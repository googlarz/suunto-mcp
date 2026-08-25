import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSleepEntries,
  pickMainSleep,
  rollCtlAtl,
  updateBaseline,
  stepsColor,
  sleepHoursColor,
  sleepScoreColor,
  recoveryColor,
  tsbColor,
  tsbLabel,
  rampRateColor,
  hrvColor,
  soWhat,
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

test("color thresholds: boundaries match the spec table", () => {
  assert.equal(stepsColor(12000), "🟢");
  assert.equal(stepsColor(11999), "🟡");
  assert.equal(stepsColor(4000), "🟠");
  assert.equal(stepsColor(3999), "🔴");

  assert.equal(sleepHoursColor(7), "🟢");
  assert.equal(sleepHoursColor(6.99), "🟡");

  assert.equal(sleepScoreColor(75), "🟢");
  assert.equal(sleepScoreColor(44), "🔴");

  assert.equal(recoveryColor(80), "🟢");
  assert.equal(recoveryColor(49), "🔴");

  assert.equal(tsbColor(11), "🔵");
  assert.equal(tsbColor(0), "🟢");
  assert.equal(tsbColor(-1), "🟡");
  assert.equal(tsbColor(-10), "🟡");
  assert.equal(tsbColor(-11), "🔴");
  assert.equal(tsbLabel(11), "Optimal");
  assert.equal(tsbLabel(0), "Balanced");
  assert.equal(tsbLabel(-5), "Compromised");
  assert.equal(tsbLabel(-11), "Strained");

  assert.equal(rampRateColor(5), "🟢");
  assert.equal(rampRateColor(0), "🟡");
  assert.equal(rampRateColor(-5), "🟠");

  assert.equal(hrvColor(30), "🟢");
  assert.equal(hrvColor(22), "🟡");
  assert.equal(hrvColor(10), "🟠");
});

test("soWhat: good recovery + fresh form -> train verdict", () => {
  const msg = soWhat({
    tsb: 1.8,
    recoveryMorningPct: 84,
    hrv: 22,
    hrvBelowRangeStreak: 1,
    rampRate: -4.9,
    isPartyNight: false,
  });
  assert.match(msg, /Good day to train/);
  assert.match(msg, /CTL is declining/);
});

test("soWhat: poor recovery + Strained TSB (below -10) -> rest verdict", () => {
  const msg = soWhat({
    tsb: -12,
    recoveryMorningPct: 40,
    hrv: 30,
    hrvBelowRangeStreak: 0,
    rampRate: 1,
    isPartyNight: false,
  });
  assert.match(msg, /Rest day/);
});

test("soWhat: Compromised TSB (-8, above the -10 Strained cutoff) is not a rest day on its own", () => {
  const msg = soWhat({
    tsb: -8,
    recoveryMorningPct: 40,
    hrv: 30,
    hrvBelowRangeStreak: 0,
    rampRate: 1,
    isPartyNight: false,
  });
  assert.match(msg, /Moderate day/);
});

test("soWhat: null rampRate (not enough history) doesn't crash or trigger the declining-CTL note", () => {
  const msg = soWhat({
    tsb: 2,
    recoveryMorningPct: 85,
    hrv: 30,
    hrvBelowRangeStreak: 0,
    rampRate: null,
    isPartyNight: false,
  });
  assert.match(msg, /Good day to train/);
  assert.doesNotMatch(msg, /CTL is declining/);
});

test("soWhat: party night flag surfaces even with a neutral verdict", () => {
  const msg = soWhat({
    tsb: -2,
    recoveryMorningPct: 70,
    hrv: null,
    hrvBelowRangeStreak: 0,
    rampRate: 0,
    isPartyNight: true,
  });
  assert.match(msg, /Post-party baseline/);
});
