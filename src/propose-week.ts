// propose_next_week: the next week's strength sessions, proposed from the stored plan, what the user's journal says they
// actually lifted, and how recovered and loaded they are. READ-ONLY toward Suunto, and it writes nothing: it returns a
// proposal (set_plan `sessions` and push_week_plan `guides` shapes) that the caller may pass on; there is no auto-write.
// (Reading the history fills the same rebuildable derived-data cache as get_exercise_history, nothing else.)
//
// The rules are a small closed set of named constants (RULES, plus the fixed ones below), all reported in `rulesUsed`:
//   progress  every planned set reached its planned reps at one weight in the lift's latest logged session -> load + step
//             (history.ts suggestProgression: at most incrementKg, at most 5%, at least 1.25 kg)
//   hold      anything else with evidence -> repeat the load that was done
//   deload    stallSessions logged sessions in a row without hitting the plan, OR TSB below tsbDeloadBelow, OR HRV and
//             recovery on waking both below the user's band -> load lowered by deloadPct, rounded to 1.25 kg
//   never raise a load without a journal entry: the watch records only the plan, so no log_session entry = no evidence;
//   one of HRV / recovery below the band, or an unread part of the history, also blocks every increase.
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, localDate } from "./api.js";
import { buildBaselines } from "./baselines.js";
import { COLS, PLANNED, collectRecords, loadOf, nameMatches, parseLoadKg, stepFor, suggestProgression, type HistoryDeps, type WorkoutRecord } from "./history.js";
import type { JournalEntry } from "./journal.js";
import type { Plan, PlanSession, PlanStore } from "./plan.js";
import { norm } from "./compare.js";
import { guideNameOf, MIN_TSS_SESSIONS, TSB_RISK_FLOOR, TSS_HISTORY_DAYS, WEEKLY_JUMP_PCT, estimateTss, mondayOf, projectLoad, roundPoint, tsbFloorCheck, weekLoad } from "./plan-load.js";
import { MAX_DAYS_AHEAD, MIN_SCORED, predictionStats, type PredictionStore } from "./predictions.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { addDays, buildTrainingLoad } from "./training-load.js";

// ---------- the rules ----------

interface RuleDef {
  default: number;
  min: number;
  max: number;
  integer?: boolean;
  text: string;
}
// The rules `rules` may override (a number each, inside [min, max]); any other key is refused.
export const RULES = {
  incrementKg: { default: 2.5, min: 0.5, max: 5, text: "Largest load step of a progression, in kg (never more than 5% of the load, never less than 1.25 kg)." },
  deloadPct: { default: 10, min: 5, max: 20, text: "A deload lowers the load by this percent, rounded to 1.25 kg." },
  stallSessions: { default: 2, min: 2, max: 4, integer: true, text: "Logged sessions of one lift in a row that did not hit every planned set and rep at one weight; reaching this many deloads the lift." },
  tsbDeloadBelow: { default: -25, min: -60, max: -10, text: "Every load with a kg figure is deloaded when today's TSB (Form) is below this." },
  tsbRiskFloor: { default: TSB_RISK_FLOOR, min: -60, max: -10, text: "The forecast flags the week when its lowest TSB is below this (-30 is the 'high risk' zone of the usual Form scale)." },
  weeklyJumpPct: { default: WEEKLY_JUMP_PCT, min: 10, max: 100, text: "The forecast flags the week when its TSS is more than this percent above the average week of the 28 days before it (acute:chronic about 1.3)." },
} as const satisfies Record<string, RuleDef>;
export type RuleName = keyof typeof RULES;
export type Rules = Record<RuleName, number>;

// Fixed (not overridable) rules.
export const HISTORY_WEEKS = 8; // the journal is read this far back
export const BASE_LOOKBACK_WEEKS = 4; // the base week is the latest week with a guided session within this many weeks before weekStart
export const MIN_LOGGED_SESSIONS = 2; // sessions with logged sets (log_session) needed in the history before anything is proposed
export const LOAD_STEP_KG = 1.25; // loads are rounded to this
// predict: true -> a log_prediction payload per increase. The rule label the predictions carry (get_prediction_stats' byRule groups by it),
// the probability when there is no history of that rule yet (a conservative guess: a planned step up is more often done than not, but not by much), and its bounds.
export const PREDICT_RULE = "progression";
export const PREDICT_DEFAULT = 0.65;
export const PREDICT_MIN = 0.5;
export const PREDICT_MAX = 0.9;

const DEFAULTS = Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v.default])) as Rules;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseRules(raw: unknown): Rules {
  if (raw === undefined) return { ...DEFAULTS };
  if (!isObject(raw)) throw new Error("rules must be an object");
  const out = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    const def: RuleDef | undefined = (RULES as Record<string, RuleDef>)[key];
    if (def === undefined) throw new Error(`rules.${key} is not a known rule (allowed: ${Object.keys(RULES).join(", ")})`);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`rules.${key} must be a finite number`);
    if (def.integer && !Number.isInteger(value)) throw new Error(`rules.${key} must be an integer`);
    if (value < def.min || value > def.max) throw new Error(`rules.${key} must be between ${def.min} and ${def.max}`);
    out[key as RuleName] = value;
  }
  return out;
}

export const rulesUsed = (rules: Rules) => [
  ...(Object.keys(RULES) as RuleName[]).map((name) => ({ name, value: rules[name], default: RULES[name].default, overridden: rules[name] !== RULES[name].default, overridable: true, rule: RULES[name].text })),
  { name: "historyWeeks", value: HISTORY_WEEKS, default: HISTORY_WEEKS, overridden: false, overridable: false, rule: "The journal and the guided sessions are read this many weeks back." },
  { name: "minLoggedSessions", value: MIN_LOGGED_SESSIONS, default: MIN_LOGGED_SESSIONS, overridden: false, overridable: false, rule: "Fewer sessions with logged sets (log_session) than this in the history: nothing is proposed." },
  { name: "baseLookbackWeeks", value: BASE_LOOKBACK_WEEKS, default: BASE_LOOKBACK_WEEKS, overridden: false, overridable: false, rule: "The base week is the latest week of the stored plan with a guided session, within this many weeks before weekStart; its sessions are repeated one week on." },
  { name: "recoverySignals", value: 2, default: 2, overridden: false, overridable: false, rule: "HRV and recovery on waking (get_baselines, today) both below your band deloads every load; one of them below allows no increase." },
  { name: "predictionDefault", value: PREDICT_DEFAULT, default: PREDICT_DEFAULT, overridden: false, overridable: false, rule: `With predict: true, each proposed increase comes with a log_prediction payload (kind reps_hit, rule '${PREDICT_RULE}'). Its probability is your own hit rate for that rule (get_prediction_stats byRule) once at least ${MIN_SCORED} are scored, else this number.` },
  { name: "predictionMin", value: PREDICT_MIN, default: PREDICT_MIN, overridden: false, overridable: false, rule: "A predicted probability is never lower than this." },
  { name: "predictionMax", value: PREDICT_MAX, default: PREDICT_MAX, overridden: false, overridable: false, rule: "A predicted probability is never higher than this." },
  { name: "loadStepKg", value: LOAD_STEP_KG, default: LOAD_STEP_KG, overridden: false, overridable: false, rule: "Loads are rounded to this many kg." },
  { name: "minTssSessions", value: MIN_TSS_SESSIONS, default: MIN_TSS_SESSIONS, overridden: false, overridable: false, rule: `A session's TSS for the forecast is the median of your last ${TSS_HISTORY_DAYS} days' sessions of the same title, needing at least this many; with fewer it counts as 0 and is listed in estimates.` },
];

// ---------- one lift ----------

const num = (n: number): number => Number(n.toFixed(2));
const KG_TOKEN = /(?<![\d.,])(\d+(?:[.,]\d+)?)(\s*kg)/i;
const KG_AT = /@(\d+(?:\.\d+)?)kg$/;

// The first "<n>kg" of a detail text replaced (a decimal comma becomes a point).
export const withKg = (detail: string, kg: number): string => detail.replace(KG_TOKEN, `${num(kg)}$2`);
const targetText = (detail: string, kg: number): string | null => {
  const m = PLANNED.exec(detail);
  return m ? `${m[1]}x${m[2]}@${num(kg)}kg` : null;
};

// pct% lower, rounded to LOAD_STEP_KG and always below the load; null when it cannot go lower than one step.
export function deloadKg(kg: number, pct: number): number | null {
  let next = Math.round((kg * (1 - pct / 100)) / LOAD_STEP_KG) * LOAD_STEP_KG;
  if (next >= kg) next = kg - LOAD_STEP_KG;
  return next >= LOAD_STEP_KG ? next : null;
}

export interface Evidence {
  date: string;
  row: unknown[]; // a get_exercise_history row (COLS), carrying the journal's sets
  kg: number | null;
}
export interface Gates {
  tsb: number | null;
  tsbDeload: boolean;
  recoveryBoth: boolean;
  recoveryOne: boolean;
  incomplete: boolean; // part of the history could not be read
}
export type Action = "progress" | "hold" | "deload" | "unchanged";
export interface LiftDecision {
  action: Action;
  kg: number | null; // the load to write; null leaves the detail as it is
  last: string | null;
  target: string | null;
  reasons: string[];
}

// Did the session hit the plan? suggestProgression raises the load exactly when every planned set reached its reps at one
// weight, so "its target is heavier than what was done" is that test, taken from the one place that decides it.
export function hit(row: unknown[], incrementKg: number): boolean {
  const s = suggestProgression({ sessions: { cols: COLS, rows: [row] } }, { incrementKg });
  const last = s.last === null ? null : KG_AT.exec(s.last);
  const target = s.target === null ? null : KG_AT.exec(s.target);
  return last !== null && target !== null && Number(target[1]) > Number(last[1]);
}

// What applies to the whole week: TSB against its line (strictly below), the two recovery signals, and whether the history was read in full.
export function buildGates(input: { tsb: number; hrv: string | null; recoveryMorning: string | null; pending: number; failed: number }, rules: Rules): Gates {
  const below = [input.hrv, input.recoveryMorning].filter((b) => b === "below").length;
  return { tsb: input.tsb, tsbDeload: input.tsb < rules.tsbDeloadBelow, recoveryBoth: below === 2, recoveryOne: below === 1, incomplete: input.pending > 0 || input.failed > 0 };
}

// Pure: what to do with one exercise. `evidence` is the lift's logged sessions with the plan's own sets x reps, oldest first.
export function decideLift(input: { baseDetail: string; evidence: Evidence[]; skippedScheme: number; gates: Gates; rules: Rules }): LiftDecision {
  const { baseDetail, evidence, gates, rules } = input;
  const baseKg = parseLoadKg(baseDetail);
  const reasons: string[] = [];
  if (baseKg === null) return { action: "unchanged", kg: null, last: null, target: null, reasons: ["No kg load in the plan's detail (bodyweight, RPE or no weight): left as it is."] };
  if (PLANNED.exec(baseDetail) === null) return { action: "unchanged", kg: null, last: null, target: null, reasons: ["The plan's detail has no sets x reps ('NxM') to compare the logs with: left as it is."] };

  const newest = evidence[evidence.length - 1];
  // A deload counts from the lower of what was lifted and what was planned; nothing else ever goes below the plan's own load.
  const refKg = newest?.kg == null ? baseKg : Math.min(newest.kg, baseKg);
  const step = stepFor(baseKg, rules.incrementKg);
  // Outside a deload a load stays between the planned one and one step above it: evidence can move a session's load up by one step,
  // never down (that takes a deload rule) and never further (a heavier day elsewhere is no licence).
  const within = (kg: number) => Math.min(Math.max(kg, baseKg), baseKg + step);
  let run = 0;
  for (let i = evidence.length - 1; i >= 0 && !hit(evidence[i].row, rules.incrementKg); i--) run++;

  const triggers: string[] = [];
  if (run >= rules.stallSessions) triggers.push(`The last ${run} logged sessions did not reach every planned set and rep at one weight (a deload needs ${rules.stallSessions} in a row).`);
  if (gates.tsbDeload) triggers.push(`TSB ${gates.tsb} is below ${rules.tsbDeloadBelow}.`);
  if (gates.recoveryBoth) triggers.push("HRV and recovery on waking are both below your usual band.");
  if (triggers.length > 0) {
    const next = deloadKg(refKg, rules.deloadPct);
    if (next === null) return { action: "unchanged", kg: null, last: null, target: null, reasons: [...triggers, `${refKg} kg is too light to lower by a ${LOAD_STEP_KG} kg step: left as it is.`] };
    return {
      action: "deload",
      kg: next,
      last: newest ? suggestLast(evidence, rules) : null,
      target: targetText(baseDetail, next),
      reasons: [...triggers, `Load ${num(refKg)} kg -> ${num(next)} kg (${rules.deloadPct}% lower, rounded to ${LOAD_STEP_KG} kg).`],
    };
  }
  if (newest === undefined) {
    const why = input.skippedScheme > 0 ? `${input.skippedScheme} logged session(s) used another sets x reps than the plan's, so they are no evidence for it` : "no log_session entry with sets for this lift in this session (the same guide) in the history (the watch records only the plan)";
    return { action: "unchanged", kg: null, last: null, target: null, reasons: [`No evidence to change the load: ${why}. Left as it is.`] };
  }
  const sug = suggestProgression({ sessions: { cols: COLS, rows: evidence.map((e) => e.row) } }, { incrementKg: rules.incrementKg });
  const targetKg = sug.target === null ? null : KG_AT.exec(sug.target);
  const last = sug.last;
  const holdAt = (kg: number, why: string[]): LiftDecision => {
    const at = within(kg);
    if (at !== kg) why.push(`${num(kg)} kg is ${kg < baseKg ? "below the planned load" : `more than one step (${num(step)} kg) above the planned ${num(baseKg)} kg`}: ${num(at)} kg instead (only a deload rule cuts a load).`);
    return { action: "hold", kg: at, last, target: targetText(baseDetail, at), reasons: why };
  };
  if (hit(newest.row, rules.incrementKg) && targetKg !== null) {
    const stepped = Number(targetKg[1]);
    if (gates.recoveryOne || gates.incomplete) {
      reasons.push(`Every planned set was reached (${sug.reason}), but ${gates.recoveryOne ? "HRV or recovery on waking is below your band" : "part of the history could not be read"}: no increase, the load is repeated.`);
      return holdAt(newest.kg ?? baseKg, reasons);
    }
    if (stepped <= baseKg) {
      return holdAt(baseKg, [`The newest logged session lifted ${num(newest.kg ?? baseKg)} kg, below the planned ${num(baseKg)} kg: every set was reached, but the step from there (${num(stepped)} kg) would be a cut, so the plan's ${num(baseKg)} kg stays (a cut needs a deload rule).`]);
    }
    const kg = Math.min(stepped, baseKg + step);
    return { action: "progress", kg, last, target: targetText(baseDetail, kg), reasons: [`Latest logged session: ${sug.reason}.`, ...(kg < stepped ? [`Capped at one step (${num(step)} kg) above the planned ${num(baseKg)} kg: ${num(kg)} kg, not ${num(stepped)} kg.`] : [])] };
  }
  return holdAt(targetKg === null ? (newest.kg ?? baseKg) : Number(targetKg[1]), [`Latest logged session: ${sug.reason}.`]);
}

const suggestLast = (evidence: Evidence[], rules: Rules): string | null => suggestProgression({ sessions: { cols: COLS, rows: evidence.map((e) => e.row) } }, { incrementKg: rules.incrementKg }).last;

// The lift's sessions with logged sets and the plan's own sets x reps, oldest first (`ordered` is oldest first), from the SAME session as
// the planned exercise only (`sameSession` says whether a workout ran the planned guide): the same lift on another day, with another
// load, is no evidence for this one.
export function liftEvidence(name: string, baseDetail: string, ordered: WorkoutRecord[], journal: Record<string, JournalEntry>, sameSession: (workoutKey: string) => boolean): { evidence: Evidence[]; skippedScheme: number } {
  const planned = PLANNED.exec(baseDetail);
  const evidence: Evidence[] = [];
  let skippedScheme = 0;
  for (const r of ordered) {
    if (!sameSession(r.workoutKey)) continue;
    const entry = journal[r.workoutKey];
    for (const e of r.exercises) {
      if (!nameMatches(name, e)) continue;
      const jEx = entry?.exercises?.find((x) => nameMatches(x.name, e));
      if (!(jEx?.sets ?? []).some((s) => typeof s.reps === "number")) continue;
      const m = e.detail === null ? null : PLANNED.exec(e.detail);
      if (m === null || (planned !== null && (m[1] !== planned[1] || m[2] !== planned[2]))) {
        skippedScheme++;
        continue;
      }
      const { kg } = loadOf(e, entry);
      const cells: Record<string, unknown> = { date: r.date, workoutKey: r.workoutKey, detail: e.detail, kg, journal: { sets: jEx!.sets } };
      evidence.push({ date: r.date, kg, row: COLS.map((c) => cells[c] ?? null) });
    }
  }
  return { evidence, skippedScheme };
}

// ---------- the week ----------

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);
const MAX_LAST_CHARS = 36;

// The latest week of the plan, within BASE_LOOKBACK_WEEKS before weekStart, that has a guided session.
export function baseWeek(plan: Plan, weekStart: string): { monday: string; sessions: PlanSession[] } | null {
  for (let k = 1; k <= BASE_LOOKBACK_WEEKS; k++) {
    const monday = addDays(weekStart, -7 * k);
    const sessions = plan.sessions.filter((s) => s.date >= monday && s.date <= addDays(monday, 6));
    if (sessions.some((s) => s.guide !== undefined)) return { monday, sessions };
  }
  return null;
}

export interface ProposeDeps {
  now?: Date;
  history?: HistoryDeps;
  journal?: Record<string, JournalEntry>; // used instead of the journal file (demo mode has a journal of its own)
  demoPlan?: (weekStart: string) => Plan; // demo mode: the plan to use when none is stored
  predictions?: PredictionStore; // for predict: true: the ledger whose 'progression' hit rate sets the probability
}

// The probability of a predicted increase: the user's own hit rate for the rule when at least MIN_SCORED are scored (get_prediction_stats), else the default; kept inside [PREDICT_MIN, PREDICT_MAX].
export function predictionProbability(stats: { n: number; hitRate: number | null } | null): { probability: number; basis: { source: "history" | "default"; rule: string; n: number; hitRate: number | null } } {
  const usable = stats !== null && stats.n >= MIN_SCORED && stats.hitRate !== null;
  const base = usable ? stats!.hitRate! : PREDICT_DEFAULT;
  return { probability: Math.round(Math.min(PREDICT_MAX, Math.max(PREDICT_MIN, base)) * 100) / 100, basis: { source: usable ? "history" : "default", rule: PREDICT_RULE, n: stats?.n ?? 0, hitRate: usable ? stats!.hitRate : null } };
}

type Client = SuuntoClient;

export async function proposeNextWeek(client: Client, planStore: PlanStore, args: unknown, deps: ProposeDeps = {}) {
  if (!isObject(args)) throw new Error("arguments must be an object");
  const extra = Object.keys(args).find((k) => !["weekStart", "rules", "predict"].includes(k));
  if (extra !== undefined) throw new Error(`${extra} is not a known field (allowed: weekStart, rules, predict)`);
  if (args.predict !== undefined && typeof args.predict !== "boolean") throw new Error("predict must be a boolean");
  const rules = parseRules(args.rules);
  const today = localDate(0, deps.now);
  const nextMonday = addDays(mondayOf(today), 7);
  const weekStart = args.weekStart === undefined ? nextMonday : args.weekStart;
  if (typeof weekStart !== "string" || !isValidCalendarDate(weekStart)) throw new Error("weekStart must be a calendar date YYYY-MM-DD");
  if (mondayOf(weekStart) !== weekStart) throw new Error(`weekStart ${weekStart} is not a Monday (the Monday of that week is ${mondayOf(weekStart)}).`);
  if (weekStart <= today) throw new Error(`weekStart ${weekStart} must be after today (${today}): a proposal is for a week that has not started.`);
  const weekEnd = addDays(weekStart, 6);

  const stored = await planStore.load();
  const plan = stored?.plan ?? deps.demoPlan?.(weekStart) ?? null;
  const planSource = stored ? "stored" : plan ? "demo" : "none";

  const empty = (missing: string[], more: Record<string, unknown> = {}) => ({
    status: "insufficient" as const,
    weekStart,
    weekEnd,
    asOf: today,
    planSource,
    pending: 0,
    rulesUsed: rulesUsed(rules),
    missing,
    basedOn: null as { from: string; to: string } | null,
    signals: null as Record<string, unknown> | null,
    sessions: [] as unknown[],
    guides: [] as unknown[],
    changes: [] as unknown[],
    reasons: [] as string[],
    forecast: null as unknown,
    risk: null as unknown,
    estimates: [] as unknown[],
    queuePayload: null as unknown,
    predictions: [] as unknown[],
    history: null as unknown,
    notes: ["Nothing is proposed. Model-based throughout: a proposal from simple stated rules, not a prescription."],
    errors: [] as { section: string; error: string }[],
    ...more,
  });

  if (plan === null) return empty(["No training plan is stored: set one with set_plan (sessions with guides) first."]);
  const base = baseWeek(plan, weekStart);
  if (base === null) return empty([`The plan has no session with a strength guide in the ${BASE_LOOKBACK_WEEKS} weeks before ${weekStart}: there is nothing to repeat and progress. Add one with set_plan.`]);
  const basedOn = { from: base.monday, to: addDays(base.monday, 6) };

  // ---- what the proposal rests on (reads only) ----
  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: String(err?.message ?? err) });
      return null;
    }
  };
  const load = await buildTrainingLoad(client, { date: today, days: 28 });
  const baselines = await section("baselines", () => buildBaselines(client, { date: today }));
  const bounds = dayFetchBounds(addDays(today, -TSS_HISTORY_DAYS), today);
  const workoutRows = rowsOf(await client.listWorkouts({ since: bounds.from, until: bounds.to, limit: 600 }));
  const history = await collectRecords(client, { weeks: HISTORY_WEEKS, date: today }, deps.history);
  const journal = deps.journal ?? history.journal;
  const guideNames = new Map<string, string>(history.items.flatMap((w) => { const g = guideNameOf(w.row); return g === null ? [] : [[w.key, g] as [string, string]]; }));

  const bands = (baselines?.metrics ?? {}) as Record<string, { latestVsBand?: string | null }>;
  const hrv = bands.hrv?.latestVsBand ?? null;
  const recoveryMorning = bands.recoveryMorning?.latestVsBand ?? null;
  const gates = buildGates({ tsb: load.current.tsb, hrv, recoveryMorning, pending: history.pending, failed: history.errors.length }, rules);
  const signals = { ctl: load.current.ctl, atl: load.current.atl, tsb: load.current.tsb, hrv, recoveryMorning };
  const logged = history.ordered.filter((r) => (journal[r.workoutKey]?.exercises ?? []).some((x) => (x.sets ?? []).some((s) => typeof s.reps === "number"))).length;
  const historyInfo = { from: history.from, to: history.to, guidedSessions: history.ordered.length, loggedSessions: logged, pending: history.pending, errors: history.errors };
  const reasons: string[] = [];
  if (gates.tsbDeload) reasons.push(`TSB ${gates.tsb} is below ${rules.tsbDeloadBelow}: every load with a kg figure is lowered ${rules.deloadPct}%.`);
  if (gates.recoveryBoth) reasons.push("HRV and recovery on waking are both below your band: every load with a kg figure is lowered.");
  else if (gates.recoveryOne) reasons.push("One of HRV / recovery on waking is below your band: no load is increased.");
  if (gates.incomplete) reasons.push(`Part of the history was not read (pending ${history.pending}, ${history.errors.length} failed): no load is increased; call again (the cache fills) before relying on this.`);
  if (baselines === null) reasons.push("The recovery baselines could not be read: recovery was not taken into account.");

  if (logged < MIN_LOGGED_SESSIONS) {
    return empty([`Too little history: ${logged} session(s) with logged sets (log_session) in ${history.from}..${history.to}, at least ${MIN_LOGGED_SESSIONS} are needed. Log what you lift with log_session: without it no load is raised.${history.pending > 0 ? ` ${history.pending} older session(s) are not read yet: call again (pending) before concluding.` : ""}`], { pending: history.pending, basedOn, signals, reasons, history: historyInfo, errors, notes: ["Nothing is proposed. Model-based throughout."] });
  }

  // ---- decisions, exercise by exercise ----
  const shift = daysBetween(base.monday, weekStart);
  const changes: any[] = [];
  const sessions: PlanSession[] = [];
  for (const s of base.sessions) {
    const date = addDays(s.date, shift);
    if (s.guide === undefined) {
      sessions.push({ date, title: s.title });
      continue;
    }
    const guide = structuredClone(s.guide) as Record<string, any>;
    // evidence comes from the sessions that ran THIS guide, nothing else (a heavier day of another guide is no evidence)
    const guideTitle = norm(String(guide.title ?? s.title));
    const sameSession = (key: string) => {
      const ran = guideNames.get(key);
      return ran !== undefined && norm(ran) === guideTitle;
    };
    guide.date = date;
    delete guide.guideId;
    for (const ex of Array.isArray(guide.exercises) ? (guide.exercises as Record<string, any>[]) : []) {
      if (typeof ex?.name !== "string" || typeof ex.detail !== "string") continue;
      const from = { detail: ex.detail, kg: parseLoadKg(ex.detail) };
      const { evidence, skippedScheme } = liftEvidence(ex.name, ex.detail, history.ordered, journal, sameSession);
      const d = decideLift({ baseDetail: ex.detail, evidence, skippedScheme, gates, rules });
      const why = [...d.reasons];
      if (d.kg !== null && from.kg !== null && d.kg !== from.kg) {
        ex.detail = withKg(ex.detail, d.kg);
        if (ex.plates !== undefined) {
          delete ex.plates;
          why.push("Plates removed (they described the old load); the detail line shows the new one.");
        }
      }
      if (d.target !== null && d.target.length <= MAX_LAST_CHARS && d.action !== "unchanged") ex.target = d.target;
      else if (d.action !== "unchanged" && ex.target !== undefined) delete ex.target;
      if (d.last !== null && d.last.length <= MAX_LAST_CHARS) ex.last = d.last;
      changes.push({ date, session: guide.title ?? s.title, exercise: ex.name, action: d.action, changed: ex.detail !== from.detail, from, to: { detail: ex.detail, kg: parseLoadKg(ex.detail) }, reasons: why });
    }
    sessions.push({ date, title: s.title, guide });
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  const guides = sessions.flatMap((s) => (s.guide ? [s.guide] : []));

  if (!changes.some((c) => c.action !== "unchanged")) {
    return empty(["No lift of the base week has usable evidence (a log_session entry with the plan's sets x reps) or a load to lower: nothing to propose. See changes for each lift."], { pending: history.pending, basedOn, signals, reasons, changes, history: historyInfo, errors });
  }

  // ---- the forecast of the proposed week (the same math as forecast_training_load) ----
  const estimates: { date: string; title: string; tss: number | null; sessions: number; scope: "proposed" | "carry-in" }[] = [];
  const planned = new Map<string, { tss: number }>();
  const estimateFor = (s: PlanSession, date: string, scope: "proposed" | "carry-in") => {
    const title = typeof (s.guide as any)?.title === "string" ? (s.guide as any).title : s.title;
    const e = estimateTss(workoutRows, title);
    estimates.push({ date, title, tss: e.tss, sessions: e.sessions, scope });
    planned.set(date, { tss: (planned.get(date)?.tss ?? 0) + (e.tss ?? 0) });
  };
  // the rest of the current week (and any gap before weekStart) from the stored plan
  for (const s of plan.sessions) if (s.date > today && s.date < weekStart) estimateFor(s, s.date, "carry-in");
  for (const s of sessions) estimateFor(s, s.date, "proposed");
  const points = projectLoad({ ctl: load.current.ctl, atl: load.current.atl }, planned, today, weekEnd).map(roundPoint);
  const weekPoints = points.filter((p) => p.date >= weekStart);
  const daily = new Map<string, number>();
  for (const p of load.series) daily.set(p.date, p.tss);
  for (const [d, v] of planned) daily.set(d, v.tss);
  const jump = weekLoad(daily, weekStart, rules.weeklyJumpPct);
  const floor = tsbFloorCheck(weekPoints, rules.tsbRiskFloor);
  const flags: { rule: string; detail: string }[] = [];
  if (floor.trips) flags.push({ rule: "tsb-floor", detail: `The forecast TSB falls to ${floor.minTsb} on ${floor.date}, below ${rules.tsbRiskFloor}.` });
  if (jump.trips) flags.push({ rule: "weekly-load-jump", detail: `The week's TSS ${jump.tss} is ${jump.jumpPct}% above the ${jump.previous4wAvgTss} average week of the 28 days before it (limit ${rules.weeklyJumpPct}%).` });
  const unknown = estimates.filter((e) => e.scope === "proposed" && e.tss === null);
  const notes = [
    "Model-based throughout: every number is a projection or a rule's output from your own data, not a measurement or a prediction of how you will respond. CTL can be about 1 point off the watch.",
    `Each session's TSS is the median of your last ${TSS_HISTORY_DAYS} days' sessions of the same title (at least ${MIN_TSS_SESSIONS} needed); a session without an estimate counts as 0${unknown.length ? ` (${unknown.map((u) => `${u.date} ${u.title}`).join(", ")})` : ""}, so its load is underestimated.`,
    "The proposal is returned only: pass `sessions` to set_plan (mode 'merge' replaces the plan's sessions on those dates) and `guides` to push_week_plan (dryRun by default), or `queuePayload` to queue_adjustment to ask for approval. Apart from the rebuildable derived-data cache that reading the history fills, this call wrote nothing, and nothing was sent to the watch.",
    "Workouts after today are not read. Days between today and weekStart count the stored plan's sessions (scope carry-in) with the same TSS estimate.",
  ];
  const existing = plan.sessions.filter((s) => s.date >= weekStart && s.date <= weekEnd).map((s) => s.date);
  if (existing.length) notes.push(`The stored plan already has sessions on ${existing.join(", ")} in that week; set_plan 'merge' replaces them by date.`);
  if (history.notes.length) notes.push(...history.notes.filter((n) => /not read|could not be read|ignored/.test(n)));

  // ---- predict: true (payloads only, nothing is logged) and the payload that queue_adjustment takes (nothing is queued) ----
  const lines = [...reasons, ...changes.filter((c) => c.action !== "unchanged").map((c) => `${c.session} ${c.exercise}: ${c.action}, ${c.from.detail} -> ${c.to.detail}. ${c.reasons[0] ?? ""}`)];
  const queuePayload = { kind: "week_plan" as const, payload: { guides }, forDate: (guides as { date: string }[]).map((g) => g.date).sort()[0], reasons: lines.map((l) => l.slice(0, 500)).slice(0, 20), source: "propose_next_week" };
  const predictions: { session: string; payload: Record<string, unknown>; basis: unknown }[] = [];
  if (args.predict === true) {
    let stats: { n: number; hitRate: number | null } | null = null;
    try {
      // the predictions scored from a confirmed draft began as the plan itself: only the others say how the rule does
      const row = predictionStats((await deps.predictions?.load()) ?? null, deps.now).byRule.find((r) => r.rule === PREDICT_RULE);
      stats = row ? { n: row.basis.other.n, hitRate: row.basis.other.hitRate } : null;
    } catch (err: any) {
      errors.push({ section: "predictions", error: String(err?.message ?? err) });
    }
    const { probability, basis } = predictionProbability(stats);
    for (const c of changes.filter((x) => x.action === "progress")) {
      const m = PLANNED.exec(c.to.detail);
      if (!m || c.to.kg === null || Number(m[1]) > 20 || Number(m[2]) > 200 || c.date > addDays(today, MAX_DAYS_AHEAD)) continue;
      predictions.push({ session: c.session, payload: { date: c.date, kind: "reps_hit", probability, exercise: c.exercise, sets: Number(m[1]), reps: Number(m[2]), kg: c.to.kg, rule: PREDICT_RULE, note: `Proposed by propose_next_week: ${c.from.kg} -> ${c.to.kg} kg.` }, basis });
    }
    notes.push("predictions: ready log_prediction payloads, one per proposed increase (the user logs them, or not: nothing was logged). Score them later with score_predictions; get_prediction_stats' byRule shows how the 'progression' rule does.");
  }

  return {
    status: "ok" as const,
    weekStart,
    weekEnd,
    asOf: today,
    planSource,
    pending: history.pending,
    rulesUsed: rulesUsed(rules),
    missing: [] as string[],
    basedOn,
    signals,
    sessions,
    guides,
    changes,
    reasons,
    forecast: { asOf: today, start: { ctl: load.current.ctl, atl: load.current.atl, tsb: load.current.tsb }, series: points, basis: "model-based: forecast_training_load's 42-day/7-day model rolled forward" },
    risk: {
      level: flags.length ? ("caution" as const) : ("none" as const),
      flags,
      tsbFloor: { threshold: rules.tsbRiskFloor, minTsb: floor.minTsb, date: floor.date },
      weeklyLoad: { threshold: rules.weeklyJumpPct, proposedTss: jump.tss, previous4wAvgTss: jump.previous4wAvgTss, jumpPct: jump.jumpPct, complete: unknown.length === 0 },
      basis: "model-based",
    },
    estimates,
    queuePayload,
    predictions,
    history: historyInfo,
    notes,
    errors,
  };
}

