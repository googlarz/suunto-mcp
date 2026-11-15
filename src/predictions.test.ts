import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DAYS_AHEAD,
  MAX_SCORED_PER_CALL,
  MIN_BUCKET_N,
  MIN_SCORED,
  SCORE_DELAY_DAYS,
  filePredictionStore,
  logPrediction,
  memoryPredictionStore,
  predictionStats,
  scoreHrv,
  scorePredictions,
  scoreRecovery,
  scoreRepsHit,
  voidPrediction,
  type Ledger,
  type Prediction,
} from "./predictions.js";
import { SuuntoNotFoundError } from "./errors.js";

const NOW = new Date(2026, 10, 15, 12, 0, 0); // local noon, Sunday 2026-11-15
const TODAY = "2026-11-15";
const KEY = "0123456789abcdef01234567";

const ok = (over: Record<string, unknown> = {}) => ({ about: "2026-11-16", kind: "session_done", probability: 0.8, ...over });

// ---------- logging ----------

test("log_prediction: each kind is stored with its own fields, an id, madeAt and the due date", async () => {
  const store = memoryPredictionStore();
  const a = await logPrediction(ok({ note: "planned", rule: "deload-rule" }), store, { now: NOW });
  assert.deepEqual(a.saved, { id: "p1", madeAt: NOW.toISOString(), about: "2026-11-16", kind: "session_done", probability: 0.8, note: "planned", rule: "deload-rule", due: "2026-11-18" });
  assert.equal(a.predictions, 1);
  const b = await logPrediction({ about: "2026-11-17", kind: "reps_hit", probability: 0.6, exercise: "Back Squat", sets: 3, reps: 5, kg: 100 }, store, { now: NOW });
  assert.deepEqual([b.saved.id, b.saved.exercise, b.saved.sets, b.saved.reps, b.saved.kg, b.saved.due], ["p2", "Back Squat", 3, 5, 100, "2026-11-19"]);
  const c = await logPrediction({ about: TODAY, kind: "recovery_morning_at_least", probability: 0.5, threshold: 0.6 }, store, { now: NOW });
  assert.deepEqual([c.saved.id, c.saved.threshold, c.saved.due], ["p3", 0.6, "2026-11-17"]);
  const d = await logPrediction({ about: "2026-11-16", kind: "hrv_in_band", probability: 0 }, store, { now: NOW });
  assert.equal(d.saved.probability, 0);
  assert.equal((await store.load())!.predictions.length, 4);
});

test("log_prediction: a reps_hit about a workoutKey is due two days after it was made (the workout's date is not known yet)", async () => {
  const store = memoryPredictionStore();
  const r = await logPrediction({ about: KEY.toUpperCase(), kind: "reps_hit", probability: 0.5, exercise: "Bench Press", sets: 3, reps: 8 }, store, { now: NOW });
  assert.equal(r.saved.about, KEY);
  assert.equal(r.saved.due, "2026-11-17");
});

test("log_prediction: strict validation refuses bad input and writes nothing", async () => {
  const reps = { about: "2026-11-16", kind: "reps_hit", probability: 0.5, exercise: "Squat", sets: 3, reps: 5 };
  const bad: [unknown, RegExp][] = [
    [null, /object/],
    [[], /object/],
    [{}, /about is required/],
    [ok({ about: "tomorrow" }), /about must be a calendar date/],
    [ok({ about: "2026-02-30" }), /about must be a calendar date/],
    [ok({ about: KEY }), /about must be a calendar date YYYY-MM-DD/], // a workoutKey only for reps_hit
    [ok({ about: "2026-11-14" }), /about .* before today/],
    [ok({ about: "2027-01-15" }), /more than 60 days/],
    [ok({ kind: undefined }), /kind is required/],
    [ok({ kind: "weather" }), /kind must be one of/],
    [ok({ probability: undefined }), /probability is required/],
    [ok({ probability: "0.5" }), /probability must be a finite number/],
    [ok({ probability: -0.01 }), /probability must be between 0 and 1/],
    [ok({ probability: 1.01 }), /probability must be between 0 and 1/],
    [ok({ probability: Number.NaN }), /probability must be a finite number/],
    [ok({ note: 5 }), /note must be a string/],
    [ok({ note: "x".repeat(501) }), /note must be at most 500/],
    [ok({ rule: "" }), /rule must not be empty/],
    [ok({ rule: "x".repeat(65) }), /rule must be at most 64/],
    [ok({ mood: "x" }), /mood is not a known field/],
    [ok({ id: "p9" }), /id is not a known field/],
    [ok({ outcome: { result: "hit" } }), /outcome is not a known field/],
    [ok({ exercise: "Squat" }), /exercise is only for kind reps_hit/],
    [ok({ threshold: 0.5 }), /threshold is only for kind recovery_morning_at_least/],
    [{ ...reps, exercise: undefined }, /exercise is required for kind reps_hit/],
    [{ ...reps, exercise: " " }, /exercise must not be empty/],
    [{ ...reps, sets: undefined }, /sets is required/],
    [{ ...reps, sets: 0 }, /sets must be between 1 and 20/],
    [{ ...reps, sets: 21 }, /sets must be between 1 and 20/],
    [{ ...reps, sets: 2.5 }, /sets must be an integer/],
    [{ ...reps, reps: 0 }, /reps must be between 1 and 200/],
    [{ ...reps, reps: 201 }, /reps must be between 1 and 200/],
    [{ ...reps, kg: -1 }, /kg must be between 0 and 1000/],
    [{ ...reps, kg: 1001 }, /kg must be between 0 and 1000/],
    [{ ...reps, threshold: 0.5 }, /threshold is only for kind recovery_morning_at_least/],
    [{ about: "2026-11-16", kind: "recovery_morning_at_least", probability: 0.5 }, /threshold is required for kind recovery_morning_at_least/],
    [{ about: "2026-11-16", kind: "recovery_morning_at_least", probability: 0.5, threshold: 1.01 }, /threshold must be between 0 and 1/],
    [{ about: "2026-11-16", kind: "recovery_morning_at_least", probability: 0.5, threshold: -0.1 }, /threshold must be between 0 and 1/],
    [{ about: "2026-11-16", kind: "session_done", probability: 0.5, sets: 3 }, /sets is only for kind reps_hit/],
  ];
  for (const [input, re] of bad) {
    const store = memoryPredictionStore();
    await assert.rejects(logPrediction(input, store, { now: NOW }), re, JSON.stringify(input));
    assert.equal(await store.load(), null, `nothing written for ${JSON.stringify(input)}`);
  }
});

test("log_prediction: boundaries — about today and today+60 are accepted, probability 0 and 1 too, yesterday and today+61 are not", async () => {
  const store = memoryPredictionStore();
  await logPrediction(ok({ about: TODAY, probability: 1 }), store, { now: NOW });
  await logPrediction(ok({ about: "2027-01-14", probability: 0 }), store, { now: NOW }); // 60 days ahead
  assert.equal(MAX_DAYS_AHEAD, 60);
  await assert.rejects(logPrediction(ok({ about: "2027-01-15" }), store, { now: NOW }), /more than 60 days/);
  await assert.rejects(logPrediction(ok({ about: "2026-11-14" }), store, { now: NOW }), /before today/);
});

test("log_prediction: the id never reuses a number, and a full ledger refuses another entry", async () => {
  const store = memoryPredictionStore();
  const base: Prediction = { id: "p7", madeAt: NOW.toISOString(), about: "2026-11-16", kind: "session_done", probability: 0.5, due: "2026-11-18" };
  await store.save({ predictions: [base] });
  assert.equal((await logPrediction(ok(), store, { now: NOW })).saved.id, "p8");
  const full: Ledger = { predictions: Array.from({ length: 2000 }, (_, i) => ({ ...base, id: `p${i + 1}` })) };
  await store.save(full);
  await assert.rejects(logPrediction(ok(), store, { now: NOW }), /at most 2000/);
  assert.equal((await store.load())!.predictions.length, 2000);
});

test("log_prediction: logged predictions cannot be edited: logging again adds a new one and changes nothing else", async () => {
  const store = memoryPredictionStore();
  const first = (await logPrediction(ok(), store, { now: NOW })).saved;
  await logPrediction(ok({ probability: 0.1 }), store, { now: new Date(2026, 10, 15, 13) });
  const [p1, p2] = (await store.load())!.predictions;
  assert.deepEqual(p1, first);
  assert.equal(p2.id, "p2");
});

// ---------- void ----------

const withOne = async (over: Partial<Prediction> = {}) => {
  const store = memoryPredictionStore();
  await store.save({ predictions: [{ id: "p1", madeAt: NOW.toISOString(), about: "2026-11-16", kind: "session_done", probability: 0.5, due: "2026-11-18", ...over }] });
  return store;
};

test("void_prediction: marks it void with the reason and keeps everything else; due day minus one works, due day does not", async () => {
  const store = await withOne();
  const r = await voidPrediction({ id: "p1", reason: "plans changed" }, store, { now: new Date(2026, 10, 17, 9) }); // 2026-11-17 = due - 1
  assert.deepEqual(r.voided, { at: new Date(2026, 10, 17, 9).toISOString(), reason: "plans changed" });
  const stored = (await store.load())!.predictions[0];
  assert.deepEqual([stored.id, stored.about, stored.probability, stored.voided?.reason], ["p1", "2026-11-16", 0.5, "plans changed"]);

  const late = await withOne();
  await assert.rejects(voidPrediction({ id: "p1", reason: "too late" }, late, { now: new Date(2026, 10, 18, 9) }), /due date \(2026-11-18\)/);
  assert.equal((await late.load())!.predictions[0].voided, undefined);
});

test("void_prediction: refuses unknown ids, empty or missing reasons and scored predictions; voiding twice changes nothing", async () => {
  const store = await withOne();
  await assert.rejects(voidPrediction({ id: "p9", reason: "x" }, store, { now: NOW }), /no prediction p9/);
  await assert.rejects(voidPrediction({ id: "p1" }, store, { now: NOW }), /reason is required/);
  await assert.rejects(voidPrediction({ id: "p1", reason: "  " }, store, { now: NOW }), /reason must not be empty/);
  await assert.rejects(voidPrediction({ reason: "x" }, store, { now: NOW }), /id is required/);
  await assert.rejects(voidPrediction({ id: "p1", reason: "x", extra: 1 }, store, { now: NOW }), /extra is not a known field/);
  const first = await voidPrediction({ id: "p1", reason: "first" }, store, { now: NOW });
  const again = await voidPrediction({ id: "p1", reason: "second" }, store, { now: new Date(2026, 10, 16) });
  assert.equal(again.alreadyVoided, true);
  assert.deepEqual(again.voided, first.voided);

  const scored = await withOne({ outcome: { result: "hit", scoredAt: NOW.toISOString(), detail: "x" } });
  await assert.rejects(voidPrediction({ id: "p1", reason: "x" }, scored, { now: NOW }), /already scored/);
});

// ---------- scoring: the rules ----------

const band = (over: Record<string, unknown> = {}) => ({ n: 28, median: 42, p25: 41, p75: 43, last7Median: 42, latest: 42, latestVsBand: "within", ...over });

test("hrv_in_band: within the band (edges inclusive) is a hit, above or below a miss; no value or no band is unresolvable", () => {
  assert.equal(scoreHrv(band() as any).result, "hit");
  assert.equal(scoreHrv(band({ latest: 41, latestVsBand: "within" }) as any).result, "hit");
  assert.equal(scoreHrv(band({ latest: 43, latestVsBand: "within" }) as any).result, "hit");
  assert.equal(scoreHrv(band({ latest: 40.9, latestVsBand: "below" }) as any).result, "miss");
  assert.equal(scoreHrv(band({ latest: 43.1, latestVsBand: "above" }) as any).result, "miss");
  const noValue = scoreHrv(band({ latest: null, latestVsBand: null }) as any);
  assert.deepEqual([noValue.result, /no HRV was recorded/.test(noValue.detail)], ["unresolvable", true]);
  const noBand = scoreHrv(band({ n: 6, p25: null, p75: null, latestVsBand: null }) as any);
  assert.deepEqual([noBand.result, /only 6 nights/.test(noBand.detail), /at least 7/.test(noBand.detail)], ["unresolvable", true, true]);
  assert.equal(scoreHrv(band({ latest: 41 }) as any).observed, 41);
});

test("recovery_morning_at_least: at the threshold is a hit, just below a miss, no value unresolvable", () => {
  const rec = (latest: number | null) => band({ latest, latestVsBand: null }) as any;
  assert.equal(scoreRecovery(rec(0.6), 0.6).result, "hit");
  assert.equal(scoreRecovery(rec(0.59), 0.6).result, "miss");
  assert.equal(scoreRecovery(rec(0.61), 0.6).result, "hit");
  assert.equal(scoreRecovery(rec(0), 0).result, "hit");
  const none = scoreRecovery(rec(null), 0.6);
  assert.deepEqual([none.result, /no morning recovery/.test(none.detail)], ["unresolvable", true]);
});

const rep = (over: Partial<Prediction> = {}): Prediction => ({ id: "p1", madeAt: NOW.toISOString(), about: "2026-11-10", kind: "reps_hit", probability: 0.5, exercise: "Back Squat", sets: 3, reps: 5, kg: 100, due: "2026-11-12", ...over });
const found = (over: Record<string, unknown> = {}) => ({
  e: { name: "Back Squat", detail: "100kg 3x5", cut: false, load: { kg: 100 }, setsDone: 3, plannedSets: 3, restS: 120, restAfterSet1: null, deviations: [], reliable: true },
  jEx: undefined as any,
  format: "strength-perSet" as const,
  reliable: true,
  ...over,
});
const sets = (...s: [number, number | undefined][]) => ({ name: "Back Squat", sets: s.map(([reps, kg]) => (kg === undefined ? { reps } : { reps, kg })) });

test("reps_hit with a log_session entry: every predicted set at the reps and the load is a hit; one short set, one light set or a missing set is a miss", () => {
  assert.equal(scoreRepsHit(rep(), found({ jEx: sets([5, 100], [5, 100], [5, 100]) })).result, "hit");
  assert.equal(scoreRepsHit(rep(), found({ jEx: sets([6, 102.5], [5, 100], [5, 100]) })).result, "hit");
  const short = scoreRepsHit(rep(), found({ jEx: sets([5, 100], [5, 100], [4, 100]) }));
  assert.deepEqual([short.result, short.observed], ["miss", 2]);
  assert.equal(scoreRepsHit(rep(), found({ jEx: sets([5, 100], [5, 100], [5, 97.5]) })).result, "miss", "one set 2.5 kg light");
  assert.equal(scoreRepsHit(rep(), found({ jEx: sets([5, 100], [5, 100]) })).result, "miss", "only 2 sets logged of 3 predicted");
  assert.equal(scoreRepsHit(rep({ sets: 2 }), found({ jEx: sets([5, 100], [5, 100], [3, 100]) })).result, "hit", "2 of the 3 logged sets are enough for 2 predicted");
  assert.equal(scoreRepsHit(rep({ kg: undefined }), found({ jEx: sets([5, 20], [5, 20], [5, 20]) })).result, "hit", "no load predicted: any weight counts");
});

test("reps_hit: a logged set without a weight takes the guide label's; with no weight anywhere the load cannot be checked", () => {
  assert.equal(scoreRepsHit(rep(), found({ jEx: sets([5, undefined], [5, undefined], [5, undefined]) })).result, "hit");
  assert.equal(scoreRepsHit(rep({ kg: 105 }), found({ jEx: sets([5, undefined], [5, undefined], [5, undefined]) })).result, "miss", "the label's 100 kg is below 105");
  const noLabel = found({ jEx: sets([5, undefined], [5, undefined], [5, undefined]) });
  noLabel.e!.load = null as any;
  const r = scoreRepsHit(rep(), noLabel);
  assert.deepEqual([r.result, /no weight/.test(r.detail)], ["unresolvable", true]);
  assert.equal(scoreRepsHit(rep({ kg: undefined }), noLabel).result, "hit", "no load predicted: the missing weight does not matter");
});

test("reps_hit without a log_session entry: fewer set laps than predicted is a miss only for a reliable per-set guide; otherwise unresolvable, never a guess", () => {
  const miss = scoreRepsHit(rep({ sets: 4 }), found());
  assert.deepEqual([miss.result, /3 set laps/.test(miss.detail)], ["miss", true]);
  const enough = scoreRepsHit(rep({ sets: 3 }), found());
  assert.deepEqual([enough.result, /log_session/.test(enough.detail)], ["unresolvable", true]);
  assert.equal(scoreRepsHit(rep({ sets: 4 }), found({ reliable: false })).result, "unresolvable");
  assert.equal(scoreRepsHit(rep({ sets: 4 }), found({ format: "strength-perExercise" })).result, "unresolvable", "one lap per exercise says nothing about sets");
  assert.equal(scoreRepsHit(rep({ sets: 4 }), found({ format: "workout" })).result, "unresolvable");
  assert.equal(scoreRepsHit(rep(), found({ e: undefined })).result, "unresolvable");
  const emptySets = found({ jEx: { name: "Back Squat", sets: [] } });
  assert.equal(scoreRepsHit(rep({ sets: 4 }), emptySets).result, "miss", "an exercise entry without sets counts as no log");
});

// ---------- scoring: the call ----------

const keyOf = (i: number) => i.toString(16).padStart(24, "0");
const fx = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/compare/${name}`, import.meta.url), "utf8"));
function lapsResponse(f: any, key: string, startTime: number) {
  const markers = f.laps.rows.map(([, off, duration, avg, max, min, energy, , label]: any[]) => ({
    startTime: startTime + off * 1000,
    endTime: startTime + (off + duration) * 1000,
    totals: { duration, energy, hr: { min, avg, max }, intervalNotes: label?.replaceAll(" | ", "\f") ?? null },
  }));
  return { payload: { workoutKey: key, activityId: 23, startTime, timeOffsetInMinutes: 0, totalTime: f.totalTimeS, extensions: [{ type: "ManualLapStreamExtension", markers }] } };
}

const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const dayRange = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const sleepInto = (day: string, hrv: number) => {
  const bed = `${prevDay(day)}T23:00:00.000+00:00`;
  return { timestamp: bed, entryData: { SleepId: Date.parse(bed) / 1000, BedtimeStart: bed, BedtimeEnd: `${day}T06:30:00.000+00:00`, Duration: 27000, IsNap: false, SleepQualityScore: 70, AvgHRV: hrv } };
};
const recov = (day: string, balance: number) => ({ timestamp: `${day}T06:30:00.000+00:00`, entryData: { Balance: balance, StressState: 1 } });

interface World {
  workouts: { key: string; date: string; laps?: boolean; fixture?: string }[];
  hrv?: Record<string, number>; // night leading into the day
  balance?: Record<string, number>;
  syncedThrough?: string; // newest day with a recovery sample
  failing?: string[];
}
// A fake Suunto: HRV 40..44 cycling (band p25 41, p75 43 over 28 days) unless overridden.
function world(w: World) {
  const calls: string[] = [];
  const hrvOf = (d: string) => w.hrv?.[d] ?? 40 + (Date.parse(`${d}T00:00:00Z`) / 86_400_000) % 5;
  const client = {
    async listWorkouts(opts: any) {
      calls.push("listWorkouts");
      if (w.failing?.includes("workouts")) throw new Error("Suunto answered 500");
      return { payload: w.workouts.map((x) => ({ workoutKey: x.key, startTime: Date.parse(`${x.date}T10:00:00Z`), timeOffsetInMinutes: 0, extensionTypes: x.laps === false ? ["SUMMARY"] : ["SUMMARY", "MANUALLAP"] })).filter((x) => x.startTime >= opts.since && x.startTime <= opts.until) };
    },
    async listSleep(from: string, to: string) {
      calls.push(`listSleep ${from}..${to}`);
      if (w.failing?.includes("sleep")) throw new Error("Suunto answered 500");
      return { payload: dayRange("2026-08-01", "2026-11-15").map((d) => sleepInto(d, hrvOf(d))) };
    },
    async listRecovery(from: string, to: string) {
      calls.push(`listRecovery ${from}..${to}`);
      const days = dayRange("2026-08-01", w.syncedThrough ?? "2026-11-15");
      return { payload: days.map((d) => recov(d, w.balance?.[d] ?? 0.5)).filter((r) => r.timestamp.slice(0, 10) >= from && r.timestamp.slice(0, 10) <= to) };
    },
    async getDailyStats() {
      return [];
    },
    async getWorkoutWithExtensions(key: string) {
      calls.push(`laps ${key}`);
      const x = w.workouts.find((y) => y.key === key);
      if (!x) throw new SuuntoNotFoundError(`/v3/workouts/${key}`, "not found");
      return lapsResponse(fx(x.fixture ?? "clean-3ex.laps.json"), key, Date.parse(`${x.date}T10:00:00Z`));
    },
  };
  return { client: client as any, calls };
}

const pred = (id: number, over: Partial<Prediction>): Prediction => ({ id: `p${id}`, madeAt: "2026-11-01T08:00:00.000Z", about: "2026-11-10", kind: "session_done", probability: 0.5, due: "2026-11-12", ...over });
const seed = async (...ps: Prediction[]) => {
  const store = memoryPredictionStore();
  await store.save({ predictions: ps });
  return store;
};
const byId = async (store: ReturnType<typeof memoryPredictionStore>) => Object.fromEntries((await store.load())!.predictions.map((p) => [p.id, p]));

test("score_predictions: session_done is a hit with a workout that day, a miss without one once the watch has synced past the day, else unresolvable", async () => {
  const store = await seed(
    pred(1, { about: "2026-11-10" }), // a workout: hit
    pred(2, { about: "2026-11-09", due: "2026-11-11" }), // none, synced through 11-14: miss
    pred(3, { about: "2026-11-13", due: "2026-11-15" }), // none; the probe's newest day is 11-13 = not past the day: unresolvable
  );
  const r = await scorePredictions(world({ workouts: [{ key: keyOf(1), date: "2026-11-10" }], syncedThrough: "2026-11-13" }).client, store, {}, { now: NOW });
  const p = await byId(store);
  assert.deepEqual([p.p1.outcome?.result, p.p2.outcome?.result, p.p3.outcome?.result], ["hit", "miss", "unresolvable"]);
  assert.match(p.p3.outcome!.detail, /not synced anything after that day/);
  assert.deepEqual([r.scored.length, r.hits, r.misses, r.unresolvable], [3, 1, 1, 1]);
  const full = await scorePredictions(world({ workouts: [], syncedThrough: "2026-11-14" }).client, await seed(pred(1, { about: "2026-11-13", due: "2026-11-15" })), {}, { now: NOW });
  assert.equal(full.misses, 1, "synced through the day after the predicted day is enough");
});

test("score_predictions: hrv_in_band and recovery_morning_at_least use get_baselines' own numbers for the night after the date", async () => {
  // about 11-10: the night after 11-10 leads into 11-11. Band over 28 days before 11-11: 40..44 cycling.
  const hrv: Record<string, number> = { "2026-11-11": 42, "2026-11-10": 60 };
  const store = await seed(
    pred(1, { about: "2026-11-10", kind: "hrv_in_band" }), // night into 11-11: 42, within -> hit
    pred(2, { about: "2026-11-09", kind: "hrv_in_band", due: "2026-11-11" }), // night into 11-10: 60, above -> miss
    pred(3, { about: "2026-11-10", kind: "recovery_morning_at_least", threshold: 0.6 }),
    pred(4, { about: "2026-11-09", kind: "recovery_morning_at_least", threshold: 0.6, due: "2026-11-11" }),
  );
  const w = world({ workouts: [], hrv, balance: { "2026-11-11": 0.62, "2026-11-10": 0.55 } });
  await scorePredictions(w.client, store, {}, { now: NOW });
  const p = await byId(store);
  assert.deepEqual([p.p1.outcome?.result, p.p2.outcome?.result, p.p3.outcome?.result, p.p4.outcome?.result], ["hit", "miss", "hit", "miss"]);
  assert.equal(p.p1.outcome?.observed, 42);
  assert.equal(p.p3.outcome?.observed, 0.62);
  assert.ok(w.calls.some((c) => c === "listSleep 2026-10-13..2026-11-10"), "one baselines read for the judged day 2026-11-11 (28 days)");
});

test("score_predictions: only due predictions are scored (due day itself counts, the day before does not); voided ones never", async () => {
  const store = await seed(
    pred(1, { about: "2026-11-13", due: "2026-11-15" }), // due today
    pred(2, { about: "2026-11-14", due: "2026-11-16" }), // tomorrow
    pred(3, { about: "2026-11-10", voided: { at: "2026-11-09T00:00:00.000Z", reason: "x" } }),
  );
  const r = await scorePredictions(world({ workouts: [], syncedThrough: "2026-11-15" }).client, store, {}, { now: NOW });
  const p = await byId(store);
  assert.ok(p.p1.outcome);
  assert.equal(p.p2.outcome, undefined);
  assert.equal(p.p3.outcome, undefined);
  assert.deepEqual([r.scored.map((s) => s.id), r.notDue], [["p1"], 1]);
  assert.equal(SCORE_DELAY_DAYS, 2);
});

test("score_predictions: calling again changes nothing (same file, same outcomes), and scored outcomes are never rescored", async () => {
  const store = await seed(pred(1, { about: "2026-11-10" }));
  const w = world({ workouts: [{ key: keyOf(1), date: "2026-11-10" }] });
  await scorePredictions(w.client, store, {}, { now: NOW });
  const once = JSON.stringify(await store.load());
  const calls = w.calls.length;
  const again = await scorePredictions(w.client, store, {}, { now: new Date(2026, 10, 16, 8) });
  assert.equal(JSON.stringify(await store.load()), once);
  assert.equal(again.scored.length, 0);
  assert.equal(w.calls.length, calls, "nothing left to score: Suunto is not called");
});

test("score_predictions: at most 20 per call, oldest due first, and `remaining` says how many are left", async () => {
  assert.equal(MAX_SCORED_PER_CALL, 20);
  const ps = Array.from({ length: 21 }, (_, i) => pred(i + 1, { about: "2026-11-10", due: `2026-11-${String(1 + (i % 10)).padStart(2, "0")}` }));
  const store = await seed(...ps);
  const w = world({ workouts: [{ key: keyOf(1), date: "2026-11-10" }] });
  const r = await scorePredictions(w.client, store, {}, { now: NOW });
  assert.deepEqual([r.scored.length, r.remaining], [20, 1]);
  const left = (await store.load())!.predictions.filter((p) => !p.outcome);
  assert.equal(left.length, 1);
  // the one left is the one with the latest due date (and, on a tie, the highest id)
  assert.equal(left[0].due, "2026-11-10");
  const r2 = await scorePredictions(w.client, store, {}, { now: NOW });
  assert.deepEqual([r2.scored.length, r2.remaining], [1, 0]);
});

test("score_predictions: a failed request leaves the prediction unscored (never unresolvable) and names the error; the others are still scored", async () => {
  const store = await seed(pred(1, { about: "2026-11-10", kind: "hrv_in_band" }), pred(2, { about: "2026-11-10" }));
  const r = await scorePredictions(world({ workouts: [{ key: keyOf(1), date: "2026-11-10" }], failing: ["sleep"] }).client, store, {}, { now: NOW });
  const p = await byId(store);
  assert.equal(p.p1.outcome, undefined);
  assert.equal(p.p2.outcome?.result, "hit");
  assert.equal(r.errors.length, 1);
  assert.deepEqual([r.errors[0].id, /sleep/.test(r.errors[0].error)], ["p1", true]);
  const failList = await scorePredictions(world({ workouts: [], failing: ["workouts"], syncedThrough: "2026-11-15" }).client, await seed(pred(1, {})), {}, { now: NOW });
  assert.equal(failList.scored.length, 0);
  assert.equal(failList.errors.length, 1);
});

test("score_predictions: an unresolvable outcome stays unless rescoreUnresolvable is passed; then it is read again and only a changed outcome is written", async () => {
  const store = await seed(pred(1, { about: "2026-11-13", due: "2026-11-15" }));
  await scorePredictions(world({ workouts: [], syncedThrough: "2026-11-13" }).client, store, {}, { now: NOW });
  assert.equal((await byId(store)).p1.outcome?.result, "unresolvable");
  const skipped = await scorePredictions(world({ workouts: [], syncedThrough: "2026-11-15" }).client, store, {}, { now: NOW });
  assert.equal(skipped.scored.length, 0);
  assert.equal((await byId(store)).p1.outcome?.result, "unresolvable");
  const before = JSON.stringify(await store.load());
  const same = await scorePredictions(world({ workouts: [], syncedThrough: "2026-11-13" }).client, store, { rescoreUnresolvable: true }, { now: NOW });
  assert.equal(same.scored.length, 0);
  assert.equal(JSON.stringify(await store.load()), before, "still unresolvable for the same reason: the record is untouched");
  const fresh = await scorePredictions(world({ workouts: [], syncedThrough: "2026-11-15" }).client, store, { rescoreUnresolvable: true }, { now: NOW });
  assert.equal(fresh.scored.length, 1);
  assert.equal((await byId(store)).p1.outcome?.result, "miss");
});

test("score_predictions: reps_hit — the watch's set laps and the journal decide; a workoutKey prediction waits until the workout is two days old", async () => {
  const k1 = keyOf(1);
  const journal = { [k1]: { workoutKey: k1, loggedAt: "2026-11-10T20:00:00.000Z", exercises: [{ name: "Back Squat", sets: [{ reps: 5, kg: 100 }, { reps: 5, kg: 100 }, { reps: 5, kg: 100 }] }, { name: "Bench Press", sets: [{ reps: 8, kg: 70 }, { reps: 6, kg: 70 }, { reps: 8, kg: 70 }] }] } };
  const store = await seed(
    pred(1, { about: "2026-11-10", kind: "reps_hit", exercise: "Back Squat", sets: 3, reps: 5, kg: 100 }), // journal: hit
    pred(2, { about: "2026-11-10", kind: "reps_hit", exercise: "Bench Press", sets: 3, reps: 8, kg: 70 }), // a 6 rep set: miss
    pred(3, { about: "2026-11-10", kind: "reps_hit", exercise: "Seated Cable Row", sets: 3, reps: 12, kg: 55 }), // 2 set laps, no journal: miss (3 predicted)
    pred(4, { about: "2026-11-10", kind: "reps_hit", exercise: "Seated Cable Row", sets: 2, reps: 12, kg: 55 }), // no journal, enough laps: unresolvable
    pred(5, { about: "2026-11-10", kind: "reps_hit", exercise: "Deadlift", sets: 3, reps: 5 }), // not in the session
    pred(6, { about: k1, kind: "reps_hit", exercise: "Back Squat", sets: 3, reps: 5, kg: 100, due: "2026-11-12" }),
    pred(7, { about: keyOf(2), kind: "reps_hit", exercise: "Back Squat", sets: 3, reps: 5, due: "2026-11-12" }), // workout from 11-14: too new
    pred(8, { about: keyOf(99), kind: "reps_hit", exercise: "Back Squat", sets: 3, reps: 5, due: "2026-11-12" }), // unknown workout
  );
  const w = world({ workouts: [{ key: k1, date: "2026-11-10" }, { key: keyOf(2), date: "2026-11-14" }] });
  const r = await scorePredictions(w.client, store, {}, { now: NOW, loadJournal: async () => journal as any });
  const p = await byId(store);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => p[`p${i}`].outcome?.result ?? "unscored"),
    ["hit", "miss", "miss", "unresolvable", "unresolvable", "hit", "unscored", "unresolvable"],
  );
  assert.match(p.p3.outcome!.detail, /2 set laps/);
  assert.match(p.p5.outcome!.detail, /no exercise matching "Deadlift"/);
  assert.match(p.p8.outcome!.detail, /not found/);
  assert.equal(r.pending, 1);
  assert.equal(w.calls.filter((c) => c === `laps ${k1}`).length, 1, "the same session is read once for all its predictions");
});

test("score_predictions: reps_hit with no workout that day is a miss once synced, and a day with only unguided workouts is unresolvable", async () => {
  const store = await seed(pred(1, { kind: "reps_hit", exercise: "Back Squat", sets: 3, reps: 5 }), pred(2, { about: "2026-11-09", due: "2026-11-11", kind: "reps_hit", exercise: "Back Squat", sets: 3, reps: 5 }));
  await scorePredictions(world({ workouts: [{ key: keyOf(3), date: "2026-11-09", laps: false }], syncedThrough: "2026-11-15" }).client, store, {}, { now: NOW, loadJournal: async () => ({}) });
  const p = await byId(store);
  assert.equal(p.p1.outcome?.result, "miss");
  assert.deepEqual([p.p2.outcome?.result, /no guide laps/.test(p.p2.outcome!.detail)], ["unresolvable", true]);
});

test("score_predictions: an unreadable journal stops reps_hit scoring (nothing is guessed) and the rest still works", async () => {
  const store = await seed(pred(1, { kind: "reps_hit", exercise: "Back Squat", sets: 3, reps: 5 }), pred(2, { about: "2026-11-10" }));
  const w = world({ workouts: [{ key: keyOf(1), date: "2026-11-10" }] });
  const r = await scorePredictions(w.client, store, {}, { now: NOW, loadJournal: async () => Promise.reject(new Error("journal.json is not valid JSON")) });
  const p = await byId(store);
  assert.equal(p.p1.outcome, undefined);
  assert.equal(p.p2.outcome?.result, "hit");
  assert.match(r.errors[0].error, /journal/);
});

test("score_predictions: without a ledger there is nothing to do and no file is created", async () => {
  const store = memoryPredictionStore();
  const r = await scorePredictions(world({ workouts: [] }).client, store, {}, { now: NOW });
  assert.deepEqual([r.scored.length, r.remaining, r.notDue], [0, 0, 0]);
  assert.equal(await store.load(), null);
});

// ---------- stats ----------

const scored = (id: number, probability: number, hit: boolean, over: Partial<Prediction> = {}): Prediction => ({
  id: `p${id}`, madeAt: "2026-10-01T08:00:00.000Z", about: "2026-10-05", kind: "session_done", probability, due: "2026-10-07",
  outcome: { result: hit ? "hit" : "miss", scoredAt: "2026-10-08T08:00:00.000Z", detail: "d" }, ...over,
});

test("stats: below the minimum number of scored predictions no rate, score or table is shown; at the minimum they are", () => {
  assert.equal(MIN_SCORED, 20);
  const ps = (n: number) => Array.from({ length: n }, (_, i) => scored(i + 1, 0.7, i % 2 === 0));
  const s19 = predictionStats({ predictions: ps(19) }, NOW);
  assert.deepEqual([s19.overall.n, s19.overall.verdict, s19.overall.hitRate, s19.overall.brier, s19.overall.calibration], [19, "insufficient", null, null, null]);
  assert.match(s19.overall.statement, /19 scored.*at least 20/);
  assert.equal(s19.overall.hits, 10, "counts are facts and are shown");
  const s20 = predictionStats({ predictions: ps(20) }, NOW);
  assert.equal(s20.overall.verdict, "ok");
  assert.equal(s20.overall.hitRate, 0.5);
  assert.ok(Array.isArray(s20.overall.calibration));
});

test("stats: hit rate, Brier score and the base-rate Brier are computed by hand; unresolvable, voided and open ones are counted but never scored", () => {
  // 20 scored at p = 0.8: 15 hits, 5 misses. Brier = (15 * 0.2^2 + 5 * 0.8^2) / 20 = (0.6 + 3.2) / 20 = 0.19. Base rate 0.75 -> 0.75 * 0.25 = 0.1875.
  const ps: Prediction[] = Array.from({ length: 20 }, (_, i) => scored(i + 1, 0.8, i < 15));
  ps.push({ ...scored(21, 0.5, true), outcome: { result: "unresolvable", scoredAt: "2026-10-08T00:00:00.000Z", detail: "x" } });
  ps.push({ ...scored(22, 0.5, true), outcome: undefined, voided: { at: "2026-10-01T00:00:00.000Z", reason: "r" } });
  ps.push({ ...scored(23, 0.5, true), outcome: undefined, due: "2026-11-30" }); // open, not due
  ps.push({ ...scored(24, 0.5, true), outcome: undefined, due: "2026-11-01" }); // due, unscored
  const s = predictionStats({ predictions: ps }, NOW);
  const o = s.overall;
  assert.deepEqual([o.logged, o.n, o.hits, o.misses, o.unresolvable, o.voided, o.unscored], [24, 20, 15, 5, 1, 1, 2]);
  assert.deepEqual([o.hitRate, o.brier, o.brierBaseRate, o.meanProbability], [0.75, 0.19, 0.188, 0.8]);
  assert.equal(s.dueUnscored, 1);
  assert.deepEqual(s.thresholds, { minScored: 20, minBucketN: 5, buckets: 5 });
});

test("stats: calibration buckets are [0,0.2) [0.2,0.4) [0.4,0.6) [0.6,0.8) [0.8,1]; a bucket under 5 scored predictions shows no observed rate", () => {
  assert.equal(MIN_BUCKET_N, 5);
  const ps: Prediction[] = [];
  let id = 1;
  const add = (p: number, n: number, hits: number) => {
    for (let i = 0; i < n; i++) ps.push(scored(id++, p, i < hits));
  };
  add(0.0, 5, 0); // bucket 0
  add(0.2, 4, 4); // exactly 0.2 is in bucket 1; 4 of them: below the bucket minimum
  add(0.59, 5, 3); // bucket 2
  add(0.6, 2, 2); // exactly 0.6 is in bucket 3
  add(0.8, 2, 1); // exactly 0.8 is in bucket 4
  add(1.0, 3, 3); // 1.0 is in the last bucket too
  const cal = predictionStats({ predictions: ps }, NOW).overall.calibration!;
  assert.deepEqual(cal.map((b) => [b.from, b.to, b.n]), [[0, 0.2, 5], [0.2, 0.4, 4], [0.4, 0.6, 5], [0.6, 0.8, 2], [0.8, 1, 5]]);
  assert.deepEqual(cal.map((b) => b.hitRate), [0, null, 0.6, null, 0.8]);
  assert.deepEqual(cal.map((b) => b.meanProbability), [0, 0.2, 0.59, 0.6, 0.92]);
  // an empty bucket
  const none = predictionStats({ predictions: Array.from({ length: 20 }, (_, i) => scored(i + 1, 0.9, true)) }, NOW).overall.calibration!;
  assert.deepEqual([none[0].n, none[0].meanProbability, none[0].hitRate], [0, null, null]);
});

test("stats: per kind and per rule, each with its own minimum (a kind with 19 scored is insufficient even when the whole is not)", () => {
  const ps: Prediction[] = [];
  for (let i = 0; i < 20; i++) ps.push(scored(i + 1, 0.6, i < 10, { kind: "session_done", rule: "weekly-plan" }));
  for (let i = 0; i < 19; i++) ps.push(scored(21 + i, 0.4, i < 5, { kind: "hrv_in_band" }));
  const s = predictionStats({ predictions: ps }, NOW);
  assert.equal(s.overall.verdict, "ok");
  const kind = (k: string) => s.byKind.find((x) => x.kind === k)!;
  assert.deepEqual([kind("session_done").verdict, kind("session_done").hitRate, kind("hrv_in_band").verdict, kind("hrv_in_band").hitRate, kind("hrv_in_band").n], ["ok", 0.5, "insufficient", null, 19]);
  assert.equal(s.byKind.find((x) => x.kind === "reps_hit"), undefined, "a kind with nothing logged is not listed");
  const rule = (r: string | null) => s.byRule.find((x) => x.rule === r)!;
  assert.deepEqual([rule("weekly-plan").n, rule("weekly-plan").verdict, rule(null).n, rule(null).verdict], [20, "ok", 19, "insufficient"]);
});

test("stats: recent lists the newest predictions first with a plain status", () => {
  const ps: Prediction[] = [
    scored(1, 0.7, true),
    { ...scored(2, 0.7, true), outcome: undefined, due: "2026-11-30" },
    { ...scored(3, 0.7, true), outcome: undefined, due: "2026-11-01" },
    { ...scored(4, 0.7, true), outcome: undefined, voided: { at: "2026-10-02T00:00:00.000Z", reason: "r" } },
  ];
  const r = predictionStats({ predictions: ps }, NOW).recent;
  assert.deepEqual(r.map((x) => [x.id, x.status]), [["p4", "void"], ["p3", "due"], ["p2", "open"], ["p1", "hit"]]);
  const many = predictionStats({ predictions: Array.from({ length: 12 }, (_, i) => scored(i + 1, 0.5, true)) }, NOW).recent;
  assert.deepEqual([many.length, many[0].id], [10, "p12"]);
  assert.deepEqual(predictionStats(null, NOW).overall.logged, 0);
});

// ---------- the file ----------

async function withDir<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-pred-"));
  try {
    return await fn(join(dir, "sub", "predictions.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the file: written as version 1, owner-only, read back; a second process's entry is kept when this one writes", async () => {
  await withDir(async (path) => {
    const a = filePredictionStore(path);
    await logPrediction(ok(), a, { now: NOW });
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual([raw.version, raw.predictions.length], [1, 1]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    // another process wrote an entry after our first read: the next write is made on what is stored now
    const other = filePredictionStore(path);
    await logPrediction(ok({ about: "2026-11-20" }), other, { now: NOW });
    await logPrediction(ok({ about: "2026-11-21" }), a, { now: NOW });
    assert.deepEqual((await a.load())!.predictions.map((p) => [p.id, p.about]), [["p1", "2026-11-16"], ["p2", "2026-11-20"], ["p3", "2026-11-21"]]);
    assert.deepEqual((await readdir(join(path, ".."))).sort(), ["predictions.json"]);
  });
});

test("the file: a damaged, foreign, newer-version or hand-edited file is refused with its name, left untouched and never overwritten by a log", async () => {
  await withDir(async (path, dir) => {
    const store = filePredictionStore(path);
    await logPrediction(ok(), store, { now: NOW });
    const good = JSON.parse(await readFile(path, "utf8"));
    const cases: [unknown, RegExp][] = [
      ["{nope", /is not valid JSON/],
      [{ version: 1, entries: {} }, /is invalid \(entries is not a known field/], // a journal.json
      [{ version: 1, version2: 1, predictions: [] }, /version2 is not a known field/],
      [{ ...good, version: 2 }, /predictions version 2, but this server reads and writes version 1 only; it is left untouched/],
      [{ predictions: [] }, /version unknown/],
      [{ ...good, predictions: [{ ...good.predictions[0], kind: "weather" }] }, /predictions\[0\]\.kind must be one of/],
      [{ ...good, predictions: [{ ...good.predictions[0], probability: 2 }] }, /predictions\[0\]\.probability must be between 0 and 1/],
      [{ ...good, predictions: [{ ...good.predictions[0], extra: 1 }] }, /predictions\[0\]\.extra is not a known field/],
      [{ ...good, predictions: [good.predictions[0], good.predictions[0]] }, /id p1 is listed more than once/],
      [{ ...good, predictions: [{ ...good.predictions[0], outcome: { result: "maybe", scoredAt: "x", detail: "y" } }] }, /outcome\.result must be one of/],
    ];
    for (const [content, re] of cases) {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      await writeFile(path, text);
      await assert.rejects(logPrediction(ok(), store, { now: NOW }), (e: Error) => re.test(e.message) && e.message.includes(path), text);
      await assert.rejects(scorePredictions(world({ workouts: [] }).client, store, {}, { now: NOW }), re, text);
      await assert.rejects(voidPrediction({ id: "p1", reason: "x" }, store, { now: NOW }), re, text);
      assert.equal(await readFile(path, "utf8"), text, "the file is exactly as it was");
    }
    assert.deepEqual((await readdir(join(dir, "sub"))).sort(), ["predictions.json"]);
  });
});
