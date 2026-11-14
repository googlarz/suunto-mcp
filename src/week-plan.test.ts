import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustStrengthGuide, planWeek } from "./week-plan.js";

const guide = () => ({
  title: "Push A",
  date: "2026-11-16",
  exercises: [
    { name: "Bench Press", detail: "60kg 3x10", sets: 3, restSec: 90, plates: "1x20+1x5/side", last: "3x10@57.5kg", target: "3x10@62.5kg" },
    { name: "Overhead Press", detail: "40kg 2x8", sets: 2, restSec: 60 },
    { name: "Pull-up", detail: "BW 4x6", sets: 4, restSec: 90 },
    { name: "Plank", detail: "3 rounds", sets: 3, restSec: 30 },
  ],
});

// ---------- adjustStrengthGuide ----------

test("adjust: no signal below the band, or no reading at all, leaves the guide as it is and says why", () => {
  for (const readiness of [{ hrv: "within", recoveryMorning: "above" }, { hrv: "above" }] as const) {
    const r = adjustStrengthGuide(guide(), readiness);
    assert.equal(r.level, "unchanged");
    assert.equal(r.adjusted, false);
    assert.deepEqual(r.guide, guide());
    assert.match(r.reasons.join(" "), /not below your band.*never adds load/);
  }
  const none = adjustStrengthGuide(guide(), { hrv: null });
  assert.equal(none.level, "unchanged");
  assert.match(none.reasons.join(" "), /No HRV or recovery reading/);
  assert.deepEqual(adjustStrengthGuide(guide(), {}).signals, { hrv: null, recoveryMorning: null });
});

test("adjust: one signal below -> one set less on exercises with 3+ sets, loads untouched", () => {
  const input = guide();
  const r = adjustStrengthGuide(input, { hrv: "below", recoveryMorning: "within" });
  assert.equal(r.level, "lighter");
  assert.equal(r.adjusted, true);
  assert.match(r.reasons.join(" "), /HRV below your usual band/);
  const [bench, ohp, pullup, plank] = r.guide.exercises;
  assert.deepEqual([bench.sets, bench.detail], [2, "60kg 2x10"]);
  assert.deepEqual([ohp.sets, ohp.detail], [2, "40kg 2x8"], "2 sets stay");
  assert.deepEqual([pullup.sets, pullup.detail], [3, "BW 3x6"]);
  // a detail with no "<sets>x<reps>" cannot be rewritten, so its sets stay and the reason says so
  assert.deepEqual([plank.sets, plank.detail], [3, "3 rounds"]);
  assert.match(r.reasons.join(" "), /Plank: .*no 'NxM'/);
  assert.equal(bench.plates, "1x20+1x5/side", "load unchanged, plates stay");
  assert.equal(bench.last, "3x10@57.5kg");
  assert.equal(bench.target, undefined, "a target built for a normal day no longer applies");
  assert.match(r.reasons.join(" "), /Bench Press: target removed/, "the removal is explained, also when only a set was cut");
  assert.doesNotMatch(r.reasons.join(" "), /Overhead Press: target removed/, "an unchanged exercise keeps its target");
  assert.deepEqual(r.changes[0], { exercise: "Bench Press", from: { sets: 3, detail: "60kg 3x10" }, to: { sets: 2, detail: "60kg 2x10" } });
  assert.deepEqual(input, guide(), "the input is not modified");
});

test("adjust: both signals below -> one set less and loads about 10% lower (2.5 kg steps); bodyweight and plates handled", () => {
  const r = adjustStrengthGuide(guide(), { hrv: "below", recoveryMorning: "below" });
  assert.equal(r.level, "reduced");
  const [bench, ohp, pullup] = r.guide.exercises;
  // 60 kg x 0.9 = 54 -> 55; plates described the old load, so they are dropped (detail carries the load)
  assert.deepEqual([bench.sets, bench.detail, bench.plates], [2, "55kg 2x10", undefined]);
  // 40 x 0.9 = 36 -> 35; two sets are kept
  assert.deepEqual([ohp.sets, ohp.detail], [2, "35kg 2x8"]);
  assert.deepEqual([pullup.sets, pullup.detail], [3, "BW 3x6"], "bodyweight has no load to cut");
  assert.match(r.reasons.join(" "), /HRV and recovery on waking below your usual band/);
  assert.match(r.reasons.join(" "), /Bench Press: plates removed/);
});

test("adjust: a load too light to lower by a step is kept; a guide with nothing to reduce says so", () => {
  const r = adjustStrengthGuide({ title: "T", date: "2026-11-16", exercises: [{ name: "Curl", detail: "5kg 2x12", sets: 2, restSec: 60 }] }, { hrv: "below", recoveryMorning: "below" });
  assert.equal(r.adjusted, false);
  assert.equal(r.guide.exercises[0].detail, "5kg 2x12");
  assert.match(r.reasons.join(" "), /nothing to reduce/i);
});

// ---------- planWeek ----------

const week = () => [guide(), { ...guide(), title: "Pull B", date: "2026-11-18" }, { ...guide(), title: "Legs C", date: "2026-11-20" }];
const spy = () => {
  const calls: { title: string; zip: Buffer }[] = [];
  return {
    calls,
    push: async (zip: Buffer, title: string) => {
      calls.push({ title, zip });
      return { data: { id: `g${calls.length}` }, check: { verified: true } };
    },
  };
};
const ok = () => [] as string[];

test("planWeek: dryRun validates and reports what would be pushed, and never calls push", async () => {
  const s = spy();
  const r = await planWeek(week(), { dryRun: true, appName: undefined, validate: ok, push: s.push });
  assert.equal(s.calls.length, 0, "zero write calls");
  assert.equal(r.dryRun, true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.wouldPush!.map((g) => [g.date, g.title, g.exercises, g.sets]), [["2026-11-16", "Push A", 4, 12], ["2026-11-18", "Pull B", 4, 12], ["2026-11-20", "Legs C", 4, 12]]);
  assert.match(r.notes.join(" "), /dryRun: false/);
});

test("planWeek: dryRun still refuses an invalid plan, and so does a real push, before any call", async () => {
  const bad: [unknown[], RegExp][] = [
    [[], /at least one guide/],
    [[guide(), { ...guide(), title: "Dup" }], /2026-11-16 .* more than once/],
    [[{ ...guide(), guideId: "abc" }], /guideId/],
    [[{ ...guide(), exercises: [{ name: "A", detail: "x", sets: 3, restSec: 60, restTargetHr: 30 }] }], /restTargetHr/],
    [Array.from({ length: 15 }, (_, i) => ({ ...guide(), date: `2026-11-${String(i + 1).padStart(2, "0")}` })), /at most 14/],
  ];
  for (const dryRun of [true, false]) {
    for (const [guides, re] of bad) {
      const s = spy();
      await assert.rejects(planWeek(guides, { dryRun, appName: "app", validate: ok, push: s.push }), re);
      assert.equal(s.calls.length, 0);
    }
  }
  // the schema check of the caller is applied to every guide, naming its position
  await assert.rejects(planWeek(week(), { dryRun: true, appName: "app", validate: (g: any) => (g.title === "Pull B" ? ["missing required property \"date\""] : []), push: spy().push }), /guides\[1\]: missing required property "date"/);
});

test("planWeek: a real push needs the app name, then pushes one new guide per date in date order", async () => {
  const s = spy();
  await assert.rejects(planWeek(week(), { dryRun: false, appName: undefined, validate: ok, push: s.push }), /SUUNTO_APP_NAME/);
  assert.equal(s.calls.length, 0);
  const shuffled = [week()[2], week()[0], week()[1]];
  const r = await planWeek(shuffled, { dryRun: false, appName: "app", validate: ok, push: s.push });
  assert.deepEqual(s.calls.map((c) => c.title), ["Push A", "Pull B", "Legs C"]);
  assert.equal(r.dryRun, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.pushed!.map((g) => [g.date, g.id, g.check]), [["2026-11-16", "g1", { verified: true }], ["2026-11-18", "g2", { verified: true }], ["2026-11-20", "g3", { verified: true }]]);
  assert.match(r.notes.join(" "), /again creates new guides/);
});

test("planWeek: the first failure stops the push and names what was pushed, what failed and what was left", async () => {
  const calls: string[] = [];
  const push = async (_zip: Buffer, title: string) => {
    calls.push(title);
    if (title === "Pull B") throw new Error("403 Forbidden");
    return { data: { id: "g" }, check: { verified: true } };
  };
  const r = await planWeek(week(), { dryRun: false, appName: "app", validate: ok, push });
  assert.deepEqual(calls, ["Push A", "Pull B"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.pushed!.map((g) => g.date), ["2026-11-16"]);
  assert.deepEqual(r.failed, { date: "2026-11-18", error: "403 Forbidden" });
  assert.deepEqual(r.notPushed, ["2026-11-20"]);
});
