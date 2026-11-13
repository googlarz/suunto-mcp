// get_baselines: the user's own recent norms for sleep, HRV, recovery and steps,
// so "HRV below recent level" has something to be compared with. One request per
// section for the whole span, reduced to a per-day value per metric, then to a
// band (quartiles) over the `days` days before the judged date. Pure functions
// plus one orchestrator over SuuntoClient, like snapshot.ts and training-load.ts.
import type { SuuntoClient } from "./api.js";
import { nightOf, rowDate } from "./api.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { nearestSample, previousDate, summarizeActivity, summarizeRecovery, summarizeSleep } from "./snapshot.js";
import { addDays } from "./training-load.js";

export const DEFAULT_DAYS = 28;
export const MIN_DAYS = 14;
export const MAX_DAYS = 90;
// Fewer values than this and a quartile band says more about the sample than the person.
export const MIN_BAND_N = 7;
const LAST_DAYS = 7;
const MIN_LAST_N = 4;

// Quantile of an ascending-sorted array by linear interpolation between order
// statistics: position h = (n - 1) * p (0-based), value = x[floor(h)] + (h - floor(h)) * (x[floor(h) + 1] - x[floor(h)]).
// For the median this is the middle value (odd n) or the mean of the two middle values (even n).
export function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

const present = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null);
const ascending = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

export type BandPosition = "below" | "within" | "above";

export interface MetricBand {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  last7Median: number | null;
  latest: number | null;
  latestVsBand: BandPosition | null;
}

// `window`: one value per day of the baseline window, oldest first, null where
// the day has none (a missing day is not 0 and is not counted). `latest`: the
// value of the judged date. The band edges are inclusive: a value on p25 or p75 is within.
export function bandOf(window: (number | null)[], latest: number | null, round: (n: number) => number): MetricBand {
  const values = ascending(present(window));
  const n = values.length;
  const banded = n >= MIN_BAND_N;
  const p25 = banded ? quantile(values, 0.25) : null;
  const p75 = banded ? quantile(values, 0.75) : null;
  const lastValues = ascending(present(window.slice(-LAST_DAYS)));
  const rounded = (x: number | null) => (x === null ? null : round(x));
  return {
    n,
    median: banded ? round(quantile(values, 0.5)) : null,
    p25: rounded(p25),
    p75: rounded(p75),
    last7Median: lastValues.length >= MIN_LAST_N ? round(quantile(lastValues, 0.5)) : null,
    latest: rounded(latest),
    latestVsBand: latest === null || p25 === null || p75 === null ? null : latest < p25 ? "below" : latest > p75 ? "above" : "within",
  };
}

const roundTo = (digits: number) => (n: number) => Math.round(n * 10 ** digits) / 10 ** digits;

type Section = "sleep" | "recovery" | "activity";
const METRICS: { name: string; round: (n: number) => number; needs: Section[]; latestIsPartial: boolean }[] = [
  { name: "sleepDurationS", round: roundTo(0), needs: ["sleep"], latestIsPartial: false },
  { name: "sleepScore", round: roundTo(1), needs: ["sleep"], latestIsPartial: false },
  { name: "hrv", round: roundTo(1), needs: ["sleep"], latestIsPartial: false },
  { name: "recoveryMorning", round: roundTo(2), needs: ["sleep", "recovery"], latestIsPartial: false },
  { name: "recoveryLow", round: roundTo(2), needs: ["recovery"], latestIsPartial: true },
  { name: "steps", round: roundTo(1), needs: ["activity"], latestIsPartial: true },
];

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

export interface BaselinesOptions {
  date: string; // the day being judged; never part of its own baseline
  days?: number; // length of the baseline window, MIN_DAYS..MAX_DAYS
}

export async function buildBaselines(client: SuuntoClient, opts: BaselinesOptions) {
  const date = opts.date;
  const days = opts.days ?? DEFAULT_DAYS;
  if (!isValidCalendarDate(date)) throw new Error(`"${date}" is not a valid calendar date (YYYY-MM-DD).`);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw new Error(`days must be an integer from ${MIN_DAYS} to ${MAX_DAYS}, got ${days}.`);

  const from = addDays(date, -days);
  const to = previousDate(date);

  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: Section, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: err?.message ?? String(err) });
      return null;
    }
  };

  // The night that led into day D is filed under D - 1, so the nights run one day earlier.
  const [sleepRes, recoveryRes, stats] = await Promise.all([
    section("sleep", () => client.listSleep(previousDate(from), to)),
    section("recovery", () => client.listRecovery(from, date)),
    section("activity", () => client.getDailyStats(`${from}T00:00:00`, `${date}T23:59:59`)),
  ]);
  const nights = sleepRes === null ? null : groupBy(rowsOf(sleepRes), (r) => nightOf(r) ?? "");
  const recovery = recoveryRes === null ? null : groupBy(rowsOf(recoveryRes), rowDate);

  // One value per metric per day, from..date inclusive; null when the day has none.
  const perDay: Record<string, (number | null)[]> = Object.fromEntries(METRICS.map((m) => [m.name, []]));
  const dates: string[] = [];
  for (let d = from; d <= date; d = addDays(d, 1)) dates.push(d);
  for (const d of dates) {
    const main = nights === null ? null : summarizeSleep(nights.get(previousDate(d)) ?? []).main;
    const dayRows = recovery?.get(d) ?? [];
    perDay.sleepDurationS.push(main?.durationS ?? null);
    perDay.sleepScore.push(main?.score ?? null);
    perDay.hrv.push(main?.avgHrv ?? null);
    perDay.recoveryMorning.push(recovery === null ? null : nearestSample(dayRows, main?.bedtimeEnd)?.balance ?? null);
    perDay.recoveryLow.push(recovery === null ? null : summarizeRecovery(dayRows)?.low.balance ?? null);
    perDay.steps.push(stats === null ? null : summarizeActivity(stats, d).steps);
  }

  const metrics: Record<string, MetricBand> = {};
  for (const m of METRICS) {
    const series = perDay[m.name];
    metrics[m.name] = bandOf(series.slice(0, -1), m.latestIsPartial ? null : series[series.length - 1], m.round);
  }

  const notes = [
    `The band [p25, p75] is the middle half of the user's own last ${days} days (${from} to ${to}), not a medical reference. median, p25 and p75 use linear interpolation between order statistics; last7Median is the median of the last 7 days of the window.`,
    "A day without a value is left out, never counted as 0. Each metric needs at least 7 days with a value for a band and 4 of the last 7 for last7Median; otherwise those are null.",
    "Sleep shorter than about 3 h is filed by Suunto as a nap and does not count as a main sleep, so a short night is a missing day here.",
    "Each day's sleep values are those of the night that led INTO that day. recoveryMorning is the Balance nearest the main sleep's end; recoveryLow is the lowest Balance of the local day. Balance x100 equals the watch's Resources %.",
    `latest is the value for ${date} itself. steps and recoveryLow are always null there: that day is still running.`,
  ];
  for (const m of METRICS) {
    if (m.needs.some((s) => errors.some((e) => e.section === s))) continue; // explained by errors
    if (metrics[m.name].n < MIN_BAND_N) notes.push(`${m.name}: only ${metrics[m.name].n} of ${days} days have a value, too little data for a band.`);
  }

  return { date, from, to, days, metrics, notes, errors };
}
