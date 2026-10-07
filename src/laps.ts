// Shapes a /v3/workouts/{key}?extensions=ManualLapStreamExtension,... response
// into the compact lap table get_workout_laps returns. The raw response is
// ~30-45 KB for a guided strength session (~760 B per lap, mostly always-null
// totals); the table is ~2.5 KB. The same laps via the FIT file are ~550 KB.

export const LAP_EXTENSIONS = ["ManualLapStreamExtension", "SummaryExtension", "IntensityExtension"];

export const LAP_COLUMNS = ["i", "startOffsetS", "durationS", "hrAvg", "hrMax", "hrMin", "kcal", "kind", "label"] as const;

export type LapKind = "rest" | "done" | "step";

const r1 = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const r0 = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);

// The label is the text of the guide step that was active during the lap
// (totals.intervalNotes). Guide steps put a form feed or newline between
// their lines; a workout with no guide has null labels.
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw
    .split(/[\f\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" | ");
  return label === "" ? null : label;
}

// Rest laps carry "Next: ..." — at the start, or after "<restSec>s target · "
// when the guide was pushed with restMode "stopwatch". The final step of a
// pushed guide is "Session complete". Prep and set laps both look like
// "<name> | <detail>" and cannot be told apart by text — only by their position
// after a rest or the exercise start.
export function lapKind(label: string | null): LapKind | null {
  if (label === null) return null;
  if (/(^|·\s*)Next:/.test(label)) return "rest";
  if (/^Session complete/.test(label)) return "done";
  return "step";
}

function extension(payload: any, type: string): any | undefined {
  return Array.isArray(payload?.extensions) ? payload.extensions.find((e: any) => e?.type === type) : undefined;
}

export interface LapCheck {
  code: "duplicate-rest" | "no-session-complete" | "no-heart-rate" | "unlabelled-laps";
  detail: string;
}

// Things that make a lap table untrustworthy for positional reading, found from
// the table alone. Every code has a known cause on the watch (Suunto Vertical 2
// user guide): a button lock stops lap presses, Tour battery mode switches heart
// rate tracking off, a restart ends the exercise early.
export function lapChecks(rows: any[][]): LapCheck[] {
  const checks: LapCheck[] = [];
  const KIND = 7, LABEL = 8;
  if (rows.length === 0) return checks;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][KIND] === "rest" && rows[i - 1][KIND] === "rest" && rows[i][LABEL] === rows[i - 1][LABEL]) {
      checks.push({ code: "duplicate-rest", detail: `laps ${rows[i - 1][0]} and ${rows[i][0]} are both "${rows[i][LABEL]}" — a set lap is missing or a rest was split` });
    }
  }

  // A lap pressed after the guide's final "Session complete" lap has no label by
  // nature; only unlabelled laps before it point at a problem.
  const doneAt = rows.findIndex((r) => r[KIND] === "done");
  const guided = doneAt === -1 ? rows : rows.slice(0, doneAt);
  const labelled = rows.filter((r) => r[LABEL] !== null).length;
  const unlabelled = guided.filter((r) => r[LABEL] === null).length;
  if (labelled > 0 && unlabelled > 0) {
    checks.push({ code: "unlabelled-laps", detail: `${unlabelled} of ${rows.length} laps have no guide label (a lap pressed outside the guide, or the guide ended)` });
  }
  if (labelled > 0 && !rows.some((r) => r[KIND] === "done")) {
    checks.push({ code: "no-session-complete", detail: "the guide's final 'Session complete' lap is missing — the session ended early, the buttons were locked, or the watch restarted" });
  }
  if (rows.every((r) => r[3] === null && r[4] === null && r[5] === null)) {
    checks.push({ code: "no-heart-rate", detail: "no lap has heart rate data (heart rate tracking was off, e.g. battery mode Tour)" });
  }
  return checks;
}

export function shapeLaps(response: any) {
  const payload = response?.payload ?? response;
  const workoutStart: number | undefined = typeof payload?.startTime === "number" ? payload.startTime : undefined;

  const markers: any[] = extension(payload, "ManualLapStreamExtension")?.markers ?? [];
  const rows = markers.map((m, i) => {
    const t = m?.totals ?? {};
    const label = cleanLabel(t.intervalNotes);
    return [
      i + 1,
      workoutStart !== undefined && typeof m?.startTime === "number" ? r1((m.startTime - workoutStart) / 1000) : null,
      r1(t.duration),
      r0(t.hr?.avg),
      r0(t.hr?.max),
      r0(t.hr?.min),
      r0(t.energy),
      lapKind(label),
      label,
    ];
  });

  const summary = extension(payload, "SummaryExtension");
  const app = Array.isArray(summary?.apps) ? summary.apps[0] : undefined;
  const zones = extension(payload, "IntensityExtension")?.zones?.heartRate;

  return {
    workoutKey: payload?.workoutKey ?? null,
    activityId: payload?.activityId ?? null,
    startTime: workoutStart ?? null,
    totalTimeS: r1(payload?.totalTime),
    // Only the id and title Suunto records — it is not resolved against
    // list_guides, because most old workouts point at guides since deleted.
    guide: app?.id ? { id: app.id, name: app.name ?? null } : null,
    tss: Array.isArray(payload?.tssList)
      ? payload.tssList.map((t: any) => ({ method: t?.calculationMethod ?? null, value: r1(t?.trainingStressScore) }))
      : [],
    pte: summary?.pte ?? null,
    peakEpoc: summary?.peakEpoc ?? null,
    // Suunto doesn't document the unit of pte, peakEpoc or recoveryTime, so
    // they are passed through under their own names with no unit claimed.
    recoveryTime: summary?.recoveryTime ?? null,
    hrZoneTimeS: zones ? [1, 2, 3, 4, 5].map((z) => r0(zones[`zone${z}`]?.totalTime)) : null,
    // The answer to the watch's "How was it?" question; null when it was skipped.
    // Passed through as Suunto sends it — the scale is not documented in the API.
    feeling: summary?.feeling ?? null,
    lapCount: rows.length,
    checks: lapChecks(rows),
    laps: { cols: LAP_COLUMNS, rows },
  };
}
