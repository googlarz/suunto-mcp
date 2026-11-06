import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRestProfile, developerInfo, hrSeries, restRecovery, type HrSample } from "./rest-profile.js";
import { compareWorkout } from "./compare.js";
import { LAP_COLUMNS, lapChecks, lapKind, type shapeLaps } from "./laps.js";
import { parseFit } from "./fit.js";

type Laps = ReturnType<typeof shapeLaps>;

// 1 Hz samples tS = from..to (inclusive), hr from fn(tS); fn returning null drops the sample.
function series(from: number, to: number, fn: (t: number) => number | null): HrSample[] {
  const out: HrSample[] = [];
  for (let t = from; t <= to; t++) {
    const hr = fn(t);
    if (hr !== null) out.push({ tS: t, hr });
  }
  return out;
}

// ---------- hrSeries: timebase ----------

const T0 = Date.UTC(2026, 9, 1, 16, 0, 0); // an arbitrary workout start, epoch ms
const rec = (offsetS: number, hr: unknown, asMs = false) => ({ timestamp: asMs ? T0 + offsetS * 1000 : new Date(T0 + offsetS * 1000), heart_rate: hr });

test("hrSeries: seconds since the FIT session start_time, not since the first record", () => {
  const parsed = { sessions: [{ start_time: new Date(T0) }], records: [rec(7, 100), rec(8, 101), rec(9, 102)] };
  assert.deepEqual(hrSeries(parsed as any).samples, [{ tS: 7, hr: 100 }, { tS: 8, hr: 101 }, { tS: 9, hr: 102 }]);
  assert.equal(hrSeries(parsed as any).startSource, "session.start_time");
  assert.equal(hrSeries(parsed as any).startMs, T0);
});

test("hrSeries: without a session the first record timestamp is time zero", () => {
  const parsed = { records: [rec(7, 100), rec(9, 102)] };
  const s = hrSeries(parsed as any);
  assert.deepEqual(s.samples, [{ tS: 0, hr: 100 }, { tS: 2, hr: 102 }]);
  assert.equal(s.startSource, "first-record");
  assert.equal(s.startMs, T0 + 7000);
});

test("hrSeries: timestamps as epoch ms numbers or ISO strings work like Dates; records without a numeric heart_rate are dropped; output is sorted", () => {
  const parsed = {
    sessions: [{ start_time: T0 }],
    records: [rec(3, 130, true), rec(1, 110, true), rec(2, undefined, true), rec(4, "x", true), rec(5, NaN, true), { heart_rate: 120 }, { timestamp: new Date(T0 + 6000).toISOString(), heart_rate: 140 }],
  };
  assert.deepEqual(hrSeries(parsed as any).samples, [{ tS: 1, hr: 110 }, { tS: 3, hr: 130 }, { tS: 6, hr: 140 }]);
});

test("hrSeries: an empty or missing FIT gives an empty series and no start", () => {
  for (const parsed of [{}, { records: [] }, { records: [{ timestamp: new Date(T0) }] }]) {
    const s = hrSeries(parsed as any);
    assert.deepEqual(s.samples, []);
  }
  assert.equal(hrSeries({} as any).startMs, null);
  assert.equal(hrSeries({} as any).startSource, null);
});

// ---------- developerInfo ----------

test("developerInfo: apps, field descriptions and the channels that carry values", () => {
  const parsed = {
    developer_data_ids: [{ developer_id: 7, application_id: [0xab, 0x01, 0x0f], developer_data_index: 0, manufacturer_id: undefined, application_version: 3 }],
    field_descriptions: [
      { developer_data_index: 0, field_definition_number: 0, fit_base_type_id: 2, field_name: "SmoothHR", units: "bpm" },
      { developer_data_index: 0, field_definition_number: 1, fit_base_type_id: 134, field_name: "Unused", units: "" },
    ],
    records: [{ heart_rate: 90 }, { heart_rate: 91, SmoothHR: 88 }, { SmoothHR: 87, Unused: undefined }],
  };
  assert.deepEqual(developerInfo(parsed as any), {
    apps: [{ devIdx: 0, developerId: 7, applicationId: "ab010f", version: 3 }],
    fields: [
      { name: "SmoothHR", units: "bpm", devIdx: 0, fieldNo: 0, baseType: 2 },
      { name: "Unused", units: "", devIdx: 0, fieldNo: 1, baseType: 134 },
    ],
    devChannels: ["SmoothHR"],
  });
});

test("developerInfo: null when the FIT has no developer data", () => {
  assert.equal(developerInfo({} as any), null);
  assert.equal(developerInfo({ developer_data_ids: [], field_descriptions: [] } as any), null);
});

test("developerInfo: apps without field descriptions still show up", () => {
  const d = developerInfo({ developer_data_ids: [{ developer_data_index: 1, application_id: "already-a-string" }] } as any);
  assert.deepEqual(d, { apps: [{ devIdx: 1, applicationId: "already-a-string" }], fields: [], devChannels: [] });
});

test("developerInfo + hrSeries: a FIT with a developer field, through the real parser", async () => {
  const { buildFit } = await import(new URL("../test-fixtures/fit-builder.mjs", import.meta.url).href);
  const base = Math.floor(T0 / 1000);
  const bytes = buildFit({
    sessionStartUnixS: base,
    devField: { name: "SmoothHR", units: "bpm" },
    records: [{ unixS: base + 2, hr: 90, dev: 5 }, { unixS: base + 3, hr: 91 }, { unixS: base + 4 }],
  });
  const parsed = await parseFit(bytes);
  const d = developerInfo(parsed);
  assert.deepEqual(d?.fields, [{ name: "SmoothHR", units: "bpm", devIdx: 0, fieldNo: 0, baseType: 2 }]);
  assert.deepEqual(d?.devChannels, ["SmoothHR"]);
  assert.equal(d?.apps.length, 1);
  assert.equal(d?.apps[0].devIdx, 0);
  assert.deepEqual(hrSeries(parsed).samples, [{ tS: 2, hr: 90 }, { tS: 3, hr: 91 }]);
  assert.equal(hrSeries(parsed).startSource, "session.start_time");
});

// ---------- restRecovery ----------

// heart rate rises 80 -> 150 up to t = 100 (the rest starts), then falls 1 bpm/s
const RAMP = (t: number) => (t <= 100 ? 150 - (100 - t) : 150 - (t - 100));

test("restRecovery: ramp and recovery with known t10/t20/t30, end and rate", () => {
  const r = restRecovery(series(60, 200, RAMP), { startOffsetS: 100, durationS: 60 });
  assert.equal(r.peakHr, 149.3, "the smoothed peak: (149 + 150 + 149) / 3");
  assert.equal(r.peakAtS, 0);
  assert.equal(r.endHr, 92, "mean of the last 5 s: 94, 93, 92, 91, 90");
  assert.equal(r.dropTotal, 57.3);
  assert.equal(r.t10S, 11, "139 is the first smoothed value under 149.33 - 10");
  assert.equal(r.t20S, 21);
  assert.equal(r.t30S, 31);
  assert.equal(r.recoveryBpmPerMin, 59.3);
  assert.equal(r.sampleCount, 61);
  assert.equal(r.coverage, 1);
  assert.equal(r.note, null);
});

test("restRecovery: the peak can land inside the rest (optical HR lag) and is timed from the rest start", () => {
  // keeps rising for 15 s after the rest started, peak 165 at t = 115, then falls 1 bpm/s
  const hr = (t: number) => (t <= 115 ? 150 + (t - 100) : 165 - (t - 115));
  const r = restRecovery(series(60, 200, hr), { startOffsetS: 100, durationS: 90 });
  assert.equal(r.peakHr, 164.3);
  assert.equal(r.peakAtS, 15);
  assert.equal(r.t10S, 11, "seconds after the peak, not after the rest start");
  assert.equal(r.t30S, 31);
  assert.equal(r.recoveryBpmPerMin, 59.3);
});

test("restRecovery: the peak is searched from 15 s before the rest to 30 s after its start only", () => {
  const before = (t: number) => (t === 80 ? 190 : t === 90 ? 140 : 120); // 190 at -20 s: outside; 140 at -10 s: inside
  assert.equal(restRecovery(series(60, 200, before), { startOffsetS: 100, durationS: 60 }).peakHr, 126.7, "the 140 at -10 s, smoothed with its 120 neighbours");
  const spike = (t: number) => (t === 135 ? 190 : 120); // 190 at +35 s: outside
  assert.equal(restRecovery(series(60, 200, spike), { startOffsetS: 100, durationS: 60 }).peakHr, 120);
  const preRest = (t: number) => (t === 85 ? 160 : 120); // exactly -15 s: inside, and the peak is before the rest
  const r = restRecovery(series(60, 200, preRest), { startOffsetS: 100, durationS: 60 });
  assert.equal(r.peakHr, 133.3);
  assert.equal(r.peakAtS, -15);
});

test("restRecovery: a peak search does not run past the end of a short rest", () => {
  const r = restRecovery(series(60, 200, (t) => (t === 125 ? 180 : 120)), { startOffsetS: 100, durationS: 20 });
  assert.equal(r.peakHr, 120);
});

test("restRecovery: thresholds never reached inside the window are null; the rate uses the window when it is under 60 s", () => {
  // falls 0.5 bpm/s from 150: t10 at 20 s, t20 at 40 s, t30 never within a 35 s window
  const r = restRecovery(series(60, 200, (t) => (t <= 100 ? 150 - (100 - t) : 150 - (t - 100) / 2)), { startOffsetS: 100, durationS: 35 });
  assert.equal(r.t10S, 21);
  assert.equal(r.t20S, null);
  assert.equal(r.t30S, null);
  assert.equal(r.recoveryBpmPerMin, 29.1, "17 bpm (smoothed 149.5 to 132.5) in 35 s");
});

test("restRecovery: 3-sample smoothing ignores a single-sample dip", () => {
  const r = restRecovery(series(60, 200, (t) => (t < 100 ? 120 : t === 100 ? 150 : t === 103 ? 130 : 148)), { startOffsetS: 100, durationS: 60 });
  assert.equal(r.t10S, null, "raw HR touched 130 once, the smoothed series never got to 140");
  assert.equal(r.t20S, null);
});

test("restRecovery: sparse samples (every 2 s) halve the coverage; end is the mean of what exists in the last 5 s", () => {
  const r = restRecovery(series(60, 200, (t) => (t % 2 === 0 ? RAMP(t) : null)), { startOffsetS: 100, durationS: 60 });
  assert.equal(r.coverage, 0.5);
  assert.equal(r.sampleCount, 31);
  assert.equal(r.peakHr, 148.7, "(148 + 150 + 148) / 3 over neighbours 2 s apart");
  assert.equal(r.endHr, 92, "t = 156, 158, 160: 94, 92, 90");
  assert.equal(r.note, null);
});

test("restRecovery: too few samples returns nulls and says why, instead of throwing", () => {
  const few = restRecovery(series(100, 102, () => 120), { startOffsetS: 100, durationS: 60 });
  assert.equal(few.sampleCount, 3);
  assert.equal(few.peakHr, null);
  assert.equal(few.endHr, null);
  assert.equal(few.dropTotal, null);
  assert.equal(few.t10S, null);
  assert.equal(few.recoveryBpmPerMin, null);
  assert.match(few.note!, /3 .*sample.*at least 5/i);
  const none = restRecovery([], { startOffsetS: 100, durationS: 60 });
  assert.equal(none.sampleCount, 0);
  assert.equal(none.coverage, 0);
  assert.equal(none.peakHr, null);
  assert.match(none.note!, /0 .*sample/i);
  // samples exist only outside the rest window
  const outside = restRecovery(series(0, 90, () => 120), { startOffsetS: 100, durationS: 60 });
  assert.equal(outside.sampleCount, 0);
  assert.equal(outside.peakHr, null);
});

test("restRecovery: opts override the defaults", () => {
  const r = restRecovery(series(60, 200, RAMP), { startOffsetS: 100, durationS: 60 }, { endTailS: 10 });
  assert.equal(r.endHr, 94.5, "mean of t = 151..160: 99 down to 90");
});

// ---------- buildRestProfile ----------

const fixtureLaps = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/compare/${name}.laps.json`, import.meta.url), "utf8")) as Laps;

// A lap table from [label, durationS] specs (hr max/min 110/90), startOffsetS cumulative.
function lapsOf(specs: [string, number][], startTime: number | null = T0): Laps {
  let off = 0;
  const rows = specs.map(([label, d], k) => {
    const row = [k + 1, off, d, 100, 110, 90, 1, lapKind(label), label];
    off += d;
    return row;
  });
  return { workoutKey: "synthetic", activityId: 23, startTime, totalTimeS: off, guide: null, tss: [], pte: null, peakEpoc: null, recoveryTime: null, hrZoneTimeS: null, feeling: null, lapCount: rows.length, checks: lapChecks(rows), laps: { cols: LAP_COLUMNS, rows } } as unknown as Laps;
}

// A synthetic per-set strength session: prep, set 1, rest, set 2, rest, set 3, done.
function guided(restLabel: (k: number, S: number) => string, restS: number, startTime: number | null = T0): Laps {
  return lapsOf(
    [
      ["100kg 3x5 | Squat", 60],
      ["Squat | 100kg 3x5", 30],
      [restLabel(2, 3), restS],
      ["Squat | 100kg 3x5", 30],
      [restLabel(3, 3), restS],
      ["Squat | 100kg 3x5", 30],
      ["Session complete", 3],
    ],
    startTime,
  );
}

// HR for the guided() session above: peaks of 150 at 0 s into each rest, falling 1 bpm/s; elsewhere 110.
function guidedHr(restStarts: number[]): (t: number) => number {
  return (t) => {
    const s = [...restStarts].reverse().find((x) => t >= x);
    return s !== undefined && 150 - (t - s) > 110 ? 150 - (t - s) : 110;
  };
}

function parsedFrom(samples: HrSample[], startMs: number, sessionStart: number | null = startMs) {
  return {
    sessions: sessionStart === null ? [] : [{ start_time: new Date(sessionStart) }],
    records: samples.map((s) => ({ timestamp: new Date(startMs + s.tS * 1000), heart_rate: s.hr })),
  } as any;
}

test("buildRestProfile: countdown rests, the lap lasts the target but recovery shows in the record-level HR", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60);
  // rests start at 90 s and 180 s into the session
  const parsed = parsedFrom(series(0, 245, guidedHr([90, 180])), T0);
  const p = buildRestProfile(laps, parsed);
  assert.equal(p.status, "ok");
  assert.equal(p.restMode, "countdown");
  assert.equal(p.reliable, true);
  assert.equal(p.workoutKey, "synthetic");
  assert.equal(p.rests.length, 2);
  const [a, b] = p.rests;
  assert.equal(a.exercise, "Squat");
  assert.equal(a.exerciseN, 1);
  assert.equal(a.set, 1, "the rest before set 2 follows set 1");
  assert.equal(b.set, 2);
  assert.equal(a.actualDurationS, 60);
  assert.equal(a.plannedRestS, 60, "no target in a countdown label: the guide's rest is the median of the laps");
  assert.equal(a.peakHr, 149, "the smoothed peak is the sample after the step up: (150 + 149 + 148) / 3");
  assert.equal(a.peakAtS, 1);
  assert.equal(a.t10S, 10);
  assert.equal(a.t20S, 20);
  assert.equal(a.t30S, 30);
  assert.equal(a.endHr, 110, "back at the 110 plateau by the end");
  assert.deepEqual(p.perExercise, [{ name: "Squat", n: 1, medianT20S: 20, medianEndHr: 110, medianRecoveryBpmPerMin: 39.7 }]);
  assert.equal(p.alignment.workoutStartSource, "session.start_time");
  assert.equal(p.alignment.lapStartTimeMs, T0);
  assert.equal(p.alignment.fitStartMs, T0);
  assert.equal(p.alignment.startSkewS, 0);
  assert.equal(p.developer, null);
});

test("buildRestProfile: stopwatch rests carry the target; the actual duration can differ from it", () => {
  const laps = guided((k, S) => `45s target · Next: set ${k}/${S}`, 60);
  const p = buildRestProfile(laps, parsedFrom(series(0, 245, guidedHr([90, 180])), T0));
  assert.equal(p.restMode, "stopwatch");
  assert.equal(p.rests[0].plannedRestS, 45);
  assert.equal(p.rests[0].actualDurationS, 60);
  assert.equal(p.rests[0].t20S, 20);
});

test("buildRestProfile: timebase. Lap offsets count from the session start, even when the first record comes later", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60);
  // the first record is 25 s after the session start; the HR curve is defined on session time
  const samples = series(25, 245, guidedHr([90, 180]));
  const p = buildRestProfile(laps, parsedFrom(samples, T0));
  assert.equal(p.rests[0].peakAtS, 1);
  assert.equal(p.rests[0].t20S, 20);
  assert.equal(p.alignment.workoutStartSource, "session.start_time");
  assert.equal(p.alignment.fitStartMs, T0);
  assert.equal(p.alignment.startSkewS, 0);
});

test("buildRestProfile: without a session message the lap table's startTime is time zero, not the first record", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60);
  const samples = series(25, 245, guidedHr([90, 180])); // first record 25 s after the workout start
  const p = buildRestProfile(laps, parsedFrom(samples, T0, null));
  assert.equal(p.alignment.workoutStartSource, "laps.startTime");
  assert.equal(p.alignment.fitStartMs, T0 + 25_000, "the FIT's own start is still its first record");
  assert.equal(p.alignment.startSkewS, null, "a first record is not a second reading of the start");
  assert.equal(p.rests[0].peakAtS, 1, "windows line up as if the session start were there");
  assert.equal(p.rests[0].t20S, 20);
  assert.equal(p.reliable, true);
  assert.equal(p.note, null);
});

test("buildRestProfile: with neither a session start nor a lap-table startTime the first record is time zero", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60, null);
  const p = buildRestProfile(laps, parsedFrom(series(25, 245, guidedHr([90, 180])), T0, null));
  assert.equal(p.alignment.workoutStartSource, "first-record");
  assert.equal(p.alignment.lapStartTimeMs, null);
  assert.equal(p.alignment.startSkewS, null);
  assert.notEqual(p.rests[0].peakAtS, 1, "every window is 25 s early against the HR curve");
});

test("buildRestProfile: a small start skew is reported, not corrected", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60, T0 - 3000);
  const p = buildRestProfile(laps, parsedFrom(series(0, 245, guidedHr([90, 180])), T0));
  assert.equal(p.alignment.lapStartTimeMs, T0 - 3000);
  assert.equal(p.alignment.startSkewS, 3);
  assert.match(p.note!, /3 s/);
  assert.equal(p.reliable, true);
  assert.equal(p.rests[0].peakAtS, 1, "windows still use the lap offsets as they are");
});

test("buildRestProfile: a start skew over 60 s makes the profile unreliable", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60, T0 - 90_000);
  const p = buildRestProfile(laps, parsedFrom(series(0, 245, guidedHr([90, 180])), T0));
  assert.equal(p.alignment.startSkewS, 90);
  assert.equal(p.reliable, false);
  assert.match(p.note!, /90 s.*unreliable/);
  const edge = buildRestProfile(guided((k, S) => `Next: set ${k}/${S}`, 60, T0 - 60_000), parsedFrom(series(0, 245, guidedHr([90, 180])), T0));
  assert.equal(edge.reliable, true, "exactly 60 s is still only a note");
});

test("buildRestProfile: unguided and lap-less workouts pass the compare status through with no rests", () => {
  for (const [name, status] of [["unguided", "no-guide-labels"], ["no-laps", "no-laps"]] as const) {
    const laps = fixtureLaps(name);
    const p = buildRestProfile(laps, parsedFrom(series(0, 100, () => 120), T0));
    assert.equal(p.status, status);
    assert.deepEqual(p.rests, []);
    assert.deepEqual(p.perExercise, []);
    assert.equal(p.reliable, false);
    assert.equal(p.note, compareWorkout(laps).note);
    assert.equal(p.restMode, null);
  }
});

test("buildRestProfile: a FIT without heart rate keeps the rests with null metrics and says so", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60);
  const p = buildRestProfile(laps, { records: [{ timestamp: new Date(T0) }, { timestamp: new Date(T0 + 1000) }] } as any);
  assert.equal(p.rests.length, 2);
  assert.equal(p.rests[0].peakHr, null);
  assert.equal(p.rests[0].sampleCount, 0);
  assert.match(p.note!, /heart rate/i);
  assert.deepEqual(p.perExercise, [{ name: "Squat", n: 1, medianT20S: null, medianEndHr: null, medianRecoveryBpmPerMin: null }]);
});

test("buildRestProfile: a lap table without startOffsetS cannot be joined to the FIT", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60);
  for (const row of laps.laps.rows) row[1] = null;
  const p = buildRestProfile(laps, parsedFrom(series(0, 245, () => 120), T0));
  assert.equal(p.rests.length, 2);
  assert.equal(p.rests[0].peakHr, null);
  assert.match(p.rests[0].note!, /startOffsetS/);
});

test("buildRestProfile: the clean fixture session, one entry per rest, set = the set before it, medians per exercise", () => {
  const laps = fixtureLaps("clean-3ex");
  const cmp = compareWorkout(laps);
  const parsed = parsedFrom(series(0, Math.ceil(laps.totalTimeS! ) + 5, () => 120), laps.startTime!);
  const p = buildRestProfile(laps, parsed);
  assert.deepEqual(p.rests.map((r) => [r.exerciseN, r.exercise, r.set]), [[1, "Back Squat", 1], [1, "Back Squat", 2], [2, "Bench Press", 1], [2, "Bench Press", 2], [3, "Seated Cable Row", 1]]);
  assert.deepEqual(p.rests.map((r) => r.actualDurationS), cmp.exercises.flatMap((e) => e.rests.map((r) => r[2])));
  assert.deepEqual(p.perExercise.map((e) => [e.n, e.name]), [[1, "Back Squat"], [2, "Bench Press"], [3, "Seated Cable Row"]]);
  assert.equal(p.perExercise[0].medianEndHr, 120);
});

test("buildRestProfile: a workout guide's rest between exercises belongs to the exercise before it", () => {
  const laps = fixtureLaps("workout-guide");
  const p = buildRestProfile(laps, parsedFrom(series(0, 1160, () => 120), laps.startTime!));
  assert.equal(p.status, "ok");
  assert.deepEqual(p.rests.map((r) => [r.exerciseN, r.exercise, r.set, r.actualDurationS]), [[1, "Push-Up", 1, 95.4], [2, "Dumbbell Curl", 1, 80.2], [3, "Plank", 1, 61]]);
});

test("buildRestProfile: a strength guide without between-set rests has none to profile", () => {
  const laps = fixtureLaps("per-exercise");
  const p = buildRestProfile(laps, parsedFrom(series(0, 100, () => 120), laps.startTime!));
  assert.equal(p.status, "ok");
  assert.deepEqual(p.rests, []);
  assert.match(p.note!, /no between-set rests/i);
});

test("buildRestProfile: the developer block lists the FIT's developer fields", () => {
  const laps = guided((k, S) => `Next: set ${k}/${S}`, 60);
  const parsed = {
    ...parsedFrom(series(0, 245, () => 120), T0),
    developer_data_ids: [{ developer_data_index: 0, application_id: [1, 255] }],
    field_descriptions: [{ developer_data_index: 0, field_definition_number: 4, fit_base_type_id: 2, field_name: "X", units: "bpm" }],
  };
  parsed.records[3] = { ...parsed.records[3], X: 7 };
  assert.deepEqual(buildRestProfile(laps, parsed).developer, {
    apps: [{ devIdx: 0, applicationId: "01ff" }],
    fields: [{ name: "X", units: "bpm", devIdx: 0, fieldNo: 4, baseType: 2 }],
    devChannels: ["X"],
  });
});

// ---------- review findings ----------

test("restRecovery: a gap in the HR at the start of a long rest returns nulls with a note, not a crash", () => {
  // a 90 s rest, no HR from 60 s before to 40 s into it, plenty of samples afterwards
  const r = restRecovery(series(0, 300, (t) => (t >= 60 && t < 140 ? null : 120)), { startOffsetS: 100, durationS: 90 });
  assert.ok(r.sampleCount >= 5);
  assert.equal(r.peakHr, null);
  assert.equal(r.t20S, null);
  assert.equal(r.endHr, null);
  assert.match(r.note!, /no HR sample in the peak search window/);
});

test("restRecovery: one spike of 175 in a flat 140 does not become the peak, a drop or a recovery rate", () => {
  const r = restRecovery(series(60, 200, (t) => (t === 105 ? 175 : 140)), { startOffsetS: 100, durationS: 60 });
  assert.equal(r.peakHr, 151.7, "(140 + 175 + 140) / 3");
  assert.equal(r.dropTotal, 11.7);
  assert.equal(r.t20S, null);
  assert.equal(r.t30S, null);
  assert.ok(r.recoveryBpmPerMin! < 15, `rate ${r.recoveryBpmPerMin}`);
});

test("hrSeries: samples outside 30-250 bpm are dropped", () => {
  const parsed = { sessions: [{ start_time: T0 }], records: [rec(1, 0, true), rec(2, 29, true), rec(3, 30, true), rec(4, 250, true), rec(5, 251, true), rec(6, 255, true)] };
  assert.deepEqual(hrSeries(parsed as any).samples, [{ tS: 3, hr: 30 }, { tS: 4, hr: 250 }]);
});

test("hrSeries: records sharing a timestamp collapse to the last one", () => {
  const parsed = { sessions: [{ start_time: T0 }], records: [rec(1, 100, true), rec(2, 110, true), rec(2, 120, true), rec(3, 130, true)] };
  assert.deepEqual(hrSeries(parsed as any).samples, [{ tS: 1, hr: 100 }, { tS: 2, hr: 120 }, { tS: 3, hr: 130 }]);
  const r = restRecovery(hrSeries({ sessions: parsed.sessions, records: Array.from({ length: 30 }, (_, i) => rec(i, 120, true)).flatMap((x) => [x, x]) } as any).samples, { startOffsetS: 0, durationS: 20 });
  assert.equal(r.sampleCount, 21, "duplicates do not inflate the sample count");
});

test("hrSeries: the lap table's startTime is time zero when there is no session start", () => {
  const parsed = { records: [rec(7, 100, true)] };
  assert.deepEqual(hrSeries(parsed as any, T0 - 3000).samples, [{ tS: 10, hr: 100 }]);
  assert.equal(hrSeries(parsed as any, T0 - 3000).startSource, "laps.startTime");
  assert.equal(hrSeries(parsed as any, T0 - 3000).fitStartMs, T0 + 7000);
  assert.equal(hrSeries({ ...parsed, sessions: [{ start_time: T0 }] } as any, T0 - 3000).startSource, "session.start_time", "a session start wins");
});

test("buildRestProfile: a split rest gets a note on its entry only", () => {
  const laps = lapsOf([
    ["100kg 3x5 | Squat", 60],
    ["Squat | 100kg 3x5", 30],
    ["Next: set 2/3", 25], // a lap pressed during the countdown splits the rest
    ["Next: set 2/3", 35],
    ["Squat | 100kg 3x5", 30],
    ["Next: set 3/3", 60],
    ["Squat | 100kg 3x5", 30],
    ["Session complete", 3],
  ]);
  const p = buildRestProfile(laps, parsedFrom(series(0, 300, () => 120), T0));
  assert.equal(p.rests.length, 2);
  assert.equal(p.rests[0].actualDurationS, 60, "both laps make up one rest");
  assert.match(p.rests[0].note!, /spans several laps/);
  assert.equal(p.rests[1].note, null);
});

test("buildRestProfile: a workout guide with HR that falls in each rest profiles each rest after its exercise", () => {
  const laps = fixtureLaps("workout-guide"); // rests at 245 s (95.4 s), 608.7 s (80.2 s) and 904.6 s (61 s)
  const hr = (t: number) => {
    const s = [245, 608.7, 904.6].reverse().find((x) => t >= x);
    return s !== undefined ? Math.max(110, 150 - (t - s)) : 110;
  };
  const p = buildRestProfile(laps, parsedFrom(series(0, 1160, hr), laps.startTime!));
  assert.deepEqual(p.rests.map((r) => [r.exercise, r.set]), [["Push-Up", 1], ["Dumbbell Curl", 1], ["Plank", 1]]);
  assert.equal(p.rests[0].peakAtS, 1);
  assert.equal(p.rests[0].t10S, 10);
  assert.equal(p.rests[0].t20S, 20);
  assert.equal(p.rests[0].endHr, 110);
  assert.ok(p.rests.every((r) => r.t20S !== null && r.coverage >= 0.98));
  assert.deepEqual(p.perExercise.map((e) => e.name), ["Push-Up", "Dumbbell Curl", "Plank"]);
});
