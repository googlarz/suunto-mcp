import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { compareWorkout, detailSets, norm, type PlanItem } from "./compare.js";
import { LAP_COLUMNS, lapChecks, lapKind, type shapeLaps } from "./laps.js";

type Laps = Parameters<typeof compareWorkout>[0];

// ---------- fixtures: every case in test-fixtures/compare/ ----------

const dir = new URL("../test-fixtures/compare/", import.meta.url);
const readJson = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const cases = readdirSync(dir)
  .filter((f) => f.endsWith(".laps.json"))
  .map((f) => f.replace(/\.laps\.json$/, ""))
  .sort();

test("fixtures: the ten cases of the design are all present", () => {
  assert.deepEqual(cases, ["checks-split-rest", "clean-3ex", "ended-early", "extra-set", "missing-set", "no-laps", "per-exercise", "stopwatch", "unguided", "workout-guide"]);
});

for (const name of cases) {
  test(`fixture ${name}: compareWorkout output equals ${name}.expected.json`, () => {
    const laps = readJson(`${name}.laps.json`) as Laps;
    const planFile = `${name}.plan.json`;
    const plan = existsSync(new URL(planFile, dir)) ? (readJson(planFile) as PlanItem[]) : undefined;
    assert.deepEqual(laps.laps.rows.map((r) => r[7]), laps.laps.rows.map((r) => lapKind(r[8] as string | null)), "fixture kind column equals lapKind(label)");
    assert.deepEqual(laps.checks, lapChecks(laps.laps.rows), "fixture checks equal lapChecks(rows)");
    assert.deepEqual(compareWorkout(laps, plan), readJson(`${name}.expected.json`));
  });
}

// ---------- helpers for synthetic tables ----------

// [label, durationS, hr]: hr is the lap's average; max and min are +10 / -10. null = no heart rate.
type Spec = [label: string | null, durationS: number, hr?: number | null];

function table(specs: Spec[]): Laps {
  const rows = specs.map(([label, durationS, hr = 100], k) => [k + 1, 0, durationS, hr, hr === null ? null : hr + 10, hr === null ? null : hr - 10, 1, lapKind(label), label]);
  return {
    workoutKey: "synthetic", activityId: 23, startTime: 0, totalTimeS: 0, guide: null, tss: [], pte: null, peakEpoc: null,
    recoveryTime: null, hrZoneTimeS: null, feeling: null, lapCount: rows.length, checks: lapChecks(rows),
    laps: { cols: LAP_COLUMNS, rows },
  } as unknown as ReturnType<typeof shapeLaps>;
}

const DONE: Spec = ["Session complete", 3];

// prep, then sets with a rest before each set after the first (labelled for S sets)
function exercise(name: string, detail: string, setDurs: number[], S: number, restS: number, target?: number): Spec[] {
  const out: Spec[] = [[`${detail} | ${name}`, 60]];
  setDurs.forEach((d, i) => {
    if (i > 0) out.push([`${target === undefined ? "" : `${target}s target · `}Next: set ${i + 1}/${S}`, restS]);
    out.push([`${name} | ${detail}`, d]);
  });
  return out;
}

const codes = (t: Laps, plan?: PlanItem[]) => compareWorkout(t, plan).deviations.map((d) => d.code);

// ---------- helpers ----------

test("norm: case, hyphens, degree signs and diacritics", () => {
  assert.equal(norm("Push-Up"), norm("push up"));
  assert.equal(norm("Push-Up"), "push up");
  assert.equal(norm("Bench Press 15°"), "bench press 15");
  assert.equal(norm("Überzug"), "uberzug");
});

test("detailSets: the last N x R token", () => {
  const cases: [string | null, number | null][] = [
    ["100kg 3x5", 3], ["BW 3x15", 3], ["2x32kg 3x40m", 3], ["3x45s", 3], ["15kg 3x8-12/side", 3], ["3 × 5", 3], ["heavy triple", null], [null, null],
  ];
  for (const [detail, want] of cases) assert.equal(detailSets(detail), want, String(detail));
});

// ---------- format detection ----------

test("format: perSet, workout with rests, a single step lap, perExercise", () => {
  const perSet = compareWorkout(table([...exercise("Squat", "100kg 3x5", [30, 30], 2, 90), DONE]));
  assert.equal(perSet.format, "strength-perSet");
  assert.equal(perSet.restMode, "countdown");
  const stopwatch = compareWorkout(table([...exercise("Squat", "100kg 3x5", [30, 30], 2, 90, 90), DONE]));
  assert.equal(stopwatch.restMode, "stopwatch");

  const workout = compareWorkout(table([["Push-Up | BW 3x15", 40], ["Next: Curl | 12kg 3x12", 30], ["Curl | 12kg 3x12", 40], DONE]));
  assert.equal(workout.format, "workout");
  assert.equal(workout.restMode, null);
  assert.equal(workout.baselineHr, null);

  const single = compareWorkout(table([["Push-Up | BW 3x15", 40], DONE]));
  assert.equal(single.format, "workout", "a one-exercise workout guide is step, done");

  const perExercise = compareWorkout(table([["3x5 | Squat", 60], ["Squat | 100kg 3x5", 100], ["BW | Pull-Up", 60], ["Pull-Up | BW 3x8", 90], DONE]));
  assert.equal(perExercise.format, "strength-perExercise");
});

test("format: mixed rest kinds, and a table whose only lap is 'Session complete', are unknown-label-format", () => {
  const mixed = compareWorkout(table([["Squat | 100kg 3x5", 30], ["Next: set 2/3", 90], ["Next: Curl | 12kg", 30], DONE]));
  assert.equal(mixed.status, "unknown-label-format");
  assert.equal(mixed.format, null);
  assert.equal(mixed.reliable, false);
  assert.match(mixed.note!, /match neither/);
  assert.equal(compareWorkout(table([DONE])).status, "unknown-label-format");
});

test("status: no laps and no guide labels give no analysis, and plan is ignored", () => {
  const plan = [{ name: "Squat" }];
  const none = compareWorkout(table([]), plan);
  assert.equal(none.status, "no-laps");
  assert.deepEqual([none.deviations, none.exercises, none.reliable], [[], [], false]);
  const unlabelled = compareWorkout(table([[null, 30], [null, 40]]), plan);
  assert.equal(unlabelled.status, "no-guide-labels");
  assert.deepEqual(unlabelled.deviations, []);
});

// ---------- the e2e stub table ----------

test("a stub-shaped table: prep, set 1, a 60 s stopwatch rest for set 2/3, Session complete", () => {
  const out = compareWorkout(table([["60kg 3x10 | Bench press", 20], ["Bench press | 60kg 3x10", 45], ["90s target · Next: set 2/3", 60], ["Session complete", 3]]));
  assert.deepEqual(out.deviations.map((d) => [d.code, d.basis, d.laps]), [
    ["unexpected-sequence", "labels", [3]],
    ["rest-short", "labels", [3]],
    ["missing-set", "labels", []],
  ]);
  assert.equal(out.deviations[2].detail, "1 of 3 sets recorded");
  assert.equal(out.reliable, false);
  assert.match(out.note!, /unexpected-sequence/);
});

// ---------- segmentation rules ----------

test("a null-label lap between a rest and a set is unattributed and the set still gets the rest's k", () => {
  const out = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["Next: set 2/2", 90], [null, 5], ["Squat | 100kg 3x5", 30], DONE]));
  assert.deepEqual(out.unattributed, [[4, 5, 100, 110]]);
  const unl = out.deviations.find((d) => d.code === "unlabelled-lap")!;
  assert.deepEqual(unl.laps, [4]);
  assert.deepEqual(out.exercises[0].sets.map((s) => s[0]), [1, 2]);
  assert.equal(out.reliable, false, "the unlabelled-laps check");
});

test("a rest before any step is unattributed and unexpected", () => {
  const out = compareWorkout(table([["Next: set 2/2", 90], ["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], DONE]));
  assert.deepEqual(out.unattributed, [[1, 90, 100, 110]]);
  const u = out.deviations.find((d) => d.code === "unexpected-sequence")!;
  assert.deepEqual([u.ex, u.laps, u.detail], [null, [1], "a rest lap before the first exercise"]);
  assert.equal(out.exercises.length, 1);
});

test("the set label changing within an exercise is unexpected", () => {
  const out = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["Next: set 2/2", 90], ["Squat | 105kg 3x5", 30], DONE]));
  const u = out.deviations.filter((d) => d.code === "unexpected-sequence");
  assert.deepEqual(u.map((d) => [d.ex, d.laps, d.detail]), [[1, [4], "this set's label differs from set 1's"]]);
});

test("prep and first set naming different exercises is unexpected; a one-part prep is not link-checked", () => {
  const differ = compareWorkout(table([["x | Squat", 60], ["Bench | y", 30], DONE]));
  const u = differ.deviations.find((d) => d.code === "unexpected-sequence")!;
  assert.deepEqual([u.ex, u.laps, u.detail], [1, [1, 2], "the prep and the first set name different exercises"]);
  const onePart = compareWorkout(table([["x".repeat(40), 60], ["Bench | y", 30], DONE]));
  assert.deepEqual(onePart.deviations, []);
});

test("a prep in front of Session complete, and a rest in front of it, are unexpected", () => {
  const afterPrep = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["60kg 3x8 | Row", 60], DONE]));
  assert.ok(afterPrep.deviations.some((d) => d.code === "unexpected-sequence" && d.detail === "'Session complete' straight after a prep lap" && d.laps[0] === 3));
  const afterRest = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["Next: set 2/2", 90], DONE]));
  assert.ok(afterRest.deviations.some((d) => d.code === "unexpected-sequence" && d.detail === "'Session complete' straight after a rest lap"));
});

// ---------- plan matching ----------

test("truncation: a one-part set label of raw length 40 matches the longer plan name by prefix; a two-part one does not", () => {
  const full = "Bulgarian Split Squat With Rear Foot Elevated";
  const cutName = full.slice(0, 40);
  const cut = compareWorkout(table([[`100kg 3x5 | ${cutName}`, 60], [cutName, 30], DONE]), [{ name: full }]);
  assert.equal(cut.exercises[0].name, cutName);
  assert.equal(cut.exercises[0].plan, 0);
  assert.deepEqual(cut.deviations, []);

  const name = "A".repeat(19);
  const twoPart = table([["x | " + name, 60], [`${name} | ${"B".repeat(21)}`, 30], DONE]);
  const out = compareWorkout(twoPart, [{ name: `${name} Extended` }]);
  assert.equal(out.exercises[0].plan, null, "raw length 40 but two parts: not treated as cut");
  assert.deepEqual(out.deviations.map((d) => d.code), ["extra-exercise", "missing-exercise"]);
});

test("duplicate plan names match in order", () => {
  const out = compareWorkout(table([["BW | Plank", 60], ["Plank | BW 3x45s", 150], ["BW | Plank", 60], ["Plank | BW 3x45s", 150], DONE]), [{ name: "Plank" }, { name: "Plank" }]);
  assert.deepEqual(out.exercises.map((e) => e.plan), [0, 1]);
  assert.deepEqual(out.deviations, []);
});

// ---------- heart rate ----------

test("no heart rate: HR fields and baselineHr are null, duration heuristics still run, and it is not a reason for reliable:false", () => {
  const t = table([["100kg 3x5 | Squat", 60, null], ["Squat | 100kg 3x5", 3, null], ["Next: set 2/3", 90, null], ["Squat | 100kg 3x5", 40, null], ["Next: set 3/3", 90, null], ["Squat | 100kg 3x5", 40, null], ["Session complete", 3, null]]);
  const out = compareWorkout(t);
  assert.deepEqual(out.checks.map((c) => c.code), ["no-heart-rate"]);
  assert.equal(out.baselineHr, null);
  assert.deepEqual(out.exercises[0].prep, [1, 60, null, null]);
  assert.deepEqual(out.exercises[0].sets[0], [1, 2, 3, null, null]);
  assert.deepEqual(out.exercises[0].rests[0], [2, 3, 90, 90, null, null, null, null]);
  assert.deepEqual(out.deviations.map((d) => d.code), ["short-set"]);
  assert.equal(out.reliable, true);
  assert.equal(out.note, null);
});

// ---------- sessions that stop early ----------

test("strength session stopped during the second exercise's prep (deviations without a lap sort last)", () => {
  const out = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["Next: set 2/2", 90], ["Squat | 100kg 3x5", 30], ["60kg 3x8 | Row", 60]]));
  const ex = out.exercises[1];
  assert.deepEqual([ex.n, ex.name, ex.detail, ex.sets, ex.prep], [2, "Row", null, [], [5, 60, 110, 90]]);
  assert.deepEqual(out.deviations.map((d) => [d.code, d.ex, d.laps, d.detail]), [
    ["ended-early", 2, [5], "no 'Session complete' lap: the recording stopped inside the guide; exercises after this one are not visible in the laps (pass plan to list them)"],
    ["missing-set", 2, [], "no set recorded: the session ended during the prep"],
  ]);
  assert.equal(out.complete, false);
  assert.equal(out.reliable, false);
});

test("workout session stopped during a rest: a not-started exercise named from the rest's Next label", () => {
  const out = compareWorkout(table([["Push-Up | BW 3x15", 40], ["Next: Curl | 12kg 3x12", 30]]));
  const ex = out.exercises[1];
  assert.deepEqual([ex.name, ex.detail, ex.sets, ex.planned.sets], ["Curl", "12kg 3x12", [], 3]);
  assert.deepEqual(out.deviations.map((d) => [d.code, d.ex, d.detail]), [
    ["ended-early", 2, "no 'Session complete' lap: the recording stopped inside the guide; exercises after this one are not visible in the laps (pass plan to list them)"],
    ["missing-set", 2, "the exercise was not started: the session ended during the rest before it"],
  ]);
});

// ---------- rest targets ----------

test("countdown target is the median of the uncut gaps; when every gap is cut it is null", () => {
  const sets = [30, 30, 30, 30];
  const t = (rests: number[]) => {
    const specs: Spec[] = [["100kg 4x5 | Squat", 60]];
    sets.forEach((d, i) => {
      if (i > 0) specs.push([`Next: set ${i + 1}/4`, rests[i - 1]]);
      specs.push(["Squat | 100kg 4x5", d]);
    });
    return [...specs, DONE];
  };
  const median = compareWorkout(table(t([60, 62, 100])));
  assert.equal(median.exercises[0].planned.restS, 62);
  assert.deepEqual(median.exercises[0].rests.map((r) => r[3]), [62, 62, 62]);

  const oneCut = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["Next: set 2/3", 60], ["Squat | 100kg 3x5", 30], ["Next: set 3/3", 25]]));
  assert.equal(oneCut.exercises[0].planned.restS, 60, "the cut gap does not count");
  assert.equal(oneCut.exercises[0].rests[1][3], 60);

  const allCut = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["Next: set 2/3", 25]]));
  assert.equal(allCut.exercises[0].planned.restS, null);
  assert.equal(allCut.exercises[0].rests[0][3], null);
});

test("stopwatch tolerance: max(10 s, 20% of the target), edges included", () => {
  const rest = (target: number, total: number) =>
    compareWorkout(table([...exercise("Squat", "100kg 2x5", [30, 30], 2, total, target), DONE])).deviations.map((d) => d.code);
  assert.deepEqual(rest(90, 108), [], "108 is within 90 + 18");
  assert.deepEqual(rest(90, 108.1), ["rest-long"]);
  assert.deepEqual(rest(90, 72), []);
  assert.deepEqual(rest(90, 71.9), ["rest-short"]);
  assert.deepEqual(rest(30, 40), [], "30 s target: tolerance is the 10 s minimum");
  assert.deepEqual(rest(30, 40.1), ["rest-long"]);
  assert.deepEqual(rest(30, 20), []);
  assert.deepEqual(rest(30, 19.9), ["rest-short"]);
});

test("short-set and long-set edges", () => {
  const sets = (d: number, m: number) => codes(table([...exercise("Squat", "100kg 3x5", [d, m, m], 3, 90), DONE]));
  assert.deepEqual(sets(9.9, 40), ["short-set"]);
  assert.deepEqual(sets(10, 40), [], "needs d < 10");
  assert.deepEqual(sets(80, 40), ["long-set"]);
  assert.deepEqual(sets(50, 25), [], "50 is 2x25 but only 25 s more");
  assert.deepEqual(sets(55, 25), ["long-set"]);
});

test("short-set and long-set are not judged on the last lap of an unfinished guide", () => {
  const out = compareWorkout(table([["100kg 3x5 | Squat", 60], ["Squat | 100kg 3x5", 30], ["Next: set 2/3", 90], ["Squat | 100kg 3x5", 30], ["Next: set 3/3", 90], ["Squat | 100kg 3x5", 2]]));
  assert.ok(!out.deviations.some((d) => d.code === "short-set"));
});

test("rest-target-mismatch: the plan's restSec against the guide's rest, tolerance 2 s", () => {
  const session = table([...exercise("Squat", "100kg 2x5", [30, 30], 2, 120), DONE]);
  const mismatch = (restSec: number) => codes(session, [{ name: "Squat", restSec }]);
  assert.deepEqual(mismatch(90), ["rest-target-mismatch"]);
  assert.deepEqual(mismatch(122), []);
  assert.deepEqual(mismatch(123), ["rest-target-mismatch"]);
  assert.equal(compareWorkout(session, [{ name: "Squat", restSec: 90 }]).deviations[0].detail, "the guide's rest was 120 s, the plan has 90 s");
});

test("plan sets: extra-set lists the laps beyond the plan, missing-set has none", () => {
  const session = table([...exercise("Squat", "100kg 3x5", [30, 30, 30], 3, 90), DONE]);
  const extra = compareWorkout(session, [{ name: "Squat", sets: 2 }]).deviations;
  assert.deepEqual(extra.map((d) => [d.code, d.basis, d.laps, d.plan]), [["extra-set", "plan", [6], 0]]);
  const missing = compareWorkout(session, [{ name: "Squat", sets: 4 }]).deviations;
  assert.deepEqual(missing.map((d) => [d.code, d.basis, d.laps, d.detail]), [["missing-set", "plan", [], "3 of 4 planned sets recorded"]]);
});

// ---------- size ----------

test("size: a 35-lap perSet session (17 sets) serialises below 4,000 bytes", () => {
  const specs: Spec[] = [];
  for (const [name, S] of [["Back Squat", 5], ["Bench Press", 4], ["Barbell Row", 4], ["Overhead Press", 4]] as const) {
    specs.push(...exercise(name, `80kg ${S}x5`, Array(S).fill(34), S, 120));
  }
  const t = table([...specs, DONE]);
  assert.equal(t.lapCount, 35);
  const text = JSON.stringify(compareWorkout(t));
  assert.ok(text.length < 4_000, `got ${text.length} B`);
});
