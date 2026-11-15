import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoClient } from "./demo.js";
import { seedDemoState } from "./demo-state.js";
import { analyzeExperiment, getExperiment, memoryExperimentStore } from "./experiments.js";
import { memoryPredictionStore, predictionStats, scorePredictions } from "./predictions.js";
import { buildDraft } from "./draft.js";

const NOW = new Date(2026, 10, 13, 20, 0, 0); // a Friday evening, machine-local

async function seeded() {
  const preds = memoryPredictionStore();
  const exps = memoryExperimentStore();
  await seedDemoState(preds, exps, NOW);
  return { preds, exps };
}

test("demo state: deterministic: the same day gives the same ledger and the same experiment", async () => {
  const a = await seeded();
  const b = await seeded();
  assert.deepEqual(await a.preds.load(), await b.preds.load());
  assert.deepEqual(await a.exps.load(), await b.exps.load());
  const ps = (await a.preds.load())!.predictions;
  assert.equal(ps.length, 32);
  assert.deepEqual([...new Set(ps.map((p) => p.kind))].sort(), ["hrv_in_band", "recovery_morning_at_least", "reps_hit", "session_done"]);
  assert.ok(ps.every((p) => p.due <= "2026-11-13" && !p.outcome), "all due, none scored yet");
  assert.equal((await a.exps.load())!.experiments.length, 1);
});

test("demo state: it is a finished experiment with its days logged, and nothing is written to disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-demo-state-"));
  const before = process.cwd();
  try {
    process.chdir(dir);
    const { exps } = await seeded();
    const e = (await getExperiment(exps, {}, NOW)).experiments[0];
    assert.deepEqual([e.status, e.endDate < "2026-11-13", e.adherence.logged > 15, e.adherence.notFollowed > 0, e.adherence.notLogged > 0], ["finished", true, true, true, true]);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    process.chdir(before);
    await rm(dir, { recursive: true, force: true });
  }
});

test("demo state: score_predictions scores the demo ledger against the synthetic data, and the statistics then have enough to say something", async () => {
  const { preds } = await seeded();
  const client = new DemoClient(NOW);
  let r = await scorePredictions(client, preds, {}, { now: NOW, loadJournal: () => client.demoJournal() });
  assert.deepEqual([r.scored.length, r.remaining, r.errors], [20, 12, []]);
  r = await scorePredictions(client, preds, {}, { now: NOW, loadJournal: () => client.demoJournal() });
  assert.deepEqual([r.scored.length, r.remaining, r.errors], [12, 0, []]);
  const s = predictionStats(await preds.load(), NOW);
  assert.ok(s.overall.n >= 20, `${s.overall.n} scored`);
  assert.equal(s.overall.verdict, "ok");
  assert.ok(s.overall.unresolvable >= 1, "the lift predictions need log_session");
  assert.ok(s.byKind.length === 4 && s.byRule.length === 3);
  const again = await scorePredictions(client, preds, {}, { now: NOW, loadJournal: () => client.demoJournal() });
  assert.equal(again.scored.length, 0, "idempotent");
});

test("demo state: the experiment analyses on the demo's own nights; draft_session_log works on a demo gym session", async () => {
  const { exps } = await seeded();
  const client = new DemoClient(NOW);
  const r = await analyzeExperiment(client, exps, {}, { now: NOW });
  assert.deepEqual([r.exploratory, r.intentionToTreat.nIntervention, r.intentionToTreat.nControl], [false, 14, 14]);
  assert.notEqual(r.verdict, "insufficient");
  assert.ok(r.perProtocol.nIntervention < 14);

  const gym = ((await client.listWorkouts({ limit: 100 })) as any).payload.find((w: any) => w.activityId === 23);
  const d = await buildDraft(client, { workoutKey: gym.workoutKey });
  assert.equal(d.status, "ok");
  assert.ok(d.draft && d.draft.exercises.length >= 3);
});
