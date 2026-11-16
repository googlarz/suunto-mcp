import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_TSS_SESSIONS, PRIOR_DAYS, TSB_RISK_FLOOR, WEEKLY_JUMP_PCT, estimateTss, guideNameOf, median, projectLoad, roundPoint, tsbFloorCheck, weekLoad } from "./plan-load.js";
import { addDays, rollForward } from "./training-load.js";

const row = (guide: string | null, tss: number | null | undefined) => ({
  extensions: guide === null ? [] : [{ type: "SummaryExtension", apps: [{ name: guide }] }],
  ...(tss === undefined ? {} : tss === null ? { tss: {} } : { tss: { trainingStressScore: tss } }),
});

test("guideNameOf: the name of the guide in the list's SummaryExtension, else null", () => {
  assert.equal(guideNameOf(row("PUSH A", 50)), "PUSH A");
  assert.equal(guideNameOf(row(null, 50)), null);
  assert.equal(guideNameOf({}), null);
  assert.equal(guideNameOf({ extensions: [{ type: "Other", apps: [{ name: "x" }] }] }), null);
  assert.equal(guideNameOf({ extensions: [{ type: "SummaryExtension", apps: [{ name: "" }] }] }), null);
});

test("median: middle value, mean of the middle two, null when empty", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("estimateTss: the median TSS of the sessions of that title; at least 2 are needed (1 is not enough, 2 is)", () => {
  assert.equal(MIN_TSS_SESSIONS, 2);
  assert.deepEqual(estimateTss([row("PUSH A", 60)], "PUSH A"), { tss: null, sessions: 1 });
  assert.deepEqual(estimateTss([row("PUSH A", 60), row("PUSH A", 50)], "PUSH A"), { tss: 55, sessions: 2 });
  assert.deepEqual(estimateTss([row("PUSH A", 60), row("PUSH A", 50), row("PUSH A", 90)], "push-a"), { tss: 60, sessions: 3 }, "case and punctuation ignored; a median, not a mean");
  assert.deepEqual(estimateTss([row("PUSH A", 60.04), row("PUSH A", 60.05)], "PUSH A"), { tss: 60, sessions: 2 }, "rounded to 1 decimal");
});

test("estimateTss: another title, no guide and a session without a TSS count for nothing (no TSS is no evidence of 0)", () => {
  const rows = [row("PULL B", 80), row("PULL B", 70), row(null, 90), row("PUSH A", null), row("PUSH A", undefined), row("PUSH A", 40)];
  assert.deepEqual(estimateTss(rows, "PUSH A"), { tss: null, sessions: 1 }, "only one PUSH A has a TSS");
  assert.deepEqual(estimateTss(rows, "PULL B"), { tss: 75, sessions: 2 });
  assert.deepEqual(estimateTss(rows, "LEGS C"), { tss: null, sessions: 0 });
  assert.deepEqual(estimateTss(rows, "  "), { tss: null, sessions: 0 }, "an empty title matches nothing");
  assert.deepEqual(estimateTss([row("PUSH A", 0), row("PUSH A", 0)], "PUSH A"), { tss: 0, sessions: 2 }, "a real TSS of 0 is a value");
});

test("projectLoad: forecast_training_load's math, from the day after asOf, a missing date is a rest day", () => {
  const planned = new Map([["2026-11-17", { tss: 80 }]]);
  const points = projectLoad({ ctl: 40, atl: 60 }, planned, "2026-11-15", "2026-11-17");
  assert.deepEqual(points.map((p) => p.date), ["2026-11-16", "2026-11-17"]);
  assert.deepEqual(points, rollForward(planned, "2026-11-16", "2026-11-17", { ctl: 40, atl: 60 }));
  assert.deepEqual(points.map(roundPoint).map((p) => [p.tss, p.ctl, p.atl, p.tsb]), [[0, 39.1, 52, -13], [80, 40, 55.7, -15.7]]);
});

// ---------- the weekly jump ----------

// 28 days before the Monday, 400 TSS in all: an average week of exactly 100.
const MONDAY = "2026-11-16";
const history = () => new Map<string, number>([[addDays(MONDAY, -1), 100], [addDays(MONDAY, -10), 100], [addDays(MONDAY, -20), 100], [addDays(MONDAY, -28), 100]]);
const withWeek = (tss: number) => new Map(history()).set(addDays(MONDAY, 2), tss);

test("weekLoad: more than the limit trips, exactly the limit does not (compared as printed, 1 decimal)", () => {
  assert.equal(WEEKLY_JUMP_PCT, 30);
  assert.equal(PRIOR_DAYS, 28);
  const at = (tss: number) => weekLoad(withWeek(tss), MONDAY, 30);
  assert.deepEqual(at(130), { tss: 130, previous4wAvgTss: 100, jumpPct: 30, trips: false });
  assert.deepEqual([at(130.1).jumpPct, at(130.1).trips], [30.1, true]);
  assert.deepEqual([at(130.04).jumpPct, at(130.04).trips], [30, false], "30.04 prints as 30: not beyond it");
  assert.deepEqual([at(130.05).jumpPct, at(130.05).trips], [30.1, true]);
  assert.equal(at(129.9).trips, false);
  assert.equal(at(100).jumpPct, 0);
  assert.equal(at(50).jumpPct, -50);
  assert.equal(at(50).trips, false);
  assert.equal(weekLoad(withWeek(120), MONDAY, 15).trips, true, "the threshold is the caller's");
  assert.equal(weekLoad(withWeek(115), MONDAY, 15).trips, false);
});

test("weekLoad: the window is exactly the 28 days before the Monday and the 7 days of the week", () => {
  const daily = new Map<string, number>([
    [addDays(MONDAY, -29), 1000], // before the window
    [addDays(MONDAY, -28), 100], // first day of the window
    [addDays(MONDAY, -1), 100], // last day of the window
    [MONDAY, 70], // first day of the week
    [addDays(MONDAY, 6), 70], // last day of the week
    [addDays(MONDAY, 7), 1000], // after the week
  ]);
  assert.deepEqual(weekLoad(daily, MONDAY, 30), { tss: 140, previous4wAvgTss: 50, jumpPct: 180, trips: true });
});

test("weekLoad: an average week of 0 has no percentage and never trips", () => {
  assert.deepEqual(weekLoad(new Map([[MONDAY, 500]]), MONDAY, 30), { tss: 500, previous4wAvgTss: 0, jumpPct: null, trips: false });
});

// ---------- the TSB floor ----------

const pt = (date: string, tsb: number) => ({ date, tss: 0, ctl: 0, atl: 0, tsb });
test("tsbFloorCheck: below the floor trips, exactly on it does not; reports the lowest day (the first when tied)", () => {
  assert.equal(TSB_RISK_FLOOR, -30);
  assert.deepEqual(tsbFloorCheck([pt("a", -10), pt("b", -30), pt("c", -5)], -30), { minTsb: -30, date: "b", trips: false });
  assert.deepEqual(tsbFloorCheck([pt("a", -10), pt("b", -30.1), pt("c", -5)], -30), { minTsb: -30.1, date: "b", trips: true });
  assert.deepEqual(tsbFloorCheck([pt("a", -31), pt("b", -31)], -30), { minTsb: -31, date: "a", trips: true });
  assert.deepEqual(tsbFloorCheck([pt("a", -10)], -5), { minTsb: -10, date: "a", trips: true }, "the floor is the caller's");
  assert.deepEqual(tsbFloorCheck([], -30), { minTsb: null, date: null, trips: false });
});
