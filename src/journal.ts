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

// Strict check of log_session's arguments; returns the entry to store, stamped with `now`.
export function parseLogInput(args: unknown, now = new Date()): JournalEntry {
  if (!isObject(args)) throw new Error("arguments must be an object");
  const key = args.workoutKey;
  if (typeof key !== "string" || !WORKOUT_KEY.test(key)) throw new Error("workoutKey must be the 24-character hex key from list_workouts");
  let exercises: JournalExercise[] | undefined;
  if (args.exercises !== undefined) {
    if (!Array.isArray(args.exercises)) throw new Error("exercises must be an array");
    if (args.exercises.length > MAX_EXERCISES) throw new Error(`exercises can have at most ${MAX_EXERCISES} items`);
    exercises = args.exercises.map((e, i) => {
      const p = `exercises[${i}]`;
      if (!isObject(e)) throw new Error(`${p} must be an object`);
      let sets: JournalSet[] | undefined;
      if (e.sets !== undefined) {
        if (!Array.isArray(e.sets)) throw new Error(`${p}.sets must be an array`);
        if (e.sets.length > MAX_SETS) throw new Error(`${p}.sets can have at most ${MAX_SETS} items`);
        sets = e.sets.map((s, j) => {
          const q = `${p}.sets[${j}]`;
          if (!isObject(s)) throw new Error(`${q} must be an object`);
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
    loggedAt: now.toISOString(),
    note: text(args.note, "note"),
    feeling: text(args.feeling, "feeling"),
    exercises,
  });
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
  return file.entries as Record<string, JournalEntry>;
}

async function saveJournal(path: string, entries: Record<string, JournalEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
}

// Calls run one after the other: two at once would each read the file before the other's write.
let queue: Promise<unknown> = Promise.resolve();

// Stores the entry, replacing one for the same workoutKey; returns the one it replaced (or null)
// so nothing is lost silently.
export function logSession(args: unknown, path = journalPath(), now = new Date()): Promise<{ saved: JournalEntry; replaced: JournalEntry | null; entries: number }> {
  const run = async () => {
    const saved = parseLogInput(args, now);
    const entries = await loadJournal(path);
    const replaced = entries[saved.workoutKey] ?? null;
    entries[saved.workoutKey] = saved;
    await saveJournal(path, entries);
    return { saved, replaced, entries: Object.keys(entries).length };
  };
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}
