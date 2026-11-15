// set_plan / get_plan: the training plan as local state (goal, phases, a planned session per date), kept in a
// file next to the tokens. It never touches Suunto and never pushes anything to the watch: pushing stays with
// push_week_plan / push_strength_guide. In demo mode the same code runs on an in-memory store.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { localDate } from "./api.js";
import { isValidCalendarDate } from "./schema-validate.js";

export interface PlanPhase {
  name: string;
  from: string;
  to: string;
  focus?: string;
}
export interface PlanSession {
  date: string;
  title: string;
  guide?: Record<string, unknown>; // a push_strength_guide spec; stored, never pushed
}
export interface Plan {
  goal: string;
  start?: string;
  end?: string;
  phases: PlanPhase[];
  sessions: PlanSession[]; // sorted by date, one per date
}

export const MAX_TEXT = 500;
export const MAX_NAME = 100;
export const MAX_PHASES = 20;
export const MAX_SESSIONS = 200;
export const MAX_GUIDE_CHARS = 8000;

export const planPath = (): string => process.env.SUUNTO_PLAN_PATH ?? join(homedir(), ".suunto-mcp", "plan.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: string[], path: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Error(`${path}${extra} is not a known field (allowed here: ${allowed.join(", ")})`);
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

function date(v: unknown, path: string, required = false): string | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "string" || !isValidCalendarDate(v)) throw new Error(`${path} must be a calendar date YYYY-MM-DD`);
  return v;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function parsePhases(v: unknown): PlanPhase[] {
  if (!Array.isArray(v)) throw new Error("phases must be an array");
  if (v.length > MAX_PHASES) throw new Error(`phases can have at most ${MAX_PHASES} items`);
  return v.map((p, i) => {
    const at = `phases[${i}]`;
    if (!isObject(p)) throw new Error(`${at} must be an object`);
    onlyKeys(p, ["name", "from", "to", "focus"], `${at}.`);
    const phase = defined({ name: text(p.name, `${at}.name`, MAX_NAME, true)!, from: date(p.from, `${at}.from`, true)!, to: date(p.to, `${at}.to`, true)!, focus: text(p.focus, `${at}.focus`, MAX_TEXT) });
    if (phase.from > phase.to) throw new Error(`${at}.from (${phase.from}) must be on or before to (${phase.to})`);
    return phase;
  });
}

function parseSessions(v: unknown): PlanSession[] {
  if (!Array.isArray(v)) throw new Error("sessions must be an array");
  if (v.length > MAX_SESSIONS) throw new Error(`sessions can have at most ${MAX_SESSIONS} items`);
  const seen = new Set<string>();
  return v.map((s, i) => {
    const at = `sessions[${i}]`;
    if (!isObject(s)) throw new Error(`${at} must be an object`);
    onlyKeys(s, ["date", "title", "guide"], `${at}.`);
    const d = date(s.date, `${at}.date`, true)!;
    if (seen.has(d)) throw new Error(`${at}.date ${d} is listed more than once: one session per date`);
    seen.add(d);
    const session: PlanSession = { date: d, title: text(s.title, `${at}.title`, MAX_NAME, true)! };
    if (s.guide !== undefined) {
      if (!isObject(s.guide)) throw new Error(`${at}.guide must be an object (a push_strength_guide spec)`);
      if (JSON.stringify(s.guide).length > MAX_GUIDE_CHARS) throw new Error(`${at}.guide must be at most ${MAX_GUIDE_CHARS} characters as JSON`);
      if (s.guide.date !== undefined && s.guide.date !== d) throw new Error(`${at}.guide.date (${String(s.guide.date)}) must equal the session date ${d}`);
      session.guide = s.guide;
    }
    return session;
  });
}

// Whole-plan consistency; shared by set_plan's result and by a plan read back from the file.
function checkPlan(plan: Plan): Plan {
  if (plan.start && plan.end && plan.start > plan.end) throw new Error(`start (${plan.start}) must be on or before end (${plan.end})`);
  for (const s of plan.sessions) {
    if ((plan.start && s.date < plan.start) || (plan.end && s.date > plan.end)) throw new Error(`session ${s.date} lies outside the plan's start..end`);
  }
  if (plan.sessions.length > MAX_SESSIONS) throw new Error(`a plan can have at most ${MAX_SESSIONS} sessions`);
  plan.sessions.sort((a, b) => a.date.localeCompare(b.date));
  return plan;
}

// A plan as stored (the file's `plan` object): every field checked, unknown fields refused.
export function parsePlan(raw: unknown): Plan {
  if (!isObject(raw)) throw new Error("plan must be an object");
  onlyKeys(raw, ["goal", "start", "end", "phases", "sessions"], "plan.");
  return checkPlan(
    defined({
      goal: text(raw.goal, "goal", MAX_TEXT, true)!,
      start: date(raw.start, "start"),
      end: date(raw.end, "end"),
      phases: parsePhases(raw.phases),
      sessions: parseSessions(raw.sessions),
    }),
  );
}

// ---------- stores ----------

export interface StoredPlan {
  updatedAt: string;
  plan: Plan;
}
export interface PlanStore {
  load(): Promise<StoredPlan | null>;
  save(stored: StoredPlan): Promise<void>;
}

// Demo mode: nothing reaches the disk, and nothing outlives the server process.
export function memoryPlanStore(): PlanStore {
  let held: StoredPlan | null = null;
  return { load: async () => (held ? structuredClone(held) : null), save: async (s) => void (held = structuredClone(s)) };
}

// A missing file is no plan; an unreadable, damaged or other-version one throws, so set_plan can never overwrite what it cannot read.
export function filePlanStore(path = planPath()): PlanStore {
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
      if (!isObject(file) || !isObject(file.plan)) throw new Error(`${path} is not a suunto-mcp plan; fix or delete it`);
      if (file.version !== 1) throw new Error(`${path} is plan version ${JSON.stringify(file.version) ?? "unknown"}, but this server reads and writes version 1 only; it is left untouched`);
      try {
        return { updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : "", plan: parsePlan(file.plan) };
      } catch (err: any) {
        throw new Error(`${path} holds an invalid plan (${err.message}); fix or delete it`);
      }
    },
    async save(stored) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        await writeFile(tmp, JSON.stringify({ version: 1, ...stored }, null, 2), { encoding: "utf8", mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
  };
}

// ---------- set_plan ----------

// The guide spec is checked against push_strength_guide's schema where the tool's arguments are (index.ts); here it is only
// stored, with a size cap and its date matched to the session's.
export interface SetPlanDeps {
  now?: Date;
}

const summary = (p: Plan) => ({ goal: p.goal, start: p.start ?? null, end: p.end ?? null, phases: p.phases.length, sessions: p.sessions.length });

// Calls run one after the other, and the store is read inside the call right before the write, so a merge
// is made on what is stored now. Not a lock between processes: two writes within the same few milliseconds can collide.
let queue: Promise<unknown> = Promise.resolve();

// mode "replace" (default): the call IS the plan (goal required; start, end, phases and sessions left out are empty).
// mode "merge": goal, start, end and phases replace the stored ones when given; sessions are merged by date (a given
// date replaces that day's session, the others stay).
export function setPlan(args: unknown, store: PlanStore, deps: SetPlanDeps = {}) {
  const run = async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    onlyKeys(args, ["goal", "start", "end", "phases", "sessions", "mode"], "");
    const mode = args.mode ?? "replace";
    if (mode !== "replace" && mode !== "merge") throw new Error('mode must be "replace" or "merge"');
    const given = {
      goal: text(args.goal, "goal", MAX_TEXT, mode === "replace"),
      start: date(args.start, "start"),
      end: date(args.end, "end"),
      phases: args.phases === undefined ? undefined : parsePhases(args.phases),
      sessions: args.sessions === undefined ? undefined : parseSessions(args.sessions),
    };
    const previous = await store.load();
    let next: Plan;
    const replacedDates: string[] = [];
    if (mode === "replace") {
      next = defined({ goal: given.goal!, start: given.start, end: given.end, phases: given.phases ?? [], sessions: given.sessions ?? [] });
    } else {
      if (Object.values(given).every((v) => v === undefined)) throw new Error("nothing to set: give a goal, start, end, phases or sessions");
      if (!previous && given.goal === undefined) throw new Error("there is no plan yet: a first call needs a goal");
      const base: Plan = previous?.plan ?? { goal: "", phases: [], sessions: [] };
      const byDate = new Map(base.sessions.map((s) => [s.date, s]));
      for (const s of given.sessions ?? []) {
        if (byDate.has(s.date)) replacedDates.push(s.date);
        byDate.set(s.date, s);
      }
      next = defined({
        goal: given.goal ?? base.goal,
        start: given.start ?? base.start,
        end: given.end ?? base.end,
        phases: given.phases ?? base.phases,
        sessions: [...byDate.values()],
      });
    }
    checkPlan(next);
    await store.save({ updatedAt: (deps.now ?? new Date()).toISOString(), plan: next });
    return { saved: true, mode, plan: summary(next), replacedDates: replacedDates.sort(), previous: previous ? summary(previous.plan) : null, note: "Local state only: nothing was sent to the watch. Push sessions with push_week_plan or push_strength_guide." };
  };
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

// ---------- get_plan ----------

const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const brief = (s: PlanSession | undefined) => (s ? { date: s.date, title: s.title, hasGuide: s.guide !== undefined } : null);
const phaseOn = (p: Plan, d: string) => p.phases.find((x) => x.from <= d && d <= x.to) ?? null;

export const planSessionOn = (plan: Plan, d: string): PlanSession | undefined => plan.sessions.find((s) => s.date === d);

// No `date`: the plan (session list without guide bodies), today's full session and the 7 days after today.
// With `date`: that day's full session (with its guide) and phase.
export async function getPlan(store: PlanStore, args: { date?: string } = {}, now = new Date()) {
  const stored = await store.load();
  const today = localDate(0, now);
  if (!stored) return { today, plan: null, note: "No plan yet: set one with set_plan." };
  const { plan } = stored;
  const header = { goal: plan.goal, start: plan.start ?? null, end: plan.end ?? null, updatedAt: stored.updatedAt };
  if (args.date !== undefined) {
    if (!isValidCalendarDate(args.date)) throw new Error(`"${args.date}" is not a valid calendar date (YYYY-MM-DD).`);
    return { today, ...header, date: args.date, phase: phaseOn(plan, args.date), session: planSessionOn(plan, args.date) ?? null };
  }
  return {
    today,
    plan: { ...header, phases: plan.phases, sessions: plan.sessions.map((s) => brief(s)) },
    currentPhase: phaseOn(plan, today),
    todaySession: planSessionOn(plan, today) ?? null,
    // the 7 days after today; a day without a session is a rest day (session: null)
    next7Days: Array.from({ length: 7 }, (_, i) => plusDays(today, i + 1)).map((d) => ({ date: d, session: brief(planSessionOn(plan, d)) })),
  };
}
