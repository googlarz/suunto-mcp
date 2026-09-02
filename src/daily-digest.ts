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
//   calculation method) and hrdata.avg, confirmed live.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SuuntoClient } from "./api.js";

// ---------- Sidecar state (CTL/ATL/baselines — Suunto's API has no endpoint for these) ----------

export interface Baseline {
  avg: number;
  n: number;
}

const HISTORY_WINDOW_DAYS = 8; // enough for a 7-day-ago ramp-rate lookback

export interface AveragesState {
  ctl: number;
  atl: number;
  lastUpdated: string; // YYYY-MM-DD of the last date rolled forward
  ctlHistory: Record<string, number>; // date -> CTL, pruned to last 8 days
  hrvHistory: Record<string, number>; // date -> AvgHRV, pruned to last 8 days
  hrvWellBelowStreak: number; // consecutive days HRV was "well below range" (orange)
  recoveryMorningBelowStreak: number; // consecutive days morning recovery < 65%
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
    hrvHistory: {},
    hrvWellBelowStreak: 0,
    recoveryMorningBelowStreak: 0,
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

// Keep only the most recent N days of a date-keyed history map, to stop it
// growing forever.
export function pruneHistory(history: Record<string, number>, keepDays: number): Record<string, number> {
  const dates = Object.keys(history).sort();
  const toKeep = dates.slice(-keepDays);
  const pruned: Record<string, number> = {};
  for (const d of toKeep) pruned[d] = history[d];
  return pruned;
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

// ---------- Color thresholds ----------

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

// Morning (nadir) and peak recovery use DIFFERENT bands — peak is naturally
// higher than the overnight low, so the same thresholds don't apply to both.
export function recoveryMorningColor(pct: number): Color {
  if (pct >= 80) return "🟢";
  if (pct >= 65) return "🟡";
  if (pct >= 50) return "🟠";
  return "🔴";
}

export function recoveryPeakColor(pct: number): Color {
  if (pct >= 90) return "🟢";
  if (pct >= 75) return "🟡";
  return "🟠"; // no red band for peak
}

// The watch's own TSB legend — 4 tiers. Confirmed directly from the watch
// display: >+10 Optimal (blue), 0 to +10 Balanced (green), -10 to 0
// Compromised (yellow), <-10 Strained (red).
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

// Ramp rate: too-fast INCREASE is flagged red (overreaching/injury risk) —
// a meaningfully different severity than a moderate decline, not the same
// "outside the good band" bucket.
export function rampRateColor(rate: number): Color {
  if (rate > 8) return "🔴";
  if (rate >= 3) return "🟢";
  if (rate >= -2) return "🟡";
  return "🟠";
}

export function rampRateLabel(rate: number): string {
  if (rate > 8) return "Overreaching — injury risk";
  if (rate >= 3) return "Building well";
  if (rate >= -2) return "Holding fitness";
  return "Losing fitness";
}

// HRV: green = within or above personal range (nothing to flag), yellow =
// slightly below, orange ("Recovery" state) = well below. Unlike a two-sided
// band, there's no upper cutoff — an unusually high HRV isn't itself a
// concern the way a low one is.
const HRV_LOW = 26;
const HRV_WELL_BELOW = 20;

export function hrvColor(hrv: number): Color {
  if (hrv >= HRV_LOW) return "🟢";
  if (hrv >= HRV_WELL_BELOW) return "🟡";
  return "🟠";
}

export function hrvLabel(hrv: number): string {
  return hrv < HRV_WELL_BELOW ? "Recovery" : "";
}

// ---------- "So what" decision (must be a decision, not a description) ----------

export interface SoWhatInput {
  tsb: number;
  recoveryMorningPct: number;
  hrv: number | null;
  hrvWellBelowStreak: number;
  recoveryMorningBelowStreak: number;
  rampRate: number | null; // null when there's no 7-day-old CTL entry yet
  isPartyNight: boolean;
  hadWorkout: boolean;
  projectedTomorrowCtl: number | null; // only set when hadWorkout is false
}

export function soWhat(i: SoWhatInput): string {
  const notes: string[] = [];

  // Primary verdict, most severe/specific first.
  let verdict: string;
  if (i.tsb > 10 && i.recoveryMorningPct >= 80) {
    verdict = "Peak form — ideal day for a race or performance test.";
  } else if (i.tsb < -10) {
    verdict = "Clear fatigue — at least 2 rest days needed.";
  } else if (i.tsb >= -10 && i.tsb < 0 && i.recoveryMorningPct < 65) {
    verdict = "Rest day — don't train today.";
  } else if (i.tsb >= 0) {
    verdict =
      i.hrv !== null && i.hrv < HRV_LOW
        ? "Good day to train, but keep intensity moderate."
        : "Good day to train. Moderate to hard intensity is fine.";
  } else {
    verdict = "Moderate day — train if it feels right, don't force intensity.";
  }

  if (i.isPartyNight) {
    notes.push("Post-party baseline — don't compare today to a normal day.");
  }
  if (
    (i.hrv !== null && i.hrv < HRV_WELL_BELOW && i.hrvWellBelowStreak >= 2) ||
    i.recoveryMorningBelowStreak >= 2
  ) {
    notes.push("Check blood pressure in the morning.");
  }
  if (i.rampRate !== null && i.rampRate > 8) {
    notes.push("Training load increasing too fast — injury risk. Back off.");
  } else if (i.rampRate !== null && i.rampRate < -2) {
    notes.push("CTL declining — consistent training needed to stop the trend.");
  }
  if (!i.hadWorkout && i.projectedTomorrowCtl !== null && i.rampRate !== null && i.rampRate < 0) {
    notes.push(`Without training today, CTL drops to ~${i.projectedTomorrowCtl.toFixed(1)} tomorrow.`);
  }

  return [verdict, ...notes].join(" ");
}

// ---------- Orchestrator ----------

export interface DigestConfig {
  suunto: SuuntoClient;
  averagesPath: string;
  historyPath: string;
  date: string; // YYYY-MM-DD, the day being summarized
  seedCtl?: number; // only used on a genuine first run (no prior lastUpdated)
  seedAtl?: number;
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

function daysAgo(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Explicit n===0 check — Math.round(0).toString() is "0", a truthy string,
// so `formatted || "n/a"` never fires on a genuine zero baseline. That was
// a real bug caught by running this against live data, not a hypothetical.
function fmtBaseline(b: Baseline, formatter: (avg: number) => string): string {
  return b.n === 0 ? "n/a" : formatter(b.avg);
}

export async function generateDigest(cfg: DigestConfig): Promise<DigestResult> {
  const { suunto, date } = cfg;
  const averages = await loadAverages(cfg.averagesPath);
  const isFirstRun = averages.lastUpdated === "";
  if (isFirstRun && (cfg.seedCtl !== undefined || cfg.seedAtl !== undefined)) {
    // Anchor to the watch's own displayed Fitness/Fatigue on first use —
    // there's no API to read those, so this only works if the caller
    // supplies them (e.g. the user reads them off their watch/app once).
    averages.ctl = cfg.seedCtl ?? 0;
    averages.atl = cfg.seedAtl ?? 0;
  }

  // Fetch everything in parallel — these are 4 independent network calls.
  const startOfDay = `${date}T00:00:00`;
  const endOfDay = `${date}T23:59:59`;
  const [stepsStats, rawSleep, rawRecovery, workouts] = await Promise.all([
    suunto.getDailyStats(startOfDay, endOfDay),
    suunto.getSleep(date),
    suunto.getRecovery(date),
    suunto.listWorkouts({
      since: Date.parse(`${date}T00:00:00Z`),
      until: Date.parse(`${date}T23:59:59Z`),
      limit: 10,
    }),
  ]);

  // --- Steps ---
  const stepsMetric = (stepsStats ?? []).find((m: any) => m.Name === "stepcount");
  const stepsValue: number =
    stepsMetric?.Sources?.[0]?.Samples?.find((s: any) => s.TimeISO8601?.startsWith(date))?.Value ?? 0;

  // --- Sleep (main overnight sleep, keyed to the wake-up date) ---
  const sleepEntries = parseSleepEntries(rawSleep as any[]);
  const mainSleep = pickMainSleep(sleepEntries);

  // --- Recovery: morning = the overnight nadir (lowest value), not simply
  // the first chronological sample — Balance typically dips before dawn
  // and climbs through the day, so "first sample" and "nadir" can differ. ---
  const recoveryValues = ((rawRecovery ?? []) as any[])
    .map((r) => r.entryData?.Balance as number)
    .filter((v) => typeof v === "number");
  const morningRecovery = recoveryValues.length ? Math.min(...recoveryValues) : null;
  const peakRecovery = recoveryValues.length ? Math.max(...recoveryValues) : null;

  // --- Workouts / TSS for the day ---
  const todaysWorkouts = (workouts.payload ?? []) as any[];
  const todayTss = todaysWorkouts.reduce(
    (sum, w) => sum + (w?.tss?.trainingStressScore ?? 0),
    0,
  );
  const hadWorkout = todaysWorkouts.length > 0;

  // --- Party night detection (before baseline updates, so the sample goes
  // into the right bucket). Steps alone, not gated on sleep data existing —
  // a genuine high-step day with no sleep record (e.g. activity ran past
  // dawn with no distinct bedtime) must still route to the party baseline,
  // not silently fall back to "false" and skew the regular-day average. ---
  const isPartyNight = stepsValue > 20000;

  // --- CTL/ATL/TSB/ramp rate ---
  // Note: without a seed, CTL/ATL start at 0 and converge over ~4-6 weeks —
  // there's no API to read the watch's own displayed value.
  const { ctl, atl } = rollCtlAtl(averages.ctl, averages.atl, todayTss);
  const tsb = ctl - atl;
  const ctl7dAgoKey = daysAgo(date, 7);
  const hasRampHistory = ctl7dAgoKey in averages.ctlHistory;
  const rampRate = hasRampHistory ? ctl - averages.ctlHistory[ctl7dAgoKey] : null;
  const projectedTomorrowCtl = hadWorkout ? null : rollCtlAtl(ctl, atl, 0).ctl;

  averages.ctl = ctl;
  averages.atl = atl;
  averages.lastUpdated = date;
  averages.ctlHistory = pruneHistory({ ...averages.ctlHistory, [date]: ctl }, HISTORY_WINDOW_DAYS);

  // --- Baselines (snapshot BEFORE updating, so today compares against
  // yesterday's baseline, not one that already includes today) ---
  const stepsBaseline = isPartyNight ? averages.baselines.stepsPartyNight : averages.baselines.steps;
  const stepsBaselineBefore = { ...stepsBaseline };
  const sleepDurationBaselineBefore = { ...averages.baselines.sleepDuration };
  const sleepScoreBaselineBefore = { ...averages.baselines.sleepScore };
  const deepSleepBaselineBefore = { ...averages.baselines.deepSleep };
  const remSleepBaselineBefore = { ...averages.baselines.remSleep };
  const recoveryMorningBaselineBefore = { ...averages.baselines.recoveryMorning };
  const recoveryPeakBaselineBefore = { ...averages.baselines.recoveryPeak };
  const hrvBaselineBefore = { ...averages.baselines.hrv };
  const hrv7dHistoryBefore = { ...averages.hrvHistory };

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
      averages.hrvHistory = pruneHistory({ ...averages.hrvHistory, [date]: mainSleep.avgHrv }, HISTORY_WINDOW_DAYS);
    }
  }
  if (morningRecovery !== null) {
    averages.baselines.recoveryMorning = updateBaseline(averages.baselines.recoveryMorning, morningRecovery * 100);
  }
  if (peakRecovery !== null) {
    averages.baselines.recoveryPeak = updateBaseline(averages.baselines.recoveryPeak, peakRecovery * 100);
  }

  const hrv = mainSleep?.avgHrv ?? null;
  const morningPct = morningRecovery !== null ? morningRecovery * 100 : null;
  const peakPct = peakRecovery !== null ? peakRecovery * 100 : null;

  averages.hrvWellBelowStreak = hrv !== null && hrv < HRV_WELL_BELOW ? averages.hrvWellBelowStreak + 1 : 0;
  averages.recoveryMorningBelowStreak =
    morningPct !== null && morningPct < 65 ? averages.recoveryMorningBelowStreak + 1 : 0;

  await saveAverages(cfg.averagesPath, averages);

  // 7-day trailing HRV average from stored history — a real, honestly-labeled
  // substitute for "the watch's own 7-day average," which isn't exposed by
  // any Suunto API endpoint. Not the same number the watch shows; the
  // digest says so explicitly.
  const hrv7dValues = Object.entries({ ...hrv7dHistoryBefore, ...(hrv !== null ? { [date]: hrv } : {}) })
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7)
    .map(([, v]) => v);
  const hrv7dAvg = hrv7dValues.length ? hrv7dValues.reduce((a, b) => a + b, 0) / hrv7dValues.length : null;

  // --- Format markdown ---
  const overallVerdict = soWhat({
    tsb,
    recoveryMorningPct: morningPct ?? 0,
    hrv,
    hrvWellBelowStreak: averages.hrvWellBelowStreak,
    recoveryMorningBelowStreak: averages.recoveryMorningBelowStreak,
    rampRate,
    isPartyNight,
    hadWorkout,
    projectedTomorrowCtl,
  });

  const lines: string[] = [];
  lines.push(`### ${date} — ${overallVerdict.split(".")[0]}.`);
  lines.push("");
  lines.push(`**${morningPct !== null ? recoveryMorningColor(morningPct) : "⚪"} ${overallVerdict}**`);
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("**🏃 Activity**");
  lines.push(
    `${stepsColor(stepsValue)} ${stepsValue.toLocaleString()} steps *(baseline: ${fmtBaseline(stepsBaselineBefore, (v) => Math.round(v).toLocaleString())})*`,
  );
  if (hadWorkout) {
    for (const w of todaysWorkouts) {
      const minutes = Math.round((w.totalTime ?? 0) / 60);
      const avgHr = w?.hrdata?.avg ?? "?";
      const tss = (w?.tss?.trainingStressScore ?? 0).toFixed(1);
      lines.push(`Workout: ${w.sport ?? "unknown"} ${minutes}min, avg HR ${avgHr}bpm, TSS ${tss}`);
    }
  } else {
    lines.push("No recorded workout.");
  }
  lines.push("");

  lines.push("**😴 Sleep**");
  if (mainSleep) {
    lines.push(
      `${sleepHoursColor(toHours(mainSleep.duration))} ${fmtHM(mainSleep.duration)}` +
        (mainSleep.sleepScore !== null ? `, Sleep Score: ${mainSleep.sleepScore}/100` : "") +
        ` *(baseline: ${fmtBaseline(sleepDurationBaselineBefore, fmtHM)}${sleepScoreBaselineBefore.n ? ` / ${Math.round(sleepScoreBaselineBefore.avg)}` : ""})*`,
    );
    lines.push(
      `Deep Sleep: ${Math.round(mainSleep.deepSleep / 60)} min *(baseline: ${fmtBaseline(deepSleepBaselineBefore, (v) => `${Math.round(v / 60)}`)})* | ` +
        `REM: ${Math.round(mainSleep.remSleep / 60)} min *(baseline: ${fmtBaseline(remSleepBaselineBefore, (v) => `${Math.round(v / 60)}`)})*`,
    );
  } else {
    lines.push("No sleep data for this date.");
  }
  lines.push("");

  lines.push("**💚 Recovery Balance**");
  if (morningPct !== null && peakPct !== null) {
    lines.push(
      `Morning: ${recoveryMorningColor(morningPct)} ${Math.round(morningPct)}% → Peak: ${recoveryPeakColor(peakPct)} ${Math.round(peakPct)}%` +
        ` *(baseline: ${fmtBaseline(recoveryMorningBaselineBefore, (v) => `${Math.round(v)}%`)} → ${fmtBaseline(recoveryPeakBaselineBefore, (v) => `${Math.round(v)}%`)})*`,
    );
    const delta = peakPct - morningPct;
    lines.push(
      delta > 10
        ? "Recovered well as the day went on."
        : delta < -5
          ? "Recovery declined through the day — worth an early night."
          : "Recovery held steady through the day.",
    );
  } else {
    lines.push("No recovery data for this date.");
  }
  lines.push("");

  lines.push("**❤️ HRV** *(from sleep data — watch's own 7-day average is more accurate)*");
  if (hrv !== null) {
    const label = hrvLabel(hrv);
    lines.push(`${hrvColor(hrv)}${label ? ` ${label} —` : ""} ${hrv}ms *(normal range: 26–34ms)*`);
    lines.push(
      `7-day avg (from sleep API, not the watch's own figure): ${hrv7dAvg !== null ? `${Math.round(hrv7dAvg)}ms` : "n/a"} | Last night: ${hrv}ms`,
    );
  } else {
    lines.push("No HRV data for this date.");
  }
  lines.push("");

  const rampText = rampRate === null
    ? "not enough history yet (needs 7+ days)"
    : `${rampRateColor(rampRate)} ${rampRate >= 0 ? "+" : ""}${rampRate.toFixed(1)}/week — ${rampRateLabel(rampRate)}`;
  lines.push(`**📈 Progress — Fitness (CTL): ${ctl.toFixed(1)}** | Ramp rate: ${rampText}`);
  lines.push(`**🔄 Form (TSB): ${tsbColor(tsb)} ${tsb >= 0 ? "+" : ""}${tsb.toFixed(1)}** — ${tsbLabel(tsb)}`);
  if (isFirstRun && cfg.seedCtl === undefined && cfg.seedAtl === undefined) {
    lines.push("_First digest with no seed value — CTL/ATL start at 0 and take ~4-6 weeks to converge. Pass seedCtl/seedAtl (read off your watch) to skip this._");
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
