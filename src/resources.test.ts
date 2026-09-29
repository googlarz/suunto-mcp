import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCES, readResource } from "./resources.js";
import { localDate } from "./api.js";

test("resources: each entry has uri, name, description, mimeType", () => {
  assert.ok(RESOURCES.length >= 5);
  for (const r of RESOURCES) {
    assert.match(r.uri, /^suunto:\/\//);
    assert.ok(r.name);
    assert.ok(r.description);
    assert.equal(r.mimeType, "application/json");
  }
});

test("resources: readResource(recent/workout) returns first listed workout", async () => {
  const fakeClient: any = {
    listWorkouts: async () => ({
      payload: [{ workoutKey: "abc", startTime: 1234 }],
    }),
  };
  const out = await readResource("suunto://recent/workout", fakeClient);
  assert.equal(out.uri, "suunto://recent/workout");
  assert.equal(out.mimeType, "application/json");
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.workoutKey, "abc");
});

test("resources: readResource(today/sleep) calls getSleep with yesterday's date, not today's", async () => {
  let receivedDate: string | undefined;
  const fakeClient: any = {
    getSleep: async (date: string) => {
      receivedDate = date;
      return { score: 88 };
    },
  };
  const out = await readResource("suunto://today/sleep", fakeClient);
  assert.match(receivedDate ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(receivedDate, localDate(0), "last night's sleep started yesterday, not today");
  assert.equal(receivedDate, localDate(1));
  assert.deepEqual(JSON.parse(out.text), { score: 88 });
});

test("resources: readResource(this-week/summary) aggregates totals", async () => {
  const fakeClient: any = {
    listWorkouts: async () => ({
      payload: [
        { workoutKey: "w1", totalTime: 3600, totalDistance: 10000 },
        { workoutKey: "w2", totalTime: 1800, totalDistance: 5000 },
      ],
    }),
  };
  const out = await readResource("suunto://this-week/summary", fakeClient);
  const data = JSON.parse(out.text);
  assert.equal(data.count, 2);
  assert.equal(data.totalDurationS, 5400);
  assert.equal(data.totalDistanceM, 15000);
  assert.equal(data.totalDurationHours, 1.5);
  assert.equal(data.totalDistanceKm, 15);
  assert.equal(data.workouts.length, 2);
});

test("resources: readResource throws on unknown uri", async () => {
  await assert.rejects(
    () => readResource("suunto://nope", {} as any),
    /Unknown resource/,
  );
});

// ---------- dates and windows: local calendar, not UTC ----------

test("resources: today/recovery and today/activity ask for today's local date", async () => {
  const seen: Record<string, string> = {};
  const fakeClient: any = {
    getRecovery: async (d: string) => ((seen.recovery = d), []),
    getDailyActivity: async (d: string) => ((seen.activity = d), []),
  };
  await readResource("suunto://today/recovery", fakeClient);
  await readResource("suunto://today/activity", fakeClient);
  assert.deepEqual(seen, { recovery: localDate(0), activity: localDate(0) });
});

test("resources: this-week starts at local Monday 00:00 and says which Monday", async () => {
  let since: number | undefined;
  const fakeClient: any = {
    listWorkouts: async (o: any) => {
      since = o.since;
      return { payload: [{ workoutKey: "k", activityId: 1, startTime: 1, totalTime: 3600, totalDistance: 10000 }] };
    },
  };
  const out = JSON.parse((await readResource("suunto://this-week/summary", fakeClient)).text);
  // independent computation, from local calendar fields
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  assert.equal(since, monday.getTime());
  assert.equal(out.weekStart, localDate(0, monday));
  assert.equal(new Date(out.weekStartISO).getTime(), monday.getTime());
  assert.equal(new Date(monday).getDay(), 1, "a Monday");
  assert.equal(out.count, 1);
  assert.equal(out.totalDistanceKm, 10);
});
