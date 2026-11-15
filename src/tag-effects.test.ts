import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, selectDays, selectNights } from "./api.js";
import type { JournalEntry } from "./journal.js";
import { addDays } from "./training-load.js";
import { MAX_DAYS, MIN_DAYS, MIN_NIGHTS, SE_K, buildTagEffects, effectOf, thresholdOf } from "./tag-effects.js";

const DATE = "2026-11-15";
const round1 = (n: number) => Math.round(n * 10) / 10;
const rep = (n: number, v: number) => Array<number>(n).fill(v);
const spread = (n: number, centre: number, step: number) => Array.from({ length: n }, (_, i) => centre + (i - (n - 1) / 2) * step);

// ---------- the decision rule, on its own ----------

test("thresholdOf: K * 1.25 * (control IQR / 1.35) * sqrt(1/nTagged + 1/nControl), K = 3", () => {
  assert.equal(SE_K, 3);
  // control 0..14: IQR 7 by linear interpolation; 15 and 15 nights
  const control = Array.from({ length: 15 }, (_, i) => i);
  assert.ok(Math.abs(thresholdOf(control, 15)! - 3 * 1.25 * (7 / 1.35) * Math.sqrt(2 / 15)) < 1e-9);
  // unequal groups: sqrt(1/20 + 1/15)
  assert.ok(Math.abs(thresholdOf(control, 20)! - 3 * 1.25 * (7 / 1.35) * Math.sqrt(1 / 20 + 1 / 15)) < 1e-9);
  assert.equal(thresholdOf([], 15), null);
  assert.equal(thresholdOf(rep(15, 5), 15), 0, "a constant control group has no spread");
});

test("effectOf: the minimum is 15 tagged AND 15 untagged nights; 14 of either is insufficient however big the difference", () => {
  assert.equal(MIN_NIGHTS, 15);
  const at = (tagged: number, control: number) => effectOf(rep(tagged, 20), spread(control, 60, 1), round1).verdict;
  assert.equal(at(15, 15), "tagged-lower");
  assert.equal(at(14, 15), "insufficient");
  assert.equal(at(15, 14), "insufficient");
  assert.equal(at(14, 14), "insufficient");
  assert.equal(at(16, 16), "tagged-lower");
  assert.equal(at(0, 15), "insufficient");
});

test("effectOf: the median difference must EXCEED the threshold (equal as printed is within noise), on both sides", () => {
  const control = spread(15, 60, 1); // median 60, IQR 7
  const thr = round1(thresholdOf(control, 15)!);
  const v = (diff: number) => effectOf(rep(15, 60 + diff), control, round1);
  assert.equal(v(-thr).noiseThreshold, thr);
  assert.equal(v(-thr).verdict, "within-noise", "equal to the threshold is not beyond it");
  assert.equal(v(thr).verdict, "within-noise");
  assert.equal(v(-thr - 0.1).verdict, "tagged-lower");
  assert.equal(v(thr + 0.1).verdict, "tagged-higher");
  assert.equal(v(-thr + 0.1).verdict, "within-noise");
  assert.equal(v(0).verdict, "within-noise");
});

test("effectOf: a wider control spread raises the bar, more nights lower it", () => {
  // the same 15-value pattern repeated: n = 15 or 60 nights with a similar IQR (7 and 8 steps)
  const cycle = (n: number, step: number) => Array.from({ length: n }, (_, i) => 60 + ((i % 15) - 7) * step);
  const verdictFor = (step: number, n: number) => effectOf(rep(n, 69), cycle(n, step), round1).verdict;
  assert.equal(verdictFor(1, 15), "tagged-higher", "9 against a bar of about 7.1");
  assert.equal(verdictFor(2, 15), "within-noise", "twice the spread: the same 9 is now below a bar of about 14.2");
  assert.equal(verdictFor(2, 60), "tagged-higher", "four times the nights: the bar drops to about 8.1");
});

test("effectOf: constant control nights have no spread: any difference at all exceeds 0, none is within noise", () => {
  assert.equal(effectOf(rep(15, 80), rep(15, 80), round1).verdict, "within-noise");
  assert.equal(effectOf(rep(15, 81), rep(15, 80), round1).verdict, "tagged-higher");
});

test("effectOf: compared as printed (rounded), so the verdict never contradicts the numbers", () => {
  const control = spread(15, 60, 1);
  const thr = thresholdOf(control, 15)!; // about 7.1
  const e = effectOf(rep(15, 60 + round1(thr) - 0.04), control, round1);
  assert.equal(e.medianDiff, round1(thr));
  assert.equal(e.verdict, "within-noise");
});

test("effectOf: the statistics are reported with the threshold and the control spread; empty groups give nulls", () => {
  const e = effectOf([1, 2, 3, 4, 5, 6, 7, 100, 8, 9, 10, 11, 12, 13, 14], rep(15, 4), round1);
  assert.equal(e.taggedMedian, 8);
  assert.equal(e.controlMedian, 4);
  assert.equal(e.medianDiff, 4);
  assert.equal(e.meanDiff, round1((1 + 2 + 3 + 4 + 5 + 6 + 7 + 100 + 8 + 9 + 10 + 11 + 12 + 13 + 14) / 15 - 4));
  assert.equal(e.controlIqr, 0);
  assert.equal(e.noiseThreshold, 0);
  const none = effectOf([], [], round1);
  assert.deepEqual([none.nTagged, none.taggedMedian, none.controlMedian, none.medianDiff, none.meanDiff, none.noiseThreshold, none.controlIqr, none.verdict], [0, null, null, null, null, null, null, "insufficient"]);
});

// ---------- false alarms and power, by simulation (seeded: the same numbers every run) ----------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (r: () => number, mean: number, sd: number) => mean + sd * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const draw = (r: () => number, n: number, mean = 50, sd = 10) => Array.from({ length: n }, () => normal(r, mean, sd));
const METRICS = 4;
const flagged = (v: string) => v === "tagged-higher" || v === "tagged-lower";

test("simulation: with NO real difference, at most about 12% of tags are flagged on any of the 4 metrics (n = 15, 20, 30 per group)", () => {
  const rates: Record<number, number> = {};
  for (const n of [15, 20, 30]) {
    const r = prng(1000 + n);
    const trials = 2000;
    let falseAlarms = 0;
    for (let t = 0; t < trials; t++) {
      let any = false;
      for (let m = 0; m < METRICS; m++) any ||= flagged(effectOf(draw(r, n), draw(r, n), round1).verdict);
      if (any) falseAlarms++;
    }
    rates[n] = falseAlarms / trials;
    assert.ok(rates[n] <= 0.12, `n=${n}: ${rates[n]} of tags flagged with no effect`);
  }
  console.log(`# simulated false-alarm rate per tag (4 metrics, no effect): ${JSON.stringify(rates)}`);
});

test("simulation: nights correlated 0.3 night to night flag more (the note says so): still at most about 25% of tags at n = 15 to 30", () => {
  const r = prng(4242);
  const ar1 = (n: number) => {
    let x = 0;
    return Array.from({ length: n }, () => (x = 0.3 * x + Math.sqrt(1 - 0.09) * normal(r, 0, 1)) * 10 + 50);
  };
  for (const n of [15, 20, 30]) {
    let falseAlarms = 0;
    for (let t = 0; t < 2000; t++) {
      let any = false;
      for (let m = 0; m < METRICS; m++) any ||= flagged(effectOf(ar1(n), ar1(n), round1).verdict);
      if (any) falseAlarms++;
    }
    assert.ok(falseAlarms / 2000 <= 0.25, `n=${n}: ${falseAlarms / 2000}`);
    console.log(`# correlated nights, n=${n}: ${falseAlarms / 2000}`);
  }
});

test("simulation: a real shift of 1.5 IQR in one metric is flagged (n = 20 per group), a shift of 0 is not (the same draws)", () => {
  const r = prng(77);
  const iqr = 1.349 * 10; // the IQR of a normal with sd 10
  let power = 0;
  const trials = 1000;
  for (let t = 0; t < trials; t++) {
    const verdict = effectOf(draw(r, 20, 50 - 1.5 * iqr), draw(r, 20), round1).verdict;
    if (verdict === "tagged-lower") power++;
  }
  assert.ok(power / trials >= 0.93, `power ${power / trials}`);
  // and one fixed case, so a failure shows what was compared
  const e = effectOf(spread(20, 50 - 1.5 * iqr, 1), spread(20, 50, 1), round1);
  assert.equal(e.verdict, "tagged-lower");
});

// ---------- the join, on a fake account ----------

const keyOf = (n: number) => n.toString(16).padStart(24, "0");
const workout = (key: string, date: string, hhmm = "17:00") => ({ workoutKey: key, activityId: 23, startTime: Date.parse(`${date}T${hhmm}:00Z`), timeOffsetInMinutes: 0, totalTime: 3600 });
// the night that begins on the evening of `night` and ends the next morning
const sleepOf = (night: string, hrv: number, score = 80, durationS = 27000) => ({
  timestamp: `${night}T23:00:00.000Z`,
  entryData: { SleepId: Date.parse(`${night}T00:00:00Z`) / 1000, BedtimeStart: `${night}T23:00:00.000Z`, BedtimeEnd: `${addDays(night, 1)}T06:30:00.000Z`, Duration: durationS, IsNap: false, SleepQualityScore: score, AvgHRV: hrv },
});
const recoveryOf = (day: string, balance: number) => ({ timestamp: `${day}T06:30:00.000Z`, entryData: { Balance: balance, StressState: 1 } });
const entry = (key: string, tags?: string[]): JournalEntry => ({ workoutKey: key, loggedAt: "2026-11-01T00:00:00.000Z", note: "x", ...(tags ? { tags } : {}) });

interface Data {
  workouts?: any[];
  sleeps?: any[];
  recoveries?: any[];
  fail?: string[];
}
function fake(data: Data) {
  const calls: { name: string; args: any[] }[] = [];
  const client = {
    listWorkouts: async (o: any) => {
      calls.push({ name: "workouts", args: [o] });
      const rows = (data.workouts ?? []).filter((w) => (o.since == null || w.startTime >= o.since) && (o.until == null || w.startTime <= o.until));
      return { payload: rows.sort((x, y) => y.startTime - x.startTime).slice(0, o.limit ?? 25) };
    },
    listSleep: async (from: string, to: string) => {
      calls.push({ name: "sleep", args: [from, to] });
      if (data.fail?.includes("sleep")) throw new Error("boom sleep");
      return selectNights({ payload: data.sleeps ?? [] }, from, to);
    },
    listRecovery: async (from: string, to: string) => {
      calls.push({ name: "recovery", args: [from, to] });
      if (data.fail?.includes("recovery")) throw new Error("boom recovery");
      return selectDays({ payload: data.recoveries ?? [] }, from, to);
    },
  } as unknown as SuuntoClient;
  return { client, calls };
}

// 60 session days ending two days before DATE (the night after the day before DATE is the last one read). Even days
// carry `tag` and are followed by a low-HRV night; odd days do not and are followed by a high-HRV one.
const DAYS = 60;
function account(opts: { tagged?: number; control?: number; tag?: string } = {}) {
  const tag = opts.tag ?? "heavy";
  const sessionDays: string[] = [];
  for (let i = 0; i < DAYS; i++) sessionDays.push(addDays(DATE, -(DAYS + 1 - i)));
  const workouts: any[] = [];
  const journal: Record<string, JournalEntry> = {};
  const sleeps: any[] = [];
  const recoveries: any[] = [];
  let taggedLeft = opts.tagged ?? 30;
  let controlLeft = opts.control ?? 30;
  sessionDays.forEach((day, i) => {
    const key = keyOf(i + 1);
    const isTagged = i % 2 === 0;
    if (isTagged ? taggedLeft-- <= 0 : controlLeft-- <= 0) return; // a day without a session: a rest day
    workouts.push(workout(key, day));
    if (isTagged) journal[key] = entry(key, [tag]);
    sleeps.push(sleepOf(day, (isTagged ? 40 : 60) + (i % 3)));
    recoveries.push(recoveryOf(addDays(day, 1), (isTagged ? 0.5 : 0.7) + (i % 3) / 100));
  });
  return { workouts, journal, sleeps, recoveries, sessionDays };
}
const run = (a: ReturnType<typeof account>, opts: { tag?: string } = {}, journal = a.journal) => buildTagEffects(fake(a).client, { date: DATE, days: DAYS, ...opts }, { loadJournal: async () => journal }) as Promise<any>;

test("tag effects: a clear gap over 30 tagged and 30 untagged nights is reported with n, the rule and no claim of cause", async () => {
  const a = account();
  const { client, calls } = fake(a);
  const res: any = await buildTagEffects(client, { date: DATE, days: DAYS }, { loadJournal: async () => a.journal });
  assert.equal(res.date, DATE);
  assert.deepEqual([res.thresholds.minTaggedNights, res.thresholds.minUntaggedNights, res.thresholds.k], [15, 15, 3]);
  assert.match(res.thresholds.rule, /3 \* 1\.25 \* \(IQR of the untagged nights \/ 1\.35\) \* sqrt\(1\/nTagged \+ 1\/nUntagged\)/);
  assert.equal(res.tags.length, 1);
  const t = res.tags[0];
  assert.equal(t.tag, "heavy");
  assert.equal(t.taggedNights, 30);
  assert.equal(t.untaggedNights, 30);
  assert.equal(t.verdict, "differs");
  assert.match(t.statement, /30 tagged vs 30 untagged nights/);
  assert.match(t.statement, /association, not a cause/);
  assert.equal(t.metrics.hrv.verdict, "tagged-lower");
  assert.equal(t.metrics.hrv.nTagged, 30);
  assert.ok(t.metrics.hrv.medianDiff < -15 && t.metrics.hrv.medianDiff > -25, String(t.metrics.hrv.medianDiff));
  assert.ok(t.metrics.hrv.noiseThreshold > 0 && t.metrics.hrv.controlIqr > 0);
  assert.equal(t.metrics.recoveryMorning.verdict, "tagged-lower");
  assert.equal(t.metrics.sleepDurationS.verdict, "within-noise", "identical sleep durations: no difference at all");
  assert.equal(t.metrics.sleepDurationS.medianDiff, 0);
  const notes = res.notes.join("\n");
  assert.match(notes, /association/i);
  assert.match(notes, /not a cause/i);
  assert.match(notes, /4 metrics/);
  assert.match(notes, /at least 15 tagged and 15 untagged nights/);
  assert.match(notes, /false.alarm/i);
  assert.match(notes, /after midnight/);
  // the window: nights of days from..date-1, sessions on the days before them; the date's own night is not read
  assert.deepEqual(calls.find((c) => c.name === "sleep")!.args, [addDays(DATE, -(DAYS + 1)), addDays(DATE, -2)]);
  assert.deepEqual(calls.find((c) => c.name === "recovery")!.args, [addDays(DATE, -DAYS), addDays(DATE, -1)]);
  const b = dayFetchBounds(addDays(DATE, -(DAYS + 1)), addDays(DATE, -2));
  assert.deepEqual([calls.find((c) => c.name === "workouts")!.args[0].since, calls.find((c) => c.name === "workouts")!.args[0].until], [b.from, b.to]);
});

test("tag effects: 14 tagged nights are insufficient, 15 are enough (the minimum, end to end); the same for untagged", async () => {
  for (const [n, verdict] of [[14, "insufficient"], [15, "differs"]] as const) {
    const res = await run(account({ tagged: n }));
    assert.equal(res.tags[0].taggedNights, n);
    assert.equal(res.tags[0].verdict, verdict, `${n} tagged nights`);
  }
  for (const [n, verdict] of [[14, "insufficient"], [15, "differs"]] as const) {
    const res = await run(account({ control: n }));
    assert.equal(res.tags[0].untaggedNights, n);
    assert.equal(res.tags[0].verdict, verdict, `${n} untagged nights`);
  }
});

test("tag effects: rest days are not controls; a session without a journal entry counts as untagged", async () => {
  const a = account({ control: 15 });
  const res = await run(a);
  assert.equal(res.tags[0].untaggedNights, 15);
  assert.equal(res.sessionDays, 45);
  const none = await run(a, {}, { [keyOf(1)]: entry(keyOf(1), ["heavy"]) });
  assert.equal(none.tags[0].taggedNights, 1);
  assert.equal(none.tags[0].untaggedNights, 44);
});

test("tag effects: two sessions on one day make one night; a day is tagged when any session on it is", async () => {
  const a = account();
  a.workouts.push(workout(keyOf(101), a.sessionDays[0], "08:00")); // a second, untagged session on a tagged day
  a.workouts.push(workout(keyOf(102), a.sessionDays[1], "08:00")); // a tagged one on a control day
  const res = await run(a, {}, { ...a.journal, [keyOf(102)]: entry(keyOf(102), ["heavy"]) });
  const t = res.tags[0];
  assert.equal(t.taggedSessions, 31);
  assert.equal(t.taggedNights, 31, "the control day is now tagged and the tagged day stays tagged: 30 + 1 nights, not 32");
  assert.equal(t.untaggedNights, 29);
  assert.equal(res.sessionDays, 60);
});

test("tag effects: tags are matched ignoring case; the first spelling is shown; a tag filter selects one", async () => {
  const a = account();
  const journal: Record<string, JournalEntry> = {};
  Object.entries(a.journal).forEach(([k, e], i) => (journal[k] = entry(k, [i % 2 ? "HEAVY" : "Heavy"])));
  const all = await run(a, {}, journal);
  assert.equal(all.tags.length, 1);
  assert.equal(all.tags[0].taggedNights, 30);
  const other = { ...journal, [keyOf(2)]: entry(keyOf(2), ["deload"]) };
  const two = await run(a, {}, other);
  assert.deepEqual(two.tags.map((t: any) => t.tag), ["Heavy", "deload"]);
  const only = await run(a, { tag: "DELOAD" }, other);
  assert.deepEqual(only.tags.map((t: any) => t.tag), ["deload"]);
  assert.equal(only.tags[0].verdict, "insufficient");
  assert.equal(only.tags[0].taggedNights, 1);
});

test("tag effects: nights without data are counted per metric, not hidden; a failed section is listed and its metrics empty", async () => {
  const a = account();
  // the night after the first tagged day has no sleep; the night after the third has a sleep with no HRV
  a.sleeps = a.sleeps.filter((s: any) => !s.timestamp.startsWith(a.sessionDays[0]));
  const idx = a.sleeps.findIndex((s: any) => s.timestamp.startsWith(a.sessionDays[2]));
  delete a.sleeps[idx].entryData.AvgHRV;
  const res = await run(a);
  const m = res.tags[0].metrics;
  assert.equal(res.tags[0].taggedNights, 30);
  assert.equal(m.hrv.nTagged, 28);
  assert.equal(m.sleepScore.nTagged, 29);
  assert.equal(m.hrv.nControl, 30);
  const failed: any = await buildTagEffects(fake({ ...a, fail: ["sleep"] }).client, { date: DATE, days: DAYS }, { loadJournal: async () => a.journal });
  assert.deepEqual(failed.errors.map((e: any) => e.section), ["sleep"]);
  assert.equal(failed.tags[0].metrics.hrv.nTagged, 0);
  assert.equal(failed.tags[0].metrics.hrv.verdict, "insufficient");
  assert.equal(failed.tags[0].metrics.recoveryMorning.nTagged, 0, "recovery on waking is read at the main sleep's end, which needs the sleep");
});

test("tag effects: no tagged session at all says how to tag; the journal's invalid entries are counted, an unreadable journal stops the call", async () => {
  const a = account();
  const res = await run(a, {}, { [keyOf(1)]: entry(keyOf(1)), bad: { nonsense: true } as any });
  assert.deepEqual(res.tags, []);
  assert.match(res.notes.join(" "), /log_session/);
  assert.equal(res.journal.ignored, 1);
  await assert.rejects(buildTagEffects(fake(a).client, { date: DATE, days: DAYS }, { loadJournal: async () => { throw new Error("/x/journal.json is not valid JSON; fix or delete it"); } }), /not valid JSON/);
});

test("tag effects: arguments are validated (30 to 180 nights: the least that can hold 15 + 15)", async () => {
  const { client } = fake({});
  const deps = { loadJournal: async () => ({}) };
  assert.equal(MIN_DAYS, 30);
  assert.equal(MAX_DAYS, 180);
  await assert.rejects(buildTagEffects(client, { date: "2026-02-30" }, deps), /not a valid calendar date/);
  for (const days of [29, 181, 30.5, NaN]) await assert.rejects(buildTagEffects(client, { date: DATE, days }, deps), /days must be an integer from 30 to 180/);
  await buildTagEffects(client, { date: DATE, days: 30 }, deps);
  await buildTagEffects(client, { date: DATE, days: 180 }, deps);
  await assert.rejects(buildTagEffects(client, { date: DATE, tag: "  " }, deps), /tag must not be empty/);
});

test("tag effects: the journal FILE is read as log_session writes it; a corrupt, foreign or other-version file stops the call and is left as it is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-tags-"));
  const saved = process.env.SUUNTO_JOURNAL_PATH;
  const path = join(dir, "journal.json");
  process.env.SUUNTO_JOURNAL_PATH = path;
  try {
    const a = account();
    await writeFile(path, JSON.stringify({ version: 1, entries: a.journal }));
    const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: DAYS });
    assert.equal(res.tags[0].taggedNights, 30);
    for (const [body, why] of [["{ not json", /not valid JSON/], [JSON.stringify({ version: 2, entries: {} }), /version 1 only/], [JSON.stringify([1]), /not a suunto-mcp journal/]] as const) {
      await writeFile(path, body);
      await assert.rejects(buildTagEffects(fake(a).client, { date: DATE, days: DAYS }), why);
      assert.equal(await readFile(path, "utf8"), body);
    }
  } finally {
    if (saved === undefined) delete process.env.SUUNTO_JOURNAL_PATH;
    else process.env.SUUNTO_JOURNAL_PATH = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
