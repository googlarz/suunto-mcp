// get_training_load: Fitness (CTL), Fatigue (ATL) and Form (TSB) over a range
// of days, computed from workout TSS — Suunto's API has no endpoint for them.
// The model is shared with the daily digest (daily-digest.ts), which rolls it
// forward one day at a time in its sidecar file; this computes it from scratch
// for any range and writes nothing.
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, workoutDate } from "./api.js";
import { isValidCalendarDate } from "./schema-validate.js";

// ---------- Pure math ----------

// Standard TrainingPeaks-style exponential time constants: CTL = 42-day
// decay, ATL = 7-day decay. Verified: 1 - e^(-1/42) = 0.02353, 1 - e^(-1/7) = 0.13353.
export const K_CTL = 1 - Math.exp(-1 / 42);
export const K_ATL = 1 - Math.exp(-1 / 7);

export function rollCtlAtl(
  prevCtl: number,
  prevAtl: number,
  todayTss: number,
): { ctl: number; atl: number } {
  return {
    ctl: prevCtl * (1 - K_CTL) + todayTss * K_CTL,
    atl: prevAtl * (1 - K_ATL) + todayTss * K_ATL,
  };
}

// A workout's TSS as the digest counts it: tss.trainingStressScore (the
// HR-based value, confirmed live), 0 when Suunto computed none.
export function workoutTss(w: any): number {
  return w?.tss?.trainingStressScore ?? 0;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface DayLoad {
  workouts: number;
  durationS: number;
  tss: number;
  noTss: number; // workouts without a TSS from Suunto (counted as 0)
}

// Per local date — each workout's own date (see workoutDate). A workout without
// a usable startTime can't be placed on a day; it is only counted in `undated`.
export function aggregateByDay(workouts: any[]): { days: Map<string, DayLoad>; undated: number } {
  const days = new Map<string, DayLoad>();
  let undated = 0;
  for (const w of workouts ?? []) {
    const date = workoutDate(w);
    if (date === "") {
      undated++;
      continue;
    }
    const day = days.get(date) ?? { workouts: 0, durationS: 0, tss: 0, noTss: 0 };
    day.workouts++;
    day.durationS += typeof w?.totalTime === "number" && Number.isFinite(w.totalTime) ? w.totalTime : 0;
    day.tss += workoutTss(w);
    if (typeof w?.tss?.trainingStressScore !== "number") day.noTss++;
    days.set(date, day);
  }
  return { days, undated };
}

export interface LoadPoint {
  date: string;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}

// One point per date from..to inclusive, each the state at the END of that
// day. `start` is the state at the end of the day before `from`. A date with no
// entry rolls forward with TSS 0 (a rest day).
export function rollForward(
  tssByDate: Map<string, { tss: number }>,
  from: string,
  to: string,
  start = { ctl: 0, atl: 0 },
): LoadPoint[] {
  const points: LoadPoint[] = [];
  let { ctl, atl } = start;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const tss = tssByDate.get(date)?.tss ?? 0;
    ({ ctl, atl } = rollCtlAtl(ctl, atl, tss));
    points.push({ date, tss, ctl, atl, tsb: ctl - atl });
  }
  return points;
}

// The Monday of the date's week. Dates here are already local calendar dates.
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

// Totals per Monday-to-Sunday week, counting only the days from..to — the
// first and last week can be partial.
export function weeklyTotals(days: Map<string, DayLoad>, from: string, to: string) {
  const weeks = new Map<string, { weekStart: string; workouts: number; durationS: number; tss: number }>();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const key = weekStart(date);
    const week = weeks.get(key) ?? { weekStart: key, workouts: 0, durationS: 0, tss: 0 };
    const day = days.get(date);
    if (day) {
      week.workouts += day.workouts;
      week.durationS += day.durationS;
      week.tss += day.tss;
    }
    weeks.set(key, week);
  }
  return [...weeks.values()];
}

// ---------- The call ----------

export const DEFAULT_DAYS = 28;
export const MAX_DAYS = 120;
// Without a seed, CTL/ATL start from 0 this many days before the window, so the
// window itself isn't cold-started: e^(-180/42) leaves ~1.4% of the true starting CTL
// (120 days left ~6%, which read CTL about 0.4 low against a full-history run on real data).
export const WARMUP_DAYS = 180;
// Warm-up plus the longest window is 300 days; 600 covers two workouts every
// day. listWorkouts pages 50 at a time and stops at the first short page, so a
// lighter history costs fewer requests (about 2-3 for a typical year).
export const WORKOUT_LIMIT = 600;

const r1 = (n: number): number => Math.round(n * 10) / 10;

export interface TrainingLoadOptions {
  date: string; // last day of the window
  days?: number;
  seedCtl?: number; // CTL/ATL at the end of the day before the window; skips the warm-up
  seedAtl?: number;
}

export async function buildTrainingLoad(client: SuuntoClient, opts: TrainingLoadOptions) {
  const to = opts.date;
  const days = opts.days ?? DEFAULT_DAYS;
  if (!isValidCalendarDate(to)) throw new Error(`"${to}" is not a valid calendar date (YYYY-MM-DD).`);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`days must be an integer from 1 to ${MAX_DAYS}, got ${days}.`);

  const from = addDays(to, -(days - 1));
  const seeded = opts.seedCtl !== undefined || opts.seedAtl !== undefined;
  const start = { ctl: opts.seedCtl ?? 0, atl: opts.seedAtl ?? 0 };
  const rollStart = seeded ? from : addDays(from, -WARMUP_DAYS);

  // Wide UTC bounds, then every workout is placed on its own local date.
  const bounds = dayFetchBounds(rollStart, to);
  const res = await client.listWorkouts({ since: bounds.from, until: bounds.to, limit: WORKOUT_LIMIT });
  const rows: any[] = Array.isArray(res?.payload) ? res.payload : [];
  const { days: byDay, undated } = aggregateByDay(rows);

  const all = rollForward(byDay, rollStart, to, start);
  const series = all.slice(-days);
  const ctlOn = new Map(all.map((p) => [p.date, p.ctl]));
  if (seeded) ctlOn.set(addDays(from, -1), start.ctl);
  const last = series[series.length - 1];
  const ctlWeekAgo = ctlOn.get(addDays(to, -7));

  const inRange = (lo: string) => [...byDay].filter(([d]) => d >= lo && d <= to);
  const windowDays = inRange(from).map(([, day]) => day);
  const windowWorkouts = windowDays.reduce((n, d) => n + d.workouts, 0);
  const windowNoTss = windowDays.reduce((n, d) => n + d.noTss, 0);

  const notes = [
    "CTL can be about 1 point off the watch's Fitness value: checked once against the Suunto app, ATL and TSB matched and CTL was about 0.9 lower. Read CTL as ±1.",
    "A day without workouts has tss 0: a rest day, not missing data.",
  ];
  if (windowWorkouts === 0) {
    notes.push(`No workouts at all from ${from} to ${to}, so every tss is 0. If that is unexpected, check that the watch has synced.`);
  }
  if (seeded) {
    notes.push(`Started from CTL ${start.ctl} / ATL ${start.atl} (the seeds) as the values at the end of ${addDays(from, -1)}; no earlier workouts were read.`);
  } else {
    notes.push(`CTL/ATL start from 0 on ${rollStart} (${WARMUP_DAYS} days before ${from}) and roll forward through every workout since.`);
    const first = inRange(rollStart).map(([d]) => d).sort()[0];
    if (first !== undefined && first > addDays(from, -42)) {
      notes.push(`Little history: the earliest workout found is on ${first} (searched back to ${rollStart}). CTL needs about 4-6 weeks of history to converge, so it reads low unless there really was no training before then. Pass seedCtl/seedAtl from the watch to anchor it.`);
    }
  }
  if (windowNoTss > 0) notes.push(`${windowNoTss} workout(s) from ${from} to ${to} have no TSS from Suunto and count as 0.`);
  if (undated > 0) notes.push(`${undated} workout(s) have no start time, so they can't be placed on a day and are left out.`);
  if (rows.length >= WORKOUT_LIMIT) {
    notes.push(`Reached the ${WORKOUT_LIMIT}-workout limit: some workouts from ${rollStart} to ${to} may be missing, so tss, CTL and ATL may be too low. Ask for fewer days.`);
  }

  return {
    from,
    to,
    current: {
      ctl: r1(last.ctl),
      atl: r1(last.atl),
      tsb: r1(last.tsb),
      rampRate7d: ctlWeekAgo === undefined ? null : r1(last.ctl - ctlWeekAgo),
    },
    weeks: weeklyTotals(byDay, from, to).map((w) => ({ ...w, durationS: r1(w.durationS), tss: r1(w.tss) })),
    series: series.map((p) => ({ date: p.date, tss: r1(p.tss), ctl: r1(p.ctl), atl: r1(p.atl), tsb: r1(p.tsb) })),
    notes,
  };
}
