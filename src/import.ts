// import_workouts / get_import_status: workouts exported from other systems (Garmin Connect, a Strava bulk export, Apple Watch
// apps and others as FIT, GPX or TCX files) kept in ~/.suunto-mcp/imported/ (SUUNTO_IMPORT_DIR moves it). A folder of its
// own, apart from the archive: the archive is what Suunto sent, byte for byte, and stays that. Per workout two files:
// <id>.<fit|gpx|tcx> (the file exactly as given) and <id>.json (source, format, SHA-256, size and a summary read from it).
// id = the first 16 hex digits of the file's SHA-256. The .json is written last: it is the mark "imported". Reads only the
// files it is pointed at, never contacts Suunto or the network, writes only new files here, deletes and overwrites nothing:
// a file that is damaged, foreign or does not match its record is reported and left as it is. Demo mode keeps it in memory.
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { writeNew } from "./archive.js";
import { MAX_IMPORT_BYTES, parseWorkout, type ImportFormat, type ImportSummary } from "./import-parse.js";
import { serialQueue } from "./local-store.js";
import type { Pt } from "./route-time.js";

export const importDir = (): string => process.env.SUUNTO_IMPORT_DIR ?? join(homedir(), ".suunto-mcp", "imported");

export const MAX_PER_CALL = 50;
export const MAX_EXAMINED = 200; // files read per call, whatever became of them: one call's work stays bounded
export const MAX_LISTED = 50; // entries of each list in the result (the counts beside them are complete)
export const SOURCES = ["garmin", "strava", "apple", "other"] as const;
export type ImportSource = (typeof SOURCES)[number];
const FORMATS: readonly string[] = ["fit", "gpx", "tcx"];
const FILE = /^([0-9a-f]{16})\.(json|fit|gpx|tcx)$/;
// the same workout from two systems: starts within this many seconds and lasts within this fraction of each other
const SAME_START_S = 60;
const SAME_DURATION = 0.05;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ImportRecord {
  version: 1;
  source: ImportSource;
  format: ImportFormat;
  sha256: string;
  bytes: number;
  importedAt: string;
  summary: ImportSummary;
}
export interface ImportProblem {
  id: string;
  problem: string;
}
export interface ImportScan {
  dir: string | null; // null: in memory
  records: Map<string, ImportRecord>;
  problems: ImportProblem[];
  incomplete: ImportProblem[]; // a data file with no record: an interrupted call left it; importing the same file again completes it
  otherFiles: number; // files in the folder that are not <id>.json / <id>.<fit|gpx|tcx>: not ours, never touched
}
export interface ImportStore {
  scan(): Promise<ImportScan>;
  // The file first, then the record. Throws rather than overwrite a file that is already there and different.
  save(id: string, bytes: Buffer, record: ImportRecord): Promise<void>;
  read(id: string, format: ImportFormat): Promise<Buffer>;
}

const SUMMARY_KEYS = ["startTime", "durationS", "distanceM", "avgHr", "maxHr", "ascentM", "sport", "hasGps", "droppedJumps"];
function parseSummary(raw: unknown): ImportSummary {
  if (!isObject(raw)) throw new Error("summary is missing");
  const extra = Object.keys(raw).find((k) => !SUMMARY_KEYS.includes(k));
  if (extra !== undefined) throw new Error(`summary.${extra} is not a known field`);
  const n = (k: string) => raw[k] === undefined || (typeof raw[k] === "number" && Number.isFinite(raw[k]));
  if (typeof raw.startTime !== "string" || Number.isNaN(Date.parse(raw.startTime)) || typeof raw.hasGps !== "boolean" || typeof raw.durationS !== "number" || typeof raw.distanceM !== "number" || !["avgHr", "maxHr", "ascentM", "droppedJumps"].every(n) || (raw.sport !== undefined && typeof raw.sport !== "string")) {
    throw new Error("summary is not { startTime, durationS, distanceM, hasGps, ... }");
  }
  return raw as unknown as ImportSummary;
}

// Strict shape of a record read back from the folder; anything else is not ours.
function parseRecord(raw: unknown, id: string): ImportRecord {
  if (!isObject(raw)) throw new Error("not an import record");
  const extra = Object.keys(raw).find((k) => !["version", "source", "format", "sha256", "bytes", "importedAt", "summary"].includes(k));
  if (extra !== undefined) throw new Error(`${extra} is not a known field`);
  if (raw.version !== 1) throw new Error(`version ${JSON.stringify(raw.version) ?? "unknown"}, but this server reads and writes version 1 only`);
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) throw new Error("sha256 is missing");
  if (raw.sha256.slice(0, 16) !== id) throw new Error("stored under another file's id");
  if (!SOURCES.includes(raw.source as ImportSource) || !FORMATS.includes(raw.format as string)) throw new Error("source or format is not known");
  if (!Number.isInteger(raw.bytes) || (raw.bytes as number) <= 0 || typeof raw.importedAt !== "string") throw new Error("bytes or importedAt is missing");
  return { version: 1, source: raw.source as ImportSource, format: raw.format as ImportFormat, sha256: raw.sha256, bytes: raw.bytes as number, importedAt: raw.importedAt, summary: parseSummary(raw.summary) };
}

export function fileImportStore(dir = importDir()): ImportStore {
  return {
    async scan() {
      const scan: ImportScan = { dir, records: new Map(), problems: [], incomplete: [], otherFiles: 0 };
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err: any) {
        if (err.code === "ENOENT") return scan; // no folder yet: nothing imported (not created by a read)
        throw err;
      }
      const hasRecord = new Set(names.flatMap((n) => (n.endsWith(".json") ? [FILE.exec(n)?.[1] ?? ""] : [])));
      for (const name of names.sort()) {
        const m = FILE.exec(name);
        if (!m) scan.otherFiles++;
        else if (m[2] !== "json") {
          if (!hasRecord.has(m[1])) scan.incomplete.push({ id: m[1], problem: `${name} has no record (${m[1]}.json): an interrupted import_workouts left it, and importing the same file again completes it` });
        } else {
          const id = m[1];
          const problem = (p: string) => scan.problems.push({ id, problem: `${p}; left untouched` });
          let record: ImportRecord;
          try {
            record = parseRecord(JSON.parse(await readFile(join(dir, name), "utf8")), id);
          } catch (err: any) {
            problem(`${name} is not a valid import record (${err.message})`);
            continue;
          }
          const file = `${id}.${record.format}`;
          const size = await stat(join(dir, file)).then((s) => s.size, () => null);
          if (size === null) problem(`${file} is missing`);
          else if (size !== record.bytes) problem(`${file} size differs from its record (${size} bytes on disk, ${record.bytes} recorded)`);
          else scan.records.set(id, record);
        }
      }
      return scan;
    },
    async save(id, bytes, record) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeNew(join(dir, `${id}.${record.format}`), bytes, true); // an identical file is what an interrupted earlier run left
      await writeNew(join(dir, `${id}.json`), Buffer.from(JSON.stringify(record, null, 2)), false);
    },
    async read(id, format) {
      if (!/^[0-9a-f]{16}$/.test(id) || !FORMATS.includes(format)) throw new Error(`"${id}.${format}" is not an imported file`);
      return readFile(join(dir, `${id}.${format}`));
    },
  };
}

// Demo mode: the same behaviour with nothing on disk; lives as long as the server process.
export function memoryImportStore(): ImportStore {
  const held = new Map<string, { bytes: Buffer; record: ImportRecord }>();
  return {
    scan: async () => ({ dir: null, records: new Map([...held].map(([k, v]) => [k, v.record])), problems: [], incomplete: [], otherFiles: 0 }),
    save: async (id, bytes, record) => void held.set(id, { bytes, record }),
    read: async (id) => {
      const hit = held.get(id);
      if (!hit) throw new Error(`workout ${id} is not imported`);
      return hit.bytes;
    },
  };
}

// ---------- reading the files to import ----------

interface Candidate {
  name: string;
  path: string;
  format: ImportFormat;
  follow: boolean; // the path the user named may be a link; a file found inside a folder may not
}

// A file is opened without following a link and without blocking (a FIFO swapped in cannot hang the queue), and its kind and
// size are taken from the open file, so a link swapped in after the listing, or a file that grows, is not read past
// MAX_IMPORT_BYTES.
async function readBounded(c: Candidate): Promise<Buffer> {
  const fh = await open(c.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (c.follow ? 0 : constants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_IMPORT_BYTES) throw new Error(`larger than ${MAX_IMPORT_BYTES / 1_000_000} MB; not read`);
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const extOf = (name: string): string => extname(name).slice(1).toLowerCase();

async function candidates(path: string) {
  const ignored = { otherTypes: 0, subfolders: 0, links: 0, hidden: 0, gzipped: 0 };
  const root = await realpath(path);
  const st = await stat(root);
  if (st.isFile()) {
    const format = extOf(root);
    if (!FORMATS.includes(format)) throw new Error(`${basename(root)} is not a .fit, .gpx or .tcx file`);
    return { list: [{ name: basename(root), path: root, format: format as ImportFormat, follow: true }], ignored };
  }
  if (!st.isDirectory()) throw new Error(`${path} is neither a file nor a folder`);
  const list: Candidate[] = [];
  for (const e of (await readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".")) ignored.hidden++; // includes macOS's ._ companions
    else if (e.isSymbolicLink()) ignored.links++; // never followed: it may point outside the folder
    else if (e.isDirectory()) ignored.subfolders++;
    else if (!e.isFile()) ignored.otherTypes++;
    else if (FORMATS.includes(extOf(e.name))) list.push({ name: e.name, path: join(root, e.name), format: extOf(e.name) as ImportFormat, follow: false });
    else if (e.name.toLowerCase().endsWith(".gz")) ignored.gzipped++;
    else ignored.otherTypes++;
  }
  return { list, ignored };
}

// ---------- import_workouts ----------

const queue = serialQueue(); // one call at a time: two at once would each import what the other is about to save

const sameWorkout = (a: ImportSummary, b: ImportSummary): boolean =>
  Math.abs(Date.parse(a.startTime) - Date.parse(b.startTime)) <= SAME_START_S * 1000 && Math.abs(a.durationS - b.durationS) <= SAME_DURATION * Math.max(a.durationS, b.durationS);

export function importWorkouts(store: ImportStore, opts: { path: string; source?: string; limit?: number; after?: string }, now = new Date()) {
  return queue(async () => {
    const source = (opts.source ?? "other") as ImportSource;
    const limit = opts.limit ?? MAX_PER_CALL;
    if (typeof opts.path !== "string" || opts.path === "" || opts.path.includes("\0") || !isAbsolute(opts.path)) throw new Error("path must be an absolute path to a folder or to one .fit, .gpx or .tcx file.");
    if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(", ")}, got "${opts.source}".`);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PER_CALL) throw new Error(`limit must be a whole number from 1 to ${MAX_PER_CALL}, got ${limit}.`);
    if (opts.after !== undefined && typeof opts.after !== "string") throw new Error("after must be a file name.");
    const scan = await store.scan(); // a folder that cannot be read stops the call before any file is looked at
    const { list, ignored } = await candidates(resolve(opts.path)).catch((err: any) => {
      throw new Error(err.code === "ENOENT" ? `${opts.path} does not exist (or this server may not read it: macOS keeps ~/Downloads, ~/Desktop and ~/Documents from it; copy the files to e.g. /tmp first).` : err.code === "EACCES" || err.code === "EPERM" ? `${opts.path} cannot be read by this server (permission denied; macOS keeps ~/Downloads, ~/Desktop and ~/Documents from it: copy the files to e.g. /tmp first).` : err.message);
    });

    const known = new Map([...scan.records].map(([id, r]) => [id, r.summary]));
    const damaged = new Map(scan.problems.map((p) => [p.id, p.problem]));
    const imported: { file: string; id: string; format: ImportFormat; source: ImportSource; summary: ImportSummary }[] = [];
    const alreadyImported: { file: string; id: string }[] = [];
    const possibleDuplicate: { file: string; sameAs: string; startTime: string }[] = [];
    const refused: { file: string; reason: string }[] = [];
    const errors: { file: string; error: string }[] = [];
    let examined = 0;
    // Files that were refused or skipped leave nothing behind, so a repeat call could not tell them from unread ones: it starts
    // after the last file this call looked at (`nextAfter`) instead.
    const pending = opts.after === undefined ? list : list.filter((c) => c.name > opts.after!);

    for (const c of pending) {
      if (imported.length >= limit || examined >= MAX_EXAMINED) break;
      examined++;
      const refuse = (reason: string) => void refused.push({ file: c.name, reason: reason.slice(0, 300) });
      let bytes: Buffer;
      try {
        bytes = await readBounded(c);
      } catch (err: any) {
        refuse(String(err?.message ?? err));
        continue;
      }
      if (bytes.length === 0) {
        refuse("the file is empty");
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const id = sha256.slice(0, 16);
      if (known.has(id)) {
        alreadyImported.push({ file: c.name, id });
        continue;
      }
      if (damaged.has(id)) {
        refuse(`a record for this file exists in the imports folder but is damaged, foreign or of another version (${damaged.get(id)})`);
        continue;
      }
      let summary: ImportSummary;
      try {
        summary = (await parseWorkout(bytes, c.format, now)).summary;
      } catch (err: any) {
        refuse(String(err?.message ?? err));
        continue;
      }
      const twin = [...known].find(([, s]) => sameWorkout(s, summary));
      if (twin) {
        possibleDuplicate.push({ file: c.name, sameAs: twin[0], startTime: summary.startTime });
        continue;
      }
      try {
        await store.save(id, bytes, { version: 1, source, format: c.format, sha256, bytes: bytes.length, importedAt: now.toISOString(), summary });
      } catch (err: any) {
        errors.push({ file: c.name, error: String(err?.message ?? err).slice(0, 300) });
        continue;
      }
      known.set(id, summary);
      imported.push({ file: c.name, id, format: c.format, source, summary });
    }
    const remaining = pending.length - examined;
    const nextAfter = remaining > 0 ? pending[examined - 1].name : null;
    const noSport = imported.filter((i) => i.summary.sport === undefined).length;
    const jumpy = imported.filter((i) => i.summary.droppedJumps !== undefined).length;
    const notes: string[] = [];
    if (remaining > 0) notes.push(`${remaining} file(s) were not looked at yet (a call reads at most ${MAX_EXAMINED} files and imports at most ${limit} new workouts): call again with after: "${nextAfter}" until remaining is 0.`);
    if (possibleDuplicate.length > 0) notes.push(`${possibleDuplicate.length} file(s) look like a workout that is already imported (same start within ${SAME_START_S} s and a duration within ${SAME_DURATION * 100} %): they were NOT imported (see possibleDuplicate). If one is really a different workout, it cannot be imported by this tool.`);
    if (refused.length > 0) notes.push(`${refused.length} file(s) were refused (see refused); nothing was written for them.`);
    if (noSport > 0) notes.push(`${noSport} imported workout(s) name no sport (a GPX file without a track <type>, a TCX file that says Other): estimate_route_time ignores them, because it uses only workouts whose sport is walking, hiking or running.`);
    if (jumpy > 0) notes.push(`${jumpy} imported workout(s) had GPS positions dropped as jumps faster than a person moves (summary.droppedJumps): their distance is lower than the file's raw track.`);
    if (alreadyImported.length > MAX_LISTED || refused.length > MAX_LISTED || possibleDuplicate.length > MAX_LISTED || errors.length > MAX_LISTED) notes.push(`Each list shows its first ${MAX_LISTED} entries only; the ...Count fields hold the totals.`);
    if (scan.problems.length > 0) notes.push(`${scan.problems.length} file(s) in the imports folder are damaged, foreign or do not match their record (see get_import_status). They are never overwritten or deleted: fix or move them yourself.`);
    const skipped = Object.entries(ignored).filter(([, n]) => n > 0);
    if (skipped.length > 0) notes.push(`Ignored in the folder: ${skipped.map(([k, n]) => `${n} ${k}`).join(", ")}. Only .fit, .gpx and .tcx files directly in the folder are read (no subfolders, links, or .gz: unpack those first).`);
    notes.push(`${scan.dir === null ? "Nothing was written to disk (demo mode keeps the imports in memory)" : "Only new files were written, in the imports folder, never in the Suunto archive"}; nothing was changed at Suunto and nothing was deleted. Each file is checked before its record is written; the record is the mark that a workout is imported. The parsers have been checked on synthetic files only: look at the summary of your first imports before relying on them.`);
    return {
      dir: scan.dir,
      source,
      found: list.length,
      examined,
      newlyImported: imported.length,
      imported,
      alreadyImported: alreadyImported.slice(0, MAX_LISTED),
      alreadyImportedCount: alreadyImported.length,
      possibleDuplicate: possibleDuplicate.slice(0, MAX_LISTED),
      possibleDuplicateCount: possibleDuplicate.length,
      refused: refused.slice(0, MAX_LISTED),
      refusedCount: refused.length,
      errors: errors.slice(0, MAX_LISTED),
      errorsCount: errors.length,
      ignored,
      remaining,
      nextAfter,
      notes,
    };
  });
}

// ---------- get_import_status ----------

// What is in the imports folder, from the folder alone: counts per source, the span of workout dates (UTC), and every file
// that does not check out. A file is checked by its size against its record; it is not read again or re-hashed.
export async function importStatus(store: ImportStore) {
  const scan = await store.scan();
  const records = [...scan.records.values()];
  const dates = records.map((r) => r.summary.startTime.slice(0, 10)).sort();
  const bySource: Record<string, number> = {};
  for (const r of records) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  const notes = ["Each imported file is checked by its size against its record, not read again or re-hashed (the record holds the SHA-256 for that). Dates are UTC."];
  if (scan.problems.length > 0) notes.push(`${scan.problems.length} workout(s) have a damaged, foreign or incomplete record or file (see problems); they are not counted as imported and are never changed or deleted.`);
  if (scan.incomplete.length > 0) notes.push(`${scan.incomplete.length} file(s) have no record (see incomplete): they are not counted as imported. import_workouts completes one when the same file is imported again; otherwise it is left as it is.`);
  if (scan.otherFiles > 0) notes.push(`${scan.otherFiles} other file(s) in the folder are not part of the imports and are never touched.`);
  return {
    dir: scan.dir,
    imported: records.length,
    bySource,
    bytes: records.reduce((n, r) => n + r.bytes, 0),
    oldest: dates[0] ?? null,
    newest: dates[dates.length - 1] ?? null,
    problems: scan.problems,
    incomplete: scan.incomplete,
    otherFiles: scan.otherFiles,
    notes,
  };
}

// ---------- for estimate_route_time ----------

export interface ImportedSource {
  records: Map<string, ImportRecord>;
  points(id: string): Promise<Pt[]>;
  error?: string; // the folder could not be read: estimate_route_time goes on without it and says so
}

export async function importedSource(store: ImportStore): Promise<ImportedSource> {
  let scan: ImportScan;
  try {
    scan = await store.scan();
  } catch (err: any) {
    return { records: new Map(), points: async () => [], error: String(err?.message ?? err).slice(0, 200) };
  }
  return {
    records: scan.records,
    points: async (id) => {
      const r = scan.records.get(id);
      if (!r) throw new Error(`workout ${id} is not imported`);
      return (await parseWorkout(await store.read(id, r.format), r.format)).pts;
    },
  };
}
