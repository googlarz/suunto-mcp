// Bridges Suunto step data into health-skill's generic CSV import
// (date,metric,value,unit — see health-skill's wearable_import.py). Steps
// are the only metric with a genuine match: Suunto's daily-stats endpoint
// only exposes stepcount/energyconsumption, and get_recovery's "Balance"
// (0.0-1.0) is a normalized score, not literal HRV in ms — mislabeling it
// as "hrv" would corrupt health-skill's trend math, so it's deliberately
// left out. HRV/RHR/sleep already reach Claude directly via get_recovery/
// get_sleep at prompt time (e.g. /gym's recovery gate) — this bridge is
// only for what health-skill's own structured vitals store can honestly
// hold.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { SuuntoClient, localDate } from "./api.js";

// Evaluated per-call, not cached at module load, so tests can override it
// via env var without touching the real user's state file.
function statePath(): string {
  return process.env.SUUNTO_HEALTH_EXPORT_STATE_PATH ?? join(homedir(), ".suunto-mcp", "health-export-state.json");
}
const MAX_WINDOW_DAYS = 28; // Suunto daily-stats API limit

// A state file that exists but can't be read is NOT a first run: treating it as
// one would re-export the last 27 days, and health-skill stores every row it is
// given, so they would all be duplicated. Stop and say so instead.
function loadLastExportedDate(): string | undefined {
  const path = statePath();
  if (!existsSync(path)) return undefined;
  let lastDate: unknown;
  try {
    lastDate = JSON.parse(readFileSync(path, "utf8")).lastDate;
  } catch (err: any) {
    throw new Error(unreadableState(path, err.message));
  }
  if (typeof lastDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
    throw new Error(unreadableState(path, "it has no valid lastDate"));
  }
  return lastDate;
}

function unreadableState(path: string, why: string): string {
  return (
    `The sync state file ${path} exists but can't be used (${why}). Fix it, or delete it to start over — ` +
    `but starting over re-exports the last ${MAX_WINDOW_DAYS - 1} days, and health-skill would store those days a second time.`
  );
}

export function saveLastExportedDate(date: string): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  // Temp file + rename, so a crash can't leave a truncated state file.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ lastDate: date }, null, 2));
  renameSync(tmp, path);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Local date: TimeISO8601 stamps in daily stats are local, so "is this day
// finished?" has to be judged against the local calendar.
function today(): string {
  return localDate(0);
}

interface DailyStatsSample {
  TimeISO8601: string;
  Value: number | null;
}
interface DailyStatsSource {
  Samples: DailyStatsSample[];
}
interface DailyStatsEntry {
  Name: string;
  Sources: DailyStatsSource[];
}

// Sums step samples per calendar date across sources (safe with a single
// watch; multiple concurrent Suunto devices would double-count, but that's
// not a supported setup anyway).
function extractStepsByDate(entries: DailyStatsEntry[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const entry of entries) {
    if (entry.Name !== "stepcount") continue;
    for (const source of entry.Sources ?? []) {
      for (const sample of source.Samples ?? []) {
        if (sample.Value === null || sample.Value === undefined) continue;
        const date = sample.TimeISO8601.slice(0, 10);
        byDate.set(date, (byDate.get(date) ?? 0) + sample.Value);
      }
    }
  }
  return byDate;
}

export interface ExportHealthOptions {
  healthRoot: string;
  personId?: string;
  since?: string;
}

export async function exportHealthCsv(
  cfg: Config,
  opts: ExportHealthOptions,
): Promise<{ csvPath: string; rowCount: number; skippedNote?: string; maxDate?: string }> {
  const client = new SuuntoClient(cfg);
  const end = today();
  let start = opts.since ?? loadLastExportedDate() ?? addDays(end, -MAX_WINDOW_DAYS);

  let skippedNote: string | undefined;
  // API rejects windows of exactly MAX_WINDOW_DAYS ("must be less than 28
  // days after startdate"), so clamp one day tighter than the documented max.
  const earliestAllowed = addDays(end, -(MAX_WINDOW_DAYS - 1));
  if (start < earliestAllowed) {
    skippedNote = `Requested since=${start}, but Suunto's daily-stats API only allows a window under ${MAX_WINDOW_DAYS} days — clamped to ${earliestAllowed}.`;
    start = earliestAllowed;
  }

  const stats = await client.getDailyStats(`${start}T00:00:00`, `${end}T23:59:59`);
  const stepsByDate = extractStepsByDate(stats.payload ?? stats ?? []);

  // The persisted watermark, always loaded (used as a floor below so an
  // explicit --since can never regress it). The dedupe *filter*, though,
  // only applies on the normal incremental path — an explicit --since
  // means the caller wants that window re-exported regardless of what was
  // already synced, so skipping dates against the watermark here would
  // silently drop every date they asked for.
  const savedWatermark = loadLastExportedDate();
  const lastExported = opts.since ? undefined : savedWatermark;
  const rows: string[] = ["date,metric,value,unit"];
  let observedMaxDate = lastExported ?? start;
  for (const [date, steps] of [...stepsByDate.entries()].sort()) {
    if (lastExported && date <= lastExported) continue; // avoid re-import (no dedupe on health-skill's side)
    // health-skill inserts every CSV row blindly, so a partial total for a
    // day still in progress would be stored and then stored again as the
    // final total the next day. Only completed days are exported.
    if (date >= end) continue;
    rows.push(`${date},steps,${Math.round(steps)},`);
    if (date > observedMaxDate) observedMaxDate = date;
  }

  // Never let the watermark reach today — today's total is still
  // accumulating (and is not exported above), so the next run picks it up
  // once it is a past day. Cap to yesterday.
  const watermarkCeiling = addDays(end, -1);
  let maxDate = observedMaxDate > watermarkCeiling ? watermarkCeiling : observedMaxDate;
  if (savedWatermark && savedWatermark > maxDate) maxDate = savedWatermark;

  const inboxDir = opts.personId
    ? join(opts.healthRoot, "people", opts.personId, "inbox", "wearable")
    : join(opts.healthRoot, "inbox", "wearable");
  mkdirSync(inboxDir, { recursive: true });
  const csvPath = join(inboxDir, `suunto-steps-${end}.csv`);
  writeFileSync(csvPath, rows.join("\n") + "\n");

  // Watermark is NOT saved here — the caller must only commit it after the
  // downstream health-skill import actually succeeds (see cli.ts). Saving
  // it here would mark dates as synced even when the import step fails.
  return { csvPath, rowCount: rows.length - 1, skippedNote, maxDate: rows.length > 1 ? maxDate : undefined };
}

// Runs the export, then invokes health-skill's own import-wearable command
// on the file — one call does export + import instead of two manual steps.
export function importIntoHealthSkill(csvPath: string, healthRoot: string, personId?: string): string {
  const scriptPath = join(homedir(), ".claude", "skills", "health-skill", "scripts", "care_workspace.py");
  const args = ["import-wearable", "--root", healthRoot, "--file", csvPath];
  if (personId) args.push("--person-id", personId);
  return execFileSync("python3", [scriptPath, ...args], { encoding: "utf8" });
}
