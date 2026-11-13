// log_session: what the user says actually happened in a session (reps, weights,
// RPE), kept in a local file next to the tokens. The watch records only the
// guide's planned text; this is the one place real reps and loads can come from.
// Never touches Suunto. One entry per workoutKey; logging the same key again replaces it.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface JournalSet {
  reps?: number;
  kg?: number;
  rpe?: number;
}
export interface JournalExercise {
  name: string;
  sets?: JournalSet[];
  note?: string;
}
export interface JournalEntry {
  workoutKey: string;
  loggedAt: string;
  note?: string;
  feeling?: string;
  exercises?: JournalExercise[];
}

const WORKOUT_KEY = /^[0-9a-f]{24}$/i;
export const MAX_TEXT = 500;
export const MAX_EXERCISES = 40;
export const MAX_SETS = 20;

export const journalPath = (): string => process.env.SUUNTO_JOURNAL_PATH ?? join(homedir(), ".suunto-mcp", "journal.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, path: string, required = false): string | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`${path} must be a string`);
  if (v.length > MAX_TEXT) throw new Error(`${path} must be at most ${MAX_TEXT} characters`);
  if (required && v.trim() === "") throw new Error(`${path} must not be empty`);
  return v;
}

function num(v: unknown, path: string, min: number, max: number, integer: boolean): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${path} must be a finite number`);
  if (integer && !Number.isInteger(v)) throw new Error(`${path} must be an integer`);
  if (v < min || v > max) throw new Error(`${path} must be between ${min} and ${max}`);
  return v;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// A field this tool does not know is refused, not dropped: {name: "Squat", weight: 100} must not silently lose the weight.
function onlyKeys(o: Record<string, unknown>, allowed: string[], path: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Error(`${path}${extra} is not a known field (allowed here: ${allowed.join(", ")})`);
}

// Strict shape check of one entry (log_session's arguments, or an entry read back from the file).
function parseEntry(args: unknown, loggedAt: string): JournalEntry {
  if (!isObject(args)) throw new Error("arguments must be an object");
  onlyKeys(args, ["workoutKey", "note", "feeling", "exercises"], "");
  const key = args.workoutKey;
  if (typeof key !== "string" || !WORKOUT_KEY.test(key)) throw new Error("workoutKey must be the 24-character hex key from list_workouts");
  let exercises: JournalExercise[] | undefined;
  if (args.exercises !== undefined) {
    if (!Array.isArray(args.exercises)) throw new Error("exercises must be an array");
    if (args.exercises.length > MAX_EXERCISES) throw new Error(`exercises can have at most ${MAX_EXERCISES} items`);
    exercises = args.exercises.map((e, i) => {
      const p = `exercises[${i}]`;
      if (!isObject(e)) throw new Error(`${p} must be an object`);
      onlyKeys(e, ["name", "sets", "note"], `${p}.`);
      let sets: JournalSet[] | undefined;
      if (e.sets !== undefined) {
        if (!Array.isArray(e.sets)) throw new Error(`${p}.sets must be an array`);
        if (e.sets.length > MAX_SETS) throw new Error(`${p}.sets can have at most ${MAX_SETS} items`);
        sets = e.sets.map((s, j) => {
          const q = `${p}.sets[${j}]`;
          if (!isObject(s)) throw new Error(`${q} must be an object`);
          onlyKeys(s, ["reps", "kg", "rpe"], `${q}.`);
          return defined({
            reps: num(s.reps, `${q}.reps`, 0, 200, true),
            kg: num(s.kg, `${q}.kg`, 0, 1000, false),
            rpe: num(s.rpe, `${q}.rpe`, 1, 10, false),
          });
        });
      }
      return defined({ name: text(e.name, `${p}.name`, true)!, sets, note: text(e.note, `${p}.note`) });
    });
  }
  return defined({
    workoutKey: key.toLowerCase(),
    loggedAt,
    note: text(args.note, "note"),
    feeling: text(args.feeling, "feeling"),
    exercises,
  });
}

// Strict check of log_session's arguments; returns the entry to store, stamped with `now`.
// A call with nothing in it is refused: it would replace a full entry with an empty one.
export function parseLogInput(args: unknown, now = new Date()): JournalEntry {
  const entry = parseEntry(args, now.toISOString());
  if (!entry.note?.trim() && !entry.feeling?.trim() && !entry.exercises?.length) throw new Error("nothing to log: give a note, a feeling or at least one exercise (an empty call would wipe the entry already stored for this workout)");
  return entry;
}

// The entries of a loaded journal that this server could have written; any other is skipped and counted
// (a hand-edited or damaged file must not break reading).
export function validEntries(raw: Record<string, unknown>): { entries: Record<string, JournalEntry>; ignored: number } {
  const entries: Record<string, JournalEntry> = {};
  let ignored = 0;
  for (const [key, v] of Object.entries(raw)) {
    try {
      if (!isObject(v) || typeof v.loggedAt !== "string") throw new Error("not an entry");
      const { loggedAt, ...rest } = v;
      const entry = parseEntry(rest, loggedAt);
      if (entry.workoutKey !== key) throw new Error("stored under another key");
      entries[key] = entry;
    } catch {
      ignored++;
    }
  }
  return { entries, ignored };
}

interface JournalFile {
  version: 1;
  entries: Record<string, JournalEntry>;
}

// All entries by workoutKey. A missing file is an empty journal; an unreadable one throws
// (log_session must not overwrite what it cannot read).
export async function loadJournal(path = journalPath()): Promise<Record<string, JournalEntry>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  let file: any;
  try {
    file = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it`);
  }
  if (!isObject(file) || !isObject(file.entries)) throw new Error(`${path} is not a suunto-mcp journal; fix or delete it`);
  // rewriting another version's file as version 1 would drop what this server cannot read
  if (file.version !== 1) throw new Error(`${path} is journal version ${JSON.stringify(file.version) ?? "unknown"}, but this server reads and writes version 1 only; it is left untouched`);
  return file.entries as Record<string, JournalEntry>;
}

// Adds `entry` to the file and returns how many entries it now holds. The file is read again right here
// and the entry merged onto it, so one logged by another server process since our first read is kept
// (this entry wins for its own key). Not a lock: two writes within the same few milliseconds can still collide.
async function saveJournal(path: string, entry: JournalEntry): Promise<number> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const entries = { ...(await loadJournal(path)), [entry.workoutKey]: entry };
  const file: JournalFile = { version: 1, entries };
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return Object.keys(entries).length;
}

// Calls run one after the other: two at once would each read the file before the other's write.
let queue: Promise<unknown> = Promise.resolve();

// Stores the entry, replacing one for the same workoutKey; returns the one it replaced (or null)
// so nothing is lost silently.
export function logSession(args: unknown, path = journalPath(), now = new Date()): Promise<{ saved: JournalEntry; replaced: JournalEntry | null; entries: number }> {
  const run = async () => {
    const saved = parseLogInput(args, now);
    const replaced = (await loadJournal(path))[saved.workoutKey] ?? null;
    return { saved, replaced, entries: await saveJournal(path, saved) };
  };
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}
