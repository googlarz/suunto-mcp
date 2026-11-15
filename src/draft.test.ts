import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDraft } from "./draft.js";
import { parseLogInput } from "./journal.js";
import type { ParsedFit } from "./fit.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/compare/${name}`, import.meta.url), "utf8"));
const keyOf = (i: number) => i.toString(16).padStart(24, "0");
const NOW = new Date("2026-11-01T12:00:00Z");

function lapsResponse(f: any, key: string, startTime: number) {
  const markers = f.laps.rows.map(([, off, duration, avg, max, min, energy, , label]: any[]) => ({
    startTime: startTime + off * 1000,
    endTime: startTime + (off + duration) * 1000,
    totals: { duration, energy, hr: { min, avg, max }, intervalNotes: label?.replaceAll(" | ", "\f") ?? null },
  }));
  return { payload: { workoutKey: key, activityId: 23, startTime, timeOffsetInMinutes: 0, totalTime: f.totalTimeS, extensions: [{ type: "ManualLapStreamExtension", markers }] } };
}
// 1 Hz HR holding each lap's average, falling from max to min in a rest
function parsedFor(f: any, startMs: number, drop?: [number, number]): ParsedFit {
  const records = [];
  for (let t = 0; t <= Math.ceil(f.totalTimeS) + 5; t++) {
    if (drop && t >= drop[0] && t < drop[1]) continue;
    const lap = f.laps.rows.find(([, off, dur]: any[]) => t >= off && t < off + dur) ?? f.laps.rows[f.laps.rows.length - 1];
    const [, off, dur, avg, max, min, , kind] = lap;
    records.push({ timestamp: new Date(startMs + t * 1000), heart_rate: Math.round(kind === "rest" ? max - ((max - min) * (t - off)) / dur : avg) });
  }
  return { sessions: [{ start_time: new Date(startMs) }], records };
}

interface W {
  key: string;
  date: string;
  fixture: string;
  guided?: boolean;
  drop?: [number, number];
  noHr?: boolean;
  fitFails?: boolean;
}
function fake(workouts: W[]) {
  const calls = { list: 0, laps: [] as string[], fit: [] as string[] };
  const startOf = (w: W) => Date.parse(`${w.date}T10:00:00Z`);
  const client = {
    async listWorkouts() {
      calls.list++;
      return { payload: workouts.map((w, i) => ({ workoutKey: w.key, startTime: startOf(w) + i * 3_600_000, timeOffsetInMinutes: 0, extensionTypes: w.guided === false ? ["SUMMARY"] : ["SUMMARY", "MANUALLAP"] })) };
    },
    async getWorkoutWithExtensions(key: string) {
      calls.laps.push(key);
      const w = workouts.find((x) => x.key === key)!;
      return lapsResponse(fx(w.fixture), key, startOf(w));
    },
    async getWorkoutFit(key: string) {
      calls.fit.push(key);
      if (workouts.find((x) => x.key === key)!.fitFails) throw new Error("Suunto answered 500");
      return Buffer.from(key);
    },
  };
  const parse = async (bytes: Buffer): Promise<ParsedFit> => {
    const w = workouts.find((x) => x.key === bytes.toString())!;
    const p = parsedFor(fx(w.fixture), startOf(w), w.drop);
    return w.noHr ? { ...p, records: p.records!.map((r) => ({ ...r, heart_rate: undefined })) } : p;
  };
  return { client: client as any, calls, parse };
}
const one = (fixture: string, over: Partial<W> = {}) => fake([{ key: keyOf(1), date: "2026-10-30", fixture, ...over }]);

test("draft: a clean session becomes a log_session payload of the guide's sets x reps @ load, all marked as assumed", async () => {
  const f = one("clean-3ex.laps.json");
  const d = await buildDraft(f.client, { workoutKey: keyOf(1) }, { parse: f.parse });
  assert.deepEqual([d.status, d.assumed, d.date, d.workoutKey], ["ok", true, "2026-10-30", keyOf(1)]);
  assert.deepEqual(d.draft, {
    workoutKey: keyOf(1),
    source: "draft",
    exercises: [
      { name: "Back Squat", sets: [{ reps: 5, kg: 100 }, { reps: 5, kg: 100 }, { reps: 5, kg: 100 }] },
      { name: "Bench Press", sets: [{ reps: 8, kg: 70 }, { reps: 8, kg: 70 }, { reps: 8, kg: 70 }] },
      { name: "Seated Cable Row", sets: [{ reps: 12, kg: 55 }, { reps: 12, kg: 55 }] },
    ],
  });
  // the payload is exactly what log_session takes: it parses unchanged
  assert.doesNotThrow(() => parseLogInput(d.draft, NOW));
  assert.equal(parseLogInput(d.draft, NOW).source, "draft");
  assert.deepEqual(d.review.map((r) => [r.n, r.name, r.assumed, r.recordedSetLaps, r.proposedSets, r.mustConfirm, r.issues]), [
    [1, "Back Squat", true, 3, 3, ["reps", "kg"], []],
    [2, "Bench Press", true, 3, 3, ["reps", "kg"], []],
    [3, "Seated Cable Row", true, 2, 2, ["reps", "kg"], []],
  ]);
  assert.deepEqual(d.review[0].planned, { sets: 3, reps: 5, kg: 100 });
  assert.deepEqual([d.mapping!.format, d.mapping!.complete, d.mapping!.reliable], ["strength-perSet", true, true]);
  assert.equal(d.hrQuality!.reliable, true);
  assert.match(d.confirm[0], /guide's PLAN: the watch does not record them/);
  assert.ok(d.confirm.some((c) => /feeling, a note, tags, RPE/.test(c)));
  assert.match(d.notes.join(" "), /Read-only: nothing was written.*log_session.*source: 'draft'/);
  assert.deepEqual(f.calls.laps, [keyOf(1)]);
});

test("draft: it never writes: only read calls are made and no file appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-draft-"));
  const saved = process.env.SUUNTO_JOURNAL_PATH;
  process.env.SUUNTO_JOURNAL_PATH = join(dir, "journal.json");
  try {
    const f = one("clean-3ex.laps.json");
    const reads = Object.keys(f.client);
    assert.deepEqual(reads.sort(), ["getWorkoutFit", "getWorkoutWithExtensions", "listWorkouts"]);
    await buildDraft(f.client, { workoutKey: keyOf(1) }, { parse: f.parse });
    assert.deepEqual(await readdir(dir), []);
  } finally {
    if (saved === undefined) delete process.env.SUUNTO_JOURNAL_PATH;
    else process.env.SUUNTO_JOURNAL_PATH = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("draft: a set the heuristics doubt (a double lap press) is listed on its exercise, and the number of sets must be confirmed", async () => {
  const f = one("missing-set.laps.json");
  const d = await buildDraft(f.client, { workoutKey: keyOf(1) }, { parse: f.parse });
  const incline = d.review.find((r) => r.name === "Incline DB Press")!;
  assert.deepEqual(incline.issues.map((i) => i.code), ["short-set"]);
  assert.deepEqual(incline.mustConfirm, ["reps", "kg", "setCount"]);
  assert.match(incline.issues[0].detail, /likely an accidental double lap press/);
  assert.ok(d.confirm.some((c) => /^Incline DB Press: check the number of sets \(3 set lap\(s\) on the watch; short-set\)/.test(c)));
  assert.deepEqual(d.review.find((r) => r.name === "Lat Pulldown")!.mustConfirm, ["reps", "kg"], "no deviation on this one without the plan");
});

test("draft: with the plan, missing and extra sets and what came after 'Session complete' are listed; the proposed count is what the watch recorded", async () => {
  const f = one("extra-set.laps.json");
  const d = await buildDraft(f.client, { workoutKey: keyOf(1), plan: fx("extra-set.plan.json") }, { parse: f.parse });
  const leg = d.review.find((r) => r.name === "Leg Press")!;
  assert.deepEqual(leg.issues.map((i) => i.code), ["extra-set"]);
  assert.deepEqual(d.review.find((r) => r.name === "Romanian Deadlift")!.issues.map((i) => i.code), ["long-set"]);
  assert.equal(leg.proposedSets, 4);
  assert.equal(leg.recordedSetLaps, 4);
  assert.deepEqual(d.draft!.exercises.find((e) => e.name === "Leg Press")!.sets.length, 4);
  assert.deepEqual(d.sessionIssues.map((i) => i.code), ["after-complete"]);
  assert.ok(d.confirm.some((c) => /^after-complete: 2 lap\(s\) pressed after 'Session complete'/.test(c)));

  const m = one("missing-set.laps.json");
  const miss = await buildDraft(m.client, { workoutKey: keyOf(1), plan: fx("missing-set.plan.json") }, { parse: m.parse });
  const lat = miss.review.find((r) => r.name === "Lat Pulldown")!;
  assert.ok(lat.issues.some((i) => i.code === "missing-set" && /3 of 4 planned sets recorded/.test(i.detail)));
  assert.equal(lat.proposedSets, 3, "the draft does not invent the set the watch did not record");
});

test("draft: a per-exercise guide has one lap per exercise, so the set count is the plan's and must be confirmed; '3x40m' is a distance, not reps", async () => {
  const f = one("per-exercise.laps.json");
  const d = await buildDraft(f.client, { workoutKey: keyOf(1) }, { parse: f.parse });
  assert.equal(d.mapping!.format, "strength-perExercise");
  const kb = d.review[0];
  assert.deepEqual([kb.name, kb.recordedSetLaps, kb.proposedSets, kb.mustConfirm], ["Kettlebell Swing", 1, 4, ["reps", "kg", "setCount"]]);
  assert.match(kb.whyNotFilled.join(" "), /one lap for the whole exercise, so the number of sets is the plan's/);
  assert.deepEqual(d.draft!.exercises[0], { name: "Kettlebell Swing", sets: Array.from({ length: 4 }, () => ({ reps: 15, kg: 24 })) });
  const carry = d.review[1];
  assert.deepEqual(carry.planned, { sets: 3, reps: null, kg: 32 });
  assert.match(carry.whyNotFilled.join(" "), /a distance or a time, not reps/);
  assert.deepEqual(d.draft!.exercises[1], { name: "Farmer Carry", sets: Array.from({ length: 3 }, () => ({ kg: 32 })) }, "the weight is proposed, the reps are left for the user");
  assert.doesNotThrow(() => parseLogInput(d.draft, NOW));
});

test("draft: a session with no laps or no guide labels cannot be drafted; the draft is null and says what to do", async () => {
  for (const [fixture, status] of [["no-laps.laps.json", "no-laps"], ["unguided.laps.json", "no-guide-labels"]] as const) {
    const f = one(fixture);
    const d = await buildDraft(f.client, { workoutKey: keyOf(1) }, { parse: f.parse });
    assert.deepEqual([d.status, d.draft, d.review], [status, null, []], fixture);
    assert.match(d.notes.join(" "), /Nothing can be drafted: ask the user what they did and call log_session/);
    assert.deepEqual(f.calls.fit, [], "no FIT download for a session that cannot be mapped");
  }
});

test("draft: a session that stopped inside the guide says so; with the plan the exercises not reached are listed", async () => {
  const f = one("ended-early.laps.json");
  const d = await buildDraft(f.client, { workoutKey: keyOf(1), plan: fx("ended-early.plan.json") }, { parse: f.parse });
  assert.equal(d.mapping!.complete, false);
  assert.ok(d.confirm.some((c) => /did not reach 'Session complete'/.test(c)));
  assert.deepEqual(d.sessionIssues.map((i) => i.code), ["missing-exercise"]);
  assert.ok(d.confirm.some((c) => /^missing-exercise: "[^"]+" was not reached: the session ended early/.test(c)));
  assert.ok(d.review[1].issues.some((i) => i.code === "ended-early"));
  // the label says 3x8 but the watch recorded 2 set laps: the draft proposes what the watch shows, not the plan
  assert.deepEqual([d.review[1].name, d.review[1].planned!.sets, d.review[1].recordedSetLaps, d.review[1].proposedSets], ["Barbell Row", 3, 2, 2]);
  assert.equal(d.draft!.exercises[1].sets.length, 2);
});

test("draft: an unreliable lap mapping is said at the top of the list to check", async () => {
  const f = one("checks-split-rest.laps.json");
  const d = await buildDraft(f.client, { workoutKey: keyOf(1) }, { parse: f.parse });
  assert.equal(d.mapping!.reliable, false);
  assert.ok(d.confirm.some((c) => /^The mapping of laps to exercises is unreliable/.test(c)));
});

test("draft: heart-rate dropouts, a FIT without heart rate and an unreadable FIT are reported, and the draft is still returned", async () => {
  const f = one("clean-3ex.laps.json", { drop: [100, 900] });
  const bad = await buildDraft(f.client, { workoutKey: keyOf(1) }, { parse: f.parse });
  assert.equal(bad.hrQuality!.reliable, false);
  assert.ok(bad.confirm.some((c) => /^Heart-rate data is unreliable \(/.test(c)));
  assert.ok(bad.draft);

  const n = one("clean-3ex.laps.json", { noHr: true });
  const none = await buildDraft(n.client, { workoutKey: keyOf(1) }, { parse: n.parse });
  assert.equal(none.hrQuality!.reliable, null);
  assert.ok(none.confirm.some((c) => /^Heart-rate data is missing/.test(c)));

  const x = one("clean-3ex.laps.json", { fitFails: true });
  const fails = await buildDraft(x.client, { workoutKey: keyOf(1) }, { parse: x.parse });
  assert.equal(fails.hrQuality, null);
  assert.match(fails.notes.join(" "), /Heart-rate quality was not checked: the FIT file could not be read \(Suunto answered 500\)/);
  assert.ok(fails.draft);
});

test("draft: by date it takes the latest guided session of that day and says there were more; none gives status no-workout", async () => {
  const f = fake([
    { key: keyOf(1), date: "2026-10-30", fixture: "clean-3ex.laps.json" },
    { key: keyOf(2), date: "2026-10-30", fixture: "missing-set.laps.json" },
    { key: keyOf(3), date: "2026-10-30", fixture: "clean-3ex.laps.json", guided: false },
    { key: keyOf(4), date: "2026-10-29", fixture: "clean-3ex.laps.json" },
  ]);
  const d = await buildDraft(f.client, { date: "2026-10-30" }, { parse: f.parse });
  assert.equal(d.workoutKey, keyOf(2), "the later of the two guided sessions; the unguided one and the other day are not candidates");
  assert.match(d.notes.join(" "), /2 guided sessions on 2026-10-30: this is the latest; pass workoutKey for another/);
  assert.deepEqual(f.calls.laps, [keyOf(2)]);

  const none = await buildDraft(f.client, { date: "2026-10-28" }, { parse: f.parse });
  assert.deepEqual([none.status, none.draft, none.workoutKey, none.notes], ["no-workout", null, null, ["No workout on 2026-10-28."]]);
  const unguided = await buildDraft(fake([{ key: keyOf(3), date: "2026-10-30", fixture: "clean-3ex.laps.json", guided: false }]).client, { date: "2026-10-30" });
  assert.match(unguided.notes[0], /1 workout\(s\) on 2026-10-30, none with guide laps/);
});

test("draft: needs exactly one of workoutKey and date, a real key and a real date", async () => {
  const f = one("clean-3ex.laps.json");
  await assert.rejects(buildDraft(f.client, {}), /either workoutKey or date/);
  await assert.rejects(buildDraft(f.client, { workoutKey: keyOf(1), date: "2026-10-30" }), /either workoutKey or date/);
  await assert.rejects(buildDraft(f.client, { workoutKey: "abc" }), /24-character hex key/);
  await assert.rejects(buildDraft(f.client, { workoutKey: `${keyOf(1)}0` }), /24-character hex key/);
  await assert.rejects(buildDraft(f.client, { date: "2026-02-30" }), /not a valid calendar date/);
  assert.equal(f.calls.list + f.calls.laps.length, 0, "refused before Suunto is called");
  assert.equal((await buildDraft(f.client, { workoutKey: keyOf(1).toUpperCase() }, { parse: f.parse })).workoutKey, keyOf(1), "the key is accepted in either case");
});
