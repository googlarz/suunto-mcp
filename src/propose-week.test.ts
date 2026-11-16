import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { selectDays, selectNights } from "./api.js";
import type { ParsedFit } from "./fit.js";
import { COLS, clearFailedSessions, suggestProgression, type WorkoutRecord } from "./history.js";
import type { JournalEntry } from "./journal.js";
import { memoryPlanStore, setPlan, type Plan, type PlanStore } from "./plan.js";
import { BASE_LOOKBACK_WEEKS, buildGates, HISTORY_WEEKS, MIN_LOGGED_SESSIONS, RULES, baseWeek, decideLift, deloadKg, hit, liftEvidence, parseRules, proposeNextWeek, rulesUsed, withKg, type Evidence, type Gates, type Rules } from "./propose-week.js";
import { forecastTrainingLoad, addDays } from "./training-load.js";
import { planWeek } from "./week-plan.js";

const DEF: Rules = parseRules(undefined);
const gates = (over: Partial<Gates> = {}): Gates => ({ tsb: 0, tsbDeload: false, recoveryBoth: false, recoveryOne: false, incomplete: false, ...over });

// ---------- the rules ----------

test("parseRules: defaults, a documented range per rule, edges inclusive, unknown names and wrong types refused", () => {
  assert.deepEqual(DEF, { incrementKg: 2.5, deloadPct: 10, stallSessions: 2, tsbDeloadBelow: -25, tsbRiskFloor: -30, weeklyJumpPct: 30 });
  assert.deepEqual(parseRules({}), DEF);
  assert.equal(parseRules({ deloadPct: 15 }).deloadPct, 15);
  for (const [name, def] of Object.entries(RULES)) {
    assert.equal(parseRules({ [name]: def.min })[name as keyof Rules], def.min, `${name} min is allowed`);
    assert.equal(parseRules({ [name]: def.max })[name as keyof Rules], def.max, `${name} max is allowed`);
    const step = "integer" in def ? 1 : 0.01;
    assert.throws(() => parseRules({ [name]: def.min - step }), new RegExp(`rules.${name} must be between ${def.min} and ${def.max}`), `${name} below min`);
    assert.throws(() => parseRules({ [name]: def.max + step }), new RegExp(`rules.${name} must be between`), `${name} above max`);
  }
  assert.throws(() => parseRules({ stallSessions: 2.5 }), /rules.stallSessions must be an integer/);
  assert.throws(() => parseRules({ deloadPct: "10" }), /rules.deloadPct must be a finite number/);
  assert.throws(() => parseRules({ deloadPct: Infinity }), /finite number/);
  assert.throws(() => parseRules({ deloadPct: NaN }), /finite number/);
  assert.throws(() => parseRules({ bogus: 1 }), /rules.bogus is not a known rule \(allowed: incrementKg, deloadPct, stallSessions, tsbDeloadBelow, tsbRiskFloor, weeklyJumpPct\)/);
  assert.throws(() => parseRules([1]), /rules must be an object/);
  assert.throws(() => parseRules(null), /rules must be an object/);
});

test("rulesUsed: every named constant with its value, default, whether it was overridden and a sentence; the fixed ones are not overridable", () => {
  const used = rulesUsed(parseRules({ deloadPct: 15 }));
  const by = Object.fromEntries(used.map((r) => [r.name, r]));
  assert.deepEqual([by.deloadPct.value, by.deloadPct.default, by.deloadPct.overridden, by.deloadPct.overridable], [15, 10, true, true]);
  assert.equal(by.stallSessions.overridden, false);
  for (const fixed of ["historyWeeks", "minLoggedSessions", "baseLookbackWeeks", "recoverySignals", "loadStepKg", "minTssSessions"]) assert.equal(by[fixed].overridable, false, fixed);
  assert.equal(by.minLoggedSessions.value, 2);
  assert.equal(by.historyWeeks.value, 8);
  assert.ok(used.every((r) => r.rule.length > 20), "each has its sentence");
});

// ---------- small helpers ----------

test("deloadKg: pct lower, rounded to 1.25 kg, always below the load, null when it cannot go down a step", () => {
  assert.equal(deloadKg(100, 10), 90);
  assert.equal(deloadKg(70, 10), 62.5, "63 rounds to 62.5");
  assert.equal(deloadKg(20, 10), 17.5);
  assert.equal(deloadKg(70, 20), 56.25);
  assert.equal(deloadKg(5, 10), 3.75, "4.5 would round back up to 5: one step lower instead");
  assert.equal(deloadKg(2.5, 10), 1.25);
  assert.equal(deloadKg(1.25, 10), null, "nothing below one step");
  assert.equal(deloadKg(1.25, 20), null);
});

test("withKg: replaces the first '<n>kg' and nothing else", () => {
  assert.equal(withKg("70kg 4x8", 72.5), "72.5kg 4x8");
  assert.equal(withKg("62,5kg 3x8", 65), "65kg 3x8");
  assert.equal(withKg("2x20kg 3x8/leg", 22.5), "2x22.5kg 3x8/leg");
  assert.equal(withKg("70 kg 4x8", 67.5), "67.5 kg 4x8");
  assert.equal(withKg("70kg 4x8, back-off 50kg 1x10", 60), "60kg 4x8, back-off 50kg 1x10");
});

// A get_exercise_history row (COLS) for one logged session: the top weight, the reps of each set, each set at `kgs` (default: all at kg).
const rowOf = (kg: number | null, reps: number[], detail = "70kg 4x8", kgs?: (number | null)[]): unknown[] => {
  const cells: Record<string, unknown> = { detail, kg, journal: { sets: reps.map((r, i) => ({ reps: r, ...(((kgs ?? [])[i] ?? kg) === null ? {} : { kg: (kgs ?? [])[i] ?? kg }) })) } };
  return COLS.map((c) => cells[c] ?? null);
};
const ev = (kg: number | null, reps: number[], detail?: string, kgs?: (number | null)[]): Evidence => ({ date: "2026-11-02", kg, row: rowOf(kg, reps, detail, kgs) });
const HIT = [8, 8, 8, 8];
const MISS = [8, 8, 8, 7];

test("hit: every planned set at its planned reps at one weight (the rule suggestProgression applies), nothing less", () => {
  assert.equal(hit(rowOf(70, HIT), 2.5), true);
  assert.equal(hit(rowOf(70, [9, 9, 9, 9]), 2.5), true, "more reps than planned still hit");
  assert.equal(hit(rowOf(70, [8, 8, 8, 9]), 2.5), true);
  assert.equal(hit(rowOf(70, MISS), 2.5), false, "one rep short on one set");
  assert.equal(hit(rowOf(70, [8, 8, 8]), 2.5), false, "a set fewer than planned");
  assert.equal(hit(rowOf(70, [8, 8, 8, 8, 8]), 2.5), true, "an extra set");
  assert.equal(hit(rowOf(70, HIT, "70kg 4x8", [70, 70, 72.5, 70]), 2.5), false, "weights differ between sets: no increase");
  assert.equal(hit(rowOf(null, HIT, "BW 4x8"), 2.5), false, "no load to raise");
  assert.equal(hit(rowOf(70, HIT, "70kg RPE7 8-12"), 2.5), false, "no sets x reps in the plan");
});

test("buildGates: TSB deloads only strictly below the line; recovery counts the signals below the band; any unread session blocks increases", () => {
  const g = (o: Partial<Parameters<typeof buildGates>[0]> = {}, rules: Partial<Rules> = {}) => buildGates({ tsb: 0, hrv: "within", recoveryMorning: "within", pending: 0, failed: 0, ...o }, { ...DEF, ...rules });
  assert.deepEqual(g(), { tsb: 0, tsbDeload: false, recoveryBoth: false, recoveryOne: false, incomplete: false });
  assert.equal(g({ tsb: -25 }).tsbDeload, false, "on the line");
  assert.equal(g({ tsb: -25.1 }).tsbDeload, true);
  assert.equal(g({ tsb: -20 }, { tsbDeloadBelow: -20 }).tsbDeload, false);
  assert.equal(g({ tsb: -20.1 }, { tsbDeloadBelow: -20 }).tsbDeload, true);
  const rec = (hrv: string | null, recoveryMorning: string | null) => { const x = g({ hrv, recoveryMorning }); return [x.recoveryOne, x.recoveryBoth]; };
  assert.deepEqual([rec("below", "below"), rec("below", "within"), rec("within", "below"), rec("above", "above"), rec(null, null), rec("below", null)], [[false, true], [true, false], [true, false], [false, false], [false, false], [true, false]]);
  assert.deepEqual([g({ pending: 1 }).incomplete, g({ failed: 1 }).incomplete, g({ pending: 0, failed: 0 }).incomplete], [true, true, false]);
});

// ---------- one lift ----------

const decide = (evidence: Evidence[], over: { gates?: Partial<Gates>; rules?: Partial<Rules>; baseDetail?: string; skippedScheme?: number } = {}) =>
  decideLift({ baseDetail: over.baseDetail ?? "70kg 4x8", evidence, skippedScheme: over.skippedScheme ?? 0, gates: gates(over.gates), rules: { ...DEF, ...over.rules } });

test("decideLift: every planned set reached -> the load goes up by the progression step, with last and target for the watch", () => {
  const d = decide([ev(70, HIT)]);
  assert.deepEqual([d.action, d.kg, d.last, d.target], ["progress", 72.5, "4x8@70kg", "4x8@72.5kg"]);
  assert.match(d.reasons.join(" "), /every set reached 8 reps: \+2.5 kg/);
  assert.equal(decide([ev(70, HIT)], { rules: { incrementKg: 1.25 } }).kg, 71.25, "the step is the caller's, at most");
  assert.equal(decide([ev(10, [10, 10, 10], "10kg 3x10")], { baseDetail: "10kg 3x10" }).kg, 11.25, "a light load goes up by the smallest step");
  assert.equal(decide([ev(100, HIT, "100kg 4x8")], { baseDetail: "100kg 4x8" }).kg, 102.5);
});

test("decideLift: a set short, fewer sets, or different weights -> hold at the load that was done, never up", () => {
  for (const e of [ev(70, MISS), ev(70, [8, 8, 8]), ev(70, HIT, "70kg 4x8", [70, 72.5, 70, 70])]) {
    const d = decide([e]);
    assert.equal(d.action, "hold");
    assert.ok(d.kg !== null && d.kg <= 70, `held at ${d.kg}`);
  }
  assert.equal(decide([ev(70, MISS)]).kg, 70);
  assert.match(decide([ev(70, MISS)]).reasons.join(" "), /fell short/);
});

test("decideLift: the proposed load follows what was logged, not what the plan said (never above evidence + one step)", () => {
  // plan says 70 but the lifter logged 65: all hit -> 67.5, not 72.5
  const d = decide([ev(65, HIT)]);
  assert.deepEqual([d.action, d.kg], ["progress", 67.5]);
  // plan says 60, logged 70 and missed: held at 70
  assert.equal(decide([ev(70, MISS)], { baseDetail: "60kg 4x8" }).kg, 70);
});

test("decideLift: deload after stallSessions logged sessions in a row without hitting the plan (default 2): 1 is not enough, 2 is", () => {
  assert.equal(decide([ev(70, MISS)]).action, "hold", "one miss: hold");
  const two = decide([ev(70, MISS), ev(70, [8, 8, 7, 7])]);
  assert.deepEqual([two.action, two.kg], ["deload", 62.5]);
  assert.match(two.reasons.join(" "), /last 2 logged sessions did not reach every planned set and rep at one weight \(a deload needs 2 in a row\)/);
  assert.match(two.reasons.join(" "), /70 kg -> 62.5 kg \(10% lower, rounded to 1.25 kg\)/);
  assert.equal(two.target, "4x8@62.5kg");
  assert.equal(decide([ev(70, HIT), ev(70, MISS)]).action, "hold", "a hit before the miss: the run is 1");
  assert.equal(decide([ev(70, MISS), ev(70, HIT)]).action, "progress", "the newest session hit: the run is 0");
  assert.equal(decide([ev(70, MISS), ev(70, MISS), ev(70, HIT)]).action, "progress");
  assert.equal(decide([ev(70, MISS), ev(70, HIT), ev(70, MISS)]).action, "hold", "not in a row");
  assert.equal(decide([ev(70, HIT), ev(70, MISS), ev(70, MISS)]).action, "deload");
});

test("decideLift: stallSessions is the caller's number (3: two misses hold, three deload; 4: three hold, four deload)", () => {
  const miss = (n: number) => Array.from({ length: n }, () => ev(70, MISS));
  assert.equal(decide(miss(2), { rules: { stallSessions: 3 } }).action, "hold");
  assert.equal(decide(miss(3), { rules: { stallSessions: 3 } }).action, "deload");
  assert.equal(decide(miss(3), { rules: { stallSessions: 4 } }).action, "hold");
  assert.equal(decide(miss(4), { rules: { stallSessions: 4 } }).action, "deload");
  assert.equal(decide(miss(2), { rules: { deloadPct: 20 } }).kg, 56.25, "deloadPct is the caller's");
});

test("decideLift: TSB below the line deloads, exactly on it does not (strict, as printed), the line is the caller's", () => {
  const at = (tsb: number, line?: number) => decide([ev(70, HIT)], { gates: { tsb, tsbDeload: tsb < (line ?? -25) }, rules: line === undefined ? {} : { tsbDeloadBelow: line } });
  assert.equal(at(-25).action, "progress");
  const low = at(-25.1);
  assert.deepEqual([low.action, low.kg], ["deload", 62.5]);
  assert.match(low.reasons[0], /TSB -25.1 is below -25/);
  assert.equal(at(-20, -20).action, "progress");
  assert.equal(at(-20.1, -20).action, "deload");
});

test("decideLift: deloads without evidence from the plan's own load (lowering needs none); raising always does", () => {
  const d = decide([], { gates: { tsb: -40, tsbDeload: true } });
  assert.deepEqual([d.action, d.kg, d.last], ["deload", 62.5, null]);
  const none = decide([]);
  assert.deepEqual([none.action, none.kg], ["unchanged", null]);
  assert.match(none.reasons[0], /No evidence.*no log_session entry/);
  assert.match(decide([], { skippedScheme: 2 }).reasons[0], /2 logged session\(s\) used another sets x reps than the plan's/);
});

test("decideLift: both recovery signals below deload; one below (or an unread history) allows no increase but does not stop a deload", () => {
  const both = decide([ev(70, HIT)], { gates: { recoveryBoth: true } });
  assert.deepEqual([both.action, both.kg], ["deload", 62.5]);
  assert.match(both.reasons[0], /HRV and recovery on waking are both below/);
  const one = decide([ev(70, HIT)], { gates: { recoveryOne: true } });
  assert.deepEqual([one.action, one.kg, one.target], ["hold", 70, "4x8@70kg"]);
  assert.match(one.reasons[0], /HRV or recovery on waking is below your band: no increase/);
  const unread = decide([ev(70, HIT)], { gates: { incomplete: true } });
  assert.deepEqual([unread.action, unread.kg], ["hold", 70]);
  assert.match(unread.reasons[0], /could not be read: no increase/);
  assert.equal(decide([ev(70, MISS)], { gates: { recoveryOne: true } }).action, "hold", "a miss holds anyway");
  assert.equal(decide([ev(70, MISS), ev(70, MISS)], { gates: { recoveryOne: true, incomplete: true } }).action, "deload", "a stall still deloads");
});

test("decideLift: no kg load or no sets x reps in the plan's detail -> left as it is, whatever the gates say", () => {
  for (const baseDetail of ["BW 3x15", "BW+10kg 3x8", "RPE6 8-12"]) {
    const d = decide([ev(70, HIT)], { baseDetail, gates: { tsb: -50, tsbDeload: true, recoveryBoth: true } });
    assert.deepEqual([d.action, d.kg, d.target], ["unchanged", null, null], baseDetail);
  }
  assert.match(decide([], { baseDetail: "70kg RPE7" }).reasons[0], /no sets x reps/);
  assert.equal(decide([ev(1.25, HIT, "1.25kg 4x8")], { baseDetail: "1.25kg 4x8", gates: { tsb: -50, tsbDeload: true } }).action, "unchanged", "too light to go lower");
});

// ---------- the evidence ----------

const record = (key: string, date: string, ex: { name: string; detail: string | null; cut?: boolean }[]): WorkoutRecord => ({
  workoutKey: key,
  date,
  hr: null,
  exercises: ex.map((e) => ({ name: e.name, detail: e.detail, cut: e.cut ?? false, load: null, setsDone: 4, plannedSets: 4, restS: 90, restAfterSet1: null, deviations: [], reliable: true })),
});
const entry = (key: string, exercises: JournalEntry["exercises"]): JournalEntry => ({ workoutKey: key, loggedAt: "2026-11-01T00:00:00Z", exercises });
const sets = (reps: number[], kg: number) => reps.map((r) => ({ reps: r, kg }));

test("liftEvidence: only sessions with logged reps for that lift and the plan's own sets x reps, oldest first; the journal's weight wins", () => {
  const ordered = [
    record("a", "2026-10-12", [{ name: "Bench Press", detail: "65kg 4x8" }]),
    record("b", "2026-10-19", [{ name: "Bench Press", detail: "67.5kg 4x8" }]),
    record("c", "2026-10-26", [{ name: "Bench Press", detail: "70kg 5x5" }]), // another scheme
    record("d", "2026-11-02", [{ name: "Bench Press", detail: "70kg 4x8" }, { name: "Back Squat", detail: "100kg 4x8" }]),
    record("e", "2026-11-09", [{ name: "Bench Press", detail: "70kg 4x8" }]), // logged, but no reps
  ];
  const journal = {
    a: entry("a", [{ name: "bench press", sets: sets(HIT, 65) }]),
    // b: not logged
    c: entry("c", [{ name: "Bench Press", sets: sets([5, 5, 5, 5, 5], 70) }]),
    d: entry("d", [{ name: "Bench Press", sets: sets(MISS, 72.5) }, { name: "Back Squat", sets: sets(HIT, 100) }]),
    e: entry("e", [{ name: "Bench Press", sets: [{ kg: 70 }] }]),
  };
  const { evidence, skippedScheme } = liftEvidence("Bench Press", "70kg 4x8", ordered, journal);
  assert.deepEqual(evidence.map((e) => [e.date, e.kg]), [["2026-10-12", 65], ["2026-11-02", 72.5]], "b has no log, c is another scheme, e logged no reps");
  assert.equal(skippedScheme, 1);
  assert.equal(liftEvidence("Back Squat", "100kg 4x8", ordered, journal).evidence.length, 1);
  assert.equal(liftEvidence("Overhead Press", "40kg 4x8", ordered, journal).evidence.length, 0);
  // a plan whose detail has no sets x reps matches any scheme the session itself had
  assert.equal(liftEvidence("Bench Press", "70kg", ordered, journal).evidence.length, 3);
});

test("liftEvidence: a name the guide cut still matches, a similar name does not", () => {
  const ordered = [record("a", "2026-11-02", [{ name: "Seated Cable Row W", detail: "55kg 4x8", cut: true }, { name: "Squat", detail: "80kg 4x8" }])];
  const journal = { a: entry("a", [{ name: "Seated Cable Row W", sets: sets(HIT, 55) }, { name: "Squat", sets: sets(HIT, 80) }]) };
  assert.equal(liftEvidence("Seated Cable Row Wide Grip", "55kg 4x8", ordered, journal).evidence.length, 1);
  assert.equal(liftEvidence("Squat Jump", "55kg 4x8", ordered, journal).evidence.length, 0);
});

// ---------- the base week ----------

const guideOf = (date: string, title = "PUSH PULL A") => ({
  title,
  date,
  exercises: [
    { name: "Back Squat", detail: "100kg 3x5", sets: 3, restSec: 120, plates: "2x20+1x5/side" },
    { name: "Bench Press", detail: "70kg 3x8", sets: 3, restSec: 90, last: "3x8@67.5kg", target: "3x8@70kg" },
    { name: "Seated Cable Row", detail: "55kg 2x12", sets: 2, restSec: 60 },
  ],
});

test("baseWeek: the latest week before weekStart with a guided session, within 4 weeks; none -> null", () => {
  assert.equal(BASE_LOOKBACK_WEEKS, 4);
  const plan = (dates: string[]): Plan => ({ goal: "g", phases: [], sessions: dates.map((d) => ({ date: d, title: "S", guide: guideOf(d) as any })) });
  assert.equal(baseWeek(plan(["2026-11-11"]), "2026-11-16")?.monday, "2026-11-09");
  assert.equal(baseWeek(plan(["2026-10-21"]), "2026-11-16")?.monday, "2026-10-19", "4 weeks back is the limit");
  assert.equal(baseWeek(plan(["2026-10-18"]), "2026-11-16"), null, "5 weeks back is not");
  assert.equal(baseWeek(plan(["2026-11-09", "2026-11-02"]), "2026-11-16")?.monday, "2026-11-09", "the latest wins");
  assert.equal(baseWeek(plan(["2026-11-16"]), "2026-11-16"), null, "the week itself is not a base");
  const noGuide: Plan = { goal: "g", phases: [], sessions: [{ date: "2026-11-11", title: "Run" }] };
  assert.equal(baseWeek(noGuide, "2026-11-16"), null, "a session without a guide has nothing to progress");
  assert.equal(baseWeek({ goal: "g", phases: [], sessions: [{ date: "2026-11-09", title: "Run" }, { date: "2026-11-10", title: "Lift", guide: guideOf("2026-11-10") as any }] }, "2026-11-16")?.sessions.length, 2, "the whole week is the base, runs included");
});

// ---------- the whole call, on a fake account ----------

const NOW = new Date(2026, 10, 13, 20, 0, 0); // Friday 2026-11-13, machine-local
const TODAY = "2026-11-13";
const NEXT_MONDAY = "2026-11-16";
const fixture = JSON.parse(readFileSync(new URL("../test-fixtures/compare/clean-3ex.laps.json", import.meta.url), "utf8"));
const keyOf = (n: number) => n.toString(16).padStart(24, "0");
const startOf = (date: string) => Date.parse(`${date}T17:00:00Z`);

function lapsResponse(key: string, startTime: number) {
  const markers = fixture.laps.rows.map(([, off, duration, avg, max, min, energy, , label]: any[]) => ({
    startTime: startTime + off * 1000,
    endTime: startTime + (off + duration) * 1000,
    totals: { duration, energy, hr: { min, avg, max }, intervalNotes: label?.replaceAll(" | ", "\f") ?? null },
  }));
  return { payload: { workoutKey: key, activityId: 23, startTime, totalTime: fixture.totalTimeS, extensions: [{ type: "ManualLapStreamExtension", markers }] } };
}
function parsedFor(startMs: number): ParsedFit {
  const records = [];
  for (let t = 0; t <= Math.ceil(fixture.totalTimeS) + 5; t++) {
    const lap = fixture.laps.rows.find(([, off, dur]: any[]) => t >= off && t < off + dur) ?? fixture.laps.rows[fixture.laps.rows.length - 1];
    const [, off, dur, avg, max, min, , kind] = lap;
    records.push({ timestamp: new Date(startMs + t * 1000), heart_rate: Math.round(kind === "rest" ? max - ((max - min) * (t - off)) / dur : avg) });
  }
  return { sessions: [{ start_time: new Date(startMs) }], records };
}

interface Session {
  date: string;
  /** reps per set of each lift as logged (log_session); a lift left out is not logged */
  logged?: Record<string, number[]>;
  tss?: number;
  guide?: string;
}
interface Account {
  sessions: Session[];
  extra?: { date: string; tss: number; guide: string }[]; // workouts without laps (a run, another guide) that only carry load
  hrvToday?: number; // the night into today
  recoveryToday?: number;
}
const LOADS: Record<string, number> = { "Back Squat": 100, "Bench Press": 70, "Seated Cable Row": 55 };

function account(a: Account) {
  const calls: string[] = [];
  const keys = a.sessions.map((_, i) => keyOf(i + 1));
  const summary = (guide: string) => ({ extensions: [{ type: "SummaryExtension", apps: [{ name: guide }] }] });
  const rows = [
    ...a.sessions.map((s, i) => ({ workoutKey: keys[i], activityId: 23, startTime: startOf(s.date), timeOffsetInMinutes: 0, totalTime: 1134, tss: { trainingStressScore: s.tss ?? 50 }, extensionTypes: ["SUMMARY", "MANUALLAP"], ...summary(s.guide ?? "PUSH PULL A") })),
    ...(a.extra ?? []).map((e, i) => ({ workoutKey: keyOf(900 + i), activityId: 3, startTime: startOf(e.date), timeOffsetInMinutes: 0, totalTime: 3000, tss: { trainingStressScore: e.tss }, extensionTypes: ["SUMMARY"], ...summary(e.guide) })),
  ];
  const journal: Record<string, JournalEntry> = {};
  a.sessions.forEach((s, i) => {
    if (s.logged) journal[keys[i]] = entry(keys[i], Object.entries(s.logged).map(([name, reps]) => ({ name, sets: sets(reps, LOADS[name]) })));
  });
  // sleep and recovery for the 35 days up to today, a quiet band, today's values as asked
  const sleeps: any[] = [];
  const recoveries: any[] = [];
  for (let i = 35; i >= 0; i--) {
    const day = addDays(TODAY, -i);
    const night = addDays(day, -1);
    const hrv = i === 0 && a.hrvToday !== undefined ? a.hrvToday : 50 + ((i + 2) % 5);
    sleeps.push({ timestamp: `${night}T23:00:00.000Z`, entryData: { SleepId: Date.parse(`${night}T00:00:00Z`) / 1000, BedtimeStart: `${night}T23:00:00.000Z`, BedtimeEnd: `${day}T06:30:00.000Z`, Duration: 27000, IsNap: false, SleepQualityScore: 80, AvgHRV: hrv } });
    recoveries.push({ timestamp: `${day}T06:30:00.000Z`, entryData: { Balance: i === 0 && a.recoveryToday !== undefined ? a.recoveryToday : 0.6 + ((i + 2) % 5) / 100, StressState: 1 } });
  }
  const client = {
    listWorkouts: async (o: any) => {
      calls.push("workouts");
      const list = rows.filter((w) => (o.since == null || w.startTime >= o.since) && (o.until == null || w.startTime <= o.until));
      return { payload: list.sort((x, y) => y.startTime - x.startTime).slice(0, o.limit ?? 25) };
    },
    getWorkoutWithExtensions: async (key: string) => {
      calls.push("laps");
      return lapsResponse(key, rows.find((r) => r.workoutKey === key)!.startTime);
    },
    getWorkoutFit: async (key: string) => Buffer.from(key),
    listSleep: async (from: string, to: string) => selectNights({ payload: sleeps }, from, to),
    listRecovery: async (from: string, to: string) => selectDays({ payload: recoveries }, from, to),
    getDailyStats: async () => ({ payload: [] }),
  } as unknown as SuuntoClient;
  const parse = async (bytes: Buffer) => parsedFor(rows.find((r) => r.workoutKey === bytes.toString())!.startTime);
  return { client, calls, journal, deps: { now: NOW, history: { now: NOW.getTime(), parse, loadJournal: async () => journal } } };
}

async function withCacheOff<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.SUUNTO_CACHE;
  process.env.SUUNTO_CACHE = "off";
  clearFailedSessions();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SUUNTO_CACHE;
    else process.env.SUUNTO_CACHE = saved;
  }
}

const monday = (n: number) => addDays("2026-10-12", 7 * n); // 10-12, 10-19, 10-26, 11-02, 11-09
const ALL_HIT = { "Back Squat": [5, 5, 5], "Bench Press": [8, 8, 8], "Seated Cable Row": [12, 12] };
// a plan whose last week (11-09..11-15) is one guided session and a run
const planStoreOf = async (sessions: Plan["sessions"] = [{ date: "2026-11-09", title: "Push pull", guide: guideOf("2026-11-09") as any }, { date: "2026-11-13", title: "Easy run" }]) => {
  const store = memoryPlanStore();
  await setPlan({ goal: "Get stronger", sessions }, store);
  return store;
};
const sixSessions = (logged: (i: number) => Session["logged"]): Session[] => [monday(0), monday(1), monday(2), monday(3), monday(4)].map((date, i) => ({ date, logged: logged(i) }));
const propose = (acc: ReturnType<typeof account>, store: PlanStore, args: unknown = {}) => withCacheOff(() => proposeNextWeek(acc.client, store, args, acc.deps));

test("proposeNextWeek: no plan, or a plan with nothing guided to repeat, is insufficient and reads nothing from Suunto", async () => {
  const acc = account({ sessions: sixSessions(() => ALL_HIT) });
  const none = await propose(acc, memoryPlanStore());
  assert.equal(none.status, "insufficient");
  assert.match(none.missing[0], /No training plan is stored/);
  assert.deepEqual([none.sessions, none.guides, none.changes, none.forecast, none.risk], [[], [], [], null, null]);
  const runOnly = await propose(acc, await planStoreOf([{ date: "2026-11-11", title: "Run" }]));
  assert.equal(runOnly.status, "insufficient");
  assert.match(runOnly.missing[0], /no session with a strength guide in the 4 weeks before 2026-11-16/);
  const old = await propose(acc, await planStoreOf([{ date: "2026-10-14", title: "Lift", guide: guideOf("2026-10-14") as any }]));
  assert.equal(old.status, "insufficient", "the only guided week is 5 weeks back");
  assert.deepEqual(acc.calls, [], "no request before the plan is usable");
  for (const r of [none, runOnly, old]) assert.deepEqual(Object.keys(r), Object.keys(await propose(acc, await planStoreOf())), "the same keys either way");
});

test("proposeNextWeek: progressions only from evidence; too little history (fewer than 2 logged sessions) proposes nothing", async () => {
  assert.equal(MIN_LOGGED_SESSIONS, 2);
  assert.equal(HISTORY_WEEKS, 8);
  const one = account({ sessions: [{ date: monday(3), logged: ALL_HIT }, { date: monday(4) }] });
  const thin = await propose(one, await planStoreOf());
  assert.equal(thin.status, "insufficient");
  assert.match(thin.missing[0], /Too little history: 1 session\(s\) with logged sets .* at least 2 are needed/);
  assert.deepEqual([thin.sessions, thin.guides], [[], []]);
  assert.equal((thin.history as any).loggedSessions, 1);

  const two = account({ sessions: [{ date: monday(3), logged: ALL_HIT }, { date: monday(4), logged: ALL_HIT }] });
  assert.equal((await propose(two, await planStoreOf())).status, "ok", "2 is enough");
});

test("proposeNextWeek: everything hit -> each load goes up, dates move a week on, last/target are set, plates dropped, set_plan and push_week_plan accept it as it is", async () => {
  const acc = account({ sessions: sixSessions(() => ALL_HIT), extra: [{ date: "2026-11-13", tss: 40, guide: "Easy run" }] });
  const store = await planStoreOf();
  const before = JSON.stringify(await store.load());
  const out = await propose(acc, store);
  assert.equal(out.status, "ok");
  assert.deepEqual([out.weekStart, out.weekEnd, out.asOf, out.planSource, out.basedOn], [NEXT_MONDAY, "2026-11-22", TODAY, "stored", { from: "2026-11-09", to: "2026-11-15" }]);
  assert.deepEqual(out.sessions.map((s: any) => [s.date, s.title]), [["2026-11-16", "Push pull"], ["2026-11-20", "Easy run"]]);
  const g: any = out.guides[0];
  assert.equal(g.date, "2026-11-16");
  assert.deepEqual(g.exercises.map((e: any) => [e.name, e.detail, e.target]), [["Back Squat", "102.5kg 3x5", "3x5@102.5kg"], ["Bench Press", "72.5kg 3x8", "3x8@72.5kg"], ["Seated Cable Row", "57.5kg 2x12", "2x12@57.5kg"]]);
  assert.equal(g.exercises[0].plates, undefined, "plates described the old load");
  assert.equal(g.exercises[1].last, "3x8@70kg");
  const bench = out.changes.find((c: any) => c.exercise === "Bench Press");
  assert.deepEqual([bench.action, bench.changed, bench.from, bench.to], ["progress", true, { detail: "70kg 3x8", kg: 70 }, { detail: "72.5kg 3x8", kg: 72.5 }]);
  assert.ok(bench.reasons.length > 0);
  assert.match(out.changes.find((c: any) => c.exercise === "Back Squat").reasons.join(" "), /Plates removed/);
  // passes straight on
  const target = memoryPlanStore();
  const saved = await setPlan({ goal: "x", sessions: out.sessions }, target);
  assert.equal(saved.saved, true);
  const week = await planWeek(out.guides, { dryRun: true, appName: undefined, validate: () => [], push: async () => assert.fail("a dry run pushes nothing") });
  assert.equal(week.ok, true);
  assert.deepEqual(week.wouldPush, [{ date: "2026-11-16", title: "PUSH PULL A", exercises: 3, sets: 8 }]);
  assert.equal(JSON.stringify(await store.load()), before, "the stored plan was not touched");
});

test("proposeNextWeek: a lift with no log stays as it is (never raised without evidence), a miss holds, two misses in a row deload", async () => {
  const acc = account({
    sessions: [
      { date: monday(1), logged: { "Back Squat": [5, 5, 4], "Bench Press": [8, 8, 8] } },
      { date: monday(2), logged: { "Back Squat": [5, 5, 4], "Bench Press": [8, 8, 7] } },
      { date: monday(3), logged: { "Back Squat": [5, 4, 4], "Bench Press": [8, 8, 8] } },
      { date: monday(4), logged: { "Back Squat": [5, 5, 3], "Bench Press": [8, 8, 7] } },
    ],
  });
  const out = await propose(acc, await planStoreOf());
  const by = Object.fromEntries(out.changes.map((c: any) => [c.exercise, c]));
  assert.deepEqual([by["Back Squat"].action, by["Back Squat"].to.detail], ["deload", "90kg 3x5"], "four misses in a row: 100 -> 90");
  assert.deepEqual([by["Bench Press"].action, by["Bench Press"].to.detail], ["hold", "70kg 3x8"], "a hit then a miss: hold");
  assert.deepEqual([by["Seated Cable Row"].action, by["Seated Cable Row"].changed, by["Seated Cable Row"].to.detail], ["unchanged", false, "55kg 2x12"]);
  assert.match(by["Seated Cable Row"].reasons[0], /No evidence/);
  assert.equal((out.guides[0] as any).exercises[1].target, "3x8@70kg");
});

test("proposeNextWeek: recovery and load gates come from today's baselines and TSB, with the reasons", async () => {
  const hist = sixSessions(() => ALL_HIT);
  const one = await propose(account({ sessions: hist, hrvToday: 20 }), await planStoreOf());
  assert.deepEqual(one.signals, { ...(one.signals as any), hrv: "below", recoveryMorning: "within" });
  assert.ok(one.changes.every((c: any) => c.action !== "progress" && !c.changed), "one below: held, nothing raised");
  assert.match(one.reasons.join(" "), /One of HRV \/ recovery on waking is below your band: no load is increased/);
  const both = await propose(account({ sessions: hist, hrvToday: 20, recoveryToday: 0.1 }), await planStoreOf());
  assert.ok(both.changes.every((c: any) => c.action === "deload"), "both below: every load deloaded");
  assert.deepEqual(both.guides[0] && (both.guides[0] as any).exercises.map((e: any) => e.detail), ["90kg 3x5", "62.5kg 3x8", "50kg 2x12"]);
  assert.match(both.reasons.join(" "), /both below your band/);
  const calm = await propose(account({ sessions: hist }), await planStoreOf());
  assert.ok(calm.changes.every((c: any) => c.action === "progress"));
  assert.deepEqual(calm.reasons, []);
});

test("proposeNextWeek: an unread part of the history blocks every increase and says so", async () => {
  // 10 uncached guided sessions, 8 are read per call: 2 pending
  const many = Array.from({ length: 10 }, (_, i) => ({ date: addDays("2026-09-25", i * 4), logged: ALL_HIT }));
  const out = await propose(account({ sessions: many }), await planStoreOf());
  assert.equal(out.status, "ok");
  assert.equal((out.history as any).pending, 2);
  assert.ok(out.changes.every((c: any) => c.action === "hold"), JSON.stringify(out.changes.map((c: any) => c.action)));
  assert.match(out.reasons.join(" "), /Part of the history was not read \(pending 2, 0 failed\): no load is increased/);
});

test("proposeNextWeek: weekStart must be a future Monday (default: the next one), unknown fields and rules are refused before any request", async () => {
  const acc = account({ sessions: sixSessions(() => ALL_HIT) });
  const store = await planStoreOf();
  const bad = async (args: unknown, re: RegExp) => {
    await assert.rejects(propose(acc, store, args), re);
  };
  await bad({ weekStart: "2026-11-17" }, /weekStart 2026-11-17 is not a Monday \(the Monday of that week is 2026-11-16\)/);
  await bad({ weekStart: "2026-11-09" }, /weekStart 2026-11-09 must be after today \(2026-11-13\)/);
  await bad({ weekStart: "2026-02-30" }, /weekStart must be a calendar date/);
  await bad({ weekStart: 5 }, /weekStart must be a calendar date/);
  await bad({ rules: { bogus: 1 } }, /rules.bogus is not a known rule/);
  await bad({ extra: 1 }, /extra is not a known field \(allowed: weekStart, rules\)/);
  await bad("x", /arguments must be an object/);
  assert.deepEqual(acc.calls, []);
  assert.equal((await propose(acc, store, { weekStart: "2026-11-23" })).weekStart, "2026-11-23");
  assert.equal((await propose(acc, store, {})).weekStart, NEXT_MONDAY);
  // today a Monday: the next Monday is a week on
  const mondayNow = { ...acc.deps, now: new Date(2026, 10, 9, 20, 0, 0) };
  await withCacheOff(async () => assert.equal((await proposeNextWeek(acc.client, store, {}, mondayNow)).weekStart, "2026-11-16"));
  await withCacheOff(() => assert.rejects(proposeNextWeek(acc.client, store, { weekStart: "2026-11-09" }, mondayNow), /weekStart 2026-11-09 must be after today \(2026-11-09\)/));
  await withCacheOff(async () => assert.equal((await proposeNextWeek(acc.client, store, { weekStart: "2026-11-16" }, mondayNow)).weekStart, "2026-11-16"));
});

test("proposeNextWeek: a rule override is used and reported", async () => {
  const acc = account({ sessions: sixSessions(() => ALL_HIT) });
  const out = await propose(acc, await planStoreOf(), { rules: { incrementKg: 1.25, deloadPct: 15 } });
  assert.equal((out.guides[0] as any).exercises[1].detail, "71.25kg 3x8");
  const used: any = Object.fromEntries(out.rulesUsed.map((r) => [r.name, r]));
  assert.deepEqual([used.incrementKg.value, used.incrementKg.overridden, used.deloadPct.value, used.stallSessions.overridden], [1.25, true, 15, false]);
});

test("proposeNextWeek: the forecast is forecast_training_load's own projection, from today's values, through the proposed week", async () => {
  const acc = account({ sessions: sixSessions(() => ALL_HIT), extra: [{ date: "2026-11-13", tss: 40, guide: "Easy run" }] });
  const out = await propose(acc, await planStoreOf());
  const days = out.estimates.map((e: any) => ({ date: e.date, tss: e.tss ?? 0 }));
  if (!days.some((d: any) => d.date === out.weekEnd)) days.push({ date: out.weekEnd, tss: 0 });
  const expected = await forecastTrainingLoad(acc.client, { asOf: TODAY, days });
  assert.deepEqual((out.forecast as any).series, expected.series);
  assert.deepEqual((out.forecast as any).start, expected.start);
  assert.deepEqual(out.estimates.map((e: any) => [e.date, e.title, e.tss, e.sessions, e.scope]), [["2026-11-16", "PUSH PULL A", 50, 5, "proposed"], ["2026-11-20", "Easy run", null, 1, "proposed"]]);
});

test("proposeNextWeek: sessions without a TSS estimate count as 0 and are named; the week's load and TSB are checked against the stated floors", async () => {
  const acc = account({ sessions: sixSessions(() => ALL_HIT), extra: [{ date: "2026-11-13", tss: 40, guide: "Easy run" }] });
  const out = await propose(acc, await planStoreOf());
  const est = out.estimates.map((e: any) => [e.date, e.title, e.tss, e.scope]);
  assert.deepEqual(est, [["2026-11-16", "PUSH PULL A", 50, "proposed"], ["2026-11-20", "Easy run", null, "proposed"]], "one 'Easy run' with a TSS is below the 2 needed");
  assert.match(out.notes.join(" "), /counts as 0 \(2026-11-20 Easy run\)/);
  assert.equal((out.risk as any).weeklyLoad.complete, false);
  assert.deepEqual([(out.risk as any).level, (out.risk as any).flags], ["none", []]);
  assert.deepEqual((out.risk as any).weeklyLoad, { threshold: 30, proposedTss: 50, previous4wAvgTss: 60, jumpPct: -16.7, complete: false });
});

test("proposeNextWeek: a heavy week trips the weekly-jump and TSB-floor flags, and the caller's thresholds move them", async () => {
  // PUSH PULL A normally scores 50; the proposed guide is a 'BIG' one that scored 400 twice, 60 and 70 days ago
  const acc = account({
    sessions: sixSessions(() => ALL_HIT),
    extra: [{ date: addDays(TODAY, -60), tss: 400, guide: "BIG" }, { date: addDays(TODAY, -70), tss: 400, guide: "BIG" }],
  });
  const store = await planStoreOf([{ date: "2026-11-09", title: "Big day", guide: guideOf("2026-11-09", "BIG") as any }]);
  const out = await propose(acc, store);
  const risk: any = out.risk;
  assert.equal(risk.level, "caution");
  assert.deepEqual(risk.flags.map((f: any) => f.rule), ["tsb-floor", "weekly-load-jump"]);
  assert.equal(risk.weeklyLoad.proposedTss, 400);
  assert.equal(risk.weeklyLoad.jumpPct, 700, "400 against an average week of 50");
  assert.ok(risk.tsbFloor.minTsb < -30);
  const lax = await propose(acc, store, { rules: { tsbRiskFloor: -60 } });
  assert.deepEqual((lax.risk as any).flags.map((f: any) => f.rule), ["weekly-load-jump"], "only the TSB line moved");
  assert.equal((lax.risk as any).tsbFloor.threshold, -60);
});

test("proposeNextWeek: deterministic, and nothing is written (no file, the plan untouched)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-propose-"));
  const saved = { ...process.env };
  process.env.SUUNTO_PLAN_PATH = join(dir, "plan.json");
  process.env.SUUNTO_JOURNAL_PATH = join(dir, "journal.json");
  process.env.SUUNTO_CACHE_DIR = join(dir, "cache");
  try {
    const acc = account({ sessions: sixSessions(() => ALL_HIT) });
    let saves = 0;
    const inner = await planStoreOf();
    const store: PlanStore = { load: () => inner.load(), save: async () => void saves++ };
    const a = JSON.stringify(await propose(acc, store));
    const b = JSON.stringify(await propose(acc, store));
    assert.equal(a, b);
    assert.equal(saves, 0, "the plan store was never written");
    assert.deepEqual(await readdir(dir), [], "no file anywhere");
  } finally {
    for (const k of ["SUUNTO_PLAN_PATH", "SUUNTO_JOURNAL_PATH", "SUUNTO_CACHE_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("suggestProgression is still the source of the step (a drift guard for hit())", () => {
  const s = suggestProgression({ sessions: { cols: COLS, rows: [rowOf(70, HIT)] } });
  assert.deepEqual([s.last, s.target], ["4x8@70kg", "4x8@72.5kg"]);
  assert.deepEqual(suggestProgression({ sessions: { cols: COLS, rows: [rowOf(70, MISS)] } }).target, "4x8@70kg");
});

test("proposeNextWeek: a guideId in the stored guide is dropped (push_week_plan only creates new guides); a stored plan wins over the demo plan, which is used only when none is stored", async () => {
  const acc = account({ sessions: sixSessions(() => ALL_HIT) });
  const withId = await planStoreOf([{ date: "2026-11-09", title: "Push pull", guide: { ...guideOf("2026-11-09"), guideId: "abc123" } as any }]);
  const out = await propose(acc, withId);
  assert.equal("guideId" in (out.guides[0] as object), false);
  const demoPlan = (weekStart: string): Plan => ({ goal: "demo", phases: [], sessions: [{ date: addDays(weekStart, -7), title: "Demo", guide: guideOf(addDays(weekStart, -7), "DEMO") as any }] });
  const both = await withCacheOff(() => proposeNextWeek(acc.client, withId, {}, { ...acc.deps, demoPlan }));
  assert.deepEqual([both.planSource, (both.sessions[0] as any).title], ["stored", "Push pull"]);
  const only = await withCacheOff(() => proposeNextWeek(acc.client, memoryPlanStore(), {}, { ...acc.deps, demoPlan }));
  assert.deepEqual([only.planSource, (only.sessions[0] as any).title], ["demo", "Demo"]);
});
