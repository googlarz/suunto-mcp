import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds } from "./api.js";
import { buildCatchup, fileSeenStore, memorySeenStore, WORKOUT_LIMIT } from "./catchup.js";
import { filePlanStore, memoryPlanStore, setPlan } from "./plan.js";

const NOW = new Date(2026, 10, 15, 12, 0, 0); // local noon, 2026-11-15
const OFFSET = -NOW.getTimezoneOffset();

// a workout that starts at local HH:MM on the given local date
const workout = (key: string, date: string, hhmm: string, extra: object = {}) => ({
  workoutKey: key,
  activityId: 3,
  startTime: Date.parse(`${date}T${hhmm}:00Z`) - OFFSET * 60_000,
  timeOffsetInMinutes: OFFSET,
  totalTime: 3600,
  tss: { trainingStressScore: 55 },
  ...extra,
});
const sleep = (id: number, start: string, end: string, durationS = 27000, extra: object = {}) => ({
  timestamp: start,
  entryData: { SleepId: id, BedtimeStart: start, BedtimeEnd: end, Duration: durationS, IsNap: durationS < 10800, SleepQualityScore: 80, AvgHRV: 60, ...extra },
});
const recovery = (at: string, balance: number) => ({ timestamp: at, entryData: { Balance: balance, StressState: 1 } });

interface Data {
  workouts?: any[];
  sleeps?: any[];
  recoveries?: any[];
  fail?: string[];
}
function fake(data: Data) {
  const calls: { name: string; args: any[] }[] = [];
  const client = {
    listWorkouts: async (o: any) => (calls.push({ name: "workouts", args: [o] }), data.fail?.includes("workouts") ? Promise.reject(new Error("boom workouts")) : { payload: data.workouts ?? [] }),
    listSleep: async (...a: any[]) => (calls.push({ name: "sleep", args: a }), data.fail?.includes("sleep") ? Promise.reject(new Error("boom sleep")) : { payload: data.sleeps ?? [] }),
    listRecovery: async (...a: any[]) => (calls.push({ name: "recovery", args: a }), data.fail?.includes("recovery") ? Promise.reject(new Error("boom recovery")) : { payload: data.recoveries ?? [] }),
  } as unknown as SuuntoClient;
  return { client, calls };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-seen-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const WK_A = workout("aaaaaaaaaaaaaaaaaaaaaaaa", "2026-11-13", "07:30");
const WK_B = workout("bbbbbbbbbbbbbbbbbbbbbbbb", "2026-11-14", "18:00");
const NIGHT_1 = sleep(1, "2026-11-13T22:30:00.000Z", "2026-11-14T06:30:00.000Z");
const NIGHT_2 = sleep(2, "2026-11-14T22:45:00.000Z", "2026-11-15T06:15:00.000Z", 26000);

const none = memoryPlanStore();

test("catchup: first call looks back 7 days with three bounded list calls and reports what is new", async () => {
  const { client, calls } = fake({
    workouts: [WK_B, WK_A],
    sleeps: [NIGHT_1, NIGHT_2],
    recoveries: [recovery("2026-11-14T06:30:00.000Z", 0.8), recovery("2026-11-14T20:00:00.000Z", 0.35), recovery("2026-11-15T06:00:00.000Z", 0.7)],
  });
  const r = await buildCatchup(client, memorySeenStore(), none, {}, NOW);
  assert.deepEqual(calls.map((c) => c.name).sort(), ["recovery", "sleep", "workouts"], "one request per section");
  assert.deepEqual(calls.find((c) => c.name === "workouts")!.args[0], { since: dayFetchBounds("2026-11-08", "2026-11-15").from, limit: WORKOUT_LIMIT });
  assert.deepEqual(calls.find((c) => c.name === "sleep")!.args, ["2026-11-07", "2026-11-15"]);
  assert.deepEqual(calls.find((c) => c.name === "recovery")!.args, ["2026-11-08", "2026-11-15"]);
  assert.deepEqual(r.since, { from: "2026-11-08", firstCall: true });
  assert.deepEqual(r.newWorkouts.map((w) => [w.date, w.workoutKey, w.startLocal, w.totalTimeS, w.tss, w.activityId]), [
    ["2026-11-13", WK_A.workoutKey, "07:30", 3600, 55, 3],
    ["2026-11-14", WK_B.workoutKey, "18:00", 3600, 55, 3],
  ]);
  assert.equal(r.newNights.length, 2);
  assert.deepEqual([r.newNights[1].durationS, r.newNights[1].score, r.newNights[1].avgHrv], [26000, 80, 60]);
  assert.deepEqual(r.newNights[1].recoveryOnWaking, { balance: 0.7, at: "2026-11-15T06:00:00.000Z" });
  assert.equal(r.recovery?.newSamples, 3);
  assert.deepEqual(r.recovery?.low, { balance: 0.35, at: "2026-11-14T20:00:00.000Z" });
  assert.deepEqual(r.recovery?.latest, { balance: 0.7, at: "2026-11-15T06:00:00.000Z" });
  assert.equal(r.lastSessionDate, "2026-11-14");
  assert.equal(r.daysSinceLastSession, 1);
  assert.equal(r.marked, false);
  assert.deepEqual(r.errors, []);
});

test("catchup: markSeen false leaves the marker alone, so the same call gives the same answer (file store: no file is created)", async () => {
  await withDir(async (dir) => {
    const seen = fileSeenStore(join(dir, "sub", "seen.json"));
    const { client } = fake({ workouts: [WK_B, WK_A], sleeps: [NIGHT_1], recoveries: [recovery("2026-11-14T06:30:00.000Z", 0.8)] });
    const first = await buildCatchup(client, seen, none, {}, NOW);
    const again = await buildCatchup(client, seen, none, { markSeen: false }, NOW);
    assert.deepEqual(again, first);
    assert.deepEqual(await readdir(dir), [], "nothing written, not even the folder");
    // and with an existing marker its bytes and mtime stay
    await buildCatchup(client, seen, none, { markSeen: true }, NOW);
    const file = join(dir, "sub", "seen.json");
    const before = [await readFile(file, "utf8"), (await stat(file)).mtimeMs];
    await buildCatchup(client, seen, none, {}, NOW);
    assert.deepEqual([await readFile(file, "utf8"), (await stat(file)).mtimeMs], before);
  });
});

test("catchup: markSeen true moves the marker; the next call shows only what came after (file store, 0600, no temp file)", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "sub", "seen.json");
    const seen = fileSeenStore(file);
    const data: Data = { workouts: [WK_B, WK_A], sleeps: [NIGHT_1], recoveries: [recovery("2026-11-14T06:30:00.000Z", 0.8)] };
    const first = await buildCatchup(fake(data).client, seen, none, { markSeen: true }, NOW);
    assert.equal(first.marked, true);
    assert.equal(first.newWorkouts.length, 2);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, "sub")), ["seen.json"]);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.seenThrough, "2026-11-15");
    assert.equal(saved.workoutStartMs, WK_B.startTime);
    assert.equal(saved.sleepEndMs, Date.parse(NIGHT_1.entryData.BedtimeEnd));

    const quiet = await buildCatchup(fake(data).client, seen, none, {}, NOW);
    assert.deepEqual([quiet.newWorkouts, quiet.newNights, quiet.recovery?.newSamples], [[], [], 0]);
    assert.deepEqual(quiet.since, { from: "2026-11-15", firstCall: false });
    assert.equal(quiet.daysSinceLastSession, 1, "still known from the marker's workout when none is in the window");

    const WK_C = workout("cccccccccccccccccccccccc", "2026-11-15", "07:00");
    const next = await buildCatchup(fake({ ...data, workouts: [WK_C, WK_B, WK_A], sleeps: [NIGHT_1, NIGHT_2], recoveries: [recovery("2026-11-14T06:30:00.000Z", 0.8), recovery("2026-11-15T06:00:00.000Z", 0.7)] }).client, seen, none, {}, NOW);
    assert.deepEqual(next.newWorkouts.map((w) => w.workoutKey), [WK_C.workoutKey]);
    assert.equal(next.newNights.length, 1);
    assert.equal(next.newNights[0].durationS, 26000);
    assert.equal(next.recovery?.newSamples, 1);
    assert.equal(next.daysSinceLastSession, 0);
  });
});

test("catchup: a night still in progress, a nap and a future-dated row are not reported or marked", async () => {
  const seen = memorySeenStore();
  const inProgress = sleep(3, "2026-11-15T01:00:00.000Z", "2026-11-15T16:00:00.000Z");
  const nap = sleep(4, "2026-11-14T13:00:00.000Z", "2026-11-14T14:00:00.000Z", 3600);
  const r = await buildCatchup(fake({ sleeps: [NIGHT_1, inProgress, nap], recoveries: [recovery("2026-11-16T06:00:00.000Z", 0.9)] }).client, seen, none, { markSeen: true }, NOW);
  assert.deepEqual(r.newNights.map((n) => n.bedtimeEnd), [NIGHT_1.entryData.BedtimeEnd]);
  assert.equal(r.recovery?.newSamples, 0);
  const state = (await seen.load())!;
  assert.equal(state.sleepEndMs, Date.parse(NIGHT_1.entryData.BedtimeEnd));
  assert.equal(state.recoveryAtMs, null);
});

test("catchup: plan items are done, missed or pending by date; a workout counts even when already seen", async () => {
  const plans = memoryPlanStore();
  await setPlan({ goal: "g", sessions: [{ date: "2026-11-09", title: "too early" }, { date: "2026-11-10", title: "Push A" }, { date: "2026-11-13", title: "Pull B" }, { date: "2026-11-15", title: "Legs C" }, { date: "2026-11-16", title: "future" }] }, plans);
  const seen = memorySeenStore();
  await seen.save({ workoutStartMs: WK_B.startTime, workoutDate: "2026-11-14", sleepEndMs: null, recoveryAtMs: null, seenThrough: "2026-11-10", updatedAt: "" });
  const r: any = await buildCatchup(fake({ workouts: [WK_B, WK_A] }).client, seen, plans, {}, NOW);
  assert.equal(r.newWorkouts.length, 0, "both workouts were seen already");
  assert.deepEqual(r.plan.items.map((i: any) => [i.date, i.status]), [["2026-11-10", "missed"], ["2026-11-13", "done"], ["2026-11-15", "pending"]]);
  assert.equal(r.plan.items[1].workoutKey, WK_A.workoutKey);
  assert.deepEqual([r.plan.done, r.plan.missed, r.plan.pending, r.plan.todaySession], [1, 1, 1, "Legs C"]);
});

test("catchup: no plan is null; an unreadable plan file is reported in the plan section, not as a failed call", async () => {
  assert.equal(((await buildCatchup(fake({}).client, memorySeenStore(), none, {}, NOW)) as any).plan, null);
  await withDir(async (dir) => {
    const file = join(dir, "plan.json");
    await writeFile(file, "{ broken");
    const r: any = await buildCatchup(fake({}).client, memorySeenStore(), filePlanStore(file), {}, NOW);
    assert.match(r.plan.error, /not valid JSON/);
    assert.equal(await readFile(file, "utf8"), "{ broken");
  });
});

test("catchup: a failing section is listed, keeps its old marker and does not advance the plan review", async () => {
  const seen = memorySeenStore();
  const old = { workoutStartMs: 1000, workoutDate: "2026-11-01", sleepEndMs: 2000, recoveryAtMs: 3000, seenThrough: "2026-11-12", updatedAt: "" };
  await seen.save(old);
  const r = await buildCatchup(fake({ workouts: [WK_B], sleeps: [NIGHT_1], recoveries: [recovery("2026-11-14T06:30:00.000Z", 0.8)], fail: ["sleep"] }).client, seen, none, { markSeen: true }, NOW);
  assert.deepEqual(r.errors.map((e) => e.section), ["sleep"]);
  assert.equal(r.newNights.length, 0);
  const state = (await seen.load())!;
  assert.equal(state.sleepEndMs, 2000, "sleep marker kept");
  assert.equal(state.workoutStartMs, WK_B.startTime);
  assert.equal(state.recoveryAtMs, Date.parse("2026-11-14T06:30:00.000Z"));

  const noWorkouts = await buildCatchup(fake({ fail: ["workouts"] }).client, seen, none, { markSeen: true }, NOW);
  assert.deepEqual(noWorkouts.errors.map((e) => e.section), ["workouts"]);
  assert.equal((await seen.load())!.seenThrough, "2026-11-15", "unchanged from the call before");
  const stale = memorySeenStore();
  await stale.save({ ...old });
  await buildCatchup(fake({ fail: ["workouts"] }).client, stale, none, { markSeen: true }, NOW);
  assert.deepEqual(await stale.load(), { ...old, updatedAt: NOW.toISOString(), sleepEndMs: 2000, recoveryAtMs: 3000 }, "a failed workouts section moves neither the workout marker nor seenThrough");
});

test("catchup: hitting the workout limit reports it and does not advance the workout marker or the plan review", async () => {
  const many = Array.from({ length: WORKOUT_LIMIT }, (_, i) => workout(i.toString(16).padStart(24, "0"), "2026-11-14", "10:00", { startTime: WK_B.startTime - i * 60_000 }));
  const seen = memorySeenStore();
  const r = await buildCatchup(fake({ workouts: many }).client, seen, none, { markSeen: true }, NOW);
  assert.match(r.errors[0].error, /50-workout limit/);
  const state = (await seen.load())!;
  assert.equal(state.workoutStartMs, null);
  assert.equal(state.seenThrough, null);
});

test("catchup: a marker older than 14 days is capped at 14 days and says so", async () => {
  const seen = memorySeenStore();
  await seen.save({ workoutStartMs: null, workoutDate: null, sleepEndMs: null, recoveryAtMs: null, seenThrough: "2026-10-01", updatedAt: "" });
  const { client, calls } = fake({});
  const r = await buildCatchup(client, seen, none, {}, NOW);
  assert.equal(r.since.from, "2026-11-01");
  assert.deepEqual(calls.find((c) => c.name === "recovery")!.args, ["2026-11-01", "2026-11-15"]);
  assert.match(r.notes.join(" "), /only the last 14 days/);
});

test("catchup: an unreadable or foreign seen file stops the call (even with markSeen) and is never overwritten", async () => {
  await withDir(async (dir) => {
    const cases: [string, RegExp][] = [
      ["{ nope", /not valid JSON/],
      ["[]", /not a suunto-mcp seen file/],
      ['{"version":2}', /version/],
      ['{"workoutStartMs":5}', /version/],
      ['{"version":1,"workoutStartMs":"x"}', /workoutStartMs must be a timestamp/],
      ['{"version":1,"seenThrough":"2026-02-30"}', /seenThrough must be a calendar date/],
      ['{"version":1,"extra":1}', /extra is not a known field/],
    ];
    for (const [body, re] of cases) {
      const file = join(dir, "seen.json");
      await writeFile(file, body);
      for (const markSeen of [false, true]) await assert.rejects(buildCatchup(fake({ workouts: [WK_A] }).client, fileSeenStore(file), none, { markSeen }, NOW), re, body);
      assert.equal(await readFile(file, "utf8"), body);
    }
    assert.deepEqual(await readdir(dir), ["seen.json"]);
  });
});

test("catchup: the memory store keeps the marker for the process only and touches no file", async () => {
  await withDir(async (dir) => {
    process.env.SUUNTO_SEEN_PATH = join(dir, "seen.json");
    try {
      const seen = memorySeenStore();
      const data: Data = { workouts: [WK_A] };
      assert.equal((await buildCatchup(fake(data).client, seen, none, { markSeen: true }, NOW)).newWorkouts.length, 1);
      assert.equal((await buildCatchup(fake(data).client, seen, none, {}, NOW)).newWorkouts.length, 0);
    } finally {
      delete process.env.SUUNTO_SEEN_PATH;
    }
    assert.deepEqual(await readdir(dir), []);
  });
});
