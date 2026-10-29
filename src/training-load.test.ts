import { test } from "node:test";
import assert from "node:assert/strict";
import { dayFetchBounds } from "./api.js";
import {
  aggregateByDay,
  buildTrainingLoad,
  rollForward,
  weekStart,
  weeklyTotals,
  workoutTss,
  WORKOUT_LIMIT,
} from "./training-load.js";

const close = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`);

// A workout at a local wall-clock time with its UTC offset, as list_workouts sends it.
const workout = (localIso: string, offsetMin: number, extra: Record<string, unknown> = {}) => ({
  startTime: Date.parse(`${localIso}Z`) - offsetMin * 60_000,
  timeOffsetInMinutes: offsetMin,
  ...extra,
});
const withTss = (localIso: string, tss: number, totalTime = 3600) =>
  workout(localIso, 120, { totalTime, tss: { trainingStressScore: tss } });

const tssMap = (entries: Record<string, number>) => new Map(Object.entries(entries).map(([d, tss]) => [d, { tss }]));

// Expected values by hand: K_CTL = 1 - e^(-1/42) = 0.0235283133, K_ATL = 1 - e^(-1/7) = 0.1331221002.
// day 1: ctl = 100·K_CTL = 2.35283133, atl = 100·K_ATL = 13.31221002
// day 2: ctl = 2.35283133·(1-K_CTL) = 2.29747318, atl = 13.31221002·(1-K_ATL) = 11.54006067
// day 3: ctl = 2.29747318·(1-K_CTL) + 50·K_CTL = 3.41983318, atl = 11.54006067·(1-K_ATL) + 50·K_ATL = 16.65992857
test("rollForward: hand-computed CTL/ATL/TSB from a cold start, rest day included", () => {
  const points = rollForward(tssMap({ "2026-03-01": 100, "2026-03-03": 50 }), "2026-03-01", "2026-03-03");
  assert.deepEqual(points.map((p) => [p.date, p.tss]), [["2026-03-01", 100], ["2026-03-02", 0], ["2026-03-03", 50]]);
  const expected = [
    [2.3528313347756735, 13.312210024981841],
    [2.2974731818766507, 11.54006066748957],
    [3.4198331803332263, 16.65992856691396],
  ];
  points.forEach((p, i) => {
    close(p.ctl, expected[i][0], `ctl day ${i + 1}`);
    close(p.atl, expected[i][1], `atl day ${i + 1}`);
    close(p.tsb, expected[i][0] - expected[i][1], `tsb day ${i + 1}`);
  });
});

// From CTL 40 / ATL 60: rest → 40·(1-K_CTL) = 39.05886747, 60·(1-K_ATL) = 52.01267399;
// then TSS 80 → 40.02214326, 55.73840560.
test("rollForward: seeds are the state at the end of the day before `from`", () => {
  const points = rollForward(tssMap({ "2026-03-02": 80 }), "2026-03-01", "2026-03-02", { ctl: 40, atl: 60 });
  close(points[0].ctl, 39.05886746608973, "ctl after a rest day");
  close(points[0].atl, 52.01267398501089, "atl after a rest day");
  close(points[1].ctl, 40.02214326115961, "ctl after TSS 80");
  close(points[1].atl, 55.738405604502624, "atl after TSS 80");
});

test("rollForward: no workouts at all is a flat zero series, one point per day across a month end", () => {
  const points = rollForward(new Map(), "2026-02-27", "2026-03-02");
  assert.deepEqual(points.map((p) => p.date), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  assert.ok(points.every((p) => p.tss === 0 && p.ctl === 0 && p.atl === 0 && p.tsb === 0));
});

test("workoutTss: the digest's rule — tss.trainingStressScore, 0 when missing", () => {
  assert.equal(workoutTss({ tss: { trainingStressScore: 40 }, tssList: [{ calculationMethod: "HR", trainingStressScore: 99 }] }), 40);
  assert.equal(workoutTss({}), 0);
  assert.equal(workoutTss({ tss: {} }), 0);
});

test("aggregateByDay: two workouts on one day add up; no-TSS ones count 0 and are flagged; undated ones are set aside", () => {
  const { days, undated } = aggregateByDay([
    withTss("2026-03-01T07:00:00", 30, 1800),
    withTss("2026-03-01T18:00:00", 45.5, 2700),
    workout("2026-03-02T10:00:00", 120, { totalTime: 600 }), // Suunto computed no TSS
    { tss: { trainingStressScore: 999 } }, // no startTime
  ]);
  assert.deepEqual(days.get("2026-03-01"), { workouts: 2, durationS: 4500, tss: 75.5, noTss: 0 });
  assert.deepEqual(days.get("2026-03-02"), { workouts: 1, durationS: 600, tss: 0, noTss: 1 });
  assert.equal(undated, 1);
  assert.equal(days.size, 2);
});

test("aggregateByDay: a workout is filed under its own local date, not the UTC one", () => {
  // 00:30 local at +02:00 is 22:30 UTC the day before
  const { days } = aggregateByDay([withTss("2026-03-02T00:30:00", 20)]);
  assert.deepEqual([...days.keys()], ["2026-03-02"]);
});

test("weekStart / weeklyTotals: Monday starts a week; partial edge weeks count only the window's days", () => {
  assert.equal(weekStart("2026-10-25"), "2026-10-19", "a Sunday belongs to the week before");
  assert.equal(weekStart("2026-10-26"), "2026-10-26", "a Monday starts its own week");
  assert.equal(weekStart("2026-10-29"), "2026-10-26");
  const { days } = aggregateByDay([
    withTss("2026-10-24T09:00:00", 10), // Saturday, before the window
    withTss("2026-10-25T23:30:00", 40, 1200), // Sunday, late evening
    withTss("2026-10-26T06:00:00", 60, 2400), // Monday morning
    withTss("2026-10-26T19:00:00", 5, 600),
  ]);
  assert.deepEqual(weeklyTotals(days, "2026-10-25", "2026-10-27"), [
    { weekStart: "2026-10-19", workouts: 1, durationS: 1200, tss: 40 },
    { weekStart: "2026-10-26", workouts: 2, durationS: 3000, tss: 65 },
  ]);
});

// ---------- buildTrainingLoad ----------

function fakeClient(payload: any[]) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      listWorkouts: async (opts: any) => {
        calls.push(opts);
        return { payload, metadata: { count: payload.length } };
      },
    } as any,
  };
}

test("buildTrainingLoad: reads a 180-day warm-up, so a workout before the window carries into it", async () => {
  const { client, calls } = fakeClient([withTss("2026-01-10T08:00:00", 100), withTss("2026-03-05T08:00:00", 50)]);
  const out = await buildTrainingLoad(client, { date: "2026-03-10", days: 7 });
  assert.equal(out.from, "2026-03-04");
  assert.equal(out.to, "2026-03-10");
  const bounds = dayFetchBounds("2025-09-05", "2026-03-10"); // 2026-03-04 minus 180 days
  assert.deepEqual(calls, [{ since: bounds.from, until: bounds.to, limit: WORKOUT_LIMIT }]);
  assert.equal(out.series.length, 7);
  assert.deepEqual(out.series.map((p) => p.tss), [0, 50, 0, 0, 0, 0, 0]);
  // 2026-01-10 → 2026-03-03 is 52 rest days after the 100-TSS day
  const ctlBefore = 100 * (1 - Math.exp(-1 / 42)) * Math.exp(-52 / 42);
  assert.equal(out.series[0].ctl, Math.round(ctlBefore * Math.exp(-1 / 42) * 10) / 10);
  assert.ok(out.series[0].ctl > 0, "the January workout still counts");
  const { date: _date, tss: _tss, ...lastDay } = out.series[6];
  assert.deepEqual({ ...out.current, rampRate7d: undefined }, { ...lastDay, rampRate7d: undefined }, "current is the last day");
  assert.notEqual(out.current.rampRate7d, null, "the warm-up has a CTL 7 days before `to`");
  assert.ok(out.notes.some((n) => /about 1 point off/.test(n)));
  assert.ok(out.notes.some((n) => /tss 0: a rest day/.test(n)));
  assert.ok(out.notes.some((n) => /start from 0 on 2025-09-05/.test(n)));
  assert.ok(!out.notes.some((n) => /Little history/.test(n)), "history starts 53 days before the window");
  assert.ok(!out.notes.some((n) => /limit/.test(n)));
});

test("buildTrainingLoad: rampRate7d is ctl(to) - ctl(to - 7), rounded", async () => {
  const { client } = fakeClient([withTss("2026-03-01T08:00:00", 100)]);
  const out = await buildTrainingLoad(client, { date: "2026-03-10", days: 10 });
  // ctl(03-10) - ctl(03-03): 100·K_CTL·(e^(-9/42) - e^(-2/42))
  const k = 1 - Math.exp(-1 / 42);
  assert.equal(out.current.rampRate7d, Math.round(100 * k * (Math.exp(-9 / 42) - Math.exp(-2 / 42)) * 10) / 10);
  assert.ok(out.notes.some((n) => /Little history: the earliest workout found is on 2026-03-01/.test(n)));
});

test("buildTrainingLoad: seeds skip the warm-up and anchor the day before the window", async () => {
  const { client, calls } = fakeClient([withTss("2026-03-10T08:00:00", 80)]);
  const out = await buildTrainingLoad(client, { date: "2026-03-10", days: 2, seedCtl: 40, seedAtl: 60 });
  const bounds = dayFetchBounds("2026-03-09", "2026-03-10");
  assert.deepEqual(calls[0], { since: bounds.from, until: bounds.to, limit: WORKOUT_LIMIT });
  assert.deepEqual(out.series, [
    { date: "2026-03-09", tss: 0, ctl: 39.1, atl: 52, tsb: -13 },
    { date: "2026-03-10", tss: 80, ctl: 40, atl: 55.7, tsb: -15.7 },
  ]);
  assert.deepEqual(out.current, { ctl: 40, atl: 55.7, tsb: -15.7, rampRate7d: null });
  assert.ok(out.notes.some((n) => /Started from CTL 40 \/ ATL 60/.test(n)));
  assert.ok(!out.notes.some((n) => /start from 0/.test(n)));
});

test("buildTrainingLoad: with seeds, 7 days are enough for a ramp rate (the seed is ctl 7 days back)", async () => {
  const { client } = fakeClient([]);
  const out = await buildTrainingLoad(client, { date: "2026-03-10", days: 7, seedCtl: 40, seedAtl: 40 });
  assert.equal(out.current.rampRate7d, Math.round((40 * Math.exp(-7 / 42) - 40) * 10) / 10);
});

test("buildTrainingLoad: no workouts at all is reported, not just shown as zeros", async () => {
  const { client } = fakeClient([]);
  const out = await buildTrainingLoad(client, { date: "2026-03-10" });
  assert.equal(out.series.length, 28, "28 days by default");
  assert.ok(out.series.every((p) => p.tss === 0 && p.ctl === 0));
  assert.ok(out.notes.some((n) => /No workouts at all from 2026-02-11 to 2026-03-10/.test(n)));
  assert.deepEqual(out.weeks.map((w) => w.weekStart), ["2026-02-09", "2026-02-16", "2026-02-23", "2026-03-02", "2026-03-09"]);
});

test("buildTrainingLoad: workouts without TSS and without a start time are named in notes", async () => {
  const { client } = fakeClient([workout("2026-03-09T10:00:00", 60, { totalTime: 900 }), { totalTime: 100 }]);
  const out = await buildTrainingLoad(client, { date: "2026-03-10", days: 3 });
  // 03-08 is a Sunday: the window splits into two weeks
  assert.deepEqual(out.weeks, [
    { weekStart: "2026-03-02", workouts: 0, durationS: 0, tss: 0 },
    { weekStart: "2026-03-09", workouts: 1, durationS: 900, tss: 0 },
  ]);
  assert.ok(out.notes.some((n) => /1 workout\(s\) from 2026-03-08 to 2026-03-10 have no TSS/.test(n)));
  assert.ok(out.notes.some((n) => /1 workout\(s\) have no start time/.test(n)));
});

test("buildTrainingLoad: reaching the workout limit is reported in notes", async () => {
  const rows = Array.from({ length: WORKOUT_LIMIT }, () => withTss("2026-03-10T08:00:00", 1));
  const { client } = fakeClient(rows);
  const out = await buildTrainingLoad(client, { date: "2026-03-10", days: 1 });
  assert.ok(out.notes.some((n) => /Reached the 600-workout limit/.test(n)));
});

test("buildTrainingLoad: an invalid date or day count is refused before any request", async () => {
  const { client, calls } = fakeClient([]);
  await assert.rejects(buildTrainingLoad(client, { date: "2026-02-30" }), /not a valid calendar date/);
  await assert.rejects(buildTrainingLoad(client, { date: "2026-03-10", days: 121 }), /from 1 to 120/);
  await assert.rejects(buildTrainingLoad(client, { date: "2026-03-10", days: 0 }), /from 1 to 120/);
  assert.equal(calls.length, 0);
});
