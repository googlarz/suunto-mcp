// get_catchup: what is new since the last time the user looked. A small local marker says where "new" begins: the
// workout keys already seen (a bounded list, so a workout that syncs late with an earlier start is still new), the end
// of the latest night and the newest recovery sample seen, and the day the review window starts at. Toward Suunto it
// only reads (list calls bounded by a look-back window). The marker moves only when the caller passes markSeen: true,
// so a call without it changes nothing and an answer that never reached the user can be asked for again. In demo mode
// the marker lives in memory.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, localDate, workoutDate } from "./api.js";
import { planSessionOn, type PlanStore } from "./plan.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { nearestSample, previousDate, summarizeRecovery, summarizeSleep, summarizeWorkouts } from "./snapshot.js";

export interface SeenWorkout {
  key: string;
  startMs: number;
}
export interface SeenState {
  workouts: SeenWorkout[]; // workouts already reported, newest first, only those still inside the look-back window
  workoutDate: string | null; // local date of the newest workout seen
  cursorMs: number | null; // a call that could not read the whole workout list stopped here; the next one continues below it
  sleepEndMs: number | null; // end of the latest finished night seen
  recoveryAtMs: number | null; // the newest recovery sample seen
  seenThrough: string | null; // sleep, recovery and plan items are reviewed from this local day on; moves only when every section was read
  updatedAt: string;
}
export interface SeenStore {
  load(): Promise<SeenState | null>;
  save(state: SeenState): Promise<void>;
}

export const FIRST_LOOKBACK_DAYS = 7;
export const MAX_LOOKBACK_DAYS = 14;
export const LATE_SYNC_DAYS = 2; // with a marker, workouts are listed this much further back so a late sync is not missed
export const WORKOUT_LIMIT = 50; // workouts per list page (51 are asked for, to tell "exactly 50" from "more")
export const MAX_WORKOUT_PAGES = 4; // list pages per call
export const MAX_SEEN_KEYS = 400;
const KEEP_KEYS_MS = (MAX_LOOKBACK_DAYS + LATE_SYNC_DAYS + 2) * 86_400_000;

export const seenPath = (): string => process.env.SUUNTO_SEEN_PATH ?? join(homedir(), ".suunto-mcp", "seen.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const FIELDS = ["workouts", "workoutDate", "cursorMs", "sleepEndMs", "recoveryAtMs", "seenThrough", "updatedAt"];

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
  const list = raw.workouts ?? [];
  if (!Array.isArray(list)) throw new Error("workouts must be an array");
  if (list.length > MAX_SEEN_KEYS) throw new Error(`workouts can have at most ${MAX_SEEN_KEYS} items`);
  const workouts = list.map((w, i) => {
    if (!isObject(w) || Object.keys(w).some((k) => k !== "key" && k !== "startMs") || typeof w.key !== "string" || w.key === "" || w.key.length > 64 || typeof w.startMs !== "number" || !Number.isFinite(w.startMs)) {
      throw new Error(`workouts[${i}] must be { key, startMs }`);
    }
    return { key: w.key, startMs: w.startMs };
  });
  return { workouts, workoutDate: day("workoutDate"), cursorMs: ms("cursorMs"), sleepEndMs: ms("sleepEndMs"), recoveryAtMs: ms("recoveryAtMs"), seenThrough: day("seenThrough"), updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
}

export function memorySeenStore(): SeenStore {
  let held: SeenState | null = null;
  return { load: async () => (held ? structuredClone(held) : null), save: async (s) => void (held = structuredClone(s)) };
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

// The workouts since `since`, newest first, in pages of WORKOUT_LIMIT (one more is asked for each time: a 51st row means
// "more", so a list of exactly 50 is complete). At most MAX_WORKOUT_PAGES pages per call; past that the result is
// incomplete and `cursor` is where it stopped. A cursor from an earlier call makes this one read the newest page (for
// late arrivals) and then continue below the cursor, so repeated calls get through a list of any length.
// Pages are cut at the oldest start already read (minus 1 ms): two workouts starting in the same millisecond at a page
// edge is not something one watch produces.
async function fetchWorkouts(client: SuuntoClient, since: number, cursorMs: number | null) {
  const rows = new Map<string, any>();
  let until: number | undefined;
  for (let page = 1; ; page++) {
    const res = rowsOf(await client.listWorkouts({ since, ...(until !== undefined ? { until } : {}), limit: WORKOUT_LIMIT + 1 }))
      .filter((w) => typeof w?.workoutKey === "string" && typeof w?.startTime === "number")
      .sort((a, b) => b.startTime - a.startTime);
    for (const w of res.slice(0, WORKOUT_LIMIT)) rows.set(w.workoutKey, w);
    if (res.length <= WORKOUT_LIMIT) return { rows: [...rows.values()], complete: true, cursor: null as number | null };
    const oldest = res[WORKOUT_LIMIT - 1].startTime;
    if (page >= MAX_WORKOUT_PAGES) return { rows: [...rows.values()], complete: false, cursor: oldest };
    until = (page === 1 && cursorMs !== null && cursorMs < oldest ? cursorMs : oldest) - 1;
  }
}

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
  if (wanted < floor) notes.push(`The review window started ${wanted}; only the last ${MAX_LOOKBACK_DAYS} days are checked, so anything older was not looked at.`);
  if (!marker) notes.push(`No marker yet: looking back ${FIRST_LOOKBACK_DAYS} days (the list calls add a margin of up to 14 hours for time zones).`);

  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: err?.message ?? String(err) });
      return null;
    }
  };
  const workoutFrom = marker ? shiftDay(from, -LATE_SYNC_DAYS) : from;
  const [workoutRes, sleepRes, recoveryRes] = await Promise.all([
    section("workouts", () => fetchWorkouts(client, dayFetchBounds(workoutFrom, today).from, marker?.cursorMs ?? null)),
    section("sleep", () => client.listSleep(previousDate(from), today)),
    section("recovery", () => client.listRecovery(from, today)),
  ]);

  // ---- workouts: new = a key not seen before, whatever its start time ----
  const workouts = workoutRes === null ? null : workoutRes.rows.filter((w) => w.startTime <= nowMs);
  const workoutsComplete = workoutRes?.complete === true;
  if (workoutRes !== null && !workoutRes.complete) {
    errors.push({ section: "workouts", error: `More workouts than one call reads (${workoutRes.rows.length} read, ${MAX_WORKOUT_PAGES} pages of ${WORKOUT_LIMIT}); call again (with markSeen: true to continue below where this one stopped). The review window stays open until the whole list has been read.` });
  }
  const seenKeys = new Set((marker?.workouts ?? []).map((w) => w.key));
  const fresh = (workouts ?? []).filter((w) => !seenKeys.has(w.workoutKey)).sort((a, b) => a.startTime - b.startTime);
  const newWorkouts = [...new Set(fresh.map(workoutDate))].flatMap((d) => summarizeWorkouts({ payload: fresh }, d).map((w) => ({ date: d, ...w })));
  const lastWorkout = (workouts ?? []).reduce<any>((best, w) => (best === null || w.startTime > best.startTime ? w : best), null);
  const windowLast = lastWorkout ? workoutDate(lastWorkout) : null;
  const lastDate = [windowLast, marker?.workoutDate ?? null].filter((d): d is string => d !== null && d !== "").sort().pop() ?? null;

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
  let planOk = true;
  if (workouts !== null && workoutsComplete) {
    try {
      const stored = await plans.load();
      if (stored) {
        const trained = new Map<string, string>();
        for (const w of workouts) trained.set(workoutDate(w), trained.get(workoutDate(w)) ?? w.workoutKey);
        const items = stored.plan.sessions
          .filter((s) => s.date >= from && s.date <= today)
          .map((s) => ({ date: s.date, title: s.title, status: trained.has(s.date) ? ("done" as const) : s.date < today ? ("missed" as const) : ("pending" as const), ...(trained.has(s.date) ? { workoutKey: trained.get(s.date) } : {}) }));
        plan = { from, items, done: items.filter((i) => i.status === "done").length, missed: items.filter((i) => i.status === "missed").length, pending: items.filter((i) => i.status === "pending").length, todaySession: planSessionOn(stored.plan, today)?.title ?? null };
      }
    } catch (err: any) {
      planOk = false;
      plan = { error: err?.message ?? String(err) };
      errors.push({ section: "plan", error: err?.message ?? String(err) });
    }
  } else if (workouts === null) {
    notes.push("Plan items were not checked: the workouts could not be read.");
  } else {
    notes.push("Plan items were not checked: the workout list was not read completely.");
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
    const allRead = workoutsComplete && sleepRes !== null && recoveryRes !== null && planOk;
    const marking = async () => {
      const current: SeenState = (await seen.load()) ?? { workouts: [], workoutDate: null, cursorMs: null, sleepEndMs: null, recoveryAtMs: null, seenThrough: null, updatedAt: "" };
      const next: SeenState = { ...current, updatedAt: now.toISOString() };
      if (workoutRes !== null && workouts !== null) {
        const known = new Map(current.workouts.map((w) => [w.key, w.startMs]));
        for (const w of workouts) known.set(w.workoutKey, w.startTime);
        next.workouts = [...known].map(([key, startMs]) => ({ key, startMs })).filter((w) => w.startMs >= nowMs - KEEP_KEYS_MS).sort((a, b) => b.startMs - a.startMs).slice(0, MAX_SEEN_KEYS);
        next.workoutDate = [current.workoutDate, windowLast].filter((d): d is string => d !== null && d !== "").sort().pop() ?? null;
        next.cursorMs = workoutRes.complete ? null : workoutRes.cursor;
      }
      if (nights !== null) next.sleepEndMs = maxOf(current.sleepEndMs, ...nights.map((n) => n.endMs));
      if (recoveryRes !== null) next.recoveryAtMs = maxOf(current.recoveryAtMs, ...stamped.map((x) => x.t));
      // the review window (sleep, recovery, plan items) closes only when every section was read, so a section
      // that failed on one day is still looked at on the next
      if (allRead && (next.seenThrough == null || today > next.seenThrough)) next.seenThrough = today;
      await seen.save(next);
    };
    const done = queue.then(marking);
    queue = done.catch(() => undefined);
    await done;
    result.marked = true;
    if (!allRead) notes.push("markSeen moved the markers of the sections that were read; the review window (sleep, recovery, plan items) stays open until every section has been read, so what a failed section missed shows up next time.");
  }
  return result;
}
