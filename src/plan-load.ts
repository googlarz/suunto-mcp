// What propose_next_week and simulate_plan share: a session's TSS estimated from the user's own history of the same
// title, the CTL/ATL/TSB projection (the same math as forecast_training_load, rolled forward from today's values), and
// the two load rules both apply to a planned week (the TSB floor and the jump over the last 4 weeks' average).
// Pure functions, no I/O. Every number computed here is model-based: a projection, never a prediction of a response.
import { norm } from "./compare.js";
import { addDays, rollForward, weekStart as mondayOf, workoutTss, type LoadPoint } from "./training-load.js";

// A session title's TSS is estimated from this many days of the user's workouts.
export const TSS_HISTORY_DAYS = 90;
// Fewer sessions of one title than this and its median says more about the sample than about the session.
export const MIN_TSS_SESSIONS = 2;
// Defaults of the rules below (propose_next_week lets the caller change them; simulate_plan uses these).
// TSB below -30 is the "high risk" zone of the usual TrainingPeaks-style reading of Form: a convention, not a measurement.
export const TSB_RISK_FLOOR = -30;
// A week's TSS more than 30% over the average week of the 28 days before it: the upper edge of the 0.8-1.3
// acute:chronic workload "sweet spot" (Gabbett); a heuristic with contested evidence, not a safe/unsafe line.
export const WEEKLY_JUMP_PCT = 30;
// The 28 days (4 weeks) the weekly jump is measured against.
export const PRIOR_DAYS = 28;

export const r1 = (n: number): number => Math.round(n * 10) / 10;
export const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The guide a workout ran, as the workout list names it (SummaryExtension.apps[0].name); null when it ran none.
export function guideNameOf(row: any): string | null {
  const summary = (row?.extensions ?? []).find((e: any) => e?.type === "SummaryExtension");
  const name = summary?.apps?.[0]?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

export interface TssEstimate {
  tss: number | null; // the median TSS (1 decimal) of the sessions of that title, null below MIN_TSS_SESSIONS
  sessions: number; // how many sessions of that title carry a TSS
}

// Title match ignores case, accents and punctuation (as get_benchmark does). A session without a TSS from Suunto is not counted:
// it is no evidence of 0.
export function estimateTss(rows: any[], title: string): TssEstimate {
  const key = norm(title);
  const values =
    key === ""
      ? []
      : rows.filter((w) => {
          const g = guideNameOf(w);
          return g !== null && norm(g) === key && typeof w?.tss?.trainingStressScore === "number";
        }).map(workoutTss);
  return { tss: values.length >= MIN_TSS_SESSIONS ? r1(median(values)!) : null, sessions: values.length };
}

export interface RoundedPoint {
  date: string;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}
export const roundPoint = (p: LoadPoint): RoundedPoint => ({ date: p.date, tss: r1(p.tss), ctl: r1(p.ctl), atl: r1(p.atl), tsb: r1(p.tsb) });

// forecast_training_load's math: from the state at the end of `asOf`, one point per day from the day after asOf to `to`,
// a date without an entry is a rest day.
export function projectLoad(start: { ctl: number; atl: number }, tssByDate: Map<string, { tss: number }>, asOf: string, to: string): LoadPoint[] {
  return rollForward(tssByDate, addDays(asOf, 1), to, start);
}

export interface WeekLoad {
  tss: number; // the week's TSS, Monday to Sunday
  previous4wAvgTss: number; // the average week of the 28 days before the Monday
  jumpPct: number | null; // (tss - average) / average, in percent, 1 decimal; null when the average is 0
  trips: boolean; // jumpPct > thresholdPct, compared as printed
}

// `daily`: TSS per date (a date left out is a rest day).
export function weekLoad(daily: Map<string, number>, monday: string, thresholdPct: number): WeekLoad {
  let tss = 0;
  for (let i = 0; i < 7; i++) tss += daily.get(addDays(monday, i)) ?? 0;
  let prior = 0;
  for (let i = 1; i <= PRIOR_DAYS; i++) prior += daily.get(addDays(monday, -i)) ?? 0;
  const avg = prior / (PRIOR_DAYS / 7);
  const jumpPct = avg > 0 ? r1(((tss - avg) / avg) * 100) : null;
  return { tss: r1(tss), previous4wAvgTss: r1(avg), jumpPct, trips: jumpPct !== null && jumpPct > thresholdPct };
}

// The lowest TSB of `points` (the first one when tied), and whether it is under the floor, compared as printed.
export function tsbFloorCheck(points: RoundedPoint[], floor: number): { minTsb: number | null; date: string | null; trips: boolean } {
  let low: RoundedPoint | null = null;
  for (const p of points) if (low === null || p.tsb < low.tsb) low = p;
  return { minTsb: low?.tsb ?? null, date: low?.date ?? null, trips: low !== null && low.tsb < floor };
}

export { mondayOf };
