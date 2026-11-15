// draft_session_log: a proposed log_session payload for a guided gym session, built from what the watch shows (the lap
// table mapped to exercises and sets by compare_workout_to_plan) and the guide's text (sets x reps @ load). The watch records
// the guide's PLANNED text, never the reps and weights actually done, so every rep and weight in the draft is an assumption
// and is marked as such; the draft lists what the watch data contradicts or cannot show, and the exact things the user must
// confirm or correct. This only reads. It never calls log_session: the client does that, with source "draft", after the
// user has confirmed.
import type { SuuntoClient } from "./api.js";
import { dayFetchBounds, workoutDate } from "./api.js";
import { compareWorkout, type Deviation, type PlanItem } from "./compare.js";
import { parseFit, type ParsedFit } from "./fit.js";
import { PLANNED, parseLoadKg } from "./history.js";
import { assessHr } from "./hr-quality.js";
import { MAX_EXERCISES, MAX_SETS } from "./journal.js";
import { LAP_EXTENSIONS, shapeLaps } from "./laps.js";
import { isValidCalendarDate } from "./schema-validate.js";

type Client = Pick<SuuntoClient, "listWorkouts" | "getWorkoutWithExtensions" | "getWorkoutFit">;
export interface DraftDeps {
  parse?: (bytes: Buffer) => Promise<ParsedFit>;
}

const WORKOUT_KEY = /^[0-9a-f]{24}$/i;
const WORKOUT_LIMIT = 100;
const ERROR_MAX = 200;
// A deviation that says the number of sets on the watch may not be the number done.
const SET_COUNT_CODES = new Set(["missing-set", "extra-set", "short-set", "long-set", "rest-split", "unexpected-sequence", "after-complete", "ended-early"]);

// "3x8" in a guide's detail text -> sets and reps, unless the number after the x is a distance or a time ("3x40m", "3x30s").
function plannedOf(detail: string | null): { sets: number; reps: number | null } | null {
  const m = detail === null ? null : PLANNED.exec(detail);
  if (!m) return null;
  const after = detail!.slice(m.index + m[0].length);
  return { sets: Number(m[1]), reps: /^[a-z]/i.test(after) ? null : Number(m[2]) };
}

const issue = (d: Deviation) => ({ code: d.code, detail: d.detail });

export async function buildDraft(client: Client, opts: { workoutKey?: string; date?: string; plan?: PlanItem[] }, deps: DraftDeps = {}) {
  if ((opts.workoutKey === undefined) === (opts.date === undefined)) throw new Error("give either workoutKey or date (the latest guided session of that day), not both and not neither");
  if (opts.workoutKey !== undefined && !WORKOUT_KEY.test(opts.workoutKey)) throw new Error("workoutKey must be the 24-character hex key from list_workouts");
  if (opts.date !== undefined && !isValidCalendarDate(opts.date)) throw new Error(`"${opts.date}" is not a valid calendar date (YYYY-MM-DD).`);
  const notes: string[] = [];

  let key = opts.workoutKey?.toLowerCase();
  if (key === undefined) {
    const bounds = dayFetchBounds(opts.date!, opts.date!);
    const res: any = await client.listWorkouts({ since: bounds.from, until: bounds.to, limit: WORKOUT_LIMIT });
    const onDay = (Array.isArray(res) ? res : res?.payload ?? []).filter((w: any) => workoutDate(w) === opts.date);
    const guided = onDay
      .filter((w: any) => Array.isArray(w?.extensionTypes) && w.extensionTypes.includes("MANUALLAP") && WORKOUT_KEY.test(String(w?.workoutKey)))
      .sort((a: any, b: any) => b.startTime - a.startTime);
    if (guided.length === 0) {
      return { workoutKey: null, date: opts.date!, status: "no-workout" as const, assumed: true, draft: null, review: [], sessionIssues: [], mapping: null, hrQuality: null, confirm: [], notes: [onDay.length === 0 ? `No workout on ${opts.date}.` : `${onDay.length} workout(s) on ${opts.date}, none with guide laps: nothing to draft from. Ask the user what they did and call log_session.`] };
    }
    key = String(guided[0].workoutKey).toLowerCase();
    if (guided.length > 1) notes.push(`${guided.length} guided sessions on ${opts.date}: this is the latest; pass workoutKey for another.`);
  }

  const data: any = await client.getWorkoutWithExtensions(key, LAP_EXTENSIONS);
  const laps = shapeLaps(data);
  const date = workoutDate(data?.payload ?? data) || opts.date || null;
  const cmp = compareWorkout(laps, opts.plan);
  const head = { workoutKey: key, date, status: cmp.status, assumed: true as const };
  if (cmp.status !== "ok") {
    return { ...head, draft: null, review: [], sessionIssues: [], mapping: { format: cmp.format, complete: cmp.complete, reliable: cmp.reliable, note: cmp.note }, hrQuality: null, confirm: [], notes: [...notes, `${cmp.note} Nothing can be drafted: ask the user what they did and call log_session.`] };
  }

  // The session's heart-rate quality: it does not change the draft, but a session with a dropout has laps (and so sets) the user should look at.
  let hrQuality: ReturnType<typeof assessHr> | null = null;
  try {
    hrQuality = assessHr(await (deps.parse ?? parseFit)(await client.getWorkoutFit(key)));
  } catch (err: any) {
    notes.push(`Heart-rate quality was not checked: the FIT file could not be read (${String(err?.message ?? err).slice(0, ERROR_MAX)}).`);
  }

  const perSet = cmp.format === "strength-perSet";
  const exercises: { name: string; sets: { reps?: number; kg?: number }[] }[] = [];
  const review = cmp.exercises.map((ex) => {
    const planned = plannedOf(ex.detail);
    const kg = parseLoadKg(ex.detail);
    const issues = cmp.deviations.filter((d) => d.ex === ex.n).map(issue);
    const recorded = ex.sets.length;
    // one set lap per set in a per-set guide; one lap for the whole exercise otherwise, so the set count is the plan's
    const countFromWatch = perSet && recorded > 0;
    const proposed = Math.min(MAX_SETS, countFromWatch ? recorded : planned?.sets ?? 0);
    const set = { ...(planned?.reps != null ? { reps: planned.reps } : {}), ...(kg !== null ? { kg } : {}) };
    const hasValues = Object.keys(set).length > 0 && proposed > 0;
    if (hasValues) exercises.push({ name: ex.name, sets: Array.from({ length: proposed }, () => ({ ...set })) });
    const mustConfirm = ["reps", "kg"];
    if (!countFromWatch || issues.some((i) => SET_COUNT_CODES.has(i.code))) mustConfirm.push("setCount");
    const why: string[] = [];
    if (planned === null) why.push("the guide's text has no 'sets x reps' to read");
    else if (planned.reps === null) why.push("the number after the x is a distance or a time, not reps");
    if (!hasValues && why.length === 0) why.push("no set to propose");
    if (kg === null) why.push("the guide's text shows no weight (bodyweight, or none)");
    if (!countFromWatch) why.push(perSet ? "the watch recorded no set lap for this exercise" : "the watch recorded one lap for the whole exercise, so the number of sets is the plan's");
    return { n: ex.n, name: ex.name, detail: ex.detail, planned: planned || kg !== null ? { sets: planned?.sets ?? null, reps: planned?.reps ?? null, kg } : null, recordedSetLaps: recorded, proposedSets: hasValues ? proposed : 0, assumed: true as const, mustConfirm, issues, whyNotFilled: why };
  });
  const sessionIssues = cmp.deviations.filter((d) => d.ex === null).map(issue);

  let cappedAt: number | null = null;
  if (exercises.length > MAX_EXERCISES) {
    cappedAt = MAX_EXERCISES;
    exercises.length = MAX_EXERCISES;
  }

  const confirm: string[] = [];
  confirm.push("Every rep count and weight in the draft is the guide's PLAN: the watch does not record them. Ask the user for each exercise whether it went as written, and correct the sets that did not.");
  for (const r of review) {
    if (r.mustConfirm.includes("setCount")) confirm.push(`${r.name}: check the number of sets (${r.recordedSetLaps} set lap(s) on the watch${r.issues.length ? `; ${r.issues.map((i) => i.code).join(", ")}` : ""}).`);
    if (r.proposedSets === 0) confirm.push(`${r.name}: nothing could be proposed (${r.whyNotFilled.join("; ")}): ask the user for the sets, reps and weights.`);
  }
  if (!cmp.reliable) confirm.push(`The mapping of laps to exercises is unreliable (${cmp.note ?? "see issues"}): check every exercise and set below against what the user remembers.`);
  if (cmp.complete === false) confirm.push("The guide did not reach 'Session complete': the session may have ended early, so exercises that are not listed may have been planned.");
  for (const i of sessionIssues) confirm.push(`${i.code}: ${i.detail}`);
  if (hrQuality && hrQuality.reliable !== true) confirm.push(`Heart-rate data is ${hrQuality.reliable === null ? "missing" : "unreliable"} (${hrQuality.reasons.join("; ")}): a set or a rest may be missing or doubled in the laps.`);
  confirm.push("Also ask, and add to the call only if the user says: feeling, a note, tags, RPE per set. They cannot be read from the watch.");
  if (cappedAt !== null) notes.push(`The session has more than ${MAX_EXERCISES} exercises: only the first ${MAX_EXERCISES} are in the draft.`);
  notes.push("Read-only: nothing was written. After the user has confirmed or corrected it, call log_session with the draft (the same fields, corrected) and source: 'draft'. Logging again for the same workoutKey replaces the entry.");

  return {
    ...head,
    draft: exercises.length > 0 ? { workoutKey: key, source: "draft" as const, exercises } : null,
    review,
    sessionIssues,
    mapping: { format: cmp.format, complete: cmp.complete, reliable: cmp.reliable, note: cmp.note },
    hrQuality,
    confirm,
    notes,
  };
}
