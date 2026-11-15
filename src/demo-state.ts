// Demo mode's starting state for the prediction ledger and the experiments: a month of past predictions waiting to be
// scored (score_predictions then scores them against the synthetic data) and one finished experiment with its log, so
// every tool has something to show. Everything is a pure function of the day (the same data as demo.ts: it depends on
// "today" only), written through the real functions into the in-memory stores: nothing reaches the disk.
import { localDate } from "./api.js";
import { logExperimentDay, startExperiment, type ExperimentStore } from "./experiments.js";
import { logPrediction, type PredictionStore } from "./predictions.js";
import { mulberry32 } from "./prng.js";
import { addDays } from "./training-load.js";

const noon = (date: string) => new Date(`${date}T12:00:00`); // machine-local, like the demo watch

export const DEMO_EXPERIMENT_SEED = 2026;

export async function seedDemoState(predictions: PredictionStore, experiments: ExperimentStore, now = new Date()): Promise<void> {
  const today = localDate(0, now);
  const rng = mulberry32(2026);
  const pct = (lo: number, hi: number) => Math.round((lo + rng() * (hi - lo)) * 100) / 100;

  // Thirty predictions about the 30 days from 33 to 4 days ago, each written the evening before; the due ones are scored by score_predictions.
  for (let i = 0; i < 30; i++) {
    const date = addDays(today, -(33 - i));
    const made = noon(addDays(date, -1));
    const kind = (["session_done", "hrv_in_band", "recovery_morning_at_least"] as const)[i % 3];
    await logPrediction(
      kind === "session_done"
        ? { date, kind, probability: pct(0.5, 0.9), rule: "weekly-plan" }
        : kind === "hrv_in_band"
          ? { date, kind, probability: pct(0.3, 0.6), rule: "recovery-gate" }
          : { date, kind, probability: pct(0.4, 0.8), threshold: 0.6, rule: "recovery-gate" },
      predictions,
      { now: made },
    );
  }
  // Two lift predictions about the demo's Monday sessions (Bench Press 4x8, a load of 70 kg or more): the watch cannot say whether
  // the reps were done, so they stay unresolvable until the sets are logged: that is the honest path, shown.
  const monday = (back: number) => {
    let d = addDays(today, -back);
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, -1);
    return d;
  };
  for (const date of [monday(4), monday(11)]) {
    await logPrediction({ date, kind: "reps_hit", probability: 0.7, exercise: "Bench Press", sets: 4, reps: 8, kg: 70, rule: "progression" }, predictions, { now: noon(addDays(date, -1)) });
  }

  // One finished experiment (28 days, ended 8 days ago, 14 days of each arm) with most days logged as followed.
  const created = noon(addDays(today, -36));
  const { experiment } = await startExperiment(
    { name: "No screens after 22:00 (demo)", intervention: "No screens after 22:00", control: "Screens as usual", metric: "sleepScore", days: 28 },
    experiments,
    { now: created, seed: DEMO_EXPERIMENT_SEED },
  );
  const trial = experiment.schedule.filter((s) => s.block !== undefined);
  for (const [i, day] of trial.entries()) {
    if (i % 5 === 4) continue; // a day left unlogged
    await logExperimentDay({ date: day.date, followed: i % 7 !== 6 }, experiments, { now: new Date(`${day.date}T21:00:00`) });
  }
}
