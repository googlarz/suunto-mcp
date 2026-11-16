import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { selectDays, selectNights } from "./api.js";
import { CTL_RAMP_MAX, FRESH_TSB_MAX, FRESH_TSB_MIN, RESPONSE_DAYS, freshBand, parseSessions, resolveSessions, responseModel, responseToPlan, simulateOne, simulatePlan, type ResolvedSession, type ResponseModel } from "./simulate-plan.js";
import { MIN_NIGHTS } from "./tag-effects.js";
import { addDays, forecastTrainingLoad } from "./training-load.js";

const TODAY = "2026-11-13"; // a Friday
const NOW = new Date(2026, 10, 13, 20, 0, 0);

// ---------- input ----------

test("parseSessions: a date and a tss or a title (or a guide with one); unknown fields, bad dates and tss bounds refused", () => {
  assert.deepEqual(parseSessions([{ date: "2026-11-16", tss: 80 }], "sessions"), [{ date: "2026-11-16", tss: 80 }]);
  assert.deepEqual(parseSessions([{ date: "2026-11-16", title: "PUSH A" }], "sessions"), [{ date: "2026-11-16", title: "PUSH A" }]);
  const guide = { title: "PUSH A", date: "2026-11-16", exercises: [] };
  assert.deepEqual(parseSessions([{ date: "2026-11-16", title: "Push", guide }], "sessions")[0].guide, guide);
  assert.deepEqual(parseSessions([{ date: "2026-11-16", tss: 0 }, { date: "2026-11-17", tss: 1000 }], "s").map((s) => s.tss), [0, 1000], "0 and 1000 are allowed");
  const bad = (raw: unknown, re: RegExp) => assert.throws(() => parseSessions(raw, "sessions"), re);
  bad([{ date: "2026-11-16", tss: -0.1 }], /sessions\[0\].tss must be a number from 0 to 1000/);
  bad([{ date: "2026-11-16", tss: 1000.1 }], /tss must be a number from 0 to 1000/);
  bad([{ date: "2026-11-16", tss: "80" }], /tss must be a number/);
  bad([{ date: "2026-11-16", tss: NaN }], /tss must be a number/);
  bad([{ date: "2026-11-16" }], /sessions\[0\] needs a tss, or a title/);
  bad([{ date: "2026-11-16", title: "" }], /title must be a non-empty string/);
  bad([{ date: "2026-11-16", title: "x".repeat(101), tss: 5 }], /at most 100 characters/);
  bad([{ date: "2026-02-30", tss: 5 }], /sessions\[0\].date must be a calendar date/);
  bad([{ date: "2026-11-16", tss: 5, load: 3 }], /sessions\[0\].load is not a known field \(allowed here: date, title, tss, guide\)/);
  bad([{ date: "2026-11-16", tss: 5, guide: { title: "x", date: "2026-11-17" } }], /guide.date \(2026-11-17\) must equal the session date 2026-11-16/);
  bad([{ date: "2026-11-16", tss: 5, guide: "x" }], /guide must be an object/);
  bad([], /sessions must list at least one session/);
  bad("x", /sessions must list at least one session/);
  bad([5], /sessions\[0\] must be an object/);
  bad(Array.from({ length: 201 }, () => ({ date: "2026-11-16", tss: 1 })), /at most 200 items/);
  assert.equal(parseSessions(Array.from({ length: 200 }, () => ({ date: "2026-11-16", tss: 1 })), "s").length, 200);
});

test("resolveSessions: a given tss wins; else the median of that title's sessions; no estimate is an error that asks for tss", () => {
  const row = (guide: string, tss: number) => ({ extensions: [{ type: "SummaryExtension", apps: [{ name: guide }] }], tss: { trainingStressScore: tss } });
  const rows = [row("PUSH A", 60), row("PUSH A", 80), row("LEGS C", 90)];
  const [a, b, c] = resolveSessions([{ date: "d1", tss: 10, title: "PUSH A" }, { date: "d2", title: "push a" }, { date: "d3", guide: { title: "PUSH A" }, title: "ignored" }], rows, "sessions");
  assert.deepEqual(a, { date: "d1", title: "PUSH A", tss: 10, tssSource: "given", historySessions: null });
  assert.deepEqual(b, { date: "d2", title: "push a", tss: 70, tssSource: "history", historySessions: 2 });
  assert.equal(c.title, "PUSH A", "the guide's title is the one the workout list names");
  assert.throws(() => resolveSessions([{ date: "2026-11-16", title: "LEGS C" }], rows, "sessions"), /sessions\[0\] \(2026-11-16 "LEGS C"\): no TSS estimate, 1 session\(s\) of that title with a TSS in your last 90 days and at least 2 are needed. Give its tss\./);
  assert.throws(() => resolveSessions([{ date: "d", tss: 5 }, { date: "2026-11-16", title: "NEW" }], rows, "compare.sessions"), /compare.sessions\[1\] .* 0 session\(s\)/);
});

// ---------- the fresh band ----------

test("freshBand: TSB 5 to 25 inclusive is fresh, below is below, above is above", () => {
  assert.deepEqual([FRESH_TSB_MIN, FRESH_TSB_MAX], [5, 25]);
  assert.deepEqual([4.9, 5, 5.1, 24.9, 25, 25.1, -40, 0].map(freshBand), ["below", "fresh", "fresh", "fresh", "fresh", "above", "below", "below"]);
});

// ---------- one plan ----------

const noModel = (): ResponseModel => ({ status: "insufficient", basis: "", window: { from: "", to: "" }, cutoffTss: null, highLoadDays: 0, otherDays: 0, thresholds: { minNightsPerGroup: 15, minPairedDays: 30, k: 3, rule: "" }, metrics: null, missing: ["x"] });
const sess = (date: string, tss: number): ResolvedSession => ({ date, title: null, tss, tssSource: "given", historySessions: null });
const run = (o: { sessions?: ResolvedSession[]; start?: { ctl: number; atl: number; tsb?: number }; asOf?: string; end: string; goalDate?: string | null; history?: Map<string, number>; model?: ResponseModel }) =>
  simulateOne({ sessions: o.sessions ?? [], start: { tsb: 0, ...(o.start ?? { ctl: 0, atl: 0 }) }, asOf: o.asOf ?? TODAY, end: o.end, goalDate: o.goalDate ?? null, history: o.history ?? new Map(), model: o.model ?? noModel() });

test("simulateOne: day-by-day CTL/ATL/TSB from the start values, one point per day to the end, rest days included", () => {
  const out = run({ sessions: [sess("2026-11-14", 100)], start: { ctl: 40, atl: 60 }, end: "2026-11-16" });
  assert.deepEqual(out.series.map((p) => [p.date, p.tss, p.ctl, p.atl, p.tsb]), [
    ["2026-11-14", 100, 41.4, 65.3, -23.9], // by hand: 40 * 0.97647 + 100 * 0.02353; 60 * 0.86688 + 100 * 0.13312
    ["2026-11-15", 0, 40.4, 56.6, -16.2],
    ["2026-11-16", 0, 39.5, 49.1, -9.6],
  ]);
  assert.deepEqual([out.from, out.to, out.totalTss], ["2026-11-14", "2026-11-16", 100]);
  assert.deepEqual(out.end, { ctl: 39.5, atl: 49.1, tsb: -9.6 });
  assert.deepEqual(out.lowestTsb, { date: "2026-11-14", tsb: -23.9 });
});

test("simulateOne: several sessions on one date add up; more than 1000 in a day is refused", () => {
  const out = run({ sessions: [sess("2026-11-14", 60), sess("2026-11-14", 40)], end: "2026-11-14" });
  assert.equal(out.series[0].tss, 100);
  assert.equal(out.totalTss, 100);
  assert.throws(() => run({ sessions: [sess("2026-11-14", 600), sess("2026-11-14", 401)], end: "2026-11-14" }), /2026-11-14 adds up to a TSS of 1001, more than 1000 in one day/);
  assert.doesNotThrow(() => run({ sessions: [sess("2026-11-14", 600), sess("2026-11-14", 400)], end: "2026-11-14" }));
});

test("simulateOne: the TSB floor trips on a day below -30 as printed, exactly -30.0 does not", () => {
  // ctl 0, atl A, one rest day: TSB = -A * (1 - K_ATL): A 34.6 prints -30.0, A 34.7 prints -30.1
  const edge = run({ start: { ctl: 0, atl: 34.6 }, end: "2026-11-14" });
  assert.equal(edge.series[0].tsb, -30);
  assert.deepEqual(edge.risks, []);
  const over = run({ start: { ctl: 0, atl: 34.7 }, end: "2026-11-14" });
  assert.equal(over.series[0].tsb, -30.1);
  assert.deepEqual(over.risks.map((r) => [r.rule, r.scope, r.date, r.value, r.threshold]), [["tsb-floor", "day", "2026-11-14", -30.1, -30]]);
  assert.deepEqual(over.lowestTsb, { date: "2026-11-14", tsb: -30.1 });
});

test("simulateOne: TSB on goalDate against the fresh band, edges inclusive (as printed)", () => {
  // atl 0, ctl C, one rest day: TSB = C * (1 - K_CTL)
  const at = (ctl: number) => run({ start: { ctl, atl: 0 }, end: "2026-11-14", goalDate: "2026-11-14" }).goal!;
  assert.deepEqual([at(5.1).tsb, at(5.1).band], [5, "fresh"], "4.98 prints 5: the edge is in the band");
  assert.deepEqual([at(5.05).tsb, at(5.05).band], [4.9, "below"]);
  assert.deepEqual([at(25.62).tsb, at(25.62).band], [25, "fresh"]);
  assert.deepEqual([at(25.7).tsb, at(25.7).band], [25.1, "above"]);
  assert.deepEqual(at(10), { date: "2026-11-14", ctl: 9.8, atl: 0, tsb: 9.8, band: "fresh", freshBand: { min: 5, max: 25 }, basis: "model-based" });
  assert.equal(run({ end: "2026-11-14" }).goal, null, "no goalDate: no goal");
});

// asOf a Sunday: the week of 2026-11-16 is whole (7 days of the series).
const SUN = "2026-11-15";
const week = (tss: number) => Array.from({ length: 7 }, (_, i) => sess(addDays("2026-11-16", i), tss));

test("simulateOne: a full week whose CTL rises by more than 8 trips the ramp rule, exactly 8.0 as printed does not", () => {
  assert.equal(CTL_RAMP_MAX, 8);
  // from CTL 0, 7 equal days of x: the week's rise is x * (1 - (1 - K_CTL)^7): 52.2 -> 8.0136, 52.6 -> 8.075
  const edge = run({ sessions: week(52.2), asOf: SUN, end: "2026-11-22" });
  assert.deepEqual([edge.weeks[0].rampRate, edge.weeks[0].complete], [8, true]);
  assert.deepEqual(edge.risks, []);
  const over = run({ sessions: week(52.6), asOf: SUN, end: "2026-11-22" });
  assert.equal(over.weeks[0].rampRate, 8.1);
  assert.deepEqual(over.risks.map((r) => [r.rule, r.scope, r.weekStart, r.value, r.threshold]), [["ctl-ramp", "week", "2026-11-16", 8.1, 8]]);
});

test("simulateOne: a part of a week is no weekly rate: neither the ramp nor the jump is checked, and it is marked incomplete", () => {
  // asOf Wednesday: the first week has Thu-Sun in the series, 4 days from Thursday the 12th
  const out = run({ sessions: [sess("2026-11-13", 500), sess("2026-11-14", 500)], asOf: "2026-11-11", end: "2026-11-15" });
  assert.deepEqual([out.weeks.length, out.weeks[0].days, out.weeks[0].complete], [1, 4, false]);
  assert.ok(out.weeks[0].rampRate > CTL_RAMP_MAX, "the rise itself is shown");
  assert.deepEqual(out.risks.filter((r) => r.scope === "week"), []);
  assert.equal(out.weeks[0].ctlStart, 0, "the first week starts from the current CTL");
});

test("simulateOne: a full week more than 30% above the average week of the 28 days before trips the jump rule, exactly 30.0 does not", () => {
  // 28 days before Monday 2026-11-16 hold 400 TSS (an average week of 100); the week's TSS is the lever
  const history = new Map<string, number>([["2026-11-15", 100], ["2026-11-06", 100], ["2026-10-27", 100], ["2026-10-19", 100]]);
  const at = (tss: number) => run({ sessions: [sess("2026-11-18", tss)], asOf: SUN, end: "2026-11-22", history });
  const edge = at(130);
  assert.deepEqual([edge.weeks[0].previous4wAvgTss, edge.weeks[0].jumpPct], [100, 30]);
  assert.deepEqual(edge.risks.filter((r) => r.rule === "weekly-load-jump"), []);
  const over = at(130.1);
  assert.deepEqual(over.risks.filter((r) => r.rule === "weekly-load-jump").map((r) => [r.scope, r.weekStart, r.value, r.threshold]), [["week", "2026-11-16", 30.1, 30]]);
  assert.match(over.risks[0].detail, /TSS of 130.1, 30.1% above the 100 average week/);
});

test("simulateOne: the second week of a plan is measured against the 28 days before it, the first planned week included", () => {
  const history = new Map<string, number>([["2026-11-15", 100]]); // an average week of 25
  const out = run({ sessions: [sess("2026-11-18", 100), sess("2026-11-25", 100)], asOf: SUN, end: "2026-11-29", history });
  assert.deepEqual(out.weeks.map((w) => [w.weekStart, w.tss, w.previous4wAvgTss, w.jumpPct]), [["2026-11-16", 100, 25, 300], ["2026-11-23", 100, 50, 100]]);
  assert.deepEqual(out.risks.filter((r) => r.rule === "weekly-load-jump").map((r) => r.weekStart), ["2026-11-16", "2026-11-23"]);
});

test("simulateOne: weekly rows carry the CTL at the start and end of each week, from one week into the next", () => {
  const out = run({ sessions: week(50), asOf: SUN, end: "2026-11-29" });
  const [w1, w2] = out.weeks;
  assert.equal(w1.ctlStart, 0);
  assert.equal(w2.ctlStart, w1.ctlEnd, "a week starts where the one before ended");
  assert.equal(w1.tss, 350);
  assert.equal(w2.tss, 0);
  assert.ok(w2.rampRate < 0, "a week of rest lowers CTL");
});

test("responseToPlan: only when the model is ok; the shift is only given for a difference beyond the noise; high-load days count from the cutoff on", () => {
  const e = (verdict: string, medianDiff: number | null) => ({ nTagged: 20, nControl: 20, taggedMedian: 1, controlMedian: 2, medianDiff, meanDiff: medianDiff, controlIqr: 1, noiseThreshold: 1, verdict }) as any;
  const model: ResponseModel = { ...noModel(), status: "ok", cutoffTss: 60, metrics: { hrv: e("tagged-lower", -8.5), recoveryMorning: e("within-noise", 0.01) }, missing: [] };
  const plan = new Map([["a", 60], ["b", 59.9], ["c", 100], ["d", 0]]);
  assert.deepEqual(responseToPlan(model, plan), {
    highLoadDays: 2,
    afterHighLoad: { hrv: { verdict: "lower", expectedShiftVsOtherDays: -8.5 }, recoveryMorning: { verdict: "within-noise", expectedShiftVsOtherDays: null } },
    basis: "model-based: your own median difference, not a forecast of any single night",
  });
  const up = responseToPlan({ ...model, metrics: { hrv: e("tagged-higher", 3), recoveryMorning: e("insufficient", null) } }, plan)!;
  assert.deepEqual([up.afterHighLoad.hrv, up.afterHighLoad.recoveryMorning], [{ verdict: "higher", expectedShiftVsOtherDays: 3 }, { verdict: "insufficient", expectedShiftVsOtherDays: null }]);
  assert.equal(responseToPlan({ ...model, status: "insufficient" }, plan), null);
  assert.equal(responseToPlan(noModel(), plan), null);
});

// ---------- the user's own response ----------

const ASOF = "2026-11-15";
const FROM = addDays(ASOF, -RESPONSE_DAYS);
const workoutOn = (day: string, tss: number) => ({ workoutKey: "k" + day, startTime: Date.parse(`${day}T17:00:00Z`), timeOffsetInMinutes: 0, totalTime: 3600, tss: { trainingStressScore: tss } });
const nightOn = (night: string, hrv: number) => ({
  timestamp: `${night}T23:00:00.000Z`,
  entryData: { SleepId: Date.parse(`${night}T00:00:00Z`) / 1000, BedtimeStart: `${night}T23:00:00.000Z`, BedtimeEnd: `${addDays(night, 1)}T06:30:00.000Z`, Duration: 27000, IsNap: false, SleepQualityScore: 80, AvgHRV: hrv },
});
// nHigh days of TSS 100 (followed by an HRV night of 30) and nRest rest days (followed by about 60); every other day has neither a workout nor a night
function history(nHigh: number, nRest: number, o: { highHrv?: number; restSpread?: number } = {}) {
  const high = Array.from({ length: nHigh }, (_, k) => addDays(FROM, 5 + 2 * k));
  const rest = Array.from({ length: nRest }, (_, k) => addDays(FROM, 6 + 2 * k));
  const spread = o.restSpread ?? 1;
  const nights = new Map<string, any[]>();
  for (const d of high) nights.set(d, [nightOn(d, o.highHrv ?? 30)]);
  rest.forEach((d, i) => nights.set(d, [nightOn(d, 60 + (i - (nRest - 1) / 2) * spread)]));
  return { workouts: high.map((d) => workoutOn(d, 100)), nights, recovery: new Map<string, any[]>(), asOf: ASOF };
}

test("responseModel: at least 15 nights of each kind are needed for a metric: 15 and 15 is ok, 14 high or 14 other is insufficient", () => {
  assert.equal(MIN_NIGHTS, 15);
  const ok = responseModel(history(15, 15));
  assert.equal(ok.status, "ok");
  assert.deepEqual([ok.metrics!.hrv.nTagged, ok.metrics!.hrv.nControl, ok.metrics!.hrv.verdict], [15, 15, "tagged-lower"]);
  assert.equal(ok.metrics!.hrv.medianDiff, -30);
  assert.equal(ok.metrics!.recoveryMorning.verdict, "insufficient");
  assert.match(ok.missing.join(" "), /recoveryMorning: 0 night\(s\) after high-load days and 0 after other days have a value; at least 15 of each are needed/, "what is missing is said even when the other metric is ok");
  assert.equal(responseModel(history(16, 16)).status, "ok");
  for (const [h, r] of [[14, 15], [15, 14], [14, 14], [0, 15]] as const) {
    const m = responseModel(history(h, r));
    assert.equal(m.status, "insufficient", `${h}/${r}`);
    assert.equal(m.metrics === null ? "no metrics" : m.metrics.hrv.verdict, h === 0 ? "no metrics" : "insufficient", `${h}/${r}`);
    assert.match(m.missing.join(" "), /hrv|No workout/, `${h}/${r}`);
  }
  assert.deepEqual([ok.thresholds.minNightsPerGroup, ok.thresholds.minPairedDays, ok.thresholds.k], [15, 30, 3]);
});

test("responseModel: a difference inside the noise is within-noise (no shift is claimed); the cutoff is the median TSS of the training days", () => {
  const noisy = responseModel(history(15, 15, { highHrv: 58, restSpread: 6 })); // rest nights spread 60 +- 42, high nights 58
  assert.equal(noisy.metrics!.hrv.verdict, "within-noise");
  assert.equal(noisy.status, "ok");
  assert.equal(responseToPlan(noisy, new Map([["d", 100]]))!.afterHighLoad.hrv.expectedShiftVsOtherDays, null);
  assert.equal(noisy.cutoffTss, 100);
  assert.deepEqual([noisy.highLoadDays, noisy.otherDays], [15, 75], "90 days in the window: 15 high-load, the rest (rest days included) other");
});

test("responseModel: with no workout carrying a TSS there is no load to compare: insufficient, saying so", () => {
  const m = responseModel({ workouts: [], nights: new Map(), recovery: new Map(), asOf: ASOF });
  assert.deepEqual([m.status, m.metrics, m.cutoffTss], ["insufficient", null, null]);
  assert.match(m.missing[0], /No workout with a TSS/);
});

test("responseModel: a section that could not be read is named in what is missing", () => {
  const m = responseModel({ ...history(15, 15), nights: null, errors: ["sleep could not be read: boom"] });
  assert.equal(m.status, "insufficient");
  assert.match(m.missing[0], /sleep could not be read: boom/);
});

// ---------- the call, on a fake account ----------

interface Day {
  date: string;
  tss: number;
  guide?: string;
}
function fake(days: Day[], nights: { night: string; hrv: number }[] = []) {
  const calls: string[] = [];
  const rows = days.map((d, i) => ({
    workoutKey: i.toString(16).padStart(24, "0"),
    startTime: Date.parse(`${d.date}T17:00:00Z`),
    timeOffsetInMinutes: 0,
    totalTime: 3600,
    tss: { trainingStressScore: d.tss },
    ...(d.guide ? { extensions: [{ type: "SummaryExtension", apps: [{ name: d.guide }] }] } : {}),
  }));
  const client = {
    listWorkouts: async (o: any) => {
      calls.push("workouts");
      return { payload: rows.filter((w) => (o.since == null || w.startTime >= o.since) && (o.until == null || w.startTime <= o.until)).sort((a, b) => b.startTime - a.startTime).slice(0, o.limit ?? 25) };
    },
    listSleep: async (from: string, to: string) => {
      calls.push("sleep");
      return selectNights({ payload: nights.map((n) => nightOn(n.night, n.hrv)) }, from, to);
    },
    listRecovery: async (from: string, to: string) => {
      calls.push("recovery");
      return selectDays({ payload: [] }, from, to);
    },
  } as unknown as SuuntoClient;
  return { client, calls };
}
// a steady training history: PUSH A and PULL B every few days, 60 and 40 TSS, for 10 weeks up to today
const steady = (): Day[] => Array.from({ length: 30 }, (_, i) => ({ date: addDays(TODAY, -2 - i * 2), tss: i % 2 ? 40 : 60, guide: i % 2 ? "PULL B" : "PUSH A" }));
const sim = (acc: ReturnType<typeof fake>, args: unknown) => simulatePlan(acc.client, args, { now: NOW });

test("simulatePlan: the series is forecast_training_load's own, from today's values, to the Sunday of the last session's week", async () => {
  const acc = fake(steady());
  const out = await sim(acc, { sessions: [{ date: "2026-11-16", tss: 80 }, { date: "2026-11-18", tss: 60 }] });
  const expected = await forecastTrainingLoad(acc.client, { asOf: TODAY, days: [{ date: "2026-11-16", tss: 80 }, { date: "2026-11-18", tss: 60 }, { date: "2026-11-22", tss: 0 }] });
  assert.deepEqual(out.series, expected.series);
  assert.deepEqual(out.start, expected.start);
  assert.deepEqual([out.asOf, out.modelBased, out.from, out.to], [TODAY, true, "2026-11-14", "2026-11-22"]);
  assert.deepEqual(out.weeks.map((w) => [w.weekStart, w.days, w.complete]), [["2026-11-09", 2, false], ["2026-11-16", 7, true]]);
  assert.equal(out.goal, null);
  assert.equal(out.compare, null);
  assert.match(out.notes[0], /MODEL-BASED/);
});

test("simulatePlan: a title's TSS comes from the user's own sessions of it; a title with no history asks for tss; a given tss wins", async () => {
  const acc = fake(steady());
  const out = await sim(acc, { sessions: [{ date: "2026-11-16", title: "PUSH A" }, { date: "2026-11-17", title: "PULL B" }, { date: "2026-11-18", title: "PUSH A", tss: 10 }] });
  assert.deepEqual(out.sessions.map((s) => [s.date, s.tss, s.tssSource, s.historySessions]), [["2026-11-16", 60, "history", 15], ["2026-11-17", 40, "history", 15], ["2026-11-18", 10, "given", null]]);
  await assert.rejects(sim(acc, { sessions: [{ date: "2026-11-16", title: "NEW THING" }] }), /no TSS estimate, 0 session\(s\) of that title .* Give its tss\./);
  // the 90-day window: a title seen only before it has no estimate
  const old = fake([{ date: addDays(TODAY, -100), tss: 50, guide: "OLD" }, { date: addDays(TODAY, -101), tss: 50, guide: "OLD" }]);
  await assert.rejects(sim(old, { sessions: [{ date: "2026-11-16", title: "OLD" }] }), /0 session\(s\)/);
});

test("simulatePlan: goalDate gives TSB then against the fresh band, and runs the series on to it", async () => {
  const acc = fake(steady());
  const out = await sim(acc, { sessions: [{ date: "2026-11-16", tss: 80 }], goalDate: "2026-11-29" });
  assert.equal(out.to, "2026-11-29");
  assert.equal(out.goal!.date, "2026-11-29");
  assert.equal(out.goal!.tsb, out.series.find((p) => p.date === "2026-11-29")!.tsb);
  assert.ok(["below", "fresh", "above"].includes(out.goal!.band));
  assert.equal(out.series.length, 16);
});

test("simulatePlan: compare runs a second plan over the same days from the same start, with the difference second minus first", async () => {
  const acc = fake(steady());
  const out = await sim(acc, { sessions: [{ date: "2026-11-16", tss: 100 }], compare: { label: "lighter", sessions: [{ date: "2026-11-16", tss: 40 }, { date: "2026-11-24", tss: 40 }] }, goalDate: "2026-11-30" });
  const cmp = out.compare!;
  assert.equal(cmp.label, "lighter");
  assert.deepEqual([out.to, cmp.to], ["2026-11-30", "2026-11-30"], "both run to the same end");
  assert.equal(cmp.series.length, out.series.length);
  assert.deepEqual([cmp.difference.totalTss, cmp.difference.endCtl], [r1(80 - 100), r1(cmp.end.ctl - out.end.ctl)]);
  assert.equal(cmp.difference.goalTsb, r1(cmp.goal!.tsb - out.goal!.tsb));
  assert.equal(cmp.difference.risks, cmp.risks.length - out.risks.length);
  assert.deepEqual(cmp.series[0].date, out.series[0].date);
  const noGoal = await sim(acc, { sessions: [{ date: "2026-11-16", tss: 100 }], compare: { sessions: [{ date: "2026-11-16", tss: 40 }] } });
  assert.deepEqual([noGoal.compare!.label, noGoal.compare!.difference.goalTsb], [null, null]);
});

test("simulatePlan: personalResponse is insufficient (with what is missing) on a thin history, and the plan still simulates", async () => {
  const out = await sim(fake(steady()), { sessions: [{ date: "2026-11-16", tss: 80 }] });
  assert.equal(out.personalResponse.status, "insufficient");
  assert.match(out.personalResponse.missing.join(" "), /hrv: 0 night\(s\) after high-load days .* at least 15 of each are needed/);
  assert.equal(out.responseToPlan, null);
  assert.equal(out.series.length > 0, true);
});

test("simulatePlan: with enough paired nights personalResponse reports the user's own difference and applies it to the plan's high-load days", async () => {
  // a workout on every 2nd day for 90 days at TSS 100 (high), rest days between; nights after workouts 30, after rest 60 +- jitter
  const days: Day[] = [];
  const nights: { night: string; hrv: number }[] = [];
  for (let i = 1; i <= 88; i++) {
    const d = addDays(TODAY, -i);
    if (i % 2 === 0) days.push({ date: d, tss: 100, guide: "PUSH A" });
    nights.push({ night: d, hrv: i % 2 === 0 ? 30 : 60 + (i % 7) });
  }
  const out = await sim(fake(days, nights), { sessions: [{ date: "2026-11-16", title: "PUSH A" }, { date: "2026-11-17", tss: 20 }, { date: "2026-11-18", tss: 100 }] });
  const pr = out.personalResponse;
  assert.equal(pr.status, "ok");
  assert.equal(pr.cutoffTss, 100);
  assert.equal(pr.metrics!.hrv.verdict, "tagged-lower");
  assert.ok(pr.metrics!.hrv.medianDiff! < -20);
  assert.equal(out.responseToPlan!.highLoadDays, 2, "the PUSH A estimate is 100: at the cutoff");
  assert.equal(out.responseToPlan!.afterHighLoad.hrv.verdict, "lower");
  assert.equal(out.responseToPlan!.afterHighLoad.hrv.expectedShiftVsOtherDays, pr.metrics!.hrv.medianDiff);
  assert.match(pr.basis, /^model-based/);
});

test("simulatePlan: a section that fails does not fail the simulation: the response says what could not be read", async () => {
  const acc = fake(steady());
  (acc.client as any).listSleep = async () => {
    throw new Error("Suunto answered 500");
  };
  const out = await sim(acc, { sessions: [{ date: "2026-11-16", tss: 80 }] });
  assert.deepEqual(out.errors, [{ section: "sleep", error: "Suunto answered 500" }]);
  assert.equal(out.personalResponse.status, "insufficient");
  assert.match(out.personalResponse.missing.join(" "), /sleep could not be read: Suunto answered 500/);
});

test("simulatePlan: bad input is refused before any request", async () => {
  const acc = fake(steady());
  const ok = { sessions: [{ date: "2026-11-16", tss: 80 }] };
  const bad = (args: unknown, re: RegExp) => assert.rejects(sim(acc, args), re);
  await bad({ ...ok, extra: 1 }, /extra is not a known field \(allowed here: sessions, goalDate, asOf, compare\)/);
  await bad("x", /arguments must be an object/);
  await bad({}, /sessions must list at least one session/);
  await bad({ sessions: [{ date: TODAY, tss: 5 }] }, /sessions\[0\].date 2026-11-13 must be after asOf 2026-11-13/);
  await bad({ sessions: [{ date: "2026-11-12", tss: 5 }] }, /must be after asOf/);
  await bad({ sessions: [{ date: addDays(TODAY, 121), tss: 5 }] }, /more than 120 days after asOf/);
  await bad({ ...ok, asOf: "2026-11-14" }, /asOf 2026-11-14 is in the future \(today is 2026-11-13\)/);
  await bad({ ...ok, asOf: "bad" }, /asOf must be a calendar date/);
  await bad({ ...ok, goalDate: TODAY }, /goalDate 2026-11-13 must be after asOf/);
  await bad({ ...ok, goalDate: addDays(TODAY, 121) }, /goalDate .* at most 120 days/);
  await bad({ ...ok, compare: [] }, /compare must be an object/);
  await bad({ ...ok, compare: { sessions: [{ date: TODAY, tss: 5 }] } }, /compare.sessions\[0\].date .* must be after asOf/);
  await bad({ ...ok, compare: { sessions: ok.sessions, extra: 1 } }, /compare.extra is not a known field/);
  await bad({ ...ok, compare: { sessions: ok.sessions, label: "x".repeat(101) } }, /compare.label/);
  assert.deepEqual(acc.calls, [], "nothing was read");
  // the edges are allowed: 120 days after asOf, goalDate the day after
  await assert.doesNotReject(sim(acc, { sessions: [{ date: addDays(TODAY, 120), tss: 5 }], goalDate: addDays(TODAY, 1) }));
  await assert.doesNotReject(sim(acc, { sessions: [{ date: addDays(TODAY, 120), tss: 5 }], goalDate: addDays(TODAY, 120) }), "goalDate on the last allowed day");
  await assert.doesNotReject(sim(acc, { ...ok, asOf: "2026-11-12", sessions: [{ date: TODAY, tss: 5 }] }));
});

test("simulatePlan: deterministic, and it writes nothing (no file anywhere, no local state read or written)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-simulate-"));
  const saved = { ...process.env };
  for (const k of ["SUUNTO_PLAN_PATH", "SUUNTO_JOURNAL_PATH", "SUUNTO_CACHE_DIR", "SUUNTO_PREDICTIONS_PATH", "SUUNTO_EXPERIMENTS_PATH"]) process.env[k] = join(dir, k);
  try {
    const args = { sessions: [{ date: "2026-11-16", title: "PUSH A" }, { date: "2026-11-18", tss: 70 }], goalDate: "2026-11-27", compare: { sessions: [{ date: "2026-11-16", tss: 30 }] } };
    const a = JSON.stringify(await sim(fake(steady()), args));
    const b = JSON.stringify(await sim(fake(steady()), args));
    assert.equal(a, b);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    for (const k of ["SUUNTO_PLAN_PATH", "SUUNTO_JOURNAL_PATH", "SUUNTO_CACHE_DIR", "SUUNTO_PREDICTIONS_PATH", "SUUNTO_EXPERIMENTS_PATH"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("simulatePlan: a propose_next_week result's sessions go in as they are", async () => {
  const proposal = [{ date: "2026-11-16", title: "Push pull", guide: { title: "PUSH A", date: "2026-11-16", exercises: [{ name: "Bench", detail: "70kg 3x8", sets: 3, restSec: 90 }] } }, { date: "2026-11-20", title: "Easy run" }];
  const out = await sim(fake(steady()), { sessions: proposal.map((s) => (s.title === "Easy run" ? { ...s, tss: 35 } : s)) });
  assert.deepEqual(out.sessions.map((s) => [s.title, s.tss, s.tssSource]), [["PUSH A", 60, "history"], ["Easy run", 35, "given"]]);
});

const r1 = (n: number) => Math.round(n * 10) / 10;
