import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_APPROVALS, approvalsBrief, fileApprovalStore, listApprovals, memoryApprovalStore, parseApprovals, queueAdjustment, resolveApproval, statusOf, type Approval, type ApprovalStore } from "./approvals.js";

const NOW = new Date(2026, 10, 13, 20, 0, 0); // Friday 2026-11-13, machine-local
const guide = (date: string, title = "PUSH A") => ({ title, date, exercises: [{ name: "Bench Press", detail: "70kg 3x8", sets: 3, restSec: 90 }] });
// push_strength_guide's schema, as far as these tests need it
const validate = (g: unknown): string[] => {
  const o = g as any;
  return typeof o?.title === "string" && typeof o?.date === "string" && Array.isArray(o?.exercises) && o.exercises.length > 0 ? [] : ["guide: title, date and exercises are required"];
};
const q = (args: unknown, store: ApprovalStore, now = NOW) => queueAdjustment(args, store, { now, validate });
const one = (over: Record<string, unknown> = {}) => ({ kind: "adjusted_guide", payload: guide("2026-11-16"), reasons: ["HRV below band"], source: "adjust_guide", ...over });

// a push path that records its calls
function pusher(over: { fail?: (n: number) => boolean; appName?: string | undefined; demo?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      demo: over.demo ?? false,
      appName: "appName" in over ? over.appName : "my-app",
      validate,
      now: NOW,
      push: async (_zip: Buffer, title: string) => {
        calls.push(title);
        if (over.fail?.(calls.length)) throw new Error("Suunto answered 500");
        return { data: { id: `g${calls.length}` }, check: { verified: true } };
      },
    },
  };
}
const resolve = (args: unknown, store: ApprovalStore, p = pusher()) => resolveApproval(args, store, p.deps);

// ---------- queue_adjustment ----------

test("queueAdjustment: stores the exact payload with id, createdAt, forDate, reasons, source and an expiry at the end of forDate; nothing is pushed", async () => {
  const store = memoryApprovalStore();
  const out = await q(one(), store);
  assert.equal(out.queued, true);
  const a = out.approval;
  assert.deepEqual([a.id, a.kind, a.status, a.forDate, a.source, a.reasons, a.createdAt], ["a1", "adjusted_guide", "pending", "2026-11-16", "adjust_guide", ["HRV below band"], NOW.toISOString()]);
  assert.equal(a.expiresAt, new Date(2026, 10, 16, 23, 59, 59, 999).toISOString());
  assert.deepEqual((await store.load())!.approvals[0].payload, guide("2026-11-16"));
  assert.equal((await q(one({ source: undefined, reasons: undefined }), store)).approval.id, "a2");
  const second = (await store.load())!.approvals[1];
  assert.deepEqual([second.source, second.reasons], ["manual", []]);
  assert.match(out.note, /nothing was sent to the watch/);
});

test("queueAdjustment: forDate (only the payload's own date) and an earlier expiresAt can be given; a week_plan's forDate is its first guide's date", async () => {
  const store = memoryApprovalStore();
  const w = await q({ kind: "week_plan", payload: { guides: [guide("2026-11-18"), guide("2026-11-16", "PULL B")] } }, store);
  assert.equal(w.approval.forDate, "2026-11-16");
  const noon = new Date(2026, 10, 16, 12, 0, 0).toISOString();
  const e = await q(one({ forDate: "2026-11-16", expiresAt: noon }), store);
  assert.deepEqual([e.approval.forDate, e.approval.expiresAt], ["2026-11-16", noon]);
});

test("queueAdjustment: refuses what the push tool would refuse, before anything is stored", async () => {
  const store = memoryApprovalStore();
  const bad = async (args: unknown, re: RegExp) => {
    await assert.rejects(q(args, store), re);
    assert.equal(await store.load(), null, "nothing stored");
  };
  await bad(one({ payload: { title: "x" } }), /not a valid push_strength_guide spec: guide: title, date and exercises are required/);
  await bad(one({ payload: { ...guide("2026-11-16"), guideId: "abc" } }), /guideId is not allowed: an approval only creates a new guide/);
  await bad(one({ payload: { ...guide("2026-11-16"), exercises: [{ name: "X", detail: "1", sets: 1, restSec: 5, restTargetHr: 300 }] } }), /cannot be built as a strength guide.*restTargetHr/);
  await bad({ kind: "week_plan", payload: { guides: [guide("2026-11-16"), guide("2026-11-16", "B")] } }, /2026-11-16 is listed more than once/);
  await bad({ kind: "week_plan", payload: { guides: [{ ...guide("2026-11-16"), guideId: "g" }] } }, /guideId is not allowed here/);
  await bad({ kind: "week_plan", payload: { guides: [] } }, /guides must list at least one guide/);
  await bad({ kind: "week_plan", payload: { guides: [guide("2026-11-16")], dryRun: false } }, /payload.dryRun is not a known field/);
  await bad(one({ kind: "shopping" }), /kind must be one of: adjusted_guide, week_plan/);
  await bad(one({ payload: "x" }), /payload must be an object/);
  await bad({ ...one(), extra: 1 }, /extra is not a known field/);
  await bad("x", /arguments must be an object/);
  await bad(one({ forDate: "2026-02-30" }), /forDate must be a calendar date/);
  await bad(one({ expiresAt: "2026-11-13T19:59:59" }), /has already passed/);
  await bad(one({ expiresAt: "soon" }), /expiresAt must be an ISO 8601 date-time/);
  await bad(one({ reasons: "why" }), /reasons must be a list/);
  await bad(one({ reasons: Array.from({ length: 21 }, () => "r") }), /at most 20 strings/);
  await bad(one({ source: "x".repeat(65) }), /source must be at most 64/);
  await bad(one({ payload: { ...guide("2026-11-16"), title: "x".repeat(200_001) } }), /at most 200000 characters/);
  assert.ok((await q(one({ payload: guide("2026-11-13"), forDate: "2026-11-13" }), store)).queued, "a guide for today is fine");
  assert.ok((await q(one({ expiresAt: new Date(NOW.getTime()).toISOString() }), store)).queued, "expiring exactly now is not yet expired");
});

test("queueAdjustment: the queue is capped, and nothing is dropped to make room", async () => {
  const mk = (n: number): Approval[] => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, createdAt: NOW.toISOString(), forDate: "2026-11-16", kind: "adjusted_guide" as const, payload: guide("2026-11-16"), reasons: [], source: "x", expiresAt: "2026-11-17T00:00:00.000Z" }));
  const store = memoryApprovalStore();
  await store.save({ approvals: mk(MAX_APPROVALS - 1) });
  assert.equal((await q(one(), store)).approval.id, `a${MAX_APPROVALS}`);
  await assert.rejects(q(one(), store), /holds 1000 approvals already/);
  assert.equal((await store.load())!.approvals.length, MAX_APPROVALS);
});

test("queueAdjustment: two at once get two ids", async () => {
  const store = memoryApprovalStore();
  const [x, y] = await Promise.all([q(one(), store), q(one(), store)]);
  assert.deepEqual([x.approval.id, y.approval.id].sort(), ["a1", "a2"]);
  assert.equal((await store.load())!.approvals.length, 2);
});

// ---------- status and listing ----------

const item = (over: Partial<Approval> = {}): Approval => ({ id: "a1", createdAt: NOW.toISOString(), forDate: "2026-11-16", kind: "adjusted_guide", payload: guide("2026-11-16"), reasons: ["r"], source: "s", expiresAt: "2026-11-16T12:00:00.000Z", ...over });

test("statusOf: expired only after expiresAt (at it the item is still pending); a resolution wins", () => {
  const at = Date.parse("2026-11-16T12:00:00.000Z");
  assert.equal(statusOf(item(), new Date(at - 1)), "pending");
  assert.equal(statusOf(item(), new Date(at)), "pending");
  assert.equal(statusOf(item(), new Date(at + 1)), "expired");
  const done = (decision: "approve" | "reject") => item({ resolution: { decision, at: "x", pushed: false } });
  assert.deepEqual([statusOf(done("approve"), new Date(at + 1e9)), statusOf(done("reject"), new Date(at + 1e9))], ["approved", "rejected"]);
});

test("listApprovals: pending, expired and done with their reasons; a filter; one item in full with the exact call", async () => {
  const store = memoryApprovalStore();
  await store.save({
    approvals: [
      item({ id: "a1" }),
      item({ id: "a2", expiresAt: "2026-11-12T00:00:00.000Z", reasons: ["too late"] }),
      item({ id: "a3", resolution: { decision: "approve", at: NOW.toISOString(), pushed: true } }),
      item({ id: "a4", resolution: { decision: "reject", at: NOW.toISOString(), note: "no", pushed: false } }),
      item({ id: "a5", kind: "week_plan", payload: { guides: [guide("2026-11-16")] } }),
    ],
  });
  const all = await listApprovals(store, {}, NOW);
  assert.deepEqual(all.counts, { pending: 2, expired: 1, approved: 1, rejected: 1 });
  assert.deepEqual(all.items.map((i) => [i.id, i.status]), [["a1", "pending"], ["a2", "expired"], ["a3", "approved"], ["a4", "rejected"], ["a5", "pending"]]);
  assert.deepEqual(all.items[1].reasons, ["too late"]);
  assert.ok(!("payload" in all.items[0]), "the list is short");
  assert.deepEqual((await listApprovals(store, { status: "done" }, NOW)).items.map((i) => i.id), ["a3", "a4"]);
  assert.deepEqual((await listApprovals(store, { status: "expired" }, NOW)).items.map((i) => i.id), ["a2"]);
  assert.deepEqual((await listApprovals(store, { status: "pending" }, NOW)).items.map((i) => i.id), ["a1", "a5"]);
  const full = (await listApprovals(store, { id: "a5" }, NOW)).items[0] as any;
  assert.deepEqual(full.call, { tool: "push_week_plan", arguments: { guides: [guide("2026-11-16")], dryRun: true } });
  assert.deepEqual(((await listApprovals(store, { id: "a1" }, NOW)).items[0] as any).call, { tool: "push_week_plan", arguments: { guides: [guide("2026-11-16")], dryRun: true } }, "an adjusted guide is shown in the same dry-run form");
  await assert.rejects(listApprovals(store, { id: "a9" }, NOW), /no approval a9/);
  await assert.rejects(listApprovals(store, { status: "old" }, NOW), /status must be one of: pending, expired, done, all/);
  assert.deepEqual((await listApprovals(memoryApprovalStore(), {}, NOW)).items, [], "no file, nothing waiting");
});

test("approvalsBrief: the pending items, how many expired, and which expire today", async () => {
  const store = memoryApprovalStore();
  await store.save({ approvals: [item({ id: "a1", expiresAt: new Date(2026, 10, 13, 23, 59, 59).toISOString() }), item({ id: "a2" }), item({ id: "a3", expiresAt: "2026-11-12T00:00:00.000Z" })] });
  const b = await approvalsBrief(store, NOW);
  assert.deepEqual([b.pending, b.expired, b.items.map((i) => [i.id, i.expiresToday])], [2, 1, [["a1", true], ["a2", false]]]);
});

// ---------- resolve_approval ----------

const queued = async (over: Record<string, unknown> = {}, store = memoryApprovalStore()) => {
  await q(one(over), store);
  return store;
};

test("resolveApproval: reject only records it, and nothing is pushed", async () => {
  const store = await queued();
  const p = pusher();
  const r = await resolve({ id: "a1", decision: "reject", note: "not this week" }, store, p);
  assert.deepEqual([r.decision, r.pushed, r.alreadyResolved, r.note], ["reject", false, false, "not this week"]);
  assert.ok(!("payload" in r), "a rejection returns no push-ready payload");
  assert.deepEqual(p.calls, []);
  assert.equal(statusOf((await store.load())!.approvals[0], NOW), "rejected");
});

test("resolveApproval: approve without push returns the payload and the dry-run call, and pushes nothing", async () => {
  const store = await queued();
  const p = pusher();
  const r = await resolve({ id: "a1", decision: "approve" }, store, p) as any;
  assert.deepEqual([r.decision, r.pushed, r.alreadyResolved], ["approve", false, false]);
  assert.deepEqual(r.payload, guide("2026-11-16"));
  assert.deepEqual(r.call, { tool: "push_week_plan", arguments: { guides: [guide("2026-11-16")], dryRun: true } });
  assert.deepEqual(p.calls, []);
});

test("resolveApproval: push needs push: true AND decision approve in the same call", async () => {
  const store = await queued();
  const p = pusher();
  await assert.rejects(resolve({ id: "a1", decision: "reject", push: true }, store, p), /push: true needs decision approve in the same call/);
  assert.deepEqual(p.calls, []);
  assert.equal((await store.load())!.approvals[0].resolution, undefined, "an invalid call decides nothing");
  await resolve({ id: "a1", decision: "approve" }, store, p);
  assert.deepEqual(p.calls, [], "approving alone never pushes");
  const r = await resolve({ id: "a1", decision: "approve", push: true }, store, p);
  assert.deepEqual([p.calls, r.pushed, r.alreadyResolved], [["PUSH A"], true, false], "the push completes the approval, once");
  assert.deepEqual((r as any).pushResult, { id: "g1", check: { verified: true } });
});

test("resolveApproval: approve with push: true pushes the guide through the push path once; resolving again returns the first result and never pushes again", async () => {
  const store = await queued();
  const p = pusher();
  const first = await resolve({ id: "a1", decision: "approve", push: true, note: "go" }, store, p);
  assert.deepEqual([first.pushed, first.alreadyResolved, p.calls], [true, false, ["PUSH A"]]);
  for (const again of [{ id: "a1", decision: "approve", push: true }, { id: "a1", decision: "reject" }, { id: "a1", decision: "approve" }]) {
    const r = await resolve(again, store, p);
    assert.equal(r.alreadyResolved, true);
    assert.deepEqual([r.decision, r.pushed, r.note, r.resolvedAt], ["approve", true, "go", first.resolvedAt], "the first answer, whatever is asked now");
  }
  assert.deepEqual(p.calls, ["PUSH A"], "pushed exactly once");
});

test("resolveApproval: two resolves at once push once", async () => {
  const store = await queued();
  const p = pusher();
  const rs = await Promise.all([resolve({ id: "a1", decision: "approve", push: true }, store, p), resolve({ id: "a1", decision: "approve", push: true }, store, p)]);
  assert.deepEqual(rs.map((r) => r.alreadyResolved).sort(), [false, true]);
  assert.deepEqual(p.calls, ["PUSH A"]);
});

test("resolveApproval: an expired item cannot be approved (or pushed); rejecting it is fine; an item expiring exactly now can still be approved", async () => {
  const expired = Date.parse("2026-11-13T19:59:59.999Z");
  const store = memoryApprovalStore();
  await store.save({ approvals: [item({ id: "a1", expiresAt: new Date(NOW.getTime() - 1).toISOString() }), item({ id: "a2", expiresAt: NOW.toISOString() }), item({ id: "a3", expiresAt: new Date(NOW.getTime() - 1).toISOString() })] });
  void expired;
  const p = pusher();
  await assert.rejects(resolve({ id: "a1", decision: "approve" }, store, p), /approval a1 expired at .* and cannot be approved/);
  await assert.rejects(resolve({ id: "a1", decision: "approve", push: true }, store, p), /cannot be approved/);
  assert.deepEqual(p.calls, []);
  assert.equal((await store.load())!.approvals[0].resolution, undefined);
  assert.equal((await resolve({ id: "a3", decision: "reject" }, store, p)).decision, "reject");
  assert.equal((await resolve({ id: "a2", decision: "approve", push: true }, store, p)).pushed, true, "expiresAt equal to now is not expired");
  // approved in time, pushed later than the expiry: refused
  const late = memoryApprovalStore();
  await late.save({ approvals: [item({ id: "a1", expiresAt: new Date(NOW.getTime() + 1000).toISOString() })] });
  await resolve({ id: "a1", decision: "approve" }, late, p);
  const afterwards = { ...p.deps, now: new Date(NOW.getTime() + 1001) };
  await assert.rejects(resolveApproval({ id: "a1", decision: "approve", push: true }, late, afterwards), /expired at .* and cannot be pushed/);
});

test("resolveApproval: bad arguments are refused and decide nothing", async () => {
  const store = await queued();
  const bad = async (args: unknown, re: RegExp) => {
    await assert.rejects(resolve(args, store), re);
    assert.equal((await store.load())!.approvals[0].resolution, undefined);
  };
  await bad({ id: "a9", decision: "approve" }, /no approval a9/);
  await bad({ decision: "approve" }, /id is required/);
  await bad({ id: "a1" }, /decision must be approve or reject/);
  await bad({ id: "a1", decision: "maybe" }, /decision must be approve or reject/);
  await bad({ id: "a1", decision: "approve", push: "yes" }, /push must be a boolean/);
  await bad({ id: "a1", decision: "approve", dryRun: false }, /dryRun only applies together with push: true/);
  await bad({ id: "a1", decision: "approve", push: true, dryRun: false }, /dryRun applies to a week_plan approval only/);
  await bad({ id: "a1", decision: "approve", extra: 1 }, /extra is not a known field/);
  await bad({ id: "a1", decision: "approve", note: "x".repeat(501) }, /note must be at most 500/);
  await bad("x", /arguments must be an object/);
});

test("resolveApproval: a failed push is an error, records nothing, and can be tried again; a missing app name stops before any push", async () => {
  const store = await queued();
  const failing = pusher({ fail: () => true });
  await assert.rejects(resolve({ id: "a1", decision: "approve", push: true }, store, failing), /Suunto answered 500/);
  assert.equal((await store.load())!.approvals[0].resolution, undefined, "not approved, not pushed");
  const noApp = pusher({ appName: undefined });
  await assert.rejects(resolve({ id: "a1", decision: "approve", push: true }, store, noApp), /SUUNTO_APP_NAME is not set/);
  assert.deepEqual(noApp.calls, []);
  const ok = pusher();
  assert.equal((await resolve({ id: "a1", decision: "approve", push: true }, store, ok)).pushed, true);
  assert.deepEqual(ok.calls, ["PUSH A"]);
});

test("resolveApproval: demo mode never calls the push path, whatever is asked, and says so", async () => {
  const store = await queued();
  const p = pusher({ demo: true });
  const r = await resolve({ id: "a1", decision: "approve", push: true }, store, p);
  assert.deepEqual([r.pushed, p.calls], [false, []]);
  assert.match(r.notes[0], /Demo mode: nothing was pushed/);
  const w = memoryApprovalStore();
  await q({ kind: "week_plan", payload: { guides: [guide("2026-11-16")] } }, w);
  const wr = await resolve({ id: "a1", decision: "approve", push: true, dryRun: false }, w, p);
  assert.deepEqual([wr.pushed, p.calls], [false, []]);
});

test("resolveApproval: a week plan is a dry run unless dryRun: false is passed with push: true; the dry run leaves the real push open", async () => {
  const store = memoryApprovalStore();
  await q({ kind: "week_plan", payload: { guides: [guide("2026-11-16"), guide("2026-11-18", "PULL B")] } }, store);
  const p = pusher();
  const dry = await resolve({ id: "a1", decision: "approve", push: true }, store, p) as any;
  assert.deepEqual([dry.pushed, p.calls, dry.pushResult.dryRun, dry.pushResult.wouldPush.map((w: any) => w.date)], [false, [], true, ["2026-11-16", "2026-11-18"]]);
  assert.match(dry.notes[0], /Dry run only/);
  assert.equal((await resolve({ id: "a1", decision: "approve", push: true, dryRun: true }, store, p)).pushed, false);
  assert.deepEqual(p.calls, []);
  const real = await resolve({ id: "a1", decision: "approve", push: true, dryRun: false }, store, p) as any;
  assert.deepEqual([real.pushed, real.alreadyResolved, p.calls], [true, false, ["PUSH A", "PULL B"]]);
  const again = await resolve({ id: "a1", decision: "approve", push: true, dryRun: false }, store, p);
  assert.deepEqual([again.alreadyResolved, p.calls.length], [true, 2], "never twice");
});

test("resolveApproval: a week push that stops half way counts as pushed and is not retried (the days that went through would be duplicated)", async () => {
  const store = memoryApprovalStore();
  await q({ kind: "week_plan", payload: { guides: [guide("2026-11-16"), guide("2026-11-18", "PULL B"), guide("2026-11-20", "LEGS C")] } }, store);
  const p = pusher({ fail: (n) => n === 2 });
  const r = await resolve({ id: "a1", decision: "approve", push: true, dryRun: false }, store, p) as any;
  assert.deepEqual([r.pushed, r.pushResult.ok, r.pushResult.failed.date, r.pushResult.notPushed], [true, false, "2026-11-18", ["2026-11-20"]]);
  assert.match(r.notes[0], /NOT retried automatically/);
  const again = await resolve({ id: "a1", decision: "approve", push: true, dryRun: false }, store, p);
  assert.deepEqual([again.alreadyResolved, p.calls.length], [true, 2]);
});

// ---------- the file ----------

async function withFile<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-approvals-"));
  try {
    return await fn(join(dir, "sub", "approvals.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fileApprovalStore: version 1, atomic write, file 0600 and folder 0700, round trip", async () => {
  await withFile(async (path, dir) => {
    const store = fileApprovalStore(path);
    assert.equal(await store.load(), null, "no file, no approvals");
    await q(one(), store);
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.equal(file.version, 1);
    assert.equal(file.approvals[0].id, "a1");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "sub"))).mode & 0o777, 0o700);
    assert.deepEqual((await store.load())!.approvals[0].payload, guide("2026-11-16"));
    await resolve({ id: "a1", decision: "reject" }, store);
    assert.equal(JSON.parse(await readFile(path, "utf8")).approvals[0].resolution.decision, "reject");
  });
});

test("fileApprovalStore: a damaged, foreign, newer-version or unknown-field file is refused with its name and left untouched", async () => {
  await withFile(async (path) => {
    const store = fileApprovalStore(path);
    await q(one(), store);
    const cases: [string, RegExp][] = [
      ["{ not json", /is not valid JSON/],
      ["[1,2]", /is not a suunto-mcp approvals file/],
      [JSON.stringify({ version: 2, approvals: [] }), /approvals version 2, but this server reads and writes version 1 only; it is left untouched/],
      [JSON.stringify({ approvals: [] }), /version/],
      [JSON.stringify({ version: 1, approvals: [], extra: 1 }), /extra is not a known field/],
      [JSON.stringify({ version: 1, approvals: [{ id: "x" }] }), /approvals\[0\]/],
      [JSON.stringify({ version: 1, approvals: "no" }), /approvals must be an array/],
    ];
    for (const [text, re] of cases) {
      await writeFile(path, text);
      await assert.rejects(store.load(), re);
      await assert.rejects(q(one(), store), re, "queueing refuses it too");
      await assert.rejects(resolve({ id: "a1", decision: "reject" }, store), re);
      await assert.rejects(listApprovals(store, {}, NOW), re);
      assert.equal(await readFile(path, "utf8"), text, "left untouched");
    }
  });
});

test("parseApprovals: 1000 approvals are fine, 1001 are refused", () => {
  const many = (n: number) => ({ version: 1, approvals: Array.from({ length: n }, (_, i) => item({ id: `a${i + 1}` })) });
  assert.equal(parseApprovals(many(MAX_APPROVALS)).approvals.length, 1000);
  assert.throws(() => parseApprovals(many(MAX_APPROVALS + 1)), /at most 1000 items/);
});

test("parseApprovals: strict about fields, ids, kinds and duplicates", () => {
  const good = { version: 1, approvals: [item()] };
  assert.equal(parseApprovals(good).approvals.length, 1);
  const bad = (over: Record<string, unknown>, re: RegExp) => assert.throws(() => parseApprovals({ version: 1, approvals: [{ ...item(), ...over }] }), re);
  bad({ kind: "x" }, /kind must be one of/);
  bad({ forDate: "2026-13-01" }, /forDate must be a calendar date/);
  bad({ expiresAt: "soon" }, /expiresAt must be an ISO/);
  bad({ payload: [] }, /payload must be an object/);
  bad({ reasons: [1] }, /reasons must be a list of strings/);
  bad({ resolution: { decision: "maybe", at: NOW.toISOString(), pushed: false } }, /decision must be approve or reject/);
  bad({ resolution: { decision: "approve", at: NOW.toISOString() } }, /pushed must be a boolean/);
  bad({ resolution: { decision: "approve", at: NOW.toISOString(), pushed: false, x: 1 } }, /x is not a known field/);
  bad({ nope: 1 }, /nope is not a known field/);
  assert.throws(() => parseApprovals({ version: 1, approvals: [item(), item()] }), /id twice/);
});

// ---------- review fixes: one queue for every writer, stale pushes, the dry-run form ----------

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setImmediate(r));
};

test("one serialized queue for every writer of approvals.json: a queue_adjustment during a slow push is not lost, the push record survives, a second approve with push pushes nothing", async () => {
  const store = await queued();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const slow = { demo: false, appName: "x", validate, now: NOW, push: async (_zip: Buffer, title: string) => { calls.push(title); await gate; return { data: { id: "g1" }, check: { verified: true } }; } };
  const first = resolveApproval({ id: "a1", decision: "approve", push: true }, store, slow);
  await settle(() => calls.length === 1);
  assert.deepEqual(calls, ["PUSH A"], "the push is under way");
  const during = q(one({ payload: guide("2026-11-17") }), store); // another writer, mid-push
  const again = resolveApproval({ id: "a1", decision: "approve", push: true }, store, slow); // a second yes, mid-push
  release();
  const [r1, r2, r3] = await Promise.all([first, during, again]);
  const file = (await store.load())!.approvals;
  assert.deepEqual(file.map((a) => a.id), ["a1", "a2"], "the queued item is not lost");
  assert.deepEqual([file[0].resolution?.decision, file[0].resolution?.pushed], ["approve", true], "the push record survives");
  assert.deepEqual([r1.pushed, r1.alreadyResolved, r2.approval.id, r3.alreadyResolved, r3.pushed], [true, false, "a2", true, true]);
  assert.deepEqual(calls, ["PUSH A"], "pushed once");
});

test("a resolve during another writer's save, and two queue writers, also keep every record", async () => {
  const store = await queued();
  const p = pusher();
  const [a, b, c] = await Promise.all([q(one({ payload: guide("2026-11-17") }), store), resolve({ id: "a1", decision: "reject" }, store, p), q(one({ payload: guide("2026-11-18") }), store)]);
  assert.deepEqual([a.approval.id, c.approval.id], ["a2", "a3"]);
  assert.equal(b.decision, "reject");
  const file = (await store.load())!.approvals;
  assert.deepEqual(file.map((x) => [x.id, x.resolution?.decision ?? null]), [["a1", "reject"], ["a2", null], ["a3", null]]);
});

test("queueAdjustment: forDate must equal the payload's date (the earliest guide's for a week plan); expiresAt cannot be later than the end of that day", async () => {
  const store = memoryApprovalStore();
  const bad = async (args: unknown, re: RegExp) => {
    await assert.rejects(q(args, store), re);
    assert.equal(await store.load(), null);
  };
  await bad(one({ forDate: "2026-11-20" }), /forDate 2026-11-20 must equal the payload's date 2026-11-16/);
  await bad({ kind: "week_plan", payload: { guides: [guide("2026-11-18"), guide("2026-11-16", "B")] }, forDate: "2026-11-18" }, /forDate 2026-11-18 must equal the payload's date 2026-11-16/);
  await bad(one({ expiresAt: new Date(2026, 10, 17, 0, 0, 0, 0).toISOString() }), /expiresAt .* is after the end of 2026-11-16/);
  await bad(one({ expiresAt: "2027-06-01T00:00:00Z" }), /is after the end of 2026-11-16/);
  // the reviewer's case: a past guide, a later forDate, a far expiry
  await bad({ kind: "adjusted_guide", payload: guide("2026-11-10"), forDate: "2026-11-20", expiresAt: "2027-06-01T00:00:00Z" }, /forDate 2026-11-20 must equal the payload's date 2026-11-10/);
  await bad({ kind: "adjusted_guide", payload: guide("2026-11-10") }, /guide dated 2026-11-10 is before today \(2026-11-13\)/);
  await bad({ kind: "week_plan", payload: { guides: [guide("2026-11-12"), guide("2026-11-16", "B")] } }, /guide dated 2026-11-12 is before today/);
  assert.equal((await q(one({ forDate: "2026-11-16", expiresAt: new Date(2026, 10, 16, 23, 59, 59, 999).toISOString() }), store)).approval.forDate, "2026-11-16", "exactly the end of the day is allowed");
  assert.equal((await q(one({ expiresAt: new Date(2026, 10, 16, 23, 59, 59, 1000).toISOString() }), store).catch((e) => e.message)), "expiresAt " + new Date(2026, 10, 17, 0, 0, 0, 0).toISOString() + " is after the end of 2026-11-16 (" + new Date(2026, 10, 16, 23, 59, 59, 999).toISOString() + "): an approval cannot outlive the day it is for.", "one millisecond later is refused");
});

test("resolveApproval: approve and push are refused when ANY guide in the payload is dated before today at that time", async () => {
  const store = memoryApprovalStore();
  const later = new Date(2026, 10, 15, 9, 0, 0); // two days on
  await store.save({
    approvals: [
      item({ id: "a1", forDate: "2026-11-14", kind: "week_plan", payload: { guides: [guide("2026-11-14"), guide("2026-11-20", "B")] }, expiresAt: "2026-11-30T00:00:00.000Z" }),
      item({ id: "a2", forDate: "2026-11-20", kind: "week_plan", payload: { guides: [guide("2026-11-20"), guide("2026-11-14", "B")] }, expiresAt: "2026-11-30T00:00:00.000Z" }),
      item({ id: "a3", forDate: "2026-11-14", payload: guide("2026-11-14"), expiresAt: "2026-11-30T00:00:00.000Z" }),
    ],
  });
  const p = pusher();
  for (const id of ["a1", "a2", "a3"]) {
    await assert.rejects(resolveApproval({ id, decision: "approve" }, store, { ...p.deps, now: later }), /guide dated 2026-11-14 is before today \(2026-11-15\)/, id);
    await assert.rejects(resolveApproval({ id, decision: "approve", push: true, ...(id === "a3" ? {} : { dryRun: false }) }, store, { ...p.deps, now: later }), /before today/, id);
  }
  assert.deepEqual(p.calls, []);
  assert.equal((await store.load())!.approvals.every((a) => a.resolution === undefined), true, "nothing was decided");
  assert.equal((await resolveApproval({ id: "a3", decision: "reject" }, store, { ...p.deps, now: later })).decision, "reject", "a stale item can still be rejected");
  // approved in time, pushed after the day has turned
  const s2 = await queued({ payload: guide("2026-11-13") });
  await resolve({ id: "a1", decision: "approve" }, s2);
  await assert.rejects(resolveApproval({ id: "a1", decision: "approve", push: true }, s2, { ...pusher().deps, now: new Date(2026, 10, 14, 8, 0, 0) }), /expired|before today/);
});

test("resolveApproval: after approve without push the call is the DRY-RUN form (push_week_plan, dryRun true); the only push path named is resolve_approval with push: true", async () => {
  const store = await queued();
  const r = (await resolve({ id: "a1", decision: "approve" }, store)) as any;
  assert.deepEqual(r.call, { tool: "push_week_plan", arguments: { guides: [guide("2026-11-16")], dryRun: true } });
  assert.match(r.howToPush, /resolve_approval with \{ id: "a1", decision: "approve", push: true \}/);
  assert.doesNotMatch(JSON.stringify(r), /"dryRun":false/, "no ready real-push call is handed out");
  const w = memoryApprovalStore();
  await q({ kind: "week_plan", payload: { guides: [guide("2026-11-16")] } }, w);
  const wr = (await resolve({ id: "a1", decision: "approve" }, w)) as any;
  assert.deepEqual(wr.call, { tool: "push_week_plan", arguments: { guides: [guide("2026-11-16")], dryRun: true } });
  assert.match(wr.howToPush, /dryRun: false/);
  const full = (await listApprovals(w, { id: "a1" }, NOW)).items[0] as any;
  assert.equal(full.call.arguments.dryRun, true);
  assert.doesNotMatch(JSON.stringify(await listApprovals(store, { id: "a1" }, NOW)), /"dryRun":false/);
});
