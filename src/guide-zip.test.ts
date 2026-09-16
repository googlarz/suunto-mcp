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
    { name: "Bench Press", detail: "60kg x10", sets: 3, restSec: 90 },
    { name: "Overhead Press", detail: "40kg x8", sets: 2, restSec: 60 },
  ],
};

test("buildStrengthGuideJson: a set step advances on a manualLap transition and has no createManualLap", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  const setStep = guide.steps[0];
  assert.equal(setStep.transitions[0].condition.type, "manualLap");
  assert.equal(setStep.createManualLap, undefined);
});

test("buildStrengthGuideJson: a rest step is a stopwatch (not a countdown) that advances on a manualLap transition", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  const restStep = guide.steps[1];
  assert.equal(restStep.transitions[0].condition.type, "manualLap");
  assert.equal(restStep.createManualLap, undefined);
  const durationField = restStep.fields.find((f: any) => f.type === "duration");
  assert.ok(durationField, "rest step must show a count-up duration field, not stepDurationCountdown");
  assert.equal(durationField.window, "step");
  assert.ok(!restStep.fields.some((f: any) => f.type === "stepDurationCountdown"));
});

test("buildStrengthGuideJson: set step title is the per-exercise set counter, not a global counter", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  // Steps: [set1/3, rest, set2/3, rest, set3/3, rest, set1/2, rest, set2/2, DONE]
  const secondExerciseFirstSet = guide.steps[6];
  assert.equal(secondExerciseFirstSet.title, "1/2");
});

test("buildStrengthGuideJson: rest step title is the session-wide exercise counter", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  const restAfterSecondExerciseFirstSet = guide.steps[7];
  assert.equal(restAfterSecondExerciseFirstSet.title, "2/2");
});

test("buildStrengthGuideJson: no rest step after the final set of the final exercise", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  const last = guide.steps[guide.steps.length - 2]; // step before DONE
  assert.equal(last.title, "2/2");
  assert.ok(
    last.fields.some((f: any) => f.type === "text" && f.value === "Overhead Press"),
    "must be the final set step (shows the exercise name), not a rest step",
  );
  assert.equal(guide.steps[guide.steps.length - 1].title, "DONE");
});

test("buildStrengthGuideJson: set and rest steps both show a live heartRate field", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  const setStep = guide.steps[0];
  const restStep = guide.steps[1];
  assert.ok(
    setStep.fields.some((f: any) => f.type === "heartRate"),
    "set step must include a heartRate field",
  );
  assert.ok(
    restStep.fields.some((f: any) => f.type === "heartRate"),
    "rest step must include a heartRate field",
  );
});
