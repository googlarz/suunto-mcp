// Randomized self-experiments: start_experiment / get_experiment / log_experiment_day / analyze_experiment /
// stop_experiment. "Does X change my sleep?" answered the way a trial would: the hypothesis and the analysis are written
// down before the first day, the schedule of intervention and control days is drawn up front by a seeded random generator
// (in pairs, so the two arms stay balanced) and never redrawn, the user logs what actually happened each day, and the
// analysis compares the nights after intervention days with the nights after control days with a permutation test over
// the very scheme that was randomized. Nothing is ever deleted: a stopped experiment keeps its schedule and log.
// Local file ~/.suunto-mcp/experiments.json (SUUNTO_EXPERIMENTS_PATH); toward Suunto only reads. Demo mode: in memory.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { localDate, nightOf, rowDate } from "./api.js";
import { METRICS, nightMetrics, quantile } from "./baselines.js";
import { fileDocStore, memoryDocStore, serialQueue, type DocStore } from "./local-store.js";
import { mulberry32 } from "./prng.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { SE_K, thresholdOf } from "./tag-effects.js";
import { addDays } from "./training-load.js";

// The nightly metrics get_tag_effects and get_baselines use, taken the same way (nightMetrics).
export const OUTCOME_METRICS = ["sleepDurationS", "sleepScore", "hrv", "recoveryMorning"] as const;
export type OutcomeMetric = (typeof OUTCOME_METRICS)[number];
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];
export type Arm = "intervention" | "control" | "washout" | "none";

export const MIN_DAYS = 14;
export const MAX_DAYS = 60;
export const MAX_WASHOUT = 2;
export const MAX_TEXT = 500;
export const MAX_NAME = 100;
export const MAX_EXPERIMENTS = 50;
// Nights WITH a value, per arm, for a verdict. With 6 pairs the smallest two-sided p-value a permutation test over pairs
// can reach is 2/2^6 = 0.031, below 0.05; with 5 it is 2/2^5 = 0.0625, so even a perfectly consistent effect could not be
// told from chance. 6 is the least that can ever show anything.
export const MIN_NIGHTS_PER_ARM = 6;
export const ALPHA = 0.05;
// Up to this many informative pairs every one of the 2^k flips of the scheme is enumerated (exact p-value); beyond it
// PERMUTATION_DRAWS random flips are drawn with the fixed seed.
export const EXACT_MAX_BLOCKS = 15;
export const PERMUTATION_DRAWS = 20_000;
export const PERMUTATION_SEED = 20_261_115;
// The night after a day is recorded and synced from the second day after it.
export const NIGHT_DELAY_DAYS = 2;
const EPS = 1e-9;
const ERROR_MAX = 200;

export interface DayLog {
  followed: boolean;
  note?: string;
  loggedAt: string;
  earlier?: { followed: boolean; note?: string; loggedAt: string }[];
}
export interface ScheduleDay {
  date: string;
  arm: Arm;
  block?: number; // the pair a trial day belongs to
}
export interface Experiment {
  id: string;
  name: string;
  intervention: string;
  control: string;
  metric: OutcomeMetric;
  days: number;
  eligible?: Weekday[];
  washout: number;
  createdAt: string;
  startDate: string;
  endDate: string;
  seed: number;
  hypothesis: string;
  analysisPlan: string[];
  schedule: ScheduleDay[];
  log: Record<string, DayLog>;
  stopped?: { at: string; date: string; reason: string };
}
export interface ExperimentsFile {
  experiments: Experiment[];
}
export type ExperimentStore = DocStore<ExperimentsFile>;

export const experimentsPath = (): string => process.env.SUUNTO_EXPERIMENTS_PATH ?? join(homedir(), ".suunto-mcp", "experiments.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const weekdayOf = (date: string): Weekday => WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
const ARMS: Arm[] = ["intervention", "control", "washout", "none"];

function onlyKeys(o: Record<string, unknown>, allowed: string[], at: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Error(`${at}${extra} is not a known field (allowed here: ${allowed.join(", ")})`);
}
function text(v: unknown, path: string, max: number, required = false): string | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`${path} must be a string`);
  if (v.length > max) throw new Error(`${path} must be at most ${max} characters`);
  if (required && v.trim() === "") throw new Error(`${path} must not be empty`);
  return v;
}
function int(v: unknown, path: string, min: number, max: number, required = false): number | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${path} must be a finite number`);
  if (!Number.isInteger(v)) throw new Error(`${path} must be an integer`);
  if (v < min || v > max) throw new Error(`${path} must be between ${min} and ${max}`);
  return v;
}
function date(v: unknown, path: string, required = false): string | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "string" || !isValidCalendarDate(v)) throw new Error(`${path} must be a calendar date YYYY-MM-DD`);
  return v;
}
function metric(v: unknown, path: string): OutcomeMetric {
  if (v === undefined) throw new Error(`${path} is required`);
  if (typeof v !== "string" || !(OUTCOME_METRICS as readonly string[]).includes(v)) throw new Error(`${path} must be one of: ${OUTCOME_METRICS.join(", ")}`);
  return v as OutcomeMetric;
}
function weekdays(v: unknown, path: string): Weekday[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.length > 7) throw new Error(`${path} must be a list of 1 to 7 weekdays`);
  for (const d of v) if (typeof d !== "string" || !(WEEKDAYS as readonly string[]).includes(d)) throw new Error(`${path} must only hold: ${WEEKDAYS.join(", ")}`);
  if (new Set(v).size !== v.length) throw new Error(`${path} lists a weekday twice`);
  return WEEKDAYS.filter((d) => v.includes(d));
}

// ---------- the schedule ----------

export interface DesignInput {
  startDate: string;
  days: number;
  eligible?: Weekday[];
  washout: number;
}

// Day by day from the start: a day inside the washout that follows an intervention day is 'washout'; a day that is not an
// eligible weekday is 'none'; every other day is a trial day. Trial days are taken two at a time (a block): one
// intervention and one control, in an order drawn by the generator, so the arms are balanced exactly. A last block left
// with one day is dropped ('none', and the washout after it too): balance matters more than one more night.
export function generateSchedule(design: DesignInput, seed: number): ScheduleDay[] {
  const rng = mulberry32(seed);
  const out: ScheduleDay[] = [];
  let queue: Arm[] = [];
  let block = 0;
  let cooldown = 0;
  for (let i = 0; i < design.days; i++) {
    const d = addDays(design.startDate, i);
    if (cooldown > 0) {
      cooldown--;
      out.push({ date: d, arm: "washout" });
    } else if (design.eligible && !design.eligible.includes(weekdayOf(d))) {
      out.push({ date: d, arm: "none" });
    } else {
      if (queue.length === 0) {
        queue = rng() < 0.5 ? ["intervention", "control"] : ["control", "intervention"];
        block++;
      }
      const arm = queue.shift()!;
      out.push({ date: d, arm, block });
      if (arm === "intervention") cooldown = design.washout;
    }
  }
  if (queue.length === 1) {
    const at = out.map((s) => s.block).lastIndexOf(block);
    out[at] = { date: out[at].date, arm: "none" };
    for (let j = at + 1; j < out.length && out[j].arm === "washout"; j++) out[j] = { date: out[j].date, arm: "none" };
  }
  return out;
}

const armCounts = (schedule: ScheduleDay[]) => ({ intervention: schedule.filter((s) => s.arm === "intervention").length, control: schedule.filter((s) => s.arm === "control").length });

// ---------- parsing the file ----------

function parseLogEntry(v: unknown, at: string) {
  if (!isObject(v)) throw new Error(`${at} must be an object`);
  onlyKeys(v, ["followed", "note", "loggedAt", "earlier"], `${at}.`);
  if (typeof v.followed !== "boolean") throw new Error(`${at}.followed must be true or false`);
  if (typeof v.loggedAt !== "string") throw new Error(`${at}.loggedAt must be a timestamp`);
  return { followed: v.followed, ...(v.note !== undefined ? { note: text(v.note, `${at}.note`, MAX_TEXT) } : {}), loggedAt: v.loggedAt };
}

function parseExperiment(v: unknown, i: number): Experiment {
  const at = `experiments[${i}]`;
  if (!isObject(v)) throw new Error(`${at} must be an object`);
  onlyKeys(v, ["id", "name", "intervention", "control", "metric", "days", "eligible", "washout", "createdAt", "startDate", "endDate", "seed", "hypothesis", "analysisPlan", "schedule", "log", "stopped"], `${at}.`);
  if (typeof v.id !== "string" || !/^e\d+$/.test(v.id)) throw new Error(`${at}.id must look like e3`);
  const days = int(v.days, `${at}.days`, MIN_DAYS, MAX_DAYS, true)!;
  const startDate = date(v.startDate, `${at}.startDate`, true)!;
  if (date(v.endDate, `${at}.endDate`, true) !== addDays(startDate, days - 1)) throw new Error(`${at}.endDate must be ${days - 1} days after startDate`);
  if (typeof v.createdAt !== "string") throw new Error(`${at}.createdAt must be a timestamp`);
  const seed = int(v.seed, `${at}.seed`, 0, 4_294_967_295, true)!;
  if (!Array.isArray(v.analysisPlan) || v.analysisPlan.some((s) => typeof s !== "string")) throw new Error(`${at}.analysisPlan must be a list of strings`);
  if (!Array.isArray(v.schedule) || v.schedule.length !== days) throw new Error(`${at}.schedule must hold one entry per day (${days})`);
  const blocks = new Map<number, Arm[]>();
  const schedule = v.schedule.map((s, j): ScheduleDay => {
    const p = `${at}.schedule[${j}]`;
    if (!isObject(s)) throw new Error(`${p} must be an object`);
    onlyKeys(s, ["date", "arm", "block"], `${p}.`);
    if (s.date !== addDays(startDate, j)) throw new Error(`${p}.date must be ${addDays(startDate, j)}`);
    if (typeof s.arm !== "string" || !ARMS.includes(s.arm as Arm)) throw new Error(`${p}.arm must be one of: ${ARMS.join(", ")}`);
    const trial = s.arm === "intervention" || s.arm === "control";
    if (trial !== (s.block !== undefined)) throw new Error(`${p}.block is for trial days (intervention, control) only, and every trial day has one`);
    if (trial) blocks.set(s.block as number, [...(blocks.get(s.block as number) ?? []), s.arm as Arm]);
    return defined({ date: s.date, arm: s.arm as Arm, block: s.block as number | undefined });
  });
  for (const [b, arms] of blocks) if (arms.length !== 2 || arms[0] === arms[1]) throw new Error(`${at}.schedule: block ${b} must hold one intervention and one control day`);
  const trialDates = new Set(schedule.filter((s) => s.block !== undefined).map((s) => s.date));
  if (!isObject(v.log)) throw new Error(`${at}.log must be an object`);
  const log: Record<string, DayLog> = {};
  for (const [d, entry] of Object.entries(v.log)) {
    if (!trialDates.has(d)) throw new Error(`${at}.log[${d}] is not a trial day`);
    const e = parseLogEntry(entry, `${at}.log[${d}]`);
    const earlier = (entry as any).earlier;
    log[d] = { ...e, ...(earlier !== undefined ? { earlier: (earlier as unknown[]).map((x, k) => parseLogEntry(x, `${at}.log[${d}].earlier[${k}]`)) } : {}) };
  }
  let stopped: Experiment["stopped"];
  if (v.stopped !== undefined) {
    if (!isObject(v.stopped)) throw new Error(`${at}.stopped must be an object`);
    onlyKeys(v.stopped, ["at", "date", "reason"], `${at}.stopped.`);
    if (typeof v.stopped.at !== "string") throw new Error(`${at}.stopped.at must be a timestamp`);
    stopped = { at: v.stopped.at, date: date(v.stopped.date, `${at}.stopped.date`, true)!, reason: text(v.stopped.reason, `${at}.stopped.reason`, MAX_TEXT, true)! };
  }
  return defined({
    id: v.id,
    name: text(v.name, `${at}.name`, MAX_NAME, true)!,
    intervention: text(v.intervention, `${at}.intervention`, MAX_TEXT, true)!,
    control: text(v.control, `${at}.control`, MAX_TEXT, true)!,
    metric: metric(v.metric, `${at}.metric`),
    days,
    eligible: weekdays(v.eligible, `${at}.eligible`),
    washout: int(v.washout, `${at}.washout`, 0, MAX_WASHOUT, true)!,
    createdAt: v.createdAt,
    startDate,
    endDate: v.endDate as string,
    seed,
    hypothesis: text(v.hypothesis, `${at}.hypothesis`, 4 * MAX_TEXT, true)!,
    analysisPlan: v.analysisPlan as string[],
    schedule,
    log,
    stopped,
  });
}

export function parseExperiments(raw: Record<string, unknown>): ExperimentsFile {
  onlyKeys(raw, ["version", "experiments"], "");
  if (!Array.isArray(raw.experiments)) throw new Error("experiments must be an array");
  if (raw.experiments.length > MAX_EXPERIMENTS) throw new Error(`experiments can have at most ${MAX_EXPERIMENTS} items`);
  const seen = new Set<string>();
  return {
    experiments: raw.experiments.map((v, i) => {
      const e = parseExperiment(v, i);
      if (seen.has(e.id)) throw new Error(`id ${e.id} is listed more than once`);
      seen.add(e.id);
      return e;
    }),
  };
}

export const memoryExperimentStore = (): ExperimentStore => memoryDocStore<ExperimentsFile>();
export const fileExperimentStore = (path = experimentsPath()): ExperimentStore => fileDocStore(path, "experiments", parseExperiments);

const queue = serialQueue();
const idNumber = (id: string) => Number(id.slice(1));

export type Status = "upcoming" | "running" | "finished" | "stopped";
export const statusOf = (e: Experiment, today: string): Status => (e.stopped ? "stopped" : today < e.startDate ? "upcoming" : today <= e.endDate ? "running" : "finished");

// ---------- start ----------

const label = (m: OutcomeMetric) => ({ sleepDurationS: "sleep duration", sleepScore: "sleep score", hrv: "overnight HRV", recoveryMorning: "morning recovery (Balance on waking)" })[m];

function preregistration(e: { metric: OutcomeMetric; intervention: string; control: string; washout: number; startDate: string; days: number; seed: number }, perArm: number) {
  return {
    hypothesis: `The median ${label(e.metric)} on the night after an intervention day ("${e.intervention}") differs from the median on the night after a control day ("${e.control}"). Two-sided: no direction is assumed.`,
    analysisPlan: [
      `Outcome: ${e.metric}, the night after each assigned day (the one measured by get_tag_effects and get_baselines), taken from Suunto's data. Nothing else is tested.`,
      `Design: ${e.days} days from ${e.startDate}; ${perArm} intervention and ${perArm} control days, drawn before the start in pairs (one of each, order random, seed ${e.seed}). ${e.washout > 0 ? `The ${e.washout} day(s) after each intervention day are a washout and are not analysed.` : "No washout."}`,
      "Estimate: the median of the intervention nights minus the median of the control nights.",
      `Test: two-sided permutation test over the pairs: every way of swapping the arms within a pair is as likely as the one drawn if the intervention does nothing. Exact up to ${EXACT_MAX_BLOCKS} informative pairs, else ${PERMUTATION_DRAWS} random swaps with fixed seed ${PERMUTATION_SEED}.`,
      "Primary analysis: intention to treat (every assigned day counts as assigned, whether followed or not). Per protocol (only days logged as followed) is reported beside it and is not protected by the randomization.",
      `Verdict: 'insufficient' with fewer than ${MIN_NIGHTS_PER_ARM} nights with a value in either arm; otherwise a difference is reported only when p <= ${ALPHA} AND the median difference is larger than get_tag_effects' noise threshold (${SE_K} * 1.25 * (IQR of the control nights / 1.35) * sqrt(1/nIntervention + 1/nControl)).`,
      "Analysis is run once, after the planned end. An earlier look is exploratory and is flagged as such.",
    ],
  };
}

export function startExperiment(args: unknown, store: ExperimentStore, deps: { now?: Date; seed?: number } = {}) {
  return queue(async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    onlyKeys(args, ["name", "intervention", "control", "metric", "days", "eligible", "washout", "startDate"], "");
    const now = deps.now ?? new Date();
    const today = localDate(0, now);
    const input = {
      name: text(args.name, "name", MAX_NAME, true)!,
      intervention: text(args.intervention, "intervention", MAX_TEXT, true)!,
      control: text(args.control, "control", MAX_TEXT, true)!,
      metric: metric(args.metric, "metric"),
      days: int(args.days, "days", MIN_DAYS, MAX_DAYS, true)!,
      eligible: weekdays(args.eligible, "eligible"),
      washout: int(args.washout, "washout", 0, MAX_WASHOUT) ?? 0,
    };
    const startDate = date(args.startDate, "startDate") ?? addDays(today, 1);
    if (startDate < today) throw new Error(`startDate (${startDate}) is before today (${today}): the schedule is drawn before the first day`);
    if (startDate > addDays(today, MAX_DAYS)) throw new Error(`startDate (${startDate}) is more than ${MAX_DAYS} days ahead`);
    const file = (await store.load()) ?? { experiments: [] };
    if (file.experiments.length >= MAX_EXPERIMENTS) throw new Error(`the file holds ${MAX_EXPERIMENTS} experiments, the most this server keeps`);
    const clash = file.experiments.find((e) => e.metric === input.metric && (statusOf(e, today) === "upcoming" || statusOf(e, today) === "running"));
    if (clash) throw new Error(`${clash.id} ("${clash.name}") is still ${statusOf(clash, today)} on ${input.metric}: only one active experiment per outcome metric (stop it with stop_experiment, or wait until it ends)`);

    const seed = deps.seed ?? randomBytes(4).readUInt32BE();
    const schedule = generateSchedule({ startDate, days: input.days, eligible: input.eligible, washout: input.washout }, seed);
    const counts = armCounts(schedule);
    if (counts.intervention < MIN_NIGHTS_PER_ARM) {
      throw new Error(`this design has only ${counts.intervention} intervention and ${counts.control} control days: at least ${MIN_NIGHTS_PER_ARM} of each are needed for a verdict (more days, more eligible weekdays or a shorter washout)`);
    }
    const id = `e${Math.max(0, ...file.experiments.map((e) => idNumber(e.id))) + 1}`;
    const experiment: Experiment = {
      id,
      ...input,
      createdAt: now.toISOString(),
      startDate,
      endDate: addDays(startDate, input.days - 1),
      seed,
      ...preregistration({ ...input, startDate, seed }, counts.intervention),
      schedule,
      log: {},
    };
    const stored = defined(experiment);
    await store.save({ experiments: [...file.experiments, stored] });
    return { saved: summarize(stored, today), experiment: stored, note: "Pre-registered: the hypothesis, the analysis plan and the schedule are fixed from now on and are never redrawn. Follow get_experiment each day and record what really happened with log_experiment_day." };
  });
}

// ---------- reading ----------

const trialDays = (e: Experiment) => e.schedule.filter((s) => s.block !== undefined);

function adherenceOf(e: Experiment, today: string) {
  const row = (arm: "intervention" | "control" | null) => {
    const elapsed = trialDays(e).filter((s) => s.date <= today && (arm === null || s.arm === arm));
    const logged = elapsed.filter((s) => e.log[s.date]);
    const followed = logged.filter((s) => e.log[s.date].followed).length;
    return { elapsed: elapsed.length, logged: logged.length, followed, notFollowed: logged.length - followed, notLogged: elapsed.length - logged.length };
  };
  return { ...row(null), byArm: { intervention: row("intervention"), control: row("control") } };
}

function assignment(e: Experiment, d: string) {
  const day = e.schedule.find((s) => s.date === d);
  const arm: Arm | null = day ? day.arm : null;
  const instruction = arm === "intervention" ? e.intervention : arm === "control" ? e.control : arm === "washout" ? "Washout day: carry-over from the last intervention day; nothing is assigned and the night is not analysed." : arm === "none" ? "Nothing is assigned today." : null;
  const logged = e.log[d];
  return { date: d, arm, instruction, followed: logged ? logged.followed : null, note: arm === null ? (d < e.startDate ? "The experiment has not started." : "The experiment's days are over.") : null };
}

function summarize(e: Experiment, today: string) {
  const elapsed = Math.min(e.days, Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.startDate}T00:00:00Z`)) / 86_400_000) + 1));
  return {
    id: e.id,
    name: e.name,
    metric: e.metric,
    status: statusOf(e, today),
    startDate: e.startDate,
    endDate: e.endDate,
    intervention: e.intervention,
    control: e.control,
    today: assignment(e, today),
    progress: { days: e.days, daysElapsed: elapsed, planned: armCounts(e.schedule) },
    adherence: adherenceOf(e, today),
    stopped: e.stopped ?? null,
  };
}

export async function getExperiment(store: ExperimentStore, args: { id?: string } = {}, now = new Date()) {
  const today = localDate(0, now);
  const file = await store.load();
  if (!file) {
    if (args.id !== undefined) throw new Error(`no experiment ${args.id}`);
    return { today, experiments: [], selected: null, note: "No experiment yet: start one with start_experiment." };
  }
  let selected: Experiment | null = null;
  if (args.id !== undefined) {
    selected = file.experiments.find((e) => e.id === args.id) ?? null;
    if (!selected) throw new Error(`no experiment ${args.id}`);
  }
  // the log as a list: a result never has a date as a key (the contract fixtures record keys, and dates are values)
  const full = selected && { ...selected, log: Object.entries(selected.log).map(([date, entry]) => ({ date, ...entry })) };
  return { today, experiments: file.experiments.map((e) => summarize(e, today)), selected: full, note: null };
}

// ---------- log a day ----------

function pick(file: ExperimentsFile | null, id: string | undefined, today: string, what: "running" | "newest"): Experiment {
  if (!file || file.experiments.length === 0) throw new Error("no experiment yet: start one with start_experiment");
  if (id !== undefined) {
    const e = file.experiments.find((x) => x.id === id);
    if (!e) throw new Error(`no experiment ${id}`);
    return e;
  }
  if (what === "newest") return [...file.experiments].sort((a, b) => idNumber(b.id) - idNumber(a.id))[0];
  const running = file.experiments.filter((e) => statusOf(e, today) === "running");
  if (running.length !== 1) throw new Error(running.length === 0 ? "no experiment is running today: pass id" : `${running.length} experiments are running: pass id`);
  return running[0];
}

export function logExperimentDay(args: unknown, store: ExperimentStore, deps: { now?: Date } = {}) {
  return queue(async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    onlyKeys(args, ["id", "date", "followed", "note"], "");
    const now = deps.now ?? new Date();
    const today = localDate(0, now);
    const id = text(args.id, "id", 20);
    const d = date(args.date, "date") ?? today;
    if (typeof args.followed !== "boolean") throw new Error("followed is required and must be true or false");
    const note = text(args.note, "note", MAX_TEXT);
    const file = await store.load();
    const e = pick(file, id, today, "running");
    if (e.stopped) throw new Error(`${e.id} was stopped on ${e.stopped.date}: days can no longer be logged`);
    if (d > today) throw new Error(`date (${d}) is in the future: log what happened, not what will`);
    const day = e.schedule.find((s) => s.date === d);
    if (!day) throw new Error(`${d} is outside ${e.id}'s days (${e.startDate}..${e.endDate})`);
    if (day.block === undefined) throw new Error(`nothing was assigned on ${d} (${day.arm}): only intervention and control days are logged`);
    const previous = e.log[d];
    if (previous && previous.followed === args.followed && previous.note === note) return { id: e.id, date: d, arm: day.arm, saved: previous, changed: false };
    const entry: DayLog = defined({ followed: args.followed, note, loggedAt: now.toISOString(), earlier: previous ? [...(previous.earlier ?? []), { followed: previous.followed, ...(previous.note !== undefined ? { note: previous.note } : {}), loggedAt: previous.loggedAt }] : undefined });
    await store.save({ experiments: file!.experiments.map((x) => (x.id === e.id ? { ...x, log: { ...x.log, [d]: entry } } : x)) });
    return { id: e.id, date: d, arm: day.arm, saved: entry, changed: true };
  });
}

// ---------- stop ----------

export function stopExperiment(args: unknown, store: ExperimentStore, deps: { now?: Date } = {}) {
  return queue(async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    onlyKeys(args, ["id", "reason"], "");
    const id = text(args.id, "id", 20, true)!;
    const reason = text(args.reason, "reason", MAX_TEXT, true)!;
    const now = deps.now ?? new Date();
    const today = localDate(0, now);
    const file = await store.load();
    const e = file?.experiments.find((x) => x.id === id);
    if (!file || !e) throw new Error(`no experiment ${id}`);
    if (e.stopped) return { id, stopped: e.stopped, alreadyStopped: true };
    if (today > e.endDate) throw new Error(`${id} has already finished (${e.endDate}): analyze it instead`);
    const stopped = { at: now.toISOString(), date: today, reason };
    await store.save({ experiments: file.experiments.map((x) => (x.id === id ? { ...x, stopped } : x)) });
    return { id, stopped, alreadyStopped: false, note: "Stopped. The schedule and the log are kept; analyze_experiment still reads what was logged, flagged exploratory." };
  });
}

// ---------- analysis ----------

const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);
export const medianOf = (xs: number[]): number | null => (xs.length ? quantile(asc(xs), 0.5) : null);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface Block {
  days: { arm: "intervention" | "control"; value: number | null }[]; // the two days of a pair
}

// Two-sided permutation test of (median intervention - median control) over the pairs: flipping a pair swaps which of its
// two days counts as intervention. Pairs with no value at all cannot change the statistic and are left out; the rest are
// "informative". Exact when there are at most EXACT_MAX_BLOCKS of them, else PERMUTATION_DRAWS random flips with the fixed seed
// (p = (hits + 1) / (draws + 1)). A flip that leaves an arm empty has no statistic and counts as at least as extreme.
export function permutationTest(blocks: Block[]) {
  const live = blocks.filter((b) => b.days.some((d) => d.value !== null));
  const stat = (flip: (j: number) => boolean) => {
    const i: number[] = [];
    const c: number[] = [];
    live.forEach((b, j) => {
      const swap = flip(j);
      for (const d of b.days) if (d.value !== null) ((d.arm === "intervention") !== swap ? i : c).push(d.value);
    });
    const [mi, mc] = [medianOf(i), medianOf(c)];
    return mi === null || mc === null ? null : mi - mc;
  };
  const observed = stat(() => false);
  const k = live.length;
  if (observed === null) return { p: null, method: "none" as const, permutations: 0, blocks: k };
  const extreme = (t: number | null) => t === null || Math.abs(t) >= Math.abs(observed) - EPS;
  if (k <= EXACT_MAX_BLOCKS) {
    let count = 0;
    for (let mask = 0; mask < 2 ** k; mask++) if (extreme(stat((j) => (mask >> j) % 2 === 1))) count++;
    return { p: count / 2 ** k, method: "exact" as const, permutations: 2 ** k, blocks: k };
  }
  const rng = mulberry32(PERMUTATION_SEED);
  let count = 0;
  for (let n = 0; n < PERMUTATION_DRAWS; n++) {
    const flips = Array.from({ length: k }, () => rng() < 0.5);
    if (extreme(stat((j) => flips[j]))) count++;
  }
  return { p: (count + 1) / (PERMUTATION_DRAWS + 1), method: "monte-carlo" as const, permutations: PERMUTATION_DRAWS, blocks: k };
}

type Client = Pick<SuuntoClient, "listSleep" | "listRecovery">;
const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);
const groupBy = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};

// 'insufficient' below MIN_NIGHTS_PER_ARM nights with a value in either arm; otherwise a difference is reported only when the
// permutation p-value is at most ALPHA AND the median difference is larger than the noise threshold (compared as printed;
// equal is not larger).
export function verdictOf(nIntervention: number, nControl: number, diff: number | null, threshold: number | null, p: number | null) {
  if (nIntervention < MIN_NIGHTS_PER_ARM || nControl < MIN_NIGHTS_PER_ARM || diff === null || threshold === null || p === null) return "insufficient" as const;
  return p <= ALPHA && Math.abs(diff) > threshold ? (diff > 0 ? ("intervention-higher" as const) : ("intervention-lower" as const)) : ("no-clear-difference" as const);
}

function summaryOf(e: Experiment, blocks: Block[], missing: { intervention: number; control: number }, round: (n: number) => number) {
  const values = (arm: "intervention" | "control") => blocks.flatMap((b) => b.days).filter((d) => d.arm === arm && d.value !== null).map((d) => d.value as number);
  const [vi, vc] = [values("intervention"), values("control")];
  const [mi, mc] = [medianOf(vi), medianOf(vc)];
  const diff = mi === null || mc === null ? null : round(mi - mc);
  const threshold = vi.length && vc.length ? round(thresholdOf(vc, vi.length)!) : null;
  const test = permutationTest(blocks);
  const verdict = verdictOf(vi.length, vc.length, diff, threshold, test.p);
  const se = threshold === null ? null : threshold / SE_K;
  return {
    nIntervention: vi.length,
    nControl: vc.length,
    interventionMedian: mi === null ? null : round(mi),
    controlMedian: mc === null ? null : round(mc),
    medianDiff: diff,
    meanDiff: vi.length && vc.length ? round(mean(vi)! - mean(vc)!) : null,
    noiseThreshold: threshold,
    effectInStandardErrors: diff !== null && se !== null && se > 0 ? Math.round((Math.abs(diff) / se) * 100) / 100 : null,
    pValue: test.p === null ? null : Math.round(test.p * 10_000) / 10_000,
    test: { method: test.method, permutations: test.permutations, informativePairs: test.blocks },
    missingNights: missing,
    verdict,
  };
}

export async function analyzeExperiment(client: Client, store: ExperimentStore, opts: { id?: string; early?: boolean } = {}, deps: { now?: Date } = {}) {
  const now = deps.now ?? new Date();
  const today = localDate(0, now);
  const file = await store.load();
  const e = pick(file, opts.id, today, "newest");
  const observable = addDays(today, -NIGHT_DELAY_DAYS); // the last assigned day whose night is recorded and synced
  let exploratory: string | null = null;
  let through = e.endDate;
  if (e.stopped) {
    through = e.stopped.date < through ? e.stopped.date : through;
    exploratory = `stopped on ${e.stopped.date} (${e.stopped.reason}), before the planned end ${e.endDate}`;
  } else if (today < addDays(e.endDate, NIGHT_DELAY_DAYS)) {
    if (opts.early !== true) throw new Error(`${e.id} ends on ${e.endDate}: the night after its last day is not recorded before ${addDays(e.endDate, NIGHT_DELAY_DAYS)}. Analyze then, or pass early: true for an exploratory look`);
    exploratory = `an early look before the planned end ${e.endDate}; not the pre-registered analysis`;
  }
  if (through > observable) through = observable;
  if (through < e.startDate) throw new Error(`${e.id} has no night to analyse yet: its first day is ${e.startDate}`);

  const m = METRICS.find((x) => x.name === e.metric)!;
  const needsRecovery = e.metric === "recoveryMorning";
  const [sleepRes, recoveryRes] = await Promise.all([
    client.listSleep(e.startDate, through),
    needsRecovery ? client.listRecovery(addDays(e.startDate, 1), addDays(through, 1)) : Promise.resolve(null),
  ]);
  const nights = groupBy(rowsOf(sleepRes), (r) => nightOf(r) ?? "");
  const recovery = recoveryRes === null ? null : groupBy(rowsOf(recoveryRes), rowDate);
  // the night after day D is filed under D and leads into D + 1
  const valueOf = (d: string): number | null => (nightMetrics(nights.get(d) ?? [], recovery === null ? [] : recovery.get(addDays(d, 1)) ?? []) as Record<string, number | null>)[e.metric];

  const byBlock = new Map<number, { arm: "intervention" | "control"; date: string }[]>();
  for (const s of trialDays(e)) byBlock.set(s.block!, [...(byBlock.get(s.block!) ?? []), { arm: s.arm as "intervention" | "control", date: s.date }]);
  const analyse = (include: (date: string) => boolean) => {
    const missing = { intervention: 0, control: 0 };
    const blocks: Block[] = [...byBlock.values()].map((pair) => ({
      days: pair.map((d) => {
        if (d.date > through || !include(d.date)) return { arm: d.arm, value: null };
        const v = valueOf(d.date);
        if (v === null) missing[d.arm]++;
        return { arm: d.arm, value: v };
      }),
    }));
    return summaryOf(e, blocks, missing, m.round);
  };
  const assigned = trialDays(e).filter((s) => s.date <= through);
  const adherence = {
    trialDays: assigned.length,
    logged: assigned.filter((s) => e.log[s.date]).length,
    followed: assigned.filter((s) => e.log[s.date]?.followed === true).length,
    notFollowed: assigned.filter((s) => e.log[s.date]?.followed === false).length,
    notLogged: assigned.filter((s) => !e.log[s.date]).length,
  };
  const itt = analyse(() => true);
  const pp = analyse((d) => e.log[d]?.followed === true);

  const noun = label(e.metric);
  const direction = itt.medianDiff === null ? "" : itt.medianDiff > 0 ? "higher" : itt.medianDiff < 0 ? "lower" : "the same";
  const statement =
    itt.verdict === "insufficient"
      ? `Not enough nights for a verdict: ${itt.nIntervention} intervention and ${itt.nControl} control nights have a ${noun} value, and at least ${MIN_NIGHTS_PER_ARM} of each are needed. Nothing is claimed.`
      : itt.verdict === "no-clear-difference"
        ? `No clear difference in ${noun}: the median after intervention days was ${itt.medianDiff} ${direction === "the same" ? "" : `${direction} `}than after control days (p = ${itt.pValue}; it needs p <= ${ALPHA} and a difference above ${itt.noiseThreshold}). That does not show there is no effect, only that this experiment did not detect one.`
        : `Median ${noun} after intervention days was ${Math.abs(itt.medianDiff!)} ${direction} than after control days (p = ${itt.pValue}, ${itt.nIntervention} vs ${itt.nControl} nights, intention to treat).`;
  return {
    id: e.id,
    name: e.name,
    metric: e.metric,
    today,
    status: statusOf(e, today),
    exploratory: exploratory !== null,
    exploratoryReason: exploratory,
    window: { from: e.startDate, through, plannedEnd: e.endDate },
    hypothesis: e.hypothesis,
    verdict: itt.verdict,
    statement: exploratory ? `Exploratory (${exploratory}). ${statement}` : statement,
    intentionToTreat: itt,
    perProtocol: { ...pp, note: "Only days logged as followed; a day without a log is left out. Who follows the plan is not randomized, so this comparison is not protected by the randomization." },
    adherence,
    randomized: "Which of the two days of each pair got the intervention and which the control: drawn by a seeded random generator before the start. That is what the p-value rests on.",
    notControlled: [
      "Everything else that differs between days: what you ate and drank, stress, illness, training load, travel, the weather. Pairing and randomization make them even out on average; they do not remove them.",
      "You knew which arm you were in (no blinding), so expectation can move the outcome and can move how faithfully you followed it.",
      "Nights are not independent: one night carries into the next, and a washout of the planned length may not be enough.",
      "The metric is the watch's estimate of the night, not a measurement of sleep itself.",
      "A night with no value is left out of both arms: if missing nights depend on the arm (a bad night not recorded), the comparison is biased.",
    ],
    thresholds: {
      minNightsPerArm: MIN_NIGHTS_PER_ARM,
      alpha: ALPHA,
      noiseRule: `|median difference| > ${SE_K} * 1.25 * (IQR of the control nights / 1.35) * sqrt(1/nIntervention + 1/nControl): the noise scale get_tag_effects uses (calibrated there for 15+ nights per group; here it only adds a size guard to the permutation test)`,
      test: `two-sided permutation test over the pairs; exact up to ${EXACT_MAX_BLOCKS} informative pairs, else ${PERMUTATION_DRAWS} draws with seed ${PERMUTATION_SEED}`,
    },
    notes: ["A night after a day is recorded from the second day after it, so days newer than that are not read yet.", ...(e.washout > 0 ? [`Washout days (${e.washout} after each intervention day) are never analysed.`] : [])],
  };
}
