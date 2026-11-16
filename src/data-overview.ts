// get_data_overview: every local file the server keeps, in one read-only look: where it is, its version, its size, how many
// entries it holds, whether its permissions are looser than the 0600 / 0700 the server itself creates, and whether it
// is one the server would refuse (unreadable, damaged, not a suunto-mcp file, written by a newer version). It only reads
// (stat, readdir, readFile): nothing is modified, created or repaired, and Suunto is never contacted. Demo mode: the
// counts of the in-memory stores, no paths, no disk.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { approvalsPath } from "./approvals.js";
import { archiveDir } from "./archive.js";
import { cacheDir } from "./cache.js";
import { seenPath } from "./catchup.js";
import { experimentsPath } from "./experiments.js";
import { journalPath } from "./journal.js";
import { planPath } from "./plan.js";
import { predictionsPath } from "./predictions.js";
import { reportsDir } from "./report.js";

export type FileStatus = "ok" | "missing" | "unreadable" | "damaged" | "foreign" | "newer-version" | "in-memory";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : 0);

interface FileSpec {
  name: string;
  path: () => string;
  key: string; // the field every file of this kind has
  counts: (doc: Record<string, any>) => Record<string, number>;
}
// What each file holds, read off its JSON without the strict parsers (a damaged file must still be described, not thrown at).
export const FILES: FileSpec[] = [
  { name: "journal", path: journalPath, key: "entries", counts: (d) => ({ entries: len(d.entries), draftMarks: len(d.sources) }) },
  { name: "plan", path: planPath, key: "plan", counts: (d) => ({ sessions: len(d.plan?.sessions), phases: len(d.plan?.phases) }) },
  { name: "seen", path: seenPath, key: "workouts", counts: (d) => ({ workouts: len(d.workouts) }) },
  {
    name: "predictions",
    path: predictionsPath,
    key: "predictions",
    counts: (d) => ({ predictions: len(d.predictions), scored: (d.predictions as any[]).filter((p) => p?.outcome && p.outcome.result !== "unresolvable").length, voided: (d.predictions as any[]).filter((p) => p?.voided).length }),
  },
  { name: "experiments", path: experimentsPath, key: "experiments", counts: (d) => ({ experiments: len(d.experiments) }) },
  { name: "approvals", path: approvalsPath, key: "approvals", counts: (d) => ({ approvals: len(d.approvals), unresolved: (d.approvals as any[]).filter((a) => a?.resolution === undefined).length }) },
];

interface DirSpec {
  name: string;
  path: () => string;
  counts: (names: string[]) => Record<string, number>;
}
export const DIRS: DirSpec[] = [
  { name: "cache", path: cacheDir, counts: (n) => ({ records: n.filter((x) => x.endsWith(".json")).length }) },
  { name: "archive", path: archiveDir, counts: (n) => ({ workouts: n.filter((x) => x.endsWith(".json")).length, fitFiles: n.filter((x) => x.endsWith(".fit")).length }) },
  { name: "reports", path: reportsDir, counts: (n) => ({ reports: n.filter((x) => /^week-\d{4}-\d{2}-\d{2}\.md$/.test(x)).length }) },
];

const modeOf = (m: number): string => (m & 0o777).toString(8).padStart(4, "0");
// The server creates its files 0600 and folders 0700. Warn when the group or others have any access (other users of the machine may read it),
// or when the owner lacks what the server needs (a file it must read and write, a folder it must also enter): that is a file the server
// could not update, not a safer one.
function modeWarning(mode: number, expected: number, path: string, what: string): string | null {
  if (process.platform === "win32") return null;
  const bits = mode & 0o777;
  if (bits & 0o077) return `${what} has mode ${modeOf(mode)}, the server creates it as ${modeOf(expected)}: other users may be able to read it (chmod ${expected.toString(8)} "${path}" if that is not intended).`;
  const lacking = (["r", "w", "x"] as const).filter((_, i) => (expected & (0o400 >> i)) !== 0 && (bits & (0o400 >> i)) === 0).map((c) => ({ r: "read", w: "write", x: "enter" })[c]);
  return lacking.length === 0 ? null : `${what} has mode ${modeOf(mode)}: its owner cannot ${lacking.join(" or ")} it, so the server could not use or update it (chmod ${expected.toString(8)} "${path}" restores ${modeOf(expected)}).`;
}

async function inspectFile(spec: FileSpec) {
  const path = spec.path();
  const blank = { name: spec.name, kind: "file" as const, path, exists: false, status: "missing" as FileStatus, error: null as string | null, version: null as number | null, sizeBytes: null as number | null, mode: null as string | null, modeWarning: null as string | null, counts: null as Record<string, number> | null };
  let st;
  try {
    st = await stat(path);
  } catch (err: any) {
    return err?.code === "ENOENT" ? blank : { ...blank, exists: true, status: "unreadable" as FileStatus, error: String(err?.message ?? err) };
  }
  const found = { ...blank, exists: true, sizeBytes: st.size, mode: modeOf(st.mode), modeWarning: modeWarning(st.mode, 0o600, path, spec.name) };
  if (!st.isFile()) return { ...found, status: "foreign" as FileStatus, error: `${path} is not a file` };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: any) {
    return { ...found, status: "unreadable" as FileStatus, error: String(err?.message ?? err) };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ...found, status: "damaged" as FileStatus, error: "not valid JSON: fix or delete it" };
  }
  if (!isObject(doc) || doc[spec.key] === undefined) return { ...found, status: "foreign" as FileStatus, error: `not a suunto-mcp ${spec.name} file (no "${spec.key}")` };
  const version = typeof doc.version === "number" ? doc.version : null;
  if (version !== 1) {
    return { ...found, version, status: (version !== null && version > 1 ? "newer-version" : "foreign") as FileStatus, error: version !== null && version > 1 ? `version ${version}: this server reads and writes version 1 only, so it refuses the file and leaves it untouched` : "no version number: not a file this server wrote" };
  }
  try {
    return { ...found, version, status: "ok" as FileStatus, counts: spec.counts(doc) };
  } catch {
    return { ...found, version, status: "foreign" as FileStatus, error: `"${spec.key}" has the wrong shape` };
  }
}

async function inspectDir(spec: DirSpec) {
  const path = spec.path();
  const out = { name: spec.name, kind: "directory" as const, path, exists: false, status: "missing" as FileStatus, error: null as string | null, version: null as number | null, sizeBytes: null as number | null, mode: null as string | null, modeWarning: null as string | null, counts: null as Record<string, number> | null };
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return { ...out, exists: true, status: "foreign" as FileStatus, error: `${path} is not a folder` };
    const names = await readdir(path);
    let size = 0;
    for (const n of names) size += await stat(join(path, n)).then((s) => (s.isFile() ? s.size : 0), () => 0);
    return { ...out, exists: true, status: "ok" as FileStatus, sizeBytes: size, mode: modeOf(st.mode), modeWarning: modeWarning(st.mode, 0o700, path, spec.name), counts: spec.counts(names) };
  } catch (err: any) {
    return err?.code === "ENOENT" ? out : { ...out, exists: true, status: "unreadable" as FileStatus, error: String(err?.message ?? err) };
  }
}

export interface InMemory {
  journal?: unknown;
  plan?: unknown;
  seen?: unknown;
  predictions?: unknown;
  experiments?: unknown;
  approvals?: unknown;
}

// `memory`: demo mode's stores (documents as they would be written, without `version`); nothing is read from the disk then.
export async function dataOverview(memory?: InMemory) {
  const files =
    memory === undefined
      ? await Promise.all(FILES.map(inspectFile))
      : FILES.map((spec) => {
          const doc = (memory as Record<string, unknown>)[spec.name];
          const shaped = isObject(doc) && doc[spec.key] !== undefined;
          return { name: spec.name, kind: "file" as const, path: null as string | null, exists: shaped, status: (shaped ? "in-memory" : "missing") as FileStatus, error: null as string | null, version: shaped ? 1 : null, sizeBytes: null as number | null, mode: null as string | null, modeWarning: null as string | null, counts: shaped ? spec.counts(doc as Record<string, any>) : null };
        });
  const dirs =
    memory === undefined
      ? await Promise.all(DIRS.map(inspectDir))
      : DIRS.map((spec) => ({ name: spec.name, kind: "directory" as const, path: null as string | null, exists: false, status: "in-memory" as FileStatus, error: null as string | null, version: null as number | null, sizeBytes: null as number | null, mode: null as string | null, modeWarning: null as string | null, counts: spec.counts([]) }));
  const all = [...files, ...dirs];
  return {
    inMemory: memory !== undefined,
    files,
    directories: dirs,
    warnings: all.flatMap((x) => [...(x.modeWarning ? [x.modeWarning] : []), ...(x.status === "ok" || x.status === "missing" || x.status === "in-memory" ? [] : [`${x.name}: ${x.status}${x.error ? ` (${x.error})` : ""}`])]),
    notes: [
      "Read-only: this looks at the files and changes none of them. A file that is damaged, not ours, unreadable or written by a newer version is refused by the tool that uses it and never overwritten; fix or delete it yourself.",
      "Counts come from reading each file's JSON without the strict check, so a file can be listed as ok and still be refused by its tool for a field this overview does not look at.",
      memory !== undefined ? "Demo mode: these are the counts of the in-memory stores; nothing is on disk and no path is shown." : "The tokens file, the daily digest's history and averages and the webhook log are not listed here.",
    ],
  };
}
