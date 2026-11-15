// archive_workouts / get_archive_status: a local copy of every workout, so the history does not depend on how far back
// Suunto's list reaches or on the 600 workouts get_training_load reads. Per workout two files in ~/.suunto-mcp/archive/
// (SUUNTO_ARCHIVE_DIR moves it): <workoutKey>.fit (the FIT file as Suunto sent it) and <workoutKey>.json (the workout's
// summary from the list, plus the FIT's size and SHA-256). The .json is written last: it is the mark "archived".
// Only reads from Suunto; writes only new files here. Nothing is ever deleted or overwritten: a file that is damaged,
// foreign or does not match its record is reported and left as it is. In demo mode the archive lives in memory.
import { chmod, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { workoutDate } from "./api.js";

// Downloads per call (one FIT each): keeps one call inside Suunto's rate limit, like get_exercise_history's 8 sessions.
export const MAX_DOWNLOADS = 20;
// Workouts read from the list per call (50 per request): the newest this many.
export const LIST_LIMIT = 1000;

export const archiveDir = (): string => process.env.SUUNTO_ARCHIVE_DIR ?? join(homedir(), ".suunto-mcp", "archive");

const KEY = /^[0-9a-f]{24}$/;
const FILE = /^([0-9a-f]{24})\.(json|fit)$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ArchiveRecord {
  version: 1;
  workoutKey: string;
  archivedAt: string;
  fit: { bytes: number; sha256: string };
  workout: Record<string, unknown>; // the item from list_workouts, with its summary and intensity extensions
}
export interface ArchiveProblem {
  workoutKey: string;
  problem: string;
}
export interface ArchiveScan {
  dir: string | null; // null: in memory
  records: Map<string, ArchiveRecord>;
  problems: ArchiveProblem[];
  incomplete: ArchiveProblem[]; // a FIT file with no record: an interrupted call left it; the next call completes it
  otherFiles: number; // files in the folder that are not <key>.json / <key>.fit: not ours, never touched
}
export interface ArchiveStore {
  scan(): Promise<ArchiveScan>;
  // The FIT first, then the record. Throws rather than overwrite a file that is already there and different.
  save(key: string, fit: Buffer, record: ArchiveRecord): Promise<void>;
}

// A FIT file: a 12 or 14 byte header whose bytes 8-11 read ".FIT", and at least as long as the header says (header + data
// + 2 byte CRC): a download cut short fails here. null when it passes. The CRC itself is not checked.
export function checkFit(bytes: Buffer): string | null {
  if (bytes.length === 0) return "the download is empty";
  const headerSize = bytes[0];
  if (bytes.length < 12 || (headerSize !== 12 && headerSize !== 14) || bytes.toString("latin1", 8, 12) !== ".FIT") return "not a FIT file (no FIT header)";
  const needed = headerSize + bytes.readUInt32LE(4) + 2;
  return bytes.length < needed ? `truncated (${bytes.length} of ${needed} bytes)` : null;
}

// Strict shape of a record read back from the folder; anything else is not ours.
function parseRecord(raw: unknown, key: string): ArchiveRecord {
  if (!isObject(raw)) throw new Error("not an archive record");
  const extra = Object.keys(raw).find((k) => !["version", "workoutKey", "archivedAt", "fit", "workout"].includes(k));
  if (extra !== undefined) throw new Error(`${extra} is not a known field`);
  if (raw.version !== 1) throw new Error(`version ${JSON.stringify(raw.version) ?? "unknown"}, but this server reads and writes version 1 only`);
  if (raw.workoutKey !== key) throw new Error("stored under another workout's key");
  if (typeof raw.archivedAt !== "string" || !isObject(raw.workout)) throw new Error("archivedAt or workout is missing");
  const fit = raw.fit;
  if (!isObject(fit) || !Number.isInteger(fit.bytes) || (fit.bytes as number) <= 0 || typeof fit.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(fit.sha256)) throw new Error("fit must be { bytes, sha256 }");
  return { version: 1, workoutKey: key, archivedAt: raw.archivedAt, fit: { bytes: fit.bytes as number, sha256: fit.sha256 }, workout: raw.workout };
}

// Writes `data` to `path` only if nothing is there: the file is written complete under a temporary name and then linked
// to `path`, which fails if `path` exists (so even another process racing for the same name cannot be overwritten).
// An existing identical file is fine when `sameIsFine`; anything else there is left untouched and refused.
async function writeNew(path: string, data: Buffer, sameIsFine: boolean): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600);
    try {
      await link(tmp, path);
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      if (sameIsFine && (await readFile(path)).equals(data)) return;
      throw new Error(`${path} already exists and differs; left untouched`);
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function fileArchiveStore(dir = archiveDir()): ArchiveStore {
  return {
    async scan() {
      const scan: ArchiveScan = { dir, records: new Map(), problems: [], incomplete: [], otherFiles: 0 };
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err: any) {
        if (err.code === "ENOENT") return scan; // no folder yet: an empty archive (not created by a read)
        throw err;
      }
      const hasRecord = new Set(names.flatMap((n) => (n.endsWith(".json") ? [FILE.exec(n)?.[1] ?? ""] : [])));
      for (const name of names.sort()) {
        const m = FILE.exec(name);
        if (!m) scan.otherFiles++;
        else if (m[2] === "fit") {
          if (!hasRecord.has(m[1])) scan.incomplete.push({ workoutKey: m[1], problem: `${name} has no record (${m[1]}.json): an interrupted archive_workouts left it, and the next call completes it while the workout is still listed` });
        } else {
          const key = m[1];
          const problem = (p: string) => scan.problems.push({ workoutKey: key, problem: `${p}; left untouched` });
          let record: ArchiveRecord;
          try {
            record = parseRecord(JSON.parse(await readFile(join(dir, name), "utf8")), key);
          } catch (err: any) {
            problem(`${name} is not a valid archive record (${err.message})`);
            continue;
          }
          const size = await stat(join(dir, `${key}.fit`)).then((s) => s.size, () => null);
          if (size === null) problem(`${key}.fit is missing`);
          else if (size !== record.fit.bytes) problem(`${key}.fit size differs from its record (${size} bytes on disk, ${record.fit.bytes} recorded)`);
          else scan.records.set(key, record);
        }
      }
      return scan;
    },
    async save(key, fit, record) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeNew(join(dir, `${key}.fit`), fit, true); // an identical file is what an interrupted earlier run left
      await writeNew(join(dir, `${key}.json`), Buffer.from(JSON.stringify(record, null, 2)), false);
    },
  };
}

// Demo mode: the same behaviour with nothing on disk; lives as long as the server process.
export function memoryArchiveStore(): ArchiveStore {
  const held = new Map<string, { fit: Buffer; record: ArchiveRecord }>();
  return {
    scan: async () => ({ dir: null, records: new Map([...held].map(([k, v]) => [k, v.record])), problems: [], incomplete: [], otherFiles: 0 }),
    save: async (key, fit, record) => void held.set(key, { fit, record }),
  };
}

type Client = Pick<SuuntoClient, "listWorkouts" | "getWorkoutFit">;
const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);

// Keys whose download failed in this process: tried after the ones not tried yet, so a few bad workouts cannot use up
// every call's quota and starve the rest.
const failedKeys = new Set<string>();
export const clearFailedDownloads = (): void => failedKeys.clear();

// One call at a time: two at once would each download what the other is about to save.
let queue: Promise<unknown> = Promise.resolve();

export function archiveWorkouts(client: Client, store: ArchiveStore, opts: { limit?: number } = {}, now = new Date()) {
  const run = async () => {
    const limit = opts.limit ?? MAX_DOWNLOADS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DOWNLOADS) throw new Error(`limit must be a whole number from 1 to ${MAX_DOWNLOADS}, got ${limit}.`);
    const scan = await store.scan(); // a folder that cannot be read stops the call before Suunto is asked anything
    const listed = rowsOf(await client.listWorkouts({ limit: LIST_LIMIT }));
    const items = new Map<string, any>();
    for (const w of listed.filter(isObject).sort((a, b) => (Number(b.startTime) || 0) - (Number(a.startTime) || 0))) {
      const key = String(w.workoutKey ?? "").toLowerCase();
      if (KEY.test(key) && !items.has(key)) items.set(key, w);
    }
    const refused = new Set(scan.problems.map((p) => p.workoutKey));
    const todo = [...items.keys()].filter((k) => !scan.records.has(k) && !refused.has(k));
    const order = [...todo.filter((k) => !failedKeys.has(k)), ...todo.filter((k) => failedKeys.has(k))];

    const errors: { workoutKey: string; error: string }[] = [];
    let newly = 0;
    for (const key of order.slice(0, limit)) {
      try {
        const fit = await client.getWorkoutFit(key);
        const bad = checkFit(fit);
        if (bad !== null) throw new Error(`${bad}; nothing was written for this workout`);
        await store.save(key, fit, { version: 1, workoutKey: key, archivedAt: now.toISOString(), fit: { bytes: fit.length, sha256: createHash("sha256").update(fit).digest("hex") }, workout: items.get(key) });
        failedKeys.delete(key);
        newly++;
      } catch (err: any) {
        failedKeys.add(key);
        errors.push({ workoutKey: key, error: String(err?.message ?? err).slice(0, 300) });
      }
    }
    const remaining = todo.length - newly;
    const notes: string[] = [];
    if (remaining > 0 && errors.length === 0) notes.push(`${remaining} workout(s) are not archived yet (at most ${limit} FIT files are downloaded per call): call again until remaining is 0.`);
    else if (remaining > 0) notes.push(`${remaining} workout(s) are not archived yet; ${errors.length} failed this call (see errors) and are tried after the others next time, so remaining may not reach 0 until they succeed.`);
    if (scan.problems.length > 0) notes.push(`${scan.problems.length} file(s) in the archive are damaged, foreign or do not match their record (see refused). They are never overwritten or deleted and their workouts are not downloaded again: fix or move them yourself.`);
    if (listed.length >= LIST_LIMIT) notes.push(`The list was cut at its newest ${LIST_LIMIT} workouts; older ones cannot be reached by this tool.`);
    notes.push("Only the files above were written, all new, in the archive folder; nothing was changed at Suunto and nothing was deleted. Each FIT file is checked (non-empty, FIT header, not truncated) before its record is written; the record is the mark that a workout is archived.");
    return {
      dir: scan.dir,
      listed: items.size,
      alreadyArchived: [...items.keys()].filter((k) => scan.records.has(k)).length,
      newlyArchived: newly,
      archived: scan.records.size + newly,
      remaining,
      refused: scan.problems,
      errors,
      notes,
    };
  };
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

// What is in the archive, from the folder alone (no Suunto): counts, the span of workout dates, the FIT bytes, and every
// file that does not check out. A FIT file is checked by its size against its record; it is not read again or re-hashed.
export async function archiveStatus(store: ArchiveStore) {
  const scan = await store.scan();
  const dates = [...scan.records.values()].map((r) => workoutDate(r.workout)).filter((d) => d !== "").sort();
  const notes = ["Each archived workout's FIT file is checked by its size against its record, not read again or re-hashed (the record holds the SHA-256 for that)."];
  if (scan.problems.length > 0) notes.push(`${scan.problems.length} workout(s) have a damaged, foreign or incomplete record or FIT file (see problems); they are not counted as archived and are never changed or deleted.`);
  if (scan.incomplete.length > 0) notes.push(`${scan.incomplete.length} workout(s) have a FIT file but no record (see incomplete): they are not counted as archived. archive_workouts completes one when its workout is still in the list and the FIT file is identical to the download; otherwise it is left as it is.`);
  if (scan.otherFiles > 0) notes.push(`${scan.otherFiles} other file(s) in the folder are not part of the archive and are never touched.`);
  return {
    dir: scan.dir,
    archived: scan.records.size,
    fitBytes: [...scan.records.values()].reduce((n, r) => n + r.fit.bytes, 0),
    oldest: dates[0] ?? null,
    newest: dates[dates.length - 1] ?? null,
    problems: scan.problems,
    incomplete: scan.incomplete,
    otherFiles: scan.otherFiles,
    notes,
  };
}
