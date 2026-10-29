// compare_workout_to_plan: maps the manual laps of a guided gym session to
// exercises, sets and rests, and reports planned against actual. Pure: it reads
// the table get_workout_laps returns and does no I/O. Spec and rationale:
// docs/design-compare-workout.md (section numbers below refer to it).
import { LAP_COLUMNS, shapeLaps, type LapCheck, type LapKind } from "./laps.js";

export interface PlanItem {
  name: string;
  sets?: number;
  restSec?: number;
}

type Basis = "labels" | "plan" | "heuristic";
type Format = "strength-perSet" | "strength-perExercise" | "workout";
type Status = "ok" | "no-laps" | "no-guide-labels" | "unknown-label-format";

// Order of the codes in a sorted deviation list (§3.9).
const CODE_ORDER = [
  "unexpected-sequence", "rest-split", "rest-short", "rest-long", "short-set", "long-set", "missing-set",
  "extra-set", "rest-target-mismatch", "extra-exercise", "ended-early", "unlabelled-lap",
  "after-complete", "order-differs", "missing-exercise",
] as const;
export type DeviationCode = (typeof CODE_ORDER)[number];

export interface Deviation {
  code: DeviationCode;
  basis: Basis;
  ex: number | null;
  plan: number | null;
  laps: number[];
  detail: string;
}

type PrepRow = [lap: number, durationS: number, hrMax: number | null, hrMin: number | null];
type SetRow = [k: number | null, lap: number, durationS: number, hrAvg: number | null, hrMax: number | null];
type RestRow = [k: number, lap: number, durationS: number, targetS: number | null, peak: number | null, end: number | null, drop: number | null, endVsBaseline: number | null];
type LapRow = [lap: number, durationS: number, hrAvg: number | null, hrMax: number | null];

export interface ExerciseResult {
  n: number;
  name: string;
  detail: string | null;
  plan: number | null;
  planned: { sets: number | null; restS: number | null };
  prep: PrepRow | null;
  sets: SetRow[];
  rests: RestRow[];
}

export interface Comparison {
  workoutKey: string | null;
  guide: ReturnType<typeof shapeLaps>["guide"];
  status: Status;
  format: Format | null;
  restMode: "countdown" | "stopwatch" | null;
  complete: boolean | null;
  reliable: boolean;
  note: string | null;
  checks: LapCheck[];
  lapCount: number;
  baselineHr: number | null;
  cols: typeof COLS;
  exercises: ExerciseResult[];
  afterComplete: LapRow[];
  unattributed: LapRow[];
  deviations: Deviation[];
}

// Rest label of a per-set strength guide; groups: target (stopwatch only), k, S.
const SET_REST = /^(?:(\d+)s target\s*·\s*)?Next: set (\d+)\/(\d+)$/;
// Longest text a label line can carry before guide-zip.ts cuts it (TEXT_WITH_SIBLING_FIELDS_MAX).
const STRENGTH_CAP = 40;
const WORKOUT_CAP = 54;
// Heuristic thresholds (§3.8). Checked against three real sessions; revisit with more.
const SHORT_SET_RATIO = 0.25;
const SHORT_SET_MAX_S = 10;
const LONG_SET_RATIO = 2;
const LONG_SET_MIN_EXTRA_S = 30;
const REST_TOL_RATIO = 0.2;
const REST_TOL_MIN_S = 10;
const REST_MISMATCH_S = 2;

const COLS = {
  prep: ["lap", "durationS", "hrMax", "hrMin"],
  set: ["k", "lap", "durationS", "hrAvg", "hrMax"],
  rest: ["k", "lap", "durationS", "targetS", "peak", "end", "drop", "endVsBaseline"],
  lap: ["lap", "durationS", "hrAvg", "hrMax"],
} as const;

const NOTES = {
  "no-laps": "No laps: the workout has no manual laps, so there is nothing to compare.",
  "no-guide-labels": "The laps carry no guide labels (no guide ran), so they cannot be mapped to exercises.",
  "unknown-label-format": "The lap labels match neither the push_strength_guide nor the push_workout_guide format; read them with get_workout_laps.",
} as const;

interface Row {
  i: number;
  durationS: number;
  hrAvg: number | null;
  hrMax: number | null;
  hrMin: number | null;
  kind: LapKind | null;
  label: string | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const parts = (label: string) => label.split(" | ");
// Length of the text before cleanLabel replaced its line breaks with " | ".
const rawLen = (label: string) => label.length - 2 * (parts(label).length - 1);
export const norm = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function links(a: string, b: string): boolean {
  const A = norm(a);
  const B = norm(b);
  if (A === B) return A.length > 0;
  return Math.min(A.length, B.length) >= 3 && (A.startsWith(B) || B.startsWith(A));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The last "N x R" in a detail text: "2x32kg 3x40m" -> 3, "BW 3x15" -> 3.
export function detailSets(detail: string | null): number | null {
  if (detail === null) return null;
  const all = [...detail.matchAll(/(\d{1,3})\s*[x×]\s*\d/gi)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

const maxOf = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};
const nextName = (label: string) => parts(label)[0].replace(/^Next:\s*/, "");
const lapRow = (r: Row): LapRow => [r.i, r.durationS, r.hrAvg, r.hrMax];

const COL = Object.fromEntries(LAP_COLUMNS.map((c, k) => [c, k])) as Record<(typeof LAP_COLUMNS)[number], number>;
function toRow(r: (string | number | null)[]): Row {
  return {
    i: r[COL.i] as number,
    durationS: (r[COL.durationS] as number | null) ?? 0,
    hrAvg: r[COL.hrAvg] as number | null,
    hrMax: r[COL.hrMax] as number | null,
    hrMin: r[COL.hrMin] as number | null,
    kind: r[COL.kind] as LapKind | null,
    label: r[COL.label] as string | null,
  };
}

// Laps that make up one exercise's lead-in (strength: the prep lap; workout: the
// rest lap(s) before it) or one rest gap (a split rest has several laps).
interface Lead {
  label: string;
  parts: Row[];
}
interface Gap extends Lead {
  k: number;
  target: number | null;
}
interface Work {
  k: number | null;
  r: Row;
}
interface Ex {
  n: number;
  prep: Lead | null;
  work: Work[];
  gaps: Gap[];
  label: string | null;
  S?: number;
}

// Findings collected while mapping.
interface Ctx {
  devs: Deviation[];
  unattributed: Row[];
  nullLaps: number[];
}

function add(ctx: Ctx, code: DeviationCode, basis: Basis, ex: number | null, laps: number[], detail: string, plan: number | null = null) {
  ctx.devs.push({ code, basis, ex, plan, laps, detail });
}
const unexpected = (ctx: Ctx, ex: number | null, laps: number[], detail: string) => add(ctx, "unexpected-sequence", "labels", ex, laps, detail);

const gapTotal = (g: Lead) => r1(g.parts.reduce((a, p) => a + p.durationS, 0));

function skeleton(laps: ReturnType<typeof shapeLaps>, status: Exclude<Status, "ok">): Comparison {
  return {
    workoutKey: laps.workoutKey, guide: laps.guide, status, format: null, restMode: null, complete: null,
    reliable: false, note: NOTES[status], checks: laps.checks, lapCount: laps.lapCount, baselineHr: null, cols: COLS,
    exercises: [], afterComplete: [], unattributed: [], deviations: [],
  };
}

// §3.4: strength guides. prep -> set -> (rest -> set)* per exercise; position decides, text only cross-checks.
function segmentStrength(ctx: Ctx, guided: Row[], perSet: boolean, complete: boolean): Ex[] {
  const exs: Ex[] = [];
  let cur: Ex | null = null;
  let prev: "prep" | "set" | "rest" | null = null;
  let gap: Gap | null = null;
  for (const r of guided) {
    if (r.label === null) {
      ctx.unattributed.push(r);
      ctx.nullLaps.push(r.i);
      continue;
    }
    if (r.kind === "rest") {
      if (cur === null) {
        ctx.unattributed.push(r);
        unexpected(ctx, null, [r.i], "a rest lap before the first exercise");
        continue;
      }
      if (prev === "rest" && gap!.label === r.label) {
        gap!.parts.push(r);
        continue;
      }
      const m: RegExpExecArray = SET_REST.exec(r.label)!; // a per-set format is only chosen when every rest label matches
      const k: number = Number(m[2]);
      const S = Number(m[3]);
      const lastK = cur.work.length ? cur.work[cur.work.length - 1].k! : 0;
      if (prev === "prep") unexpected(ctx, cur.n, [r.i], "a rest lap straight after the prep");
      else if (prev === "rest") unexpected(ctx, cur.n, [gap!.parts[gap!.parts.length - 1].i, r.i], "two different rest laps in a row");
      else if (k !== lastK + 1) unexpected(ctx, cur.n, [r.i], `the rest announces set ${k} after set ${lastK}`);
      if (cur.S === undefined) cur.S = S;
      else if (cur.S !== S) unexpected(ctx, cur.n, [r.i], `the rest says ${S} sets, an earlier rest said ${cur.S}`);
      gap = { k, label: r.label, target: m[1] ? Number(m[1]) : null, parts: [r] };
      cur.gaps.push(gap);
      prev = "rest";
      continue;
    }
    if (prev === null || prev === "set") {
      cur = { n: exs.length + 1, prep: { label: r.label, parts: [r] }, work: [], gaps: [], label: null };
      exs.push(cur);
      prev = "prep";
      continue;
    }
    const k = perSet ? (prev === "rest" ? gap!.k : 1) : null;
    if (cur!.label === null) {
      cur!.label = r.label;
      const prepParts = parts(cur!.prep!.label);
      if (prepParts.length >= 2 && !links(prepParts[prepParts.length - 1], parts(r.label)[0])) {
        unexpected(ctx, cur!.n, [cur!.prep!.parts[0].i, r.i], "the prep and the first set name different exercises");
      }
    } else if (r.label !== cur!.label) {
      unexpected(ctx, cur!.n, [r.i], "this set's label differs from set 1's");
    }
    cur!.work.push({ k, r });
    prev = "set";
  }
  if (complete && prev === "rest") unexpected(ctx, cur!.n, [gap!.parts[0].i], "'Session complete' straight after a rest lap");
  if (complete && prev === "prep") unexpected(ctx, cur!.n, [cur!.prep!.parts[0].i], "'Session complete' straight after a prep lap");
  return exs;
}

// §3.5: workout guide. ex 1, rest(Next: ex 2), ex 2, ...; the rest before an exercise is its "prep".
function segmentWorkout(ctx: Ctx, guided: Row[], complete: boolean): Ex[] {
  const exs: Ex[] = [];
  let pending: Lead | null = null;
  let prev: "rest" | "step" | null = null;
  for (const r of guided) {
    if (r.label === null) {
      ctx.unattributed.push(r);
      ctx.nullLaps.push(r.i);
      continue;
    }
    if (r.kind === "rest") {
      if (prev === "rest" && pending && pending.label === r.label) {
        pending.parts.push(r);
        continue;
      }
      if (prev === "rest" && pending) {
        unexpected(ctx, null, [pending.parts[0].i, r.i], "two different rest laps in a row; the first is left out");
        ctx.unattributed.push(...pending.parts);
      } else if (exs.length === 0) {
        unexpected(ctx, null, [r.i], "a rest lap before the first exercise");
      }
      pending = { label: r.label, parts: [r] };
      prev = "rest";
      continue;
    }
    const n = exs.length + 1;
    if (prev === "step") unexpected(ctx, n, [r.i], "two exercise laps in a row with no rest lap between");
    if (pending && !links(nextName(pending.label), parts(r.label)[0])) {
      unexpected(ctx, n, [pending.parts[0].i, r.i], "the rest lap announced a different exercise");
    }
    exs.push({ n, prep: pending, work: [{ k: null, r }], gaps: [], label: r.label });
    pending = null;
    prev = "step";
  }
  if (pending) {
    if (complete) unexpected(ctx, null, [pending.parts[0].i], "'Session complete' straight after a rest lap");
    exs.push({ n: exs.length + 1, prep: pending, work: [], gaps: [], label: null });
  }
  return exs;
}

interface Built extends ExerciseResult {
  cut: boolean; // the label may have been truncated: enables prefix matching against the plan
  labelSets: number | null; // planned.sets before the plan is consulted
}

export function compareWorkout(laps: ReturnType<typeof shapeLaps>, plan?: PlanItem[]): Comparison {
  const rows = laps.laps.rows.map(toRow);
  if (rows.length === 0) return skeleton(laps, "no-laps");
  if (rows.every((r) => r.label === null)) return skeleton(laps, "no-guide-labels");

  // §3.2 split at the first "Session complete"
  const firstDone = rows.findIndex((r) => r.kind === "done");
  const complete = firstDone !== -1;
  const guided = complete ? rows.slice(0, firstDone) : rows;
  const tail = complete ? rows.slice(firstDone) : [];
  // the stop of the recording, not a lap press, ends the last lap of an unfinished guide
  const cutLap = complete ? null : guided[guided.length - 1].i;
  const afterComplete = tail.slice(0, -1);

  // §3.3 format
  const rests = guided.filter((r) => r.kind === "rest");
  const setRests = rests.filter((r) => SET_REST.test(r.label!));
  const steps = guided.filter((r) => r.kind === "step");
  let format: Format;
  if (setRests.length > 0 && setRests.length === rests.length) format = "strength-perSet";
  else if (rests.length > 0 && setRests.length === 0) format = "workout";
  else if (rests.length === 0 && steps.length === 1) format = "workout";
  else if (rests.length === 0 && steps.length >= 2) format = "strength-perExercise";
  else return skeleton(laps, "unknown-label-format");
  const perSet = format === "strength-perSet";
  const restMode = perSet ? (SET_REST.exec(setRests[0].label!)![1] ? "stopwatch" : "countdown") : null;

  const ctx: Ctx = { devs: [], unattributed: [], nullLaps: [] };
  const exs = format === "workout" ? segmentWorkout(ctx, guided, complete) : segmentStrength(ctx, guided, perSet, complete);

  // §4: lap 1 is a prep (standing around) only in the strength formats
  const baselineHr = format === "workout" ? null : rows[0].hrAvg;

  const built: Built[] = exs.map((e) => {
    // §3.6 name, detail, cut
    let name: string;
    let detail: string | null;
    let cut: boolean;
    if (e.label !== null) {
      const p = parts(e.label);
      name = p[0];
      detail = p.slice(1).join(" | ") || null;
      cut = format === "workout" ? p[0].length >= WORKOUT_CAP : p.length === 1 && rawLen(e.label) >= STRENGTH_CAP;
    } else if (format === "workout") {
      const p = parts(e.prep!.label);
      name = nextName(e.prep!.label);
      detail = p.slice(1).join(" | ") || null;
      cut = p[0].length >= WORKOUT_CAP;
    } else {
      // the prep shows the plates OR the detail, which cannot be told apart
      const p = parts(e.prep!.label);
      name = p[p.length - 1];
      detail = null;
      cut = rawLen(e.prep!.label) >= STRENGTH_CAP;
    }

    let plannedSets: number | null;
    let plannedRest: number | null = null;
    let restRows: RestRow[] = [];
    if (perSet) {
      const isLast = e.n === exs.length;
      plannedSets = e.S ?? (!isLast || complete ? 1 : detailSets(detail));
      const isCut = (g: Gap) => g.parts[g.parts.length - 1].i === cutLap;
      if (e.gaps.length) {
        if (e.gaps[0].target !== null) plannedRest = e.gaps[0].target;
        else {
          const full = e.gaps.filter((g) => !isCut(g)).map(gapTotal);
          plannedRest = full.length ? Math.round(median(full)) : null;
        }
      }
      restRows = e.gaps.map((g) => {
        const total = gapTotal(g);
        const peak = maxOf(g.parts.map((p) => p.hrMax));
        const end = g.parts[g.parts.length - 1].hrMin;
        if (g.parts.length >= 2) {
          add(ctx, "rest-split", "labels", e.n, g.parts.map((p) => p.i), `the rest before set ${g.k} spans ${g.parts.length} laps: a lap was pressed during a countdown rest (a set done inside the rest looks like this)`);
        }
        if (g.target !== null && !isCut(g)) {
          const tol = Math.max(REST_TOL_MIN_S, Math.round(REST_TOL_RATIO * g.target));
          const detailText = `rest before set ${g.k}: ${total} s against a ${g.target} s target`;
          if (total < g.target - tol) add(ctx, "rest-short", "labels", e.n, [g.parts[0].i], detailText);
          if (total > g.target + tol) add(ctx, "rest-long", "labels", e.n, [g.parts[0].i], detailText);
        }
        return [g.k, g.parts[0].i, total, g.target ?? plannedRest, peak, end, peak !== null && end !== null ? peak - end : null, end !== null && baselineHr !== null ? end - baselineHr : null];
      });
      if (e.work.length >= 2) {
        e.work.forEach((w, idx) => {
          if (w.r.i === cutLap) return;
          const m = median(e.work.filter((_, j) => j !== idx).map((x) => x.r.durationS));
          const d = w.r.durationS;
          if (d < SHORT_SET_RATIO * m && d < SHORT_SET_MAX_S) {
            add(ctx, "short-set", "heuristic", e.n, [w.r.i], `set ${w.k} lasted ${d} s against a median of ${r1(m)} s for the other sets: likely an accidental double lap press, so the set may not have been done`);
          }
          if (d >= LONG_SET_RATIO * m && d - m >= LONG_SET_MIN_EXTRA_S) {
            add(ctx, "long-set", "heuristic", e.n, [w.r.i], `set ${w.k} lasted ${d} s against a median of ${r1(m)} s for the other sets: it may contain an extra set, or a lap press was forgotten`);
          }
        });
      }
    } else {
      plannedSets = detailSets(detail);
    }

    let prep: PrepRow | null = null;
    if (e.prep) {
      const ps = e.prep.parts;
      prep = [ps[0].i, r1(ps.reduce((a, p) => a + p.durationS, 0)), maxOf(ps.map((p) => p.hrMax)), ps[ps.length - 1].hrMin];
      if (format === "workout" && ps.length >= 2) add(ctx, "rest-split", "labels", e.n, ps.map((p) => p.i), `the rest before this exercise spans ${ps.length} laps`);
    }
    return {
      n: e.n, name, detail, plan: null, planned: { sets: plannedSets, restS: plannedRest }, prep,
      sets: e.work.map((w) => [w.k, w.r.i, w.r.durationS, w.r.hrAvg, w.r.hrMax]), rests: restRows,
      cut, labelSets: plannedSets,
    };
  });

  if (plan) comparePlan(ctx, built, plan, format, complete);

  // missing sets by the labels, unless the plan already says
  for (const ex of built) {
    const planSets = ex.plan !== null && plan ? plan[ex.plan].sets : undefined;
    if (ex.sets.length === 0) {
      if (format === "workout") add(ctx, "missing-set", "labels", ex.n, [], "the exercise was not started: the session ended during the rest before it");
      else if (!(perSet && planSets !== undefined)) add(ctx, "missing-set", "labels", ex.n, [], "no set recorded: the session ended during the prep");
      continue;
    }
    if (perSet && planSets === undefined && ex.labelSets !== null && ex.sets.length < ex.labelSets) {
      add(ctx, "missing-set", "labels", ex.n, [], `${ex.sets.length} of ${ex.labelSets} sets recorded`);
    }
  }

  if (!complete) {
    add(ctx, "ended-early", "labels", built.length ? built.length : null, [cutLap!], "no 'Session complete' lap: the recording stopped inside the guide; exercises after this one are not visible in the laps (pass plan to list them)");
  }
  if (ctx.nullLaps.length) add(ctx, "unlabelled-lap", "labels", null, ctx.nullLaps, "laps without a guide label inside the guided part; left out of the mapping");
  if (afterComplete.length) {
    add(ctx, "after-complete", "labels", null, afterComplete.map((r) => r.i), `${afterComplete.length} lap(s) pressed after 'Session complete': work after the guide ended (an extra set, say), not attributed to an exercise`);
  }

  // §3.9
  const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
  ctx.devs.sort((a, b) =>
    cmp(a.ex ?? Infinity, b.ex ?? Infinity) ||
    cmp(a.laps[0] ?? Infinity, b.laps[0] ?? Infinity) ||
    cmp(CODE_ORDER.indexOf(a.code), CODE_ORDER.indexOf(b.code)) ||
    cmp(a.plan ?? -1, b.plan ?? -1));

  // Heart rate loss does not affect the positional mapping, so it is reported in `checks` only.
  const reasons = [...new Set([
    ...laps.checks.map((c) => c.code).filter((c) => c !== "no-heart-rate"),
    ...(ctx.devs.some((d) => d.code === "unexpected-sequence") ? ["unexpected-sequence"] : []),
  ])];
  const reliable = reasons.length === 0;

  return {
    workoutKey: laps.workoutKey, guide: laps.guide, status: "ok", format, restMode, complete, reliable,
    note: reliable ? null : `Positional mapping is unreliable (${reasons.join(", ")}); exercises, sets and rests below are best effort.`,
    checks: laps.checks, lapCount: laps.lapCount, baselineHr, cols: COLS,
    exercises: built.map(({ cut, labelSets, ...ex }) => ex),
    afterComplete: afterComplete.map(lapRow), unattributed: ctx.unattributed.map(lapRow), deviations: ctx.devs,
  };
}

// §3.7 matching and the plan-basis deviations
function comparePlan(ctx: Ctx, built: Built[], plan: PlanItem[], format: Format, complete: boolean) {
  const used = new Set<number>();
  const claim = (ex: Built, test: (p: PlanItem) => boolean) => {
    const j = plan.findIndex((p, idx) => !used.has(idx) && test(p));
    if (j !== -1) {
      ex.plan = j;
      used.add(j);
    }
  };
  for (const ex of built) if (norm(ex.name) !== "") claim(ex, (p) => norm(p.name) === norm(ex.name));
  for (const ex of built) {
    if (ex.plan === null && ex.cut && norm(ex.name).length >= 3) claim(ex, (p) => norm(p.name).startsWith(norm(ex.name)));
  }

  const lastMatched = Math.max(-1, ...built.filter((e) => e.plan !== null).map((e) => e.plan!));
  for (const ex of built) {
    if (ex.plan === null) {
      add(ctx, "extra-exercise", "plan", ex.n, [], `"${ex.name}" is not in the plan`);
      continue;
    }
    if (format !== "strength-perSet") continue;
    const p = plan[ex.plan];
    const done = ex.sets.length;
    if (p.sets !== undefined && done > p.sets) add(ctx, "extra-set", "plan", ex.n, ex.sets.slice(p.sets).map((s) => s[1]), `${done} sets recorded, the plan has ${p.sets}`, ex.plan);
    if (p.sets !== undefined && done < p.sets) add(ctx, "missing-set", "plan", ex.n, [], `${done} of ${p.sets} planned sets recorded`, ex.plan);
    if (p.restSec !== undefined && ex.planned.restS !== null && Math.abs(p.restSec - ex.planned.restS) > REST_MISMATCH_S) {
      add(ctx, "rest-target-mismatch", "plan", ex.n, [], `the guide's rest was ${ex.planned.restS} s, the plan has ${p.restSec} s`, ex.plan);
    }
  }
  plan.forEach((p, j) => {
    if (used.has(j)) return;
    add(ctx, "missing-exercise", "plan", null, [], !complete && j > lastMatched ? `"${p.name}" was not reached: the session ended early` : `"${p.name}" is not in this session`, j);
  });
  const seq = built.filter((e) => e.plan !== null).map((e) => e.plan!);
  if (seq.some((v, i) => i > 0 && v < seq[i - 1])) add(ctx, "order-differs", "plan", null, [], `plan entries in session order: ${seq.join(", ")}`);
}
