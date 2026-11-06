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

test("buildStrengthGuideJson: no text field sharing a step with another field exceeds 40 chars, in any lapGranularity/restMode", () => {
  const longPlan = {
    ...strengthPlan,
    exercises: [
      { name: "Incline Dumbbell Bench Press With Pause", detail: "32.5kg each 4x10 tempo 3-1-1", sets: 2, restSec: 90, plates: "2x25+1x10+1x2.5+1x1.25/side" },
    ],
  };
  for (const lapGranularity of ["perSet", "perExercise"] as const) {
    for (const restMode of ["countdown", "stopwatch"] as const) {
      const guide = buildStrengthGuideJson({ ...longPlan, lapGranularity, restMode }, "app") as any;
      for (const step of guide.steps) {
        if (step.fields.length < 2) continue; // a lone text field (DONE) has no sibling to hide
        for (const f of step.fields) {
          if (f.type === "text") {
            assert.ok(f.value.length <= 40, `${lapGranularity}/${restMode} step "${step.title}": text is ${f.value.length} chars`);
          }
        }
      }
    }
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
  assert.equal(guide.steps[5].title, "1/2 - 3/3", "last set of exercise 1");
  assert.equal(guide.steps[6].fields[0].type, "heartRate");
  assert.ok(guide.steps[6].fields.some((f: any) => f.type === "duration"));
  assert.equal(guide.steps[7].title, "2/2 - 1/2", "first set of exercise 2");
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

test("buildStrengthGuideJson: rest between sets is titled E<i>/<N> REST and spells out the next set", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps[2].title, "1/2 REST");
  assert.equal(guide.steps[4].title, "1/2 REST");
  assert.ok(guide.steps[4].fields.some((f: any) => f.type === "text" && f.value === "Next: set 3/3"));
});

test("buildStrengthGuideJson: set step title carries the exercise counter and the per-exercise set counter", () => {
  const guide = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(guide.steps[7].title, "2/2 - 1/2");
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
  assert.equal(last.title, "2/2 - 2/2");
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

const planOf = (nEx: number, sets: number, extra: Record<string, unknown> = {}) => ({
  title: "T",
  date: "2026-01-01",
  exercises: Array.from({ length: nEx }, (_, i) => ({ name: `Ex${i + 1}`, detail: "10kg", sets, restSec: 60, ...extra })),
});

test("buildStrengthGuideJson: every step title is E<i>/<N> [S<k>/<S>] and fits 13 chars (1, 6, 12 exercises; 10 sets)", () => {
  for (const [n, sets] of [[1, 3], [6, 3], [12, 10]] as const) {
    for (const restMode of ["countdown", "stopwatch"] as const) {
      const guide = buildStrengthGuideJson({ ...planOf(n, sets), restMode }, "app") as any;
      for (const step of guide.steps) assert.ok(step.title.length <= 13, `"${step.title}" (${n} ex, ${sets} sets)`);
    }
  }
  const g = buildStrengthGuideJson(planOf(12, 10), "app") as any;
  const titles = g.steps.map((s: any) => s.title);
  assert.ok(titles.includes("10/12"), "prep of exercise 10");
  assert.ok(titles.includes("10/12 - 10/10"), "last set of exercise 10, 13 chars");
  assert.equal(titles.filter((t: string) => t === "12/12 - 9/10").length, 1, "set 9 only; the rest after it is REST");
  assert.ok(titles.includes("12/12 REST"));
  const one = buildStrengthGuideJson(planOf(1, 3), "app") as any;
  assert.deepEqual(one.steps.map((s: any) => s.title), ["1/1", "1/1 - 1/3", "1/1 REST", "1/1 - 2/3", "1/1 REST", "1/1 - 3/3", "DONE"]);
});

test("buildStrengthGuideJson: rest is titled 'E<i>/<N> REST' and keeps 'Next: set k/S' in its text", () => {
  const guide = buildStrengthGuideJson(planOf(6, 3), "app") as any;
  const rest = guide.steps[4]; // prep, s1, r1, s2, r2
  assert.equal(rest.title, "1/6 REST");
  assert.ok(rest.fields.some((f: any) => f.type === "text" && f.value === "Next: set 3/3"));
});

test("buildStrengthGuideJson: lapGranularity 'perExercise' work step is titled E<i>/<N>; prep too; DONE kept", () => {
  const guide = buildStrengthGuideJson({ ...planOf(3, 3), lapGranularity: "perExercise" }, "app") as any;
  assert.deepEqual(guide.steps.map((s: any) => s.title), ["1/3", "1/3", "2/3", "2/3", "3/3", "3/3", "DONE"]);
});

test("buildStrengthGuideJson: restTargetHr adds targetHeartRate after heartRate on rests (countdown and stopwatch), before the duration field", () => {
  for (const restMode of ["countdown", "stopwatch"] as const) {
    const guide = buildStrengthGuideJson({ ...planOf(2, 3, { restTargetHr: 120 }), restMode }, "app") as any;
    const rest = guide.steps[2];
    const types = rest.fields.map((f: any) => f.type);
    assert.deepEqual(types.slice(0, 2), ["heartRate", "targetHeartRate"], restMode);
    assert.deepEqual(rest.fields[1], { type: "targetHeartRate", value: 80, min: 40, max: 120 });
    assert.equal(types[types.length - 1], "text", "text last");
    assert.ok(types.indexOf("targetHeartRate") < types.findIndex((t: string) => t === "duration" || t === "stepDurationCountdown"));
    assert.ok(rest.fields.length <= 4);
    for (const f of rest.fields) if (f.type === "text") assert.ok(f.value.length <= 40);
    // set and prep steps are untouched
    for (const i of [0, 1]) assert.ok(!guide.steps[i].fields.some((f: any) => f.type === "targetHeartRate"));
  }
});

test("buildStrengthGuideJson: without restTargetHr rests are unchanged; restTargetHr applies per exercise", () => {
  const plain = buildStrengthGuideJson(planOf(1, 3), "app") as any;
  assert.deepEqual(plain.steps[2].fields.map((f: any) => f.type), ["heartRate", "stepDurationCountdown", "text"]);
  const mixed = buildStrengthGuideJson(
    { title: "T", date: "2026-01-01", exercises: [
      { name: "A", detail: "d", sets: 2, restSec: 60, restTargetHr: 110 },
      { name: "B", detail: "d", sets: 2, restSec: 60 },
    ] },
    "app",
  ) as any;
  assert.ok(mixed.steps[2].fields.some((f: any) => f.type === "targetHeartRate"));
  assert.ok(!mixed.steps[6].fields.some((f: any) => f.type === "targetHeartRate"));
});

test("buildStrengthGuideJson: rejects restTargetHr outside 40-200 or non-integer", () => {
  for (const bad of [39, 201, 120.5, NaN]) {
    assert.throws(() => buildStrengthGuideJson(planOf(1, 2, { restTargetHr: bad }), "app"), /restTargetHr/, String(bad));
  }
  for (const ok of [40, 200]) assert.doesNotThrow(() => buildStrengthGuideJson(planOf(1, 2, { restTargetHr: ok }), "app"));
});

test("buildStrengthGuideJson: description lists the exercises joined with ' · ' and is capped at 60 chars", () => {
  const g = buildStrengthGuideJson(strengthPlan, "app") as any;
  assert.equal(g.description, "Bench Press · Overhead Press");
  assert.equal(g.shortDescription, "Push A");
  const long = buildStrengthGuideJson(planOf(12, 1), "app") as any;
  assert.ok(long.description.length <= 60);
  assert.ok(long.description.startsWith("Ex1 · Ex2 · Ex3"));
  const huge = buildStrengthGuideJson({ ...planOf(1, 1), exercises: [{ name: "x".repeat(100), detail: "d", sets: 1, restSec: 1 }] }, "app") as any;
  assert.equal(huge.description.length, 60);
});

const textOf = (step: any) => step.fields.find((f: any) => f.type === "text").value as string;
const oneEx = (ex: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  buildStrengthGuideJson({ title: "T", date: "2026-01-01", exercises: [{ name: "Name", detail: "d", sets: 2, restSec: 60, ...ex }], ...extra } as any, "app") as any;

test("two-line text: 24-char name + 16-char detail is 41 chars, so the name is cut to 23 and the detail survives", () => {
  const g = oneEx({ name: "N".repeat(24), detail: "D".repeat(16) });
  assert.equal(textOf(g.steps[1]), `${"N".repeat(23)}\n${"D".repeat(16)}`);
  assert.equal(textOf(g.steps[1]).length, 40);
});

test("two-line text: 23+16 and shorter are untouched", () => {
  const g = oneEx({ name: "N".repeat(23), detail: "D".repeat(16) });
  assert.equal(textOf(g.steps[1]), `${"N".repeat(23)}\n${"D".repeat(16)}`);
  assert.equal(textOf(oneEx({ name: "Bench", detail: "60kg 3x10" }).steps[1]), "Bench\n60kg 3x10");
});

test("two-line text: very long name is cut to fit; long detail is capped at 38 and the name keeps at least 1 char", () => {
  const long = oneEx({ name: "N".repeat(100), detail: "60kg 3x10" });
  assert.equal(textOf(long.steps[1]), `${"N".repeat(30)}\n60kg 3x10`);
  const longDetail = oneEx({ name: "Squat", detail: "D".repeat(60) });
  assert.equal(textOf(longDetail.steps[1]), `S\n${"D".repeat(38)}`);
  assert.equal(textOf(longDetail.steps[1]).length, 40);
});

test("prep text: the load/plates line survives and the name on line 2 is cut; plates capped at 38", () => {
  const p = oneEx({ name: "N".repeat(50), detail: "60kg 3x10", plates: "2x20+1x5/side" });
  assert.equal(textOf(p.steps[0]), `2x20+1x5/side\n${"N".repeat(26)}`);
  assert.equal(textOf(p.steps[0]).length, 40);
  const noPlates = oneEx({ name: "N".repeat(50), detail: "60kg 3x10" });
  assert.equal(textOf(noPlates.steps[0]), `60kg 3x10\n${"N".repeat(30)}`);
  const longPlates = oneEx({ name: "Squat", plates: "P".repeat(60) });
  assert.equal(textOf(longPlates.steps[0]), `${"P".repeat(38)}\nS`);
  assert.equal(textOf(oneEx({ name: "Bench", detail: "60kg 3x10" }).steps[0]), "60kg 3x10\nBench");
});

test("perExercise work text uses the same budget", () => {
  const g = oneEx({ name: "N".repeat(50), detail: "60kg 3x10" }, { lapGranularity: "perExercise" });
  assert.equal(textOf(g.steps[1]), `${"N".repeat(30)}\n60kg 3x10`);
});

test("set notifications: SET k/S with 'name - detail'; LAST SET with next exercise or own name - detail", () => {
  const g = buildStrengthGuideJson(strengthPlan, "app") as any;
  // [prep1, s1, r, s2, r, s3, prep2, s1, r, s2, DONE]
  assert.deepEqual(g.steps[1].notification, { title: "SET 1/3", text: "Bench Press - 60kg 3x10" });
  assert.deepEqual(g.steps[3].notification, { title: "SET 2/3", text: "Bench Press - 60kg 3x10" });
  assert.deepEqual(g.steps[5].notification, { title: "LAST SET", text: "Next: Overhead Press" }, "last set, not last exercise");
  assert.deepEqual(g.steps[7].notification, { title: "SET 1/2", text: "Overhead Press - 40kg 2x8" });
  assert.deepEqual(g.steps[9].notification, { title: "LAST SET", text: "Overhead Press - 40kg 2x8" }, "last set of last exercise");
  assert.equal(g.steps[0].notification, undefined);
  assert.equal(g.steps[2].notification, undefined);
});

test("set notifications: a single-set exercise is LAST SET; text is capped at 54", () => {
  const g = oneEx({ sets: 1, name: "N".repeat(80), detail: "d" });
  assert.equal(g.steps[1].notification.title, "LAST SET");
  assert.equal(g.steps[1].notification.text.length, 54);
  const next = buildStrengthGuideJson({ ...planOf(2, 1), exercises: [{ name: "A", detail: "d", sets: 1, restSec: 1 }, { name: "B".repeat(80), detail: "d", sets: 1, restSec: 1 }] }, "app") as any;
  assert.equal(next.steps[1].notification.text.length, 54);
  assert.match(next.steps[1].notification.text, /^Next: B+$/);
});

test("perExercise work step keeps the GO notification", () => {
  const g = buildStrengthGuideJson({ ...strengthPlan, lapGranularity: "perExercise" }, "app") as any;
  assert.equal(g.steps[1].notification.title, "GO");
});
