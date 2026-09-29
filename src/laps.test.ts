import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLabel, lapKind, shapeLaps, LAP_EXTENSIONS } from "./laps.js";

// Synthetic response in the live /v3/workouts/{key}?extensions=... shape.
const START = 1_790_000_000_000;
function marker(offsetS: number, durationS: number, hr: { min: number; avg: number; max: number } | null, energy: number, notes: string | null) {
  return {
    startTime: START + offsetS * 1000,
    endTime: START + (offsetS + durationS) * 1000,
    totals: { duration: durationS, energy, hr, intervalNotes: notes, cadence: null, power: null },
  };
}
function response(extensions: any[]) {
  return {
    error: null,
    payload: {
      workoutKey: "6aba8afee2ab172bb4c5fc8d",
      activityId: 23,
      startTime: START,
      totalTime: 2148.802,
      tssList: [
        { calculationMethod: "HR", trainingStressScore: 24.47175 },
        { calculationMethod: "MET", trainingStressScore: 33.425808 },
      ],
      extensions,
    },
    metadata: { ts: "x" },
  };
}
const GUIDED = response([
  {
    type: "ManualLapStreamExtension",
    markers: [
      marker(0, 20.04, { min: 80, avg: 95.4, max: 110 }, 3, "60kg 3x10\fBench press"),
      marker(20.04, 45.26, { min: 100, avg: 128.6, max: 150 }, 9, "Bench press\f60kg 3x10"),
      marker(65.3, 60, { min: 120, avg: 130, max: 140 }, 4, "Next: set 2/3"),
      marker(125.3, 3.2, { min: 118, avg: 119, max: 120 }, 0, "Session complete"),
    ],
  },
  { type: "IntensityExtension", zones: { heartRate: { zone1: { totalTime: 604.321 }, zone2: { totalTime: 1051.349 }, zone3: { totalTime: 485.114 }, zone4: { totalTime: 7 }, zone5: { totalTime: 0 } } } },
  { type: "SummaryExtension", pte: 2, peakEpoc: 14, recoveryTime: 12360, apps: [{ name: "MONDAY", authorId: "a", id: "yn8oz6vu" }] },
]);

test("shapeLaps: rows follow the column order and carry offsets, HR, kcal, kind and label", () => {
  const out = shapeLaps(GUIDED);
  assert.deepEqual(out.laps.cols, ["i", "startOffsetS", "durationS", "hrAvg", "hrMax", "hrMin", "kcal", "kind", "label"]);
  assert.equal(out.lapCount, 4);
  assert.deepEqual(out.laps.rows[0], [1, 0, 20, 95, 110, 80, 3, "step", "60kg 3x10 | Bench press"]);
  assert.deepEqual(out.laps.rows[1], [2, 20, 45.3, 129, 150, 100, 9, "step", "Bench press | 60kg 3x10"]);
  assert.deepEqual(out.laps.rows[2], [3, 65.3, 60, 130, 140, 120, 4, "rest", "Next: set 2/3"]);
  assert.deepEqual(out.laps.rows[3], [4, 125.3, 3.2, 119, 120, 118, 0, "done", "Session complete"]);
  for (const row of out.laps.rows) assert.equal(row.length, out.laps.cols.length);
});

test("shapeLaps: workout-level fields", () => {
  const out = shapeLaps(GUIDED);
  assert.equal(out.workoutKey, "6aba8afee2ab172bb4c5fc8d");
  assert.equal(out.activityId, 23);
  assert.equal(out.startTime, START);
  assert.equal(out.totalTimeS, 2148.8);
  assert.deepEqual(out.guide, { id: "yn8oz6vu", name: "MONDAY" });
  assert.deepEqual(out.tss, [{ method: "HR", value: 24.5 }, { method: "MET", value: 33.4 }]);
  assert.equal(out.pte, 2);
  assert.equal(out.peakEpoc, 14);
  assert.equal(out.recoveryTime, 12360);
  assert.deepEqual(out.hrZoneTimeS, [604, 1051, 485, 7, 0]);
});

test("shapeLaps: a workout without the lap extension is an empty table, not an error", () => {
  const out = shapeLaps(response([{ type: "SummaryExtension", pte: 1, apps: [] }]));
  assert.equal(out.lapCount, 0);
  assert.deepEqual(out.laps.rows, []);
  assert.equal(out.guide, null);
  assert.equal(out.hrZoneTimeS, null);
  assert.equal(out.pte, 1);
});

test("shapeLaps: unguided laps have null labels and no kind — nothing is invented", () => {
  const out = shapeLaps(response([{ type: "ManualLapStreamExtension", markers: [marker(0, 60, { min: 90, avg: 100, max: 110 }, 5, null)] }]));
  assert.deepEqual(out.laps.rows[0], [1, 0, 60, 100, 110, 90, 5, null, null]);
});

test("shapeLaps: tolerates laps with no HR data and a payload without the envelope", () => {
  const bare = response([{ type: "ManualLapStreamExtension", markers: [marker(0, 30, null, 0, "x")] }]).payload;
  const out = shapeLaps(bare);
  assert.deepEqual(out.laps.rows[0], [1, 0, 30, null, null, null, 0, "step", "x"]);
});

test("shapeLaps: output is compact — a 35-lap session stays in the low kilobytes", () => {
  const markers = Array.from({ length: 35 }, (_, i) => marker(i * 40, 40, { min: 90, avg: 110, max: 130 }, 5, i % 2 ? "Next: set 2/3" : "Squat\f80kg 3x8"));
  const bytes = JSON.stringify(shapeLaps(response([{ type: "ManualLapStreamExtension", markers }]))).length;
  assert.ok(bytes < 4_000, `expected < 4 KB, got ${bytes} B`);
});

test("cleanLabel: joins guide-step lines, keeps null, drops blanks", () => {
  assert.equal(cleanLabel("Squat\f80kg 3x8"), "Squat | 80kg 3x8");
  assert.equal(cleanLabel("Squat\n80kg 3x8"), "Squat | 80kg 3x8");
  assert.equal(cleanLabel("Session complete"), "Session complete");
  assert.equal(cleanLabel(null), null);
  assert.equal(cleanLabel(undefined), null);
  assert.equal(cleanLabel(""), null);
  assert.equal(cleanLabel("  \f "), null);
  assert.equal(cleanLabel("Squat\f\f80kg 3x8\f"), "Squat | 80kg 3x8", "empty parts and trailing separators are dropped");
});

test("lapKind: rest, done, step, null — including the older per-exercise rest labels", () => {
  assert.equal(lapKind("Next: set 2/3"), "rest");
  // restMode 'stopwatch' prefixes the rest text with its target
  assert.equal(lapKind("90s target · Next: set 2/3"), "rest");
  assert.equal(lapKind("90s target ·Next: set 3/3"), "rest");
  // ...but only a real "Next:" marker counts
  assert.equal(lapKind("Nextdoor squat | 60kg"), "step");
  assert.equal(lapKind("Squat | Next set heavy"), "step", "no colon, not a rest marker");
  assert.equal(lapKind("Done | Session complete"), "step", "'Session complete' must be the whole label's start");
  assert.equal(lapKind("Next: Bench press → 60kg"), "rest");
  assert.equal(lapKind("Session complete"), "done");
  assert.equal(lapKind(""), "step", "callers pass null for no label; an empty string is not one");
  assert.equal(lapKind("Bench press | 60kg 3x10"), "step");
  assert.equal(lapKind(null), null);
});

test("LAP_EXTENSIONS: exact Suunto names (case-sensitive, with the Extension suffix)", () => {
  assert.deepEqual(LAP_EXTENSIONS, ["ManualLapStreamExtension", "SummaryExtension", "IntensityExtension"]);
});
