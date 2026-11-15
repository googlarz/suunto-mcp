import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, selectDays, selectNights } from "./api.js";
import type { JournalEntry } from "./journal.js";
import { addDays } from "./training-load.js";
import { MAX_DAYS, MIN_DAYS, MIN_NIGHTS, buildTagEffects, effectOf } from "./tag-effects.js";

const DATE = "2026-11-15";
const round1 = (n: number) => Math.round(n * 10) / 10;
const rep = (n: number, v: number) => Array<number>(n).fill(v);

// ---------- the decision rule, on its own ----------

test("effectOf: the minimum is 8 tagged AND 8 untagged nights; 7 of either is insufficient however big the difference", () => {
  assert.equal(MIN_NIGHTS, 8);
  const at = (tagged: number, control: number) => effectOf(rep(tagged, 40), rep(control, 60), 5, round1).verdict;
  assert.equal(at(8, 8), "tagged-lower");
  assert.equal(at(7, 8), "insufficient");
  assert.equal(at(8, 7), "insufficient");
  assert.equal(at(7, 7), "insufficient");
  assert.equal(at(9, 9), "tagged-lower");
  assert.equal(at(0, 8), "insufficient");
});

test("effectOf: the median difference must EXCEED the noise half-width (equal is within noise), on both sides", () => {
  const v = (diff: number, hw: number) => effectOf(rep(8, 60 + diff), rep(8, 60), hw, round1).verdict;
  assert.equal(v(-10, 10), "within-noise", "equal to the half-width is not beyond it");
  assert.equal(v(10, 10), "within-noise");
  assert.equal(v(-10.1, 10), "tagged-lower");
  assert.equal(v(10.1, 10), "tagged-higher");
  assert.equal(v(-9.9, 10), "within-noise");
  assert.equal(v(0, 0), "within-noise");
  assert.equal(v(0.1, 0), "tagged-higher");
});

test("effectOf: compared as printed (rounded), so the verdict never contradicts the numbers", () => {
  // -10.04 prints as -10 (one decimal); the half-width prints as 10: within noise
  const e = effectOf(rep(8, 49.96), rep(8, 60), 10, round1);
  assert.equal(e.medianDiff, -10);
  assert.equal(e.verdict, "within-noise");
});

test("effectOf: no noise band (too few nights for a baseline) is insufficient; the statistics are still reported", () => {
  const e = effectOf(rep(8, 40), rep(8, 60), null, round1);
  assert.equal(e.verdict, "insufficient");
  assert.deepEqual([e.nTagged, e.nControl, e.taggedMedian, e.controlMedian, e.medianDiff, e.meanDiff, e.noiseHalfWidth], [8, 8, 40, 60, -20, -20, null]);
});

test("effectOf: median and mean differ on skewed data, and empty groups give nulls", () => {
  const e = effectOf([1, 2, 3, 4, 5, 6, 7, 100], rep(8, 4), 1, round1);
  assert.equal(e.taggedMedian, 4.5);
  assert.equal(e.meanDiff, round1((1 + 2 + 3 + 4 + 5 + 6 + 7 + 100) / 8 - 4));
  assert.equal(e.medianDiff, 0.5);
  const none = effectOf([], [], 1, round1);
  assert.deepEqual([none.nTagged, none.taggedMedian, none.controlMedian, none.medianDiff, none.meanDiff, none.verdict], [0, null, null, null, null, "insufficient"]);
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

// 28 session days ending two days before DATE (the night after the day before DATE is the last one read). Even days
// carry `tag` and are followed by a low-HRV night; odd days do not and are followed by a high-HRV one.
function account(opts: { tagged?: number; control?: number; tag?: string } = {}) {
  const tag = opts.tag ?? "heavy";
  const sessionDays: string[] = [];
  for (let i = 0; i < 28; i++) sessionDays.push(addDays(DATE, -(29 - i))); // 2026-10-17 .. 2026-11-13
  const workouts: any[] = [];
  const journal: Record<string, JournalEntry> = {};
  const sleeps: any[] = [];
  const recoveries: any[] = [];
  let taggedLeft = opts.tagged ?? 14;
  let controlLeft = opts.control ?? 14;
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

test("tag effects: a clear gap over 14 tagged and 14 untagged nights is reported with n, the rule and no claim of cause", async () => {
  const a = account();
  const { client, calls } = fake(a);
  const res: any = await buildTagEffects(client, { date: DATE, days: 28 }, { loadJournal: async () => a.journal });
  assert.equal(res.date, DATE);
  assert.equal(res.thresholds.minTaggedNights, 8);
  assert.equal(res.thresholds.minUntaggedNights, 8);
  assert.match(res.thresholds.noiseBand, /half/);
  assert.equal(res.tags.length, 1);
  const t = res.tags[0];
  assert.equal(t.tag, "heavy");
  assert.equal(t.taggedNights, 14);
  assert.equal(t.untaggedNights, 14);
  assert.equal(t.verdict, "differs");
  assert.equal(t.metrics.hrv.verdict, "tagged-lower");
  assert.equal(t.metrics.hrv.nTagged, 14);
  assert.ok(t.metrics.hrv.medianDiff < -15 && t.metrics.hrv.medianDiff > -25, String(t.metrics.hrv.medianDiff));
  assert.ok(t.metrics.hrv.noiseHalfWidth > 0);
  assert.equal(t.metrics.recoveryMorning.verdict, "tagged-lower");
  assert.equal(t.metrics.sleepDurationS.verdict, "within-noise", "identical sleep durations: no difference at all");
  assert.equal(t.metrics.sleepDurationS.medianDiff, 0);
  assert.match(res.notes.join(" "), /not (a )?cause|association|does not show/i);
  // the window: nights of days from..date-1 (28), sessions on the days before them; the date's own night is not read
  assert.deepEqual(calls.find((c) => c.name === "sleep")!.args, [addDays(DATE, -29), addDays(DATE, -2)]);
  assert.deepEqual(calls.find((c) => c.name === "recovery")!.args, [addDays(DATE, -28), addDays(DATE, -1)]);
  const b = dayFetchBounds(addDays(DATE, -29), addDays(DATE, -2));
  assert.deepEqual([calls.find((c) => c.name === "workouts")!.args[0].since, calls.find((c) => c.name === "workouts")!.args[0].until], [b.from, b.to]);
});

test("tag effects: 7 tagged nights are insufficient, 8 are enough (the minimum, end to end)", async () => {
  for (const [n, verdict] of [[7, "insufficient"], [8, "differs"]] as const) {
    const a = account({ tagged: n });
    const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => a.journal });
    assert.equal(res.tags[0].taggedNights, n);
    assert.equal(res.tags[0].verdict, verdict, `${n} tagged nights`);
  }
  for (const [n, verdict] of [[7, "insufficient"], [8, "differs"]] as const) {
    const a = account({ control: n });
    const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => a.journal });
    assert.equal(res.tags[0].untaggedNights, n);
    assert.equal(res.tags[0].verdict, verdict, `${n} untagged nights`);
  }
});

test("tag effects: rest days are not controls; a session without a journal entry counts as untagged", async () => {
  const a = account({ control: 8 }); // 6 odd days are rest days: the nights after them belong to no group
  const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => a.journal });
  assert.equal(res.tags[0].untaggedNights, 8);
  assert.equal(res.sessionDays, 22);
  // sessions with no entry at all are the control group
  const none: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => ({ [keyOf(1)]: entry(keyOf(1), ["heavy"]) }) });
  assert.equal(none.tags[0].taggedNights, 1);
  assert.equal(none.tags[0].untaggedNights, 21);
});

test("tag effects: two sessions on one day make one night; a day is tagged when any session on it is", async () => {
  const a = account({ tagged: 14, control: 14 });
  // a second session on the first tagged day (untagged), and a second session on the first control day (tagged)
  a.workouts.push(workout(keyOf(101), a.sessionDays[0], "08:00"));
  a.workouts.push(workout(keyOf(102), a.sessionDays[1], "08:00"));
  const journal = { ...a.journal, [keyOf(102)]: entry(keyOf(102), ["heavy"]) };
  const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => journal });
  const t = res.tags[0];
  assert.equal(t.taggedSessions, 15);
  assert.equal(t.taggedNights, 15, "the first control day is now tagged, the first tagged day stays tagged: 14 + 1 nights, not 16");
  assert.equal(t.untaggedNights, 13);
  assert.equal(res.sessionDays, 28);
});

test("tag effects: tags are matched ignoring case; the first spelling is shown; a tag filter selects one", async () => {
  const a = account();
  const journal: Record<string, JournalEntry> = {};
  Object.entries(a.journal).forEach(([k, e], i) => (journal[k] = entry(k, [i % 2 ? "HEAVY" : "Heavy"])));
  const all: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => journal });
  assert.equal(all.tags.length, 1);
  assert.equal(all.tags[0].taggedNights, 14);
  const other = { ...journal, [keyOf(2)]: entry(keyOf(2), ["deload"]) };
  const two: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => other });
  assert.deepEqual(two.tags.map((t: any) => t.tag), ["Heavy", "deload"]);
  const only: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28, tag: "DELOAD" }, { loadJournal: async () => other });
  assert.deepEqual(only.tags.map((t: any) => t.tag), ["deload"]);
  assert.equal(only.tags[0].verdict, "insufficient");
  assert.equal(only.tags[0].taggedNights, 1);
});

test("tag effects: nights without data are counted per metric, not hidden; a failed section is listed and its metrics empty", async () => {
  const a = account();
  // the night after the first tagged day has no sleep; the night after the second has a sleep with no HRV
  a.sleeps = a.sleeps.filter((s: any) => !s.timestamp.startsWith(a.sessionDays[0]));
  const idx = a.sleeps.findIndex((s: any) => s.timestamp.startsWith(a.sessionDays[2]));
  delete a.sleeps[idx].entryData.AvgHRV;
  const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => a.journal });
  const m = res.tags[0].metrics;
  assert.equal(res.tags[0].taggedNights, 14);
  assert.equal(m.hrv.nTagged, 12);
  assert.equal(m.sleepScore.nTagged, 13);
  assert.equal(m.hrv.nControl, 14);
  const failed: any = await buildTagEffects(fake({ ...a, fail: ["sleep"] }).client, { date: DATE, days: 28 }, { loadJournal: async () => a.journal });
  assert.deepEqual(failed.errors.map((e: any) => e.section), ["sleep"]);
  assert.equal(failed.tags[0].metrics.hrv.nTagged, 0);
  assert.equal(failed.tags[0].metrics.hrv.verdict, "insufficient");
  assert.equal(failed.tags[0].metrics.recoveryMorning.nTagged, 0, "recovery on waking is read at the main sleep's end, which needs the sleep");
});

test("tag effects: no tagged session at all says how to tag; the journal's invalid entries are counted, an unreadable journal stops the call", async () => {
  const a = account();
  const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => ({ [keyOf(1)]: entry(keyOf(1)), bad: { nonsense: true } as any }) });
  assert.deepEqual(res.tags, []);
  assert.match(res.notes.join(" "), /log_session/);
  assert.equal(res.journal.ignored, 1);
  await assert.rejects(buildTagEffects(fake(a).client, { date: DATE, days: 28 }, { loadJournal: async () => { throw new Error("/x/journal.json is not valid JSON; fix or delete it"); } }), /not valid JSON/);
});

test("tag effects: arguments are validated", async () => {
  const { client } = fake({});
  const deps = { loadJournal: async () => ({}) };
  assert.equal(MIN_DAYS, 28);
  assert.equal(MAX_DAYS, 180);
  await assert.rejects(buildTagEffects(client, { date: "2026-02-30" }, deps), /not a valid calendar date/);
  for (const days of [27, 181, 28.5, NaN]) await assert.rejects(buildTagEffects(client, { date: DATE, days }, deps), /days must be an integer from 28 to 180/);
  await buildTagEffects(client, { date: DATE, days: 28 }, deps);
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
    const good = JSON.stringify({ version: 1, entries: a.journal });
    await writeFile(path, good);
    const res: any = await buildTagEffects(fake(a).client, { date: DATE, days: 28 });
    assert.equal(res.tags[0].taggedNights, 14);
    for (const [body, why] of [["{ not json", /not valid JSON/], [JSON.stringify({ version: 2, entries: {} }), /version 1 only/], [JSON.stringify([1]), /not a suunto-mcp journal/]] as const) {
      await writeFile(path, body);
      await assert.rejects(buildTagEffects(fake(a).client, { date: DATE, days: 28 }), why);
      assert.equal(await readFile(path, "utf8"), body);
    }
  } finally {
    if (saved === undefined) delete process.env.SUUNTO_JOURNAL_PATH;
    else process.env.SUUNTO_JOURNAL_PATH = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
