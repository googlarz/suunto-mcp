// The prediction ledger: log_prediction / void_prediction / score_predictions / get_prediction_stats.
// A prediction is written down BEFORE the fact (its date is after today), with a probability, and is immutable: no edit,
// only a void with a reason before its due date. The server scores it itself, from Suunto's data and the journal, as
// hit / miss / unresolvable (data missing: never a guess), and the statistics say whether the stated probabilities were
// any good (hit rate, Brier score, a calibration table) once there are enough scored predictions to say anything.
// Local file ~/.suunto-mcp/predictions.json (SUUNTO_PREDICTIONS_PATH); toward Suunto only reads. Demo mode: in memory.
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, localDate, rowDate, workoutDate } from "./api.js";
import { MIN_BAND_N, buildBaselines, type MetricBand } from "./baselines.js";
import { compareWorkout } from "./compare.js";
import { deriveRecord, nameMatches, type ExerciseRecord } from "./history.js";
import { loadJournal, validEntries, type JournalEntry, type JournalExercise } from "./journal.js";
import { LAP_EXTENSIONS, shapeLaps } from "./laps.js";
import { fileDocStore, memoryDocStore, serialQueue, type DocStore } from "./local-store.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { addDays } from "./training-load.js";

export const KINDS = ["reps_hit", "hrv_in_band", "recovery_morning_at_least", "session_done"] as const;
export type Kind = (typeof KINDS)[number];
export type Result = "hit" | "miss" | "unresolvable";

export const MAX_TEXT = 500;
export const MAX_RULE = 64;
export const MAX_EXERCISE = 200;
export const MAX_PREDICTIONS = 2000;
// A prediction about a date further ahead than this is more likely a typo than a forecast.
export const MAX_DAYS_AHEAD = 60;
// A day's data may reach the cloud a day late (the watch syncs when it syncs): a prediction is scored from the second day
// after its date.
export const SCORE_DELAY_DAYS = 2;
// Requests toward Suunto per call stay bounded: the oldest due ones first, `remaining` says how many are left.
export const MAX_SCORED_PER_CALL = 20;
// Below this many scored (hit or miss) predictions no hit rate, score or table is shown: with fewer, a hit rate says more
// about the handful of predictions than about the person (at 20 the 95% interval of a 50% hit rate is still about +-22 points).
export const MIN_SCORED = 20;
// A calibration bucket shows its observed hit rate only with at least this many predictions in it.
export const MIN_BUCKET_N = 5;
const BUCKETS = 5;
const BASELINE_DAYS = 28;
const SYNC_PROBE_DAYS = 7;
const WORKOUT_LIMIT = 600;
const RECENT = 10;
const ERROR_MAX = 200;
const WORKOUT_KEY = /^[0-9a-f]{24}$/i;

export interface Outcome {
  result: Result;
  scoredAt: string;
  detail: string;
  observed?: number | string | null;
  basis?: "draft-confirmed"; // a reps_hit scored from a journal entry made from a confirmed draft_session_log
}
export interface Prediction {
  id: string;
  madeAt: string;
  date: string; // the local date the prediction is about (after the day it was made)
  kind: Kind;
  probability: number;
  exercise?: string; // reps_hit: the exercise, sets x reps (at kg when given) predicted to be completed
  sets?: number;
  reps?: number;
  kg?: number;
  threshold?: number; // recovery_morning_at_least: the Balance (0-1; x100 is the watch's Resources %) on waking
  note?: string;
  rule?: string; // the rule or skill that made the prediction, for the per-rule statistics
  due: string; // the first day it is scored: two days after the date
  voided?: { at: string; reason: string };
  outcome?: Outcome;
}
export interface Ledger {
  predictions: Prediction[];
}
export type PredictionStore = DocStore<Ledger>;

export const predictionsPath = (): string => process.env.SUUNTO_PREDICTIONS_PATH ?? join(homedir(), ".suunto-mcp", "predictions.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function onlyKeys(o: Record<string, unknown>, allowed: string[], at: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Error(`${at}${extra} is not a known field (allowed here: ${allowed.join(", ")})`);
}

function text(v: unknown, path: string, max: number, required = false, nonEmpty = required): string | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`${path} must be a string`);
  if (v.length > max) throw new Error(`${path} must be at most ${max} characters`);
  if (nonEmpty && v.trim() === "") throw new Error(`${path} must not be empty`);
  return v;
}

function num(v: unknown, path: string, min: number, max: number, integer: boolean, required: string | false = false): number | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required for kind ${required}`);
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${path} must be a finite number`);
  if (integer && !Number.isInteger(v)) throw new Error(`${path} must be an integer`);
  if (v < min || v > max) throw new Error(`${path} must be between ${min} and ${max}`);
  return v;
}

const INPUT_FIELDS = ["date", "kind", "probability", "exercise", "sets", "reps", "kg", "threshold", "note", "rule"];
const STORED_FIELDS = [...INPUT_FIELDS, "id", "madeAt", "due", "voided", "outcome"];

// The fields a caller supplies (log_prediction's arguments, or the same fields of a stored prediction); `at` prefixes the
// messages ("predictions[3]." when a stored one is checked). Date rules that need "today" are checked by the caller.
function parseFields(o: Record<string, unknown>, allowed: string[], at: string) {
  onlyKeys(o, allowed, at);
  if (o.date === undefined) throw new Error(`${at}date is required`);
  const kind = o.kind;
  if (kind === undefined) throw new Error(`${at}kind is required`);
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) throw new Error(`${at}kind must be one of: ${KINDS.join(", ")}`);
  const k = kind as Kind;
  const date = o.date;
  if (typeof date !== "string" || !isValidCalendarDate(date)) throw new Error(`${at}date must be a calendar date YYYY-MM-DD`);
  if (o.probability === undefined) throw new Error(`${at}probability is required`);
  const probability = num(o.probability, `${at}probability`, 0, 1, false)!;
  for (const [field, only] of [["exercise", "reps_hit"], ["sets", "reps_hit"], ["reps", "reps_hit"], ["kg", "reps_hit"], ["threshold", "recovery_morning_at_least"]] as const) {
    if (o[field] !== undefined && k !== only) throw new Error(`${at}${field} is only for kind ${only}`);
  }
  const rest = k === "reps_hit"
    ? {
        exercise: o.exercise === undefined ? fail(`${at}exercise is required for kind reps_hit`) : text(o.exercise, `${at}exercise`, MAX_EXERCISE, true),
        sets: num(o.sets, `${at}sets`, 1, 20, true, k),
        reps: num(o.reps, `${at}reps`, 1, 200, true, k),
        kg: num(o.kg, `${at}kg`, 0, 1000, false),
      }
    : k === "recovery_morning_at_least"
      ? { threshold: num(o.threshold, `${at}threshold`, 0, 1, false, k) }
      : {};
  return defined({ date, kind: k, probability, ...rest, note: text(o.note, `${at}note`, MAX_TEXT), rule: text(o.rule, `${at}rule`, MAX_RULE, false, true) });
}

const fail = (message: string): never => {
  throw new Error(message);
};

const RESULTS: Result[] = ["hit", "miss", "unresolvable"];

function parsePrediction(v: unknown, i: number): Prediction {
  const at = `predictions[${i}].`;
  if (!isObject(v)) throw new Error(`predictions[${i}] must be an object`);
  const fields = parseFields(v, STORED_FIELDS, at);
  if (typeof v.id !== "string" || !/^p\d+$/.test(v.id)) throw new Error(`${at}id must look like p12`);
  if (typeof v.madeAt !== "string") throw new Error(`${at}madeAt must be a timestamp`);
  if (typeof v.due !== "string" || !isValidCalendarDate(v.due)) throw new Error(`${at}due must be a calendar date`);
  const p: Prediction = { id: v.id, madeAt: v.madeAt, ...fields, due: v.due };
  if (v.voided !== undefined) {
    if (!isObject(v.voided)) throw new Error(`${at}voided must be an object`);
    onlyKeys(v.voided, ["at", "reason"], `${at}voided.`);
    if (typeof v.voided.at !== "string") throw new Error(`${at}voided.at must be a timestamp`);
    p.voided = { at: v.voided.at, reason: text(v.voided.reason, `${at}voided.reason`, MAX_TEXT, true)! };
  }
  if (v.outcome !== undefined) {
    const o = v.outcome;
    if (!isObject(o)) throw new Error(`${at}outcome must be an object`);
    onlyKeys(o, ["result", "scoredAt", "detail", "observed", "basis"], `${at}outcome.`);
    if (typeof o.result !== "string" || !(RESULTS as string[]).includes(o.result)) throw new Error(`${at}outcome.result must be one of: ${RESULTS.join(", ")}`);
    if (typeof o.scoredAt !== "string") throw new Error(`${at}outcome.scoredAt must be a timestamp`);
    if (typeof o.detail !== "string") throw new Error(`${at}outcome.detail must be a string`);
    if (o.observed !== undefined && o.observed !== null && typeof o.observed !== "number" && typeof o.observed !== "string") throw new Error(`${at}outcome.observed must be a number, a string or null`);
    if (o.basis !== undefined && o.basis !== "draft-confirmed") throw new Error(`${at}outcome.basis must be "draft-confirmed" when given`);
    p.outcome = defined({ result: o.result as Result, scoredAt: o.scoredAt, detail: o.detail, observed: o.observed as Outcome["observed"], basis: o.basis as Outcome["basis"] });
  }
  return p;
}

export function parseLedger(raw: Record<string, unknown>): Ledger {
  onlyKeys(raw, ["version", "predictions"], "");
  if (!Array.isArray(raw.predictions)) throw new Error("predictions must be an array");
  if (raw.predictions.length > MAX_PREDICTIONS) throw new Error(`predictions can have at most ${MAX_PREDICTIONS} items`);
  const seen = new Set<string>();
  return {
    predictions: raw.predictions.map((v, i) => {
      const p = parsePrediction(v, i);
      if (seen.has(p.id)) throw new Error(`id ${p.id} is listed more than once`);
      seen.add(p.id);
      return p;
    }),
  };
}

export const memoryPredictionStore = (): PredictionStore => memoryDocStore<Ledger>();
export const filePredictionStore = (path = predictionsPath()): PredictionStore => fileDocStore(path, "predictions", parseLedger);

const queue = serialQueue();
const idNumber = (id: string) => Number(id.slice(1));

// ---------- log / void ----------

export function logPrediction(args: unknown, store: PredictionStore, deps: { now?: Date } = {}) {
  return queue(async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    const now = deps.now ?? new Date();
    const fields = parseFields(args, INPUT_FIELDS, "");
    const today = localDate(0, now);
    if (fields.date <= today) throw new Error(`date (${fields.date}) must be after today (${today}): a prediction is about the future, written down before the day begins`);
    if (fields.date > addDays(today, MAX_DAYS_AHEAD)) throw new Error(`date (${fields.date}) is more than ${MAX_DAYS_AHEAD} days ahead`);
    const ledger = (await store.load()) ?? { predictions: [] };
    if (ledger.predictions.length >= MAX_PREDICTIONS) throw new Error(`a ledger can hold at most ${MAX_PREDICTIONS} predictions`);
    // the same prediction twice would count twice in the statistics: probability, note and rule do not make it a different one
    const sig = (x: { kind: Kind; date: string; exercise?: string; sets?: number; reps?: number; kg?: number; threshold?: number }) => JSON.stringify([x.kind, x.date, x.exercise?.trim().toLowerCase(), x.sets, x.reps, x.kg, x.threshold]);
    const same = ledger.predictions.find((x) => !x.voided && !x.outcome && sig(x) === sig(fields));
    if (same) throw new Error(`this is the same as ${same.id} (still open): same kind, date and parameters. Void ${same.id} first (on a day before ${same.date}) if it should be replaced`);
    const id = `p${Math.max(0, ...ledger.predictions.map((x) => idNumber(x.id))) + 1}`;
    const saved: Prediction = { id, madeAt: now.toISOString(), ...fields, due: addDays(fields.date, SCORE_DELAY_DAYS) };
    await store.save({ predictions: [...ledger.predictions, saved] });
    return { saved, predictions: ledger.predictions.length + 1, note: `Written to the ledger, unchanged from now on. It is scored from ${saved.due}: call score_predictions then. It can be voided (with a reason) only on a day before ${saved.date}.` };
  });
}

export function voidPrediction(args: unknown, store: PredictionStore, deps: { now?: Date } = {}) {
  return queue(async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    onlyKeys(args, ["id", "reason"], "");
    const id = text(args.id, "id", 20, true)!;
    const reason = text(args.reason, "reason", MAX_TEXT, true)!;
    const now = deps.now ?? new Date();
    const ledger = await store.load();
    const p = ledger?.predictions.find((x) => x.id === id);
    if (!ledger || !p) throw new Error(`no prediction ${id} in the ledger`);
    if (p.voided) return { id, voided: p.voided, alreadyVoided: true };
    if (p.outcome) throw new Error(`${id} is already scored (${p.outcome.result}); a scored prediction cannot be voided`);
    if (localDate(0, now) >= p.date) throw new Error(`${id} is about ${p.date}, which has begun: a prediction can only be voided on a day before its date (it will be scored from ${p.due})`);
    const voided = { at: now.toISOString(), reason };
    await store.save({ predictions: ledger.predictions.map((x) => (x.id === id ? { ...x, voided } : x)) });
    return { id, voided, alreadyVoided: false };
  });
}

// ---------- scoring rules (pure) ----------

export interface Verdict {
  result: Result;
  detail: string;
  observed?: number | string | null;
  basis?: "draft-confirmed";
}
const unresolvable = (detail: string): Verdict => ({ result: "unresolvable", detail });

// The night after the predicted date, judged against the band get_baselines shows for it (edges inclusive).
export function scoreHrv(m: MetricBand): Verdict {
  if (m.latest === null) return unresolvable("no HRV was recorded for that night");
  if (m.latestVsBand === null) return unresolvable(`the baseline has only ${m.n} nights with HRV; a band needs at least ${MIN_BAND_N}`);
  return { result: m.latestVsBand === "within" ? "hit" : "miss", detail: `HRV ${m.latest} against the band ${m.p25}..${m.p75} (${m.latestVsBand})`, observed: m.latest };
}

export function scoreRecovery(m: MetricBand, threshold: number): Verdict {
  if (m.latest === null) return unresolvable("no morning recovery (Balance) was recorded after that night");
  return { result: m.latest >= threshold ? "hit" : "miss", detail: `Balance on waking ${m.latest} against at least ${threshold}`, observed: m.latest };
}

export interface FoundExercise {
  e: ExerciseRecord | undefined; // the exercise as the laps show it
  jEx: JournalExercise | undefined; // what log_session says about it
  format: string | null;
  reliable: boolean;
  draft?: boolean; // the journal entry was made from a confirmed draft_session_log (source 'draft')
}

// What was done is only known from log_session: the watch records the guide's text, not reps or weights. A logged set
// without a weight takes the guide label's (as get_exercise_history does). Without logged sets, the watch can only prove a
// MISS (fewer set laps than predicted, in a reliable per-set guide); it can never prove a hit.
export function scoreRepsHit(p: Prediction, f: FoundExercise): Verdict {
  const want = `${p.sets}x${p.reps}${p.kg !== undefined ? ` at ${p.kg} kg` : ""}`;
  const sets = (f.jEx?.sets ?? []).filter((s) => typeof s.reps === "number");
  if (sets.length > 0) {
    const labelKg = f.e?.load?.kg ?? null;
    const kgOf = (s: { kg?: number }) => s.kg ?? labelKg;
    if (p.kg !== undefined && sets.some((s) => kgOf(s) === null)) return unresolvable("a logged set has no weight and the guide's label shows none, so the load cannot be checked");
    const reached = sets.filter((s) => s.reps! >= p.reps! && (p.kg === undefined || kgOf(s)! >= p.kg)).length;
    return { result: reached >= p.sets! ? "hit" : "miss", detail: `${reached} of ${sets.length} logged sets reached ${p.reps} reps${p.kg !== undefined ? ` at ${p.kg} kg or more` : ""}; ${p.sets} were predicted (${want})`, observed: reached, ...(f.draft ? { basis: "draft-confirmed" as const } : {}) };
  }
  if (f.e && f.format === "strength-perSet" && f.reliable && f.e.setsDone < p.sets!) {
    return { result: "miss", detail: `the watch recorded ${f.e.setsDone} set laps for ${f.e.name}, fewer than the ${p.sets} predicted`, observed: f.e.setsDone };
  }
  return unresolvable("the watch records the guide's text, not reps or weights, and no log_session entry has sets for this exercise: log them (log_session, or confirm a draft_session_log), then score again with rescoreUnresolvable");
}

// ---------- scoring (the call) ----------

type Pending = { pending: string };
type Client = Pick<SuuntoClient, "listWorkouts" | "listSleep" | "listRecovery" | "getDailyStats" | "getWorkoutWithExtensions">;
export interface ScoreDeps {
  now?: Date;
  loadJournal?: () => Promise<Record<string, JournalEntry>>;
}

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);
const short = (err: unknown) => String((err as any)?.message ?? err).slice(0, ERROR_MAX);

export function scorePredictions(client: Client, store: PredictionStore, opts: { rescoreUnresolvable?: boolean } = {}, deps: ScoreDeps = {}) {
  return queue(async () => {
    const now = deps.now ?? new Date();
    const today = localDate(0, now);
    const first = await store.load(); // an unreadable ledger stops the call
    const empty = { today, scored: [] as { id: string; date: string; kind: Kind; result: Result; detail: string }[], hits: 0, misses: 0, unresolvable: 0, pending: [] as { id: string; date: string; kind: Kind; reason: string }[], notDue: 0, remaining: 0, errors: [] as { id: string; error: string }[], notes: [] as string[] };
    if (!first) return empty;
    const open = first.predictions.filter((p) => !p.voided && (p.outcome === undefined || (opts.rescoreUnresolvable === true && p.outcome.result === "unresolvable")));
    // never-scored ones first, rescored unresolvable ones after them: a call always advances through what is new
    const byDue = (a: Prediction, b: Prediction) => a.due.localeCompare(b.due) || idNumber(a.id) - idNumber(b.id);
    const due = [...open.filter((p) => p.due <= today && p.outcome === undefined).sort(byDue), ...open.filter((p) => p.due <= today && p.outcome !== undefined).sort(byDue)];
    const batch = due.slice(0, MAX_SCORED_PER_CALL);
    const out = { ...empty, notDue: open.filter((p) => p.due > today && p.outcome === undefined).length, remaining: due.length - batch.length };

    // Each piece of evidence is read once per call, however many predictions need it. A failed read is remembered too: it
    // fails every prediction that needs it, and those stay unscored (a failed request is not "data missing").
    const once = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => {
      const memo = new Map<string, Promise<T>>();
      return (...a: A) => memo.get(a.join("|")) ?? (memo.set(a.join("|"), fn(...a)), memo.get(a.join("|"))!);
    };
    const baselines = once((judged: string) => buildBaselines(client as any, { date: judged, days: BASELINE_DAYS }));
    const dates = batch.filter((p) => p.kind === "session_done" || p.kind === "reps_hit").map((p) => p.date).sort();
    const workoutsByDate = once(async () => {
      const bounds = dayFetchBounds(dates[0], dates[dates.length - 1]);
      const byDate = new Map<string, any[]>();
      for (const w of rowsOf(await client.listWorkouts({ since: bounds.from, until: bounds.to, limit: WORKOUT_LIMIT }))) byDate.set(workoutDate(w), [...(byDate.get(workoutDate(w)) ?? []), w]);
      return byDate;
    });
    // The newest day the watch has synced data for. A day without a workout is a miss only if data from a LATER day exists:
    // otherwise "no workout" cannot be told from "not synced yet".
    const syncedThrough = once(async () => {
      const days = rowsOf(await client.listRecovery(addDays(today, -SYNC_PROBE_DAYS), today)).map(rowDate).filter((d) => d !== "").sort();
      return days.length ? days[days.length - 1] : null;
    });
    // Workouts of the prediction's date that started after it was made: an earlier one cannot be what was predicted.
    const workoutsOf = async (p: Prediction) => ((await workoutsByDate()).get(p.date) ?? []).filter((w) => Number(w?.startTime) >= Date.parse(p.madeAt));
    // Missing data is "not synced yet" until the watch has synced something from a LATER day: then it is truly missing.
    const pending = (reason: string): Pending => ({ pending: reason });
    const noWorkout = async (date: string, what: string): Promise<Verdict | Pending> => {
      const synced = await syncedThrough();
      return synced !== null && synced >= addDays(date, 1)
        ? { result: "miss", detail: `no workout on ${date} (the watch has synced data up to ${synced}), so ${what}`, observed: 0 }
        : pending(`no workout found on ${date}, and the watch has not synced anything after that day, so a missing workout cannot be told from a missing sync`);
    };
    // the night after `date` leads into date + 1: it is truly missing once data from date + 2 or later exists
    const noNight = async (date: string, v: Verdict): Promise<Verdict | Pending> => {
      const synced = await syncedThrough();
      return synced !== null && synced >= addDays(date, 2) ? v : pending(`${v.detail}, and the watch has not synced anything after that night, so a missing night cannot be told from a missing sync`);
    };
    const laps = once(async (key: string) => client.getWorkoutWithExtensions(key, LAP_EXTENSIONS));
    const journal = once(async () => validEntries(await (deps.loadJournal ?? loadJournal)()).entries);
    const failIfSection = (b: Awaited<ReturnType<typeof buildBaselines>>, sections: string[]) => {
      const bad = b.errors.find((e) => sections.includes(e.section));
      if (bad) throw new Error(`the ${bad.section} data could not be read: ${bad.error}`);
    };

    const scoreOne = async (p: Prediction): Promise<Verdict | Pending> => {
      switch (p.kind) {
        case "hrv_in_band": {
          const b = await baselines(addDays(p.date, 1)); // the night after the date leads into the next day
          failIfSection(b, ["sleep"]);
          const v = scoreHrv(b.metrics.hrv);
          return b.metrics.hrv.latest === null ? noNight(p.date, v) : v;
        }
        case "recovery_morning_at_least": {
          const b = await baselines(addDays(p.date, 1));
          failIfSection(b, ["sleep", "recovery"]);
          const v = scoreRecovery(b.metrics.recoveryMorning, p.threshold!);
          return b.metrics.recoveryMorning.latest === null ? noNight(p.date, v) : v;
        }
        case "session_done": {
          const ws = await workoutsOf(p);
          return ws.length > 0 ? { result: "hit", detail: `${ws.length} workout${ws.length === 1 ? "" : "s"} on ${p.date}`, observed: ws.length } : noWorkout(p.date, "the session was not done");
        }
        case "reps_hit": {
          const ws = await workoutsOf(p);
          if (ws.length === 0) return noWorkout(p.date, "the sets were not done");
          const guided = ws.filter((w) => Array.isArray(w?.extensionTypes) && w.extensionTypes.includes("MANUALLAP") && WORKOUT_KEY.test(String(w?.workoutKey)));
          if (guided.length === 0) return unresolvable(`the ${ws.length} workout${ws.length === 1 ? "" : "s"} on ${p.date} have no guide laps, so no exercise can be matched`);
          const keys = guided.sort((a, b) => b.startTime - a.startTime).map((w) => String(w.workoutKey).toLowerCase());
          const entries = await journal();
          for (const key of keys) {
            const shaped = shapeLaps(await laps(key));
            const cmp = compareWorkout(shaped);
            const e = deriveRecord(shaped, null, p.date).exercises.find((x) => nameMatches(p.exercise!, x));
            const jEx = entries[key]?.exercises?.find((x) => (e ? nameMatches(x.name, e) : nameMatches(p.exercise!, { name: x.name, cut: false })));
            if (e || jEx) return scoreRepsHit(p, { e, jEx, format: cmp.format, reliable: cmp.reliable, draft: entries[key]?.source === "draft" });
          }
          return unresolvable(`no exercise matching "${p.exercise}" in ${keys.length === 1 ? "the session" : `the ${keys.length} guided sessions`} of ${p.date}`);
        }
      }
    };

    const verdicts = new Map<string, Verdict>();
    for (const p of batch) {
      try {
        const v = await scoreOne(p);
        if ("pending" in v) out.pending.push({ id: p.id, date: p.date, kind: p.kind, reason: v.pending });
        else verdicts.set(p.id, v);
      } catch (err) {
        out.errors.push({ id: p.id, error: short(err) });
      }
    }

    // Written on what is stored NOW (another process may have added predictions while Suunto was read); an outcome is only
    // set on a prediction still open, and an unresolvable one read again with the same answer is left as it is.
    const latest = (await store.load()) ?? first;
    const changed = new Set<string>();
    const next = latest.predictions.map((p) => {
      const v = verdicts.get(p.id);
      if (!v || p.voided || (p.outcome !== undefined && p.outcome.result !== "unresolvable")) return p;
      if (p.outcome && v.result === "unresolvable" && v.detail === p.outcome.detail) return p;
      changed.add(p.id);
      return { ...p, outcome: defined({ result: v.result, scoredAt: now.toISOString(), detail: v.detail.slice(0, MAX_TEXT), observed: v.observed, basis: v.basis }) };
    });
    if (changed.size > 0) await store.save({ predictions: next });
    for (const p of next.filter((x) => changed.has(x.id))) {
      const o = p.outcome!;
      out.scored.push({ id: p.id, date: p.date, kind: p.kind, result: o.result, detail: o.detail });
      if (o.result === "hit") out.hits++;
      else if (o.result === "miss") out.misses++;
      else out.unresolvable++;
    }
    if (out.remaining > 0) out.notes.push(`${out.remaining} more due predictions are not scored yet (at most ${MAX_SCORED_PER_CALL} per call): call score_predictions again.`);
    if (out.pending.length > 0) out.notes.push(`${out.pending.length} prediction(s) are waiting for data (see pending): a workout or a night that is missing may only not have synced yet. They stay unscored and the next call looks again; they become unresolvable or a miss only once the watch has synced a later day.`);
    if (out.unresolvable > 0) out.notes.push("unresolvable means the data to decide was missing: it counts as neither hit nor miss. A reps_hit becomes scorable once the sets are logged with log_session; call again with rescoreUnresolvable: true.");
    return out;
  });
}

// ---------- statistics ----------

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function groupOf(ps: Prediction[]) {
  const scored = ps.filter((p) => p.outcome && p.outcome.result !== "unresolvable").map((p) => ({ probability: p.probability, hit: p.outcome!.result === "hit", draft: p.outcome!.basis === "draft-confirmed" }));
  const n = scored.length;
  const hits = scored.filter((s) => s.hit).length;
  const counts = {
    logged: ps.length,
    n,
    hits,
    misses: n - hits,
    unresolvable: ps.filter((p) => p.outcome?.result === "unresolvable").length,
    voided: ps.filter((p) => p.voided).length,
    unscored: ps.filter((p) => !p.voided && !p.outcome).length,
  };
  // reps_hit scored from a confirmed draft began as the guide's plan: shown apart, each part under the same minimum
  const part = (xs: typeof scored) => ({ n: xs.length, hits: xs.filter((x) => x.hit).length, hitRate: xs.length >= MIN_SCORED ? r3(xs.filter((x) => x.hit).length / xs.length) : null });
  const basis = { draftConfirmed: part(scored.filter((x) => x.draft)), other: part(scored.filter((x) => !x.draft)) };
  if (n < MIN_SCORED) {
    return { ...counts, basis, hitRate: null, meanProbability: null, brier: null, brierBaseRate: null, calibration: null, verdict: "insufficient" as const, statement: `${n} scored predictions; at least ${MIN_SCORED} are needed before a hit rate, a Brier score or a calibration table is shown.` };
  }
  const rate = hits / n;
  const brier = scored.reduce((s, x) => s + (x.probability - (x.hit ? 1 : 0)) ** 2, 0) / n;
  const calibration = Array.from({ length: BUCKETS }, (_, b) => {
    const inBucket = scored.filter((x) => Math.min(BUCKETS - 1, Math.floor(x.probability * BUCKETS + 1e-9)) === b);
    return {
      from: b / BUCKETS,
      to: (b + 1) / BUCKETS,
      n: inBucket.length,
      meanProbability: inBucket.length ? r3(inBucket.reduce((s, x) => s + x.probability, 0) / inBucket.length) : null,
      hitRate: inBucket.length >= MIN_BUCKET_N ? r3(inBucket.filter((x) => x.hit).length / inBucket.length) : null,
    };
  });
  return {
    ...counts,
    basis,
    hitRate: r3(rate),
    meanProbability: r3(scored.reduce((s, x) => s + x.probability, 0) / n),
    brier: r3(brier),
    brierBaseRate: r3(rate * (1 - rate)),
    calibration,
    verdict: "ok" as const,
    statement: `${n} scored predictions: ${hits} hit (${r3(rate)}), Brier score ${r3(brier)} (0 is perfect; ${r3(rate * (1 - rate))} is what always saying ${r3(rate)} would have scored).`,
  };
}

const statusOf = (p: Prediction, today: string): string => (p.voided ? "void" : p.outcome ? p.outcome.result : p.due <= today ? "due" : "open");

export function predictionStats(ledger: Ledger | null, now = new Date()) {
  const today = localDate(0, now);
  const ps = ledger?.predictions ?? [];
  const kinds = KINDS.filter((k) => ps.some((p) => p.kind === k));
  const rules = [...new Set(ps.map((p) => p.rule ?? null))];
  return {
    today,
    thresholds: { minScored: MIN_SCORED, minBucketN: MIN_BUCKET_N, buckets: BUCKETS },
    dueUnscored: ps.filter((p) => !p.voided && !p.outcome && p.due <= today).length,
    overall: groupOf(ps),
    byKind: kinds.map((kind) => ({ kind, ...groupOf(ps.filter((p) => p.kind === kind)) })),
    byRule: rules.map((rule) => ({ rule, ...groupOf(ps.filter((p) => (p.rule ?? null) === rule)) })),
    recent: [...ps].sort((a, b) => idNumber(b.id) - idNumber(a.id)).slice(0, RECENT).map((p) => ({ id: p.id, date: p.date, kind: p.kind, probability: p.probability, rule: p.rule ?? null, due: p.due, status: statusOf(p, today), detail: p.outcome?.detail ?? p.voided?.reason ?? null })),
    notes: [
      "Only hit and miss count: unresolvable (data missing), voided and not-yet-scored predictions are counted but never scored.",
      "Brier score = the mean of (probability - outcome)^2, outcome 1 for a hit and 0 for a miss: lower is better, and a score below brierBaseRate means the stated probabilities carried information beyond the overall hit rate.",
      "Calibration: predictions are grouped by stated probability (0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1); in a calibrated forecaster each group's hitRate is close to its meanProbability. A group with fewer than " + MIN_BUCKET_N + " predictions shows no hitRate.",
      "basis: a reps_hit scored from a journal entry that was made from a confirmed draft_session_log (source 'draft') began as the guide's plan, and a user who confirms without checking would make every such prediction a hit. Their hit rate is shown apart from the others (each under the same minimum), and they still count in the overall figures.",
      `Nothing is claimed below ${MIN_SCORED} scored predictions (overall, per kind or per rule): the rates are null and verdict is 'insufficient'.`,
    ],
  };
}
