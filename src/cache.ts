// Local cache of DERIVED per-workout results (a few KB each, never the raw FIT).
// A finished workout does not change, and one guided session costs two requests
// (laps + a ~550 KB FIT), so get_exercise_history keeps what it derived from them.
// One file per workoutKey in ~/.suunto-mcp/cache/ (SUUNTO_CACHE_DIR overrides it);
// SUUNTO_CACHE=off disables reading and writing.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Bump when the derived record changes shape or the algorithm behind it does:
// an entry written under another number is ignored, so old results are recomputed.
export const CACHE_SCHEMA = 1;

// A workout that started less than this long ago may still be syncing or being edited.
export const MIN_AGE_MS = 24 * 3_600_000;

const WORKOUT_KEY = /^[0-9a-f]{24}$/i;

// Demo mode never caches on disk: its synthetic workouts must not sit next to real ones.
// It keeps them in memory for the life of the process instead, so repeated calls still converge.
const isDemo = (): boolean => process.env.SUUNTO_DEMO === "1";
const demoMemory = new Map<string, unknown>();
export const cacheEnabled = (): boolean => process.env.SUUNTO_CACHE !== "off" && process.env.SUUNTO_DEMO !== "1";
export const cacheDir = (): string => process.env.SUUNTO_CACHE_DIR ?? join(homedir(), ".suunto-mcp", "cache");

// The key becomes part of a path, so anything but 24 hex characters is refused.
function fileOf(workoutKey: string): string {
  if (!WORKOUT_KEY.test(workoutKey)) throw new Error(`${JSON.stringify(workoutKey)} is not a workout key (24 hex characters), so it cannot be cached.`);
  return join(cacheDir(), `${workoutKey.toLowerCase()}.json`);
}

// The cached record, or null: no entry, caching off, an unreadable file or another schema.
export async function readCache<T>(workoutKey: string): Promise<T | null> {
  const file = fileOf(workoutKey);
  if (isDemo()) return (demoMemory.get(workoutKey.toLowerCase()) as T | undefined) ?? null;
  if (!cacheEnabled()) return null;
  try {
    const entry = JSON.parse(await readFile(file, "utf8"));
    return entry?.schema === CACHE_SCHEMA && entry.workoutKey === workoutKey.toLowerCase() ? (entry.data as T) : null;
  } catch {
    return null;
  }
}

// Stores `data` unless caching is off or the workout (started at startMs, epoch ms) is under 24 h old
// or has no usable start time. Returns whether it was written; a write that fails is not an error:
// the cache is only an optimisation.
export async function writeCache(workoutKey: string, startMs: number | null, data: unknown, now = Date.now()): Promise<boolean> {
  const file = fileOf(workoutKey);
  if (isDemo()) {
    if (startMs !== null && Number.isFinite(startMs) && now - startMs >= MIN_AGE_MS) demoMemory.set(workoutKey.toLowerCase(), data);
    return false;
  }
  if (!cacheEnabled() || startMs === null || !Number.isFinite(startMs) || now - startMs < MIN_AGE_MS) return false;
  // Temp file + rename: a crash mid-write must not leave a truncated entry.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify({ schema: CACHE_SCHEMA, workoutKey: workoutKey.toLowerCase(), data }), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    return true;
  } catch {
    await rm(tmp, { force: true });
    return false;
  }
}
