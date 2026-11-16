// The approval queue: the safe form of "autonomy". A prepared change (an adjusted strength guide, or a week of guides) is
// stored in a local file, ~/.suunto-mcp/approvals.json (SUUNTO_APPROVALS_PATH), and nothing is ever pushed to the watch
// unless the user says yes in a call of resolve_approval that carries decision "approve" AND push: true. That call is the
// ONE place where a yes becomes a push; queue_adjustment, list_approvals, propose_next_week and adjust_guide never push.
// Same local-state conventions as the other files (local-store.ts): version 1, strict parser, atomic write, 0600/0700, a
// damaged / foreign / newer file is refused and left untouched; demo mode keeps it in memory and never calls the push path.
import { homedir } from "node:os";
import { join } from "node:path";
import { localDate } from "./api.js";
import { buildStrengthGuideZip, type StrengthPlan } from "./guide-zip.js";
import { fileDocStore, memoryDocStore, serialQueue, type DocStore } from "./local-store.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { planWeek, type WeekPlanResult } from "./week-plan.js";

export const KINDS = ["adjusted_guide", "week_plan"] as const;
export type Kind = (typeof KINDS)[number];
export const MAX_APPROVALS = 1000;
export const MAX_REASONS = 20;
export const MAX_TEXT = 500;
export const MAX_SOURCE = 64;
export const MAX_PAYLOAD_CHARS = 200_000;

export interface Resolution {
  decision: "approve" | "reject";
  at: string;
  note?: string;
  pushed: boolean; // a real push was made (a dry run is not one)
  pushResult?: unknown;
}
export interface Approval {
  id: string;
  createdAt: string;
  forDate: string;
  kind: Kind;
  payload: Record<string, unknown>; // adjusted_guide: push_strength_guide's arguments; week_plan: push_week_plan's { guides }
  reasons: string[];
  source: string;
  expiresAt: string;
  resolution?: Resolution;
}
export interface ApprovalsFile {
  approvals: Approval[];
}
export type ApprovalStore = DocStore<ApprovalsFile>;

export const approvalsPath = (): string => process.env.SUUNTO_APPROVALS_PATH ?? join(homedir(), ".suunto-mcp", "approvals.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
function onlyKeys(o: Record<string, unknown>, allowed: string[], at: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Error(`${at}${extra} is not a known field (allowed here: ${allowed.join(", ")})`);
}
function str(v: unknown, path: string, max: number, required = false): string | undefined {
  if (v === undefined) {
    if (required) throw new Error(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`${path} must be a string`);
  if (v.length > max) throw new Error(`${path} must be at most ${max} characters`);
  if (required && v.trim() === "") throw new Error(`${path} must not be empty`);
  return v;
}
const stamp = (v: unknown, path: string): string => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new Error(`${path} must be an ISO 8601 date-time`);
  return new Date(Date.parse(v)).toISOString();
};
const calendarDate = (v: unknown, path: string): string => {
  if (typeof v !== "string" || !isValidCalendarDate(v)) throw new Error(`${path} must be a calendar date YYYY-MM-DD`);
  return v;
};

// ---------- the file ----------

function parseApproval(v: unknown, i: number): Approval {
  const at = `approvals[${i}]`;
  if (!isObject(v)) throw new Error(`${at} must be an object`);
  onlyKeys(v, ["id", "createdAt", "forDate", "kind", "payload", "reasons", "source", "expiresAt", "resolution"], `${at}.`);
  if (typeof v.id !== "string" || !/^a\d+$/.test(v.id)) throw new Error(`${at}.id must look like a12`);
  if (!(KINDS as readonly string[]).includes(v.kind as string)) throw new Error(`${at}.kind must be one of: ${KINDS.join(", ")}`);
  if (!isObject(v.payload)) throw new Error(`${at}.payload must be an object`);
  if (!Array.isArray(v.reasons) || v.reasons.some((r) => typeof r !== "string")) throw new Error(`${at}.reasons must be a list of strings`);
  const a: Approval = {
    id: v.id,
    createdAt: stamp(v.createdAt, `${at}.createdAt`),
    forDate: calendarDate(v.forDate, `${at}.forDate`),
    kind: v.kind as Kind,
    payload: v.payload,
    reasons: v.reasons as string[],
    source: str(v.source, `${at}.source`, MAX_SOURCE, true)!,
    expiresAt: stamp(v.expiresAt, `${at}.expiresAt`),
  };
  if (v.resolution !== undefined) {
    const r = v.resolution;
    if (!isObject(r)) throw new Error(`${at}.resolution must be an object`);
    onlyKeys(r, ["decision", "at", "note", "pushed", "pushResult"], `${at}.resolution.`);
    if (r.decision !== "approve" && r.decision !== "reject") throw new Error(`${at}.resolution.decision must be approve or reject`);
    if (typeof r.pushed !== "boolean") throw new Error(`${at}.resolution.pushed must be a boolean`);
    a.resolution = defined<Resolution>({ decision: r.decision, at: stamp(r.at, `${at}.resolution.at`), note: str(r.note, `${at}.resolution.note`, MAX_TEXT), pushed: r.pushed, pushResult: r.pushResult });
  }
  return a;
}

export function parseApprovals(raw: Record<string, unknown>): ApprovalsFile {
  onlyKeys(raw, ["version", "approvals"], "");
  if (!Array.isArray(raw.approvals)) throw new Error("approvals must be an array");
  if (raw.approvals.length > MAX_APPROVALS) throw new Error(`approvals can have at most ${MAX_APPROVALS} items`);
  const approvals = raw.approvals.map(parseApproval);
  if (new Set(approvals.map((a) => a.id)).size !== approvals.length) throw new Error("approvals has an id twice");
  return { approvals };
}

export const memoryApprovalStore = (): ApprovalStore => memoryDocStore<ApprovalsFile>();
export const fileApprovalStore = (path = approvalsPath()): ApprovalStore => fileDocStore(path, "approvals", parseApprovals);

// ---------- status ----------

export type Status = "pending" | "expired" | "approved" | "rejected";
// Expired: not resolved and `now` is after expiresAt (at expiresAt itself it is still pending).
export function statusOf(a: Approval, now: Date): Status {
  if (a.resolution) return a.resolution.decision === "approve" ? "approved" : "rejected";
  return now.getTime() > Date.parse(a.expiresAt) ? "expired" : "pending";
}
const endOfDay = (forDate: string): string => {
  const [y, m, d] = forDate.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
};
const nextId = (all: Approval[]): string => `a${Math.max(0, ...all.map((a) => Number(a.id.slice(1)))) + 1}`;

// ---------- queue_adjustment ----------

export interface QueueDeps {
  now?: Date;
  validate: (guide: unknown) => string[]; // push_strength_guide's own input schema
}

// The push tool's own checks, dry-run style: the schema, then building the guide (as the push does) without sending it.
async function checkPayload(kind: Kind, payload: Record<string, unknown>, validate: QueueDeps["validate"]): Promise<{ dates: string[] }> {
  if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) throw new Error(`payload must be at most ${MAX_PAYLOAD_CHARS} characters as JSON`);
  if (kind === "adjusted_guide") {
    if (payload.guideId !== undefined) throw new Error("payload.guideId is not allowed: an approval only creates a new guide (a guideId would overwrite an existing one; use push_strength_guide for that).");
    const errors = validate(payload);
    if (errors.length) throw new Error(`payload is not a valid push_strength_guide spec: ${errors.join("; ")}`);
    try {
      buildStrengthGuideZip(payload as unknown as StrengthPlan, "dry-run");
    } catch (err: any) {
      throw new Error(`payload cannot be built as a strength guide: ${err.message ?? err}`);
    }
    return { dates: [payload.date as string] };
  }
  onlyKeys(payload, ["guides"], "payload.");
  // push_week_plan's own dry run: schema, unique dates, no guideId, every guide built; it never calls push
  await planWeek(payload.guides, {
    dryRun: true,
    appName: undefined,
    validate,
    push: async () => {
      throw new Error("a dry run pushes nothing");
    },
  });
  return { dates: (payload.guides as { date: string }[]).map((g) => g.date).sort() };
}

// ONE queue for every writer of approvals.json (queue_adjustment and resolve_approval, a push included): each call re-reads the file
// inside the queue, so a save can never erase what another call just wrote, and a second resolve of an item waits for the first
// and finds it resolved. A lock within this process only: two server processes writing within the same moments can still collide,
// as with the other local files (local-store.ts). A slow push holds the queue, so a queue_adjustment made meanwhile waits for it.
const writers = serialQueue();

export function queueAdjustment(args: unknown, store: ApprovalStore, deps: QueueDeps) {
  return writers(async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    onlyKeys(args, ["kind", "payload", "forDate", "reasons", "source", "expiresAt"], "");
    if (!(KINDS as readonly string[]).includes(args.kind as string)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
    const kind = args.kind as Kind;
    if (!isObject(args.payload)) throw new Error("payload must be an object (the arguments of the push tool: push_strength_guide for adjusted_guide, push_week_plan's { guides } for week_plan)");
    const checked = await checkPayload(kind, args.payload, deps.validate);
    const now = deps.now ?? new Date();
    const today = localDate(0, now);
    // a change is for the day of its guide (the earliest guide's for a week) and cannot outlive that day: an approval must not be pushable
    // after the day it was prepared for, or for a day that has already passed
    const forDate = checked.dates[0];
    if (args.forDate !== undefined && calendarDate(args.forDate, "forDate") !== forDate) {
      throw new Error(`forDate ${String(args.forDate)} must equal the payload's date ${forDate}${kind === "week_plan" ? " (the earliest guide's)" : ""}: leave forDate out to use it.`);
    }
    const past = checked.dates.find((d) => d < today);
    if (past !== undefined) throw new Error(`guide dated ${past} is before today (${today}): there is nothing to approve for a day that has passed.`);
    if (args.reasons !== undefined && (!Array.isArray(args.reasons) || args.reasons.length > MAX_REASONS || args.reasons.some((r) => typeof r !== "string" || r.length > MAX_TEXT))) {
      throw new Error(`reasons must be a list of at most ${MAX_REASONS} strings of at most ${MAX_TEXT} characters`);
    }
    const lastMoment = endOfDay(forDate);
    const expiresAt = args.expiresAt === undefined ? lastMoment : stamp(args.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) > Date.parse(lastMoment)) throw new Error(`expiresAt ${expiresAt} is after the end of ${forDate} (${lastMoment}): an approval cannot outlive the day it is for.`);
    if (now.getTime() > Date.parse(expiresAt)) throw new Error(`expiresAt ${expiresAt} has already passed.`);
    const file = (await store.load()) ?? { approvals: [] };
    if (file.approvals.length >= MAX_APPROVALS) throw new Error(`the queue holds ${MAX_APPROVALS} approvals already (nothing is deleted automatically): resolve some, or remove old ones from the file.`);
    const approval: Approval = {
      id: nextId(file.approvals),
      createdAt: now.toISOString(),
      forDate,
      kind,
      payload: structuredClone(args.payload),
      reasons: (args.reasons as string[] | undefined) ?? [],
      source: str(args.source, "source", MAX_SOURCE) ?? "manual",
      expiresAt,
    };
    await store.save({ approvals: [...file.approvals, approval] });
    return {
      queued: true,
      approval: summary(approval, now),
      note: "Local state only: nothing was sent to the watch. The user decides with resolve_approval (decision approve and push: true make the push; reject just records).",
    };
  });
}

// ---------- list_approvals ----------

// The dates of the guides in a payload.
const datesOf = (a: Approval): string[] => (a.kind === "adjusted_guide" ? [a.payload.date as string] : (a.payload.guides as { date: string }[]).map((g) => g.date));
const guidesOf = (a: Approval): unknown[] => (a.kind === "adjusted_guide" ? [a.payload] : (a.payload.guides as unknown[]));

// What to look at before deciding: the DRY-RUN form of the push (push_week_plan validates and sends nothing). A ready real push is never
// handed out; the one way to push is resolve_approval with decision approve and push: true, in the same call.
const callOf = (a: Approval) => ({ tool: "push_week_plan", arguments: { guides: guidesOf(a), dryRun: true } });
const howToPush = (a: Approval): string =>
  `The only way to push this is resolve_approval with { id: "${a.id}", decision: "approve", push: true }, when the user says to${a.kind === "week_plan" ? " (a week plan is a dry run until dryRun: false is added)" : ""}.`;

function summary(a: Approval, now: Date) {
  return { id: a.id, kind: a.kind, status: statusOf(a, now), forDate: a.forDate, source: a.source, createdAt: a.createdAt, expiresAt: a.expiresAt, reasons: a.reasons, resolution: a.resolution ?? null };
}

export const STATUS_FILTERS = ["pending", "expired", "done", "all"] as const;
// pending / expired / done (approved or rejected) with their reasons; with `id` the full item, payload and the call included.
export async function listApprovals(store: ApprovalStore, args: { status?: string; id?: string } = {}, now = new Date()) {
  const file = (await store.load()) ?? { approvals: [] };
  if (args.status !== undefined && !(STATUS_FILTERS as readonly string[]).includes(args.status)) throw new Error(`status must be one of: ${STATUS_FILTERS.join(", ")}`);
  const counts = { pending: 0, expired: 0, approved: 0, rejected: 0 };
  for (const a of file.approvals) counts[statusOf(a, now)]++;
  if (args.id !== undefined) {
    const a = file.approvals.find((x) => x.id === args.id);
    if (!a) throw new Error(`no approval ${args.id} (see list_approvals)`);
    return { now: now.toISOString(), counts, items: [{ ...summary(a, now), payload: a.payload, call: callOf(a), howToPush: howToPush(a) }], notes: [] };
  }
  const want = args.status ?? "all";
  const items = file.approvals
    .filter((a) => {
      const s = statusOf(a, now);
      return want === "all" || (want === "done" ? s === "approved" || s === "rejected" : s === want);
    })
    .map((a) => summary(a, now));
  return {
    now: now.toISOString(),
    counts,
    items,
    notes: [
      "pending: waiting for the user; expired: not decided before expiresAt and can no longer be approved (it can still be rejected); done: approved or rejected. Pass `id` for one item with its payload and the exact tool call.",
      "Nothing here pushes anything: only resolve_approval with decision approve and push: true does.",
    ],
  };
}

// For get_catchup: what is waiting, short.
export async function approvalsBrief(store: ApprovalStore, now = new Date()) {
  const file = (await store.load()) ?? { approvals: [] };
  const today = localDate(0, now);
  const pending = file.approvals.filter((a) => statusOf(a, now) === "pending");
  return {
    pending: pending.length,
    expired: file.approvals.filter((a) => statusOf(a, now) === "expired").length,
    items: pending.map((a) => ({ id: a.id, kind: a.kind, forDate: a.forDate, source: a.source, expiresAt: a.expiresAt, expiresToday: localDate(0, new Date(a.expiresAt)) === today })),
  };
}

// ---------- resolve_approval ----------

export interface PushDeps {
  demo: boolean; // demo mode: never calls the push path
  appName: string | undefined;
  validate: (guide: unknown) => string[];
  push: (zip: Buffer, title: string) => Promise<{ data: any; check: unknown }>; // the existing push path (always a new guide)
  now?: Date;
}


export interface ResolveResult {
  alreadyResolved: boolean;
  id: string;
  kind: Kind;
  decision: "approve" | "reject";
  resolvedAt: string;
  note: string | null;
  pushed: boolean;
  payload?: Record<string, unknown>;
  call?: { tool: string; arguments: Record<string, unknown> };
  pushResult?: unknown;
  howToPush?: string;
  notes: string[];
}

export function resolveApproval(args: unknown, store: ApprovalStore, deps: PushDeps): Promise<ResolveResult> {
  // One call at a time, the whole call: a second resolve of the same item waits for the first (push included) and then
  // finds it resolved, so a push never happens twice.
  return writers(async () => {
    if (!isObject(args)) throw new Error("arguments must be an object");
    onlyKeys(args, ["id", "decision", "note", "push", "dryRun"], "");
    const id = str(args.id, "id", 20, true)!;
    if (args.decision !== "approve" && args.decision !== "reject") throw new Error("decision must be approve or reject");
    const decision = args.decision;
    const note = str(args.note, "note", MAX_TEXT);
    if (args.push !== undefined && typeof args.push !== "boolean") throw new Error("push must be a boolean");
    if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") throw new Error("dryRun must be a boolean");
    const push = args.push === true;
    if (push && decision !== "approve") throw new Error("push: true needs decision approve in the same call: a push is only ever made on an explicit yes.");
    if (args.dryRun !== undefined && !push) throw new Error("dryRun only applies together with push: true.");
    const now = deps.now ?? new Date();
    const file = (await store.load()) ?? { approvals: [] };
    const a = file.approvals.find((x) => x.id === id);
    if (!a) throw new Error(`no approval ${id} (see list_approvals)`);
    if (args.dryRun !== undefined && a.kind !== "week_plan") throw new Error("dryRun applies to a week_plan approval only.");
    const status = statusOf(a, now);

    const base = (x: Approval, extra: { alreadyResolved: boolean; notes: string[] }): ResolveResult => ({
      id: x.id,
      kind: x.kind,
      decision: x.resolution!.decision,
      resolvedAt: x.resolution!.at,
      note: x.resolution!.note ?? null,
      pushed: x.resolution!.pushed,
      ...(x.resolution!.decision === "approve" ? { payload: x.payload, call: callOf(x), howToPush: howToPush(x) } : {}),
      ...(x.resolution!.pushResult !== undefined ? { pushResult: x.resolution!.pushResult } : {}),
      ...extra,
    });

    // already decided: the first answer again. The one thing still open on an approved item is the push itself, once.
    if (a.resolution && !(a.resolution.decision === "approve" && !a.resolution.pushed && push && decision === "approve")) {
      return base(a, { alreadyResolved: true, notes: ["This approval was resolved before; this is the first result and nothing was done again."] });
    }
    if (decision === "approve" && !a.resolution && status === "expired") {
      throw new Error(`approval ${id} expired at ${a.expiresAt} and cannot be approved: prepare it again (queue_adjustment with a fresh queuePayload from propose_next_week / adjust_guide).`);
    }
    // pushing an approved item after it expired is refused too
    if (push && now.getTime() > Date.parse(a.expiresAt)) {
      throw new Error(`approval ${id} expired at ${a.expiresAt} and cannot be pushed: prepare it again.`);
    }
    // a guide for a day that has passed is stale whatever the expiry says: approving or pushing it is refused (rejecting it is not)
    if (decision === "approve") {
      const today = localDate(0, now);
      const stale = datesOf(a).filter((d) => d < today).sort()[0];
      if (stale !== undefined) throw new Error(`approval ${id}: guide dated ${stale} is before today (${today}), so it cannot be approved or pushed: prepare it again.`);
    }

    let pushed = false;
    let pushResult: unknown;
    let notes: string[] = [];
    if (decision === "approve" && push) {
      if (deps.demo) {
        notes = ["Demo mode: nothing was pushed and nothing left this machine. With real credentials, push: true would push this exactly through the existing push path."];
      } else if (a.kind === "adjusted_guide") {
        if (!deps.appName) throw new Error("SUUNTO_APP_NAME is not set. Set it in the env block of your MCP client config with the exact app name registered on apizone.suunto.com.");
        const errors = deps.validate(a.payload);
        if (errors.length) throw new Error(`the stored payload no longer passes push_strength_guide's validation: ${errors.join("; ")}`);
        const p = a.payload as unknown as StrengthPlan;
        const zip = buildStrengthGuideZip({ title: p.title, date: p.date, exercises: p.exercises, restMode: p.restMode, lapGranularity: p.lapGranularity }, deps.appName);
        const { data, check } = await deps.push(zip, p.title);
        pushed = true;
        pushResult = { id: data?.id ?? null, check };
        notes = ["Pushed. It should appear on the watch after the phone's next normal Suunto app sync."];
      } else {
        const dryRun = args.dryRun !== false;
        const result: WeekPlanResult = await planWeek(a.payload.guides, { dryRun, appName: deps.appName, validate: deps.validate, push: deps.push });
        pushResult = result;
        if (dryRun) notes = ["Dry run only (the default): nothing was pushed. Call again with push: true and dryRun: false to push."];
        else {
          // even a partial push counts as a push: trying again would duplicate the days that went through
          pushed = (result.pushed?.length ?? 0) > 0 || result.ok;
          notes = result.ok ? ["Pushed one new guide per date."] : ["The push stopped at a failure (see pushResult: pushed, failed, notPushed). It is NOT retried automatically, since the days already pushed would be duplicated."];
        }
      }
    }

    // a dry run decides nothing about the push: the approval is recorded, the real push is still open
    const resolution: Resolution = a.resolution ?? defined({ decision, at: now.toISOString(), note, pushed, pushResult });
    if (a.resolution) {
      resolution.pushed = pushed || resolution.pushed;
      if (pushResult !== undefined) resolution.pushResult = pushResult;
    }
    const next: Approval = { ...a, resolution };
    await store.save({ approvals: file.approvals.map((x) => (x.id === id ? next : x)) });
    const extra = { alreadyResolved: false, notes: notes.length ? notes : decision === "reject" ? ["Recorded. Nothing was pushed."] : ["Approved. Nothing was pushed: call resolve_approval again with push: true, or make the call below yourself."] };
    return base(next, extra);
  });
}
