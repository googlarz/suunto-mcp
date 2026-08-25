// Daily Health Digest: fetches yesterday's Suunto data, computes a training
// load model (CTL/ATL/TSB) Suunto's own API doesn't provide, and writes a
// color-coded markdown entry to a history file.
//
// Field names below are verified against LIVE API responses, not assumed:
// - get_sleep / get_recovery return { timestamp, entryData: {...} } arrays
//   with PascalCase fields (AvgHRV, SleepQualityScore, IsNap, Balance, etc).
// - get_sleep duplicates the same SleepId many times with identical
//   entryData (confirmed live — 20+ duplicate rows per night) — every
//   caller of this module's parsing functions gets deduped data back.
// - list_workouts genuinely has workout.tss.trainingStressScore (HR-based
//   calculation method), confirmed live.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SuuntoClient } from "./api.js";

// ---------- Sidecar state (CTL/ATL/baselines — Suunto's API has no endpoint for these) ----------

export interface Baseline {
  avg: number;
  n: number;
}

export interface AveragesState {
  ctl: number;
  atl: number;
  lastUpdated: string; // YYYY-MM-DD of the last date rolled forward
  ctlHistory: Record<string, number>; // date -> CTL, for 7-day ramp-rate lookback
  hrvBelowRangeStreak: number;
  baselines: {
    steps: Baseline;
    stepsPartyNight: Baseline; // separate baseline for >20k-step days
    sleepDuration: Baseline; // seconds
    sleepScore: Baseline;
    deepSleep: Baseline; // seconds
    remSleep: Baseline; // seconds
    recoveryMorning: Baseline; // 0-100
    recoveryPeak: Baseline; // 0-100
    hrv: Baseline;
  };
}

function emptyBaseline(): Baseline {
  return { avg: 0, n: 0 };
}

export function emptyAverages(): AveragesState {
  return {
    ctl: 0,
    atl: 0,
    lastUpdated: "",
    ctlHistory: {},
    hrvBelowRangeStreak: 0,
    baselines: {
      steps: emptyBaseline(),
      stepsPartyNight: emptyBaseline(),
      sleepDuration: emptyBaseline(),
      sleepScore: emptyBaseline(),
      deepSleep: emptyBaseline(),
      remSleep: emptyBaseline(),
      recoveryMorning: emptyBaseline(),
      recoveryPeak: emptyBaseline(),
      hrv: emptyBaseline(),
    },
  };
}

export async function loadAverages(path: string): Promise<AveragesState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const empty = emptyAverages();
    // Shallow-merge onto defaults so a file from an older version of this
    // module (missing newer fields) doesn't crash on load.
    return { ...empty, ...parsed, baselines: { ...empty.baselines, ...parsed.baselines } };
  } catch (err: any) {
    if (err.code === "ENOENT") return emptyAverages();
    throw err;
  }
}

export async function saveAverages(path: string, state: AveragesState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

// ---------- Pure math ----------

// Standard TrainingPeaks-style exponential time constants: CTL = 42-day
// decay, ATL = 7-day decay. Verified: 1 - e^(-1/42) = 0.02353, 1 - e^(-1/7) = 0.13353.
const K_CTL = 1 - Math.exp(-1 / 42);
const K_ATL = 1 - Math.exp(-1 / 7);

export function rollCtlAtl(
  prevCtl: number,
  prevAtl: number,
  todayTss: number,
): { ctl: number; atl: number } {
  return {
    ctl: prevCtl * (1 - K_CTL) + todayTss * K_CTL,
    atl: prevAtl * (1 - K_ATL) + todayTss * K_ATL,
  };
}

export function updateBaseline(old: Baseline, value: number): Baseline {
  return { avg: (old.avg * old.n + value) / (old.n + 1), n: old.n + 1 };
}

// ---------- Sleep parsing ----------

export interface SleepEntry {
  sleepId: number;
  isNap: boolean;
  duration: number; // seconds
  deepSleep: number; // seconds
  remSleep: number; // seconds
  sleepScore: number | null;
  avgHrv: number | null;
  bedtimeStart: string;
  bedtimeEnd: string;
}

// Dedup by SleepId (the raw API repeats the same sleep record many times
// with identical entryData). Where duplicates disagree, keep the longest
// Duration — Suunto revises sleep boundaries as it processes more data, so
// the longest estimate is the most refined one.
export function parseSleepEntries(raw: any[]): SleepEntry[] {
  const bySleepId = new Map<number, SleepEntry>();
  for (const row of raw ?? []) {
    const d = row?.entryData;
    if (!d || typeof d.SleepId !== "number") continue;
    const entry: SleepEntry = {
      sleepId: d.SleepId,
      isNap: !!d.IsNap,
      duration: d.Duration ?? 0,
      deepSleep: d.DeepSleepDuration ?? 0,
      remSleep: d.REMSleepDuration ?? 0,
      sleepScore: d.SleepQualityScore ?? null,
      avgHrv: d.AvgHRV ?? null,
      bedtimeStart: d.BedtimeStart,
      bedtimeEnd: d.BedtimeEnd,
    };
    const existing = bySleepId.get(entry.sleepId);
    if (!existing || entry.duration > existing.duration) {
      bySleepId.set(entry.sleepId, entry);
    }
  }
  return [...bySleepId.values()];
}

// The main overnight sleep: exclude naps (IsNap: true), keep the longest
// remaining entry. A night can have more than one non-nap SleepId if the
// watch split detection into segments.
export function pickMainSleep(entries: SleepEntry[]): SleepEntry | null {
  const nonNaps = entries.filter((e) => !e.isNap);
  if (!nonNaps.length) return null;
  return nonNaps.reduce((best, e) => (e.duration > best.duration ? e : best));
}

// ---------- Color thresholds (from spec) ----------

export type Color = "🔵" | "🟢" | "🟡" | "🟠" | "🔴";

export function stepsColor(steps: number): Color {
  if (steps >= 12000) return "🟢";
  if (steps >= 8000) return "🟡";
  if (steps >= 4000) return "🟠";
  return "🔴";
}

export function sleepHoursColor(hours: number): Color {
  if (hours >= 7) return "🟢";
  if (hours >= 6) return "🟡";
  if (hours >= 4) return "🟠";
  return "🔴";
}

export function sleepScoreColor(score: number): Color {
  if (score >= 75) return "🟢";
  if (score >= 60) return "🟡";
  if (score >= 45) return "🟠";
  return "🔴";
}

export function recoveryColor(pct: number): Color {
  if (pct >= 80) return "🟢";
  if (pct >= 65) return "🟡";
  if (pct >= 50) return "🟠";
  return "🔴";
}

// The watch's own TSB legend — 4 tiers, not the spec's invented 3-color
// scheme. Confirmed directly from the watch display: >+10 Optimal (blue),
// 0 to +10 Balanced (green), -10 to 0 Compromised (yellow), <-10 Strained (red).
export function tsbColor(tsb: number): Color {
  if (tsb > 10) return "🔵";
  if (tsb >= 0) return "🟢";
  if (tsb >= -10) return "🟡";
  return "🔴";
}

export function tsbLabel(tsb: number): string {
  if (tsb > 10) return "Optimal";
  if (tsb >= 0) return "Balanced";
  if (tsb >= -10) return "Compromised";
  return "Strained";
}

// Spec defines no red bucket for ramp rate or HRV — anything outside the
// given bands falls to orange, the most severe color those two use.
export function rampRateColor(rate: number): Color {
  if (rate >= 3 && rate <= 8) return "🟢";
  if (rate >= -2 && rate <= 2) return "🟡";
  return "🟠";
}

export function hrvColor(hrv: number): Color {
  if (hrv >= 26 && hrv <= 34) return "🟢";
  if (hrv >= 20 && hrv <= 25) return "🟡";
  return "🟠";
}

// ---------- "So what" decision (must be a decision, not a description) ----------

export interface SoWhatInput {
  tsb: number;
  recoveryMorningPct: number;
  hrv: number | null;
  hrvBelowRangeStreak: number;
  rampRate: number | null; // null when there's no 7-day-old CTL entry yet
  isPartyNight: boolean;
}

export function soWhat(i: SoWhatInput): string {
  const notes: string[] = [];

  if (i.isPartyNight) {
    notes.push("Post-party baseline — don't compare today to a normal day.");
  }
  if (i.hrv !== null && i.hrv < 26 && i.hrvBelowRangeStreak >= 2) {
    notes.push("HRV has been below your normal range for 2+ days running — worth checking blood pressure in the morning.");
  }
  if (i.rampRate !== null && i.rampRate < -3) {
    notes.push("CTL is declining — needs consistent training to stop the trend.");
  }

  // Aligned to the watch's own TSB tiers (Balanced/Optimal >= 0, Strained < -10)
  // rather than an arbitrary cutoff.
  let verdict: string;
  if (i.tsb >= 0 && i.recoveryMorningPct >= 80) {
    verdict = "Good day to train.";
  } else if (i.tsb < -10 && i.recoveryMorningPct < 65) {
    verdict = "Rest day — don't train today.";
  } else {
    verdict = "Moderate day — train if it feels right, don't force intensity.";
  }

  return [verdict, ...notes].join(" ");
}

// ---------- Orchestrator ----------

export interface DigestConfig {
  suunto: SuuntoClient;
  averagesPath: string;
  historyPath: string;
  date: string; // YYYY-MM-DD, the day being summarized
}

export interface DigestResult {
  markdown: string;
  date: string;
}

function toHours(seconds: number): number {
  return seconds / 3600;
}

function fmtHM(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}min`;
}

// Explicit n===0 check — Math.round(0).toString() is "0", a truthy string,
// so `formatted || "n/a"` never fires on a genuine zero baseline. That was
// a real bug caught by running this against live data, not a hypothetical.
function fmtBaseline(b: Baseline, formatter: (avg: number) => string): string {
  return b.n === 0 ? "n/a" : formatter(b.avg);
}

function daysAgo(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function generateDigest(cfg: DigestConfig): Promise<DigestResult> {
  const { suunto, date } = cfg;
  const averages = await loadAverages(cfg.averagesPath);

  // --- Steps ---
  const startOfDay = `${date}T00:00:00`;
  const endOfDay = `${date}T23:59:59`;
  const stepsStats = await suunto.getDailyStats(startOfDay, endOfDay);
  const stepsMetric = (stepsStats ?? []).find((m: any) => m.Name === "stepcount");
  const stepsValue: number =
    stepsMetric?.Sources?.[0]?.Samples?.find((s: any) => s.TimeISO8601?.startsWith(date))?.Value ?? 0;

  // --- Sleep (main overnight sleep, keyed to the wake-up date) ---
  const rawSleep = await suunto.getSleep(date);
  const sleepEntries = parseSleepEntries(rawSleep as any[]);
  const mainSleep = pickMainSleep(sleepEntries);

  // --- Recovery (morning + peak for the day) ---
  const rawRecovery = await suunto.getRecovery(date);
  const recoverySamples = ((rawRecovery ?? []) as any[])
    .map((r) => ({ time: r.timestamp as string, balance: r.entryData?.Balance as number }))
    .filter((r) => typeof r.balance === "number")
    .sort((a, b) => a.time.localeCompare(b.time));
  const morningRecovery = recoverySamples[0]?.balance ?? null;
  const peakRecovery = recoverySamples.length
    ? Math.max(...recoverySamples.map((r) => r.balance))
    : null;

  // --- Workout TSS for the day ---
  const workouts = await suunto.listWorkouts({
    since: Date.parse(`${date}T00:00:00Z`),
    until: Date.parse(`${date}T23:59:59Z`),
    limit: 10,
  });
  const todaysWorkouts = (workouts.payload ?? []) as any[];
  const todayTss = todaysWorkouts.reduce(
    (sum, w) => sum + (w?.tss?.trainingStressScore ?? 0),
    0,
  );

  // --- Party night detection (do this before baseline updates so the
  // party-night sample goes into the right bucket) ---
  const isPartyNight = stepsValue > 20000 && (mainSleep ? mainSleep.duration < 6 * 3600 : false);

  // --- CTL/ATL/TSB/ramp rate ---
  // Note: CTL/ATL start at 0 and converge over ~4-6 weeks from a cold start
  // — there's no API to seed them from the watch's own displayed value, so
  // early digests understate fitness/fatigue until enough days accumulate.
  const { ctl, atl } = rollCtlAtl(averages.ctl, averages.atl, todayTss);
  const tsb = ctl - atl;
  const ctl7dAgoKey = daysAgo(date, 7);
  const hasRampHistory = ctl7dAgoKey in averages.ctlHistory;
  const rampRate = hasRampHistory ? ctl - averages.ctlHistory[ctl7dAgoKey] : null;

  averages.ctl = ctl;
  averages.atl = atl;
  averages.lastUpdated = date;
  averages.ctlHistory[date] = ctl;

  // --- Baselines (update AFTER reading, so today doesn't skew its own comparison) ---
  const stepsBaseline = isPartyNight ? averages.baselines.stepsPartyNight : averages.baselines.steps;
  const stepsBaselineBefore = { ...stepsBaseline };

  const sleepDurationBaselineBefore = { ...averages.baselines.sleepDuration };
  const sleepScoreBaselineBefore = { ...averages.baselines.sleepScore };
  const deepSleepBaselineBefore = { ...averages.baselines.deepSleep };
  const remSleepBaselineBefore = { ...averages.baselines.remSleep };
  const recoveryMorningBaselineBefore = { ...averages.baselines.recoveryMorning };
  const recoveryPeakBaselineBefore = { ...averages.baselines.recoveryPeak };
  const hrvBaselineBefore = { ...averages.baselines.hrv };

  if (isPartyNight) {
    averages.baselines.stepsPartyNight = updateBaseline(averages.baselines.stepsPartyNight, stepsValue);
  } else {
    averages.baselines.steps = updateBaseline(averages.baselines.steps, stepsValue);
  }
  if (mainSleep) {
    averages.baselines.sleepDuration = updateBaseline(averages.baselines.sleepDuration, mainSleep.duration);
    averages.baselines.deepSleep = updateBaseline(averages.baselines.deepSleep, mainSleep.deepSleep);
    averages.baselines.remSleep = updateBaseline(averages.baselines.remSleep, mainSleep.remSleep);
    if (mainSleep.sleepScore !== null) {
      averages.baselines.sleepScore = updateBaseline(averages.baselines.sleepScore, mainSleep.sleepScore);
    }
    if (mainSleep.avgHrv !== null) {
      averages.baselines.hrv = updateBaseline(averages.baselines.hrv, mainSleep.avgHrv);
    }
  }
  if (morningRecovery !== null) {
    averages.baselines.recoveryMorning = updateBaseline(averages.baselines.recoveryMorning, morningRecovery * 100);
  }
  if (peakRecovery !== null) {
    averages.baselines.recoveryPeak = updateBaseline(averages.baselines.recoveryPeak, peakRecovery * 100);
  }

  const hrv = mainSleep?.avgHrv ?? null;
  if (hrv !== null) {
    averages.hrvBelowRangeStreak = hrv < 26 ? averages.hrvBelowRangeStreak + 1 : 0;
  }

  await saveAverages(cfg.averagesPath, averages);

  // --- Format markdown ---
  const morningPct = morningRecovery !== null ? morningRecovery * 100 : null;
  const peakPct = peakRecovery !== null ? peakRecovery * 100 : null;

  const overallVerdict = soWhat({
    tsb,
    recoveryMorningPct: morningPct ?? 0,
    hrv,
    hrvBelowRangeStreak: averages.hrvBelowRangeStreak,
    rampRate,
    isPartyNight,
  });

  const lines: string[] = [];
  lines.push(`## ${date} — ${overallVerdict.split(".")[0]}.`);
  lines.push("");
  lines.push(`${morningPct !== null ? recoveryColor(morningPct) : "⚪"} ${overallVerdict}`);
  lines.push("");

  lines.push("### 🏃 Activity");
  lines.push(
    `${stepsColor(stepsValue)} ${stepsValue.toLocaleString()} steps (baseline: ${fmtBaseline(stepsBaselineBefore, (v) => Math.round(v).toLocaleString())})`,
  );
  if (todaysWorkouts.length) {
    for (const w of todaysWorkouts) {
      lines.push(`Workout: ${w.sport ?? "unknown"} — TSS ${Math.round(w?.tss?.trainingStressScore ?? 0)}`);
    }
  } else {
    lines.push("No recorded workout.");
  }
  lines.push("");

  lines.push("### 😴 Sleep");
  if (mainSleep) {
    lines.push(
      `${sleepHoursColor(toHours(mainSleep.duration))} ${fmtHM(mainSleep.duration)}` +
        (mainSleep.sleepScore !== null ? `, Sleep Score: ${mainSleep.sleepScore}/100` : "") +
        ` (baseline: ${fmtBaseline(sleepDurationBaselineBefore, fmtHM)}${sleepScoreBaselineBefore.n ? ` / ${Math.round(sleepScoreBaselineBefore.avg)}` : ""})`,
    );
    lines.push(
      `Deep Sleep: ${Math.round(mainSleep.deepSleep / 60)} min (baseline: ${fmtBaseline(deepSleepBaselineBefore, (v) => `${Math.round(v / 60)}`)}) | ` +
        `REM: ${Math.round(mainSleep.remSleep / 60)} min (baseline: ${fmtBaseline(remSleepBaselineBefore, (v) => `${Math.round(v / 60)}`)})`,
    );
  } else {
    lines.push("No sleep data for this date.");
  }
  lines.push("");

  lines.push("### 💚 Recovery Balance");
  if (morningPct !== null && peakPct !== null) {
    lines.push(
      `Morning: ${recoveryColor(morningPct)} ${Math.round(morningPct)}% → Peak: ${recoveryColor(peakPct)} ${Math.round(peakPct)}%` +
        ` (baseline: ${fmtBaseline(recoveryMorningBaselineBefore, (v) => `${Math.round(v)}%`)} → ${fmtBaseline(recoveryPeakBaselineBefore, (v) => `${Math.round(v)}%`)})`,
    );
  } else {
    lines.push("No recovery data for this date.");
  }
  lines.push("");

  lines.push("### ❤️ HRV *(from sleep data — watch's own 7-day average is more accurate)*");
  if (hrv !== null) {
    lines.push(`${hrvColor(hrv)} ${hrv}ms (normal range: 26–34ms, your baseline: ${fmtBaseline(hrvBaselineBefore, (v) => `${Math.round(v)}ms`)})`);
  } else {
    lines.push("No HRV data for this date.");
  }
  lines.push("");

  const rampText = rampRate === null
    ? "not enough history yet (needs 7+ days)"
    : `${rampRateColor(rampRate)} ${rampRate >= 0 ? "+" : ""}${rampRate.toFixed(1)}/week`;
  lines.push(`### 📈 Progress — Fitness (CTL): ${ctl.toFixed(1)} | Ramp rate: ${rampText}`);
  lines.push(`### 🔄 Recovery — Form (TSB): ${tsbColor(tsb)} ${tsbLabel(tsb)} (${tsb >= 0 ? "+" : ""}${tsb.toFixed(1)})`);
  if (averages.lastUpdated === date && ctl === 0 && atl === 0) {
    lines.push("_First digest — CTL/ATL start at 0 and take ~4-6 weeks to converge; there's no API to seed them from the watch's own displayed value._");
  }
  lines.push("");

  lines.push("**👉 So what:**");
  lines.push(overallVerdict);
  lines.push("");
  lines.push("---");
  lines.push("");

  const markdown = lines.join("\n");
  await mkdir(dirname(cfg.historyPath), { recursive: true }).catch(() => {});
  await appendFile(cfg.historyPath, markdown, "utf8");

  return { markdown, date };
}
