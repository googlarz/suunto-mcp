import { test } from "node:test";
import assert from "node:assert/strict";
import { previousDate, summarizeSleep, summarizeRecovery, summarizeActivity, summarizeWorkouts, buildSnapshot, buildSnapshotRange, nearestSample } from "./snapshot.js";

const sleepRow = (id: number, bedtime: string, duration: number, extra: Record<string, unknown> = {}) => ({
  timestamp: bedtime,
  entryData: { SleepId: id, BedtimeStart: bedtime, BedtimeEnd: "end", Duration: duration, IsNap: duration < 10800, DeepSleepDuration: 5000, LightSleepDuration: 15000, REMSleepDuration: 4000, SleepQualityScore: 81, AvgHRV: 62, HRAvg: 52, HRMin: 44, MaxSpo2: 98, ...extra },
});

test("previousDate: month, year and leap boundaries", () => {
  assert.equal(previousDate("2026-09-28"), "2026-09-27");
  assert.equal(previousDate("2026-10-01"), "2026-09-30");
  assert.equal(previousDate("2027-01-01"), "2026-12-31");
  assert.equal(previousDate("2028-03-01"), "2028-02-29");
});

test("summarizeSleep: the longest non-nap is main; a split night is summed; naps stay apart", () => {
  const s = summarizeSleep([sleepRow(2, "2026-09-28T03:31:00.000+02:00", 17000), sleepRow(1, "2026-09-27T23:10:00.000+02:00", 27000), sleepRow(3, "2026-09-28T08:00:00.000+02:00", 5400)]);
  assert.equal(s.main?.sleepId, 1);
  assert.equal(s.main?.durationS, 27000);
  assert.deepEqual(s.otherNights.map((n) => n.sleepId), [2]);
  assert.equal(s.nightSleepS, 44000);
  assert.deepEqual(s.naps.map((n) => n.sleepId), [3]);
  assert.deepEqual([s.main?.deepS, s.main?.remS, s.main?.score, s.main?.avgHrv, s.main?.spo2Max], [5000, 4000, 81, 62, 98]);
});

test("summarizeSleep: no rows is an empty night, not zero hours; a short sleep is a nap with main null", () => {
  assert.deepEqual(summarizeSleep([]), { main: null, otherNights: [], nightSleepS: null, naps: [] });
  const short = summarizeSleep([sleepRow(9, "2026-09-27T23:10:00.000+02:00", 3600)]);
  assert.equal(short.main, null);
  assert.equal(short.nightSleepS, null);
  assert.equal(short.naps.length, 1);
});

test("summarizeSleep: tolerates rows with missing fields", () => {
  const s = summarizeSleep([{ entryData: { SleepId: 1, IsNap: false } }, {}, null]);
  assert.equal(s.main?.durationS, null);
  assert.equal(s.nightSleepS, 0);
});

const rec = (hhmm: string, balance: number | undefined, state = 1) => ({ timestamp: `2026-09-28T${hhmm}:00.000+02:00`, entryData: { Balance: balance, StressState: state } });

test("summarizeRecovery: lowest and highest of the day, first/last and stress samples", () => {
  const r = summarizeRecovery([rec("00:00", 0.6), rec("04:00", 0.42, 1), rec("12:00", 0.9, 2), rec("20:00", 0.5, 3), rec("20:30", 0.5, 3)]);
  assert.equal(r?.samples, 5);
  assert.deepEqual(r?.low, { balance: 0.42, at: "2026-09-28T04:00:00.000+02:00" });
  assert.deepEqual(r?.high, { balance: 0.9, at: "2026-09-28T12:00:00.000+02:00" });
  assert.deepEqual([r?.first, r?.last], [0.6, 0.5]);
  assert.deepEqual(r?.stressStateSamples, { "1": 2, "2": 1, "3": 2 });
});

test("summarizeRecovery: no usable sample is null", () => {
  assert.equal(summarizeRecovery([]), null);
  assert.equal(summarizeRecovery([rec("00:00", undefined)]), null);
  assert.equal(summarizeRecovery(null as any), null);
});

const stats = (day: string, steps: number | null, joules: number | null) => [
  { Name: "stepcount", Sources: [{ Samples: [{ TimeISO8601: `${day}T12:00:00+02:00`, Value: steps }, { TimeISO8601: "2026-12-31T12:00:00+01:00", Value: 99 }] }] },
  { Name: "energyconsumption", Sources: [{ Samples: [{ TimeISO8601: `${day}T12:00:00+02:00`, Value: joules }] }] },
];

test("summarizeActivity: the date's own sample only (the API also returns the next day); joules to kcal", () => {
  assert.deepEqual(summarizeActivity(stats("2026-09-27", 8123, 10_420_945), "2026-09-27"), { steps: 8123, energyKcal: 2491 });
});

test("summarizeActivity: no sample is null — never a quiet 0", () => {
  assert.deepEqual(summarizeActivity(stats("2026-09-27", null, null), "2026-09-27"), { steps: null, energyKcal: null });
  assert.deepEqual(summarizeActivity([], "2026-09-27"), { steps: null, energyKcal: null });
  assert.deepEqual(summarizeActivity(stats("2026-09-27", 0, 0), "2026-09-27"), { steps: 0, energyKcal: 0 }, "a real 0 is data");
  assert.deepEqual(summarizeActivity(null, "2026-09-27"), { steps: null, energyKcal: null });
});

const workout = (isoLocal: string, extra: Record<string, unknown> = {}) => ({
  workoutKey: "6aba8afee2ab172bb4c5fc8d",
  activityId: 23,
  startTime: Date.parse(isoLocal),
  timeOffsetInMinutes: 120,
  totalTime: 2148.802,
  energyConsumption: 319,
  hrdata: { workoutAvgHR: 114, workoutMaxHR: 143, max: 179 },
  tssList: [{ calculationMethod: "MET", trainingStressScore: 33.4 }, { calculationMethod: "HR", trainingStressScore: 24.47 }],
  extensions: [{ type: "SummaryExtension", apps: [{ name: "MONDAY", id: "yn8oz6vu" }] }],
  extensionTypes: ["HEARTRATE", "MANUALLAP"],
  ...extra,
});

test("summarizeWorkouts: only the date's workouts by their own local date, sorted, with the useful fields", () => {
  const out = summarizeWorkouts(
    { payload: [workout("2026-09-27T18:30:00+02:00"), workout("2026-09-28T00:20:00+02:00"), workout("2026-09-27T08:00:00+02:00", { extensions: [], extensionTypes: [] })] },
    "2026-09-27",
  );
  assert.deepEqual(out.map((w) => w.startLocal), ["08:00", "18:30"]);
  const w = out[1];
  assert.deepEqual([w.totalTimeS, w.kcal, w.hrAvg, w.hrMax, w.tss, w.guide, w.hasLaps], [2148.8, 319, 114, 143, 24.5, "MONDAY", true]);
  assert.deepEqual([out[0].guide, out[0].hasLaps], [null, false]);
});

test("summarizeWorkouts: empty and malformed lists", () => {
  assert.deepEqual(summarizeWorkouts({ payload: [] }, "2026-09-27"), []);
  assert.deepEqual(summarizeWorkouts(null, "2026-09-27"), []);
});

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    listSleep: async () => [sleepRow(1, "2026-09-27T23:10:00.000+02:00", 27000)],
    listRecovery: async () => [rec("04:00", 0.4)],
    getDailyStats: async () => stats("2026-09-28", 5000, 8_368_000),
    listWorkouts: async () => ({ payload: [] }),
    ...over,
  } as any;
}

test("buildSnapshot: the sleep section is the night before the date; all sections present", async () => {
  const seen: any = {};
  const snap = await buildSnapshot(fakeClient({ listSleep: async (a: string, b: string) => ((seen.range = [a, b]), [sleepRow(1, "2026-09-27T23:10:00.000+02:00", 27000)]) }), "2026-09-28");
  assert.deepEqual(seen.range, ["2026-09-27", "2026-09-27"]);
  assert.equal(snap.sleepNightOf, "2026-09-27");
  assert.equal(snap.sleep?.main?.sleepId, 1);
  assert.equal(snap.recovery?.low.balance, 0.4);
  assert.deepEqual(snap.activity, { steps: 5000, energyKcal: 2000 });
  assert.deepEqual(snap.workouts, []);
  assert.deepEqual(snap.errors, []);
});

test("buildSnapshot: a failing section is null and explained; the others survive", async () => {
  const snap = await buildSnapshot(
    fakeClient({
      listRecovery: async () => {
        throw new Error("Suunto API 403 /247samples/recovery: Forbidden");
      },
      listWorkouts: async () => {
        throw new Error("rate limited");
      },
    }),
    "2026-09-28",
  );
  assert.equal(snap.recovery, null);
  assert.equal(snap.workouts, null);
  assert.equal(snap.sleep?.main?.sleepId, 1);
  assert.equal(snap.activity?.steps, 5000);
  assert.deepEqual(snap.errors.map((e) => e.section).sort(), ["recovery", "workouts"]);
  assert.match(snap.errors.find((e) => e.section === "recovery")!.error, /403/);
});

test("buildSnapshot: asks for a wide workout window and keeps only the date's own workouts", async () => {
  let asked: any;
  const snap = await buildSnapshot(
    fakeClient({
      listWorkouts: async (o: any) => ((asked = o), { payload: [workout("2026-09-28T09:00:00+02:00"), workout("2026-09-29T00:10:00+02:00")] }),
    }),
    "2026-09-28",
  );
  assert.equal(asked.since, Date.UTC(2026, 8, 28) - 14 * 3_600_000);
  assert.equal(asked.limit, 10);
  assert.equal(snap.workouts?.length, 1);
});

test("nearestSample: the closest within an hour, null beyond it or on bad input", () => {
  const rows = [rec("06:00", 0.5), rec("06:30", 0.6), rec("07:00", 0.7)];
  assert.deepEqual(nearestSample(rows, "2026-09-28T06:20:00.000+02:00"), { balance: 0.6, at: "2026-09-28T06:30:00.000+02:00" });
  assert.equal(nearestSample(rows, "2026-09-28T09:00:00.000+02:00"), null, "two hours from the last sample");
  assert.equal(nearestSample(rows, null), null);
  assert.equal(nearestSample([], "2026-09-28T06:20:00.000+02:00"), null);
});

test("buildSnapshot: recovery carries the waking value (at BedtimeEnd) and the bedtime value (previous day's rows)", async () => {
  const night = sleepRow(1, "2026-09-27T23:10:00.000+02:00", 27000, { BedtimeEnd: "2026-09-28T06:40:00.000+02:00", SleepOnsetLatencyDuration: 600, WakeAfterSleepOnsetDuration: 1200, WakeBeforeOffBedDuration: 300 });
  const snap = await buildSnapshot(
    fakeClient({
      listSleep: async () => [night],
      listRecovery: async () => [
        { timestamp: "2026-09-27T23:00:00.000+02:00", entryData: { Balance: 0.3, StressState: 1 } },
        rec("06:30", 0.9),
        rec("06:00", 0.8),
        rec("12:00", 0.5),
      ],
    }),
    "2026-09-28",
  );
  assert.deepEqual(snap.recovery?.morning, { balance: 0.9, at: "2026-09-28T06:30:00.000+02:00" });
  assert.deepEqual(snap.recovery?.atBedtime, { balance: 0.3, at: "2026-09-27T23:00:00.000+02:00" });
  assert.equal(snap.recovery?.samples, 3, "the previous day's row is not part of the day's summary");
  assert.deepEqual([snap.sleep?.main?.latencyS, snap.sleep?.main?.wasoS, snap.sleep?.main?.wakeBeforeOffBedS], [600, 1200, 300]);
});

test("buildSnapshot: no main sleep means no morning/atBedtime, not a guess", async () => {
  const snap = await buildSnapshot(fakeClient({ listSleep: async () => [] }), "2026-09-28");
  assert.deepEqual([snap.recovery?.morning, snap.recovery?.atBedtime], [null, null]);
});

const rangeClient = (over: Record<string, unknown> = {}, calls: string[] = []) =>
  ({
    listSleep: async (a: string, b: string) => (calls.push(`sleep ${a}..${b}`), [sleepRow(1, "2026-09-26T23:10:00.000+02:00", 27000), sleepRow(2, "2026-09-27T23:40:00.000+02:00", 25000)]),
    listRecovery: async (a: string, b: string) => (calls.push(`recovery ${a}..${b}`), [rec("04:00", 0.4), { timestamp: "2026-09-29T04:00:00.000+02:00", entryData: { Balance: 0.7, StressState: 1 } }]),
    getDailyStats: async () => (calls.push("stats"), [...stats("2026-09-28", 5000, 8_368_000), ...stats("2026-09-29", 7000, 4_184_000)]),
    listWorkouts: async (o: any) => (calls.push(`workouts limit ${o.limit}`), { payload: [workout("2026-09-29T09:00:00+02:00")] }),
    ...over,
  }) as any;

test("buildSnapshotRange: one request per section; each day gets its own night, recovery, steps and workouts", async () => {
  const calls: string[] = [];
  const r = await buildSnapshotRange(rangeClient({}, calls), "2026-09-28", "2026-09-29");
  assert.deepEqual(calls.sort(), ["recovery 2026-09-27..2026-09-29", "sleep 2026-09-27..2026-09-28", "stats", "workouts limit 20"]);
  assert.deepEqual(r.days.map((d) => d.date), ["2026-09-28", "2026-09-29"]);
  assert.deepEqual(r.days.map((d) => d.sleepNightOf), ["2026-09-27", "2026-09-28"]);
  assert.deepEqual(r.days.map((d) => d.sleep?.main?.sleepId ?? null), [2, null], "night of 09-27 -> day 09-28; night of 09-28 has no row");
  assert.deepEqual(r.days.map((d) => d.recovery?.low.balance), [0.4, 0.7]);
  assert.deepEqual(r.days.map((d) => d.activity?.steps), [5000, 7000]);
  assert.deepEqual(r.days.map((d) => d.workouts?.length), [0, 1]);
  assert.deepEqual(r.errors, []);
});

test("buildSnapshotRange: a failing section is null on every day and explained once", async () => {
  const r = await buildSnapshotRange(rangeClient({ listRecovery: async () => { throw new Error("403"); } }), "2026-09-28", "2026-09-29");
  assert.deepEqual(r.days.map((d) => d.recovery), [null, null]);
  assert.equal(r.days[0].activity?.steps, 5000);
  assert.deepEqual(r.errors.map((e) => e.section), ["recovery"]);
});

test("buildSnapshotRange: refuses a reversed range and one over 14 days; 14 days is fine", async () => {
  await assert.rejects(buildSnapshotRange(rangeClient(), "2026-09-29", "2026-09-28"), /on or before/);
  await assert.rejects(buildSnapshotRange(rangeClient(), "2026-09-01", "2026-09-15"), /limited to 14 days; 2026-09-01\.\.2026-09-15 is 15/);
  const ok = await buildSnapshotRange(rangeClient(), "2026-09-01", "2026-09-14");
  assert.equal(ok.days.length, 14);
});

test("buildSnapshotRange: a range across a month and year boundary lists every date once", async () => {
  const r = await buildSnapshotRange(rangeClient(), "2026-12-30", "2027-01-02");
  assert.deepEqual(r.days.map((d) => d.date), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
});
