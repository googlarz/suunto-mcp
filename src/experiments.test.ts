import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXACT_MAX_BLOCKS,
  MIN_NIGHTS_PER_ARM,
  PERMUTATION_DRAWS,
  analyzeExperiment,
  fileExperimentStore,
  generateSchedule,
  getExperiment,
  logExperimentDay,
  memoryExperimentStore,
  permutationTest,
  startExperiment,
  stopExperiment,
  verdictOf,
  type Block,
  type Experiment,
  type ScheduleDay,
} from "./experiments.js";
import { mulberry32 } from "./prng.js";
import { thresholdOf } from "./tag-effects.js";
import { addDays } from "./training-load.js";

const at = (date: string, hour = 12) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`); // local time
const D0 = "2026-10-01"; // the day the experiment is started (a Thursday)
const NOW0 = at(D0);
const design = (over: Record<string, unknown> = {}) => ({ name: "No caffeine after noon", intervention: "No caffeine after 12:00", control: "Usual caffeine", metric: "sleepScore", days: 28, ...over });
const arms = (s: ScheduleDay[]) => s.map((d) => ({ intervention: "I", control: "C", washout: "w", none: "." })[d.arm]).join("");

// ---------- the schedule ----------

const ALL = { startDate: "2026-10-02", days: 28, washout: 0 };

test("schedule: pinned for a seed (a changed generator would silently change what 'seed' means for stored experiments)", () => {
  assert.equal(arms(generateSchedule({ ...ALL, days: 14 }, 7)), "ICICCICICIICIC");
});

test("schedule: every pair of consecutive trial days holds one intervention and one control, so the arms are always balanced", () => {
  for (let seed = 0; seed < 300; seed++) {
    for (const d of [{ ...ALL, days: 14 }, { ...ALL, days: 15 }, { ...ALL, days: 29, washout: 1 }, { ...ALL, days: 40, washout: 2 }, { ...ALL, days: 30, eligible: ["mon" as const, "wed" as const, "thu" as const] }]) {
      const s = generateSchedule(d, seed);
      assert.equal(s.length, d.days);
      s.forEach((x, i) => assert.equal(x.date, addDays(d.startDate, i)));
      const trial = s.filter((x) => x.arm === "intervention" || x.arm === "control");
      assert.equal(trial.filter((x) => x.arm === "intervention").length, trial.length / 2, `seed ${seed}`);
      const blocks = new Map<number, string[]>();
      for (const x of trial) blocks.set(x.block!, [...(blocks.get(x.block!) ?? []), x.arm]);
      for (const [, b] of blocks) assert.deepEqual([...b].sort(), ["control", "intervention"]);
      assert.deepEqual([...blocks.keys()], [...blocks.keys()].map((_, i) => i + 1), "blocks are numbered in order");
      assert.ok(s.filter((x) => x.arm !== "intervention" && x.arm !== "control").every((x) => x.block === undefined));
    }
  }
});

test("schedule: the same seed always gives the same schedule, another seed (almost always) another one", () => {
  const a = generateSchedule(ALL, 12345);
  assert.deepEqual(generateSchedule(ALL, 12345), a);
  const distinct = new Set(Array.from({ length: 50 }, (_, i) => arms(generateSchedule(ALL, i))));
  assert.ok(distinct.size >= 45, `${distinct.size} distinct schedules from 50 seeds`);
});

test("schedule: the order inside a pair is a fair coin (about half the pairs start with the intervention)", () => {
  let first = 0;
  let total = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const s = generateSchedule({ ...ALL, days: 14 }, seed);
    for (const b of new Set(s.map((x) => x.block))) {
      total++;
      if (s.find((x) => x.block === b)!.arm === "intervention") first++;
    }
  }
  assert.ok(first / total > 0.47 && first / total < 0.53, `${first}/${total}`);
});

test("schedule: the washout days follow every intervention day and only those; a control day needs none", () => {
  let controlThenTrial = false;
  for (const washout of [1, 2]) {
    for (let seed = 0; seed < 100; seed++) {
      const s = generateSchedule({ ...ALL, days: 40, washout }, seed);
      s.forEach((x, i) => {
        if (x.arm === "intervention") for (let j = 1; j <= washout && i + j < s.length; j++) assert.ok(s[i + j].arm === "washout" || (s[i + j].arm === "none" && i + j >= 36), `seed ${seed}: day ${i + j} after an intervention day`);
        if (x.arm === "washout") assert.ok(i > 0 && (s[i - 1].arm === "intervention" || s[i - 1].arm === "washout"), "a washout day follows an intervention day or another washout day");
        if (x.arm === "control" && (s[i + 1]?.arm === "intervention" || s[i + 1]?.arm === "control")) controlThenTrial = true;
      });
    }
  }
  assert.ok(controlThenTrial, "a control day can be followed straight away by the next trial day");
});

test("schedule: only eligible weekdays carry a trial day (2026-10-02 is a Friday)", () => {
  const s = generateSchedule({ ...ALL, days: 28, eligible: ["mon", "wed", "fri"] }, 5);
  const weekday = (d: string) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${d}T00:00:00Z`).getUTCDay()];
  for (const x of s) {
    if (x.arm === "intervention" || x.arm === "control") assert.ok(["mon", "wed", "fri"].includes(weekday(x.date)), x.date);
    else assert.equal(x.arm, "none");
  }
  assert.equal(s.filter((x) => x.block !== undefined).length, 12);
});

test("schedule: an odd last trial day is dropped (and the washout after it), so the arms stay equal", () => {
  for (let seed = 0; seed < 100; seed++) {
    const s = generateSchedule({ ...ALL, days: 15 }, seed);
    assert.equal(s[14].arm, "none", `seed ${seed}`);
    assert.equal(s.filter((x) => x.arm === "intervention").length, 7);
  }
  // a dropped intervention day takes its washout days with it: the schedule ends in two or more unassigned days
  let tails = 0;
  for (let seed = 0; seed < 300; seed++) {
    for (let days = 14; days <= 24; days++) {
      const s = generateSchedule({ ...ALL, days, washout: 2 }, seed);
      if (s[days - 1].arm === "none" && s[days - 2].arm === "none") {
        tails++;
        assert.equal(s.filter((x) => x.arm === "intervention").length, s.filter((x) => x.arm === "control").length);
      }
    }
  }
  assert.ok(tails > 0, "found schedules whose dropped last day took its washout with it");
});

// ---------- start ----------

test("start_experiment: pre-registers the hypothesis and the analysis, draws the schedule up front and stores the seed", async () => {
  const store = memoryExperimentStore();
  const r = await startExperiment(design({ washout: 1 }), store, { now: NOW0, seed: 42 });
  const e = r.experiment;
  assert.deepEqual([e.id, e.startDate, e.endDate, e.days, e.washout, e.seed, e.createdAt], ["e1", "2026-10-02", "2026-10-29", 28, 1, 42, NOW0.toISOString()]);
  assert.match(e.hypothesis, /overnight|sleep score/);
  assert.match(e.hypothesis, /No caffeine after 12:00/);
  assert.match(e.hypothesis, /Two-sided/);
  const plan = e.analysisPlan.join("\n");
  for (const re of [/permutation test/, /seed 42/, /intention to treat/, /per protocol/i, /at least 6|fewer than 6/, /only once|run once/, /washout/]) assert.match(plan, re);
  assert.deepEqual(e.schedule, generateSchedule({ startDate: "2026-10-02", days: 28, washout: 1 }, 42), "the stored schedule is exactly what the seed draws");
  assert.deepEqual(await store.load(), { experiments: [e] });
  assert.equal(r.saved.status, "upcoming");
  assert.deepEqual(r.saved.progress.planned, { intervention: 9, control: 9 });
});

test("start_experiment: the stored schedule is never redrawn: reading it back, logging and stopping leave it as it was", async () => {
  const store = memoryExperimentStore();
  const { experiment } = await startExperiment(design(), store, { now: NOW0, seed: 9 });
  const before = JSON.stringify(experiment.schedule);
  const trial = experiment.schedule.find((s) => s.block !== undefined)!;
  await logExperimentDay({ date: trial.date, followed: true }, store, { now: at(trial.date, 20) });
  await getExperiment(store, {}, NOW0);
  await stopExperiment({ id: "e1", reason: "travelling" }, store, { now: at(trial.date, 21) });
  assert.equal(JSON.stringify((await store.load())!.experiments[0].schedule), before);
  assert.equal((await store.load())!.experiments[0].seed, 9);
});

test("start_experiment: without a seed it draws one, and the seed regenerates the stored schedule", async () => {
  const store = memoryExperimentStore();
  const { experiment: e } = await startExperiment(design(), store, { now: NOW0 });
  assert.ok(Number.isInteger(e.seed) && e.seed >= 0 && e.seed <= 4_294_967_295);
  assert.deepEqual(generateSchedule({ startDate: e.startDate, days: e.days, washout: e.washout }, e.seed), e.schedule);
  const other = await startExperiment(design({ metric: "hrv" }), store, { now: NOW0 });
  assert.notEqual(other.experiment.seed, e.seed, "two experiments do not share a seed (random 32-bit seeds)");
});

test("start_experiment: strict validation, with every limit tested on both sides", async () => {
  const bad: [unknown, RegExp][] = [
    [null, /object/],
    [design({ name: undefined }), /name is required/],
    [design({ name: " " }), /name must not be empty/],
    [design({ name: "x".repeat(101) }), /name must be at most 100/],
    [design({ intervention: undefined }), /intervention is required/],
    [design({ control: "x".repeat(501) }), /control must be at most 500/],
    [design({ metric: undefined }), /metric is required/],
    [design({ metric: "steps" }), /metric must be one of: sleepDurationS, sleepScore, hrv, recoveryMorning/],
    [design({ days: undefined }), /days is required/],
    [design({ days: 13 }), /days must be between 14 and 60/],
    [design({ days: 61 }), /days must be between 14 and 60/],
    [design({ days: 20.5 }), /days must be an integer/],
    [design({ washout: -1 }), /washout must be between 0 and 2/],
    [design({ washout: 3 }), /washout must be between 0 and 2/],
    [design({ eligible: [] }), /eligible must be a list of 1 to 7 weekdays/],
    [design({ eligible: ["mon", "funday"] }), /eligible must only hold/],
    [design({ eligible: ["mon", "mon"] }), /lists a weekday twice/],
    [design({ eligible: "mon" }), /eligible must be a list/],
    [design({ startDate: "2026-02-30" }), /startDate must be a calendar date/],
    [design({ startDate: "2026-09-30" }), /startDate .* before today/],
    [design({ startDate: "2026-12-01" }), /more than 60 days ahead/],
    [design({ seed: 1 }), /seed is not a known field/],
    [design({ eligible: ["mon", "tue"] }), /only 4 intervention and 4 control days: at least 6/],
  ];
  for (const [input, re] of bad) {
    const store = memoryExperimentStore();
    await assert.rejects(startExperiment(input, store, { now: NOW0, seed: 1 }), re, JSON.stringify(input));
    assert.equal(await store.load(), null, "nothing written");
  }
  // the accepted edges
  for (const input of [design({ days: 14 }), design({ days: 60 }), design({ washout: 2 }), design({ startDate: D0 }), design({ startDate: "2026-11-30" }), design({ eligible: ["mon", "tue", "wed"] })]) {
    await startExperiment(input, memoryExperimentStore(), { now: NOW0, seed: 1 });
  }
});

test("start_experiment: six of each arm is the least a design may give; five is refused", async () => {
  assert.equal(MIN_NIGHTS_PER_ARM, 6);
  // 28 days from Friday 2026-10-02 hold exactly 12 Mon+Tue+Wed days
  const ok = await startExperiment(design({ eligible: ["mon", "tue", "wed"] }), memoryExperimentStore(), { now: NOW0, seed: 1 });
  assert.deepEqual(ok.saved.progress.planned, { intervention: 6, control: 6 });
  await assert.rejects(startExperiment(design({ days: 25, eligible: ["mon", "tue", "wed"] }), memoryExperimentStore(), { now: NOW0, seed: 1 }), /only 5 intervention and 5 control days/);
});

test("start_experiment: one active experiment per outcome metric: upcoming and running block, finished and stopped do not", async () => {
  const store = memoryExperimentStore();
  await startExperiment(design(), store, { now: NOW0, seed: 1 }); // upcoming: 2026-10-02..2026-10-29, sleepScore
  await assert.rejects(startExperiment(design({ name: "other" }), store, { now: NOW0, seed: 2 }), /e1 .* is still upcoming on sleepScore: only one active experiment per outcome metric/);
  await startExperiment(design({ metric: "hrv" }), store, { now: NOW0, seed: 3 }); // another metric is fine
  await assert.rejects(startExperiment(design({ name: "other" }), store, { now: at("2026-10-15"), seed: 2 }), /still running/);
  await assert.rejects(startExperiment(design({ name: "other", startDate: "2026-10-30" }), store, { now: at("2026-10-29"), seed: 2 }), /still running/, "the last day itself is still running");
  await startExperiment(design({ name: "later", startDate: "2026-10-31" }), store, { now: at("2026-10-30"), seed: 2 }); // finished the day before
  assert.equal((await store.load())!.experiments.length, 3);

  const stopped = memoryExperimentStore();
  await startExperiment(design(), stopped, { now: NOW0, seed: 1 });
  await stopExperiment({ id: "e1", reason: "changed my mind" }, stopped, { now: NOW0 });
  await startExperiment(design({ name: "again" }), stopped, { now: NOW0, seed: 2 });
  assert.deepEqual((await stopped.load())!.experiments.map((e) => e.id), ["e1", "e2"]);
});

// ---------- reading and logging ----------

async function started(over: Record<string, unknown> = {}, seed = 11) {
  const store = memoryExperimentStore();
  const { experiment } = await startExperiment(design(over), store, { now: NOW0, seed });
  return { store, e: experiment };
}
const dayOf = (e: Experiment, arm: string, nth = 0) => e.schedule.filter((s) => s.arm === arm)[nth].date;

test("get_experiment: today's assignment says what to do on an intervention, control, washout and unassigned day", async () => {
  const { store, e } = await started({ washout: 1, eligible: ["mon", "tue", "wed", "thu", "fri", "sat"] }, 21);
  for (const arm of ["intervention", "control", "washout", "none"] as const) {
    const day = dayOf(e, arm);
    const r = await getExperiment(store, {}, at(day));
    const t = r.experiments[0].today;
    assert.deepEqual([t.date, t.arm], [day, arm]);
    assert.match(t.instruction!, arm === "intervention" ? /No caffeine after 12:00/ : arm === "control" ? /Usual caffeine/ : arm === "washout" ? /Washout day/ : /Nothing is assigned/);
  }
  const before = (await getExperiment(store, {}, NOW0)).experiments[0].today;
  assert.deepEqual([before.arm, before.instruction, before.note], [null, null, "The experiment has not started."]);
  const after = (await getExperiment(store, {}, at("2026-11-02"))).experiments[0].today;
  assert.deepEqual([after.arm, after.note], [null, "The experiment's days are over."]);
});

test("get_experiment: status and progress at the edges of the experiment", async () => {
  const { store } = await started({}, 3); // 2026-10-02 .. 2026-10-29
  const at_ = async (d: string) => (await getExperiment(store, {}, at(d))).experiments[0];
  assert.deepEqual([(await at_("2026-10-01")).status, (await at_("2026-10-01")).progress.daysElapsed], ["upcoming", 0]);
  assert.deepEqual([(await at_("2026-10-02")).status, (await at_("2026-10-02")).progress.daysElapsed], ["running", 1]);
  assert.deepEqual([(await at_("2026-10-29")).status, (await at_("2026-10-29")).progress.daysElapsed], ["running", 28]);
  assert.deepEqual([(await at_("2026-10-30")).status, (await at_("2026-10-30")).progress.daysElapsed], ["finished", 28]);
});

test("get_experiment: adherence counts the trial days so far, per arm: followed, not followed, not logged", async () => {
  const { store, e } = await started({}, 5);
  const trial = e.schedule.filter((s) => s.block !== undefined);
  const [d1, d2, d3] = trial;
  const now = at(trial[5].date, 22); // the first 6 trial days have passed
  await logExperimentDay({ date: d1.date, followed: true }, store, { now });
  await logExperimentDay({ date: d2.date, followed: false, note: "forgot" }, store, { now });
  await logExperimentDay({ date: d3.date, followed: true }, store, { now });
  const a = (await getExperiment(store, {}, now)).experiments[0].adherence;
  assert.deepEqual([a.elapsed, a.logged, a.followed, a.notFollowed, a.notLogged], [6, 3, 2, 1, 3]);
  const count = (arm: string, f: (s: ScheduleDay) => boolean) => trial.slice(0, 6).filter((s) => s.arm === arm && f(s)).length;
  assert.equal(a.byArm.intervention.elapsed, count("intervention", () => true));
  assert.equal(a.byArm.control.elapsed + a.byArm.intervention.elapsed, 6);
  assert.equal(a.byArm.control.followed + a.byArm.intervention.followed, 2);
  const one = await getExperiment(store, { id: "e1" }, now);
  assert.equal(one.selected!.log.find((l) => l.date === d2.date)!.note, "forgot");
  assert.equal(one.selected!.log.length, 3, "the log is a list of days (a date is never a key)");
  await assert.rejects(getExperiment(store, { id: "e9" }, now), /no experiment e9/);
  assert.deepEqual((await getExperiment(memoryExperimentStore(), {}, now)).experiments, []);
  await assert.rejects(getExperiment(memoryExperimentStore(), { id: "e1" }, now), /no experiment e1/);
});

test("log_experiment_day: logs what happened on a trial day; the default day is today and the default experiment the one running", async () => {
  const { store, e } = await started({}, 7);
  const d = dayOf(e, "intervention");
  const r = await logExperimentDay({ followed: false, note: "coffee at 3" }, store, { now: at(d, 21) });
  assert.deepEqual([r.id, r.date, r.arm, r.changed, r.saved.followed, r.saved.note], ["e1", d, "intervention", true, false, "coffee at 3"]);
  assert.equal((await store.load())!.experiments[0].log[d].loggedAt, at(d, 21).toISOString());
});

test("log_experiment_day: refuses future days, days outside the experiment, washout and unassigned days, unknown fields and a stopped experiment", async () => {
  const { store, e } = await started({ washout: 1 }, 8);
  const inter = dayOf(e, "intervention");
  const wash = dayOf(e, "washout");
  const now = at("2026-10-20");
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ followed: true, date: "2026-10-21" }, /in the future/],
    [{ followed: true, date: "2026-10-01" }, /outside e1's days/],
    [{ followed: true, date: "2026-10-30" }, /in the future|outside/],
    [{ followed: true, date: wash }, /nothing was assigned on .* \(washout\)/],
    [{ date: inter }, /followed is required/],
    [{ followed: "yes", date: inter }, /followed is required and must be true or false/],
    [{ followed: true, date: "2026-13-01" }, /date must be a calendar date/],
    [{ followed: true, extra: 1 }, /extra is not a known field/],
    [{ followed: true, id: "e5" }, /no experiment e5/],
    [{ followed: true, note: "x".repeat(501) }, /note must be at most 500/],
  ];
  for (const [input, re] of bad) await assert.rejects(logExperimentDay(input, store, { now }), re, JSON.stringify(input));
  await stopExperiment({ id: "e1", reason: "x" }, store, { now });
  await assert.rejects(logExperimentDay({ followed: true, date: inter, id: "e1" }, store, { now }), /was stopped on 2026-10-20/);
  await assert.rejects(logExperimentDay({ followed: true }, memoryExperimentStore(), { now }), /no experiment yet/);
});

test("log_experiment_day: with no experiment running, or two, the id is needed", async () => {
  const store = memoryExperimentStore();
  await startExperiment(design(), store, { now: NOW0, seed: 1 });
  await startExperiment(design({ metric: "hrv" }), store, { now: NOW0, seed: 2 });
  await assert.rejects(logExperimentDay({ followed: true }, store, { now: NOW0 }), /no experiment is running today: pass id/);
  await assert.rejects(logExperimentDay({ followed: true }, store, { now: at("2026-10-05") }), /2 experiments are running: pass id/);
});

test("log_experiment_day: logging a day again keeps the earlier answer under `earlier`; the same answer twice changes nothing", async () => {
  const { store, e } = await started({}, 12);
  const d = dayOf(e, "control");
  const now = at(d, 21);
  await logExperimentDay({ date: d, followed: true }, store, { now });
  const same = await logExperimentDay({ date: d, followed: true }, store, { now: at(d, 22) });
  assert.equal(same.changed, false);
  assert.equal((await store.load())!.experiments[0].log[d].earlier, undefined);
  const corrected = await logExperimentDay({ date: d, followed: false, note: "was ill" }, store, { now: at(d, 23) });
  assert.equal(corrected.changed, true);
  const entry = (await store.load())!.experiments[0].log[d];
  assert.deepEqual([entry.followed, entry.note, entry.earlier!.length, entry.earlier![0].followed, entry.earlier![0].loggedAt], [false, "was ill", 1, true, now.toISOString()]);
  await logExperimentDay({ date: d, followed: true }, store, { now: at(d, 23) });
  assert.equal((await store.load())!.experiments[0].log[d].earlier!.length, 2, "every earlier answer is kept");
});

test("stop_experiment: needs a reason and never deletes anything; stopping twice changes nothing; a finished one cannot be stopped", async () => {
  const { store, e } = await started({}, 13);
  const d = dayOf(e, "intervention");
  await logExperimentDay({ date: d, followed: true }, store, { now: at(d, 20) });
  const before = (await store.load())!.experiments[0];
  await assert.rejects(stopExperiment({ id: "e1" }, store, { now: at(d, 21) }), /reason is required/);
  await assert.rejects(stopExperiment({ reason: "x" }, store, { now: at(d, 21) }), /id is required/);
  await assert.rejects(stopExperiment({ id: "e1", reason: " " }, store, { now: at(d, 21) }), /reason must not be empty/);
  await assert.rejects(stopExperiment({ id: "e2", reason: "x" }, store, { now: at(d, 21) }), /no experiment e2/);
  const r = await stopExperiment({ id: "e1", reason: "moving house" }, store, { now: at(d, 21) });
  assert.deepEqual([r.stopped.reason, r.stopped.date, r.alreadyStopped], ["moving house", d, false]);
  const after = (await store.load())!.experiments[0];
  assert.deepEqual({ ...after, stopped: undefined }, { ...before, stopped: undefined }, "everything but `stopped` is exactly as it was");
  const again = await stopExperiment({ id: "e1", reason: "other" }, store, { now: at(d, 22) });
  assert.deepEqual([again.alreadyStopped, again.stopped.reason], [true, "moving house"]);
  assert.equal((await getExperiment(store, {}, at(d, 22))).experiments[0].status, "stopped");
  const fin = await started({}, 14);
  await assert.rejects(stopExperiment({ id: "e1", reason: "late" }, fin.store, { now: at("2026-10-30") }), /already finished/);
  await stopExperiment({ id: "e1", reason: "on the last day" }, fin.store, { now: at("2026-10-29") });
});

// ---------- the permutation test ----------

const pair = (i: number | null, c: number | null, order: "ic" | "ci" = "ic"): Block => ({ days: order === "ic" ? [{ arm: "intervention", value: i }, { arm: "control", value: c }] : [{ arm: "control", value: c }, { arm: "intervention", value: i }] });

test("permutation test: three pairs that all go the same way give p = 2/8 by hand (the observed split and its mirror image)", () => {
  const r = permutationTest([pair(10, 1), pair(11, 2), pair(12, 3)]);
  assert.deepEqual([r.p, r.method, r.permutations, r.blocks], [0.25, "exact", 8, 3]);
});

test("permutation test: six pairs all the same way give 2/64, five give 2/32: why six nights per arm is the minimum", () => {
  const same = (n: number) => Array.from({ length: n }, (_, i) => pair(20 + i, 1 + i));
  assert.equal(permutationTest(same(6)).p, 2 / 64);
  assert.equal(permutationTest(same(5)).p, 2 / 32);
  assert.ok(2 / 64 < 0.05 && 2 / 32 > 0.05);
});

test("permutation test: the order inside a pair does not matter; mixed directions give a larger p; no difference gives p = 1", () => {
  const a = permutationTest([pair(10, 1), pair(11, 2, "ci"), pair(12, 3), pair(13, 4, "ci")]);
  const b = permutationTest([pair(10, 1, "ci"), pair(11, 2), pair(12, 3, "ci"), pair(13, 4)]);
  assert.equal(a.p, b.p);
  assert.equal(a.p, 2 / 16);
  const mixed = permutationTest([pair(10, 1), pair(1, 10), pair(12, 3), pair(5, 5), pair(9, 2), pair(2, 8)]);
  assert.ok(mixed.p! > 0.3, `${mixed.p}`);
  assert.equal(permutationTest([pair(5, 5), pair(5, 5), pair(5, 5)]).p, 1);
});

test("permutation test: pairs with no value are left out; a pair with one value still counts; no data at all gives no p", () => {
  const r = permutationTest([pair(10, 1), pair(null, null), pair(11, 2), pair(12, 3)]);
  assert.deepEqual([r.blocks, r.p], [3, 0.25]);
  const half = permutationTest([pair(10, null), pair(11, 2), pair(12, 3), pair(null, 1), pair(13, 4)]);
  assert.equal(half.blocks, 5);
  assert.ok(half.p! > 0 && half.p! <= 1);
  assert.deepEqual(permutationTest([pair(null, null)]), { p: null, method: "none", permutations: 0, blocks: 0 });
  assert.equal(permutationTest([pair(10, null), pair(11, null)]).p, null, "no control value at all: no statistic");
});

test("permutation test: exact up to 15 informative pairs, 20000 seeded draws from 16; the same data always gives the same p", () => {
  assert.equal(EXACT_MAX_BLOCKS, 15);
  const data = (n: number) => Array.from({ length: n }, (_, i) => pair(20 + i, 1 + i));
  const k15 = permutationTest(data(15));
  assert.deepEqual([k15.method, k15.permutations, k15.p], ["exact", 32768, 2 / 32768]);
  const k16 = permutationTest(data(16));
  assert.deepEqual([k16.method, k16.permutations], ["monte-carlo", PERMUTATION_DRAWS]);
  assert.deepEqual(permutationTest(data(16)), k16, "fixed seed: the same answer every time");
  // 2 of the 65536 flips are as extreme (about 0.6 of 20000 draws): the p-value cannot go below 1 / 20001
  assert.ok(k16.p! >= 1 / (PERMUTATION_DRAWS + 1) && k16.p! < 0.0003, `${k16.p}`);
  // a case in the middle: the seeded draws agree with a brute-force enumeration of all 2^16 flips
  const mixed: Block[] = Array.from({ length: 16 }, (_, i) => pair(9 + ((i * 7) % 11), 8 + ((i * 5) % 9) + (i % 4 === 0 ? 3 : 0), i % 2 ? "ic" : "ci"));
  const mc = permutationTest(mixed);
  assert.equal(mc.method, "monte-carlo");
  const med = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const stat = (mask: number) => {
    const i: number[] = [];
    const c: number[] = [];
    mixed.forEach((b, j) => b.days.forEach((d) => (((d.arm === "intervention") !== (((mask >> j) & 1) === 1)) ? i : c).push(d.value!)));
    return med(i) - med(c);
  };
  const obs = stat(0);
  let extreme = 0;
  for (let mask = 0; mask < 65536; mask++) if (Math.abs(stat(mask)) >= Math.abs(obs) - 1e-9) extreme++;
  assert.ok(Math.abs(mc.p! - extreme / 65536) < 0.012, `monte carlo ${mc.p} vs exact ${extreme / 65536}`);
  assert.ok(extreme / 65536 > 0.01 && extreme / 65536 < 0.99, "the case is not trivial");
  assert.deepEqual(permutationTest(mixed), mc);
  assert.equal(mc.p, 8898 / (PERMUTATION_DRAWS + 1), "pinned: 8897 of the 20000 seeded draws (seed 20261115) were as extreme, plus one");
});

test("permutation test: with no real effect it is wrong about 5% of the time at most (seeded simulation, 8 pairs)", () => {
  const rng = mulberry32(2026);
  let rejected = 0;
  const trials = 600;
  for (let t = 0; t < trials; t++) {
    const blocks = Array.from({ length: 8 }, () => {
      const base = rng() * 10;
      return pair(base + rng() * 3, base + rng() * 3, rng() < 0.5 ? "ic" : "ci");
    });
    if (permutationTest(blocks).p! <= 0.05) rejected++;
  }
  assert.ok(rejected / trials <= 0.07, `${rejected} of ${trials} rejected`);
  // and with a real, large effect it usually finds it
  let found = 0;
  for (let t = 0; t < 100; t++) {
    const blocks = Array.from({ length: 8 }, () => {
      const base = rng() * 10;
      return pair(base + 6 + rng() * 3, base + rng() * 3);
    });
    if (permutationTest(blocks).p! <= 0.05) found++;
  }
  assert.ok(found >= 95, `${found} of 100 found`);
});

test("pre-registration: the plan calls the test exact only without a washout, and an approximation (checked by simulation) with one", async () => {
  const plain = (await startExperiment(design(), memoryExperimentStore(), { now: NOW0, seed: 1 })).experiment.analysisPlan.join("\n");
  const washed = (await startExperiment(design({ washout: 1 }), memoryExperimentStore(), { now: NOW0, seed: 1 })).experiment.analysisPlan.join("\n");
  assert.match(plain, /the p-value is exact when the intervention does nothing/);
  assert.doesNotMatch(plain, /approximation/);
  assert.match(washed, /approximation, checked by simulation in the project's tests, not exact/);
  assert.doesNotMatch(washed, /p-value is exact/);
  assert.doesNotMatch(plain + washed, /exactly what was randomized/);
});

test("permutation test with a washout: still close to its nominal 5% with no effect and carry-over between nights (seeded simulation)", () => {
  const rng = mulberry32(77);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  for (const washout of [0, 1, 2]) {
    let rejected = 0;
    const trials = 400;
    for (let t = 0; t < trials; t++) {
      const schedule = generateSchedule({ startDate: "2026-10-02", days: 40, washout }, 1000 + t);
      // nights that follow one another: AR(1) with 0.3, and no effect of the arm
      let prev = 0;
      const value = schedule.map(() => (prev = 0.3 * prev + gauss()));
      const byBlock = new Map<number, Block["days"]>();
      schedule.forEach((d, i) => {
        if (d.block !== undefined) byBlock.set(d.block, [...(byBlock.get(d.block) ?? []), { arm: d.arm as "intervention" | "control", value: value[i] }]);
      });
      if (permutationTest([...byBlock.values()].map((days) => ({ days }))).p! <= 0.05) rejected++;
    }
    assert.ok(rejected / trials <= 0.08, `washout ${washout}: ${rejected} of ${trials} rejected`);
  }
});

// ---------- analysis ----------

// A fake Suunto: the night filed under day D (the one after day D) has score valueOf(D), or no sleep when null.
function fakeSleep(valueOf: (d: string) => number | null, balanceOf: (d: string) => number | null = () => 0.5) {
  const calls: string[] = [];
  const dayList = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  return {
    calls,
    client: {
      async listSleep(from: string, to: string) {
        calls.push(`sleep ${from}..${to}`);
        return { payload: dayList(from, to).flatMap((d) => (valueOf(d) === null ? [] : [{ timestamp: `${d}T23:00:00.000+00:00`, entryData: { SleepId: Date.parse(d) / 1000, BedtimeStart: `${d}T23:00:00.000+00:00`, BedtimeEnd: `${addDays(d, 1)}T06:30:00.000+00:00`, Duration: 27000, IsNap: false, SleepQualityScore: valueOf(d), AvgHRV: valueOf(d) } }])) };
      },
      async listRecovery(from: string, to: string) {
        calls.push(`recovery ${from}..${to}`);
        return { payload: dayList(from, to).flatMap((d) => (balanceOf(addDays(d, -1)) === null ? [] : [{ timestamp: `${d}T06:30:00.000+00:00`, entryData: { Balance: balanceOf(addDays(d, -1)), StressState: 1 } }])) };
      },
    } as any,
  };
}
const armOn = (e: Experiment, d: string) => e.schedule.find((s) => s.date === d)!.arm;
// jitter: a deterministic little noise per day so medians are not all ties
const jitter = (d: string) => (((Date.parse(d) / 86_400_000) * 7919) % 101) / 25; // 0..4 in steps of 0.04, no two days of an experiment alike

async function finished(over: Record<string, unknown> = {}, seed = 31) {
  const { store, e } = await started(over, seed);
  return { store, e, today: at(addDays(e.endDate, 2)) };
}

test("analyze_experiment: refused before the night after the last day is recorded (end + 2), unless early is passed", async () => {
  const { store, e } = await finished();
  const s = fakeSleep(() => 60);
  const endPlus1 = at(addDays(e.endDate, 1));
  await assert.rejects(analyzeExperiment(s.client, store, {}, { now: endPlus1 }), /ends on 2026-10-29: .* not recorded before 2026-10-31\. Analyze then, or pass early: true/);
  await assert.rejects(analyzeExperiment(s.client, store, { early: false }, { now: at("2026-10-15") }), /ends on/);
  assert.equal(s.calls.length, 0, "refused before anything is read");
  const ok = await analyzeExperiment(s.client, store, {}, { now: at(addDays(e.endDate, 2)) });
  assert.deepEqual([ok.exploratory, ok.window.through], [false, e.endDate]);
  await assert.rejects(analyzeExperiment(s.client, store, { early: true }, { now: at("2026-10-02") }), /no night to analyse yet|ends on/);
  await assert.rejects(analyzeExperiment(s.client, store, { early: true }, { now: at("2026-10-03") }), /no night to analyse yet/);
});

test("analyze_experiment: an early look is flagged exploratory and reads only the nights that are recorded", async () => {
  const { store, e } = await finished();
  const s = fakeSleep((d) => 60 + (armOn(e, addDays(d, 0)) === "intervention" ? 10 : 0));
  const r = await analyzeExperiment(s.client, store, { early: true }, { now: at("2026-10-20") });
  assert.deepEqual([r.exploratory, r.window.through, r.window.plannedEnd], [true, "2026-10-18", e.endDate]);
  assert.match(r.statement, /^Exploratory \(an early look before the planned end 2026-10-29/);
  assert.deepEqual(s.calls, ["sleep 2026-10-02..2026-10-18"]);
  const trial = e.schedule.filter((x) => x.block !== undefined && x.date <= "2026-10-18");
  assert.equal(r.intentionToTreat.nIntervention + r.intentionToTreat.nControl, trial.length);
});

test("analyze_experiment: a real difference is found; the numbers are the medians of the nights after each arm's days", async () => {
  const { store, e, today } = await finished({ days: 30 }, 77);
  const value = (d: string) => (armOn(e, d) === "intervention" ? 80 : 60) + jitter(d);
  const s = fakeSleep(value);
  for (const x of e.schedule.filter((y) => y.block !== undefined)) await logExperimentDay({ date: x.date, followed: true }, store, { now: at(x.date, 21) });
  const r = await analyzeExperiment(s.client, store, {}, { now: today });
  const itt = r.intentionToTreat;
  const med = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const vals = (arm: string) => e.schedule.filter((x) => x.arm === arm).map((x) => value(x.date));
  assert.equal(itt.interventionMedian, Math.round(med(vals("intervention")) * 10) / 10);
  assert.equal(itt.controlMedian, Math.round(med(vals("control")) * 10) / 10);
  assert.equal(itt.medianDiff, Math.round((med(vals("intervention")) - med(vals("control"))) * 10) / 10);
  assert.deepEqual([itt.nIntervention, itt.nControl, itt.verdict], [15, 15, "intervention-higher"]);
  assert.ok(itt.pValue! < 0.01, `p ${itt.pValue}`); // a few flips of pairs that straddle the medians leave them unchanged, so p is a little above the smallest 2/2^15
  assert.deepEqual(itt.missingNights, { intervention: 0, control: 0 });
  assert.equal(r.verdict, "intervention-higher");
  assert.deepEqual(r.perProtocol.nIntervention, 15);
  assert.equal(r.perProtocol.verdict, "intervention-higher");
  assert.match(r.statement, /Median sleep score after intervention days was .* higher than after control days \(p = .*15 vs 15 nights, intention to treat\)/);
  // the noise threshold is the one get_tag_effects uses (rounded as the metric is)
  const control = vals("control");
  assert.equal(itt.noiseThreshold, Math.round(thresholdOf(control, 15)! * 10) / 10);
  assert.ok(itt.effectInStandardErrors! > 3);
  assert.ok(r.randomized.length > 20 && r.notControlled.length >= 4);
  assert.match(r.pValueBasis, /^valid when the intervention does nothing/);
  const washed = await finished({ days: 30, washout: 1 }, 77);
  const rw = await analyzeExperiment(fakeSleep((d) => 60 + jitter(d)).client, washed.store, {}, { now: washed.today });
  assert.match(rw.pValueBasis, /^approximation: with a washout/);
  assert.ok(rw.notes.some((n) => /approximation/.test(n)));
  assert.match(rw.thresholds.test, /all swaps enumerated up to 15/);
  assert.deepEqual(r.adherence, { trialDays: 30, logged: 30, followed: 30, notFollowed: 0, notLogged: 0 });
});

test("analyze_experiment: no effect gives 'no-clear-difference', and says it does not show there is none", async () => {
  const { store, e, today } = await finished({ days: 30 }, 78);
  const r = await analyzeExperiment(fakeSleep((d) => 60 + jitter(d) * (armOn(e, d) === "intervention" ? 1 : 1)).client, store, {}, { now: today });
  assert.equal(r.verdict, "no-clear-difference");
  assert.match(r.statement, /No clear difference in sleep score/);
  assert.match(r.statement, /does not show there is no effect/);
});

test("verdict: needs six nights per arm, p <= 0.05 AND a difference larger than the noise threshold; each limit on both sides", () => {
  const v = verdictOf;
  assert.equal(v(6, 6, 5, 3, 0.05), "intervention-higher");
  assert.equal(v(6, 6, -5, 3, 0.05), "intervention-lower");
  assert.equal(v(5, 6, 5, 3, 0.01), "insufficient");
  assert.equal(v(6, 5, 5, 3, 0.01), "insufficient");
  assert.equal(v(6, 6, 5, 3, 0.0501), "no-clear-difference", "p just above 0.05");
  assert.equal(v(6, 6, 3, 3, 0.01), "no-clear-difference", "a difference equal to the threshold is not larger");
  assert.equal(v(6, 6, -3, 3, 0.01), "no-clear-difference");
  assert.equal(v(6, 6, 3.1, 3, 0.01), "intervention-higher");
  assert.equal(v(6, 6, 0, 0, 0.01), "no-clear-difference", "no difference at all");
  assert.equal(v(6, 6, null, 3, 0.01), "insufficient");
  assert.equal(v(6, 6, 5, null, 0.01), "insufficient");
  assert.equal(v(6, 6, 5, 3, null), "insufficient");
});

test("analyze_experiment: a lower outcome after the intervention is reported as lower", async () => {
  const { store, e, today } = await finished({ days: 30 }, 80);
  const r = await analyzeExperiment(fakeSleep((d) => (armOn(e, d) === "intervention" ? 50 : 70) + jitter(d)).client, store, {}, { now: today });
  assert.equal(r.verdict, "intervention-lower");
  assert.match(r.statement, /lower than after control days/);
});

test("analyze_experiment: per protocol counts only the days logged as followed; intention to treat counts every assigned day", async () => {
  const { store, e, today } = await finished({ days: 30 }, 81);
  const trial = e.schedule.filter((x) => x.block !== undefined);
  for (const [i, x] of trial.entries()) {
    if (i % 3 === 1) continue; // not logged
    await logExperimentDay({ date: x.date, followed: i % 3 === 0 }, store, { now: at(x.date, 21) });
  }
  const r = await analyzeExperiment(fakeSleep((d) => (armOn(e, d) === "intervention" ? 80 : 60) + jitter(d)).client, store, {}, { now: today });
  const followed = trial.filter((_, i) => i % 3 === 0);
  assert.deepEqual([r.intentionToTreat.nIntervention + r.intentionToTreat.nControl, r.perProtocol.nIntervention + r.perProtocol.nControl], [30, followed.length]);
  assert.deepEqual(r.adherence, { trialDays: 30, logged: 20, followed: followed.length, notFollowed: 10, notLogged: 10 });
  assert.match(r.perProtocol.note, /not protected by the randomization/);
  assert.equal(r.perProtocol.nIntervention, followed.filter((x) => x.arm === "intervention").length);
});

test("analyze_experiment: insufficient below six nights with a value in an arm, a verdict at six; missing nights are counted per arm", async () => {
  const { store, e, today } = await finished({ days: 14 }, 82); // 7 + 7 trial days
  const interventionDays = e.schedule.filter((x) => x.arm === "intervention").map((x) => x.date);
  const controlDays = e.schedule.filter((x) => x.arm === "control").map((x) => x.date);
  const strong = (d: string) => (armOn(e, d) === "intervention" ? 80 : 60) + jitter(d);
  // 5 intervention nights recorded: 2 missing
  const five = await analyzeExperiment(fakeSleep((d) => (interventionDays.slice(5).includes(d) ? null : strong(d))).client, store, {}, { now: today });
  assert.deepEqual([five.intentionToTreat.nIntervention, five.intentionToTreat.nControl, five.intentionToTreat.missingNights, five.verdict], [5, 7, { intervention: 2, control: 0 }, "insufficient"]);
  assert.match(five.statement, /Not enough nights for a verdict: 5 intervention and 7 control .* at least 6 of each are needed\. Nothing is claimed\./);
  // 6 intervention nights: no longer insufficient (whether it finds the effect is another matter: with one pair half missing the
  // smallest possible p-value is close to the limit)
  const six = await analyzeExperiment(fakeSleep((d) => (interventionDays.slice(6).includes(d) ? null : strong(d))).client, store, {}, { now: today });
  assert.deepEqual([six.intentionToTreat.nIntervention, six.intentionToTreat.missingNights.intervention], [6, 1]);
  assert.notEqual(six.verdict, "insufficient");
  // 5 control nights
  const fiveC = await analyzeExperiment(fakeSleep((d) => (controlDays.slice(5).includes(d) ? null : strong(d))).client, store, {}, { now: today });
  assert.deepEqual([fiveC.intentionToTreat.nControl, fiveC.intentionToTreat.missingNights.control, fiveC.verdict], [5, 2, "insufficient"]);
  assert.equal(fiveC.intentionToTreat.pValue !== null, true, "the numbers are still shown");
});

test("analyze_experiment: the morning-recovery metric reads the Balance on waking the day after", async () => {
  const { store, e, today } = await finished({ days: 30, metric: "recoveryMorning" }, 83);
  const bal = (d: string) => (armOn(e, d) === "intervention" ? 0.8 : 0.5) + (jitter(d) / 100);
  const s = fakeSleep(() => 60, bal);
  const r = await analyzeExperiment(s.client, store, {}, { now: today });
  assert.deepEqual(s.calls, [`sleep ${e.startDate}..${e.endDate}`, `recovery ${addDays(e.startDate, 1)}..${addDays(e.endDate, 1)}`]);
  assert.equal(r.verdict, "intervention-higher");
  assert.ok(r.intentionToTreat.interventionMedian! > 0.75 && r.intentionToTreat.controlMedian! < 0.56);
});

test("analyze_experiment: a stopped experiment is analysed up to the day it was stopped and flagged exploratory", async () => {
  const { store, e } = await started({ days: 30 }, 84);
  await stopExperiment({ id: "e1", reason: "knee surgery" }, store, { now: at("2026-10-20") });
  const s = fakeSleep((d) => (armOn(e, d) === "intervention" ? 80 : 60) + jitter(d));
  const r = await analyzeExperiment(s.client, store, {}, { now: at("2026-11-05") });
  assert.deepEqual([r.exploratory, r.window.through, r.status], [true, "2026-10-20", "stopped"]);
  assert.match(r.exploratoryReason!, /stopped on 2026-10-20 \(knee surgery\)/);
  assert.deepEqual(s.calls, ["sleep 2026-10-02..2026-10-20"]);
});

test("analyze_experiment: a failed request stops the analysis; an unknown id or no experiment is an error", async () => {
  const { store, today } = await finished();
  await assert.rejects(analyzeExperiment({ async listSleep() { throw new Error("Suunto answered 500"); }, async listRecovery() { return []; } } as any, store, {}, { now: today }), /Suunto answered 500/);
  await assert.rejects(analyzeExperiment(fakeSleep(() => 1).client, store, { id: "e4" }, { now: today }), /no experiment e4/);
  await assert.rejects(analyzeExperiment(fakeSleep(() => 1).client, memoryExperimentStore(), {}, { now: today }), /no experiment yet/);
});

// ---------- the file ----------

async function withDir<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-exp-"));
  try {
    return await fn(join(dir, "sub", "experiments.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the file: version 1, owner-only, the seed and schedule stored, read back identically", async () => {
  await withDir(async (path) => {
    const store = fileExperimentStore(path);
    const { experiment } = await startExperiment(design(), store, { now: NOW0, seed: 99 });
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual([raw.version, raw.experiments[0].seed, raw.experiments[0].schedule.length], [1, 99, 28]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await store.load())!.experiments[0], experiment);
    assert.deepEqual(await readdir(join(path, "..")), ["experiments.json"]);
    // another process's experiment is kept when this one writes
    await startExperiment(design({ metric: "hrv" }), fileExperimentStore(path), { now: NOW0, seed: 2 });
    await startExperiment(design({ metric: "sleepDurationS" }), store, { now: NOW0, seed: 3 });
    assert.deepEqual((await store.load())!.experiments.map((e) => e.id), ["e1", "e2", "e3"]);
  });
});

test("the file: damaged, foreign, newer-version or inconsistent files are refused by every tool, with the file named, and left untouched", async () => {
  await withDir(async (path, dir) => {
    const store = fileExperimentStore(path);
    await startExperiment(design(), store, { now: NOW0, seed: 5 });
    const good = JSON.parse(await readFile(path, "utf8"));
    const ex = good.experiments[0];
    const swap = (patch: (e: any) => void) => {
      const copy = structuredClone(good);
      patch(copy.experiments[0]);
      return copy;
    };
    const cases: [unknown, RegExp][] = [
      ["{nope", /is not valid JSON/],
      [{ version: 1, predictions: [] }, /is invalid \(predictions is not a known field/],
      [{ experiments: [] }, /version unknown/],
      [{ ...good, version: 2 }, /experiments version 2, but this server reads and writes version 1 only; it is left untouched/],
      [swap((e) => (e.metric = "steps")), /experiments\[0\]\.metric must be one of/],
      [swap((e) => (e.days = 5)), /experiments\[0\]\.days must be between 14 and 60/],
      [swap((e) => (e.endDate = "2026-12-31")), /endDate must be 27 days after startDate/],
      [swap((e) => e.schedule.pop()), /schedule must hold one entry per day \(28\)/],
      [swap((e) => (e.schedule[0].date = "2026-10-03")), /schedule\[0\]\.date must be 2026-10-02/],
      [swap((e) => (e.schedule[0].arm = "both")), /schedule\[0\]\.arm must be one of/],
      [swap((e) => { const i = e.schedule.findIndex((s: any) => s.block === 1 && s.arm === "control"); const j = e.schedule.findIndex((s: any) => s.block === 1 && s.arm === "intervention"); e.schedule[i].arm = e.schedule[j].arm; }), /block 1 must hold one intervention and one control day/],
      [swap((e) => delete e.schedule.find((s: any) => s.block !== undefined).block), /block is for trial days/],
      [swap((e) => (e.log["2026-09-01"] = { followed: true, loggedAt: "x" })), /log\[2026-09-01\] is not a trial day/],
      [swap((e) => (e.extra = 1)), /experiments\[0\]\.extra is not a known field/],
      [{ ...good, experiments: [ex, ex] }, /id e1 is listed more than once/],
    ];
    for (const [content, re] of cases) {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      await writeFile(path, text);
      const reading = [
        () => startExperiment(design({ metric: "hrv" }), store, { now: NOW0, seed: 1 }),
        () => getExperiment(store, {}, NOW0),
        () => logExperimentDay({ followed: true }, store, { now: at("2026-10-05") }),
        () => stopExperiment({ id: "e1", reason: "x" }, store, { now: NOW0 }),
        () => analyzeExperiment(fakeSleep(() => 1).client, store, { early: true }, { now: at("2026-10-20") }),
      ];
      for (const r of reading) await assert.rejects(r(), (e: Error) => re.test(e.message) && e.message.includes(path), text.slice(0, 80));
      assert.equal(await readFile(path, "utf8"), text, "the file is exactly as it was");
    }
    assert.deepEqual(await readdir(join(dir, "sub")), ["experiments.json"]);
  });
});
