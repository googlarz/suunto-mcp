import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTokens } from "./storage.js";
import {
  SuuntoClient,
  dayFetchBounds,
  nightFetchBounds,
  rowDate,
  nightOf,
  selectDays,
  selectNights,
  workoutDate,
  localDate,
} from "./api.js";

const H = 3_600_000;
const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) => Date.UTC(y, m - 1, d, h, min, s, ms);

// Local-time ISO string with a UTC offset, as Suunto stamps rows.
function stamp(instantMs: number, offsetMin: number): string {
  const local = new Date(instantMs + offsetMin * 60_000).toISOString().slice(0, 23);
  const a = Math.abs(offsetMin);
  return `${local}${offsetMin < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const row = (ts: string, entryData: Record<string, unknown> = {}) => ({ timestamp: ts, entryData });

// ---------- fetch windows ----------

test("dayFetchBounds: UTC midnight minus 14 h through the next UTC midnight plus 14 h", () => {
  const b = dayFetchBounds("2026-09-27", "2026-09-27");
  assert.equal(b.from, utc(2026, 9, 26, 10));
  assert.equal(b.to, utc(2026, 9, 28, 14) - 1);
  assert.equal(dayFetchBounds("2026-09-01", "2026-09-03").to, utc(2026, 9, 4, 14) - 1);
});

test("nightFetchBounds: reaches two UTC midnights past the last date", () => {
  const b = nightFetchBounds("2026-09-27", "2026-09-27");
  assert.equal(b.from, utc(2026, 9, 26, 10));
  assert.equal(b.to, utc(2026, 9, 29) - 1);
});

test("fetch windows cover every row the date labelling can select, for every real UTC offset", () => {
  // Offsets from -12:00 to +14:00 in 15-minute steps.
  for (let offsetMin = -12 * 60; offsetMin <= 14 * 60; offsetMin += 15) {
    // Local clock times on 2026-09-27 (day) and from noon 09-27 to noon 09-28 (night), every 30 min.
    for (let localMin = 0; localMin < 24 * 60; localMin += 30) {
      const instantMs = utc(2026, 9, 27) + localMin * 60_000 - offsetMin * 60_000;
      const ts = stamp(instantMs, offsetMin);
      assert.equal(rowDate(row(ts)), "2026-09-27", ts);
      const day = dayFetchBounds("2026-09-27", "2026-09-27");
      assert.ok(instantMs >= day.from && instantMs <= day.to, `day row ${ts} outside the fetch window`);
    }
    for (let localMin = 12 * 60; localMin < 36 * 60; localMin += 30) {
      const instantMs = utc(2026, 9, 27) + localMin * 60_000 - offsetMin * 60_000;
      const ts = stamp(instantMs, offsetMin);
      assert.equal(nightOf(row(ts)), "2026-09-27", ts);
      const night = nightFetchBounds("2026-09-27", "2026-09-27");
      assert.ok(instantMs >= night.from && instantMs <= night.to, `night row ${ts} outside the fetch window`);
    }
  }
});

// ---------- labelling ----------

test("rowDate: the row's own local date; anything unparseable has none", () => {
  assert.equal(rowDate(row("2026-09-27T00:00:00.000+02:00")), "2026-09-27");
  assert.equal(rowDate(row("2026-09-26T23:59:59.999-08:00")), "2026-09-26");
  assert.equal(rowDate(row("")), "");
  assert.equal(rowDate(row("yesterday")), "");
  assert.equal(rowDate({}), "");
  assert.equal(rowDate(null), "");
});

test("nightOf: noon to noon, by BedtimeStart's own local clock", () => {
  const n = (bedtime: string) => nightOf({ timestamp: bedtime, entryData: { BedtimeStart: bedtime } });
  assert.equal(n("2026-09-27T23:00:00.000+02:00"), "2026-09-27", "usual bedtime");
  assert.equal(n("2026-09-28T00:30:00.000+02:00"), "2026-09-27", "just after midnight");
  assert.equal(n("2026-09-28T03:31:00.000+02:00"), "2026-09-27", "3 a.m. — used to be filed a night too late");
  assert.equal(n("2026-09-28T11:59:59.000+02:00"), "2026-09-27", "just before noon");
  assert.equal(n("2026-09-27T12:00:00.000+02:00"), "2026-09-27", "noon starts the night of that date");
  assert.equal(n("2026-09-27T11:59:59.000+02:00"), "2026-09-26", "just before noon belongs to the previous night");
  assert.equal(n("2026-09-28T12:00:00.000+02:00"), "2026-09-28");
  assert.equal(n("2027-01-01T03:00:00.000+01:00"), "2026-12-31", "year boundary");
  assert.equal(n("2026-03-01T05:00:00.000+01:00"), "2026-02-28", "month boundary");
});

test("nightOf: falls back to timestamp, and returns null when there is nothing to read", () => {
  assert.equal(nightOf({ timestamp: "2026-09-28T01:00:00.000+02:00" }), "2026-09-27");
  assert.equal(nightOf({ timestamp: "2026-09-28T01:00:00.000+02:00", entryData: { BedtimeStart: "2026-09-27T22:00:00.000+02:00" } }), "2026-09-27");
  assert.equal(nightOf({}), null);
  assert.equal(nightOf({ timestamp: "later" }), null);
  assert.equal(nightOf(null), null);
});

// ---------- recovery / activity ----------

test("selectDays: keeps the rows of the requested local dates and drops the margin's neighbours", () => {
  const rows = [
    row("2026-09-26T23:30:00.000+02:00"),
    row("2026-09-27T00:00:00.000+02:00"),
    row("2026-09-27T23:30:00.000+02:00"),
    row("2026-09-28T00:00:00.000+02:00"),
    row("garbage"),
  ];
  assert.deepEqual(selectDays(rows, "2026-09-27", "2026-09-27").map((r: any) => r.timestamp), ["2026-09-27T00:00:00.000+02:00", "2026-09-27T23:30:00.000+02:00"]);
  assert.equal(selectDays(rows, "2026-09-26", "2026-09-28").length, 4);
});

test("selectDays: a repeated row is kept once, and order is by instant, not by string", () => {
  const rows = [
    row("2026-09-27T10:00:00.000+02:00", { v: 1 }),
    row("2026-09-27T09:00:00.000+02:00", { v: 2 }),
    row("2026-09-27T10:00:00.000+02:00", { v: 1 }),
  ];
  assert.deepEqual(selectDays(rows, "2026-09-27", "2026-09-27").map((r: any) => r.entryData.v), [2, 1]);
});

test("selectDays: both response shapes, and anything else passes through", () => {
  const rows = [row("2026-09-27T09:00:00.000+02:00")];
  assert.equal(selectDays({ payload: rows, metadata: { m: 1 } }, "2026-09-27", "2026-09-27").payload.length, 1);
  assert.deepEqual(selectDays({ payload: rows, metadata: { m: 1 } }, "2026-09-27", "2026-09-27").metadata, { m: 1 });
  assert.deepEqual(selectDays([], "2026-09-27", "2026-09-27"), []);
  assert.equal(selectDays(null, "2026-09-27", "2026-09-27"), null);
  assert.deepEqual(selectDays({ note: "x" }, "2026-09-27", "2026-09-27"), { note: "x" });
});

test("DST fall-back 2026-10-25: the 25-hour day keeps all 50 half-hour rows in true order", () => {
  const rows = [];
  // 00:00 CEST on the 25th = 22:00Z on the 24th; the clock goes back at 01:00Z.
  for (let t = utc(2026, 10, 24, 22); t < utc(2026, 10, 25, 23); t += H / 2) rows.push(row(stamp(t, t < utc(2026, 10, 25, 1) ? 120 : 60)));
  // plus neighbours that must be excluded
  rows.push(row(stamp(utc(2026, 10, 24, 21, 30), 120)), row(stamp(utc(2026, 10, 25, 23), 60)));
  assert.equal(rows.length, 52);
  const out = selectDays([...rows].reverse(), "2026-10-25", "2026-10-25");
  assert.equal(out.length, 50);
  const instants = out.map((r: any) => Date.parse(r.timestamp));
  assert.deepEqual(instants, [...instants].sort((a, b) => a - b));
  assert.equal(new Set(instants).size, 50);
  // the repeated local hour: 02:30+02:00 comes BEFORE 02:10+01:00, though its string sorts after
  const iA = out.findIndex((r: any) => r.timestamp.startsWith("2026-10-25T02:30:00.000+02:00"));
  const iB = out.findIndex((r: any) => r.timestamp.startsWith("2026-10-25T02:10") || r.timestamp.startsWith("2026-10-25T02:00:00.000+01:00"));
  assert.ok(iA >= 0 && iB >= 0 && iA < iB, "repeated hour must be in real-time order");
});

test("DST spring-forward 2027-03-28: the 23-hour day keeps its 46 half-hour rows", () => {
  const rows = [];
  for (let t = utc(2027, 3, 27, 23); t < utc(2027, 3, 28, 22); t += H / 2) rows.push(row(stamp(t, t < utc(2027, 3, 28, 1) ? 60 : 120)));
  assert.equal(selectDays(rows, "2027-03-28", "2027-03-28").length, 46);
});

// ---------- sleep ----------

const sleep = (bedtime: string, sleepId: number | undefined, duration: number, extra: Record<string, unknown> = {}) =>
  row(bedtime, { SleepId: sleepId, Duration: duration, BedtimeStart: bedtime, ...extra });

test("selectNights: keeps the longest revision per SleepId, the later row on a tie", () => {
  const b = "2026-09-27T23:10:00.000+02:00";
  const rows = [sleep(b, 1, 100, { r: "a" }), sleep(b, 2, 50, { r: "b" }), sleep(b, 1, 300, { r: "c" }), sleep(b, 1, 200, { r: "d" }), sleep(b, 2, 50, { r: "e" })];
  assert.deepEqual(selectNights(rows, "2026-09-27", "2026-09-27").map((r: any) => r.entryData.r), ["c", "e"]);
});

test("selectNights: the night of D covers bedtimes from noon D to noon D+1, so a 03:00 bedtime is not lost", () => {
  const rows = [
    sleep("2026-09-27T08:00:00.000+02:00", 10, 5400, { IsNap: true }), // morning nap → the night before
    sleep("2026-09-27T21:21:00.000+02:00", 11, 32000),
    sleep("2026-09-28T03:31:00.000+02:00", 12, 17000), // after 02:00 — used to be filed under D+1
    sleep("2026-09-28T13:00:00.000+02:00", 13, 3600, { IsNap: true }), // afternoon nap → the next night
  ];
  const night27 = selectNights(rows, "2026-09-27", "2026-09-27").map((r: any) => r.entryData.SleepId);
  assert.deepEqual(night27, [11, 12]);
  assert.deepEqual(selectNights(rows, "2026-09-26", "2026-09-26").map((r: any) => r.entryData.SleepId), [10]);
  assert.deepEqual(selectNights(rows, "2026-09-28", "2026-09-28").map((r: any) => r.entryData.SleepId), [13]);
  // a range never drops or repeats a sleep
  assert.deepEqual(selectNights(rows, "2026-09-26", "2026-09-28").map((r: any) => r.entryData.SleepId), [10, 11, 12, 13]);
});

test("selectNights: IsNap never decides the night — the same bedtime files the same way whatever it says", () => {
  for (const isNap of [true, false]) {
    const rows = [sleep("2026-09-28T02:00:00.000+02:00", 20, isNap ? 3000 : 20000, { IsNap: isNap })];
    assert.equal(selectNights(rows, "2026-09-27", "2026-09-27").length, 1);
    assert.equal(selectNights(rows, "2026-09-28", "2026-09-28").length, 0);
  }
});

test("selectNights: rows without a SleepId are kept, unreadable rows dropped, order is by instant", () => {
  const rows = [
    sleep("2026-09-27T23:30:00.000+02:00", undefined, 10),
    sleep("2026-09-27T22:00:00.000+02:00", 7, 10),
    sleep("2026-09-27T22:00:00.000+02:00", 7, 20),
    row("nope", { SleepId: 9, Duration: 1 }),
  ];
  const out = selectNights(rows, "2026-09-27", "2026-09-27");
  assert.deepEqual(out.map((r: any) => [r.entryData.SleepId, r.entryData.Duration]), [[7, 20], [undefined, 10]]);
});

test("selectNights: both response shapes", () => {
  const rows = [sleep("2026-09-27T23:30:00.000+02:00", 1, 10), sleep("2026-09-27T23:30:00.000+02:00", 1, 20)];
  const wrapped = selectNights({ payload: rows, metadata: { m: 1 } }, "2026-09-27", "2026-09-27");
  assert.equal(wrapped.payload.length, 1);
  assert.deepEqual(wrapped.metadata, { m: 1 });
  assert.equal(selectNights(null, "2026-09-27", "2026-09-27"), null);
});

test("selectDays: a row whose timestamp cannot be read as an instant is dropped, so it can't scramble the order", () => {
  const rows = [row("2026-09-27T10:00:00.000+02:00"), row("2026-09-27T25:99:00.000+02:00"), row("2026-09-27T08:00:00.000+02:00")];
  const out = selectDays(rows, "2026-09-27", "2026-09-27");
  assert.deepEqual(out.map((r: any) => r.timestamp), ["2026-09-27T08:00:00.000+02:00", "2026-09-27T10:00:00.000+02:00"]);
});

test("selectNights: a sleep row with no timestamp is ordered by its BedtimeStart instead of breaking the sort", () => {
  const noTimestamp = { entryData: { SleepId: 5, Duration: 100, BedtimeStart: "2026-09-27T23:00:00.000+02:00" } };
  const out = selectNights([sleep("2026-09-27T23:30:00.000+02:00", 6, 100), noTimestamp, sleep("2026-09-27T22:00:00.000+02:00", 7, 100)], "2026-09-27", "2026-09-27");
  assert.deepEqual(out.map((r: any) => r.entryData.SleepId), [7, 5, 6]);
});

// ---------- workouts, local dates ----------

test("workoutDate: the workout's own local date from its UTC offset", () => {
  assert.equal(workoutDate({ startTime: utc(2026, 9, 28, 22, 30), timeOffsetInMinutes: 120 }), "2026-09-29");
  assert.equal(workoutDate({ startTime: utc(2026, 9, 28, 22, 30), timeOffsetInMinutes: 0 }), "2026-09-28");
  assert.equal(workoutDate({ startTime: utc(2026, 9, 28, 22, 30) }), "2026-09-28", "no offset → UTC");
  assert.equal(workoutDate({ startTime: utc(2026, 1, 1, 0, 30), timeOffsetInMinutes: -480 }), "2025-12-31");
  assert.equal(workoutDate({}), "");
});

test("workoutDate: never invents a date — unreadable input gives ''", () => {
  for (const startTime of [null, undefined, "", "  ", "soon", NaN, Infinity, 8.64e15 + 1, {}, [], true]) {
    assert.equal(workoutDate({ startTime, timeOffsetInMinutes: 120 }), "", JSON.stringify(startTime));
  }
  // a garbled offset falls back to UTC instead of throwing
  for (const off of ["x", NaN, {}, undefined, null]) assert.equal(workoutDate({ startTime: utc(2026, 9, 28, 22, 30), timeOffsetInMinutes: off }), "2026-09-28");
  assert.equal(workoutDate({ startTime: String(utc(2026, 9, 28, 22, 30)), timeOffsetInMinutes: 120 }), "2026-09-29", "a numeric string is accepted");
});

test("localDate: this machine's calendar date, only for today/yesterday defaults", () => {
  const justAfterMidnight = new Date(2026, 8, 29, 1, 43); // local components, whatever the host zone
  assert.equal(localDate(0, justAfterMidnight), "2026-09-29");
  assert.equal(localDate(1, justAfterMidnight), "2026-09-28");
  assert.equal(localDate(1, new Date(2026, 9, 1, 0, 5)), "2026-09-30", "month boundary");
  assert.equal(localDate(1, new Date(2027, 0, 1, 0, 5)), "2026-12-31", "year boundary");
});

test("bucketing never reads the host time zone", () => {
  const rows = [
    sleep("2026-09-27T21:21:00.000+02:00", 1, 100),
    sleep("2026-09-28T03:31:00.000+02:00", 2, 100),
    row("2026-09-27T00:00:00.000+02:00"),
    row("2026-09-28T00:00:00.000+02:00"),
  ];
  const run = () => JSON.stringify([selectNights(rows, "2026-09-27", "2026-09-27"), selectDays(rows, "2026-09-27", "2026-09-27"), nightOf(rows[1]), workoutDate({ startTime: utc(2026, 9, 28, 22, 30), timeOffsetInMinutes: 120 })]);
  const original = process.env.TZ;
  try {
    const results = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati"].map((tz) => {
      process.env.TZ = tz;
      return run();
    });
    assert.equal(new Set(results).size, 1);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// ---------- through the client, with fetch stubbed ----------
const origFetch = globalThis.fetch;
let tmp: string;
let cfg: any;
let requests: URL[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "suunto-days-"));
  const tokenPath = join(tmp, "tokens.json");
  await saveTokens(tokenPath, { accessToken: "t", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
  cfg = { clientId: "cid", clientSecret: "sec", subscriptionKey: "key", redirectUri: "x", tokenPath };
  requests = [];
});
afterEach(async () => {
  globalThis.fetch = origFetch;
  await rm(tmp, { recursive: true });
});
function stub(body: unknown) {
  globalThis.fetch = (async (url: any) => {
    requests.push(new URL(String(url)));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
}
const window = (u: URL) => [Number(u.searchParams.get("from")), Number(u.searchParams.get("to"))];

test("client: asks the API for the wide window and returns only the requested days", async () => {
  stub([
    row("2026-09-26T23:30:00.000+02:00", { Balance: 0.1 }),
    row("2026-09-27T00:00:00.000+02:00", { Balance: 0.5 }),
    row("2026-09-27T23:30:00.000+02:00", { Balance: 0.6 }),
    row("2026-09-28T00:00:00.000+02:00", { Balance: 0.9 }),
  ]);
  const c = new SuuntoClient(cfg);
  const got = await c.getRecovery("2026-09-27");
  assert.deepEqual(got.map((r: any) => r.entryData.Balance), [0.5, 0.6]);
  assert.equal(requests[0].pathname, "/247samples/recovery");
  assert.deepEqual(window(requests[0]), [utc(2026, 9, 26, 10), utc(2026, 9, 28, 14) - 1]);
  assert.equal((await c.getDailyActivity("2026-09-27")).length, 2);
  assert.equal(requests[1].pathname, "/247samples/activity");
  assert.deepEqual(window(requests[1]), [utc(2026, 9, 26, 10), utc(2026, 9, 28, 14) - 1]);
  assert.equal((await c.listDailyActivity("2026-09-26", "2026-09-28")).length, 4);
  assert.deepEqual(window(requests[2]), [utc(2026, 9, 25, 10), utc(2026, 9, 29, 14) - 1]);
  assert.equal((await c.listRecovery("2026-09-26", "2026-09-28")).length, 4);
  assert.deepEqual(window(requests[3]), [utc(2026, 9, 25, 10), utc(2026, 9, 29, 14) - 1]);
});

test("client: getSleep and listSleep return one row per sleep of the requested nights", async () => {
  stub([
    sleep("2026-09-27T23:10:00.000+02:00", 2, 100),
    sleep("2026-09-26T23:00:00.000+02:00", 1, 20000),
    sleep("2026-09-27T23:10:00.000+02:00", 2, 28000),
    sleep("2026-09-26T23:00:00.000+02:00", 1, 25000),
    sleep("2026-09-29T23:00:00.000+02:00", 3, 25000),
  ]);
  const c = new SuuntoClient(cfg);
  const one = await c.getSleep("2026-09-27");
  assert.deepEqual(one.map((r: any) => r.entryData.Duration), [28000]);
  assert.equal(requests[0].pathname, "/247samples/sleep");
  assert.deepEqual(window(requests[0]), [utc(2026, 9, 26, 10), utc(2026, 9, 29) - 1]);
  const list = await c.listSleep("2026-09-26", "2026-09-27");
  assert.deepEqual(list.map((r: any) => [r.entryData.SleepId, r.entryData.Duration]), [[1, 25000], [2, 28000]]);
});
