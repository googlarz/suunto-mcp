// get_weekly_report: one finished Monday-to-Sunday week assembled from the builders the other tools use (snapshot range,
// training load, baselines, exercise history, the plan, tag effects) into a structured result and a self-contained
// markdown text meant to be shared. Toward Suunto it only reads. `save: true` additionally writes the markdown to
// ~/.suunto-mcp/reports/week-<Monday>.md (SUUNTO_REPORTS_DIR moves it); in demo mode that store lives in memory.
// The markdown carries no account id, token, workout key or file path; a section without enough data says so.
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { localDate } from "./api.js";
import { writeNew } from "./archive.js";
import { METRICS, MIN_BAND_N, buildBaselines, quantile } from "./baselines.js";
import { buildExerciseHistory } from "./history.js";
import type { JournalEntry } from "./journal.js";
import type { PlanStore } from "./plan.js";
import { isValidCalendarDate } from "./schema-validate.js";
import { buildSnapshotRange } from "./snapshot.js";
import { buildTagEffects } from "./tag-effects.js";
import { addDays, buildTrainingLoad, weekStart } from "./training-load.js";
import { DEMO_NOTICE } from "./demo.js";

// A week's median needs at least this many days with a value (the rule get_baselines uses for last7Median).
export const MIN_WEEK_DAYS = 4;
const BASELINE_DAYS = 28;
const LOAD_DAYS = 28;

export const reportsDir = (): string => process.env.SUUNTO_REPORTS_DIR ?? join(homedir(), ".suunto-mcp", "reports");

// ---------- the week ----------

// `week` is the Monday of a finished week; without it, the last full Monday-to-Sunday week before today.
export function weekRange(week: string | undefined, today: string): { from: string; to: string } {
  const from = week ?? addDays(weekStart(today), -7);
  if (!isValidCalendarDate(from)) throw new Error(`"${from}" is not a valid calendar date (YYYY-MM-DD).`);
  if (weekStart(from) !== from) throw new Error(`week must be a Monday; ${from} is not (the Monday of its week is ${weekStart(from)}).`);
  const to = addDays(from, 6);
  if (to >= today) throw new Error(`The week ${from}..${to} has not ended yet (today is ${today}): a report needs a finished week. The latest one starts on ${addDays(weekStart(today), -7)}.`);
  return { from, to };
}

// ---------- the pure comparisons ----------

export function weekMedian(values: (number | null)[]): { n: number; median: number | null } {
  const have = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { n: have.length, median: have.length >= MIN_WEEK_DAYS ? quantile(have, 0.5) : null };
}

// Against the middle half of the user's own band; the edges count as within (as get_baselines' latestVsBand).
export function positionOf(median: number | null, band: { p25: number | null; p75: number | null }): "below" | "within" | "above" | null {
  if (median === null || band.p25 === null || band.p75 === null) return null;
  return median < band.p25 ? "below" : median > band.p75 ? "above" : "within";
}

// ---------- the store ----------

export type SaveStatus = "written" | "unchanged" | "overwritten";
export interface ReportStore {
  // Never replaces a different existing file unless `overwrite`; throws instead. null path: held in memory.
  save(name: string, markdown: string, overwrite: boolean): Promise<{ status: SaveStatus; path: string | null }>;
}

export function fileReportStore(dir = reportsDir()): ReportStore {
  return {
    async save(name, markdown, overwrite) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, name);
      const data = Buffer.from(markdown, "utf8");
      let existing: Buffer | null = null;
      try {
        if (!(await lstat(path)).isFile()) throw new Error(`${path} is not a regular file; left untouched`);
        existing = await readFile(path);
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
      if (existing === null) {
        await writeNew(path, data, false);
        return { status: "written", path };
      }
      if (existing.equals(data)) return { status: "unchanged", path };
      if (!overwrite) throw new Error(`${path} already exists with different content; pass overwrite: true to replace it (it is left untouched)`);
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        await writeFile(tmp, data, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return { status: "overwritten", path };
    },
  };
}

// Demo mode: the same rules, nothing on disk.
export function memoryReportStore(): ReportStore {
  const held = new Map<string, string>();
  return {
    async save(name, markdown, overwrite) {
      const had = held.get(name);
      if (had === markdown) return { status: "unchanged", path: null };
      if (had !== undefined && !overwrite) throw new Error(`${name} already exists with different content; pass overwrite: true to replace it`);
      held.set(name, markdown);
      return { status: had === undefined ? "written" : "overwritten", path: null };
    },
  };
}

// ---------- the report ----------

export interface ReportDeps {
  planStore: PlanStore;
  reportStore: ReportStore;
  now?: Date;
  loadJournal?: () => Promise<Record<string, JournalEntry>>;
  demo?: boolean;
}

const rowOf = (m: any) => METRICS.find((x) => x.name === m)!;
const WEEK_METRICS: Record<string, (day: any) => number | null> = {
  sleepDurationS: (d) => d.sleep?.main?.durationS ?? null,
  sleepScore: (d) => d.sleep?.main?.score ?? null,
  hrv: (d) => d.sleep?.main?.avgHrv ?? null,
  recoveryMorning: (d) => d.recovery?.morning?.balance ?? null,
  steps: (d) => d.activity?.steps ?? null,
};

export async function buildWeeklyReport(
  client: SuuntoClient,
  opts: { week?: string; save?: boolean; overwrite?: boolean },
  deps: ReportDeps,
) {
  if (opts.overwrite === true && opts.save !== true) throw new Error("overwrite only applies together with save: true.");
  const today = localDate(0, deps.now ?? new Date());
  const { from, to } = weekRange(opts.week, today);

  const errors: { section: string; error: string }[] = [];
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err: any) {
      errors.push({ section: name, error: String(err?.message ?? err).slice(0, 300) });
      return null;
    }
  };

  // One after the other, not in parallel: the sections together are about 30 requests.
  const snapshot = await section("snapshot", () => buildSnapshotRange(client, from, to));
  if (snapshot) errors.push(...snapshot.errors);
  const days: any[] | null = snapshot?.days ?? null;
  const load = await section("training-load", () => buildTrainingLoad(client, { date: to, days: LOAD_DAYS }));
  const baselines = await section("baselines", () => buildBaselines(client, { date: from, days: BASELINE_DAYS }));
  if (baselines) errors.push(...baselines.errors);
  const history = await section("history", async () => {
    const h = await buildExerciseHistory(client, { weeks: 1, date: to }, { loadJournal: deps.loadJournal }); // no name: the index of exercises
    if (!("exercises" in h)) throw new Error("exercise index expected");
    return h;
  });
  if (history) errors.push(...history.errors.map((e) => ({ section: "history", error: `${e.date}: ${e.error}` })));
  const tags = await section("tag-effects", () => buildTagEffects(client, { date: addDays(to, 1) }, { loadJournal: deps.loadJournal }));
  if (tags) errors.push(...tags.errors);

  // ---- workouts ----
  const workoutsOk = days !== null && days[0]?.workouts !== null; // null: that section failed (a reached limit is only a listed error)
  const workouts = !workoutsOk
    ? null
    : (() => {
        const perDay = days!.map((d) => ({ date: d.date as string, sessions: (d.workouts ?? []) as any[] }));
        const all = perDay.flatMap((d) => d.sessions);
        return {
          count: all.length,
          totalTimeS: Math.round(all.reduce((s, w) => s + (w.totalTimeS ?? 0), 0)),
          kcal: all.reduce((s, w) => s + (w.kcal ?? 0), 0),
          // the table's rows and this total are the same numbers (the snapshot's per-workout TSS); the load model reads another field
          tss: Math.round(all.reduce((s, w) => s + (w.tss ?? 0), 0) * 10) / 10,
          noTss: all.filter((w) => typeof w.tss !== "number").length,
          restDays: perDay.filter((d) => d.sessions.length === 0).length,
          days: perDay.map((d) => ({ date: d.date, sessions: d.sessions.map((w) => ({ startLocal: w.startLocal, totalTimeS: w.totalTimeS, tss: w.tss, guide: w.guide })) })),
        };
      })();

  // ---- sleep and recovery against the user's own band before the week ----
  const recovery =
    days === null
      ? null
      : {
          baselineFrom: baselines?.from ?? null,
          baselineTo: baselines?.to ?? null,
          metrics: Object.fromEntries(
            Object.entries(WEEK_METRICS).map(([name, pick]) => {
              const { n, median } = weekMedian(days.map(pick));
              const round = rowOf(name).round;
              const band = baselines?.metrics?.[name] ?? null;
              return [
                name,
                {
                  unavailable: rowOf(name).needs.some((sec) => errors.some((e) => e.section === sec)),
                  n,
                  median: median === null ? null : round(median),
                  baseline: band && { n: band.n, median: band.median, p25: band.p25, p75: band.p75 },
                  vsBaseline: band ? positionOf(median, band) : null,
                },
              ];
            }),
          ),
        };
  const steps = days === null ? null : days.map((d) => d.activity?.steps ?? null).filter((v): v is number => v !== null);

  // ---- training load at the end of the week ----
  const weekOf = (start: string) => load?.weeks.find((w) => w.weekStart === start);
  const loadOut =
    load === null
      ? null
      : {
          asOf: to,
          ctl: load.current.ctl,
          atl: load.current.atl,
          tsb: load.current.tsb,
          rampRate7d: load.current.rampRate7d,
          weekTss: weekOf(from)?.tss ?? 0,
          previousWeekTss: weekOf(addDays(from, -7))?.tss ?? null,
          notes: load.notes.filter((n) => /Little history|Reached the|No workouts at all|no TSS/.test(n)),
          // what the shared markdown says about those notes, in plain words
          flags: { littleHistory: load.notes.some((n) => /^Little history/.test(n)), limitReached: load.notes.some((n) => /^Reached the/.test(n)) },
        };

  // ---- the guided strength sessions of the week ----
  const strength = history && { sessions: history.sessions, exercises: history.exercises.map((e) => ({ name: e.name, sessions: e.sessions, lastDetail: e.lastDetail })), pending: history.pending };

  // ---- the plan: any workout on a planned date is done (as in get_catchup) ----
  let plan: null | { goal: string; planned: number; done: number; missed: number; adherencePct: number | null; items: { date: string; title: string; status: "done" | "missed" }[] } = null;
  const stored = await section("plan", () => deps.planStore.load());
  if (stored && workouts) {
    const trained = new Set(workouts.days.filter((d) => d.sessions.length > 0).map((d) => d.date));
    const items = stored.plan.sessions
      .filter((s) => s.date >= from && s.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((s) => ({ date: s.date, title: s.title, status: trained.has(s.date) ? ("done" as const) : ("missed" as const) }));
    const done = items.filter((i) => i.status === "done").length;
    plan = { goal: stored.plan.goal, planned: items.length, done, missed: items.length - done, adherencePct: items.length === 0 ? null : Math.round((100 * done) / items.length), items };
  } else if (stored) {
    errors.push({ section: "plan", error: "the week's workouts could not be read, so adherence is unknown" });
  }

  // ---- tag effects: only a tag whose verdict is not insufficient ----
  const tagEffects = tags && {
    window: { from: tags.from, to: tags.to },
    tags: tags.tags.filter((t) => t.verdict !== "insufficient").map((t) => ({ tag: t.tag, verdict: t.verdict, taggedNights: t.taggedNights, untaggedNights: t.untaggedNights, statement: t.statement })),
    insufficientTags: tags.tags.filter((t) => t.verdict === "insufficient").length,
    minNightsPerGroup: tags.thresholds.minTaggedNights,
  };

  const report = { week: { from, to }, workouts, recovery: recovery && { ...recovery, stepsTotal: steps && steps.length ? steps.reduce((a, b) => a + b, 0) : null, stepsDays: steps ? steps.length : 0 }, load: loadOut, strength, plan, tagEffects };
  const markdown = renderMarkdown(report, errors, deps.demo === true);

  let saved: null | { status: SaveStatus | "refused"; path: string | null; reason?: string } = null;
  if (opts.save === true) {
    try {
      saved = await deps.reportStore.save(`week-${from}.md`, markdown, opts.overwrite === true);
    } catch (err: any) {
      const reason = String(err?.message ?? err).slice(0, 400);
      saved = { status: "refused", path: null, reason };
      errors.push({ section: "save", error: reason });
    }
  }

  return {
    ...report,
    markdown,
    saved,
    errors,
    notes: [
      "Read-only toward Suunto. The markdown is meant to be shared: it holds no account id, token, workout key or file path, only the week's own numbers, plan goal and session titles, and journal tag names.",
      "Heavy: the sections together read about 30 requests (snapshot, training load with its warm-up, baselines, at most 8 uncached guided sessions for the strength section, tag effects).",
    ],
  };
}

// ---------- markdown ----------

const fmtMin = (min: number): string => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`);
const fmtDur = (s: number | null | undefined): string => (s === null || s === undefined ? "n/a" : fmtMin(Math.round(s / 60)));
const fmtNum = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: digits }));
const METRIC_LABEL: Record<string, { label: string; fmt: (n: number | null) => string }> = {
  sleepDurationS: { label: "Sleep duration", fmt: (n) => fmtDur(n) },
  sleepScore: { label: "Sleep score", fmt: (n) => fmtNum(n, 0) },
  hrv: { label: "HRV (ms)", fmt: (n) => fmtNum(n, 0) },
  recoveryMorning: { label: "Recovery on waking", fmt: (n) => (n === null ? "n/a" : `${Math.round(n * 100)} %`) },
  steps: { label: "Steps per day", fmt: (n) => fmtNum(n, 0) },
};

// Text the user wrote (guide, exercise and tag names, plan goal and titles) goes into a text that is shared and may be shown
// as markdown or HTML, so it is data and never markup: whitespace (newlines too) collapses to single spaces, `\`, backtick,
// `|`, `[` and `]` are backslash-escaped, `&`, `<` and `>` become entities, and a marker that would start a heading, list
// item or quote at the beginning of the text is escaped.
export function mdText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`|[\]]/g, (c) => `\\${c}`)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^(#{1,6}|[-+*])(?=\s|$)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2");
}

export function renderMarkdown(r: any, errors: { section: string }[], demo: boolean): string {
  const out: string[] = [`# Weekly training report: ${r.week.from} to ${r.week.to}`, ""];
  if (demo) out.push(`> ${DEMO_NOTICE} Every number below is generated.`, "");
  const down = [...new Set(errors.map((e) => e.section))];

  // Each row shows whole minutes, so the total is the sum of those rounded rows: a reader adding the column gets the Total.
  const workoutMinutes = r.workouts === null ? 0 : r.workouts.days.reduce((n: number, d: any) => n + d.sessions.reduce((m: number, w: any) => m + Math.round((w.totalTimeS ?? 0) / 60), 0), 0);

  out.push("## Summary", "");
  if (r.workouts === null) out.push("- Workouts: unavailable (the data could not be read).");
  else if (r.workouts.count === 0) out.push("- No workouts this week.");
  else out.push(`- ${r.workouts.count} workout${r.workouts.count === 1 ? "" : "s"}, ${fmtMin(workoutMinutes)} in total, ${fmtNum(r.workouts.kcal, 0)} kcal; ${r.workouts.restDays} day${r.workouts.restDays === 1 ? "" : "s"} without a workout.`);
  if (r.recovery === null) out.push("- Sleep, recovery and steps: unavailable.");
  else {
    const m = r.recovery.metrics;
    out.push(`- Sleep: ${m.sleepDurationS.unavailable ? "unavailable" : m.sleepDurationS.median === null ? `insufficient data (${m.sleepDurationS.n} of 7 nights)` : `median ${fmtDur(m.sleepDurationS.median)} over ${m.sleepDurationS.n} nights`}.`);
    out.push(`- Steps: ${m.steps.unavailable ? "unavailable" : r.recovery.stepsTotal === null ? "insufficient data" : `${fmtNum(r.recovery.stepsTotal, 0)} over ${r.recovery.stepsDays} of 7 days`}.`);
  }
  if (r.load) out.push(`- Training load at the end of the week: Fitness (CTL) ${fmtNum(r.load.ctl)}, Fatigue (ATL) ${fmtNum(r.load.atl)}, Form (TSB) ${fmtNum(r.load.tsb)}.`);

  out.push("", "## Workouts", "");
  if (r.workouts === null) out.push("Unavailable.");
  else if (r.workouts.count === 0) out.push("No workouts this week.");
  else {
    out.push("| Date | Start | Duration | TSS | Guide |", "|---|---|---|---|---|");
    for (const d of r.workouts.days) for (const w of d.sessions) out.push(`| ${d.date} | ${w.startLocal ?? "n/a"} | ${fmtDur(w.totalTimeS)} | ${fmtNum(w.tss)} | ${w.guide ? mdText(w.guide) : ""} |`);
    out.push(`| Total | | ${fmtMin(workoutMinutes)} | ${fmtNum(r.workouts.tss)} | |`);
  }

  out.push("", "## Sleep and recovery against your usual", "");
  if (r.recovery === null) out.push("Unavailable.");
  else {
    out.push(`Usual = the middle half (25th to 75th percentile) of your own ${BASELINE_DAYS} days before the week${r.recovery.baselineFrom ? ` (${r.recovery.baselineFrom} to ${r.recovery.baselineTo})` : ""}; the week's value is its median over the days with a value (at least ${MIN_WEEK_DAYS}).`, "");
    out.push("| Metric | This week | Your usual | Against usual |", "|---|---|---|---|");
    for (const [name, m] of Object.entries<any>(r.recovery.metrics)) {
      const { label, fmt } = METRIC_LABEL[name];
      const band = m.baseline && m.baseline.p25 !== null ? `${fmt(m.baseline.p25)} to ${fmt(m.baseline.p75)}` : `insufficient data (needs ${MIN_BAND_N} days)`;
      const week = m.median === null ? `insufficient data (${m.n} of 7 days)` : `${fmt(m.median)} (${m.n} days)`;
      out.push(m.unavailable ? `| ${label} | unavailable | unavailable | n/a |` : `| ${label} | ${week} | ${band} | ${m.vsBaseline ?? "n/a"} |`);
    }
  }

  out.push("", "## Training load", "");
  if (r.load === null) out.push("Unavailable.");
  else {
    out.push(`- Fitness (CTL) ${fmtNum(r.load.ctl)}, Fatigue (ATL) ${fmtNum(r.load.atl)}, Form (TSB) ${fmtNum(r.load.tsb)} at the end of ${r.load.asOf}.`);
    if (r.load.rampRate7d !== null) out.push(`- Fitness changed by ${fmtNum(r.load.rampRate7d)} over the 7 days.`);
    // one source for the figure: the workouts table's own rows; the load model's figure (another TSS field of Suunto's) is only
    // stated when it differs, with the reason
    if (r.workouts) {
      out.push(`- Training stress this week: ${fmtNum(r.workouts.tss)} (the sum of the workouts above${r.workouts.noTss > 0 ? `; ${r.workouts.noTss} without TSS counted as 0` : ""}).`);
      if (Math.abs(r.load.weekTss - r.workouts.tss) > 0.5) out.push(`- The load model behind the Fitness numbers counted ${fmtNum(r.load.weekTss)} for the week: it reads another TSS field of Suunto's, which can differ from the per-workout values above.`);
    } else out.push(`- Training stress this week (load model): ${fmtNum(r.load.weekTss)}.`);
    if (r.load.previousWeekTss !== null) out.push(`- The week before (load model): ${fmtNum(r.load.previousWeekTss)}.`);
    if (r.load.flags.littleHistory) out.push("- Fitness (CTL) needs about 4 to 6 weeks of history to settle, so it may read low.");
    if (r.load.flags.limitReached) out.push("- Some older workouts may be missing from the load calculation, so fitness may read low.");
    out.push("- Computed from each workout's TSS; CTL can be about 1 point off the watch.");
  }

  out.push("", "## Strength", "");
  if (r.strength === null) out.push("Unavailable.");
  else if (r.strength.exercises.length === 0) out.push("No guided strength sessions this week.");
  else {
    out.push(`${r.strength.sessions} guided session${r.strength.sessions === 1 ? "" : "s"}. Loads are what the guide planned unless you logged them.`, "");
    for (const e of r.strength.exercises.slice(0, 15)) out.push(`- ${mdText(e.name)}: ${e.sessions} session${e.sessions === 1 ? "" : "s"}${e.lastDetail ? `, last ${mdText(e.lastDetail)}` : ""}`);
    if (r.strength.pending > 0) out.push("", `${r.strength.pending} session(s) were not read yet, so this list may be incomplete.`);
  }

  out.push("", "## Plan", "");
  if (r.plan === null && down.includes("plan")) out.push("Unavailable.");
  else if (r.plan === null) out.push("No plan was set, so there is no adherence to report.");
  else if (r.plan.planned === 0) out.push(`Plan "${mdText(r.plan.goal)}": no session was planned this week.`);
  else {
    out.push(`Plan "${mdText(r.plan.goal)}": ${r.plan.done} of ${r.plan.planned} planned sessions done (${r.plan.adherencePct} %). Any workout on a planned date counts as done; the sport and guide are not compared.`, "");
    for (const i of r.plan.items) out.push(`- ${i.date} ${mdText(i.title)}: ${i.status}`);
  }

  out.push("", "## Tag effects", "");
  if (r.tagEffects === null) out.push("Unavailable.");
  else if (r.tagEffects.tags.length === 0) out.push(`Insufficient data: a tag needs at least ${r.tagEffects.minNightsPerGroup} nights after tagged sessions and ${r.tagEffects.minNightsPerGroup} after other training days before anything is said${r.tagEffects.insufficientTags > 0 ? ` (${r.tagEffects.insufficientTags} tag(s) checked)` : ", and no session carries a tag yet"}.`);
  else {
    for (const t of r.tagEffects.tags) out.push(`- ${mdText(t.statement)}`);
    out.push("", "These are associations in your own data, not causes.");
  }

  out.push("", "## Data notes", "");
  if (down.length) out.push(`- Unavailable or incomplete: ${down.join(", ")}.`);
  out.push("- A day without data is left out, never counted as 0. Sleep values are the night that led into each day.", "- Generated by suunto-mcp from Suunto watch data.", "");
  return out.join("\n");
}
