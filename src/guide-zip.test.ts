import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIntervalGuideJson, buildStrengthGuideJson } from "./guide-zip.js";

const basePlan = (segments: any[]) => ({
  title: "Test",
  date: "2026-01-01",
  blocks: [{ segments }],
});

test("buildIntervalGuideJson: rejects a segment with neither durationSec nor distanceM", () => {
  assert.throws(
    () => buildIntervalGuideJson(basePlan([{ label: "Recovery" }]), "app"),
    /exactly one of durationSec or distanceM/,
  );
});

test("buildIntervalGuideJson: rejects a segment with both durationSec and distanceM", () => {
  assert.throws(
    () => buildIntervalGuideJson(basePlan([{ label: "Interval", durationSec: 60, distanceM: 400 }]), "app"),
    /exactly one of durationSec or distanceM/,
  );
});

test("buildIntervalGuideJson: accepts a segment with exactly one of durationSec/distanceM and gives it a transition", () => {
  const guide = buildIntervalGuideJson(basePlan([{ label: "Interval", durationSec: 60 }]), "app") as any;
  const step = guide.steps[0];
  assert.ok(step.transitions, "step must have a transitions object to auto-advance");
  assert.equal(step.transitions[0].condition.type, "stepDuration");
});

const strengthPlan = {
  title: "Push A",
  date: "2026-01-01",
  exercises: [
    { name: "Bench Press", detail: "60kg 3x10", sets: 3, restSec: 90 },
    { name: "Overhead Press", detail: "40kg 2x8", sets: 2, restSec: 60 },
  ],
};

// Default flow (countdown rest, perSet) for strengthPlan:
// [prep1, set1/3, rest, set2/3, rest, set3/3, prep2, set1/2, rest, set2/2, DONE]
test("buildStrengthGuideJson: every exercise starts with a self-paced prep stopwatch showing weight/sets, name and HR", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  for (const [i, title, name, detail] of [
    [0, "1/2", "Bench Press", "60kg 3x10"],
    [6, "2/2", "Overhead Press", "40kg 2x8"],
  ] as const) {
    const prep = guide.steps[i];
    assert.equal(prep.title, title, "prep carries the exercise counter");
    assert.deepEqual(prep.fields[0], { type: "heartRate", title: "HR" }, "HR must be first so it actually renders");
    assert.ok(prep.fields.some((f: any) => f.type === "duration" && f.window === "step"));
    assert.ok(prep.fields.some((f: any) => f.type === "text" && f.value === `${detail}\n${name}`));
    assert.equal(prep.transitions[0].condition.type, "manualLap");
    assert.ok(!prep.fields.some((f: any) => f.type === "stepDurationCountdown"), "prep is never a countdown");
  }
});

test("buildStrengthGuideJson: prep shows plates instead of detail when given; falls back to detail when absent", () => {
  const planWithPlates = {
    ...strengthPlan,
    exercises: [
      { ...strengthPlan.exercises[0], plates: "2x20+1x5/side" },
      strengthPlan.exercises[1], // no plates — e.g. a dumbbell exercise
    ],
  };
  const guide = buildStrengthGuideJson(planWithPlates, "app") as any;
  assert.ok(
    guide.steps[0].fields.some((f: any) => f.type === "text" && f.value === "2x20+1x5/side\nBench Press"),
    "prep uses plates over detail when given",
  );
  assert.ok(
    !guide.steps[0].fields.some((f: any) => f.type === "text" && f.value.includes("60kg 3x10")),
    "raw detail must not also appear on prep once plates is given",
  );
  assert.ok(
    guide.steps[6].fields.some((f: any) => f.type === "text" && f.value === "40kg 2x8\nOverhead Press"),
    "prep falls back to detail when plates is omitted",
  );
  // Set steps are unaffected by plates — still show detail, not plate math.
  assert.ok(guide.steps[1].fields.some((f: any) => f.type === "text" && f.value.includes("60kg 3x10")));
});

test("buildStrengthGuideJson: no countdown between exercises — the step before the next exercise's first set is its prep stopwatch", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps[5].title, "3/3", "last set of exercise 1");
  assert.equal(guide.steps[6].fields[0].type, "heartRate");
  assert.ok(guide.steps[6].fields.some((f: any) => f.type === "duration"));
  assert.equal(guide.steps[7].title, "1/2", "first set of exercise 2");
});

test("buildStrengthGuideJson: a set step advances on a manualLap transition", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps[1].transitions[0].condition.type, "manualLap");
});

test("buildStrengthGuideJson: default rest between sets is a countdown that auto-advances", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  const restStep = guide.steps[2];
  assert.ok(restStep.fields.some((f: any) => f.type === "stepDurationCountdown" && f.value === 90));
  assert.equal(restStep.transitions[0].condition.type, "stepDuration");
  assert.equal(restStep.transitions[0].condition.value, 90);
});

test("buildStrengthGuideJson: rest between sets shows the set counter and spells out the next set", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps[2].title, "1/3");
  assert.equal(guide.steps[4].title, "2/3");
  assert.ok(guide.steps[4].fields.some((f: any) => f.type === "text" && f.value === "Next: set 3/3"));
});

test("buildStrengthGuideJson: set step title is the per-exercise set counter, not a global counter", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps[7].title, "1/2");
});

test("buildStrengthGuideJson: sets after an auto-advanced countdown rest get createManualLap; the first set (after prep) does not", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps[1].createManualLap, undefined, "set 1 follows a lap-ended prep");
  assert.equal(guide.steps[3].createManualLap, true, "set 2 follows a countdown rest with no button press");
  assert.equal(guide.steps[5].createManualLap, true);
  assert.equal(guide.steps[7].createManualLap, undefined, "first set of exercise 2 follows prep");
  assert.equal(guide.steps[9].createManualLap, true);
});

test("buildStrengthGuideJson: no rest step after the final set of the final exercise", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps.length, 11);
  const last = guide.steps[guide.steps.length - 2]; // step before DONE
  assert.equal(last.title, "2/2");
  assert.ok(
    last.fields.some((f: any) => f.type === "text" && f.value === "Overhead Press\n40kg 2x8"),
    "must be the final set step (shows the exercise name), not a rest step",
  );
  assert.equal(guide.steps[guide.steps.length - 1].title, "DONE");
});

test("buildStrengthGuideJson: prep, set and rest steps all show a live heartRate field", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  for (const i of [0, 1, 2]) {
    assert.ok(
      guide.steps[i].fields.some((f: any) => f.type === "heartRate"),
      `step ${i} must include a heartRate field`,
    );
  }
});

test("buildStrengthGuideJson: restMode 'stopwatch' counts up, advances on a lap press, and needs no createManualLap", () => {
  const guide = buildStrengthGuideJson({ ...strengthPlan, restMode: "stopwatch" }, "app") as any;
  const restStep = guide.steps[2];
  assert.deepEqual(restStep.fields[0], { type: "heartRate", title: "HR" }, "HR must be first so it actually renders");
  assert.ok(restStep.fields.some((f: any) => f.type === "duration" && f.window === "step"));
  assert.ok(!restStep.fields.some((f: any) => f.type === "stepDurationCountdown"));
  assert.equal(restStep.transitions[0].condition.type, "manualLap");
  assert.equal(guide.steps[3].createManualLap, undefined, "the lap press already marks the set start");
});

test("buildStrengthGuideJson: lapGranularity 'perExercise' gives prep + one step per exercise, no between-set rests", () => {
  const guide = buildStrengthGuideJson({ ...strengthPlan, lapGranularity: "perExercise" }, "app") as any;
  // [prep1, ex1, prep2, ex2, DONE]
  assert.equal(guide.steps.length, 5);
  assert.equal(guide.steps[0].fields[0].type, "heartRate");
  assert.ok(guide.steps[0].fields.some((f: any) => f.type === "duration"));
  assert.equal(guide.steps[1].fields[0].type, "heartRate", "HR must be first on the exercise step too");
  assert.ok(guide.steps[1].fields.some((f: any) => f.type === "text" && f.value === "Bench Press\n60kg 3x10"));
  assert.equal(guide.steps[2].fields[0].type, "heartRate");
  assert.equal(guide.steps[guide.steps.length - 1].title, "DONE");
});
