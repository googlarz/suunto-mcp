// simulate_plan: a what-if for a candidate week or multi-week plan. Read-only, writes nothing, no local state: it takes the
// plan as the argument, reads the user's workouts, sleep and recovery, and returns
//   - day-by-day CTL / ATL / TSB from today's values (forecast_training_load's math),
//   - TSB on `goalDate` against a stated 'fresh' band, the CTL ramp per week, and where the risk rules trip,
//   - `personalResponse`: how the user's OWN next-night HRV / recovery has differed after high-load days, ONLY when enough
//     history exists (get_tag_effects' own test: at least MIN_NIGHTS nights of each group and a gap larger than the noise).
// Every number is model-based: a projection of a simple model, never a prediction of how the user will respond.
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, localDate, nightOf, rowDate } from "./api.js";
import { METRICS, nightMetrics } from "./baselines.js";
import { MAX_SESSIONS } from "./plan.js";
import { MIN_TSS_SESSIONS, PRIOR_DAYS, TSB_RISK_FLOOR, TSS_HISTORY_DAYS, WEEKLY_JUMP_PCT, estimateTss, median, mondayOf, projectLoad, r1, roundPoint, tsbFloorCheck, weekLoad } from "./plan-load.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { MIN_NIGHTS, SE_K, effectOf } from "./tag-effects.js";
import { previousDate } from "./snapshot.js";
import { MAX_FORECAST_DAYS, MAX_PLANNED_TSS, addDays, aggregateByDay, buildTrainingLoad } from "./training-load.js";

// The stated 'fresh' band of TSB (Form): +5 to +25 is the usual "fresh, race-ready" reading; below it you are still carrying
// fatigue, above it you have probably rested long enough to lose fitness. A convention, not a measurement. Inclusive edges.
export const FRESH_TSB_MIN = 5;
export const FRESH_TSB_MAX = 25;
// CTL gain over a full Monday-to-Sunday week above which a ramp is flagged (about 8 points a week is the usual ceiling of a
// sustainable build). Strictly more than this trips.
export const CTL_RAMP_MAX = 8;
// The history the personal response is estimated from: the nights that followed the days of this many days before asOf.
export const RESPONSE_DAYS = TSS_HISTORY_DAYS;
const RESPONSE_METRICS = ["hrv", "recoveryMorning"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function onlyKeys(o: Record<string, unknown>, allowed: string[], path: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Error(`${path}${extra} is not a known field (allowed here: ${allowed.join(", ")})`);
}
const calendarDate = (v: unknown, path: string): string => {
  if (typeof v !== "string" || !isValidCalendarDate(v)) throw new Error(`${path} must be a calendar date YYYY-MM-DD`);
  return v;
};

export interface SessionIn {
  date: string;
  title?: string;
  tss?: number;
  guide?: Record<string, unknown>;
}

// One candidate plan: sessions with a date and either a `tss` or a title (or a guide spec with one) to estimate it from.
// A propose_next_week result's `sessions` fits as it is.
export function parseSessions(raw: unknown, path: string): SessionIn[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${path} must list at least one session: [{ date, title and/or tss }]`);
  if (raw.length > MAX_SESSIONS) throw new Error(`${path} can have at most ${MAX_SESSIONS} items`);
  return raw.map((s, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(s)) throw new Error(`${at} must be an object`);
    onlyKeys(s, ["date", "title", "tss", "guide"], `${at}.`);
    const out: SessionIn = { date: calendarDate(s.date, `${at}.date`) };
    if (s.title !== undefined) {
      if (typeof s.title !== "string" || s.title.trim() === "" || s.title.length > 100) throw new Error(`${at}.title must be a non-empty string of at most 100 characters`);
      out.title = s.title;
    }
    if (s.tss !== undefined) {
      if (typeof s.tss !== "number" || !Number.isFinite(s.tss) || s.tss < 0 || s.tss > MAX_PLANNED_TSS) throw new Error(`${at}.tss must be a number from 0 to ${MAX_PLANNED_TSS}`);
      out.tss = s.tss;
    }
    if (s.guide !== undefined) {
      if (!isObject(s.guide)) throw new Error(`${at}.guide must be an object (a push_strength_guide spec)`);
      if (s.guide.date !== undefined && s.guide.date !== out.date) throw new Error(`${at}.guide.date (${String(s.guide.date)}) must equal the session date ${out.date}`);
      if (s.guide.title !== undefined && typeof s.guide.title !== "string") throw new Error(`${at}.guide.title must be a string`);
      out.guide = s.guide;
    }
    if (out.tss === undefined && titleOf(out) === undefined) throw new Error(`${at} needs a tss, or a title (or a guide with one) to estimate it from`);
    return out;
  });
}

const titleOf = (s: SessionIn): string | undefined => (typeof s.guide?.title === "string" && s.guide.title !== "" ? s.guide.title : s.title);

export interface ResolvedSession {
  date: string;
  title: string | null;
  tss: number;
  tssSource: "given" | "history";
  historySessions: number | null; // sessions of that title the estimate is the median of
}

// TSS per session: the given one, else the median of the user's sessions of that title; no estimate -> an error that asks for `tss`.
export function resolveSessions(sessions: SessionIn[], rows: any[], path: string): ResolvedSession[] {
  return sessions.map((s, i) => {
    const title = titleOf(s) ?? null;
    if (s.tss !== undefined) return { date: s.date, title, tss: s.tss, tssSource: "given" as const, historySessions: null };
    const e = estimateTss(rows, title!);
    if (e.tss === null) {
      throw new Error(`${path}[${i}] (${s.date} "${title}"): no TSS estimate, ${e.sessions} session(s) of that title with a TSS in your last ${TSS_HISTORY_DAYS} days and at least ${MIN_TSS_SESSIONS} are needed. Give its tss.`);
    }
    return { date: s.date, title, tss: e.tss, tssSource: "history" as const, historySessions: e.sessions };
  });
}

// ---------- the user's own response ----------

export function freshBand(tsb: number): "below" | "fresh" | "above" {
  return tsb < FRESH_TSB_MIN ? "below" : tsb > FRESH_TSB_MAX ? "above" : "fresh";
}

type Effect = ReturnType<typeof effectOf>;
export interface ResponseModel {
  status: "ok" | "insufficient";
  basis: string;
  window: { from: string; to: string };
  cutoffTss: number | null; // a day at or above this is a high-load day: the median TSS of the user's own training days in the window
  highLoadDays: number;
  otherDays: number;
  thresholds: { minNightsPerGroup: number; minPairedDays: number; k: number; rule: string };
  metrics: Record<string, Effect> | null;
  missing: string[];
}

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

// Pure: the nights after high-load days against the nights after the other days (rest days included), per metric, by
// get_tag_effects' own rule. `nights` / `recovery` are the grouped sleep and recovery rows (null: that section could not be read).
export function responseModel(input: { workouts: any[]; nights: Map<string, any[]> | null; recovery: Map<string, any[]> | null; asOf: string; errors?: string[] }): ResponseModel {
  const { asOf } = input;
  const from = addDays(asOf, -RESPONSE_DAYS);
  const to = previousDate(asOf); // the night that led into asOf itself may still be recording
  const thresholds = {
    minNightsPerGroup: MIN_NIGHTS,
    minPairedDays: 2 * MIN_NIGHTS,
    k: SE_K,
    rule: `|median(after high-load days) - median(after other days)| > ${SE_K} * 1.25 * (IQR of the other days' nights / 1.35) * sqrt(1/nHigh + 1/nOther), at least ${MIN_NIGHTS} nights of each (get_tag_effects' rule)`,
  };
  const base = { basis: "model-based: the median next-night value after high-load days minus after other days, from your own history; an association, not a cause", window: { from, to }, thresholds };
  const { days } = aggregateByDay(input.workouts);
  const tssOn = (d: string) => days.get(d)?.tss ?? 0;
  // a session on day S is followed by the night that led into S + 1
  const sessionDays: string[] = [];
  for (let d = addDays(from, -1); d <= previousDate(to); d = addDays(d, 1)) sessionDays.push(d);
  const training = sessionDays.map(tssOn).filter((t) => t > 0);
  const missing = [...(input.errors ?? [])];
  if (training.length === 0) {
    return { status: "insufficient", ...base, cutoffTss: null, highLoadDays: 0, otherDays: 0, metrics: null, missing: [...missing, `No workout with a TSS in ${from}..${to}: there is no load to compare the nights with.`] };
  }
  const cutoff = r1(median(training)!);
  const isHigh = (d: string) => tssOn(d) >= cutoff;
  const values = new Map<string, Record<string, number | null>>();
  for (let d = from; d <= to; d = addDays(d, 1)) values.set(d, nightMetrics(input.nights === null ? null : input.nights.get(previousDate(d)) ?? [], input.recovery === null ? null : input.recovery.get(d) ?? []));
  const metrics: Record<string, Effect> = {};
  for (const m of RESPONSE_METRICS) {
    const pick = (high: boolean) => sessionDays.filter((d) => isHigh(d) === high).map((d) => values.get(addDays(d, 1))?.[m] ?? null).filter((x): x is number => x !== null);
    metrics[m] = effectOf(pick(true), pick(false), METRICS.find((x) => x.name === m)!.round);
    if (metrics[m].verdict === "insufficient") {
      missing.push(`${m}: ${metrics[m].nTagged} night(s) after high-load days and ${metrics[m].nControl} after other days have a value; at least ${MIN_NIGHTS} of each are needed.`);
    }
  }
  const ok = RESPONSE_METRICS.some((m) => metrics[m].verdict !== "insufficient");
  return {
    status: ok ? "ok" : "insufficient",
    ...base,
    cutoffTss: cutoff,
    highLoadDays: sessionDays.filter(isHigh).length,
    otherDays: sessionDays.filter((d) => !isHigh(d)).length,
    metrics,
    missing,
  };
}

// What the model says about one plan: how many of its days are high-load, and (only for a metric whose history showed a
// difference beyond the noise) the shift to expect the night after one; null shift otherwise.
export function responseToPlan(model: ResponseModel, dayTss: Map<string, number>) {
  if (model.status !== "ok" || model.metrics === null || model.cutoffTss === null) return null;
  const highLoadDays = [...dayTss.values()].filter((t) => t >= model.cutoffTss!).length;
  const afterHighLoad = Object.fromEntries(
    RESPONSE_METRICS.map((m) => {
      const e = model.metrics![m];
      const differs = e.verdict === "tagged-higher" || e.verdict === "tagged-lower";
      return [m, { verdict: e.verdict === "tagged-higher" ? "higher" : e.verdict === "tagged-lower" ? "lower" : e.verdict, expectedShiftVsOtherDays: differs ? e.medianDiff : null }];
    }),
  );
  return { highLoadDays, afterHighLoad, basis: "model-based: your own median difference, not a forecast of any single night" };
}

// ---------- one plan ----------

const sunday = (d: string) => addDays(mondayOf(d), 6);

export function simulateOne(input: { sessions: ResolvedSession[]; start: { ctl: number; atl: number; tsb: number }; asOf: string; end: string; goalDate: string | null; history: Map<string, number>; model: ResponseModel }) {
  const { sessions, start, asOf, end, goalDate } = input;
  const planned = new Map<string, { tss: number }>();
  for (const s of sessions) planned.set(s.date, { tss: (planned.get(s.date)?.tss ?? 0) + s.tss });
  for (const [d, v] of planned) if (v.tss > MAX_PLANNED_TSS) throw new Error(`${d} adds up to a TSS of ${r1(v.tss)}, more than ${MAX_PLANNED_TSS} in one day.`);
  const raw = projectLoad(start, planned, asOf, end);
  const series = raw.map(roundPoint);
  const daily = new Map(input.history);
  for (const [d, v] of planned) daily.set(d, v.tss);

  const weeks = [...new Set(raw.map((p) => mondayOf(p.date)))].map((monday) => {
    const inWeek = raw.filter((p) => mondayOf(p.date) === monday);
    const before = raw[raw.indexOf(inWeek[0]) - 1];
    const ctlStart = before === undefined ? start.ctl : before.ctl;
    const complete = inWeek.length === 7;
    const load = weekLoad(daily, monday, WEEKLY_JUMP_PCT);
    return {
      weekStart: monday,
      days: inWeek.length,
      complete,
      tss: r1(inWeek.reduce((n, p) => n + p.tss, 0)),
      ctlStart: r1(ctlStart),
      ctlEnd: r1(inWeek[inWeek.length - 1].ctl),
      rampRate: r1(inWeek[inWeek.length - 1].ctl - ctlStart),
      // only a whole week is compared with the weeks before it
      previous4wAvgTss: complete ? load.previous4wAvgTss : null,
      jumpPct: complete ? load.jumpPct : null,
      _jumpTrips: complete && load.trips,
    };
  });

  const risks: { rule: string; scope: "day" | "week"; date?: string; weekStart?: string; value: number; threshold: number; detail: string }[] = [];
  for (const p of series) {
    if (p.tsb < TSB_RISK_FLOOR) risks.push({ rule: "tsb-floor", scope: "day", date: p.date, value: p.tsb, threshold: TSB_RISK_FLOOR, detail: `TSB ${p.tsb} is below ${TSB_RISK_FLOOR}.` });
  }
  for (const w of weeks) {
    if (!w.complete) continue; // a part of a week is no weekly rate
    if (w.rampRate > CTL_RAMP_MAX) risks.push({ rule: "ctl-ramp", scope: "week", weekStart: w.weekStart, value: w.rampRate, threshold: CTL_RAMP_MAX, detail: `CTL rises ${w.rampRate} in the week of ${w.weekStart}, more than ${CTL_RAMP_MAX}.` });
    if (w._jumpTrips) risks.push({ rule: "weekly-load-jump", scope: "week", weekStart: w.weekStart, value: w.jumpPct!, threshold: WEEKLY_JUMP_PCT, detail: `The week of ${w.weekStart} has a TSS of ${w.tss}, ${w.jumpPct}% above the ${w.previous4wAvgTss} average week of the ${PRIOR_DAYS} days before it (limit ${WEEKLY_JUMP_PCT}%).` });
  }
  const low = tsbFloorCheck(series, TSB_RISK_FLOOR);
  const goalPoint = goalDate === null ? null : series.find((p) => p.date === goalDate)!;
  const last = series[series.length - 1];
  return {
    from: series[0].date,
    to: last.date,
    totalTss: r1(sessions.reduce((n, s) => n + s.tss, 0)),
    sessions,
    series,
    weeks: weeks.map(({ _jumpTrips, ...w }) => w),
    goal:
      goalPoint === null
        ? null
        : { date: goalPoint.date, ctl: goalPoint.ctl, atl: goalPoint.atl, tsb: goalPoint.tsb, band: freshBand(goalPoint.tsb), freshBand: { min: FRESH_TSB_MIN, max: FRESH_TSB_MAX }, basis: "model-based" },
    lowestTsb: { date: low.date, tsb: low.minTsb },
    end: { ctl: last.ctl, atl: last.atl, tsb: last.tsb },
    risks,
    responseToPlan: responseToPlan(input.model, new Map([...planned].map(([d, v]) => [d, v.tss]))),
  };
}

// ---------- the call ----------

export interface SimulateDeps {
  now?: Date;
}

export async function simulatePlan(client: SuuntoClient, args: unknown, deps: SimulateDeps = {}) {
  if (!isObject(args)) throw new Error("arguments must be an object");
  onlyKeys(args, ["sessions", "goalDate", "asOf", "compare"], "");
  const today = localDate(0, deps.now);
  const asOf = args.asOf === undefined ? today : calendarDate(args.asOf, "asOf");
  if (asOf > today) throw new Error(`asOf ${asOf} is in the future (today is ${today}): workouts that have not happened cannot be read; list planned days in \`sessions\` instead.`);
  const plan = parseSessions(args.sessions, "sessions");
  let compare: { label: string | null; sessions: SessionIn[] } | null = null;
  if (args.compare !== undefined) {
    if (!isObject(args.compare)) throw new Error("compare must be an object { sessions, label? }");
    onlyKeys(args.compare, ["sessions", "label"], "compare.");
    if (args.compare.label !== undefined && (typeof args.compare.label !== "string" || args.compare.label.length > 100)) throw new Error("compare.label must be a string of at most 100 characters");
    compare = { label: (args.compare.label as string | undefined) ?? null, sessions: parseSessions(args.compare.sessions, "compare.sessions") };
  }
  const goalDate = args.goalDate === undefined ? null : calendarDate(args.goalDate, "goalDate");
  const limit = addDays(asOf, MAX_FORECAST_DAYS);
  for (const [path, list] of [["sessions", plan], ...(compare ? [["compare.sessions", compare.sessions] as const] : [])] as const) {
    list.forEach((s, i) => {
      if (s.date <= asOf) throw new Error(`${path}[${i}].date ${s.date} must be after asOf ${asOf}; a simulation starts the day after the last known workouts (pass an earlier asOf to plan today).`);
      if (s.date > limit) throw new Error(`${path}[${i}].date ${s.date} is more than ${MAX_FORECAST_DAYS} days after asOf ${asOf}.`);
    });
  }
  if (goalDate !== null && (goalDate <= asOf || goalDate > limit)) throw new Error(`goalDate ${goalDate} must be after asOf ${asOf} and at most ${MAX_FORECAST_DAYS} days after it.`);

  // ---- reads ----
  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: String(err?.message ?? err) });
      return null;
    }
  };
  const load = await buildTrainingLoad(client, { date: asOf, days: 28 });
  const from = addDays(asOf, -RESPONSE_DAYS);
  const to = previousDate(asOf); // the night that led into asOf itself may still be recording
  const bounds = dayFetchBounds(previousDate(from), asOf);
  const workouts = rowsOf(await client.listWorkouts({ since: bounds.from, until: bounds.to, limit: 600 }));
  const [sleepRes, recoveryRes] = await Promise.all([section("sleep", () => client.listSleep(previousDate(from), previousDate(to))), section("recovery", () => client.listRecovery(from, to))]);
  const model = responseModel({
    workouts,
    asOf,
    nights: sleepRes === null ? null : groupBy(rowsOf(sleepRes), (r) => nightOf(r) ?? ""),
    recovery: recoveryRes === null ? null : groupBy(rowsOf(recoveryRes), rowDate),
    errors: errors.map((e) => `${e.section} could not be read: ${e.error}`),
  });

  // ---- the plans ----
  const resolved = resolveSessions(plan, workouts, "sessions");
  const resolvedCompare = compare ? resolveSessions(compare.sessions, workouts, "compare.sessions") : null;
  const lastDates = [...resolved, ...(resolvedCompare ?? [])].map((s) => s.date).sort();
  const end = [sunday(lastDates[lastDates.length - 1]), ...(goalDate ? [goalDate] : [])].sort().pop()!;
  const start = load.current;
  const history = new Map<string, number>(load.series.map((p) => [p.date, p.tss]));
  const run = (sessions: ResolvedSession[]) => simulateOne({ sessions, start, asOf, end, goalDate, history, model });
  const main = run(resolved);
  const other = resolvedCompare ? run(resolvedCompare) : null;
  const num = (a: number | null, b: number | null) => (a === null || b === null ? null : r1(b - a));

  return {
    modelBased: true,
    asOf,
    start: { ctl: start.ctl, atl: start.atl, tsb: start.tsb },
    ...main,
    compare:
      compare === null || other === null
        ? null
        : {
            label: compare.label,
            ...other,
            // the compared plan minus this one, over the same days (both run to the same end)
            difference: {
              totalTss: num(main.totalTss, other.totalTss),
              endCtl: num(main.end.ctl, other.end.ctl),
              endTsb: num(main.end.tsb, other.end.tsb),
              lowestTsb: num(main.lowestTsb.tsb, other.lowestTsb.tsb),
              goalTsb: num(main.goal?.tsb ?? null, other.goal?.tsb ?? null),
              risks: other.risks.length - main.risks.length,
            },
          },
    personalResponse: model,
    thresholds: {
      freshTsb: { min: FRESH_TSB_MIN, max: FRESH_TSB_MAX },
      tsbFloor: TSB_RISK_FLOOR,
      ctlRampPerWeek: CTL_RAMP_MAX,
      weeklyJumpPct: WEEKLY_JUMP_PCT,
      minTssSessions: MIN_TSS_SESSIONS,
    },
    notes: [
      "MODEL-BASED throughout. CTL/ATL/TSB are projections of the same 42-day/7-day model as get_training_load and forecast_training_load, rolled forward from today's values (CTL can be about 1 point off the watch); they are not a prediction of how you will feel or respond, and a day without a session is a rest day.",
      `A session's TSS is the one given, else the median of your sessions of the same title in the last ${TSS_HISTORY_DAYS} days (at least ${MIN_TSS_SESSIONS} sessions with a TSS; without them the call asks for tss). Several sessions on a date add up.`,
      `The fresh band is TSB ${FRESH_TSB_MIN} to ${FRESH_TSB_MAX}: a convention of the usual Form scale, not a personal target. Risk rules: a day with TSB below ${TSB_RISK_FLOOR}; a full Monday-to-Sunday week whose CTL rises by more than ${CTL_RAMP_MAX}; a full week whose TSS is more than ${WEEKLY_JUMP_PCT}% above the average week of the ${PRIOR_DAYS} days before it. Heuristics with contested evidence, compared as printed. A part of a week is no weekly rate and is not checked.`,
      "personalResponse is an association in your own history (as get_tag_effects), only shown when there are enough nights of both kinds and the gap is larger than the noise; it never claims a cause and never extends beyond the nights it was measured on.",
      "Workouts after asOf are not read: list them in sessions too, or the simulation ignores them. The series runs to the Sunday of the last session's week (or goalDate, if later), so a week is complete.",
    ],
    errors,
  };
}
