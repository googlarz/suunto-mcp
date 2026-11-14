// adjust_guide and push_week_plan: the two tools that take strength guide specs (push_strength_guide's
// arguments). adjustStrengthGuide only RETURNS a changed spec; planWeek is the only writer, and its dryRun
// (the default) validates and builds every guide but never calls push.
import { buildStrengthGuideZip, type StrengthPlan } from "./guide-zip.js";
import { PLANNED, parseLoadKg } from "./history.js";

// ---------- adjust_guide ----------

export type Band = "below" | "within" | "above" | null;
export interface Readiness {
  hrv?: Band; // get_baselines metrics.hrv.latestVsBand
  recoveryMorning?: Band; // get_baselines metrics.recoveryMorning.latestVsBand
}

const LOAD_CUT = 0.9;
const LOAD_STEP_KG = 2.5;
const KG = /(\d+(?:[.,]\d+)?)(\s*kg)/i;

// Rules (kept this simple on purpose; the user's own band, not a medical reference):
//   no signal below the band (or no reading) -> unchanged; it never adds load or sets
//   one of HRV / recovery on waking below    -> one set less on every exercise with 3+ sets
//   both below                                -> that, plus every load 10% lower, rounded to 2.5 kg
// The text in `detail` is rewritten to match (first "NxM", first "<n>kg"). A plate breakdown is dropped when the
// load changed, and `target` whenever anything about the exercise changed (sets or load); `last` stays. An exercise whose detail cannot be rewritten is left as it is.
export function adjustStrengthGuide(guide: StrengthPlan, readiness: Readiness) {
  const signals = { hrv: readiness.hrv ?? null, recoveryMorning: readiness.recoveryMorning ?? null };
  const below = [signals.hrv === "below" ? "HRV" : "", signals.recoveryMorning === "below" ? "recovery on waking" : ""].filter(Boolean);
  const out: StrengthPlan = structuredClone(guide);
  const reasons: string[] = [];
  const changes: { exercise: string; from: { sets: number; detail: string }; to: { sets: number; detail: string } }[] = [];

  if (below.length === 0) {
    reasons.push(
      signals.hrv === null && signals.recoveryMorning === null
        ? "No HRV or recovery reading to compare with your band yet (the watch may not have synced): left unchanged."
        : "HRV and recovery on waking are not below your band: left unchanged (this tool never adds load).",
    );
    return { level: "unchanged" as const, adjusted: false, signals, reasons, changes, guide: out };
  }
  reasons.push(`${below.join(" and ")} below your usual band.`);
  const cutLoad = below.length === 2;

  for (const ex of out.exercises) {
    const from = { sets: ex.sets, detail: ex.detail };
    if (ex.sets >= 3) {
      const m = PLANNED.exec(ex.detail);
      if (m && Number(m[1]) === ex.sets) {
        ex.detail = ex.detail.replace(PLANNED, `${ex.sets - 1}x${m[2]}`);
        ex.sets -= 1;
      } else {
        reasons.push(`${ex.name}: the detail text has no 'NxM' matching its ${ex.sets} sets, so its sets were left as they are.`);
      }
    }
    const kg = cutLoad ? parseLoadKg(ex.detail) : null;
    if (kg !== null) {
      const next = Math.round((kg * LOAD_CUT) / LOAD_STEP_KG) * LOAD_STEP_KG;
      if (next < kg) {
        ex.detail = ex.detail.replace(KG, `${next}$2`);
        if (ex.plates !== undefined) {
          delete ex.plates;
          reasons.push(`${ex.name}: plates removed (they described the old load); the detail line shows the new one.`);
        }
      }
    }
    if (ex.sets !== from.sets || ex.detail !== from.detail) {
      if (ex.target !== undefined) {
        delete ex.target; // it was set for the unreduced plan, whatever was changed
        reasons.push(`${ex.name}: target removed (it was set for the unreduced plan).`);
      }
      changes.push({ exercise: ex.name, from, to: { sets: ex.sets, detail: ex.detail } });
    }
  }
  if (changes.length === 0) reasons.push("Nothing to reduce: no exercise has 3+ sets or a load that a 2.5 kg step lowers.");
  return { level: cutLoad ? ("reduced" as const) : ("lighter" as const), adjusted: changes.length > 0, signals, reasons, changes, guide: out };
}

// ---------- push_week_plan ----------

export const MAX_WEEK_GUIDES = 14;

export interface WeekPlanDeps {
  dryRun: boolean;
  appName: string | undefined;
  validate: (guide: unknown) => string[]; // the caller's schema check of one guide (push_strength_guide's inputSchema)
  push: (zip: Buffer, title: string) => Promise<{ data: any; check: unknown }>; // the existing guide push path; always creates a new guide
}

export interface WeekPlanResult {
  dryRun: boolean;
  ok: boolean;
  wouldPush?: { date: string; title: string; exercises: number; sets: number }[];
  pushed?: { date: string; title: string; id: unknown; check: unknown }[];
  failed?: { date: string; error: string };
  notPushed?: string[];
  notes: string[];
}

// One new strength guide per date. Everything is validated, and every guide is built, before the first push (and in
// dryRun, instead of it), so a bad guide on day 5 cannot leave days 1-4 pushed.
export async function planWeek(guides: unknown, deps: WeekPlanDeps): Promise<WeekPlanResult> {
  if (!Array.isArray(guides) || guides.length === 0) throw new Error("guides must list at least one guide.");
  if (guides.length > MAX_WEEK_GUIDES) throw new Error(`guides can have at most ${MAX_WEEK_GUIDES} items.`);
  const seen = new Set<string>();
  const built: { plan: StrengthPlan; zip: Buffer }[] = [];
  for (const [i, g] of guides.entries()) {
    const errors = deps.validate(g);
    if (errors.length) throw new Error(`guides[${i}]: ${errors.join("; ")}`);
    if ((g as any).guideId !== undefined) throw new Error(`guides[${i}]: guideId is not allowed here: push_week_plan only creates new guides (use push_strength_guide to overwrite one).`);
    const plan = g as StrengthPlan;
    if (seen.has(plan.date)) throw new Error(`${plan.date} is listed more than once: one guide per date.`);
    seen.add(plan.date);
    try {
      built.push({ plan, zip: buildStrengthGuideZip(plan, deps.appName ?? "dry-run") });
    } catch (err: any) {
      throw new Error(`guides[${i}] (${plan.date}): ${err.message ?? err}`);
    }
  }
  built.sort((a, b) => a.plan.date.localeCompare(b.plan.date));

  if (deps.dryRun) {
    return {
      dryRun: true,
      ok: true,
      wouldPush: built.map(({ plan }) => ({ date: plan.date, title: plan.title, exercises: plan.exercises.length, sets: plan.exercises.reduce((n, e) => n + e.sets, 0) })),
      notes: ["Nothing was sent: this is the validation. Call again with dryRun: false to push these guides (one new guide per date)."],
    };
  }
  if (!deps.appName) throw new Error("SUUNTO_APP_NAME is not set. Set it in the env block of your MCP client config with the exact app name registered on apizone.suunto.com.");

  const pushed: NonNullable<WeekPlanResult["pushed"]> = [];
  const notes = ["Pushing the same plan again creates new guides next to these (see list_guides / delete_guide), it does not replace them."];
  for (const [i, { plan, zip }] of built.entries()) {
    try {
      const { data, check } = await deps.push(zip, plan.title);
      pushed.push({ date: plan.date, title: plan.title, id: data?.id ?? null, check });
    } catch (err: any) {
      return { dryRun: false, ok: false, pushed, failed: { date: plan.date, error: String(err?.message ?? err) }, notPushed: built.slice(i + 1).map((b) => b.plan.date), notes };
    }
  }
  return { dryRun: false, ok: true, pushed, notes };
}
