import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExerciseHistory, deriveRecord, nameMatches, parseLoadKg, MAX_FETCH, type HistoryDeps } from "./history.js";
import { shapeLaps } from "./laps.js";
import type { ParsedFit } from "./fit.js";
import type { JournalEntry } from "./journal.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/compare/${name}`, import.meta.url), "utf8"));
const CLEAN = fixture("clean-3ex.laps.json");
const PER_EXERCISE = fixture("per-exercise.laps.json");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01 12:00 UTC
const TODAY = "2026-11-01";
const keyOf = (i: number) => i.toString(16).padStart(24, "0");

// ---------- test doubles ----------

type Subst = [string, string][];

// An API-shaped /v3/workouts/{key}?extensions=... response for a fixture's laps, moved to `startTime`.
function lapsResponse(f: any, key: string, startTime: number, subst: Subst = []) {
  const swap = (label: string | null) => (label === null ? null : subst.reduce((l, [a, b]) => l.replaceAll(a, b), label));
  const markers = f.laps.rows.map(([, off, duration, avg, max, min, energy, , label]: any[]) => ({
    startTime: startTime + off * 1000,
    endTime: startTime + (off + duration) * 1000,
    totals: { duration, energy, hr: { min, avg, max }, intervalNotes: swap(label)?.replaceAll(" | ", "\f") ?? null },
  }));
  return { payload: { workoutKey: key, activityId: 23, startTime, totalTime: f.totalTimeS, extensions: [{ type: "ManualLapStreamExtension", markers }] } };
}

// What the FIT parser would return for the clean fixture: 1 Hz HR holding each lap's average, falling from max to min in a rest.
function parsedFor(f: any, startMs: number): ParsedFit {
  const records = [];
  for (let t = 0; t <= Math.ceil(f.totalTimeS) + 5; t++) {
    const lap = f.laps.rows.find(([, off, dur]: any[]) => t >= off && t < off + dur) ?? f.laps.rows[f.laps.rows.length - 1];
    const [, off, dur, avg, max, min, , kind] = lap;
    records.push({ timestamp: new Date(startMs + t * 1000), heart_rate: Math.round(kind === "rest" ? max - ((max - min) * (t - off)) / dur : avg) });
  }
  return { sessions: [{ start_time: new Date(startMs) }], records };
}

interface W {
  key: string;
  startMs: number;
  fixture?: any;
  subst?: Subst;
  fails?: boolean;
  noLaps?: boolean;
}

function fakeClient(workouts: W[]) {
  const calls = { list: 0, laps: [] as string[], fit: [] as string[] };
  const find = (key: string) => workouts.find((w) => w.key === key)!;
  const client = {
    async listWorkouts() {
      calls.list++;
      // newest first, like Suunto; UTC offset 0 so the local date is the UTC date
      const sorted = [...workouts].sort((a, b) => b.startMs - a.startMs);
      return { payload: sorted.map((w) => ({ workoutKey: w.key, startTime: w.startMs, timeOffsetInMinutes: 0, extensionTypes: w.noLaps ? ["SUMMARY"] : ["SUMMARY", "MANUALLAP"] })) };
    },
    async getWorkoutWithExtensions(key: string) {
      calls.laps.push(key);
      const w = find(key);
      if (w.fails) throw new Error(`Suunto answered 500 for ${key}`);
      return lapsResponse(w.fixture ?? CLEAN, key, w.startMs, w.subst);
    },
    async getWorkoutFit(key: string) {
      calls.fit.push(key);
      return Buffer.from(key);
    },
  };
  const parse = async (bytes: Buffer) => {
    const w = find(bytes.toString());
    return parsedFor(w.fixture ?? CLEAN, w.startMs);
  };
  return { client: client as any, calls, parse };
}

async function withCacheDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "suunto-history-"));
  const saved = { dir: process.env.SUUNTO_CACHE_DIR, off: process.env.SUUNTO_CACHE };
  process.env.SUUNTO_CACHE_DIR = join(root, "cache");
  delete process.env.SUUNTO_CACHE;
  try {
    return await fn(join(root, "cache"));
  } finally {
    for (const [k, v] of [["SUUNTO_CACHE_DIR", saved.dir], ["SUUNTO_CACHE", saved.off]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const noJournal = async () => ({}) as Record<string, JournalEntry>;
const deps = (parse: HistoryDeps["parse"], extra: HistoryDeps = {}): HistoryDeps => ({ now: NOW, parse, loadJournal: noJournal, ...extra });
// a session `daysAgo` days (and a bit) before NOW
const at = (daysAgo: number) => NOW - daysAgo * DAY - 3 * 3_600_000;

// ---------- load parsing and name matching ----------

test("parseLoadKg: the first number followed by kg, else null", () => {
  assert.equal(parseLoadKg("100kg 3x5"), 100);
  assert.equal(parseLoadKg("55kg 10-15 RPE7"), 55);
  assert.equal(parseLoadKg("2x20kg 3x8/leg"), 20, "the first weight, not the 2 of '2x'");
  assert.equal(parseLoadKg("2x32kg 3x40m"), 32);
  assert.equal(parseLoadKg("100kg 3x5, back-off 80kg 1x10"), 100, "the first of several weights");
  assert.equal(parseLoadKg("62,5kg 3x8"), 62.5);
  assert.equal(parseLoadKg("12.5 kg 3x8"), 12.5);
  assert.equal(parseLoadKg("RPE6 8-12"), null, "no weight: never guessed");
  assert.equal(parseLoadKg("BW 3x15"), null);
  assert.equal(parseLoadKg("3x10"), null);
  assert.equal(parseLoadKg("45lb 3x10"), null, "other units are not converted");
  assert.equal(parseLoadKg(null), null);
});

test("nameMatches: normalised equality, or a prefix only when the stored name may be cut", () => {
  const full = { name: "Back Squat", cut: false };
  assert.equal(nameMatches("back  squat", full), true);
  assert.equal(nameMatches("BACK-SQUAT!", full), true);
  assert.equal(nameMatches("Bäck Squat", { name: "Back Squat", cut: false }), true, "accents ignored");
  assert.equal(nameMatches("Back Squat Wide Stance", full), false, "an uncut name is not a prefix match");
  assert.equal(nameMatches("Back", full), false);
  assert.equal(nameMatches("", full), false);
  const cut = { name: "Seated Cable Row W", cut: true };
  assert.equal(nameMatches("Seated Cable Row Wide Grip", cut), true);
  assert.equal(nameMatches("Seated Cable Row", cut), false, "the query is shorter than the stored name");
  assert.equal(nameMatches("Se", { name: "Se", cut: true }), true, "equal still matches");
  assert.equal(nameMatches("Seated", { name: "Se", cut: true }), false, "a name under 3 letters is too short to prefix-match");
});

// ---------- derivation ----------

test("deriveRecord: per-exercise load, sets, rest and recovery after set 1", () => {
  const laps = shapeLaps(lapsResponse(CLEAN, keyOf(1), CLEAN.startTime));
  const rec = deriveRecord(laps, parsedFor(CLEAN, CLEAN.startTime), "2026-10-01");
  assert.deepEqual(rec.exercises.map((e) => [e.name, e.detail, e.load, e.setsDone, e.plannedSets, e.restS, e.cut]), [
    ["Back Squat", "100kg 3x5", { kg: 100 }, 3, 3, 120, false],
    ["Bench Press", "70kg 3x8", { kg: 70 }, 3, 3, 90, false],
    ["Seated Cable Row", "55kg 2x12", { kg: 55 }, 2, 2, 60, false],
  ]);
  for (const e of rec.exercises) {
    assert.equal(e.reliable, true);
    assert.deepEqual(e.deviations, []);
    assert.ok(e.restAfterSet1 && e.restAfterSet1.endHr > 50 && e.restAfterSet1.coverage >= 0.99, JSON.stringify(e.restAfterSet1));
  }
  // squat rest 1 falls from 138 to 101 over 120 s: the end of the rest is near 101
  assert.ok(rec.exercises[0].restAfterSet1!.endHr >= 101 && rec.exercises[0].restAfterSet1!.endHr <= 104);
  const without = deriveRecord(laps, null, "2026-10-01");
  assert.ok(without.exercises.every((e) => e.restAfterSet1 === null), "no FIT: no recovery");
});

test("deriveRecord: an unreliable session flags every exercise; deviation codes are per exercise", () => {
  const f = fixture("missing-set.laps.json");
  const rec = deriveRecord(shapeLaps(lapsResponse(f, keyOf(2), f.startTime)), null, "2026-10-01");
  assert.deepEqual(rec.exercises.map((e) => e.deviations), [["short-set"], []], "the code belongs to the exercise it was found in");
  const ended = fixture("ended-early.laps.json");
  const e2 = deriveRecord(shapeLaps(lapsResponse(ended, keyOf(3), ended.startTime)), null, "2026-10-01");
  assert.ok(e2.exercises.length > 0 && e2.exercises.every((e) => e.reliable === false), "ended without 'Session complete': best effort");
});

// ---------- the call ----------

test("history index: exercises by number of sessions, with the last date and detail; the second call is served from the cache", async () => {
  await withCacheDir(async (dir) => {
    const { client, calls, parse } = fakeClient([
      { key: keyOf(1), startMs: at(21) },
      { key: keyOf(2), startMs: at(14), subst: [["100kg", "102.5kg"]] },
      { key: keyOf(3), startMs: at(7), subst: [["100kg", "105kg"]] },
      { key: keyOf(4), startMs: at(5), fixture: PER_EXERCISE },
      { key: keyOf(5), startMs: at(4), noLaps: true },
    ]);
    const out = await buildExerciseHistory(client, { date: TODAY, weeks: 4 }, deps(parse));
    assert.equal(out.from, "2026-10-05");
    assert.equal(out.to, TODAY);
    assert.equal(out.sessions, 4, "the workout without laps is not a session");
    assert.deepEqual(out.pending, 0);
    assert.deepEqual(out.errors, []);
    const ex = (out as any).exercises;
    assert.deepEqual(ex.map((e: any) => [e.name, e.sessions]), [["Back Squat", 3], ["Bench Press", 3], ["Seated Cable Row", 3], ["Farmer Carry", 1], ["Kettlebell Swing", 1]]);
    assert.deepEqual(ex[0], { name: "Back Squat", sessions: 3, lastDate: "2026-10-25", lastDetail: "105kg 3x5" });
    assert.match(out.notes[0], /PLANNED/);
    assert.equal(calls.laps.length, 4);
    assert.equal(calls.fit.length, 3, "the per-exercise guide has no between-set rests: its FIT is not downloaded");
    assert.equal((await readdir(dir)).length, 4);

    const again = await buildExerciseHistory(client, { date: TODAY, weeks: 4 }, deps(parse));
    assert.deepEqual(again, out);
    assert.equal(calls.laps.length, 4, "no new request");
    assert.equal(calls.fit.length, 3);
  });
});

test("history by name: oldest first, load progression, recovery after set 1 and the median end-of-rest HR", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([
      { key: keyOf(3), startMs: at(7), subst: [["100kg", "105kg"]] },
      { key: keyOf(1), startMs: at(21) },
      { key: keyOf(2), startMs: at(14), subst: [["100kg", "102.5kg"]] },
      { key: keyOf(4), startMs: at(1), subst: [["100kg 3x5", "RPE6 8-12"]] }, // no weight in the label
    ]);
    const out: any = await buildExerciseHistory(client, { name: "back squat", weeks: 8, date: TODAY }, deps(parse));
    assert.deepEqual(out.sessions.cols.slice(0, 3), ["date", "workoutKey", "detail"]);
    const rows: any[][] = out.sessions.rows;
    const col = (name: string) => out.sessions.cols.indexOf(name);
    assert.deepEqual(rows.map((r) => r[col("date")]), ["2026-10-11", "2026-10-18", "2026-10-25", "2026-10-31"], "oldest first");
    assert.deepEqual(rows.map((r) => r[col("kg")]), [100, 102.5, 105, null]);
    assert.deepEqual(rows.map((r) => r[col("loadSource")]), ["label", "label", "label", "label"]);
    assert.deepEqual(rows[0].slice(col("setsDone"), col("restS") + 1), [3, 3, 120]);
    assert.ok(rows.every((r) => typeof r[col("restEndHr")] === "number" && r[col("reliable")] === true && r[col("journal")] === null));
    assert.deepEqual(out.summary, { sessions: 4, firstLoadKg: 100, lastLoadKg: 105, restEndHrMedian: out.summary.restEndHrMedian });
    assert.ok(Number.isInteger(out.summary.restEndHrMedian) && out.summary.restEndHrMedian >= 101 && out.summary.restEndHrMedian <= 104, `median ${out.summary.restEndHrMedian}`);
    assert.ok(out.notes.some((n: string) => /normalisation/.test(n)), "the matching rule is stated");
    assert.ok(out.notes.some((n: string) => /PLANNED/.test(n)));
  });
});

test("history by name: an unreliable session is listed and flagged but does not move restEndHrMedian", async () => {
  await withCacheDir(async () => {
    // no 'Session complete' lap: unreliable; its first squat rest ends near 60 bpm instead of 101
    const rows = CLEAN.laps.rows.slice(0, -1).map((r: any[]) => (r[0] === 3 ? [...r.slice(0, 5), 60, ...r.slice(6)] : r));
    const unreliable = { ...CLEAN, laps: { ...CLEAN.laps, rows } };
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14) },
      { key: keyOf(2), startMs: at(7), fixture: unreliable },
    ]);
    const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 4, date: TODAY }, deps(parse));
    const c = (n: string) => out.sessions.cols.indexOf(n);
    assert.deepEqual(out.sessions.rows.map((r: any[]) => r[c("reliable")]), [true, false]);
    assert.ok(out.sessions.rows[1][c("restEndHr")] < 70, "the unreliable session's own value is still shown");
    assert.equal(out.summary.sessions, 2);
    assert.equal(out.summary.restEndHrMedian, Math.round(out.sessions.rows[0][c("restEndHr")]), "only the reliable session counts");
  });
});

test("history by name: a name the guide cut is matched by the full name and grouped with it in the index", async () => {
  await withCacheDir(async () => {
    const cutSubst: Subst = [["Seated Cable Row", "Seated Cable Row W"], ["55kg 2x12", "55kg 2x12 RPE7 slow!!"]]; // 18 + 21 characters: at the 39-character cut
    const fullSubst: Subst = [["Seated Cable Row", "Seated Cable Row Wide Grip"]];
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14), subst: cutSubst },
      { key: keyOf(2), startMs: at(7), subst: fullSubst },
    ]);
    const named: any = await buildExerciseHistory(client, { name: "Seated Cable Row Wide Grip", weeks: 4, date: TODAY }, deps(parse));
    assert.equal(named.summary.sessions, 2, "the cut name matches by prefix");
    assert.deepEqual(named.sessions.rows.map((r: any[]) => r[2]), ["55kg 2x12 RPE7 slow!!", "55kg 2x12"]);
    const short: any = await buildExerciseHistory(client, { name: "Seated Cable Row", weeks: 4, date: TODAY }, deps(parse));
    assert.equal(short.summary.sessions, 0, "a shorter name is not a match, even though the exercise starts with it");
    assert.match(short.notes.join(" "), /No exercise matches "Seated Cable Row".*Names seen:.*Back Squat/);
    const index: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    const row = index.exercises.find((e: any) => e.name.startsWith("Seated"));
    assert.deepEqual(row, { name: "Seated Cable Row Wide Grip", sessions: 2, lastDate: "2026-10-25", lastDetail: "55kg 2x12" });
    assert.equal(index.exercises.filter((e: any) => e.name.startsWith("Seated")).length, 1);
  });
});

test("history: at most 8 uncached sessions per call, newest first; pending counts down to 0; 26 weeks of one exercise stay under 6 KB", async () => {
  await withCacheDir(async () => {
    const workouts: W[] = Array.from({ length: 26 }, (_, i) => ({ key: keyOf(i + 1), startMs: at(7 * i + 2), subst: [["100kg", `${100 + i}kg`]] }));
    const { client, calls, parse } = fakeClient(workouts);
    const run = () => buildExerciseHistory(client, { name: "Back Squat", weeks: 26, date: TODAY }, deps(parse)) as Promise<any>;

    const first = await run();
    assert.equal(calls.laps.length, MAX_FETCH);
    assert.deepEqual(calls.laps, workouts.slice(0, 8).map((w) => w.key), "the newest eight, one after the other");
    assert.equal(first.pending, 18);
    assert.equal(first.summary.sessions, 8);
    assert.match(first.notes.join(" "), /call again until pending is 0/);

    assert.equal((await run()).pending, 10);
    assert.equal(calls.laps.length, 16, "the cached eight are not fetched again");
    assert.equal((await run()).pending, 2);
    const last = await run();
    assert.equal(last.pending, 0);
    assert.equal(calls.laps.length, 26);
    assert.equal(new Set(calls.laps).size, 26, "no session was fetched twice");
    assert.equal(last.summary.sessions, 26);
    assert.equal(last.summary.firstLoadKg, 125, "the oldest session is the 26th");
    assert.equal(last.summary.lastLoadKg, 100);
    assert.doesNotMatch(last.notes.join(" "), /call again/);
    const size = JSON.stringify(last).length;
    assert.ok(size < 6_000, `26 sessions of one exercise took ${size} B`);
  });
});

test("history: a workout that fails is skipped, listed in errors and not cached; the rest still work", async () => {
  await withCacheDir(async (dir) => {
    const { client, calls, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14) },
      { key: keyOf(2), startMs: at(7), fails: true },
      { key: keyOf(3), startMs: at(3) },
    ]);
    const out: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    assert.equal(out.sessions, 2);
    assert.deepEqual(out.errors, [{ workoutKey: keyOf(2), date: "2026-10-25", error: `Suunto answered 500 for ${keyOf(2)}` }]);
    assert.equal(out.pending, 0, "an attempted workout is not pending");
    assert.equal((await readdir(dir)).length, 2, "the failure left no cache entry");
    await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    assert.equal(calls.laps.filter((k) => k === keyOf(2)).length, 2, "tried again on the next call");
    assert.equal(calls.laps.filter((k) => k === keyOf(1)).length, 1, "the good ones were cached");
  });
});

test("history: a failing FIT download fails the workout instead of caching a record without recovery", async () => {
  await withCacheDir(async (dir) => {
    const { client, parse } = fakeClient([{ key: keyOf(1), startMs: at(7) }]);
    client.getWorkoutFit = async () => {
      throw new Error("403 Forbidden");
    };
    const out: any = await buildExerciseHistory(client, { weeks: 2, date: TODAY }, deps(parse));
    assert.equal(out.sessions, 0);
    assert.equal(out.errors.length, 1);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });
});

test("history: a session under 24 h old is shown but never cached", async () => {
  await withCacheDir(async (dir) => {
    const { client, calls, parse } = fakeClient([
      { key: keyOf(1), startMs: at(7) },
      { key: keyOf(2), startMs: NOW - 2 * 3_600_000 },
    ]);
    const out: any = await buildExerciseHistory(client, { weeks: 2, date: TODAY }, deps(parse));
    assert.equal(out.sessions, 2);
    assert.deepEqual(await readdir(dir), [`${keyOf(1)}.json`]);
    await buildExerciseHistory(client, { weeks: 2, date: TODAY }, deps(parse));
    assert.deepEqual(calls.laps, [keyOf(2), keyOf(1), keyOf(2)], "the recent one is read again, the old one is not");
  });
});

test("history: SUUNTO_CACHE=off reads everything every time and writes nothing", async () => {
  await withCacheDir(async (dir) => {
    process.env.SUUNTO_CACHE = "off";
    const { client, calls, parse } = fakeClient([{ key: keyOf(1), startMs: at(7) }]);
    await buildExerciseHistory(client, { weeks: 2, date: TODAY }, deps(parse));
    await buildExerciseHistory(client, { weeks: 2, date: TODAY }, deps(parse));
    assert.equal(calls.laps.length, 2);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });
});

test("history: only workouts with laps inside weeks and date are read", async () => {
  await withCacheDir(async () => {
    const { client, calls, parse } = fakeClient([
      { key: keyOf(1), startMs: at(13) },
      { key: keyOf(2), startMs: at(15) }, // 2026-10-17: before a two-week range
      { key: keyOf(3), startMs: at(3), noLaps: true },
      { key: keyOf(4), startMs: NOW + 2 * DAY }, // after `date`
    ]);
    const out: any = await buildExerciseHistory(client, { weeks: 2, date: TODAY }, deps(parse));
    assert.equal(out.from, "2026-10-19");
    assert.equal(out.sessions, 1);
    assert.deepEqual(calls.laps, [keyOf(1)]);
  });
});

test("history: weeks and date are validated", async () => {
  const { client, parse } = fakeClient([]);
  for (const weeks of [0, 27, 1.5]) await assert.rejects(buildExerciseHistory(client, { weeks, date: TODAY }, deps(parse)), /weeks must be/);
  await assert.rejects(buildExerciseHistory(client, { date: "2026-02-31" }, deps(parse)), /not a valid calendar date/);
});

// ---------- journal merge ----------

const journalOf = (entries: JournalEntry[]) => async () => Object.fromEntries(entries.map((e) => [e.workoutKey, e]));

test("history by name: the journal's top set weight replaces the label's load, and its entry is attached", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14) },
      { key: keyOf(2), startMs: at(7) },
      { key: keyOf(3), startMs: at(3) },
    ]);
    const entries: JournalEntry[] = [
      { workoutKey: keyOf(2), loggedAt: "x", note: "felt heavy", feeling: "tired", exercises: [{ name: "BACK SQUAT", sets: [{ reps: 5, kg: 95 }, { reps: 5, kg: 97.5 }, { reps: 6 }], note: "knee ok" }] },
      // only another exercise was logged: the load stays the label's, the session note is still attached
      { workoutKey: keyOf(3), loggedAt: "x", note: "all as planned", exercises: [{ name: "Bench Press", sets: [{ reps: 8, kg: 72.5 }] }] },
    ];
    const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 4, date: TODAY }, deps(parse, { loadJournal: journalOf(entries) }));
    const c = (n: string) => out.sessions.cols.indexOf(n);
    const rows: any[][] = out.sessions.rows;
    assert.deepEqual(rows.map((r) => [r[c("kg")], r[c("loadSource")]]), [[100, "label"], [97.5, "journal"], [100, "label"]]);
    assert.equal(rows[0][c("journal")], null);
    assert.deepEqual(rows[1][c("journal")], { note: "felt heavy", feeling: "tired", sets: entries[0].exercises![0].sets, exerciseNote: "knee ok" });
    assert.deepEqual(rows[2][c("journal")], { note: "all as planned" });
    assert.equal(out.summary.lastLoadKg, 100);
    const bench: any = await buildExerciseHistory(client, { name: "Bench Press", weeks: 4, date: TODAY }, deps(parse, { loadJournal: journalOf(entries) }));
    assert.equal(bench.sessions.rows[2][c("kg")], 72.5);
    assert.equal(bench.sessions.rows[2][c("loadSource")], "journal");
  });
});

test("history: an unreadable journal is reported in notes and the history still works", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([{ key: keyOf(1), startMs: at(7) }]);
    const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 2, date: TODAY }, deps(parse, { loadJournal: async () => { throw new Error("journal.json is not valid JSON; fix or delete it"); } }));
    assert.equal(out.summary.sessions, 1);
    assert.match(out.notes.join(" "), /journal could not be read.*not valid JSON/);
  });
});
