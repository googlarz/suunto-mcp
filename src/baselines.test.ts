import { test } from "node:test";
import assert from "node:assert/strict";
import { bandOf, buildBaselines, quantile } from "./baselines.js";

const id = (n: number) => n;

test("quantile: linear interpolation between order statistics, odd and even n", () => {
  // n=7, h=(n-1)p: p25 -> 1.5, p50 -> 3, p75 -> 4.5
  const odd = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual([0.25, 0.5, 0.75].map((p) => quantile(odd, p)), [2.5, 4, 5.5]);
  // n=8: p25 -> h=1.75 -> 2 + 0.75 = 2.75; p50 -> h=3.5 -> 4.5; p75 -> h=5.25 -> 6 + 0.25 = 6.25
  const even = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual([0.25, 0.5, 0.75].map((p) => quantile(even, p)), [2.75, 4.5, 6.25]);
  assert.equal(quantile([5], 0.75), 5);
  assert.equal(quantile([10, 20], 0.5), 15);
});

test("bandOf: n below 7 gives no band at all, only n and latest", () => {
  const b = bandOf([10, null, 20, 30, null, 40, 50, 60], 25, id); // 6 values
  assert.deepEqual(b, { n: 6, median: null, p25: null, p75: null, last7Median: 40, latest: 25, latestVsBand: null });
});

test("bandOf: exactly 7 values is enough for a band", () => {
  const b = bandOf([1, 2, 3, 4, 5, 6, 7], 4, id);
  assert.deepEqual([b.n, b.median, b.p25, b.p75, b.latestVsBand], [7, 4, 2.5, 5.5, "within"]);
});

test("bandOf: a missing day is not a zero (a 0 would drag p25 down)", () => {
  // 14 days, 7 with a value 10..70, 7 missing; counting the gaps as 0 would give median 0.
  const window = [10, null, 20, null, 30, null, 40, null, 50, null, 60, null, 70, null];
  const b = bandOf(window, null, id);
  assert.deepEqual([b.n, b.median, b.p25, b.p75], [7, 40, 25, 55]);
});

test("bandOf: last7Median looks only at the last 7 days and needs 4 values there", () => {
  const early = [100, 100, 100, 100, 100, 100, 100];
  // last 7: 1, null, 2, null, 3, null, 4 -> 4 values -> median (2 + 3) / 2
  assert.equal(bandOf([...early, 1, null, 2, null, 3, null, 4], null, id).last7Median, 2.5);
  // last 7: 1, null, 2, null, 3, null, null -> 3 values -> null
  assert.equal(bandOf([...early, 1, null, 2, null, 3, null, null], null, id).last7Median, null);
  // 5 values in the last 7: odd count, the middle one
  assert.equal(bandOf([...early, 9, 8, null, 7, 6, 5, null], null, id).last7Median, 7);
});

test("bandOf: latestVsBand at the band edges (inclusive) and just outside", () => {
  const w = [1, 2, 3, 4, 5, 6, 7]; // p25 = 2.5, p75 = 5.5
  const at = (latest: number) => bandOf(w, latest, id).latestVsBand;
  assert.deepEqual([at(2.4), at(2.5), at(4), at(5.5), at(5.6)], ["below", "within", "within", "within", "above"]);
  assert.equal(bandOf(w, null, id).latestVsBand, null);
  assert.equal(bandOf(w, 0, id).latestVsBand, "below", "a real 0 is a value");
});

test("bandOf: rounding applies to the output, the comparison uses the exact band", () => {
  const w = [1, 2, 3, 4, 5, 6, 7, 8]; // p25 = 2.75 (shown 2.8), p75 = 6.25 (shown 6.3)
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const b = bandOf(w, 2.76, round1);
  assert.deepEqual([b.p25, b.p75, b.median, b.latest, b.latestVsBand], [2.8, 6.3, 4.5, 2.8, "within"]);
  assert.equal(bandOf(w, 2.74, round1).latestVsBand, "below", "2.74 is below the exact 2.75 although it rounds to 2.7");
});

// ---------- buildBaselines ----------

// date 2026-11-02, days 14: window 2026-10-19 (i=0) .. 2026-11-01 (i=13), crossing a month boundary.
const DATE = "2026-11-02";
const FROM = "2026-10-19";
const dayAt = (i: number) => new Date(Date.UTC(2026, 9, 19 + i)).toISOString().slice(0, 10);
const prev = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) - 1)).toISOString().slice(0, 10);

let sleepId = 0;
// The sleep that led INTO `day`: bedtime the evening before (or just after midnight), wake at 06:30 on `day`.
const night = (day: string, duration: number, score: number, hrv: number, bedtimeTime = "23:00") => {
  const bedtime = bedtimeTime < "12:00" ? `${day}T${bedtimeTime}:00.000+01:00` : `${prev(day)}T${bedtimeTime}:00.000+01:00`;
  return { timestamp: bedtime, entryData: { SleepId: ++sleepId, BedtimeStart: bedtime, BedtimeEnd: `${day}T06:30:00.000+01:00`, Duration: duration, IsNap: duration < 10800, SleepQualityScore: score, AvgHRV: hrv } };
};

// Days i = 0..13 plus the judged date (i = 14). Day i = 3 only has a 1 h nap. Day i = 13 (2026-11-01)
// is a night that started at 00:30 on 11-01, i.e. filed under 10-31 (month boundary).
function sleepRows() {
  const rows: any[] = [];
  for (let i = 0; i <= 13; i++) {
    if (i === 3) rows.push(night(dayAt(i), 3600, 99, 99));
    else rows.push(night(dayAt(i), 25000 + 100 * i, 60 + i, 40 + i, i === 13 ? "00:30" : "23:00"));
  }
  rows.push(night(DATE, 24000, 50, 41)); // the judged date: bedtime 11-01 23:00
  return rows;
}

const rec = (day: string, hhmm: string, balance: number) => ({ timestamp: `${day}T${hhmm}:00.000+01:00`, entryData: { Balance: balance, StressState: 1 } });
function recoveryRows() {
  const rows: any[] = [];
  for (let i = 0; i <= 14; i++) {
    const day = i === 14 ? DATE : dayAt(i);
    rows.push(rec(day, "03:00", i === 14 ? 0.1 : 0.2 + 0.04 * i), rec(day, "06:30", i === 14 ? 0.55 : 0.6 + 0.01 * i), rec(day, "12:00", 0.95));
  }
  return rows;
}

// Steps on even i only (1000 * (i + 1)), plus a value on the judged date.
function statsRows() {
  const samples = [];
  for (let i = 0; i <= 14; i += 2) samples.push({ TimeISO8601: `${i === 14 ? DATE : dayAt(i)}T12:00:00+01:00`, Value: i === 14 ? 5000 : 1000 * (i + 1) });
  return [{ Name: "stepcount", Sources: [{ Samples: samples }] }];
}

const client = (over: Record<string, unknown> = {}, calls: string[] = []) =>
  ({
    listSleep: async (a: string, b: string) => (calls.push(`sleep ${a}..${b}`), sleepRows()),
    listRecovery: async (a: string, b: string) => (calls.push(`recovery ${a}..${b}`), recoveryRows()),
    getDailyStats: async (a: string, b: string) => (calls.push(`stats ${a}..${b}`), statsRows()),
    ...over,
  }) as any;

test("buildBaselines: one request per section over the whole span; the night maps to the day it led into", async () => {
  const calls: string[] = [];
  const out = await buildBaselines(client({}, calls), { date: DATE, days: 14 });
  assert.deepEqual(calls.sort(), ["recovery 2026-10-19..2026-11-02", "sleep 2026-10-18..2026-11-01", "stats 2026-10-19T00:00:00..2026-11-02T23:59:59"]);
  assert.deepEqual([out.date, out.from, out.to, out.days], [DATE, FROM, "2026-11-01", 14]);
  assert.deepEqual(out.errors, []);

  // hrv = 40 + i on 13 days (i = 3 is a nap, so no value): sorted 40 41 42 44 .. 53, n = 13.
  // p25 = x[3] = 44, median = x[6] = 47, p75 = x[9] = 50; last 7 days i = 7..13 -> 47..53, median 50.
  assert.deepEqual(out.metrics.hrv, { n: 13, median: 47, p25: 44, p75: 50, last7Median: 50, latest: 41, latestVsBand: "below" });
  // duration = 25000 + 100 i: same positions -> i = 4, 7, 10; last 7 median i = 10.
  assert.deepEqual(out.metrics.sleepDurationS, { n: 13, median: 25700, p25: 25400, p75: 26000, last7Median: 26000, latest: 24000, latestVsBand: "below" });
  // score = 60 + i
  assert.deepEqual(out.metrics.sleepScore, { n: 13, median: 67, p25: 64, p75: 70, last7Median: 70, latest: 50, latestVsBand: "below" });
});

test("buildBaselines: recoveryMorning needs a main sleep; recoveryLow and steps never have a latest", async () => {
  const out = await buildBaselines(client(), { date: DATE, days: 14 });
  // morning Balance 0.60 + 0.01 i at 06:30, only on the 13 days with a main sleep: i = 4, 7, 10 -> 0.64, 0.67, 0.70
  assert.deepEqual(out.metrics.recoveryMorning, { n: 13, median: 0.67, p25: 0.64, p75: 0.7, last7Median: 0.7, latest: 0.55, latestVsBand: "below" });
  // lowest Balance of the day 0.20 + 0.04 i for i = 0..13 (n = 14): median h = 6.5 -> (0.44 + 0.48) / 2 = 0.46,
  // p25 h = 3.25 -> 0.32 + 0.25 * 0.04 = 0.33, p75 h = 9.75 -> 0.56 + 0.75 * 0.04 = 0.59; last 7 days i = 7..13, middle i = 10 -> 0.60
  const low = out.metrics.recoveryLow;
  assert.deepEqual([low.n, low.median, low.p25, low.p75, low.last7Median], [14, 0.46, 0.33, 0.59, 0.6]);
  assert.deepEqual([low.latest, low.latestVsBand], [null, null], "the judged day is still running");
  // steps on even i: 1000, 3000, ..., 13000 (n = 7): median 7000, p25 h=1.5 -> 4000, p75 h=4.5 -> 10000;
  // only i = 8, 10, 12 are in the last 7 days -> 3 values -> no last7Median. The 5000 on the judged date is not used.
  assert.deepEqual(out.metrics.steps, { n: 7, median: 7000, p25: 4000, p75: 10000, last7Median: null, latest: null, latestVsBand: null });
});

test("buildBaselines: fewer than 7 days of data leaves the band null and says so", async () => {
  const few = sleepRows().slice(0, 5);
  const out = await buildBaselines(client({ listSleep: async () => few }), { date: DATE, days: 14 });
  assert.deepEqual([out.metrics.hrv.n, out.metrics.hrv.median, out.metrics.hrv.p25, out.metrics.hrv.p75, out.metrics.hrv.latestVsBand], [4, null, null, null, null]);
  assert.ok(out.notes.some((n) => /^hrv: only 4 of 14 days/.test(n)));
});

test("buildBaselines: a failing section empties its metrics and is listed; the others are unaffected", async () => {
  const out = await buildBaselines(client({ listRecovery: async () => { throw new Error("403 Forbidden"); } }), { date: DATE, days: 14 });
  assert.deepEqual(out.errors, [{ section: "recovery", error: "403 Forbidden" }]);
  for (const m of ["recoveryMorning", "recoveryLow"]) {
    assert.deepEqual(out.metrics[m], { n: 0, median: null, p25: null, p75: null, last7Median: null, latest: null, latestVsBand: null }, m);
  }
  assert.equal(out.metrics.hrv.n, 13);
  assert.equal(out.metrics.steps.n, 7);
  assert.ok(!out.notes.some((n) => /^recovery/.test(n)), "the error explains it; no too-little-data note");

  const noSleep = await buildBaselines(client({ listSleep: async () => { throw new Error("boom"); } }), { date: DATE, days: 14 });
  assert.deepEqual(noSleep.errors.map((e) => e.section), ["sleep"]);
  assert.equal(noSleep.metrics.hrv.n, 0);
  assert.equal(noSleep.metrics.recoveryMorning.n, 0, "the waking value needs the main sleep");
  assert.equal(noSleep.metrics.recoveryLow.n, 14);
});

test("buildBaselines: the notes carry the required caveats", async () => {
  const text = (await buildBaselines(client(), { date: DATE, days: 14 })).notes.join("\n");
  assert.match(text, /middle half of the user's own last 14 days/);
  assert.match(text, /not a medical reference/);
  assert.match(text, /shorter than about 3 h .* nap/);
  assert.match(text, /Balance x100 equals the watch's Resources %/);
});

test("buildBaselines: days defaults to 28; days and date are validated before any request", async () => {
  const calls: string[] = [];
  const out = await buildBaselines(client({}, calls), { date: "2026-11-13" });
  assert.deepEqual([out.days, out.from, out.to], [28, "2026-10-16", "2026-11-12"]);
  const asked = calls.length;
  for (const days of [13, 91, 28.5, 0, -1, NaN]) await assert.rejects(buildBaselines(client({}, calls), { date: DATE, days }), /days must be an integer from 14 to 90/, String(days));
  for (const date of ["2026-02-30", "2026-1-5", "garbage"]) await assert.rejects(buildBaselines(client({}, calls), { date }), /not a valid calendar date/, date);
  assert.equal(calls.length, asked);
  assert.equal((await buildBaselines(client(), { date: DATE, days: 90 })).from, "2026-08-04");
  assert.equal((await buildBaselines(client(), { date: DATE, days: 14 })).from, FROM);
});
