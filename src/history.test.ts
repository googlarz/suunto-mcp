import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildExerciseHistory, clearFailedSessions, deriveRecord, nameMatches, parseLoadKg, suggestProgression, COLS, MAX_FETCH, type HistoryDeps } from "./history.js";
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
  dropHr?: boolean; // the FIT's HR is lost for the middle of the session
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
    const parsed = parsedFor(w.fixture ?? CLEAN, w.startMs);
    if (w.dropHr) parsed.records = parsed.records!.filter((_, i) => i < 100 || i > parsed.records!.length * 0.7);
    return parsed;
  };
  return { client: client as any, calls, parse };
}

async function withCacheDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "suunto-history-"));
  const saved = { dir: process.env.SUUNTO_CACHE_DIR, off: process.env.SUUNTO_CACHE };
  process.env.SUUNTO_CACHE_DIR = join(root, "cache");
  delete process.env.SUUNTO_CACHE;
  clearFailedSessions();
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
  assert.equal(parseLoadKg("135 lbs"), null);
  assert.equal(parseLoadKg("100 kg"), 100);
  assert.equal(parseLoadKg("57.5kg"), 57.5);
  assert.equal(parseLoadKg("BW+10kg 3x8"), null, "an addition to bodyweight is not the load: never guessed");
  assert.equal(parseLoadKg("bw + 10 kg 3x8"), null);
  assert.equal(parseLoadKg("Bodyweight +5kg 3x8"), null);
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
  assert.equal(nameMatches("Seated", { name: "Se", cut: true }), false, "a name this short is too short to prefix-match");
  assert.equal(nameMatches("Squat Jump", { name: "Squat", cut: true }), false, "a real cut leaves most of the name: 5 characters is not one");
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

test("deriveRecord: the session's HR quality is stored on the record; null without a FIT", () => {
  const laps = shapeLaps(lapsResponse(CLEAN, keyOf(1), CLEAN.startTime));
  const good = deriveRecord(laps, parsedFor(CLEAN, CLEAN.startTime), "2026-10-01");
  assert.equal(good.hr?.reliable, true, good.hr?.reasons.join("; "));
  const parsed = parsedFor(CLEAN, CLEAN.startTime);
  parsed.records = parsed.records!.filter((_, i, all) => i < 100 || i > all.length * 0.7);
  const bad = deriveRecord(laps, parsed, "2026-10-01");
  assert.equal(bad.hr?.reliable, false);
  assert.ok(bad.exercises.every((e) => e.reliable === false), "unreliable HR makes every exercise unreliable");
  assert.equal(deriveRecord(laps, null, "2026-10-01").hr, null);
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

test("history: a session with unreliable HR is flagged, excluded from restEndHrMedian, named in a note with its reason, and the verdict survives the cache", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14) },
      { key: keyOf(2), startMs: at(7), dropHr: true },
    ]);
    for (const pass of [1, 2]) {
      const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 4, date: TODAY }, deps(parse));
      const c = (n: string) => out.sessions.cols.indexOf(n);
      assert.deepEqual(out.sessions.rows.map((r: any[]) => r[c("reliable")]), [true, false], `pass ${pass}`);
      assert.equal(out.summary.restEndHrMedian, Math.round(out.sessions.rows[0][c("restEndHr")]), "only the reliable session counts");
      const note = out.notes.find((n: string) => /unreliable heart-rate/i.test(n));
      assert.ok(note, "a note says so");
      assert.match(note, /only \d+% of the session/);
      assert.match(note, new RegExp(out.sessions.rows[1][c("date")]));
      assert.doesNotMatch(note, new RegExp(out.sessions.rows[0][c("date")]));
    }
  });
});

test("history by name: only sessions that have a matching exercise are named in the HR note; the index names every session in the range and never mentions restEndHrMedian", async () => {
  await withCacheDir(async () => {
    // both sessions lose their HR; the second one has no 'Back Squat' (it is a 'Front Squat' there)
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14), dropHr: true },
      { key: keyOf(2), startMs: at(7), dropHr: true, subst: [["Back Squat", "Front Squat"]] },
    ]);
    const named: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 4, date: TODAY }, deps(parse));
    const noteNamed = named.notes.find((n: string) => /unreliable heart-rate/i.test(n));
    assert.match(noteNamed, /^1 session\(s\)/);
    assert.match(noteNamed, /2026-10-18/);
    assert.doesNotMatch(noteNamed, /2026-10-25/, "that session has no matching row");
    assert.match(noteNamed, /restEndHrMedian/, "the named view does return the median");

    const index: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    const noteIndex = index.notes.find((n: string) => /unreliable heart-rate/i.test(n));
    assert.match(noteIndex, /^2 session\(s\)/);
    assert.match(noteIndex, /2026-10-18/);
    assert.match(noteIndex, /2026-10-25/);
    assert.doesNotMatch(noteIndex, /restEndHrMedian/, "the index view does not return it");
    assert.ok(!("summary" in index));
  });
});

test("history by name: a session with no matching exercise and no HR is not named in the no-HR note either", async () => {
  await withCacheDir(async () => {
    const { client } = fakeClient([
      { key: keyOf(1), startMs: at(14) },
      { key: keyOf(2), startMs: at(7), subst: [["Back Squat", "Front Squat"]] },
    ]);
    const parse = async () => ({ sessions: [], records: [] }) as ParsedFit;
    const out: any = await buildExerciseHistory(client, { name: "Front Squat", weeks: 4, date: TODAY }, deps(parse));
    const note = out.notes.find((n: string) => /no heart rate data/i.test(n));
    assert.match(note, /^1 session\(s\)/);
    assert.match(note, /2026-10-25/);
    assert.doesNotMatch(note, /2026-10-18/);
  });
});

test("history: sessions with no HR at all are noted as 'no heart rate data', not as unreliable", async () => {
  await withCacheDir(async () => {
    const { client } = fakeClient([{ key: keyOf(1), startMs: at(7) }]);
    const parse = async () => ({ sessions: [], records: [] }) as ParsedFit;
    const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 4, date: TODAY }, deps(parse));
    assert.ok(out.notes.some((n: string) => /no heart rate data/i.test(n)));
    assert.ok(!out.notes.some((n: string) => /unreliable heart-rate/i.test(n)));
  });
});

test("history: a clean history adds no HR-quality note", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([{ key: keyOf(1), startMs: at(7) }]);
    const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 4, date: TODAY }, deps(parse));
    assert.ok(!out.notes.some((n: string) => /heart-rate|heart rate/i.test(n)), out.notes.join("\n"));
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

test("history by name: journal tags do not change the merge", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([{ key: keyOf(1), startMs: at(7) }]);
    const entries: JournalEntry[] = [{ workoutKey: keyOf(1), loggedAt: "x", tags: ["deload"], note: "easy" }];
    const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 2, date: TODAY }, deps(parse, { loadJournal: journalOf(entries) }));
    assert.deepEqual(out.sessions.rows[0][out.sessions.cols.indexOf("journal")], { note: "easy" });
    assert.equal(out.notes.some((n: string) => /journal entr(y|ies) ignored/.test(n)), false);
    // the named result carries the progression hint of its newest session (no sets logged: a repeat)
    assert.equal(out.suggestion.last, out.suggestion.target);
    assert.match(out.suggestion.reason, /log_session/);
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

// ---------- hostile journal files, demo mode ----------

test("history: malformed journal entries are skipped and counted in one note; the valid ones still apply", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([{ key: keyOf(1), startMs: at(14) }, { key: keyOf(2), startMs: at(7) }, { key: keyOf(3), startMs: at(3) }, { key: keyOf(4), startMs: at(2) }]);
    const good: JournalEntry = { workoutKey: keyOf(4), loggedAt: "x", exercises: [{ name: "Back Squat", sets: [{ reps: 5, kg: 90 }] }] };
    const hostile: any = {
      [keyOf(1)]: { exercises: "x" },
      [keyOf(2)]: { workoutKey: keyOf(2), loggedAt: "x", exercises: [{ sets: [{ kg: 1 }] }] },
      [keyOf(3)]: { workoutKey: keyOf(3), loggedAt: "x", exercises: [{ name: "Back Squat", sets: "x" }] },
      [keyOf(4)]: good,
    };
    const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 4, date: TODAY }, deps(parse, { loadJournal: async () => hostile }));
    assert.equal(out.summary.sessions, 4);
    const c = (n: string) => out.sessions.cols.indexOf(n);
    assert.deepEqual(out.sessions.rows.map((r: any[]) => r[c("loadSource")]), ["label", "label", "label", "journal"]);
    assert.equal(out.notes.filter((n: string) => /journal entries ignored/.test(n)).length, 1);
    assert.match(out.notes.join(" "), /3 journal entries ignored/);
    const index: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse, { loadJournal: async () => hostile }));
    assert.equal(index.sessions, 4);
  });
});

test("history: in demo mode the journal file is not read at all", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([{ key: keyOf(1), startMs: at(7) }]);
    const saved = process.env.SUUNTO_DEMO;
    process.env.SUUNTO_DEMO = "1";
    let reads = 0;
    try {
      const out: any = await buildExerciseHistory(client, { name: "Back Squat", weeks: 2, date: TODAY }, deps(parse, { loadJournal: async () => { reads++; return { [keyOf(1)]: { workoutKey: keyOf(1), loggedAt: "x", note: "real" } }; } }));
      assert.equal(reads, 0);
      assert.equal(out.sessions.rows[0][out.sessions.cols.indexOf("journal")], null);
    } finally {
      if (saved === undefined) delete process.env.SUUNTO_DEMO;
      else process.env.SUUNTO_DEMO = saved;
    }
  });
});

// ---------- pending that cannot reach 0 ----------

const manySessions = (n: number, extra: (i: number) => Partial<W> = () => ({})): W[] => Array.from({ length: n }, (_, i) => ({ key: keyOf(i + 1), startMs: at(i + 2), ...extra(i + 1) }));

test("history: when the cache cannot be written, pending stays and the note says calling again will not help", async () => {
  await withCacheDir(async (dir) => {
    const blocker = join(dirname(dir), "blocker");
    await writeFile(blocker, "a file where the cache folder should go");
    process.env.SUUNTO_CACHE_DIR = join(blocker, "cache");
    const { client, parse } = fakeClient(manySessions(12));
    for (let i = 0; i < 2; i++) {
      const out: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
      assert.deepEqual(out.errors, []);
      assert.equal(out.pending, 4, "nothing was cached, so nothing got closer to 0");
      const note = out.notes.join(" ");
      assert.match(note, /will not help/);
      assert.match(note, /not writable/);
      assert.ok(note.includes(join(blocker, "cache")), "the folder is named");
      assert.doesNotMatch(note, /call again until pending is 0/);
    }
  });
});

test("history: sessions that keep failing say so instead of 'call again', and cannot starve the older ones", async () => {
  await withCacheDir(async () => {
    // the nine newest fail every time; the three oldest are fine
    const { client, calls, parse } = fakeClient(manySessions(12, (k) => ({ fails: k <= 9 })));
    const first: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    assert.equal(first.errors.length, MAX_FETCH);
    assert.equal(first.pending, 4);
    assert.match(first.notes.join(" "), /will not help.*8 session\(s\) failed to load \(see errors\)/);
    assert.doesNotMatch(first.notes.join(" "), /call again until pending is 0/);
    calls.laps.length = 0;
    const second: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    assert.deepEqual(calls.laps.slice(0, 4), [keyOf(9), keyOf(10), keyOf(11), keyOf(12)], "the not yet tried ones come first");
    assert.deepEqual(calls.laps.slice(4), [keyOf(1), keyOf(2), keyOf(3), keyOf(4)], "then the ones that failed, newest first, each once");
    assert.equal(second.sessions, 3, "the three older sessions got through; the ninth fails like the others");
  });
});

// ---------- names that look alike ----------

test("history index: 'Squat' and 'Squat Jump' stay separate even when the short one's label is at the cut length; the note says so", async () => {
  await withCacheDir(async () => {
    const longDetail = "100kg 3x5 tempo 3-1-0 pause!!xxxx"; // 'Squat' + 1 + 33 characters: at the 39-character cut
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14), subst: [["Back Squat", "Squat"], ["100kg 3x5", longDetail]] },
      { key: keyOf(2), startMs: at(7), subst: [["Back Squat", "Squat Jump"]] },
    ]);
    const index: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    const names = index.exercises.map((e: any) => e.name);
    assert.ok(names.includes("Squat") && names.includes("Squat Jump"), names.join());
    assert.equal(index.exercises.find((e: any) => e.name === "Squat").sessions, 1);
    assert.equal(index.exercises.find((e: any) => e.name === "Squat Jump").sessions, 1);
    assert.match(index.notes.join(" "), /could not be told apart.*Squat.*Squat Jump/);
    const named: any = await buildExerciseHistory(client, { name: "Squat Jump", weeks: 4, date: TODAY }, deps(parse));
    assert.equal(named.summary.sessions, 1, "the short name is not folded into the long one when asked by name either");
  });
});

test("history index: a cut name with exactly one longer candidate and 12+ characters is merged into it", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(14), subst: [["Back Squat", "Barbell Bulgarian Split S"], ["100kg 3x5", "100kg 3x5 xxx"]] }, // 25 + 1 + 13 characters: at the cut
      { key: keyOf(2), startMs: at(7), subst: [["Back Squat", "Barbell Bulgarian Split Squat"]] },
    ]);
    const index: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    const rows = index.exercises.filter((e: any) => e.name.startsWith("Barbell"));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].name, rows[0].sessions], ["Barbell Bulgarian Split Squat", 2]);
    assert.doesNotMatch(index.notes.join(" "), /told apart/);
  });
});

test("history index: a cut name with two longer candidates is not merged; the note lists them", async () => {
  await withCacheDir(async () => {
    const { client, parse } = fakeClient([
      { key: keyOf(1), startMs: at(21), subst: [["Back Squat", "Barbell Bulgarian Split S"], ["100kg 3x5", "100kg 3x5 xxx"]] },
      { key: keyOf(2), startMs: at(14), subst: [["Back Squat", "Barbell Bulgarian Split Squat"]] },
      { key: keyOf(3), startMs: at(7), subst: [["Back Squat", "Barbell Bulgarian Split Stance"]] },
    ]);
    const index: any = await buildExerciseHistory(client, { weeks: 4, date: TODAY }, deps(parse));
    const rows = index.exercises.filter((e: any) => e.name.startsWith("Barbell"));
    assert.deepEqual(rows.map((e: any) => [e.name, e.sessions]).sort(), [["Barbell Bulgarian Split S", 1], ["Barbell Bulgarian Split Squat", 1], ["Barbell Bulgarian Split Stance", 1]]);
    assert.match(index.notes.join(" "), /could not be told apart.*Barbell Bulgarian Split S.*Barbell Bulgarian Split Squat.*Barbell Bulgarian Split Stance/);
  });
});

// ---------- suggestProgression ----------

// A history result with one row per session (oldest first): [detail, kg, journalSets].
function hist(...sessions: [string | null, number | null, any[] | null][]) {
  const rows = sessions.map(([detail, kg, sets], i) => COLS.map((c) => (c === "date" ? `2026-10-0${i + 1}` : c === "detail" ? detail : c === "kg" ? kg : c === "journal" ? (sets ? { sets } : null) : null)));
  return { sessions: { cols: COLS, rows } };
}
const sets = (n: number, reps: number, kg: number) => Array.from({ length: n }, () => ({ reps, kg }));

test("suggestProgression: every planned rep hit -> same sets x reps, load +2.5 kg", () => {
  const r = suggestProgression(hist(["60kg 3x8", 60, sets(3, 8, 60)]));
  assert.equal(r.last, "3x8@60kg");
  assert.equal(r.target, "3x8@62.5kg");
  assert.match(r.reason, /every set reached 8 reps/);
  // the increase is capped at 5% of the load, in 1.25 kg steps, never below 1.25 kg
  assert.equal(suggestProgression(hist(["60kg 3x8", 60, sets(3, 8, 60)]), { incrementKg: 5 }).target, "3x8@62.5kg");
  assert.equal(suggestProgression(hist(["100kg 3x5", 100, sets(3, 5, 100)]), { incrementKg: 5 }).target, "3x5@105kg");
  assert.equal(suggestProgression(hist(["100kg 3x5", 100, sets(3, 5, 100)])).target, "3x5@102.5kg");
  assert.equal(suggestProgression(hist(["5kg 3x10", 5, sets(3, 10, 5)])).target, "3x10@6.25kg", "a 5 kg dumbbell goes up by 1.25 kg, not 2.5");
  assert.equal(suggestProgression(hist(["30kg 3x10", 30, sets(3, 10, 30)])).target, "3x10@31.25kg");
});

test("suggestProgression: a short set repeats the load; extra reps and a heavier top set count as hit", () => {
  const miss = suggestProgression(hist(["60kg 3x8", 60, [{ reps: 8, kg: 60 }, { reps: 8, kg: 60 }, { reps: 6, kg: 60 }]]));
  assert.equal(miss.last, "8/8/6@60kg");
  assert.equal(miss.target, "3x8@60kg");
  assert.match(miss.reason, /repeat/);
  assert.equal(suggestProgression(hist(["60kg 3x8", 60, sets(2, 8, 60)])).target, "3x8@60kg", "a missing set is not a hit");
  assert.equal(suggestProgression(hist(["60kg 3x8", 65, sets(4, 9, 65)])).target, "3x8@67.5kg");
});

test("suggestProgression: uses the newest session only; no history, no load, a rep range or no log never invent a progression", () => {
  const newest = suggestProgression(hist(["50kg 3x8", 50, sets(3, 8, 50)], ["60kg 3x8", 60, sets(3, 8, 60)]));
  assert.equal(newest.last, "3x8@60kg");
  assert.deepEqual(suggestProgression({ sessions: { cols: COLS, rows: [] } }), { last: null, target: null, reason: "no sessions to learn from" });
  // bodyweight: nothing to add to
  const bw = suggestProgression(hist(["BW 3x12", null, sets(3, 12, 0).map(({ reps }) => ({ reps }))]));
  assert.equal(bw.last, "3x12");
  assert.equal(bw.target, "3x12");
  // every way of writing a rep range: no increase, whatever was logged
  for (const detail of ["60kg 3x8–12", "60kg 3x8 - 12", "60kg 3 x 8 to 12", "60kg 3x8—12", "60kg 3x8−12"]) {
    const r = suggestProgression(hist([detail, 60, sets(3, 12, 60)]));
    assert.equal(r.target, "3x12@60kg", detail);
    assert.match(r.reason, /cannot be read/, detail);
  }
  // a rep range: what counts as "hit" is a decision for the caller
  assert.equal(suggestProgression(hist(["60kg 3x8-12", 60, sets(3, 12, 60)])).target, "3x12@60kg");
  // only the guide's plan is known (nothing logged): repeat it, and say that nothing was verified
  const planned = suggestProgression(hist(["60kg 3x8", 60, null]));
  assert.equal(planned.last, "3x8@60kg");
  assert.equal(planned.target, "3x8@60kg");
  assert.match(planned.reason, /log_session/);
  // an unreadable detail is passed through as it is
  assert.equal(suggestProgression(hist(["RPE6 8-12", null, null])).last, "RPE6 8-12");
});

test("suggestProgression: logged weights that differ between sets never give an increase, and the top weight is never paired with other sets' reps", () => {
  // 8@60, 8@60, 5@65 against 3x8: the 65 kg set missed; the sets that hit the reps were at 60
  const miss = suggestProgression(hist(["60kg 3x8", 65, [{ reps: 8, kg: 60 }, { reps: 8, kg: 60 }, { reps: 5, kg: 65 }]]));
  assert.equal(miss.last, "8@60/8@60/5@65kg");
  assert.equal(miss.target, "3x8@60kg");
  assert.match(miss.reason, /differ/);
  // 8@60, 8@60, 8@70: every rep hit, but the weights differ: repeat at the lowest, no +2.5 on the 70
  const mixed = suggestProgression(hist(["60kg 3x8", 70, [{ reps: 8, kg: 60 }, { reps: 8, kg: 60 }, { reps: 8, kg: 70 }]]));
  assert.equal(mixed.last, "8@60/8@60/8@70kg");
  assert.equal(mixed.target, "3x8@60kg");
  assert.match(mixed.reason, /differ.*lowest/);
  // some sets with a weight, some without: not comparable, no increase
  const partial = suggestProgression(hist(["60kg 3x8", 60, [{ reps: 8, kg: 60 }, { reps: 8 }, { reps: 8, kg: 60 }]]));
  assert.equal(partial.target, "3x8@60kg");
  assert.match(partial.reason, /differ/);
  // sets that missed only at the lowest weight: the weight of the sets that hit the reps is used
  const lowMiss = suggestProgression(hist(["60kg 3x8", 70, [{ reps: 6, kg: 55 }, { reps: 8, kg: 70 }, { reps: 8, kg: 70 }]]));
  assert.equal(lowMiss.target, "3x8@70kg");
});
