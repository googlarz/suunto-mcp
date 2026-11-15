// get_benchmark: one repeatable session (a guide such as "PUSH A", or one exercise) as a series over its occurrences:
// per exercise the load, planned reps and end-of-rest heart rate, per session the duration, TSS and the median end-of-rest
// HR, each with first / last / best and a trend by one stated rule. The sessions come from get_exercise_history's own
// reader (collectRecords: cache, rate limit and journal included), joined to the workout list's summary for duration and TSS.
import type { SuuntoClient } from "./api.js";
import { norm } from "./compare.js";
import { PLANNED, collectRecords, loadOf, nameMatches, type ExerciseRecord, type HistoryDeps, type WorkoutRecord } from "./history.js";
import type { JournalEntry } from "./journal.js";
import { summarizeWorkouts } from "./snapshot.js";

// Fewer occurrences than this and there is no trend: three is the least that has an older half, a newer half and a middle.
export const MIN_OCCURRENCES = 3;
// A newer-half median within this share of the older-half median is "flat": below it, a 2.5 kg step or a 2 bpm wobble is not a trend.
export const FLAT_SHARE = 0.03;
const MAX_GUIDES_LISTED = 15;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type Better = "higher" | "lower" | null;
export interface Series {
  n: number; // occurrences with a value
  first: number | null;
  last: number | null;
  best: number | null; // null when no direction is better (TSS) or there is no value
  better: Better;
  trend: "up" | "down" | "flat" | "insufficient";
  change: number | null; // newer-half median minus older-half median; null when insufficient
}

// `values` oldest first, null where an occurrence has none. Trend rule: with n values (n >= MIN_OCCURRENCES) the older
// half is the first floor(n/2), the newer half the last floor(n/2) (the middle one is left out when n is odd); 'up' or 'down'
// when the two medians differ by more than FLAT_SHARE of the older median (equal to it counts as flat), else 'flat'.
// No significance test: it says what moved, not that the move is real.
export function seriesOf(values: (number | null)[], better: Better): Series {
  const v = values.filter((x): x is number => x !== null);
  const n = v.length;
  const half = n >> 1;
  const base: Series = { n, first: n ? v[0] : null, last: n ? v[n - 1] : null, best: n && better ? (better === "higher" ? Math.max(...v) : Math.min(...v)) : null, better, trend: "insufficient", change: null };
  if (n < MIN_OCCURRENCES) return base;
  const older = median(v.slice(0, half));
  const newer = median(v.slice(n - half));
  const change = newer - older;
  return { ...base, trend: Math.abs(change) <= FLAT_SHARE * Math.abs(older) ? "flat" : change > 0 ? "up" : "down", change: r2(change) };
}

// The list's summary of a session (guide, duration, TSS), by the date the record carries.
const summaryOf = (rows: Map<string, any>, r: WorkoutRecord) => {
  const row = rows.get(r.workoutKey);
  return row ? summarizeWorkouts({ payload: [row] }, r.date)[0] : undefined;
};

const reps = (detail: string | null): number | null => {
  const m = detail === null ? null : PLANNED.exec(detail);
  return m ? Number(m[2]) : null;
};

// The sessions of `records` that ran the guide (by the guide's name in the workout list's summary), or that contain the
// exercise; `rows` are the list items by workoutKey. Pure.
export function benchmarkFrom(
  records: WorkoutRecord[],
  rows: Map<string, any>,
  journal: Record<string, JournalEntry>,
  query: { guide: string } | { exercise: string },
) {
  const sessions = records.flatMap((r) => {
    const summary = summaryOf(rows, r);
    const guide = summary?.guide ?? null;
    if ("guide" in query && (guide === null || norm(guide) !== norm(query.guide))) return [];
    const exercises = r.exercises.filter((e) => !("exercise" in query) || nameMatches(query.exercise, e));
    if (exercises.length === 0) return [];
    const shaped = exercises.map((e: ExerciseRecord) => {
      const { kg, source } = loadOf(e, journal[r.workoutKey]);
      return { name: e.name, detail: e.detail, kg, loadSource: source, reps: reps(e.detail), setsDone: e.setsDone, plannedSets: e.plannedSets, restEndHr: e.reliable && e.restAfterSet1 ? e.restAfterSet1.endHr : null, reliable: e.reliable };
    });
    const hrs = shaped.map((e) => e.restEndHr).filter((x): x is number => x !== null);
    return [{ date: r.date, workoutKey: r.workoutKey, guide, durationS: summary?.totalTimeS ?? null, tss: summary?.tss ?? null, restEndHrMedian: hrs.length ? Math.round(median(hrs)) : null, exercises: shaped }];
  });

  const groups = new Map<string, { name: string; kg: (number | null)[]; reps: (number | null)[]; restEndHr: (number | null)[] }>();
  for (const s of sessions) {
    for (const e of s.exercises) {
      const g = groups.get(norm(e.name)) ?? { name: e.name, kg: [], reps: [], restEndHr: [] };
      g.kg.push(e.kg);
      g.reps.push(e.reps);
      g.restEndHr.push(e.restEndHr);
      groups.set(norm(e.name), g);
    }
  }
  const series = {
    durationS: seriesOf(sessions.map((s) => s.durationS), "lower"),
    tss: seriesOf(sessions.map((s) => s.tss), null),
    restEndHrMedian: seriesOf(sessions.map((s) => s.restEndHrMedian), "lower"),
    exercises: [...groups.values()].map((g) => ({ name: g.name, kg: seriesOf(g.kg, "higher"), reps: seriesOf(g.reps, "higher"), restEndHr: seriesOf(g.restEndHr, "lower") })),
  };
  return { sessions, series };
}

export async function buildBenchmark(
  client: Pick<SuuntoClient, "listWorkouts" | "getWorkoutWithExtensions" | "getWorkoutFit">,
  opts: { guide?: string; exercise?: string; weeks?: number; date?: string },
  deps: HistoryDeps = {},
) {
  const [guide, exercise] = [opts.guide?.trim(), opts.exercise?.trim()];
  if ((guide === undefined || guide === "") === (exercise === undefined || exercise === "")) throw new Error("Give exactly one of guide (a guide's title, e.g. 'PUSH A') or exercise (an exercise name).");
  const { from, to, items, ordered, journal, pending, errors, notes: shared } = await collectRecords(client, opts, deps);
  const rows = new Map(items.map((i) => [i.key, i.row]));
  const query = guide ? { guide } : { exercise: exercise! };
  const { sessions, series } = benchmarkFrom(ordered, rows, journal, query);

  const notes = [
    `Series run oldest to newest over the sessions in ${from}..${to} that ${guide ? `ran the guide "${guide}"` : `contain the exercise "${exercise}"`}, matched ignoring case, accents and punctuation. Weights and planned reps come from the guide's text unless a log_session entry logged weights (loadSource 'journal'); the watch does not record them.`,
    `Per series: n (occurrences with a value), first, last, best (highest kg and reps, lowest duration and heart rate; TSS has no better direction: null) and trend. Trend rule: with at least ${MIN_OCCURRENCES} values, the median of the older half is compared with the median of the newer half (the middle one is left out when n is odd); 'up' or 'down' when they differ by more than ${FLAT_SHARE * 100}% of the older median (exactly ${FLAT_SHARE * 100}% is flat), else 'flat'; change is that difference. With fewer values it is 'insufficient'. No significance test: it says what moved, not that the move is real, and sessions differ in more than the one thing you changed.`,
    "durationS and tss are the workout list's own totalTime and Suunto's HR-based TSS (null when Suunto gave none). restEndHr is the end-of-rest heart rate after set 1 and counts only sessions whose heart-rate data is reliable; restEndHrMedian is the median of those within a session (rounded).",
    ...shared,
  ];
  if (sessions.length < MIN_OCCURRENCES) notes.push(`${sessions.length} occurrence(s) found, fewer than ${MIN_OCCURRENCES}: no trend is given. Use a longer range (weeks) or call again until pending is 0.`);
  if (sessions.length === 0 && guide) {
    const seen = [...new Set(ordered.map((r) => summaryOf(rows, r)?.guide).filter((g): g is string => !!g))].slice(0, MAX_GUIDES_LISTED);
    notes.push(`No session ran a guide called "${guide}" in ${from}..${to}.${seen.length ? ` Guides seen: ${seen.join("; ")}.` : ""}`);
  }
  if (sessions.length === 0 && exercise) notes.push(`No session contains an exercise matching "${exercise}" in ${from}..${to}.`);

  return { mode: guide ? "guide" : "exercise", name: guide ?? exercise, from, to, occurrences: sessions.length, sessions, series, pending, errors, notes };
}
