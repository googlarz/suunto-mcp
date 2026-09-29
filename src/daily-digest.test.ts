import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SuuntoApiError, SuuntoAuthError, SuuntoEmptyResponseError, SuuntoNotFoundError, SuuntoRateLimitError } from "./errors.js";
import {
  emptyAverages,
  saveAverages,
  degradesToNoData,
  parseSleepEntries,
  pickMainSleep,
  rollCtlAtl,
  updateBaseline,
  pruneHistory,
  stepsColor,
  sleepHoursColor,
  sleepScoreColor,
  recoveryMorningColor,
  recoveryPeakColor,
  tsbColor,
  tsbLabel,
  rampRateColor,
  rampRateLabel,
  hrvColor,
  hrvLabel,
  hrvDisplayRange,
  soWhat,
  generateDigest,
} from "./daily-digest.js";

test("parseSleepEntries: dedupes repeated SleepId, keeps longest Duration", () => {
  const raw = [
    { entryData: { SleepId: 1, IsNap: false, Duration: 6900 } },
    { entryData: { SleepId: 1, IsNap: false, Duration: 6900 } }, // exact duplicate
    { entryData: { SleepId: 1, IsNap: false, Duration: 13980 } }, // revised, longer
    { entryData: { SleepId: 2, IsNap: true, Duration: 1800 } },
  ];
  const entries = parseSleepEntries(raw);
  assert.equal(entries.length, 2);
  const main = entries.find((e) => e.sleepId === 1);
  assert.equal(main?.duration, 13980);
});

test("parseSleepEntries: ignores rows without a SleepId", () => {
  const entries = parseSleepEntries([{ entryData: {} }, { entryData: null }, {}]);
  assert.equal(entries.length, 0);
});

test("pickMainSleep: excludes naps, keeps longest non-nap", () => {
  const entries = parseSleepEntries([
    { entryData: { SleepId: 1, IsNap: true, Duration: 6900 } },
    { entryData: { SleepId: 2, IsNap: false, Duration: 17460 } },
    { entryData: { SleepId: 3, IsNap: false, Duration: 29580 } },
  ]);
  const main = pickMainSleep(entries);
  assert.equal(main?.sleepId, 3);
  assert.equal(main?.duration, 29580);
});

test("pickMainSleep: null when only naps exist", () => {
  const entries = parseSleepEntries([{ entryData: { SleepId: 1, IsNap: true, Duration: 1800 } }]);
  assert.equal(pickMainSleep(entries), null);
});

test("rollCtlAtl: zero TSS decays both toward zero", () => {
  const { ctl, atl } = rollCtlAtl(50, 50, 0);
  assert.ok(ctl < 50 && ctl > 48.5, `ctl=${ctl}`);
  assert.ok(atl < 50 && atl > 43, `atl=${atl}`);
});

test("rollCtlAtl: ATL reacts faster than CTL to a big TSS day", () => {
  const { ctl, atl } = rollCtlAtl(30, 30, 150);
  const ctlMove = ctl - 30;
  const atlMove = atl - 30;
  assert.ok(atlMove > ctlMove, `atl moved ${atlMove}, ctl moved ${ctlMove} — ATL should react faster`);
});

test("updateBaseline: incremental mean matches a plain average", () => {
  let b = { avg: 0, n: 0 };
  for (const v of [10, 20, 30]) b = updateBaseline(b, v);
  assert.equal(b.n, 3);
  assert.equal(b.avg, 20);
});

test("pruneHistory: keeps only the most recent N dates", () => {
  const history = { "2026-01-01": 1, "2026-01-02": 2, "2026-01-03": 3, "2026-01-04": 4 };
  const pruned = pruneHistory(history, 2);
  assert.deepEqual(Object.keys(pruned).sort(), ["2026-01-03", "2026-01-04"]);
});

test("color thresholds: boundaries match the spec table", () => {
  assert.equal(stepsColor(12000), "🟢");
  assert.equal(stepsColor(11999), "🟡");
  assert.equal(stepsColor(4000), "🟠");
  assert.equal(stepsColor(3999), "🔴");

  assert.equal(sleepHoursColor(7), "🟢");
  assert.equal(sleepHoursColor(6.99), "🟡");

  assert.equal(sleepScoreColor(75), "🟢");
  assert.equal(sleepScoreColor(44), "🔴");

  assert.equal(recoveryMorningColor(80), "🟢");
  assert.equal(recoveryMorningColor(65), "🟡");
  assert.equal(recoveryMorningColor(49), "🔴");

  assert.equal(recoveryPeakColor(90), "🟢");
  assert.equal(recoveryPeakColor(75), "🟡");
  assert.equal(recoveryPeakColor(74), "🟠");
  assert.notEqual(recoveryPeakColor(10), "🔴"); // no red band for peak

  assert.equal(tsbColor(11), "🔵");
  assert.equal(tsbColor(0), "🟢");
  assert.equal(tsbColor(-1), "🟡");
  assert.equal(tsbColor(-10), "🟡");
  assert.equal(tsbColor(-11), "🔴");
  assert.equal(tsbLabel(11), "Optimal");
  assert.equal(tsbLabel(0), "Balanced");
  assert.equal(tsbLabel(-5), "Compromised");
  assert.equal(tsbLabel(-11), "Strained");

  assert.equal(rampRateColor(9), "🔴");
  assert.equal(rampRateLabel(9), "Overreaching — injury risk");
  assert.equal(rampRateColor(5), "🟢");
  assert.equal(rampRateLabel(5), "Building well");
  assert.equal(rampRateColor(0), "🟡");
  assert.equal(rampRateLabel(0), "Holding fitness");
  assert.equal(rampRateColor(-5), "🟠");
  assert.equal(rampRateLabel(-5), "Losing fitness");

  assert.equal(hrvColor(30), "🟢");
  assert.equal(hrvColor(22), "🟡");
  assert.equal(hrvColor(10), "🟠");
  assert.equal(hrvLabel(10), "Recovery");
  assert.equal(hrvLabel(30), "");
});

test("soWhat: good recovery + fresh form -> train verdict", () => {
  const msg = soWhat({
    tsb: 1.8,
    recoveryMorningPct: 84,
    hrv: 22,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
    rampRate: -4.9,
    isPartyNight: false,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /Good day to train/);
  assert.match(msg, /CTL declining/);
});

test("soWhat: poor recovery + Strained TSB (below -10) -> rest verdict", () => {
  const msg = soWhat({
    tsb: -12,
    recoveryMorningPct: 40,
    hrv: 30,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
    rampRate: 1,
    isPartyNight: false,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /Clear fatigue/);
});

test("soWhat: Compromised TSB + poor recovery -> explicit rest day", () => {
  const msg = soWhat({
    tsb: -8,
    recoveryMorningPct: 40,
    hrv: 30,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
    rampRate: 1,
    isPartyNight: false,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /Rest day/);
});

test("soWhat: null rampRate (not enough history) doesn't crash or trigger the declining-CTL note", () => {
  const msg = soWhat({
    tsb: 2,
    recoveryMorningPct: 85,
    hrv: 30,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
    rampRate: null,
    isPartyNight: false,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /Good day to train/);
  assert.doesNotMatch(msg, /CTL declining/);
});

test("soWhat: party night flag surfaces even with a neutral verdict", () => {
  const msg = soWhat({
    tsb: -2,
    recoveryMorningPct: 70,
    hrv: null,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
    rampRate: 0,
    isPartyNight: true,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /Post-party baseline/);
});

test("soWhat: 2+ day well-below HRV streak triggers a BP-check note", () => {
  const msg = soWhat({
    tsb: 5,
    recoveryMorningPct: 80,
    hrv: 18,
    hrvWellBelowStreak: 2,
    recoveryMorningBelowStreak: 0,
    rampRate: 0,
    isPartyNight: false,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /Check blood pressure/);
});

test("soWhat: 2+ day low-morning-recovery streak also triggers the BP-check note", () => {
  const msg = soWhat({
    tsb: 5,
    recoveryMorningPct: 60,
    hrv: 30,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 2,
    rampRate: 0,
    isPartyNight: false,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /Check blood pressure/);
});

test("soWhat: ramp rate over +8/week flags overreaching injury risk", () => {
  const msg = soWhat({
    tsb: 5,
    recoveryMorningPct: 80,
    hrv: 30,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
    rampRate: 9,
    isPartyNight: false,
    hadWorkout: true,
    projectedTomorrowCtl: null,
  });
  assert.match(msg, /injury risk/);
});

test("soWhat: no workout + declining ramp projects tomorrow's CTL", () => {
  const msg = soWhat({
    tsb: 2,
    recoveryMorningPct: 80,
    hrv: 30,
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
    rampRate: -3,
    isPartyNight: false,
    hadWorkout: false,
    projectedTomorrowCtl: 41.2,
  });
  assert.match(msg, /drops to ~41\.2 tomorrow/);
});

test("hrvDisplayRange: falls back to the generic range with under 14 days of history", () => {
  const range = hrvDisplayRange({ avg: 40, n: 5 });
  assert.equal(range.personalized, false);
  assert.equal(range.low, 26);
  assert.equal(range.high, 34);
});

test("hrvDisplayRange: uses the personal baseline once there's enough history", () => {
  const range = hrvDisplayRange({ avg: 40, n: 14 });
  assert.equal(range.personalized, true);
  assert.equal(range.low, 36);
  assert.equal(range.high, 44);
});

// ---------- generateDigest orchestration ----------

function fakeSuunto(overrides: Partial<{ stats: any; sleep: any; recovery: any; workouts: any }> = {}) {
  return {
    getDailyStats: async () => overrides.stats ?? [],
    getSleep: async () => overrides.sleep ?? [],
    getRecovery: async () => overrides.recovery ?? [],
    listWorkouts: async () => overrides.workouts ?? { payload: [] },
  } as any;
}

async function withTempDigestPaths(fn: (paths: { averagesPath: string; historyPath: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "suunto-digest-"));
  try {
    await fn({ averagesPath: join(dir, "averages.json"), historyPath: join(dir, "history.md") });
  } finally {
    await rm(dir, { recursive: true });
  }
}

test("generateDigest: refuses to re-run an already-processed date (would corrupt CTL/ATL)", async () => {
  await withTempDigestPaths(async (paths) => {
    const suunto = fakeSuunto({ workouts: { payload: [{ tss: { trainingStressScore: 100 } }] } });
    await generateDigest({ suunto, ...paths, date: "2026-01-01" });
    await assert.rejects(
      () => generateDigest({ suunto, ...paths, date: "2026-01-01" }),
      /already processed/,
    );
    await assert.rejects(
      () => generateDigest({ suunto, ...paths, date: "2025-12-31" }),
      /already processed/,
    );
  });
});

test("generateDigest: rejects a non-finite seedCtl/seedAtl instead of writing Infinity (-> null) into the sidecar", async () => {
  await withTempDigestPaths(async (paths) => {
    const suunto = fakeSuunto();
    await assert.rejects(
      () => generateDigest({ suunto, ...paths, date: "2026-01-01", seedCtl: Infinity }),
      /seedCtl must be a finite number/,
    );
    await assert.rejects(
      () => generateDigest({ suunto, ...paths, date: "2026-01-01", seedAtl: -Infinity }),
      /seedAtl must be a finite number/,
    );
  });
});

test("generateDigest: a missing optional subscription (403/404/plain 401) degrades to 'no data' instead of failing the whole digest", async () => {
  await withTempDigestPaths(async (paths) => {
    const suunto = {
      getDailyStats: async () => {
        throw new SuuntoApiError(403, "/247/daily-activity-statistics", "Forbidden");
      },
      getSleep: async () => {
        throw new SuuntoNotFoundError("/247samples/sleep", "not found");
      },
      getRecovery: async () => {
        throw new SuuntoAuthError("/247samples/recovery", "Access denied (SubscriptionKeyInvalid)");
      },
      listWorkouts: async () => ({ payload: [] }),
    } as any;
    const result = await generateDigest({ suunto, ...paths, date: "2026-01-01" });
    assert.match(result.markdown, /No sleep data for this date\./);
    assert.match(result.markdown, /No recovery data for this date\./);
    assert.match(result.markdown, /No HRV data for this date\./);
  });
});

test("degradesToNoData: only a missing-subscription failure may become 'no data'", () => {
  assert.equal(degradesToNoData(new SuuntoApiError(403, "/x", "")), true);
  assert.equal(degradesToNoData(new SuuntoNotFoundError("/x", "")), true);
  assert.equal(degradesToNoData(new SuuntoAuthError("/x", "Access denied")), true);
  // Suunto's gateway reports a rate limit and a removed route as HTTP 401:
  assert.equal(degradesToNoData(new SuuntoAuthError("/x", '{"code":"RateLimitExceeded"}')), false);
  assert.equal(degradesToNoData(new SuuntoAuthError("/x", "... (OperationNotFound)")), false);
  assert.equal(degradesToNoData(new SuuntoRateLimitError("/x", "slow down", 5)), false);
  // an empty 200 from a subscribed endpoint is a malformed answer, not a missing product
  assert.equal(degradesToNoData(new SuuntoEmptyResponseError("/x")), false);
  assert.equal(degradesToNoData(new SuuntoApiError(503, "/x", "unavailable")), false);
  assert.equal(degradesToNoData(new Error("network down")), false);
});

// Each of these used to be swallowed as "no data": the digest then wrote
// {avg:0, n:1} into the steps baseline, reset the streaks, saved it, and the
// forward-only guard refused a re-run — wrong data locked in permanently.
for (const method of ["getDailyStats", "getSleep", "getRecovery"] as const) {
  for (const [label, err] of [
    ["a 503", new SuuntoApiError(503, "/247samples/x", "unavailable")],
    ["a 429 rate limit", new SuuntoRateLimitError("/247samples/x", "slow down", 5)],
    ["a 401 RateLimitExceeded", new SuuntoAuthError("/247samples/x", '{"code":"RateLimitExceeded"}')],
    ["an empty 200 body", new SuuntoEmptyResponseError("/247samples/x")],
    ["a network error", new TypeError("fetch failed")],
  ] as const) {
    test(`generateDigest: ${label} on ${method} aborts and writes NO state`, async () => {
      await withTempDigestPaths(async (paths) => {
        const suunto = fakeSuunto();
        suunto[method] = async () => {
          throw err;
        };
        await assert.rejects(() => generateDigest({ suunto, ...paths, date: "2026-01-01" }));
        await assert.rejects(() => readFile(paths.averagesPath), { code: "ENOENT" }, "sidecar must not be created");
        await assert.rejects(() => readFile(paths.historyPath), { code: "ENOENT" }, "history must not be written");
        // ...and the date is still runnable afterwards:
        const ok = await generateDigest({ suunto: fakeSuunto(), ...paths, date: "2026-01-01" });
        assert.equal(ok.date, "2026-01-01");
      });
    });
  }
}

test("generateDigest: if the history append fails the sidecar is NOT advanced, so the date can be re-run", async () => {
  await withTempDigestPaths(async (paths) => {
    const broken = { ...paths, historyPath: dirname(paths.historyPath) }; // a directory: appendFile -> EISDIR
    await assert.rejects(() => generateDigest({ suunto: fakeSuunto(), ...broken, date: "2026-01-01" }));
    await assert.rejects(() => readFile(paths.averagesPath), { code: "ENOENT" });
    const ok = await generateDigest({ suunto: fakeSuunto(), ...paths, date: "2026-01-01" });
    assert.equal(ok.date, "2026-01-01");
  });
});

test("saveAverages: leaves no temp file behind, and replaces the sidecar even when the old file is read-only (temp file + rename, not an in-place write)", async () => {
  await withTempDigestPaths(async (paths) => {
    await saveAverages(paths.averagesPath, emptyAverages());
    assert.equal(JSON.parse(await readFile(paths.averagesPath, "utf8")).ctl, 0);
    // An in-place write would fail on a read-only file; a rename replaces it.
    await chmod(paths.averagesPath, 0o444);
    await saveAverages(paths.averagesPath, { ...emptyAverages(), ctl: 42 });
    assert.equal(JSON.parse(await readFile(paths.averagesPath, "utf8")).ctl, 42);
    const leftovers = (await readdir(dirname(paths.averagesPath))).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });
});

test("saveAverages: a failed save cleans up its temp file and leaves the previous sidecar untouched", async () => {
  await withTempDigestPaths(async (paths) => {
    await saveAverages(paths.averagesPath, { ...emptyAverages(), ctl: 7 });
    // the target's parent is fine but the target itself becomes a directory → rename fails
    const dir = join(dirname(paths.averagesPath), "as-dir");
    await saveAverages(join(dir, "inner.json"), emptyAverages()); // creates dir/
    await assert.rejects(() => saveAverages(dir, emptyAverages()));
    const leftovers = (await readdir(dirname(paths.averagesPath))).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "temp file must be removed after a failed rename");
    assert.equal(JSON.parse(await readFile(paths.averagesPath, "utf8")).ctl, 7);
  });
});

test("generateDigest: a hard failure fetching workouts (not an optional subscription) still throws", async () => {
  await withTempDigestPaths(async (paths) => {
    const suunto = fakeSuunto();
    suunto.listWorkouts = async () => {
      throw new Error("network error");
    };
    await assert.rejects(() => generateDigest({ suunto, ...paths, date: "2026-01-01" }), /network error/);
  });
});

test("generateDigest: recovery narrative reflects the actual first-to-last trend, not min-vs-max", async () => {
  await withTempDigestPaths(async (paths) => {
    // Monotonic decline through the day: 90% -> 70% -> 40%. Old code
    // compared peak(90) to morning/min(40) and always reported "recovered
    // well" since max >= min by construction — the day actually declined.
    const suunto = fakeSuunto({
      recovery: [
        { timestamp: "2026-01-01T08:00:00Z", entryData: { Balance: 0.9 } },
        { timestamp: "2026-01-01T14:00:00Z", entryData: { Balance: 0.7 } },
        { timestamp: "2026-01-01T20:00:00Z", entryData: { Balance: 0.4 } },
      ],
    });
    const result = await generateDigest({ suunto, ...paths, date: "2026-01-01" });
    assert.match(result.markdown, /Recovery declined through the day/);
    assert.doesNotMatch(result.markdown, /Recovered well as the day went on/);
  });
});

test("generateDigest: fetches a wide workout window and counts only workouts whose own local date is the digest date", async () => {
  await withTempDigestPaths(async (paths) => {
    let asked: { since?: number; until?: number } = {};
    const workout = (isoLocal: string, offsetMin: number, tss: number) => ({
      startTime: Date.parse(isoLocal) , // isoLocal carries its own offset
      timeOffsetInMinutes: offsetMin,
      tss: { trainingStressScore: tss },
    });
    const suunto = fakeSuunto({
      workouts: {
        payload: [
          workout("2026-09-28T00:20:00+02:00", 120, 300), // the next local day, 00:20
          workout("2026-09-27T08:00:00+02:00", 120, 50), // the digest date
          workout("2026-09-27T00:20:00+02:00", 120, 20), // the digest date, 00:20 — a UTC day would call this the 26th
          workout("2026-09-26T23:30:00+02:00", 120, 200), // the previous local day
        ],
      },
    });
    const listWorkouts = suunto.listWorkouts;
    suunto.listWorkouts = async (opts: any) => {
      asked = opts;
      return listWorkouts(opts);
    };
    await generateDigest({ suunto, ...paths, date: "2026-09-27" });
    assert.equal(asked.since, Date.UTC(2026, 8, 27) - 14 * 3_600_000);
    assert.equal(asked.until, Date.UTC(2026, 8, 28) + 14 * 3_600_000 - 1);
    const state = JSON.parse(await readFile(paths.averagesPath, "utf8"));
    const expected = rollCtlAtl(0, 0, 70); // 50 + 20 only
    assert.ok(Math.abs(state.ctl - expected.ctl) < 1e-9, `ctl ${state.ctl} vs ${expected.ctl}`);
    assert.ok(Math.abs(state.atl - expected.atl) < 1e-9);
  });
});

// ---------- no-data days must not become fabricated numbers or decisions ----------

const stepsFor = (date: string, value: number | null) => [
  { Name: "stepcount", Sources: [{ Samples: [{ TimeISO8601: `${date}T12:00:00+02:00`, Value: value }] }] },
];

test("generateDigest: a day with no step sample is 'no data' — not a red 0 averaged into the baseline", async () => {
  await withTempDigestPaths(async (paths) => {
    await generateDigest({ suunto: fakeSuunto({ stats: stepsFor("2026-01-01", 9000) }), ...paths, date: "2026-01-01" });
    for (const [i, stats] of [[0, []], [1, stepsFor("2026-01-02", null)], [2, stepsFor("2026-01-03", null)]] as const) {
      const date = `2026-01-0${i + 2}`;
      const r = await generateDigest({ suunto: fakeSuunto({ stats }), ...paths, date });
      assert.match(r.markdown, /No step data for this date\./, date);
      assert.doesNotMatch(r.markdown, /🔴 0 steps/, date);
    }
    const state = JSON.parse(await readFile(paths.averagesPath, "utf8"));
    assert.deepEqual(state.baselines.steps, { avg: 9000, n: 1 }, "no-data days must leave the baseline alone");
  });
});

test("generateDigest: a real 0-step sample IS data and is counted; the next day's sample is ignored", async () => {
  await withTempDigestPaths(async (paths) => {
    const stats = [{ Name: "stepcount", Sources: [{ Samples: [{ TimeISO8601: "2026-01-01T12:00:00+02:00", Value: 8000 }, { TimeISO8601: "2026-01-02T12:00:00+02:00", Value: 500 }] }] }];
    const r = await generateDigest({ suunto: fakeSuunto({ stats }), ...paths, date: "2026-01-01" });
    assert.match(r.markdown, new RegExp(`${(8000).toLocaleString()} steps`));
    assert.doesNotMatch(r.markdown, /8,500|500 steps/);
    const zero = await generateDigest({ suunto: fakeSuunto({ stats: stepsFor("2026-01-02", 0) }), ...paths, date: "2026-01-02" });
    assert.match(zero.markdown, /0 steps/);
    const state = JSON.parse(await readFile(paths.averagesPath, "utf8"));
    assert.equal(state.baselines.steps.n, 2);
  });
});

test("soWhat: with no recovery reading the verdict comes from load alone — never a fabricated Rest day", () => {
  const base = { tsb: -5, hrv: null, hrvWellBelowStreak: 0, recoveryMorningBelowStreak: 0, isPartyNight: false } as any;
  assert.doesNotMatch(soWhat({ ...base, recoveryMorningPct: null }), /Rest day/);
  assert.match(soWhat({ ...base, recoveryMorningPct: 40 }), /Rest day/, "a real low reading still says rest");
  assert.doesNotMatch(soWhat({ ...base, tsb: 15, recoveryMorningPct: null }), /Peak form/, "peak form needs a real recovery reading");
  assert.match(soWhat({ ...base, tsb: 15, recoveryMorningPct: 90 }), /Peak form/);
});

test("generateDigest: missing recovery (empty list or no subscription) does not produce 'Rest day'", async () => {
  await withTempDigestPaths(async (paths) => {
    const r = await generateDigest({ suunto: fakeSuunto(), ...paths, date: "2026-01-01", seedCtl: 30, seedAtl: 40 });
    assert.match(r.markdown, /No recovery data for this date\./);
    assert.doesNotMatch(r.markdown, /Rest day/);
  });
});

test("generateDigest: reads the right night, the day's own steps and the day's recovery from real-shaped rows", async () => {
  await withTempDigestPaths(async (paths) => {
    const night = (id: number, bedtime: string, duration: number, isNap: boolean, score?: number) => ({
      timestamp: bedtime,
      entryData: { SleepId: id, IsNap: isNap, Duration: duration, DeepSleepDuration: 5400, REMSleepDuration: 3600, BedtimeStart: bedtime, BedtimeEnd: bedtime, ...(score ? { SleepQualityScore: score } : {}) },
    });
    const suunto = fakeSuunto({
      stats: [{ Name: "stepcount", Sources: [{ Samples: [{ TimeISO8601: "2026-01-01T12:00:00+01:00", Value: 8123 }, { TimeISO8601: "2026-01-02T12:00:00+01:00", Value: 77 }] }] }],
      sleep: [night(2, "2026-01-01T13:30:00+01:00", 3000, true), night(1, "2026-01-01T23:10:00+01:00", 27000, false, 81)],
      recovery: [
        { timestamp: "2026-01-01T03:00:00.000+01:00", entryData: { Balance: 0.55 } },
        { timestamp: "2026-01-01T15:00:00.000+01:00", entryData: { Balance: 0.9 } },
      ],
    });
    const r = await generateDigest({ suunto, ...paths, date: "2026-01-01" });
    assert.match(r.markdown, new RegExp(`${(8123).toLocaleString()} steps`));
    assert.match(r.markdown, /7h 30m|7\.5/, "the 27000 s non-nap sleep is the main sleep, not the 50-minute nap");
    assert.match(r.markdown, /55%/, "morning recovery is the overnight low");
    assert.match(r.markdown, /90%/, "peak recovery");
  });
});

test("generateDigest: asks for 30 workouts, and a workout with no readable date is kept, not dropped", async () => {
  await withTempDigestPaths(async (paths) => {
    let asked: any = {};
    const suunto = fakeSuunto({ workouts: { payload: [{ tss: { trainingStressScore: 60 } }, { startTime: Date.parse("2026-01-05T09:00:00Z"), timeOffsetInMinutes: 60, tss: { trainingStressScore: 999 } }] } });
    const list = suunto.listWorkouts;
    suunto.listWorkouts = async (o: any) => {
      asked = o;
      return list(o);
    };
    await generateDigest({ suunto, ...paths, date: "2026-01-01" });
    assert.equal(asked.limit, 30);
    const state = JSON.parse(await readFile(paths.averagesPath, "utf8"));
    assert.ok(Math.abs(state.ctl - rollCtlAtl(0, 0, 60).ctl) < 1e-9, "only the undated workout counts; the 5 January one is another day");
  });
});
