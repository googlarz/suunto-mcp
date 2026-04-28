import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCES, readResource } from "./resources.js";

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

test("resources: readResource(today/sleep) calls getSleep with today's date", async () => {
  let receivedDate: string | undefined;
  const fakeClient: any = {
    getSleep: async (date: string) => {
      receivedDate = date;
      return { score: 88 };
    },
  };
  const out = await readResource("suunto://today/sleep", fakeClient);
  assert.match(receivedDate ?? "", /^\d{4}-\d{2}-\d{2}$/);
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
