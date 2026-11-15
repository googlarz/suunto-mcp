// get_catchup: what is new since the last time the user looked. A small local marker (the newest workout start,
// sleep end and recovery sample seen, and the day plan items were reviewed through) says where "new" begins.
// Toward Suunto it only reads (three list calls, bounded by a look-back window). The marker moves only when the
// caller passes markSeen: true, so an answer that never reached the user loses nothing. In demo mode the marker
// lives in memory.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, localDate, workoutDate } from "./api.js";
import { planSessionOn, type PlanStore } from "./plan.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { nearestSample, previousDate, summarizeRecovery, summarizeSleep, summarizeWorkouts } from "./snapshot.js";

export interface SeenState {
  workoutStartMs: number | null; // start of the newest workout seen
  workoutDate: string | null; // its local date
  sleepEndMs: number | null; // end of the latest finished night seen
  recoveryAtMs: number | null; // the newest recovery sample seen
  seenThrough: string | null; // plan items are reviewed from this local day on
  updatedAt: string;
}
export interface SeenStore {
  load(): Promise<SeenState | null>;
  save(state: SeenState): Promise<void>;
}

export const FIRST_LOOKBACK_DAYS = 7;
export const MAX_LOOKBACK_DAYS = 14;
export const WORKOUT_LIMIT = 50;

export const seenPath = (): string => process.env.SUUNTO_SEEN_PATH ?? join(homedir(), ".suunto-mcp", "seen.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const FIELDS = ["workoutStartMs", "workoutDate", "sleepEndMs", "recoveryAtMs", "seenThrough", "updatedAt"];

function parseSeen(raw: Record<string, unknown>): SeenState {
  const extra = Object.keys(raw).find((k) => k !== "version" && !FIELDS.includes(k));
  if (extra !== undefined) throw new Error(`${extra} is not a known field`);
  const ms = (k: string) => {
    const v = raw[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${k} must be a timestamp in milliseconds or null`);
    return v;
  };
  const day = (k: string) => {
    const v = raw[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string" || !isValidCalendarDate(v)) throw new Error(`${k} must be a calendar date or null`);
    return v;
  };
  return { workoutStartMs: ms("workoutStartMs"), workoutDate: day("workoutDate"), sleepEndMs: ms("sleepEndMs"), recoveryAtMs: ms("recoveryAtMs"), seenThrough: day("seenThrough"), updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
}

export function memorySeenStore(): SeenStore {
  let held: SeenState | null = null;
  return { load: async () => (held ? { ...held } : null), save: async (s) => void (held = { ...s }) };
}

// A missing file is "nothing seen yet"; a damaged or other-version one throws and is never overwritten.
export function fileSeenStore(path = seenPath()): SeenStore {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err: any) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
      let file: any;
      try {
        file = JSON.parse(raw);
      } catch {
        throw new Error(`${path} is not valid JSON; fix or delete it`);
      }
      if (!isObject(file)) throw new Error(`${path} is not a suunto-mcp seen file; fix or delete it`);
      if (file.version !== 1) throw new Error(`${path} is seen version ${JSON.stringify(file.version) ?? "unknown"}, but this server reads and writes version 1 only; it is left untouched`);
      try {
        return parseSeen(file);
      } catch (err: any) {
        throw new Error(`${path} is invalid (${err.message}); fix or delete it`);
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        await writeFile(tmp, JSON.stringify({ version: 1, ...state }, null, 2), { encoding: "utf8", mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
  };
}

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);
const maxOf = (...v: (number | null | undefined)[]): number | null => {
  const n = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return n.length ? Math.max(...n) : null;
};
const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Marking is read-merge-write inside a queue, so two calls that mark at once keep the newer of each field.
let queue: Promise<unknown> = Promise.resolve();

export async function buildCatchup(
  client: SuuntoClient,
  seen: SeenStore,
  plans: PlanStore,
  opts: { markSeen?: boolean } = {},
  now = new Date(),
) {
  const marker = await seen.load(); // an unreadable marker stops the call: "new" cannot be told
  const today = localDate(0, now);
  const nowMs = now.getTime();
  const floor = shiftDay(today, -MAX_LOOKBACK_DAYS);
  const wanted = marker?.seenThrough ?? shiftDay(today, -FIRST_LOOKBACK_DAYS);
  const from = wanted < floor ? floor : wanted;
  const notes: string[] = [];
  if (wanted < floor) notes.push(`The last markSeen was ${wanted}; only the last ${MAX_LOOKBACK_DAYS} days are checked, so anything older was not looked at.`);
  if (!marker) notes.push(`No marker yet: looking back ${FIRST_LOOKBACK_DAYS} days.`);

  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: err?.message ?? String(err) });
      return null;
    }
  };
  const [workoutRes, sleepRes, recoveryRes] = await Promise.all([
    section("workouts", () => client.listWorkouts({ since: dayFetchBounds(from, today).from, limit: WORKOUT_LIMIT })),
    section("sleep", () => client.listSleep(previousDate(from), today)),
    section("recovery", () => client.listRecovery(from, today)),
  ]);

  // ---- workouts ----
  const workouts = workoutRes === null ? null : rowsOf(workoutRes).filter((w) => typeof w?.startTime === "number" && w.startTime <= nowMs);
  const workoutsComplete = workoutRes !== null && rowsOf(workoutRes).length < WORKOUT_LIMIT;
  if (workoutRes !== null && !workoutsComplete) {
    errors.push({ section: "workouts", error: `Reached the ${WORKOUT_LIMIT}-workout limit; older workouts in the window may be missing, so the workout marker and the plan review are not advanced.` });
  }
  const fresh = (workouts ?? []).filter((w) => marker?.workoutStartMs == null || w.startTime > marker.workoutStartMs).sort((a, b) => a.startTime - b.startTime);
  const newWorkouts = [...new Set(fresh.map(workoutDate))].flatMap((d) => summarizeWorkouts({ payload: fresh }, d).map((w) => ({ date: d, ...w })));
  const lastWorkout = (workouts ?? []).reduce<any>((best, w) => (best === null || w.startTime > best.startTime ? w : best), null);
  const lastDate = lastWorkout ? workoutDate(lastWorkout) : marker?.workoutDate ?? null;

  // ---- nights ----
  const allRecovery = rowsOf(recoveryRes);
  const endedNights = (): { bedtimeEnd: string; endMs: number; [k: string]: any }[] => {
    const finished = rowsOf(sleepRes).filter((r) => {
      const end = Date.parse(r?.entryData?.BedtimeEnd);
      return Number.isFinite(end) && end <= nowMs;
    });
    const s = summarizeSleep(finished);
    return [s.main, ...s.otherNights]
      .filter((n): n is NonNullable<typeof n> => n !== null)
      .map((n) => ({ ...n, bedtimeEnd: n.bedtimeEnd as string, endMs: Date.parse(n.bedtimeEnd as string) }))
      .sort((a, b) => a.endMs - b.endMs);
  };
  const nights = sleepRes === null ? null : endedNights();
  const newNights = (nights ?? [])
    .filter((n) => marker?.sleepEndMs == null || n.endMs > marker.sleepEndMs)
    .map((n) => ({
      bedtimeStart: n.bedtimeStart,
      bedtimeEnd: n.bedtimeEnd,
      durationS: n.durationS,
      score: n.score,
      avgHrv: n.avgHrv,
      recoveryOnWaking: recoveryRes === null ? null : nearestSample(allRecovery, n.bedtimeEnd),
    }));

  // ---- recovery ----
  const stamped = allRecovery.map((r) => ({ r, t: Date.parse(r?.timestamp) })).filter((x) => Number.isFinite(x.t) && x.t <= nowMs);
  const freshRecovery = stamped.filter((x) => marker?.recoveryAtMs == null || x.t > marker.recoveryAtMs);
  const recoverySummary = recoveryRes === null ? null : summarizeRecovery(freshRecovery.map((x) => x.r));
  const newestRecovery = freshRecovery.length ? freshRecovery.reduce((a, b) => (b.t > a.t ? b : a)) : null;
  const recovery =
    recoveryRes === null
      ? null
      : {
          newSamples: freshRecovery.length,
          latest: newestRecovery ? { balance: summarizeRecovery([newestRecovery.r])?.last ?? null, at: newestRecovery.r.timestamp as string } : null,
          low: recoverySummary?.low ?? null,
          high: recoverySummary?.high ?? null,
        };

  // ---- plan: by date, not by sport ----
  let plan: unknown = null;
  if (workouts !== null && workoutsComplete) {
    try {
      const stored = await plans.load();
      if (stored) {
        const trained = new Map<string, string>();
        for (const w of workouts) trained.set(workoutDate(w), trained.get(workoutDate(w)) ?? (w.workoutKey ?? ""));
        const items = stored.plan.sessions
          .filter((s) => s.date >= from && s.date <= today)
          .map((s) => ({ date: s.date, title: s.title, status: trained.has(s.date) ? ("done" as const) : s.date < today ? ("missed" as const) : ("pending" as const), ...(trained.has(s.date) ? { workoutKey: trained.get(s.date) } : {}) }));
        plan = { from, items, done: items.filter((i) => i.status === "done").length, missed: items.filter((i) => i.status === "missed").length, pending: items.filter((i) => i.status === "pending").length, todaySession: planSessionOn(stored.plan, today)?.title ?? null };
      }
    } catch (err: any) {
      plan = { error: err?.message ?? String(err) };
    }
  } else if (workouts === null) {
    notes.push("Plan items were not checked: the workouts could not be read.");
  }

  const result = {
    today,
    since: { from, firstCall: marker === null },
    newWorkouts,
    newNights,
    recovery,
    plan,
    lastSessionDate: lastDate,
    daysSinceLastSession: lastDate ? dayNumber(today) - dayNumber(lastDate) : null,
    markSeen: opts.markSeen === true,
    marked: false,
    errors,
    notes,
  };

  if (opts.markSeen === true) {
    const marking = async () => {
      const current = (await seen.load()) ?? { workoutStartMs: null, workoutDate: null, sleepEndMs: null, recoveryAtMs: null, seenThrough: null, updatedAt: "" };
      const next: SeenState = { ...current, updatedAt: now.toISOString() };
      if (workouts !== null && workoutsComplete) {
        if (lastWorkout && (current.workoutStartMs == null || lastWorkout.startTime > current.workoutStartMs)) {
          next.workoutStartMs = lastWorkout.startTime;
          next.workoutDate = workoutDate(lastWorkout);
        }
        if (next.seenThrough == null || today > next.seenThrough) next.seenThrough = today;
      }
      if (nights !== null) next.sleepEndMs = maxOf(current.sleepEndMs, ...nights.map((n) => n.endMs));
      if (recoveryRes !== null) next.recoveryAtMs = maxOf(current.recoveryAtMs, ...stamped.map((x) => x.t));
      await seen.save(next);
    };
    const done = queue.then(marking);
    queue = done.catch(() => undefined);
    await done;
    result.marked = true;
    if (errors.length) notes.push("markSeen moved the markers of the sections that were read; a section listed in errors keeps its old marker and shows up again next time.");
  }
  return result;
}
