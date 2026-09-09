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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { SuuntoClient } from "./api.js";

// Evaluated per-call, not cached at module load, so tests can override it
// via env var without touching the real user's state file.
function statePath(): string {
  return process.env.SUUNTO_HEALTH_EXPORT_STATE_PATH ?? join(homedir(), ".suunto-mcp", "health-export-state.json");
}
const MAX_WINDOW_DAYS = 28; // Suunto daily-stats API limit

function loadLastExportedDate(): string | undefined {
  const path = statePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")).lastDate;
  } catch {
    return undefined;
  }
}

export function saveLastExportedDate(date: string): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ lastDate: date }, null, 2));
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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
    rows.push(`${date},steps,${Math.round(steps)},`);
    if (date > observedMaxDate) observedMaxDate = date;
  }

  // Never let the watermark reach today — today's total is still
  // accumulating, so treating it as "done" would freeze whatever partial
  // count happened to exist at export time and never re-sync it. Cap to
  // yesterday; today keeps getting re-exported on every run until it's
  // genuinely a past day, at which point the next run locks it in for real.
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
