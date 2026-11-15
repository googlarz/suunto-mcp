import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAT_SHARE, MIN_OCCURRENCES, benchmarkFrom, buildBenchmark, seriesOf } from "./benchmark.js";
import { clearFailedSessions, type ExerciseRecord, type WorkoutRecord } from "./history.js";
import type { JournalEntry } from "./journal.js";
import type { ParsedFit } from "./fit.js";

// ---------- the trend rule ----------

test("seriesOf: fewer than 3 values is insufficient (2 vs 3), but first, last and best are still given", () => {
  assert.equal(MIN_OCCURRENCES, 3);
  const two = seriesOf([60, 70], "higher");
  assert.deepEqual([two.n, two.first, two.last, two.best, two.trend, two.change], [2, 60, 70, 70, "insufficient", null]);
  const three = seriesOf([60, 65, 70], "higher");
  assert.deepEqual([three.n, three.trend, three.change], [3, "up", 10]);
  assert.deepEqual(seriesOf([], "higher"), { n: 0, first: null, last: null, best: null, better: "higher", trend: "insufficient", change: null });
  // nulls are not occurrences: 3 sessions with one missing value is 2 values
  assert.equal(seriesOf([60, null, 70], "higher").trend, "insufficient");
  assert.equal(seriesOf([60, null, 65, 70], "higher").trend, "up");
});

test("seriesOf: older half vs newer half, the middle one left out when n is odd", () => {
  // n=5: older [10, 10], newer [20, 20]; the middle 99 is not used
  assert.equal(seriesOf([10, 10, 99, 20, 20], "higher").change, 10);
  // n=4: older [10, 30] (median 20), newer [20, 20] (median 20): flat
  assert.deepEqual([seriesOf([10, 30, 20, 20], "higher").trend, seriesOf([10, 30, 20, 20], "higher").change], ["flat", 0]);
  // n=6 uses all: older [1,2,3] -> 2, newer [4,5,6] -> 5
  assert.equal(seriesOf([1, 2, 3, 4, 5, 6], "higher").change, 3);
  // a single outlier in the newer half does not move its median
  assert.equal(seriesOf([100, 100, 100, 100, 100, 500], "lower").trend, "flat");
});

test("seriesOf: the flat band is 3% of the older median; exactly 3% is flat, just over is a trend, on both sides", () => {
  assert.equal(FLAT_SHARE, 0.03);
  const t = (older: number, newer: number) => seriesOf([older, older, newer, newer], "higher").trend;
  assert.equal(t(100, 103), "flat");
  assert.equal(t(100, 103.5), "up");
  assert.equal(t(100, 97), "flat");
  assert.equal(t(100, 96.5), "down");
  assert.equal(t(100, 100), "flat");
  assert.equal(t(0, 0), "flat");
  assert.equal(t(0, 1), "up", "from zero any rise is beyond 3% of nothing");
  assert.equal(seriesOf([70, 70, 72.5, 72.5], "higher").trend, "up", "a 2.5 kg step on 70 kg is 3.6%");
  assert.equal(seriesOf([100, 100, 102.5, 102.5], "higher").trend, "flat", "a 2.5 kg step on 100 kg is 2.5%");
});

test("seriesOf: best is the highest or lowest by direction, null for no direction", () => {
  const v = [70, 80, 60, 75];
  assert.equal(seriesOf(v, "higher").best, 80);
  assert.equal(seriesOf(v, "lower").best, 60);
  assert.equal(seriesOf(v, null).best, null);
  assert.equal(seriesOf(v, "lower").better, "lower");
});

// ---------- the sessions ----------

const ex = (name: string, detail: string | null, kg: number | null, endHr: number | null, extra: Partial<ExerciseRecord> = {}): ExerciseRecord => ({
  name, detail, cut: false, load: kg === null ? null : { kg }, setsDone: 3, plannedSets: 3, restS: 90,
  restAfterSet1: endHr === null ? null : { endHr, dropTotal: 20, t20S: 30, coverage: 1 }, deviations: [], reliable: true, ...extra,
});
const rec = (n: number, exercises: ExerciseRecord[]): WorkoutRecord => ({ workoutKey: n.toString(16).padStart(24, "0"), date: `2026-10-${String(n).padStart(2, "0")}`, exercises, hr: null });
const row = (r: WorkoutRecord, guide: string | null, totalTime: number, tss: number | null) => ({
  workoutKey: r.workoutKey, startTime: Date.parse(`${r.date}T07:00:00Z`), timeOffsetInMinutes: 0, totalTime,
  ...(tss === null ? {} : { tss: { trainingStressScore: tss } }),
  extensions: [{ type: "SummaryExtension", apps: guide === null ? [] : [{ name: guide }] }],
});

function fiveSessions() {
  const recs = [1, 2, 3, 4, 5].map((n) => rec(n, [ex("Bench Press", `${60 + n * 2.5}kg 3x8`, 60 + n * 2.5, 120 - n * 3), ex("Overhead Press", "40kg 3x8", 40, 118)]));
  const rows = new Map(recs.map((r, i) => [r.workoutKey, row(r, "PUSH A", 3000 - i * 100, 50 + i)]));
  return { recs, rows };
}

test("benchmarkFrom (guide): per session duration, TSS, median rest HR and per exercise load, planned reps, rest HR; series with best/last/trend", () => {
  const { recs, rows } = fiveSessions();
  const other = rec(6, [ex("Back Squat", "100kg 3x5", 100, 130)]);
  rows.set(other.workoutKey, row(other, "LEGS C", 2800, 60));
  const res = benchmarkFrom([...recs, other], rows, {}, { guide: "push  a" });
  assert.equal(res.sessions.length, 5, "only the sessions of that guide, matched ignoring case and spacing");
  const s = res.sessions[0];
  assert.deepEqual([s.date, s.guide, s.durationS, s.tss, s.restEndHrMedian], ["2026-10-01", "PUSH A", 3000, 50, 118]);
  assert.deepEqual(s.exercises[0], { name: "Bench Press", detail: "62.5kg 3x8", kg: 62.5, loadSource: "label", reps: 8, setsDone: 3, plannedSets: 3, restEndHr: 117, reliable: true });
  assert.deepEqual(res.series.durationS, { n: 5, first: 3000, last: 2600, best: 2600, better: "lower", trend: "down", change: -300 });
  assert.equal(res.series.tss.best, null);
  assert.equal(res.series.tss.trend, "up");
  const bench = res.series.exercises.find((e) => e.name === "Bench Press")!;
  assert.deepEqual([bench.kg.first, bench.kg.last, bench.kg.best, bench.kg.trend, bench.kg.change], [62.5, 72.5, 72.5, "up", 7.5]);
  assert.deepEqual([bench.restEndHr.best, bench.restEndHr.trend], [105, "down"]);
  assert.equal(bench.reps.trend, "flat");
  const ohp = res.series.exercises.find((e) => e.name === "Overhead Press")!;
  assert.deepEqual([ohp.kg.trend, ohp.kg.change], ["flat", 0]);
  assert.equal(res.series.exercises.length, 2);
});

test("benchmarkFrom (exercise): the sessions that contain it, whatever their guide, with only that exercise listed", () => {
  const { recs, rows } = fiveSessions();
  const squat = rec(6, [ex("Bench Press", "75kg 3x8", 75, 110), ex("Back Squat", "100kg 3x5", 100, 130)]);
  rows.set(squat.workoutKey, row(squat, "OTHER", 2900, 55));
  const res = benchmarkFrom([...recs, squat], rows, {}, { exercise: "bench press" });
  assert.equal(res.sessions.length, 6);
  assert.deepEqual(res.sessions[5].exercises.map((e) => e.name), ["Bench Press"]);
  assert.equal(res.sessions[5].guide, "OTHER");
  assert.equal(res.series.exercises.length, 1);
  assert.equal(benchmarkFrom(recs, rows, {}, { exercise: "Dips" }).sessions.length, 0);
});

test("benchmarkFrom: unreliable heart-rate sessions do not enter rest HR; missing summary leaves duration and TSS null; a logged weight beats the label", () => {
  const { recs, rows } = fiveSessions();
  recs[1].exercises[0] = ex("Bench Press", "65kg 3x8", 65, 99, { reliable: false });
  rows.delete(recs[2].workoutKey); // no list summary for the third session: it has no guide, so a guide query skips it ...
  const byExercise = benchmarkFrom(recs, rows, {}, { exercise: "Bench Press" });
  assert.equal(byExercise.sessions.length, 5, "... but an exercise query keeps it");
  assert.deepEqual([byExercise.sessions[2].guide, byExercise.sessions[2].durationS, byExercise.sessions[2].tss], [null, null, null]);
  assert.equal(byExercise.sessions[1].exercises[0].restEndHr, null, "reliable false: not used");
  assert.equal(byExercise.sessions[1].exercises[0].reliable, false);
  const bench = byExercise.series.exercises[0];
  assert.equal(bench.restEndHr.n, 4);
  const journal: Record<string, JournalEntry> = { [recs[4].workoutKey]: { workoutKey: recs[4].workoutKey, loggedAt: "x", exercises: [{ name: "Bench Press", sets: [{ reps: 8, kg: 80 }, { reps: 8, kg: 77.5 }] }] } };
  const logged = benchmarkFrom(recs, rows, journal, { exercise: "Bench Press" });
  assert.deepEqual([logged.sessions[4].exercises[0].kg, logged.sessions[4].exercises[0].loadSource], [80, "journal"]);
});

test("benchmarkFrom: a rep range or an unreadable detail has no reps (never guessed)", () => {
  const r = rec(1, [ex("Curl", "12kg 3x8-12", 12, 100), ex("Plank", "BW 60s", null, 100)]);
  const res = benchmarkFrom([r], new Map([[r.workoutKey, row(r, "G", 1000, 10)]]), {}, { guide: "G" });
  assert.deepEqual(res.sessions[0].exercises.map((e) => e.reps), [null, null]);
});

// ---------- end to end over the shared reader ----------

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/compare/${name}`, import.meta.url), "utf8"));
const CLEAN = fixture("clean-3ex.laps.json");
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;
const TODAY = "2026-11-01";

function lapsResponse(f: any, key: string, startTime: number) {
  const markers = f.laps.rows.map(([, off, duration, avg, max, min, energy, , label]: any[]) => ({
    startTime: startTime + off * 1000,
    endTime: startTime + (off + duration) * 1000,
    totals: { duration, energy, hr: { min, avg, max }, intervalNotes: label?.replaceAll(" | ", "\f") ?? null },
  }));
  return { payload: { workoutKey: key, activityId: 23, startTime, totalTime: f.totalTimeS, extensions: [{ type: "ManualLapStreamExtension", markers }] } };
}
function parsedFor(f: any, startMs: number): ParsedFit {
  const records = [];
  for (let t = 0; t <= Math.ceil(f.totalTimeS) + 5; t++) {
    const lap = f.laps.rows.find(([, off, dur]: any[]) => t >= off && t < off + dur) ?? f.laps.rows[f.laps.rows.length - 1];
    const [, off, dur, avg, max, min, , kind] = lap;
    records.push({ timestamp: new Date(startMs + t * 1000), heart_rate: Math.round(kind === "rest" ? max - ((max - min) * (t - off)) / dur : avg) });
  }
  return { sessions: [{ start_time: new Date(startMs) }], records };
}

test("buildBenchmark: joins the guided sessions with the list's guide title, duration and TSS, and reports what is still unread", async () => {
  const root = await mkdtemp(join(tmpdir(), "suunto-bench-"));
  const saved = { dir: process.env.SUUNTO_CACHE_DIR, off: process.env.SUUNTO_CACHE };
  process.env.SUUNTO_CACHE_DIR = join(root, "cache");
  delete process.env.SUUNTO_CACHE;
  clearFailedSessions();
  try {
    const keys = [1, 2, 3].map((i) => i.toString(16).padStart(24, "0"));
    const start = (i: number) => NOW - (3 - i) * 7 * DAY - 3 * 3_600_000;
    const list = keys.map((k, i) => ({
      workoutKey: k, startTime: start(i), timeOffsetInMinutes: 0, totalTime: 1100 + i * 10, tss: { trainingStressScore: 40 + i }, extensionTypes: ["SUMMARY", "MANUALLAP"],
      extensions: [{ type: "SummaryExtension", apps: [{ name: i === 1 ? "PULL B" : "PUSH A" }] }],
    }));
    const client: any = {
      listWorkouts: async () => ({ payload: [...list].sort((a, b) => b.startTime - a.startTime) }),
      getWorkoutWithExtensions: async (key: string) => lapsResponse(CLEAN, key, list.find((w) => w.workoutKey === key)!.startTime),
      getWorkoutFit: async (key: string) => Buffer.from(key),
    };
    const parse = async (bytes: Buffer) => parsedFor(CLEAN, list.find((w) => w.workoutKey === bytes.toString())!.startTime);
    const deps = { now: NOW, parse, loadJournal: async () => ({}) as Record<string, JournalEntry> };
    const res: any = await buildBenchmark(client, { guide: "push a", date: TODAY }, deps);
    assert.equal(res.mode, "guide");
    assert.equal(res.occurrences, 2, "the PULL B session is not part of it");
    assert.deepEqual(res.sessions.map((s: any) => [s.durationS, s.tss, s.guide]), [[1100, 40, "PUSH A"], [1120, 42, "PUSH A"]]);
    assert.ok(res.sessions[0].exercises.some((e: any) => e.name === "Back Squat" && e.kg === 100 && e.reps === 5));
    assert.equal(res.series.durationS.trend, "insufficient");
    assert.match(res.notes.join(" "), /fewer than 3: no trend/);
    assert.equal(res.pending, 0);
    const ex: any = await buildBenchmark(client, { exercise: "Back Squat", date: TODAY }, deps);
    assert.equal(ex.mode, "exercise");
    assert.equal(ex.occurrences, 3);
    assert.equal(ex.series.exercises[0].kg.trend, "flat");
    const none: any = await buildBenchmark(client, { guide: "Nope", date: TODAY }, deps);
    assert.equal(none.occurrences, 0);
    assert.match(none.notes.join(" "), /Guides seen: PUSH A; PULL B|Guides seen: PULL B; PUSH A/);
  } finally {
    for (const [k, v] of [["SUUNTO_CACHE_DIR", saved.dir], ["SUUNTO_CACHE", saved.off]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("buildBenchmark: exactly one of guide and exercise; weeks and date are validated by the shared reader", async () => {
  const client: any = { listWorkouts: async () => ({ payload: [] }) };
  await assert.rejects(buildBenchmark(client, {}), /exactly one of guide .* or exercise/);
  await assert.rejects(buildBenchmark(client, { guide: "a", exercise: "b" }), /exactly one of/);
  await assert.rejects(buildBenchmark(client, { guide: "  " }), /exactly one of/);
  await assert.rejects(buildBenchmark(client, { guide: "a", weeks: 27 }), /weeks must be a whole number from 1 to 26/);
  await assert.rejects(buildBenchmark(client, { guide: "a", date: "2026-13-01" }), /not a valid calendar date/);
  const res: any = await buildBenchmark(client, { guide: "a", weeks: 1, date: TODAY }, { loadJournal: async () => ({}) });
  assert.equal(res.occurrences, 0);
});
