// get_tag_effects: does the night after a session with a tag (log_session `tags`) look different from the night after a
// session without it? Per tag and per sleep metric it compares the nights that followed tagged days with the nights that
// followed other training days, and says "insufficient" unless there are enough of both and the gap is larger than what
// chance alone would produce (a multiple of the standard error of the difference of the two medians, from the untagged
// nights' own spread). It reports an association in the user's own data; it never claims a cause.
// The nights come from the same code as get_baselines (nightMetrics); this adds the join with the journal. Read-only.
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, localDate, nightOf, rowDate, workoutDate } from "./api.js";
import { METRICS, nightMetrics, quantile } from "./baselines.js";
import { loadJournal, validEntries, type JournalEntry } from "./journal.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { previousDate } from "./snapshot.js";
import { addDays } from "./training-load.js";

export const DEFAULT_DAYS = 90;
export const MIN_DAYS = 30; // the least that can hold MIN_NIGHTS tagged and MIN_NIGHTS untagged nights
export const MAX_DAYS = 180;
// Tagged AND untagged nights each, with a value for the metric. Below this a median of the nights is too loose for the
// standard-error rule to hold (at 8 + 8 a plain "bigger than the usual spread" rule flagged about a quarter of metrics with no effect).
export const MIN_NIGHTS = 15;
// A metric differs only when |median(tagged) - median(untagged)| > K * SE, SE = 1.25 * (IQR_untagged / 1.35) * sqrt(1/nTagged + 1/nUntagged):
// 1.25 sigma / sqrt(n) is the standard error of a median, IQR / 1.35 an outlier-resistant sigma. K = 3: the usual 2 sigma
// plus an allowance for the 4 metrics tested per tag and for nights being autocorrelated. Chosen by the seeded simulation in
// tag-effects.test.ts: K = 2.5 flagged 17% of tags with no effect at 15 nights per group (4.7% per metric, the estimated
// spread being noisy at that size), K = 3 flags 9%, 5% and 3% at 15, 20 and 30.
export const SE_K = 3;
const WORKOUT_LIMIT = 600;
// measured by the simulation in tag-effects.test.ts (4 metrics, no real difference): independent nights
const FALSE_ALARM = "about 9% (15 nights per group), 5% (20) and 3% (30)";
const FALSE_ALARM_CORRELATED = "11% to 22%";
const NIGHT_METRICS = ["sleepDurationS", "sleepScore", "hrv", "recoveryMorning"] as const;

export type EffectVerdict = "insufficient" | "within-noise" | "tagged-higher" | "tagged-lower";

const ascending = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const median = (xs: number[]): number | null => (xs.length ? quantile(ascending(xs), 0.5) : null);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// The bar a median difference has to clear (unrounded); null without untagged nights.
export function thresholdOf(control: number[], nTagged: number): number | null {
  if (control.length === 0) return null;
  const sorted = ascending(control);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  return SE_K * 1.25 * (iqr / 1.35) * Math.sqrt(1 / nTagged + 1 / control.length);
}

// One metric of one tag. Verdict: insufficient below MIN_NIGHTS of either group; otherwise the MEDIAN difference must be
// larger than the threshold (equal is within noise), compared as printed (rounded) so it never contradicts the numbers.
export function effectOf(tagged: number[], control: number[], round: (n: number) => number) {
  const rounded = (x: number | null) => (x === null ? null : round(x));
  const [tMed, cMed] = [median(tagged), median(control)];
  const medianDiff = tMed === null || cMed === null ? null : round(tMed - cMed);
  const meanDiff = tagged.length && control.length ? round(mean(tagged)! - mean(control)!) : null;
  const sorted = ascending(control);
  const controlIqr = control.length ? rounded(quantile(sorted, 0.75) - quantile(sorted, 0.25)) : null;
  const threshold = tagged.length ? rounded(thresholdOf(control, tagged.length)) : null;
  let verdict: EffectVerdict = "insufficient";
  if (tagged.length >= MIN_NIGHTS && control.length >= MIN_NIGHTS && threshold !== null && medianDiff !== null) {
    verdict = Math.abs(medianDiff) > threshold ? (medianDiff > 0 ? "tagged-higher" : "tagged-lower") : "within-noise";
  }
  return { nTagged: tagged.length, nControl: control.length, taggedMedian: rounded(tMed), controlMedian: rounded(cMed), medianDiff, meanDiff, controlIqr, noiseThreshold: threshold, verdict };
}

type Client = Pick<SuuntoClient, "listWorkouts" | "listSleep" | "listRecovery">;
export interface TagEffectsDeps {
  loadJournal?: () => Promise<Record<string, JournalEntry>>;
}

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

export async function buildTagEffects(client: Client, opts: { date?: string; days?: number; tag?: string }, deps: TagEffectsDeps = {}) {
  const date = opts.date ?? localDate();
  const days = opts.days ?? DEFAULT_DAYS;
  if (!isValidCalendarDate(date)) throw new Error(`"${date}" is not a valid calendar date (YYYY-MM-DD).`);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw new Error(`days must be an integer from ${MIN_DAYS} to ${MAX_DAYS}, got ${days}.`);
  if (opts.tag !== undefined && opts.tag.trim() === "") throw new Error("tag must not be empty.");
  const only = opts.tag?.trim().toLowerCase();

  // Nights: the one that led into each day from..to. The night that led into `date` itself may still be recording, so
  // it is left out. A session on day S is followed by the night that led into S + 1.
  const from = addDays(date, -days);
  const to = previousDate(date);
  const { entries, ignored } = validEntries(await (deps.loadJournal ?? loadJournal)());

  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: err?.message ?? String(err) });
      return null;
    }
  };
  const bounds = dayFetchBounds(previousDate(from), previousDate(to));
  const [workoutRes, sleepRes, recoveryRes] = await Promise.all([
    client.listWorkouts({ since: bounds.from, until: bounds.to, limit: WORKOUT_LIMIT }),
    section("sleep", () => client.listSleep(previousDate(from), previousDate(to))),
    section("recovery", () => client.listRecovery(from, to)),
  ]);
  const nights = sleepRes === null ? null : groupBy(rowsOf(sleepRes), (r) => nightOf(r) ?? "");
  const recovery = recoveryRes === null ? null : groupBy(rowsOf(recoveryRes), rowDate);

  // The sessions on days whose next night is in the window, oldest first; per day, how many carry each tag.
  const inRange = rowsOf(workoutRes)
    .filter((w) => workoutDate(w) >= previousDate(from) && workoutDate(w) <= previousDate(to))
    .sort((a, b) => a.startTime - b.startTime);
  const sessionDays = new Map<string, Map<string, number>>();
  const spelled = new Map<string, string>(); // lower case -> the spelling used first
  for (const w of inRange) {
    const day = sessionDays.get(workoutDate(w)) ?? new Map<string, number>();
    for (const t of entries[String(w?.workoutKey ?? "").toLowerCase()]?.tags ?? []) {
      day.set(t.toLowerCase(), (day.get(t.toLowerCase()) ?? 0) + 1);
      if (!spelled.has(t.toLowerCase())) spelled.set(t.toLowerCase(), t);
    }
    sessionDays.set(workoutDate(w), day);
  }
  const trainingDays = [...sessionDays.keys()].sort();

  // one value per metric per night of the window (null: none)
  const values = new Map<string, Record<string, number | null>>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    values.set(d, nightMetrics(nights === null ? null : nights.get(previousDate(d)) ?? [], recovery === null ? null : recovery.get(d) ?? []));
  }
  const roundOf = (name: string) => METRICS.find((m) => m.name === name)!.round;

  const result = [...spelled]
    .filter(([lower]) => only === undefined || lower === only)
    .map(([lower, tag]) => {
      const taggedDays = trainingDays.filter((d) => sessionDays.get(d)!.has(lower));
      const untaggedDays = trainingDays.filter((d) => !sessionDays.get(d)!.has(lower));
      const metrics = Object.fromEntries(
        NIGHT_METRICS.map((m) => {
          const pick = (days: string[]) => days.map((s) => values.get(addDays(s, 1))![m]).filter((x): x is number => x !== null);
          return [m, effectOf(pick(taggedDays), pick(untaggedDays), roundOf(m))];
        }),
      );
      const verdicts = Object.values(metrics).map((e) => e.verdict);
      const verdict = verdicts.every((v) => v === "insufficient") ? "insufficient" : verdicts.some((v) => v === "tagged-higher" || v === "tagged-lower") ? "differs" : "within-noise";
      return {
        tag,
        statement: `${tag}: ${verdict} (${taggedDays.length} tagged vs ${untaggedDays.length} untagged nights; at least ${MIN_NIGHTS} of each are needed; ${NIGHT_METRICS.length} metrics tested): an association, not a cause.`,
        taggedSessions: taggedDays.reduce((n, d) => n + sessionDays.get(d)!.get(lower)!, 0),
        taggedNights: taggedDays.length,
        untaggedNights: untaggedDays.length,
        verdict,
        metrics,
      };
    })
    .sort((a, b) => b.taggedNights - a.taggedNights || a.tag.localeCompare(b.tag));

  const notes = [
    "An association in your own data, not a cause: a tagged session and a poor night can share a third reason (a hard week, a late meal, a cold coming). Nothing here shows the tag changed the night.",
    `Per tag, the nights that followed a day with a session carrying the tag are compared with the nights that followed other training days: a day without a session is a rest day and is in neither group, and a session with no journal entry counts as untagged. A day with several sessions is one night, tagged when any of its sessions is. A session that starts after midnight counts on its own calendar day, so its night is taken to be the one that begins that evening, not the sleep that follows the session.`,
    `Verdict rule: 'insufficient' below ${MIN_NIGHTS} tagged or ${MIN_NIGHTS} untagged nights with a value for the metric (at least ${MIN_NIGHTS} tagged and ${MIN_NIGHTS} untagged nights are needed); otherwise 'tagged-higher' / 'tagged-lower' only when |median(tagged) - median(untagged)| > ${SE_K} * 1.25 * (IQR of the untagged nights / 1.35) * sqrt(1/nTagged + 1/nUntagged), else 'within-noise' (equal is within noise; compared as printed). That is ${SE_K} standard errors of the difference of two medians, the spread taken from the untagged nights themselves; K = ${SE_K} is about 2 sigma plus an allowance for the ${NIGHT_METRICS.length} metrics tested per tag and for nights being autocorrelated. The tag's verdict is 'differs' when any metric is higher or lower, 'insufficient' when all are, else 'within-noise'.`,
    `False alarms: ${NIGHT_METRICS.length} metrics are tested per tag, so some chance of a spurious 'differs' remains. In simulations of independent nights with NO real difference, ${FALSE_ALARM} of tags were flagged on at least one metric; with nights correlated 0.3 night to night the same simulation flagged ${FALSE_ALARM_CORRELATED}, and real nights do follow one another, so expect the higher figures. Treat one 'differs' as a lead to watch, not a finding; it counts for more when it repeats on a later window or on related metrics.`,
    `Nights are those that led into ${from}..${to} (the night into ${date} may still be recording and is left out). Sleep values are the main sleep's, as in get_baselines; recoveryMorning is the Balance nearest its end. A night without a value is left out of that metric's counts, never counted as 0. Consecutive days are not independent samples.`,
  ];
  if (spelled.size === 0) notes.push("No session in the window carries a tag. Tag sessions with log_session (tags: ['heavy', 'late']), or send tags alone to add them to an entry that exists.");
  else if (only !== undefined && result.length === 0) notes.push(`No session in the window carries the tag "${opts.tag}".`);
  if (rowsOf(workoutRes).length >= WORKOUT_LIMIT) notes.push(`Reached the ${WORKOUT_LIMIT}-workout limit; sessions at the start of the window may be missing.`);
  if (ignored > 0) notes.push(`${ignored} journal ${ignored === 1 ? "entry" : "entries"} ignored: not a valid log_session entry (fix or delete ${ignored === 1 ? "it" : "them"} in the journal file).`);

  return {
    date,
    from,
    to,
    nights: days,
    sessionDays: trainingDays.length,
    thresholds: {
      minTaggedNights: MIN_NIGHTS,
      minUntaggedNights: MIN_NIGHTS,
      k: SE_K,
      rule: `|median(tagged) - median(untagged)| > ${SE_K} * 1.25 * (IQR of the untagged nights / 1.35) * sqrt(1/nTagged + 1/nUntagged)`,
      metricsTested: NIGHT_METRICS.length,
      compared: "median of the nights after tagged days minus median of the nights after other training days",
    },
    journal: { entries: Object.keys(entries).length, ignored },
    tags: result,
    notes,
    errors,
  };
}
