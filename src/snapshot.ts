// get_daily_snapshot: one call that answers "how was my day and the night before
// it", with the aggregation every consumer used to redo by hand — one row per
// sleep, naps apart from nights, the overnight recovery low, steps and energy
// of the local day, the day's workouts. Pure shaping functions plus a small
// orchestrator over SuuntoClient; every section can fail on its own.
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, nightOf, rowDate, workoutDate } from "./api.js";

const r1 = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const num = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

const J_PER_KCAL = 4184;

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const previousDate = (date: string): string => shiftDate(date, -1);
const nextDate = (date: string): string => shiftDate(date, 1);

// ---------- sleep ----------

function sleepRow(row: any) {
  const d = row?.entryData ?? {};
  return {
    sleepId: num(d.SleepId),
    bedtimeStart: d.BedtimeStart ?? null,
    bedtimeEnd: d.BedtimeEnd ?? null,
    durationS: num(d.Duration),
    deepS: num(d.DeepSleepDuration),
    lightS: num(d.LightSleepDuration),
    remS: num(d.REMSleepDuration),
    score: num(d.SleepQualityScore),
    avgHrv: num(d.AvgHRV),
    hrAvg: num(d.HRAvg),
    hrMin: num(d.HRMin),
    spo2Max: num(d.MaxSpo2),
    isNap: d.IsNap === true,
  };
}

// Rows are expected already deduplicated to one per SleepId (SuuntoClient.getSleep
// does that). IsNap is Suunto's own flag; it is true for any sleep shorter than
// about 3 hours, so a night still being recorded or a short night looks like a nap.
export function summarizeSleep(rows: any[]) {
  const sleeps = (rows ?? []).map(sleepRow);
  const nights = sleeps.filter((s) => !s.isNap);
  const naps = sleeps.filter((s) => s.isNap);
  const main = nights.reduce<ReturnType<typeof sleepRow> | null>((best, s) => ((s.durationS ?? 0) > (best?.durationS ?? -1) ? s : best), null);
  return {
    main,
    // Non-nap sleeps besides the main one (a night the watch split in two).
    otherNights: nights.filter((s) => s !== main),
    // Main plus other non-nap sleeps: the time slept at night.
    nightSleepS: nights.length ? nights.reduce((sum, s) => sum + (s.durationS ?? 0), 0) : null,
    naps,
  };
}

// ---------- recovery ----------

export function summarizeRecovery(rows: any[]) {
  const samples = (rows ?? [])
    .map((r) => ({ at: typeof r?.timestamp === "string" ? r.timestamp : null, balance: num(r?.entryData?.Balance), state: num(r?.entryData?.StressState) }))
    .filter((s) => s.balance !== null);
  if (samples.length === 0) return null;
  const lowest = samples.reduce((a, b) => (b.balance! < a.balance! ? b : a));
  const highest = samples.reduce((a, b) => (b.balance! > a.balance! ? b : a));
  const stateCounts: Record<string, number> = {};
  for (const s of samples) if (s.state !== null) stateCounts[String(s.state)] = (stateCounts[String(s.state)] ?? 0) + 1;
  return {
    samples: samples.length,
    // The lowest and highest recovery balance (0.0-1.0) of the local day, and
    // when. The low is not necessarily overnight: after an evening workout it
    // can fall in the evening.
    low: { balance: lowest.balance, at: lowest.at },
    high: { balance: highest.balance, at: highest.at },
    first: samples[0].balance,
    last: samples[samples.length - 1].balance,
    // Samples per StressState (one sample is half an hour on a full day).
    stressStateSamples: stateCounts,
  };
}

// ---------- steps and energy ----------

// null — not 0 — when Suunto has no sample for the date: no data is not a quiet day.
export function summarizeActivity(stats: any, date: string) {
  const metrics: any[] = Array.isArray(stats) ? stats : Array.isArray(stats?.payload) ? stats.payload : [];
  const total = (name: string): number | null => {
    const values = metrics
      .filter((m) => m?.Name === name)
      .flatMap((m) => (m.Sources ?? []).flatMap((s: any) => s.Samples ?? []))
      .filter((s: any) => typeof s?.TimeISO8601 === "string" && s.TimeISO8601.startsWith(date) && typeof s.Value === "number");
    return values.length ? values.reduce((sum: number, s: any) => sum + s.Value, 0) : null;
  };
  const steps = total("stepcount");
  const joules = total("energyconsumption");
  return {
    steps: steps === null ? null : Math.round(steps),
    // The day's energy exactly as /247 daily statistics reports it (joules / 4184).
    // Real days land around 700-1,500 kcal, well under a resting rate, so this
    // looks like ACTIVE energy rather than a total — not verified against the watch.
    energyKcal: joules === null ? null : Math.round(joules / J_PER_KCAL),
  };
}

// ---------- workouts ----------

export function summarizeWorkouts(list: any, date: string) {
  const items: any[] = Array.isArray(list?.payload) ? list.payload : [];
  return items
    .filter((w) => workoutDate(w) === date)
    .map((w) => {
      const offsetMs = (Number(w.timeOffsetInMinutes) || 0) * 60_000;
      const summary = (w.extensions ?? []).find((e: any) => e?.type === "SummaryExtension");
      return {
        workoutKey: w.workoutKey ?? null,
        activityId: w.activityId ?? null,
        startLocal: typeof w.startTime === "number" ? new Date(w.startTime + offsetMs).toISOString().slice(11, 16) : null,
        totalTimeS: r1(w.totalTime),
        kcal: num(w.energyConsumption),
        hrAvg: num(w.hrdata?.workoutAvgHR),
        hrMax: num(w.hrdata?.workoutMaxHR),
        tss: r1((w.tssList ?? []).find((t: any) => t?.calculationMethod === "HR")?.trainingStressScore ?? w.tss?.trainingStressScore),
        guide: summary?.apps?.[0]?.name ?? null,
        // true when get_workout_laps has laps to read for it
        hasLaps: Array.isArray(w.extensionTypes) && w.extensionTypes.includes("MANUALLAP"),
      };
    })
    .sort((a, b) => String(a.startLocal).localeCompare(String(b.startLocal)));
}

// ---------- the call ----------

export const MAX_SNAPSHOT_DAYS = 14;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.payload ?? []);

// The same per-day shape as buildSnapshot, for from..to inclusive, from ONE
// request per section instead of one per day (Suunto rate-limits with a 401).
export async function buildSnapshotRange(client: SuuntoClient, from: string, to: string) {
  if (from > to) throw new Error(`date (${from}) must be on or before to (${to}).`);
  const count = daysBetween(from, to);
  if (count > MAX_SNAPSHOT_DAYS) throw new Error(`A snapshot range is limited to ${MAX_SNAPSHOT_DAYS} days; ${from}..${to} is ${count}.`);

  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: err?.message ?? String(err) });
      return null;
    }
  };

  const bounds = dayFetchBounds(from, to);
  const [sleepRes, recoveryRes, stats, workouts] = await Promise.all([
    section("sleep", () => client.listSleep(previousDate(from), previousDate(to))),
    section("recovery", () => client.listRecovery(from, to)),
    section("activity", () => client.getDailyStats(`${from}T00:00:00`, `${to}T23:59:59`)),
    section("workouts", () => client.listWorkouts({ since: bounds.from, until: bounds.to, limit: Math.min(10 * count, 150) })),
  ]);
  const nights = sleepRes === null ? null : groupBy(rowsOf(sleepRes), (r) => nightOf(r) ?? "");
  const recovery = recoveryRes === null ? null : groupBy(rowsOf(recoveryRes), rowDate);

  const days = [];
  for (let date = from, i = 0; i < count; date = nextDate(date), i++) {
    const nightDate = previousDate(date);
    days.push({
      date,
      sleepNightOf: nightDate,
      sleep: nights === null ? null : summarizeSleep(nights.get(nightDate) ?? []),
      recovery: recovery === null ? null : summarizeRecovery(recovery.get(date) ?? []),
      activity: stats === null ? null : summarizeActivity(stats, date),
      workouts: workouts === null ? null : summarizeWorkouts(workouts, date),
    });
  }
  return { from, to, days, errors };
}

export async function buildSnapshot(client: SuuntoClient, date: string) {
  const nightOf = previousDate(date);
  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: err?.message ?? String(err) });
      return null;
    }
  };

  const bounds = dayFetchBounds(date, date);
  const [sleepRows, recoveryRows, stats, workouts] = await Promise.all([
    section("sleep", () => client.getSleep(nightOf)),
    section("recovery", () => client.getRecovery(date)),
    section("activity", () => client.getDailyStats(`${date}T00:00:00`, `${date}T23:59:59`)),
    section("workouts", () => client.listWorkouts({ since: bounds.from, until: bounds.to, limit: 30 })),
  ]);

  return {
    date,
    // The night that led into `date`: sleeps that began between noon on the
    // previous day and noon on `date`.
    sleepNightOf: nightOf,
    sleep: sleepRows === null ? null : summarizeSleep(Array.isArray(sleepRows) ? sleepRows : (sleepRows as any)?.payload ?? []),
    recovery: recoveryRows === null ? null : summarizeRecovery(Array.isArray(recoveryRows) ? recoveryRows : (recoveryRows as any)?.payload ?? []),
    activity: stats === null ? null : summarizeActivity(stats, date),
    workouts: workouts === null ? null : summarizeWorkouts(workouts, date),
    // A section that failed is null above and explained here; the rest is still good.
    errors,
  };
}
