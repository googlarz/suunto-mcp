#!/usr/bin/env node
import { extname } from "node:path";
import "./env.js";

// CLI mode: any explicit command arg, OR running interactively in a terminal.
// MCP server mode: stdin is piped (how every MCP client spawns this binary).
const [, , firstArg] = process.argv;
if (firstArg !== undefined || process.stdin.isTTY) {
  const { runCli } = await import("./cli.js");
  const { exitAfterFlush } = await import("./exit.js");
  await runCli(process.argv.slice(2));
  await exitAfterFlush(0); // never settles: exits from the flush callback, so the MCP startup below can't run
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { loadConfig, assertCredentials } from "./config.js";
import { SuuntoClient, localDate } from "./api.js";
import { adjustStrengthGuide, planWeek } from "./week-plan.js";
import { parseFit, summarizeFit } from "./fit.js";
import { RESOURCES, readResource } from "./resources.js";
import { PROMPTS, getPrompt } from "./prompts.js";
import { buildGuideZip, buildIntervalGuideZip, buildStrengthGuideZip } from "./guide-zip.js";
import { generateDigest } from "./daily-digest.js";
import { validateAgainstSchema } from "./schema-validate.js";
import { TOOL_META } from "./tool-meta.js";
import { LAP_EXTENSIONS, shapeLaps } from "./laps.js";
import { compareWorkout } from "./compare.js";
import { buildRestProfile } from "./rest-profile.js";
import { buildSnapshot, buildSnapshotRange } from "./snapshot.js";
import { buildTrainingLoad, forecastTrainingLoad } from "./training-load.js";
import { buildBaselines } from "./baselines.js";
import { buildExerciseHistory } from "./history.js";
import { logSession } from "./journal.js";
import { buildDraft } from "./draft.js";
import { KINDS as PREDICTION_KINDS, filePredictionStore, logPrediction, memoryPredictionStore, predictionStats, scorePredictions, voidPrediction } from "./predictions.js";
import { OUTCOME_METRICS, WEEKDAYS, analyzeExperiment, fileExperimentStore, getExperiment, logExperimentDay, memoryExperimentStore, startExperiment, stopExperiment } from "./experiments.js";
import { seedDemoState } from "./demo-state.js";
import { filePlanStore, getPlan, memoryPlanStore, setPlan } from "./plan.js";
import { buildCatchup, fileSeenStore, memorySeenStore } from "./catchup.js";
import { buildTagEffects } from "./tag-effects.js";
import { archiveStatus, archiveWorkouts, fileArchiveStore, memoryArchiveStore } from "./archive.js";
import { buildBenchmark } from "./benchmark.js";
import { buildWeeklyReport, fileReportStore, memoryReportStore } from "./report.js";
import { estimateRouteTime } from "./route-time.js";
import { DemoClient, DEMO_INSTRUCTIONS, DEMO_NOTICE, demoWriteResult, isDemo, markDemo } from "./demo.js";

const cfg = loadConfig();
// SUUNTO_DEMO=1: synthetic data, no credentials, no network (see demo.ts).
const demo = isDemo();
const suunto = demo ? new DemoClient() : new SuuntoClient(cfg);
// Local state of set_plan / get_plan / get_catchup: in demo mode it lives in memory and never reaches the disk.
const planStore = demo ? memoryPlanStore() : filePlanStore();
const seenStore = demo ? memorySeenStore() : fileSeenStore();
// The local workout archive (archive_workouts / get_archive_status): in memory in demo mode, never on disk.
const archiveStore = demo ? memoryArchiveStore() : fileArchiveStore();
// Where get_weekly_report saves its markdown: in memory in demo mode, never on disk.
const reportStore = demo ? memoryReportStore() : fileReportStore();
// The prediction ledger and the experiments: in memory in demo mode (seeded with deterministic demo data), never on disk.
const predictionStore = demo ? memoryPredictionStore() : filePredictionStore();
const experimentStore = demo ? memoryExperimentStore() : fileExperimentStore();
if (demo) await seedDemoState(predictionStore, experimentStore);
// Not read-only (they can write local state) but they never change anything at Suunto, so demo mode runs them on the
// in-memory stores instead of answering with the generic "nothing was written" note.
const LOCAL_STATE_TOOLS = new Set(["set_plan", "get_catchup", "archive_workouts", "get_weekly_report", "log_prediction", "void_prediction", "score_predictions", "start_experiment", "log_experiment_day", "stop_experiment"]);
// These only touch local files, so they work before any Suunto credentials are set up.
const NO_CREDENTIALS_TOOLS = new Set(["set_plan", "get_plan", "get_archive_status", "log_prediction", "void_prediction", "get_prediction_stats", "start_experiment", "get_experiment", "log_experiment_day", "stop_experiment"]);

// Read the version from package.json instead of hardcoding it here — a
// hardcoded string silently drifts from the real published version on
// every release (found stale at 0.13.1 while package.json was 0.14.0).
const pkgVersion: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

// Credential check runs lazily — at the moment a tool or resource actually
// tries to hit the API. This lets MCP introspection (ListTools,
// ListResources) succeed without credentials, which catalogs like
// glama.ai use to verify the server boots correctly.
function ensureReady() {
  if (!demo) assertCredentials(cfg);
}

// Far above any real route (a day-long track is well under 1 MB); keeps a mistaken path from reading a huge file.
const MAX_GPX_BYTES = 10_000_000;

const server = new Server(
  { name: "suunto-mcp", version: pkgVersion },
  { capabilities: { tools: {}, resources: {}, prompts: {} }, ...(demo ? { instructions: DEMO_INSTRUCTIONS } : {}) },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  ensureReady();
  const contents = await readResource(req.params.uri, suunto);
  return { contents: [demo ? { ...contents, text: markDemo(contents.text) } : contents] };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = getPrompt(req.params.name, req.params.arguments);
  if (!demo) return prompt;
  const note = `${DEMO_NOTICE} Say so in your answer: every number below comes from generated data.\n\n`;
  return { ...prompt, messages: prompt.messages.map((m) => ({ ...m, content: { ...m.content, text: note + m.content.text } })) };
});

const toolDefs = [
  {
    name: "list_workouts",
    description:
      "Returns the user's recent Suunto workouts ordered newest-first (Workout API v3). Each item: workoutKey (string id), activityId (numeric activity code — there is no separate plain-language 'sport' field; use get_workout_fit for the parsed FIT file's session.sport if a sport name is needed), startTime (epoch ms), totalTime (s), totalDistance (m), totalAscent (m), totalDescent (m), energyConsumption (kilocalories, not 'totalCalories'), hrdata: { avg, max } (workout heart rate — hrdata.max is the account's overall max HR, use hrdata.workoutMaxHR for this specific workout's peak). Auto-paginates with offset-based pagination until limit is reached or no more workouts exist. Each item also embeds SummaryExtension (including apps[]: the SuuntoPlus guide that ran, if any) and IntensityExtension (HR-zone times). Use get_workout_laps for the lap table of a single workout. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          format: "date-time",
          examples: ["2026-04-01T00:00:00Z"],
          description: "ISO 8601 lower bound on startTime (inclusive). Filters on workout start time; omit for all time. Pagination is automatic so since does not affect page size.",
        },
        until: {
          type: "string",
          format: "date-time",
          examples: ["2026-04-30T23:59:59Z"],
          description: "ISO 8601 upper bound on startTime (inclusive). Omit to include workouts up to the present. Combine with since to target a specific window.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 25,
          description: "Maximum number of workouts to return (1–1000). Defaults to 25. Pagination is automatic across API pages; set to 1 for the single most-recent workout.",
        },
      },
    },
  },
  {
    name: "get_workout",
    description:
      "Returns the base summary for one workout (about 1.6 KB): the same scalar fields as a list_workouts item (times, distance, energy, hrdata, tss/tssList, recoveryTime) plus extensionTypes, the list of data streams Suunto holds for it. It does NOT include laps, HR zones or other extension data — use get_workout_laps for laps and zone times, get_workout_fit for record-level data. Throws SuuntoNotFoundError if the workoutKey is malformed (not 24 hex characters) or does not exist. Use list_workouts to discover valid workoutKey values. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Opaque server-assigned string returned by list_workouts. Not guessable or constructable — always discover via list_workouts first. Passing an invalid key throws SuuntoNotFoundError.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_samples",
    description:
      "UNAVAILABLE — Suunto's API gateway currently rejects this endpoint (/v2/workout/samples) with 401 OperationNotFound on the account it was tested with (September 2026), so the call fails with an 'endpoint unavailable' error; it is not an authentication problem. Use get_workout_fit with full=true for record-level data (heart rate etc.), or get_workout_laps for laps. Kept so the tool starts working again if Suunto restores the endpoint. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Opaque server-assigned string returned by list_workouts. Not guessable or constructable — always discover via list_workouts first. Passing an invalid key throws SuuntoNotFoundError.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_fit",
    description:
      "Downloads the workout's binary FIT file from Suunto and returns it parsed to JSON. Default (full=false): compact summary { sport, total_distance_km, avg_heart_rate, training_effect, laps (a COUNT only, not the laps), records_sample: { first, middle, last (one record each), count } }. Set full=true to receive every parsed FIT record and lap — pretty-printed, about 550 KB for a 35-lap strength session, so the result usually spills to a file. For per-lap data use get_workout_laps instead (about 2.5 KB); use full=true only when record-level data is required. An unknown workoutKey fails with a 403 Forbidden error here (not-found on the other workout tools). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Opaque server-assigned string returned by list_workouts. Not guessable or constructable — always discover via list_workouts first.",
        },
        full: {
          type: "boolean",
          default: false,
          description: "false (default): return compact summary. true: return all parsed FIT records.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_daily_snapshot",
    description:
      "One call for \"how was this day, and the night before it\": the aggregation the other tools leave to the caller. Output: { date, sleepNightOf, sleep, recovery, activity, workouts, errors }. sleep describes the NIGHT THAT LED INTO the date (sleepNightOf = the previous date, i.e. sleeps that began between noon on the previous day and noon on the date): { main (the longest non-nap sleep: sleepId, bedtimeStart, bedtimeEnd, durationS, deepS, lightS, remS, score, avgHrv, hrAvg, hrMin, spo2Max, latencyS, wasoS, wakeBeforeOffBedS — all durations in seconds: time to fall asleep, awake after falling asleep, awake in bed before getting up), otherNights (further non-nap sleeps, when the watch split a night), nightSleepS (total of main + otherNights, null when there is none), naps }. Suunto marks any sleep shorter than about 3 hours as a nap, so a short night appears under naps with main null. recovery covers the local calendar day: { samples, low: { balance, at }, high, first, last, morning: { balance, at } (the sample nearest the main sleep's bedtimeEnd — the waking value), atBedtime: { balance, at } (nearest its bedtimeStart, which falls on the previous local day), both null when there is no main sleep or no sample within an hour, stressStateSamples (samples per StressState) } or null without data. low is the day's lowest balance — not necessarily overnight (after an evening workout it can fall in the evening). activity: { steps, energyKcal } for the local day — energyKcal is the daily-statistics energy converted from joules; real days come out around 700-1,500 kcal, well below a resting rate, so it looks like ACTIVE energy rather than a total (not verified against the watch). A value is null, never 0, when Suunto has no sample for the date. workouts: the day's workouts (by their own local date) with { workoutKey, activityId, startLocal, totalTimeS, kcal, hrAvg, hrMax, tss (HR method), guide, hasLaps } — pass a workoutKey with hasLaps to get_workout_laps. Each section is fetched independently: one that fails is null and explained in errors, the others are still valid. With `to`, returns { from, to, days: [...], errors } instead (errors is shared by the whole range; a failed section is null in every day). Use this instead of combining get_sleep, get_recovery, get_daily_activity_statistics and list_workouts by hand. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "The local calendar day YYYY-MM-DD (the first day when `to` is given). Use yesterday or earlier for a complete day; today's data is partial until the watch has synced, and the night that led into today may still be in progress.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-26"],
          description: "Optional last day of a range (inclusive, at most 14 days from `date`). The result is then { from, to, days: [one entry per day, in the shape above without errors], errors } — one request per section for the whole range, so prefer it to calling this once per day.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "get_baselines",
    description:
      "Your own recent norms, so a day can be judged against them: the band of the user's last `days` days (default 28) for sleep duration, sleep score, HRV, recovery on waking, the day's lowest recovery and steps, and where the judged `date` sits in it. The baseline window is the `days` days BEFORE `date` (date-days to date-1); `date` itself is never part of its own baseline. Per day: sleepDurationS, sleepScore and hrv (AvgHRV) come from the main sleep of the night that led INTO that day (as in get_daily_snapshot; sleep shorter than about 3 h is filed by Suunto as a nap and does not count, so that day has no value), recoveryMorning is the Balance nearest the main sleep's end, recoveryLow the lowest Balance of the local day (Balance x100 equals the watch's Resources %), steps the day's step count. A day without data has no value and is never counted as 0. Output (compact JSON; seconds whole, Balance 2 decimals, everything else 1): { date, from, to, days, metrics: { <metric>: { n (days with a value in the window), median, p25, p75, last7Median, latest, latestVsBand } }, notes, errors }. median, p25 and p75 are quantiles by linear interpolation between order statistics (position (n-1)*p in the sorted values; the median of an even n is the mean of the two middle values), and all three are null when n < 7 (too little data; notes says so). last7Median is the median of the last 7 days of the window, null with fewer than 4 values. latest is the value for `date` itself, null when missing; for steps and recoveryLow it is always null because that day is still running. latestVsBand is 'below' | 'within' | 'above' relative to [p25, p75] (the edges count as within), null when latest or the band is null. The band is the middle half of the user's own last N days, not a medical reference. One request each for sleep and recovery over the whole span; activity is read in pieces of up to 28 days (Suunto's limit for daily statistics), so 90 days cost 6 requests; a section that fails leaves its metrics empty and is listed in errors: [{ section, error }]. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "The local calendar day YYYY-MM-DD being judged against the baseline. Today works: its night may still be in progress and the watch may not have synced yet.",
        },
        days: {
          type: "integer",
          minimum: 14,
          maximum: 90,
          description: "Length of the baseline window in days, ending the day before `date` (default 28).",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "get_training_load",
    description:
      "Fitness (CTL, 42-day), Fatigue (ATL, 7-day) and Form (TSB = CTL - ATL) day by day up to `date`. Suunto's API has no endpoint for these, so they are computed from each workout's TSS (tss.trainingStressScore, 0 when Suunto has none) with the standard exponential model — the same maths as generate_daily_digest. The result can be about 1 point off the watch for CTL (compared once with the Suunto app: ATL and TSB matched, CTL was about 0.9 lower). Without seeds, workouts from 120 days before the window are read as warm-up and CTL/ATL start from 0 there, so the window is not cold-started; with little workout history CTL still reads low (it takes about 4-6 weeks to converge), which notes then says. Output (compact JSON, numbers to 1 decimal): { from, to, current: { ctl, atl, tsb, rampRate7d (CTL change over the last 7 days, null when not enough days) }, weeks: [{ weekStart (Monday), workouts, durationS, tss }] (only the days from..to count, so the first and last week can be partial), series: [{ date, tss, ctl, atl, tsb }] (values at the end of each day; tss 0 is a rest day, not missing data), notes: [caveats, plus: no workouts at all in the range, workouts without TSS, and when the workout limit was reached so numbers may be too low] }. Workouts are placed on their own local date. Read-only: it only reads workouts and never touches the digest's history or averages files.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "The last local calendar day of the series, YYYY-MM-DD. Today works but its workouts may not have synced yet.",
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 120,
          description: "How many days the series covers, ending at `date` (default 28).",
        },
        seedCtl: {
          type: "number",
          minimum: 0,
          description: "Optional: Fitness (CTL) at the end of the day before the series starts, read off the watch or app, instead of computing it from a 120-day warm-up. Giving seedCtl or seedAtl skips the warm-up; a seed left out starts at 0.",
        },
        seedAtl: {
          type: "number",
          minimum: 0,
          description: "Same as seedCtl but for Fatigue (ATL).",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "forecast_training_load",
    description:
      "Projects Fitness (CTL, 42-day), Fatigue (ATL, 7-day) and Form (TSB) for planned training days: the same model and constants as get_training_load, rolled forward from today's values. Give each planned day's training stress as `tss` (the unit get_training_load shows per day: a typical hour of easy training is about 40-60, a hard one 80-100+); a date left out of `days` between today and the last planned day is a rest day (tss 0). Starts from the state at the end of `asOf` (default today) read with get_training_load's own computation (one workouts request, warm-up included); every planned date must be after asOf, and asOf must not be in the future, so to plan today pass yesterday as asOf. Workouts already in the account after asOf are not read: list them in `days`. Output (numbers to 1 decimal): { asOf, start: { ctl, atl, tsb }, series: [{ date, tss, ctl, atl, tsb }] (one per day from the day after asOf to the last planned day, values at the end of each day), notes }. A projection of the model, not a prediction of how you will respond; CTL can be about 1 point off the watch. At most 120 days after asOf. Read-only: it writes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "array",
          minItems: 1,
          maxItems: 120,
          description: "The planned days, in any order, one entry per date.",
          items: {
            type: "object",
            properties: {
              date: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", minLength: 10, maxLength: 10, description: "The day, YYYY-MM-DD, after asOf." },
              tss: { type: "number", minimum: 0, maximum: 1000, description: "The day's total planned training stress (all sessions of that day together)." },
            },
            required: ["date", "tss"],
          },
        },
        asOf: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "The last local day whose workouts are counted as done, YYYY-MM-DD (default today; not in the future). The projection starts the day after.",
        },
      },
      required: ["days"],
    },
  },
  {
    name: "get_workout_laps",
    description:
      "Returns the manual laps of one workout as a compact table, plus its training-load fields — the way to read back a guided gym session set by set (push_strength_guide records one lap per set and per rest; push_workout_guide one lap per exercise and one per rest between exercises). A session from push_interval_guide auto-advances and is expected to record no manual laps (unverified), so it should return an empty table. About 2.5 KB for a 35-lap strength session, versus ~550 KB for get_workout_fit full=true. Output: { workoutKey, activityId, startTime (epoch ms), totalTimeS, guide: { id, name } | null (the guide that ran, as recorded by Suunto — not looked up in list_guides, because guides are often deleted afterwards), tss: [{ method (seen so far: 'HR', 'MET'), value }], pte, peakEpoc, recoveryTime (from the workout's summary extension; units not verified, and it can differ from the recoveryTime that list_workouts and get_workout carry), hrZoneTimeS: [zone1..zone5 seconds], feeling (the answer to the watch's 'How was it?' question, passed through as Suunto sends it; null when skipped), lapCount, checks: [{ code, detail }], laps: { cols, rows } }. checks lists reasons not to trust positional reading of the table (empty when clean): 'duplicate-rest' (the same rest label twice in a row — a set lap is missing or a rest was split), 'no-session-complete' (a guided table without its final lap — session ended early, buttons locked or watch restarted), 'unlabelled-laps' (some laps have no guide label), 'no-heart-rate' (no lap has heart rate, e.g. battery mode Tour). laps.cols = [i (1-based), startOffsetS (from workout start), durationS, hrAvg, hrMax, hrMin (bpm), kcal, kind, label]; each row is an array in that order. label is the text of the guide step that was active during the lap (lines joined with ' | '), or null when no guide ran. kind is 'rest' when the label contains 'Next:' at its start or after a '·' (a per-set rest lap reads 'Next: set k/S', or '<restSec>s target · Next: set k/S' with restMode 'stopwatch'), 'done' for the final 'Session complete' lap, 'step' for any other labelled lap, null when there is no label. A per-set strength guide yields, per exercise, a prep lap, then set 1, rest, set 2, rest, … — 2 × sets laps — and one trailing 'Session complete' lap for the whole session; a prep lap's label reads '<plates or detail> | <name>' and a set lap's '<name> | <detail>' (the halves are swapped, but the text is not always decisive, e.g. a name equal to the detail or a label cut at 40 characters), so tell them apart by position. Real sessions can deviate (skipped or repeated rest laps), so check the labels rather than only counting. A workout without manual laps (unguided gym, cycling) returns lapCount 0 and laps.rows [] — not an error. Call list_workouts first for the workoutKey.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "The 24-character workoutKey returned by list_workouts. Anything else fails with a not-found error without calling Suunto.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "compare_workout_to_plan",
    description:
      "Compares one guided gym session with its plan: maps the manual laps (the same data get_workout_laps returns) to exercises, sets and rests, and reports planned vs actual with honest deviations. Works for sessions pushed with push_strength_guide (lapGranularity perSet or perExercise, restMode countdown or stopwatch) and push_workout_guide. The plan — exercise order, set counts, rest targets — is read from the lap labels, so `plan` is optional; pass the exercises array you pushed to also check the session against it (missing, extra or reordered exercises, set counts, rest targets). Output: { workoutKey, guide, status ('ok' | 'no-laps' | 'no-guide-labels' | 'unknown-label-format'), format ('strength-perSet' | 'strength-perExercise' | 'workout'), restMode ('countdown' | 'stopwatch' | null), complete (the guide's 'Session complete' lap was reached), reliable, note, checks (get_workout_laps' checks, passed through), lapCount, baselineHr (heart rate of lap 1, the first prep — null for workout guides), cols, exercises: [{ n, name, detail, plan (index into plan or null), planned: { sets, restS }, prep, sets, rests }], afterComplete, unattributed, deviations: [{ code, basis ('labels' | 'plan' | 'heuristic'), ex, plan, laps, detail }] }. prep, sets, rests, afterComplete and unattributed rows are arrays in the column order given by cols. A rest row's peak is the rest lap's max HR and end its min HR (optical HR lags 20–30 s, so the peak lands in the rest, not in the set); endVsBaseline is end minus baselineHr. Deviation codes: unexpected-sequence, rest-split, rest-short, rest-long, short-set, long-set, missing-set, extra-set, rest-target-mismatch, extra-exercise, ended-early, unlabelled-lap, after-complete, order-differs, missing-exercise. reliable is false when checks has an entry other than no-heart-rate (which only nulls the heart-rate fields) or the laps break the guide's step order; the mapping is then best effort and note says why. With restMode countdown a rest lap always lasts exactly its target (the watch advances by itself), so extra rest ends up inside the next set's lap and is not measurable. About 1–4 KB. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "The 24-character workoutKey returned by list_workouts. Anything else fails with a not-found error without calling Suunto.",
        },
        plan: {
          type: "array",
          minItems: 1,
          description: "Optional: what the session was meant to be, in order. Pass the exercises array given to push_strength_guide or push_workout_guide as-is — only name, sets and restSec are read. Without it the plan is read from the lap labels alone.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name as pushed to the guide, e.g. 'Back Squat'." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Planned number of sets." },
              restSec: { type: "integer", minimum: 1, description: "Planned rest between sets, in seconds." },
            },
            required: ["name"],
          },
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_rest_profile",
    description:
      "Per-rest heart-rate recovery of one guided gym session, from the FIT file's record-level heart rate joined to the guide's lap labels (the same exercise/set mapping as compare_workout_to_plan). compare_workout_to_plan reports only a rest lap's max and min HR, and with restMode countdown the lap lasts exactly its target, so how far and how fast the heart rate fell is invisible there; this tool reads it from the individual HR samples. Output: { workoutKey, status ('ok' | 'no-laps' | 'no-guide-labels' | 'unknown-label-format', passed through from compare_workout_to_plan; any other status returns empty rests), restMode, reliable, note, hrQuality: { reliable (true | false | null when the FIT has no heart rate at all), reasons, coverage }, rests: [{ exercise, exerciseN, set (the set after which the rest happened), plannedRestS, actualDurationS, peakHr, peakAtS, endHr, dropTotal, t10S, t20S, t30S, recoveryBpmPerMin, sampleCount, coverage, note }], perExercise: [{ name, n, medianT20S, medianEndHr, medianRecoveryBpmPerMin }], developer: { apps, fields: [{ name, units, devIdx, fieldNo, baseType }], devChannels } | null, alignment: { workoutStartSource ('session.start_time' | 'laps.startTime' | 'first-record'), lapStartTimeMs, fitStartMs, startSkewS } }. Units: heart rate in bpm; peakAtS in seconds from the start of the rest (negative when the peak came before it); t10S, t20S and t30S in seconds after the peak until the 3-sample-smoothed HR first reached peakHr minus 10, 20 or 30 bpm (null if it never did within the rest); endHr is the mean of the last 5 s of the rest; dropTotal is peakHr minus endHr; recoveryBpmPerMin is the fall (smoothed) over the first 60 s after the peak (or what the rest has left of it); coverage is the fraction of the rest's seconds that have an HR sample (0 to 1). hrQuality rates the whole session's HR: reliable false when under 80% of the session is covered (coverage: the share not lost to gaps of over 10 s between plausible samples, whatever the sampling rate), over 2% of the samples are outside 30-230 bpm, the same value holds for over 180 s, or jumps of over 40 bpm between adjacent samples are frequent; then reliable above is false too and note lists the reasons (the rest numbers are still returned, best effort); null means no heart rate in the FIT at all. peakHr is the highest 3-sample-smoothed value from 15 s before the rest to 30 s after it started (clipped to the rest; the latest of tied values), because optical HR lags the effort by 20-30 s and keeps rising into the rest; a single spike does not set it, and a sharp peak reads a little lower than its raw sample. Samples outside 30-230 bpm are ignored. A rest with fewer than 5 HR samples returns nulls with a note instead of failing. In a workout guide (push_workout_guide) the rest lap before an exercise counts as the rest after the previous exercise; a strength guide with lapGranularity perExercise has no between-set rests, so rests is empty. Caveats: the rest windows come from the lap table's startOffsetS (seconds from the workout start) and are placed on the FIT's timeline from the lap table's startTime (else the FIT session start_time, else its first record); that this lines up exactly was not checked against a real workout, and alignment.startSkewS (FIT session start minus the lap table's startTime) plus the note flag a disagreement of more than 2 s, and reliable is false beyond 10 s. A rest with a lap pressed during it (rest-split) carries a note. After an exercise's last set the transition into the next exercise's prep lap is not profiled. developer lists the SuuntoPlus app's developer fields in the FIT and which of them carry values; it is null or devChannels is empty when the app writes none (whether Suunto's FIT files carry them is unverified). Downloads the FIT file (about 550 KB for a 35-lap session) but returns only a few KB. Optional plan is the same as for compare_workout_to_plan. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "The 24-character workoutKey returned by list_workouts. Anything else fails with a not-found error without calling Suunto.",
        },
        plan: {
          type: "array",
          minItems: 1,
          description: "Optional: what the session was meant to be, in order. Pass the exercises array given to push_strength_guide or push_workout_guide as-is — only name, sets and restSec are read. Without it the plan is read from the lap labels alone.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name as pushed to the guide, e.g. 'Back Squat'." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Planned number of sets." },
              restSec: { type: "integer", minimum: 1, description: "Planned rest between sets, in seconds." },
            },
            required: ["name"],
          },
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_exercise_history",
    description:
      "Progression of strength exercises across guided gym sessions (push_strength_guide / push_workout_guide): load, sets, rest and heart-rate recovery of the same exercise week after week. Each session is read once with the same logic as get_workout_laps, compare_workout_to_plan and get_workout_rest_profile, and the small derived result is cached on disk (~/.suunto-mcp/cache/, SUUNTO_CACHE=off disables it), so repeat calls are cheap. It writes nothing but that cache and never changes anything at Suunto. Looks at the `weeks` weeks (default 8, max 26) ending at `date` (default today; a session that started less than 24 h ago is read but not cached). Reads at most 8 sessions not yet cached per call (two requests each, newest first); the result's `pending` is how many are still unread: CALL AGAIN until pending is 0 before drawing conclusions from the history, unless a note says calling again will not help (cache not writable, sessions failing): then say so instead of looping. A session that fails to load is skipped and listed in `errors`. IMPORTANT: the watch records only the guide's TEXT, so weights and reps are what was PLANNED, not measured; a log_session entry for the session replaces the label's weight with the logged one (loadSource 'journal') and is attached as `journal`. Sessions whose mapping or rest profile is unreliable are included with reliable false and never enter restEndHrMedian. Only the sessions whose heart-rate data is unreliable (dropouts, implausible values, flat-lines, frequent jumps; see get_workout_rest_profile's hrQuality) are also named in a note with the reasons (with name: those with a matching exercise; without: all in the range); a session unreliable for another reason (a missing lap, say) is marked but not named, and one whose FIT has no heart rate at all gets its own note. Without `name`: { from, to, sessions (guided sessions read), exercises: [{ name, sessions, lastDate, lastDetail }] (most sessions first; a name the guide cut to 40 characters is grouped with its longer form only when that is certain: exactly one longer name and at least 12 characters, otherwise they stay separate and a note lists them), pending, errors, notes }. With `name`: { name, from, to, sessions: { cols, rows } (oldest first; cols = date, workoutKey, detail, kg (the first 'NNkg' in the label text, or the top journal set's weight; null when there is none, never guessed), loadSource ('label' | 'journal'), setsDone, plannedSets, restS (the guide's rest), restEndHr / restDropTotal / restT20S / restCoverage (heart-rate recovery of the rest after set 1 from the FIT's record-level HR, null when missing: end-of-rest HR, peak minus end, seconds after the peak to fall 20 bpm, share of the rest's seconds with an HR sample), deviations (compare_workout_to_plan codes for that exercise), reliable, journal), summary: { sessions, firstLoadKg, lastLoadKg, restEndHrMedian (median end-of-rest HR after set 1 over reliable sessions: usable as push_strength_guide's restTargetHr) }, suggestion: { last, target, reason } (the newest session as e.g. '3x8@60kg' or, when set weights differed, '8@60/8@60/5@65kg', and a simple next target: when a log_session entry shows every planned set done with every planned rep at ONE weight, the same sets x reps with a step on top (2.5 kg, but at most 5% of the load in 1.25 kg steps and at least 1.25 kg: 5 kg goes to 6.25); a short set, differing weights between sets (repeat at the lowest weight that reached the reps), a missing load or a rep range written in any way ('3x8-12', '3x8 - 12', '3x8–12', '3x8 to 12') never raise the load: repeat; null without a session; usable as push_strength_guide's per-exercise last/target; nothing is pushed), pending, errors, notes }. `name` is matched ignoring case, accents and punctuation, exactly or, for a name the guide may have cut (12+ characters), as a prefix of the given name. Use the names from the index (or compare_workout_to_plan). Writes only the local cache.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "Exercise name, e.g. 'Back Squat'. Omit for an index of all exercises in the range." },
        weeks: { type: "integer", minimum: 1, maximum: 26, description: "How many weeks the history covers, ending at `date` (default 8)." },
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "The last local calendar day of the range, YYYY-MM-DD (default today).",
        },
      },
    },
  },
  {
    name: "log_session",
    description:
      "Records what the user says ACTUALLY happened in a gym session (reps, weights, RPE, notes), because the watch only records the guide's planned text. Writes only the local file ~/.suunto-mcp/journal.json (SUUNTO_JOURNAL_PATH overrides it) and never contacts Suunto. One entry per workoutKey: logging the same workoutKey again REPLACES that entry, and the result returns the previous one as `replaced` so nothing is lost silently. A call with no note, no feeling, no tags and no exercises is refused ('nothing to log'): it would wipe the stored entry. Unknown fields at any level (e.g. `weight`) are refused with an error naming the field, never dropped: use `kg` inside a set. get_exercise_history attaches the entry as `journal` and uses the top set's kg as the load when sets carry kg. Only record what the user told you; leave out what they did not say. Exercise names should be the ones get_exercise_history or compare_workout_to_plan show. Limits: reps integer 0-200, kg 0-1000, rpe 1-10, texts up to 500 characters, at most 40 exercises and 20 sets each, at most 8 tags of 1-24 characters each (trimmed; no control characters; no duplicates, ignoring case; stored on the entry; get_tag_effects compares the nights after tagged sessions with the others, get_exercise_history does not use them). A call with ONLY tags does not replace the entry: it sets the entry's tags and keeps its note, feeling and exercises (a tags-only entry is created when none exists). Optional `source: 'draft'` marks an entry made from a confirmed draft_session_log. Output: { saved, replaced, entries }.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workoutKey: { type: "string", minLength: 24, maxLength: 24, pattern: "^[0-9a-fA-F]{24}$", description: "The 24-character workoutKey of the session, from list_workouts or get_daily_snapshot." },
        note: { type: "string", maxLength: 500, description: "How the session went overall, in the user's words, e.g. 'all as planned except squat set 3'." },
        feeling: { type: "string", maxLength: 500, description: "How the user felt, e.g. 'tired', 'strong'." },
        tags: {
          type: "array",
          maxItems: 8,
          description: "Optional short labels for the session, e.g. ['deload', 'poor-sleep'] (at most 8, each 1-24 characters, trimmed, no duplicates). Sent alone, they set the tags of the existing entry without touching the rest.",
          items: { type: "string", minLength: 1, maxLength: 24 },
        },
        source: { type: "string", enum: ["draft"], description: "Pass 'draft' when the exercises come from a draft_session_log that the user confirmed or corrected (the reps and weights began as the guide's plan). Stored on the entry; nothing else changes." },
        exercises: {
          type: "array",
          maxItems: 40,
          description: "Per exercise what was actually done. Leave out exercises that went as planned.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 500, description: "Exercise name as in get_exercise_history, e.g. 'Back Squat'." },
              sets: {
                type: "array",
                maxItems: 20,
                description: "The sets in order, as done.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    reps: { type: "integer", minimum: 0, maximum: 200, description: "Reps done." },
                    kg: { type: "number", minimum: 0, maximum: 1000, description: "Weight used, in kg." },
                    rpe: { type: "number", minimum: 1, maximum: 10, description: "Rate of perceived exertion, 1-10." },
                  },
                },
              },
              note: { type: "string", maxLength: 500, description: "A note on this exercise, e.g. 'left knee felt tight'." },
            },
            required: ["name"],
          },
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "export_workout_gpx",
    description:
      "UNAVAILABLE — Suunto's API gateway currently rejects this endpoint (/v2/workout/exportGpx) with 401 OperationNotFound on the account it was tested with (September 2026), so the call fails with an 'endpoint unavailable' error; it is not an authentication problem. Would return the workout's GPS route as a GPX 1.1 XML string. Kept so the tool starts working again if Suunto restores the endpoint. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Opaque server-assigned string returned by list_workouts. Not guessable or constructable — always discover via list_workouts first. Passing an invalid key throws SuuntoNotFoundError.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_daily_activity",
    description:
      "Returns the 24/7 activity samples for one local calendar day (00:00–23:59 in the local time the watch stamped on each sample) from the /247samples API, as a plain array of { timestamp (ISO 8601 with UTC offset), entryData: { HR (bpm), StepCount, EnergyConsumption (joules, as in get_daily_activity_statistics) } } — 144 rows for a full day, one per 10 minutes (138 or 150 on the days the clocks change). A day without synced data returns []. Use list_daily_activity for a date range. Requires 24/7 Activity API subscription on apizone. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "Calendar date YYYY-MM-DD (a local day, in the local time the watch stamped on each sample). Data arrives when the watch syncs, so today's is usually partial — the API answers 200 with an empty or partial payload for today and future dates rather than an error (confirmed live). Use yesterday or earlier for complete results.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_daily_activity",
    description:
      "Returns 24/7 activity samples from the /247samples API for the local calendar days [from, to] inclusive (in the local time the watch stamped on each sample), ordered chronologically, as a plain array of { timestamp (ISO 8601 with UTC offset), entryData: { HR (bpm), StepCount, EnergyConsumption (joules, as in get_daily_activity_statistics) } }. Days without synced data are simply absent. Use get_daily_activity for a single day or get_daily_activity_statistics for aggregated daily step/energy totals. Requires 24/7 Activity API subscription on apizone. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-01"],
          description: "Start date YYYY-MM-DD, inclusive. Must be ≤ to. Days without synced data are silently omitted, not 404.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-30"],
          description: "End date YYYY-MM-DD, inclusive. Future dates are accepted but produce no entries. Prefer about 3–7 days: a day is ~15 KB, so 30 days is ~450 KB (use get_daily_activity_statistics for longer totals).",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_sleep",
    description:
      "Returns the sleeps of one night from the /247samples API. A date means the NIGHT of that date: every sleep that began between 12:00 (noon) on it and 12:00 the next day, in the local time the watch stamped on the sleep — so 23:00, 00:30 and 03:00 bedtimes all belong to the same date, and an afternoon nap is filed with the night after it. Last night is therefore filed under yesterday's date. Plain array with one row per sleep — Suunto re-sends a sleep every time it revises it, and only the longest revision is kept — of { timestamp (= BedtimeStart, ISO 8601 with UTC offset), entryData: { SleepId, IsNap, BedtimeStart, BedtimeEnd, Duration (s), DeepSleepDuration, LightSleepDuration, REMSleepDuration (s), SleepQualityScore, AvgHRV (ms), HRAvg, HRMin (bpm), … } }. IsNap is true for any sleep shorter than about 3 hours, at any time of day, and can flip while a sleep is still being recorded — so it also marks a short fragment of a split night; do not drop rows by IsNap alone. A night can hold several rows (a split night, or a nap beside it): rows are not merged, so decide from BedtimeStart and Duration which belong together. Returns [] when no sleep began in that window, e.g. today's date before tonight. Use list_sleep for a range. Requires Sleep API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "Date YYYY-MM-DD of the night, NOT the wake-up date: sleeps that began between noon on this date and noon the next day (in the local time the watch stamped on each sample), so a bedtime shortly after midnight — even 03:00 — still belongs to the previous date. Last night's sleep is under yesterday's date, not today's; today's date is empty until tonight's sleep begins.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_sleep",
    description:
      "Returns the sleeps of the nights [from, to] inclusive from the /247samples API, ordered chronologically by bedtime. A date means the NIGHT of that date: every sleep that began between 12:00 (noon) on it and 12:00 the next day, in the local time the watch stamped on the sleep — so 23:00, 00:30 and 03:00 bedtimes all belong to the same date, and an afternoon nap is filed with the night after it. Last night is therefore filed under yesterday's date. Same rows as get_sleep, one per sleep (revisions collapsed): { timestamp (= BedtimeStart, ISO 8601 with UTC offset), entryData: { SleepId, IsNap, BedtimeStart, BedtimeEnd, Duration (s), DeepSleepDuration, LightSleepDuration, REMSleepDuration (s), SleepQualityScore, AvgHRV (ms), HRAvg, HRMin (bpm), … } }. Nights without recorded sleep are simply absent. Use get_sleep for a single night. Requires Sleep API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-01"],
          description: "First bedtime date YYYY-MM-DD, inclusive (the date the person went to bed, not woke up — see get_sleep). Must be ≤ to. Nights without recorded sleep are silently omitted, not 404.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-30"],
          description: "Last bedtime date YYYY-MM-DD, inclusive (the date the person went to bed, not woke up — see get_sleep). Future dates are accepted but produce no entries. Prefer ranges ≤ 30 days for responsiveness.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_recovery",
    description:
      "Returns recovery-balance samples from the /247samples API for one local calendar day (00:00–23:59 in the local time the watch stamped on each sample), as a plain array of { timestamp (ISO 8601 with UTC offset), entryData: { Balance (0.0–1.0 recovery balance), StressState (0=Invalid, 1=Relaxing, 2=Active, 3=Passive, 4=Stressful) } } — 48 half-hourly rows for a full day (46 or 50 on the days the clocks change). A day without recovery data returns []. Use list_recovery for a date range. Requires Recovery API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "Calendar date YYYY-MM-DD (a local day, in the local time the watch stamped on each sample). Data arrives when the watch syncs, so today's is usually partial — the API answers 200 with an empty or partial payload for today and future dates rather than an error (confirmed live). Use yesterday or earlier for complete results.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_recovery",
    description:
      "Returns recovery-balance samples from the /247samples API for the local calendar days [from, to] inclusive (in the local time the watch stamped on each sample), ordered chronologically, as a plain array of { timestamp (ISO 8601 with UTC offset), entryData: { Balance (0.0–1.0 recovery balance), StressState (0=Invalid, 1=Relaxing, 2=Active, 3=Passive, 4=Stressful) } }. Days without recovery data are simply absent. Use get_recovery for a single day. Requires Recovery API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-01"],
          description: "Start date YYYY-MM-DD, inclusive. Must be ≤ to. Days without recovery data are silently omitted, not 404.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-30"],
          description: "End date YYYY-MM-DD, inclusive. Future dates are accepted but produce no entries. Prefer about 14 days or less: a day is ~4 KB of output.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_daily_activity_statistics",
    description:
      "Returns aggregated daily step count and energy consumption (joules) from the /247 API for the given datetime range. Response is an array of AggregatedActivityData objects, each with a Name ('stepcount' or 'energyconsumption'), Aggregation ('sum'), and Sources array containing per-device Samples with TimeISO8601 and Value. The window must be less than 28 days (exactly 28 is rejected). Samples with null Value indicate no data synced for that day. Each daily Sample is stamped local noon (TimeISO8601 like 2026-09-27T12:00:00+02:00); a one-day window (startdate = enddate = D) was observed returning the samples for D and the day after, so select samples by the date in TimeISO8601 rather than summing the response. Prefer this tool over list_daily_activity when you need totals rather than intraday time-series. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        startdate: {
          type: "string",
          examples: ["2026-04-01T00:00:00"],
          description:
            "Start datetime in ISO-8601 format, with or without a UTC offset (e.g. 2026-04-01T00:00:00 or 2026-04-01T00:00:00+02:00). An offset written +0200, as `date +%z` prints it, is rewritten to +02:00 because Suunto rejects the former.",
        },
        enddate: {
          type: "string",
          examples: ["2026-04-27T23:59:59"],
          description:
            "End datetime in ISO-8601 format, same forms as startdate (e.g. 2026-04-27T23:59:59). Must be less than 28 days after startdate.",
        },
      },
      required: ["startdate", "enddate"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "UNAVAILABLE — Suunto's API gateway currently rejects this endpoint (/v2/subscriptions) with 401 OperationNotFound on the account it was tested with (September 2026), so the call fails with an 'endpoint unavailable' error rather than returning a list. Would return the active webhook subscriptions as an array of { id, eventType, callbackUrl, createdAt }. Kept so the tool starts working again if Suunto restores the endpoint. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_routes",
    description:
      "Returns the user's saved Suunto routes — at most 5 of them (Suunto's list endpoint ignores limit/offset and appears to return the newest, unverified), so an account with more routes is NOT fully listed; look a route up by id with get_route (ids come from upload_route results, the Suunto app or the route webhook). Each route: id, description, visibility, activityIds, startPoint/centerPoint/endPoint, totalDistance (m), created/modified (epoch ms), watchEnabled. Use export_route for the GPX track. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_route",
    description:
      "Returns one saved Suunto route by id: { id, description, visibility, activityIds, startPoint, centerPoint, endPoint (latitude, longitude, altitude), totalDistance (m), averageSpeed, created, modified (epoch ms), watchEnabled (true = offered to the watch), turnWaypointsEnabled }. Works for any route, including ones list_routes does not show (it returns at most 5). Whether the route is actually on the watch cannot be seen here — that is decided by the Suunto app's sync. Use export_route for the track. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        routeId: {
          type: "string",
          minLength: 1,
          description: "Route ID, e.g. from upload_route or list_routes.",
        },
      },
      required: ["routeId"],
    },
  },
  {
    name: "export_route",
    description:
      "Exports a saved Suunto route as a GPX 1.1 XML string. Suitable for import into navigation apps (Komoot, Strava, Garmin Connect, etc.). Use list_routes to discover valid route IDs. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        routeId: {
          type: "string",
          minLength: 1,
          description: "Route ID returned by list_routes.",
        },
      },
      required: ["routeId"],
    },
  },
  {
    name: "upload_route",
    description:
      "Imports a GPX file as a route in the user's Suunto account (it appears in the Suunto app's route library as PRIVATE and can then be synced to the watch for navigation). Provide the absolute path to a .gpx file. Every <rte> or <trk> element in the file becomes its own route; the route name comes from its <name> (or <desc>), and waypoints are created from <wpt> elements at the same coordinates as route points and from route points that have a name or type. The route's activities come from the `activities` argument, NOT from the GPX content (default [1] = running). Returns { count, routes: [{ id, name, activities, segments }], check: { verified, watchEnabled, distanceM, pointsInFile, pointsInRoute, note? } }. Imports are queued one at a time with a short pause and each route is read back from Suunto (point count against the file), so many calls at once are safe; expect roughly 3 s per route. verified:false with a note means the import went through but the read-back did not match — say so to the user instead of reporting success. A route cannot be deleted through this server — remove it in the Suunto app. Requires the Route API on the Suunto subscription (list_routes shows existing routes). Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          minLength: 1,
          description: "Absolute path to the .gpx file on disk.",
        },
        activities: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
          maxItems: 20,
          default: [1],
          description: "Suunto activity IDs the route is suitable for (1 = running; the other IDs are in Suunto's Activities.pdf on apizone). Shown in the app's route details. Optional.",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "upload_workout",
    description:
      "Uploads a workout file to the user's Suunto account. Provide the absolute path to the file on disk. The file is pushed to Suunto and appears in the app after processing (usually a few seconds). Waits for Suunto to process the file (polling the upload status for up to about 20 s) and returns { uploadId, message, status, check: { verified, note? } }: verified is true when the status reaches 'Processed'; otherwise note says why (another final status such as 'Error', or processing not finished in time — then poll get_upload_status with the uploadId later). Uploads are queued one at a time with a short pause, so several calls at once are safe. Suunto's own upload API docs state only .fit (binary) is currently supported for this endpoint — a .gpx path is still accepted here (sent as application/gpx+xml) in case that changes, but treat it as unverified; use .fit for a workout that must reliably show up. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          minLength: 1,
          description: "Absolute path to the .fit or .gpx file on disk.",
        },
        description: {
          type: "string",
          description: "Short workout title shown in the Suunto app. Optional.",
        },
        comment: {
          type: "string",
          description: "Longer notes for the workout. Optional.",
        },
        privacy: {
          type: "string",
          enum: ["DEFAULT", "PRIVATE", "FOLLOWERS", "PUBLIC"],
          default: "DEFAULT",
          description: "Visibility. DEFAULT uses the account's default setting.",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "push_workout_guide",
    description:
      "Pushes a text-step workout guide to the user's Suunto account via the SuuntoPlus Guide Cloud API. Each exercise becomes one step, advanced by a lap-button press on the watch. Requires SUUNTO_APP_NAME env var to exactly match the app name registered on apizone.suunto.com. There is no live push to the watch itself — delivery depends on the phone's normal Suunto app sync. In testing it showed up on the watch after the next ordinary sync with no manual pinning needed; if it doesn't appear, check the Suunto app under SuuntoPlus Guides and pin it there. For gym sessions prefer push_strength_guide: it records one lap per set and per rest, which get_workout_laps can read back. Returns Suunto's response (including the guide id) plus nextStep and check: { verified, note? }: after the push the guide is looked up in the guide list (by id), and verified:false with a note means the push went through but the guide was not found there — say so to the user instead of reporting success. Pushes are queued one at a time with a short pause, so several calls at once are safe. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Short session name shown in the Suunto app, e.g. 'Push A'.",
        },
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Session date YYYY-MM-DD.",
        },
        exercises: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name, e.g. 'Bench Press 15°'." },
              detail: { type: "string", minLength: 1, description: "Sets/reps/weight as one display string, e.g. '60kg 3x10'." },
            },
            required: ["name", "detail"],
          },
        },
        guideId: {
          type: "string",
          description: "If provided, updates this existing guide instead of creating a new one.",
        },
      },
      required: ["title", "date", "exercises"],
    },
  },
  {
    name: "push_interval_guide",
    description:
      "Pushes an interval/cardio guide (warmup, timed or distance-based work intervals, recoveries, optional repeats) to the user's Suunto account via the SuuntoPlus Guide Cloud API. Unlike push_workout_guide (manual lap-per-exercise), interval segments auto-advance by elapsed time or distance — hands-off during a run or ride. Each segment can show a target heart-rate range alongside live HR. Requires SUUNTO_APP_NAME env var to exactly match the app name registered on apizone.suunto.com. Same delivery caveat as push_workout_guide: appears after the phone's next normal Suunto app sync, no live push. Returns Suunto's response (including the guide id) plus nextStep and check: { verified, note? }: after the push the guide is looked up in the guide list (by id), and verified:false with a note means the push went through but the guide was not found there — say so to the user instead of reporting success. Pushes are queued one at a time with a short pause, so several calls at once are safe. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Short session name shown in the Suunto app, e.g. '4x4 VO2max'.",
        },
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Session date YYYY-MM-DD.",
        },
        blocks: {
          type: "array",
          minItems: 1,
          description:
            "Ordered list of blocks. A block with times>1 repeats its segments as a unit (e.g. 4x[interval,recovery]) — put only the segments that repeat inside it; warmup/cooldown go in their own times=1 blocks before/after.",
          items: {
            type: "object",
            properties: {
              times: {
                type: "integer",
                minimum: 1,
                default: 1,
                description: "Repeat count for this block's segments. Omit or 1 for a non-repeating block.",
              },
              segments: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", minLength: 1, description: "Segment name, e.g. 'Warmup', 'Interval', 'Recovery'. Shown as the step title (truncated to 13 chars)." },
                    durationSec: { type: "integer", minimum: 1, description: "Auto-advance after this many seconds. Mutually exclusive with distanceM — provide exactly one." },
                    distanceM: { type: "number", minimum: 1, description: "Auto-advance after this many meters. Mutually exclusive with durationSec." },
                    targetHrMin: { type: "integer", description: "Lower bound of target heart-rate range (bpm). Provide with targetHrMax, or omit both." },
                    targetHrMax: { type: "integer", description: "Upper bound of target heart-rate range (bpm)." },
                    notifyText: { type: "string", description: "Optional vibrate + popup text shown when this segment starts, e.g. 'Push to 170bpm'." },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["segments"],
          },
        },
        guideId: {
          type: "string",
          description: "If provided, updates this existing guide instead of creating a new one.",
        },
      },
      required: ["title", "date", "blocks"],
    },
  },
  {
    name: "push_strength_guide",
    description:
      "The guide's icon in the Suunto app's guide list is a blue-violet gradient with a barbell. Pushes a resistance-training guide to the user's Suunto account via the SuuntoPlus Guide Cloud API — the tool to use for gym sessions. Step titles show where you are: a prep step is '<i>/<N>' (exercise i of N), a set step '<i>/<N> - <k>/<S>' (exercise i of N, set k of S), and a rest '<i>/<N> REST'; with lapGranularity 'perExercise' the work step is '<i>/<N>'. Set popups read 'SET k/S' with '<name> - <detail>'; the last set of an exercise pops 'LAST SET' with 'Next: <next exercise>' (or its own name and detail for the final exercise); perExercise keeps 'GO'. Text lines are cut to the watch's 40 characters by shortening the exercise name; the weight/plates line is capped at 36 characters so the name keeps at least 3. (Titles and popups are not part of the lap labels; a shortened name is, and compare_workout_to_plan matches such a name to the plan by prefix.) The guide's list description names the day's exercises ('Bench · Row · ...', cut at 60 characters). Per exercise: a prep step (self-paced stopwatch showing the plate breakdown if given, otherwise the weight/sets detail, plus the exercise name and live HR; a lap press starts the exercise), then with lapGranularity 'perSet' (default) each set is its own step ended by a lap press, and each rest between sets is its own step showing 'Next: set k/S' (plus, when the exercise sets restTargetHr, a heart-rate gauge up to that bpm). restMode 'countdown' (default) counts down restSec and auto-advances into the next set with a vibration; 'stopwatch' counts up and waits for a lap press. lapGranularity 'perExercise' gives one step per exercise after its prep, with no between-set rests and no per-set laps. Every prep, set and rest is its own lap and the guide ends with one extra 'Session complete' step, so a perSet session records 2 × (total sets) + 1 laps. Read them back after the workout with get_workout_laps — its labels are the step texts. Requires SUUNTO_APP_NAME to exactly match the app name registered on apizone.suunto.com. Without guideId a new guide is created on every call (see list_guides / delete_guide to tidy up); with guideId that guide is overwritten. There is no live push to the watch: it appears after the phone's next normal Suunto app sync. Returns Suunto's response (including the guide id) plus nextStep and check: { verified, note? }: after the push the guide is looked up in the guide list (by id), and verified:false with a note means the push went through but the guide was not found there — say so to the user instead of reporting success. Pushes are queued one at a time with a short pause, so several calls at once are safe. How the step titles and popups look on a real watch is not yet verified on a device. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Short session name shown in the Suunto app, e.g. 'Push A'.",
        },
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Session date YYYY-MM-DD.",
        },
        exercises: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name, e.g. 'Bench Press 15°'." },
              detail: { type: "string", minLength: 1, description: "Display string shown on the exercise's set steps, and on the prep screen before it unless 'plates' is given — include weight and sets, e.g. '60kg 3x10'." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Number of sets for this exercise." },
              restSec: {
                type: "integer",
                minimum: 1,
                description: "Rest between sets within this exercise, in seconds. With restMode 'countdown' (default) it's the countdown and auto-advance duration; with 'stopwatch' it's shown as a target label only. Not applied between exercises — that's the self-paced prep stopwatch.",
              },
              last: { type: "string", minLength: 1, maxLength: 36, description: "Optional: what was done last time, e.g. '3x8@60kg' (get_exercise_history's suggestion.last). Shown with target in a 'TODAY' popup when the exercise's prep step starts, never in the step text, so lap labels are unchanged. The hint 'Last <last> > <target>' must fit 36 characters: when it does not, last is shortened to its top reps ('10/10/10/10/8@102.5kg' becomes '10@102.5kg'), then dropped so the target stays whole, and if even that does not fit there is no popup (a number is never cut). Not yet verified on a real watch how the popup renders." },
              target: { type: "string", minLength: 1, maxLength: 36, description: "Optional: today's target, e.g. '3x8@62.5kg' (get_exercise_history's suggestion.target). See last." },
              plates: {
                type: "string",
                description: "Per-side plate breakdown for barbell exercises, e.g. '2x20+1x5/side' — shown on the prep screen instead of detail, since that's when the bar actually gets loaded. Omit for non-barbell exercises (dumbbell, machine, bodyweight, cable); compute the math yourself before calling this tool, it isn't done here.",
              },
              restTargetHr: {
                type: "integer",
                minimum: 41,
                maximum: 200,
                description: "Optional target heart rate to recover to during this exercise's rests between sets, in bpm (41-200). Adds a gauge from 40 to this value right after the live HR on every rest step of this exercise (both restModes); it is a visual target only and does not end the rest. Not shown on prep or set steps. Omit for no gauge.",
              },
            },
            required: ["name", "detail", "sets", "restSec"],
          },
        },
        restMode: {
          type: "string",
          enum: ["countdown", "stopwatch"],
          default: "countdown",
          description: "Rest between sets. 'countdown' (default): counts down from restSec and auto-advances into the next set. 'stopwatch': counts up and waits for a lap press — the user paces it. Has no effect with lapGranularity 'perExercise' (no between-set rests). Before/between exercises is always a self-paced stopwatch.",
        },
        lapGranularity: {
          type: "string",
          enum: ["perSet", "perExercise"],
          default: "perSet",
          description: "'perSet' (default, recommended): one step per set plus one per rest, so laps bound every set/rest individually — needed to read per-set HR and duration from the synced workout. 'perExercise': one step per whole exercise instead, like push_workout_guide — shorter Guide list, coarser data.",
        },
        guideId: {
          type: "string",
          description: "If provided, updates this existing guide instead of creating a new one.",
        },
      },
      required: ["title", "date", "exercises"],
    },
  },
  {
    name: "list_guides",
    description:
      "Returns all SuuntoPlus Guides (from push_workout_guide/push_interval_guide/push_strength_guide) on the user's account, newest first. Each item includes id, name, description, owner, localDate, and usage. Use the id with delete_guide, or with push_*_guide's guideId param to update an existing guide instead of creating a new one. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_guide",
    description:
      "Permanently deletes one SuuntoPlus Guide from the user's account by id. Use list_guides to find the id. This removes it from the Suunto app / apizone catalogue; it does not reach into the watch to un-pin a copy already synced there. Write operation (irreversible).",
    inputSchema: {
      type: "object",
      properties: {
        guideId: {
          type: "string",
          minLength: 1,
          description: "Guide id, from list_guides or from a previous push_*_guide response.",
        },
      },
      required: ["guideId"],
    },
  },
  {
    name: "get_upload_status",
    description:
      "Polls the processing status of a workout upload initiated by upload_workout. Returns status (e.g. 'Queued', 'Processing', 'Processed', 'Error') and the workoutKey once processing completes. Use the returned workoutKey with get_workout for full detail.",
    inputSchema: {
      type: "object",
      properties: {
        uploadId: {
          type: "string",
          minLength: 1,
          description: "Upload ID returned by upload_workout.",
        },
      },
      required: ["uploadId"],
    },
  },
  {
    name: "generate_daily_digest",
    description:
      "Builds a color-coded daily health digest (steps, sleep, recovery balance, HRV, and a training-load model) for one date and appends it as markdown to a history file. Suunto's API has no fitness/fatigue endpoints, so this computes CTL (42-day fitness), ATL (7-day fatigue), and TSB (form) from each workout's tss.trainingStressScore using standard exponential time constants, persisting the running values in a local sidecar file (SUUNTO_DIGEST_AVERAGES_PATH env var, default ~/.suunto-mcp/averages.json) since there's nowhere else to store them. Running-average baselines (all days so far) per metric are also tracked there, with a separate baseline bucket for 'party nights' (>20,000 steps) so those don't skew the normal-day average. Requires Sleep and Recovery API subscriptions on apizone for the sleep/recovery sections to populate — falls back to 'no data' text for sections without a subscription rather than erroring. Write operation (updates the sidecar file and appends to the history file).",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Calendar date YYYY-MM-DD to summarize. Use yesterday or earlier — today's data is usually partial until the watch has synced.",
        },
        seedCtl: {
          type: "number",
          description: "Only used on the very first digest ever run (no prior sidecar file). Anchors the starting Fitness (CTL) value to the number shown on the user's watch instead of cold-starting at 0. Ask the user for their watch's displayed Fitness value if this is their first digest.",
        },
        seedAtl: {
          type: "number",
          description: "Same as seedCtl but for Fatigue (ATL). Only used on the very first digest ever run.",
        },
      },
      required: ["date"],
    },
  },
];

// The tools that take a strength guide spec reuse push_strength_guide's schema (minus guideId) instead of copying it.
const strengthSpec: any = (() => {
  const { guideId: _guideId, ...properties } = (toolDefs.find((t) => t.name === "push_strength_guide")!.inputSchema as any).properties;
  return { type: "object", properties, required: ["title", "date", "exercises"] };
})();
const dateProp = (description?: string) => ({ type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", minLength: 10, maxLength: 10, ...(description ? { description } : {}) });
const specTools = [
  {
    name: "set_plan",
    description:
      "Stores the training plan as LOCAL state: a goal, optional start/end dates, phases and planned sessions per date, in ~/.suunto-mcp/plan.json (SUUNTO_PLAN_PATH overrides it). Writes only that file, never contacts Suunto, needs no Suunto credentials and NEVER pushes anything to the watch: to put a planned session on the watch, take its `guide` from get_plan and send it with push_strength_guide / push_week_plan. mode 'replace' (default) is DESTRUCTIVE to the stored plan: the call IS the whole plan (goal required; start, end, phases and sessions left out become empty) and overwrites the stored one, so clients may ask for permission; the result's `previous` is the complete plan it replaced (null when there was none), so nothing is lost and setting `previous` again undoes it. mode 'merge': goal, start, end and phases replace the stored ones when given, sessions are merged by date (a given date replaces that day's session, other dates stay; `replacedDates` lists them); a merge needs at least one field, and a first merge needs a goal. Start and end cannot be cleared in a merge (use replace). A session is { date, title, guide? } where guide is an optional push_strength_guide spec whose `date` must equal the session's. Strict: unknown fields, bad dates, from after to, sessions or phases outside start..end (when both are given), duplicate dates, and more than 20 phases / 200 sessions / 500 characters of text (100 for names and titles) / 8000 characters of guide JSON are refused with an error and nothing is written. A damaged or other-version plan file is refused, never overwritten. Result: { saved, mode, plan: { goal, start, end, phases, sessions } (counts), replacedDates, previous, note }. In demo mode the plan is kept in memory only.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", maxLength: 500, description: "The goal of the plan in the user's words, e.g. 'Sub-50 10k in January'. Required unless mode is 'merge' on an existing plan." },
        start: dateProp("First day of the plan, YYYY-MM-DD."),
        end: dateProp("Last day of the plan, YYYY-MM-DD."),
        phases: {
          type: "array",
          maxItems: 20,
          description: "Training phases. In merge mode a given list replaces the stored one.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100, description: "e.g. 'Base'." },
              from: dateProp(),
              to: dateProp(),
              focus: { type: "string", maxLength: 500, description: "What the phase is about, e.g. 'aerobic volume, 2 strength sessions'." },
            },
            required: ["name", "from", "to"],
          },
        },
        sessions: {
          type: "array",
          maxItems: 200,
          description: "Planned sessions, at most one per date.",
          items: {
            type: "object",
            properties: {
              date: dateProp(),
              title: { type: "string", minLength: 1, maxLength: 100, description: "e.g. 'Push A' or 'Easy 8 km'." },
              guide: { ...strengthSpec, description: "Optional strength guide spec for that day (the arguments of push_strength_guide without guideId). Stored only; its `date` must equal the session's." },
            },
            required: ["date", "title"],
          },
        },
        mode: { type: "string", enum: ["replace", "merge"], default: "replace", description: "'replace' (default): the call is the whole plan. 'merge': update the stored plan; sessions are merged by date." },
      },
    },
  },
  {
    name: "get_plan",
    description:
      "Reads the training plan stored by set_plan (~/.suunto-mcp/plan.json). Local file only: never contacts Suunto, needs no Suunto credentials, writes nothing. Without `date`: { today, plan: { goal, start, end, updatedAt, phases, sessions: [{ date, title, hasGuide }] }, currentPhase (the phase containing today, or null), todaySession (today's session WITH its guide spec, or null), next7Days: [{ date, session: { date, title, hasGuide } | null }] } for the 7 days AFTER today (a null session is a rest day). With `date`: { today, goal, start, end, updatedAt, date, phase, session (that day's session with its guide, or null) }. No plan yet: { today, plan: null, note }. A damaged plan file is an error naming the file. To put a planned session on the watch, pass its `guide` to push_strength_guide (or several to push_week_plan): this tool pushes nothing. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...dateProp("A single day to look up, YYYY-MM-DD. Omit for the whole plan with today and the next 7 days."), examples: ["2026-11-17"] },
      },
    },
  },
  {
    name: "get_catchup",
    description:
      "What is new since the last time the user caught up: new workouts (date, startLocal, activityId, totalTimeS, tss, guide, workoutKey), new finished nights (bedtimeStart/End, durationS, score, avgHrv, recoveryOnWaking), new recovery samples (count, latest, low, high), the plan items (from set_plan) in the review window as done / missed / pending by DATE (any workout on a planned date counts as done: the sport and the guide are not compared), and daysSinceLastSession. Toward Suunto it only reads: list calls for workouts (pages of 50, at most 4 pages per call), sleep and recovery. The first call looks back 7 days (the list calls add a margin of up to 14 hours for time zones); later calls start at the review window's first day, which is the day every section was last read completely (never more than 14 days back; anything older is reported in notes and was not looked at), and list workouts 2 days further back so a late sync is found. 'New' means after the marker kept in ~/.suunto-mcp/seen.json (SUUNTO_SEEN_PATH overrides it): workouts by key (a workout that syncs late with an earlier start is still new, once), nights by end time, recovery by sample time. Pass markSeen: true only once the user has actually been told. markSeen false (the default) is a PURE READ: nothing is written and the same call repeats the same answer. With markSeen: true each section that was read moves its marker, and `marked` is true; the review window (sleep, recovery and plan items) moves forward only when EVERY section was read (no entry in `errors`, the plan file readable, the whole workout list read), so what a failed section missed is reported next time. If there are more workouts than one call reads, `errors` says so, the call reports what it read, and calling again with markSeen: true continues below where it stopped. Plan items are reviewed from the review window's first day, so an item can show again until the window moves. A night still being recorded and naps are not reported. Output: { today, since: { from, firstCall }, newWorkouts, newNights, recovery, plan (null without a plan, { error } if the plan file is unreadable), lastSessionDate, daysSinceLastSession, markSeen, marked, errors, notes }. An unreadable seen.json is an error and is never overwritten. In demo mode the marker is kept in memory. Annotated not read-only (and idempotent: marking twice leaves the same marker) only because markSeen: true writes that small local marker, so clients may ask for permission before running it; the call itself changes nothing at Suunto.",
    inputSchema: {
      type: "object",
      properties: {
        markSeen: { type: "boolean", default: false, description: "true: move the marker to what this answer covers (do it only after telling the user). false (default): leave it, so the next call repeats this answer." },
      },
    },
  },
  {
    name: "get_tag_effects",
    description:
      "Does the night after a session with a given tag (log_session `tags`) look different from the night after a session without it? Per tag and per metric (sleepDurationS, sleepScore, hrv, recoveryMorning: the same per-night values as get_baselines) it compares the nights that followed a day with a tagged session with the nights that followed other training days, over the `days` nights ending the day before `date` (default 90, 30-180, date default today; the night that led into `date` itself may still be recording and is left out). A day without a session is a rest day and is in neither group; a session with no journal entry counts as untagged; a day with several sessions is ONE night, tagged when any of its sessions is; tags match ignoring case. Output: { date, from, to, nights, sessionDays, thresholds, journal: { entries, ignored }, tags: [{ tag, taggedSessions, taggedNights, untaggedNights, verdict, metrics: { <metric>: { nTagged, nControl (nights with a value), taggedMedian, controlMedian, medianDiff (tagged minus control), meanDiff, controlIqr, noiseThreshold, verdict } }, statement (one sentence with n, the minimum and 'an association, not a cause') }], notes, errors }, tags with most tagged nights first. HONEST VERDICTS: a metric's verdict is 'insufficient' unless there are at least 15 tagged AND 15 untagged nights with a value for it; then 'tagged-higher' / 'tagged-lower' only when |medianDiff| is LARGER than noiseThreshold = 3 * 1.25 * (controlIqr / 1.35) * sqrt(1/nTagged + 1/nControl) (3 standard errors of the difference of two medians, the spread from the untagged nights' own IQR; equal counts as within noise; compared as printed, rounded), else 'within-noise'. 4 metrics are tested per tag, so a tag's verdict is 'differs' when ANY is higher or lower ('within-noise', or 'insufficient' when all are): with no real difference a simulation flags about 9% of tags at 15 nights per group, 5% at 20 and 3% at 30, and 11% to 22% when nights are correlated 0.3, so treat one 'differs' as a lead, not a finding. It reports an ASSOCIATION in the user's own data and NEVER a cause: say so when you present it, and state n and the thresholds (they are in the result). Consecutive days are not independent samples. A session that starts after midnight counts on its own calendar day. Needs no tags to run: without any it says how to add them. Reads Suunto's workout, sleep and recovery lists (one request each) and the local journal; writes nothing. An unreadable journal file is an error. In demo mode the synthetic sessions carry the tags 'strength' and 'long-run'. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...dateProp("The day after the last night to read, YYYY-MM-DD (default today)."), examples: ["2026-11-15"] },
        days: { type: "integer", minimum: 30, maximum: 180, description: "How many nights the window covers, ending the day before `date` (default 90)." },
        tag: { type: "string", minLength: 1, maxLength: 24, description: "Only this tag (ignoring case). Omit for every tag found on a session in the window." },
      },
    },
  },
  {
    name: "archive_workouts",
    description:
      "Copies the user's workouts to local files so the history does not depend on how far back Suunto's list reaches: per workout <workoutKey>.fit (the FIT file as Suunto sent it) and <workoutKey>.json (the workout's summary from the list with its summary and intensity extensions, the FIT's size and SHA-256) in ~/.suunto-mcp/archive/ (SUUNTO_ARCHIVE_DIR moves it; files are 0600 and a folder the tool creates is 0700, an existing folder keeps its mode; each file is written complete under a temporary name and linked into place, which fails if the name exists, so not even another process can overwrite one: the folder's filesystem must support hard links). Incremental: a workout whose record exists is skipped, at most `limit` FIT files are downloaded per call (1-20, default 20, newest workouts first), and the result's `remaining` says how many are still missing: CALL AGAIN until remaining is 0, unless a note says it will not help (failed downloads are listed in `errors` and tried after the others next time). Each FIT file is checked before its record is written (non-empty, a FIT header, not shorter than the header says; the CRC is not checked); a bad download writes nothing and is reported. Only NEW files are written: nothing at Suunto is changed, and nothing is ever deleted or overwritten; a record that is damaged, of another version, filed under another key or whose FIT is missing or has another size is reported in `refused` and left as it is (the user fixes or moves it), and a FIT file already there that differs blocks that workout with an error. The record file is written last and is the mark 'archived', so an interrupted call is completed by the next one. Reads the newest 1000 workouts from the list per call (50 per request): older ones are not reachable. Output: { dir, listed, alreadyArchived, newlyArchived, archived, remaining, refused: [{ workoutKey, problem }], errors: [{ workoutKey, error }], notes }. estimate_route_time reads the archived FIT files; get_exercise_history, get_training_load and the other tools do NOT read the archive. Annotated not read-only (it writes local files), not destructive, NOT idempotent (each call archives the next batch) and open-world (it contacts Suunto). In demo mode the archive lives in memory.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Most FIT files to download in this call (default and maximum 20)." },
      },
    },
  },
  {
    name: "get_archive_status",
    description:
      "What is in the local workout archive made by archive_workouts (~/.suunto-mcp/archive/, SUUNTO_ARCHIVE_DIR moves it), from the folder alone: { dir, archived (workouts whose record and FIT file check out), fitBytes, oldest, newest (local dates of the archived workouts), problems: [{ workoutKey, problem }] (a damaged or foreign record, a missing FIT file, a FIT file whose size differs from its record: never repaired or deleted), incomplete: [{ workoutKey, problem }] (a FIT file with no record, left by an interrupted archive_workouts: not counted as archived; the next archive_workouts completes it while the workout is still listed and the download is identical), otherFiles (files in the folder that are not part of the archive, never touched), notes }. A FIT file is checked by its size against its record, not read again or re-hashed. A folder that does not exist is an empty archive and is not created. Local files only: never contacts Suunto, needs no Suunto credentials, writes nothing. It cannot say how many workouts are still missing: archive_workouts reports `remaining`. In demo mode it describes the in-memory archive. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_benchmark",
    description:
      "One repeatable session as a series over its occurrences, to see whether it is getting better: give `guide` (a guide's title, e.g. 'PUSH A': the sessions that ran it, by the guide name in the workout list) or `exercise` (the sessions that contain that exercise, as in get_exercise_history), over the `weeks` weeks (default 8, max 26) ending at `date`. It reads the guided sessions with get_exercise_history's own reader (the same local cache, the same limit of 8 uncached sessions per call, the same `pending`: CALL AGAIN until pending is 0 before drawing conclusions, and the same journal), and adds the workout list's own duration and TSS. Output: { mode, name, from, to, occurrences, sessions: [{ date, workoutKey, guide, durationS, tss (Suunto's HR-based, null when none), restEndHrMedian (median end-of-rest HR after set 1 over the session's exercises with reliable heart-rate data, rounded), exercises: [{ name (one entry per exercise per session: an exercise that appears twice is merged: heaviest block's detail, load and reps, sets added, median rest HR, reliable only if every block is; parts counts the blocks), detail, kg (the guide's label weight, or the top logged weight with loadSource 'journal'; null when none, never guessed), loadSource, reps (the planned reps per set from 'NxM' in the label; null for a range or no 'NxM'), setsDone, plannedSets, restEndHr (null when unreliable), reliable }] }] oldest first, series: { durationS, tss, restEndHrMedian, exercises: [{ name, kg, reps, restEndHr }] } where each series is { n (occurrences with a value), first, last, best (highest kg and reps, lowest duration and heart rate; null for TSS, which has no better direction), better, trend, change }, pending, errors, notes }. TREND RULE: with at least 3 values, the median of the older half is compared with the median of the newer half (floor(n/2) values each; the middle one is left out when n is odd): 'up' or 'down' when they differ by more than 3% of the older median (exactly 3% is flat), else 'flat'; change is that difference; with fewer than 3 values the trend is 'insufficient'. There is no significance test: it says what moved, not that the move is real; 'up' is not 'better' for every series (see `better`). Weights and reps are what the guide PLANNED unless a log_session entry logged weights. Writes only get_exercise_history's local cache; never changes anything at Suunto. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        guide: { type: "string", minLength: 1, maxLength: 100, description: "A guide's title as shown by list_guides or get_daily_snapshot's `guide`, e.g. 'PUSH A' (matched ignoring case, accents and punctuation). Give this or `exercise`." },
        exercise: { type: "string", minLength: 1, maxLength: 200, description: "An exercise name as in get_exercise_history's index, e.g. 'Back Squat'. Give this or `guide`." },
        weeks: { type: "integer", minimum: 1, maximum: 26, description: "How many weeks the series covers, ending at `date` (default 8)." },
        date: { ...dateProp("The last local calendar day of the range, YYYY-MM-DD (default today)."), examples: ["2026-11-15"] },
      },
    },
  },
  {
    name: "get_weekly_report",
    description:
      "A shareable report for one FINISHED Monday-to-Sunday week, assembled from the same builders as the other tools: the week's workouts (get_daily_snapshot), sleep, HRV, waking recovery and steps as the week's median against the user's own 28 days before the week (get_baselines: below / within / above the middle half), training load at the end of the week (get_training_load: CTL/ATL/TSB, the week's TSS and the week before), the guided strength sessions of the week (get_exercise_history), plan adherence (get_plan's plan: a planned date with any workout is done, else missed; no plan or no session that week says so) and tag effects (get_tag_effects, only a tag whose verdict is not 'insufficient'). `week` is the Monday of the week (default: the last full week before today); a week that has not ended yet, a date that is not a Monday and an invalid date are refused. Output: { week: { from, to }, workouts: { count, totalTimeS, kcal, tss (the sum of the sessions' tss below, the one figure the markdown's table and total use), noTss (sessions without one, counted as 0), restDays, days: [{ date, sessions: [{ startLocal, totalTimeS, tss, guide }] }] } | null, recovery: { baselineFrom, baselineTo, stepsTotal, stepsDays (days that total covers; the markdown always says 'N steps over D of 7 days'), metrics: { sleepDurationS | sleepScore | hrv | recoveryMorning | steps: { unavailable, n (days with a value), median (null below 4 days), baseline: { n, median, p25, p75 } | null, vsBaseline: 'below' | 'within' | 'above' | null } } } | null, load: { asOf, ctl, atl, tsb, rampRate7d, weekTss and previousWeekTss (the load model's own figures, which read Suunto's tss.trainingStressScore and can differ from workouts.tss; the markdown says so when they do), notes (raw, for you; the markdown gets plain sentences only), flags } | null, strength: { sessions, exercises: [{ name, sessions, lastDetail }], pending } | null, plan: { goal, planned, done, missed, adherencePct, items } | null, tagEffects: { window, tags, insufficientTags, minNightsPerGroup } | null, markdown, saved, errors, notes }. A section that fails is null and explained in errors; a section without enough data says 'insufficient data' instead of a number. `markdown` is a self-contained text meant to be shared: it holds no account id, token, workout key or file path (only the week's own numbers, the plan goal and session titles, and journal tag names), and every text the user wrote in it (guide, exercise and tag names, plan goal and titles) is escaped so it cannot add markup. Toward Suunto it only reads, about 30 requests (the strength section reads at most 8 uncached guided sessions; its `pending` says how many are left). With `save: true` it also writes the markdown to ~/.suunto-mcp/reports/week-<Monday>.md (SUUNTO_REPORTS_DIR moves it; file 0600, a folder it creates 0700): it never replaces a different existing file unless `overwrite: true` is also given (a refused save is saved.status 'refused' with the reason and the report is still returned; the same content again is 'unchanged'); `overwrite` without `save` is refused. Local files only, nothing is sent anywhere. In demo mode the markdown opens with a synthetic-data notice and a save stays in memory. Annotated not read-only (and destructive only through overwrite: true; idempotent) because save writes a local file, so clients may ask for permission; the call itself changes nothing at Suunto.",
    inputSchema: {
      type: "object",
      properties: {
        week: { ...dateProp("The Monday of the week, YYYY-MM-DD (default: the last full Monday-to-Sunday week before today). The week must be finished."), examples: ["2026-11-02"] },
        save: { type: "boolean", default: false, description: "true: also write the markdown to the reports folder as week-<Monday>.md. false (default): return it only." },
        overwrite: { type: "boolean", default: false, description: "With save: replace a DIFFERENT existing file of that name. Without it such a file is left untouched and the save is refused." },
      },
    },
  },
  {
    name: "estimate_route_time",
    description:
      "How long a saved Suunto route will take THIS user, from their own pace on hills. It reads the route's GPX (one request, as export_route) and the user's local workout archive (archive_workouts; no Suunto request for them) and fits time = flat pace x distance + extra time per metre climbed + extra time per metre descended (Naismith's rule with the three constants fitted by least squares to the 100 m pieces of the user's archived walking and hiking workouts, or running ones with activity 'running': record-level distance, altitude and time from each FIT file, pauses over 30 s left out, implausible speeds and altitude glitches dropped; the newest 25 usable ones of the 40 newest archived). It needs at least 3 usable workouts of 1 km or more, 15 km of track, 300 m of climbing and 300 m of descent together; otherwise model.status is 'insufficient' with the reason, and the estimate falls back to the generic Naismith rule (5 km/h plus 1 h per 600 m climbed, nothing for descent), labelled basis 'generic-naismith': say so to the user, it is NOT their pace (the demo archive has no altitude, so demo mode always falls back). A route without altitude on every point is estimated as flat ground, with a note. Output: { route: { name, points, distanceM, ascentM, descentM, hasElevation }, activity, basis ('personal' | 'generic-naismith'), model: { status, reason?, workoutsUsed, workoutsConsidered, skipped: { otherSport, noMotionData, unreadable }, distanceM, ascentM, descentM, flatPaceSPerKm, ascentSPerM (extra seconds per metre climbed), descentSPerM, gradeRangePct { min, max } (the steepest descent and ascent the model was fitted to), inSampleErrorPct (median error of the model against the user's own workouts' total times: fit to the past, not a forecast) }, estimate: { totalTimeS, totalTime, outsideRangeM (metres steeper than anything in the user's workouts, where the fitted pace is extrapolated: a note says so, 0 for the generic fallback), byKind: { flat | ascent | descent: { distanceM, timeS } }, splits: [{ kind, startM, distanceM, ascentM, descentM, timeS, outsideRangeM }] } (pieces at or above +3 % are ascent, at or below -3 % descent, else flat; stretches under 300 m are merged into the one before), latestStart: { sunset, marginMinutes, latestStart (in the sunset's own UTC offset), latestStartUtc, finishBy, alreadyPast } | null, assumptions, notes }. `sunset` is an ISO 8601 date-time WITH its UTC offset that the USER supplies (no sunset is looked up and nothing external is called); latestStart = sunset minus marginMinutes (default 30, 0-360) minus the estimated time; daylight after sunset is not considered. It is an ESTIMATE of moving time: no stops, weather, load, surface or fatigue. Read-only: it writes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        routeId: { type: "string", minLength: 1, description: "Route ID, e.g. from list_routes or upload_route." },
        activity: { type: "string", enum: ["walking", "running"], default: "walking", description: "Which of the user's archived workouts set the pace: 'walking' (FIT sport walking or hiking, the default) or 'running'." },
        sunset: { type: "string", minLength: 16, maxLength: 40, examples: ["2026-11-15T16:05:00+01:00"], description: "Optional: the sunset (or any finish-by time) as ISO 8601 date-time with its UTC offset, supplied by the user. Adds latestStart." },
        marginMinutes: { type: "integer", minimum: 0, maximum: 360, default: 30, description: "With sunset: minutes to be back before it (default 30)." },
      },
      required: ["routeId"],
    },
  },
  {
    name: "adjust_guide",
    description:
      "Adjusts a strength guide spec (the arguments of push_strength_guide) to how recovered the user is on `date` (default today), and RETURNS the adjusted spec with the reasons. It does not push anything: show the user the changes, and push the returned `guide` with push_strength_guide only if they agree. Reads get_baselines for `date`: HRV (metrics.hrv.latestVsBand) and recovery on waking (metrics.recoveryMorning.latestVsBand) against the user's own band of the last 28 days. Rules: neither below the band, or no reading yet -> unchanged (it never adds load or sets); one of the two below -> one set less on every exercise with 3 or more sets (the 'NxM' in detail is rewritten to match; an exercise whose detail has no matching 'NxM' keeps its sets and says so in reasons); both below -> that, plus every load in detail (the first '<n>kg', not bodyweight) 10% lower rounded to 2.5 kg, a plates breakdown is dropped when the load changed, and an exercise's `target` is dropped whenever that exercise changed at all (sets or load; a reason says so, `last` stays). Output: { level ('unchanged' | 'lighter' | 'reduced'), adjusted (whether anything changed), signals: { hrv, recoveryMorning } (below | within | above | null), reasons, changes: [{ exercise, from: { sets, detail }, to: { sets, detail } }], guide (the full adjusted spec), baselineErrors (only when a baseline section failed) }. The band is the middle half of the user's own recent days, not a medical reference. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        guide: { ...strengthSpec, description: "The strength guide spec to adjust: the same arguments as push_strength_guide (without guideId)." },
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "The day whose HRV and recovery are compared with the band, YYYY-MM-DD (default today: the night that led into it). A day with no reading yet leaves the guide unchanged.",
        },
      },
      required: ["guide"],
    },
  },
  {
    name: "push_week_plan",
    description:
      "Pushes a week of strength guides: one NEW SuuntoPlus guide per date, each built and sent exactly like push_strength_guide (same arguments per guide, without guideId; several dates coexist on the account). dryRun defaults to TRUE: then it only validates every guide (schema, unique dates, building each guide) and returns what it would push as { dryRun: true, ok, wouldPush: [{ date, title, exercises, sets }], notes } without contacting Suunto; show that to the user and call again with dryRun: false only when they agree. With dryRun false: everything is validated and built first, then the guides are pushed one after the other in date order (queued with a short pause, each read back from the guide list); the first failure stops the push, so the result is { dryRun: false, ok, pushed: [{ date, title, id, check: { verified, note? } }], failed?: { date, error }, notPushed?: [dates], notes } (ok false with failed set; say which days are missing). Pushing the same plan twice creates duplicates (list_guides / delete_guide to tidy up); to overwrite one guide use push_strength_guide with guideId. At most 14 guides. Requires SUUNTO_APP_NAME for a real push. Same delivery caveat as push_strength_guide: it appears after the phone's next normal Suunto app sync. Write operation (dryRun false).",
    inputSchema: {
      type: "object",
      properties: {
        guides: { type: "array", minItems: 1, maxItems: 14, items: strengthSpec, description: "One strength guide spec per date (dates must differ)." },
        dryRun: { type: "boolean", default: true, description: "true (default): validate only and return what would be pushed; false: push the guides." },
      },
      required: ["guides"],
    },
  },
  {
    name: "log_prediction",
    description:
      "Writes down a prediction BEFORE the fact, with a probability, in the local ledger ~/.suunto-mcp/predictions.json (SUUNTO_PREDICTIONS_PATH overrides it). Writes only that file, never contacts Suunto, needs no Suunto credentials. A prediction is immutable once logged: it cannot be edited or deleted, only voided (void_prediction, with a reason, on a day before its `date`). The server scores it itself later (score_predictions) from Suunto's data and the journal, and get_prediction_stats says whether the stated probabilities were any good. `date` is the local day the prediction is about: strictly AFTER today (the server's local date: a prediction is about the future, so today is refused too) and at most 60 days ahead. `kind` is one of: 'session_done' (a workout exists on `date`), 'hrv_in_band' (the night AFTER `date`, the one leading into the next morning, has an HRV within the user's own p25..p75 band as get_baselines shows it, edges included), 'recovery_morning_at_least' (plus `threshold`, a Balance from 0 to 1 where x100 is the watch's Resources %: the morning recovery after the night after `date` is at least that), 'reps_hit' (plus `exercise`, `sets`, `reps` and optionally `kg`: on `date`, at least that many sets reached that many reps at that weight or more; the watch records only the guide's text, so this is scored from log_session entries and can be 'unresolvable' until the sets are logged). `probability` 0 to 1 is how likely the prediction is to come true in the caller's honest judgement; `rule` optionally names the rule or skill that made it, for the per-rule statistics; `note` is free text. A prediction identical to one still open (same kind, date and kind-specific fields; probability, note and rule do not count) is refused with the id of the open one, because it would count twice in the statistics. A prediction is due, and scored, from the second day after `date` (a day's data may sync late). Unknown fields and fields that do not belong to the kind are refused. At most 2000 predictions. Output: { saved: { id, madeAt, date, kind, probability, ..., due }, predictions (the count), note }. Not read-only (writes the ledger), not destructive (adds an entry), not idempotent (the same call again adds another prediction, or is refused as a duplicate). In demo mode the ledger is kept in memory.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...dateProp("The local day the prediction is about, YYYY-MM-DD: after today, at most 60 days ahead.") },
        kind: { type: "string", enum: [...PREDICTION_KINDS], description: "What is predicted: session_done, hrv_in_band, recovery_morning_at_least or reps_hit." },
        probability: { type: "number", minimum: 0, maximum: 1, description: "How likely it is to come true, 0 to 1." },
        exercise: { type: "string", minLength: 1, maxLength: 200, description: "reps_hit: the exercise name as in get_exercise_history." },
        sets: { type: "integer", minimum: 1, maximum: 20, description: "reps_hit: how many sets are predicted to reach the reps." },
        reps: { type: "integer", minimum: 1, maximum: 200, description: "reps_hit: reps per set." },
        kg: { type: "number", minimum: 0, maximum: 1000, description: "reps_hit: the weight, in kg, at which each set is predicted to reach the reps (that or more). Leave out for any weight." },
        threshold: { type: "number", minimum: 0, maximum: 1, description: "recovery_morning_at_least: the Balance on waking, 0 to 1 (0.6 = 60% Resources)." },
        note: { type: "string", maxLength: 500, description: "Free text, e.g. why." },
        rule: { type: "string", minLength: 1, maxLength: 64, description: "The rule or skill that made the prediction, e.g. 'weekly-plan'." },
      },
      required: ["date", "kind", "probability"],
    },
  },
  {
    name: "void_prediction",
    description:
      "Voids a prediction with a reason, only on a day strictly BEFORE the prediction's `date` (once its date has begun it can no longer be voided: it will be scored whatever the caller now thinks). The prediction stays in the ledger with the reason and is never scored; get_prediction_stats counts voided predictions separately, so voiding cannot hide one. A scored prediction cannot be voided. Voiding twice changes nothing and returns the first void (alreadyVoided: true). Local file only (predictions.json): never contacts Suunto, needs no credentials. Output: { id, voided: { at, reason }, alreadyVoided }. Not read-only; annotated destructive because a void cannot be undone (nothing is removed from the file, but the prediction is out of the scoring for good); idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "The prediction's id, e.g. 'p3'." },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "Why it is withdrawn." },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "score_predictions",
    description:
      "Scores every DUE, unscored prediction in the ledger (log_prediction) as 'hit', 'miss' or 'unresolvable', and stores the outcome in ~/.suunto-mcp/predictions.json. Toward Suunto it only reads (workout list, sleep and recovery lists, laps of the guided sessions it needs; the same numbers as get_baselines and compare_workout_to_plan). Rules: session_done = a workout exists on the date; hrv_in_band = HRV of the night after the date against the user's 28-day band (get_baselines), inclusive; recovery_morning_at_least = Balance on waking after that night, at least the threshold (compared as printed, 2 decimals); reps_hit = the journal's logged sets of that exercise decide (a logged set without a weight takes the guide label's), and without logged sets only fewer set laps than predicted in a reliable per-set guide proves a miss. Only workouts that started after the prediction was made count. A reps_hit scored from a journal entry made from a confirmed draft_session_log (source 'draft') carries basis 'draft-confirmed' in its outcome; get_prediction_stats reports those apart. MISSING DATA: when a workout, or the night, is missing, the prediction stays PENDING (unscored, listed in `pending` with the reason) until the watch has synced data from a LATER day; only then is it a miss (no workout) or unresolvable (no night): a missing sync is never scored. UNRESOLVABLE means the data to decide was truly missing (no HRV that night, fewer than 7 nights for a band, nothing logged): it is never guessed and counts as neither hit nor miss. A failed request is NOT unresolvable: that prediction stays unscored, the error is in `errors`, and the next call tries again. Scored outcomes are final; an unresolvable one is read again only with rescoreUnresolvable: true (and written only if the answer changed). At most 20 predictions per call, oldest due first, NEVER-scored ones before the re-read unresolvable ones (so a call always advances through what is new): `remaining` says how many are left, call again. Calling it again with nothing newly due changes nothing and does not call Suunto. Output: { today, scored: [{ id, date, kind, result, detail }], hits, misses, unresolvable, pending: [{ id, date, kind, reason }], notDue, remaining, errors, notes }. Annotated not read-only (it writes outcomes locally), not destructive and not idempotent (each call scores the next batch); it never changes anything at Suunto. In demo mode the demo ledger is scored against the synthetic data and the outcomes stay in memory.",
    inputSchema: {
      type: "object",
      properties: {
        rescoreUnresolvable: { type: "boolean", default: false, description: "true: also read again the predictions that were 'unresolvable' (more data may have arrived, e.g. after log_session). Default false." },
      },
    },
  },
  {
    name: "get_prediction_stats",
    description:
      "How good the logged predictions were, from the local ledger only (never contacts Suunto, needs no credentials, writes nothing): overall, per kind and per `rule`: logged, n (scored: hit or miss), hits, misses, unresolvable, voided (counted apart, never scored), unscored; and, ONLY with at least 20 scored predictions in that group, hitRate, meanProbability, brier (the mean of (probability - outcome)^2; 0 is perfect; lower is better), brierBaseRate (what always saying the overall hit rate would have scored: a brier below it means the probabilities carried information) and a calibration table by stated probability (0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1: n, meanProbability, and hitRate when the bucket has at least 5). Below 20 scored the rates are null, verdict is 'insufficient' and statement says how many are missing: no claim is made. `basis` reports the predictions scored from a confirmed draft_session_log (a reps_hit whose sets began as the guide's plan) apart from all others: { draftConfirmed: { n, hits, hitRate }, other: { n, hits, hitRate } }, each hitRate shown only from 20; they still count in the overall figures. Unresolvable, voided and unscored predictions are never scored. Also: dueUnscored (call score_predictions), thresholds, recent (the 10 newest predictions with their status: hit, miss, unresolvable, void, due, open), notes. Output: { today, thresholds, dueUnscored, overall, byKind: [{ kind, ... }], byRule: [{ rule (null: none given), ... }], recent, notes }. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_experiment",
    description:
      "Starts a randomized self-experiment on one nightly outcome, e.g. 'does no caffeine after noon change my sleep score?'. It PRE-REGISTERS the hypothesis and the analysis plan (stored in the result and the file) and draws the whole schedule up front: each day from the start is an intervention day, a control day, a washout day (the `washout` days after each intervention day, never analysed) or unassigned (a weekday not in `eligible`). Eligible days are paired in order and each pair holds one intervention and one control day in random order, drawn by a seeded generator (the seed is stored; the schedule is never redrawn), so the two arms are exactly balanced; a last unpaired day is dropped. The experiment starts tomorrow unless startDate (today or later, at most 60 days ahead) says otherwise; it needs at least 6 intervention and 6 control days (the least that can ever give a verdict) or it is refused. Only one active (upcoming or running) experiment per outcome metric at a time. Outcome `metric` is the night AFTER each assigned day, one of the per-night values get_baselines and get_tag_effects use: sleepDurationS, sleepScore, hrv, recoveryMorning. Follow it with get_experiment (today's assignment) and log_experiment_day (what really happened), then analyze_experiment after the planned end. Local file ~/.suunto-mcp/experiments.json (SUUNTO_EXPERIMENTS_PATH overrides it); never contacts Suunto, needs no credentials. Output: { saved (summary), experiment: { id, name, intervention, control, metric, days, washout, eligible, startDate, endDate, seed, hypothesis, analysisPlan, schedule: [{ date, arm ('intervention' | 'control' | 'washout' | 'none'), block }], log }, note }. Not read-only (writes the file), not destructive, not idempotent (each call starts another experiment). In demo mode it is kept in memory, and a finished demo experiment is already there.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100, description: "A short name, e.g. 'No caffeine after noon'." },
        intervention: { type: "string", minLength: 1, maxLength: 500, description: "What to do on an intervention day, in plain words." },
        control: { type: "string", minLength: 1, maxLength: 500, description: "What to do on a control day, e.g. 'usual routine'." },
        metric: { type: "string", enum: [...OUTCOME_METRICS], description: "The nightly outcome: sleepDurationS, sleepScore, hrv or recoveryMorning (read for the night after each assigned day)." },
        days: { type: "integer", minimum: 14, maximum: 60, description: "How many calendar days the experiment lasts from its start." },
        eligible: { type: "array", maxItems: 7, items: { type: "string", enum: [...WEEKDAYS] }, description: "Weekdays that may carry an intervention or control day (default: every day), e.g. ['mon','tue','wed','thu']." },
        washout: { type: "integer", minimum: 0, maximum: 2, default: 0, description: "Days after each intervention day that are left out, to let carry-over pass (default 0)." },
        startDate: { ...dateProp("First day, YYYY-MM-DD (default tomorrow; today or later).") },
      },
      required: ["name", "intervention", "control", "metric", "days"],
    },
  },
  {
    name: "get_experiment",
    description:
      "Reads the experiments from ~/.suunto-mcp/experiments.json: for each one its status ('upcoming', 'running', 'finished' (past its last day) or 'stopped'), the outcome metric, the dates, and TODAY's assignment: { date, arm ('intervention' | 'control' | 'washout' | 'none', or null before the start / after the end), instruction (the text to follow today), followed (what was logged, or null) }, progress (days elapsed, planned intervention and control days) and adherence (trial days so far, how many are logged, followed, not followed, not logged, in total and per arm). With `id`, `selected` is the whole experiment: hypothesis, analysis plan, seed, the full schedule and the day log. Local file only: never contacts Suunto, needs no credentials, writes nothing. A damaged or other-version file is an error naming it. Output: { today, experiments: [summary], selected, note }. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "An experiment id, e.g. 'e1', to get its full schedule and log in `selected`." },
      },
    },
  },
  {
    name: "log_experiment_day",
    description:
      "Records what ACTUALLY happened on an experiment day: `followed` true or false (did the user do what that day's arm said), with an optional note. Only intervention and control days can be logged (not washout or unassigned days), not future days and not after the experiment was stopped. `date` defaults to today; `id` defaults to the one experiment running today (needed when none or several run). Logging a day again with a different answer keeps the earlier answer under `earlier` (nothing is lost); the same answer again changes nothing. analyze_experiment reports intention to treat (every assigned day) and per protocol (only days logged as followed), so honest logging, including false, matters. Local file only (experiments.json): never contacts Suunto, needs no credentials. Output: { id, date, arm, saved: { followed, note, loggedAt, earlier }, changed }. Not read-only, not destructive, idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "The experiment id (default: the one running today)." },
        date: { ...dateProp("The day, YYYY-MM-DD (default today; not in the future).") },
        followed: { type: "boolean", description: "true: the user did what that day's arm said. false: they did not." },
        note: { type: "string", maxLength: 500, description: "Optional, e.g. 'coffee at 15:00'." },
      },
      required: ["followed"],
    },
  },
  {
    name: "analyze_experiment",
    description:
      "Analyzes an experiment (default: the newest): the difference in MEDIANS of the outcome metric on the night after intervention days minus the night after control days, with a two-sided permutation test over the randomized pairs (the arms swapped within each pair; all swaps are enumerated up to 15 informative pairs, else 20000 random swaps with a fixed seed, so the same data always gives the same p; WITHOUT a washout the p-value is exact when the intervention does nothing, WITH a washout it is an approximation, checked by simulation in the project's tests, and `pValueBasis` says which), the effect against the same noise scale get_tag_effects uses (noiseThreshold = 3 * 1.25 * (IQR of the control nights / 1.35) * sqrt(1/nIntervention + 1/nControl), effectInStandardErrors), the nights per arm, the missing nights per arm, and a verdict. Both analyses are reported: intentionToTreat (every assigned day counts as assigned, followed or not; the PRIMARY one) and perProtocol (only days logged as followed; not protected by the randomization). verdict: 'insufficient' with fewer than 6 nights with a value in either arm (nothing is claimed; 6 is the least with which a permutation test over pairs can reach p < 0.05); 'intervention-higher' / 'intervention-lower' only when p <= 0.05 AND the median difference is larger than noiseThreshold (compared as printed); else 'no-clear-difference', which does not show there is no effect. `statement` says it in plain language, `randomized` says what was randomized and `notControlled` what was not (everything else on those days, no blinding, carry-over between nights, the watch's estimate, missing nights). Allowed only from the second day after the planned end (the last night must be recorded); before it an early look needs early: true and is flagged exploratory (exploratory: true, the statement starts with 'Exploratory'), as is a stopped experiment (analysed up to the day it was stopped). Reads Suunto's sleep list (and the recovery list for recoveryMorning), one request each, and the local file; writes nothing. A failed request is an error, never silently 'missing nights'. Output: { id, name, metric, today, status, exploratory, exploratoryReason, window: { from, through, plannedEnd }, hypothesis, verdict, statement, intentionToTreat: { nIntervention, nControl, interventionMedian, controlMedian, medianDiff, meanDiff, noiseThreshold, effectInStandardErrors, pValue, test: { method, permutations, informativePairs }, missingNights: { intervention, control }, verdict }, perProtocol (the same fields + note), adherence, randomized, pValueBasis, notControlled, thresholds, notes }. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "The experiment id (default: the newest)." },
        early: { type: "boolean", default: false, description: "true: analyze before the planned end (exploratory, flagged as such). Default false: refused until the last night is recorded." },
      },
    },
  },
  {
    name: "stop_experiment",
    description:
      "Stops an experiment with a reason, e.g. when life got in the way. Nothing is deleted: the schedule, the seed and the log stay in the file, and analyze_experiment still analyzes what was logged up to the stop date, flagged exploratory. A stop cannot be undone (annotated destructive), and a stopped experiment accepts no more day logs; it no longer blocks a new one on the same metric. An experiment past its last day cannot be stopped (analyze it). Stopping twice changes nothing. Local file only (experiments.json): never contacts Suunto, needs no credentials. Output: { id, stopped: { at, date, reason }, alreadyStopped, note }. Not read-only, destructive, idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "The experiment id, e.g. 'e1'." },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "Why it is stopped." },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "draft_session_log",
    description:
      "ZERO-LOGGING DRAFT: proposes the log_session payload for a guided gym session so the user only has to confirm it. Give `workoutKey`, or `date` for the latest guided session of that day (exactly one of the two). It reads the session's laps (the same mapping as compare_workout_to_plan; `plan` is the same optional exercises array) and its FIT file (heart-rate quality only), and builds, per exercise, the guide's text as sets x reps @ load. IMPORTANT: the watch records only the guide's PLANNED text, never the reps and weights done, so every rep count and weight in the draft is an ASSUMPTION (assumed: true) and must be confirmed or corrected by the user before anything is logged. In a per-set guide the number of sets is the number of set laps the watch recorded; in a per-exercise or workout guide the watch has one lap per exercise, so the number of sets is the plan's. It lists every deviation the watch data shows per exercise and for the session (missing, extra, short or long sets, a lap pressed during a rest, laps after 'Session complete', an unreliable mapping, a session that stopped early, missing exercises when `plan` is given) and the exact things to ask: `confirm`. A distance or time after the x ('3x40m') is not taken as reps, a missing weight is left out, never guessed. It NEVER writes anything, here or at Suunto: after the user has confirmed or corrected the draft, call log_session with `draft` (corrected) and source: 'draft'. Output: { workoutKey, date, status ('ok' | 'no-laps' | 'no-guide-labels' | 'unknown-label-format' | 'no-workout'), assumed: true, draft: { workoutKey, source: 'draft', exercises: [{ name, sets: [{ reps, kg }] }] } | null (valid arguments for log_session as they are), review: [{ n, name, detail, planned: { sets, reps, kg } | null, recordedSetLaps, proposedSets, assumed: true, mustConfirm ('reps', 'kg', 'setCount'), issues: [{ code, detail }], whyNotFilled }], sessionIssues, mapping: { format, complete, reliable, note }, hrQuality: { reliable, reasons, coverage } | null, confirm (plain sentences: what to ask the user), notes }. About 1-4 KB; downloads the FIT file (about 550 KB). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: { type: "string", minLength: 24, maxLength: 24, pattern: "^[0-9a-fA-F]{24}$", description: "The 24-character workoutKey of the session, from list_workouts or get_daily_snapshot." },
        date: { ...dateProp("Instead of workoutKey: the local date; the latest guided session (with guide laps) of that day is drafted.") },
        plan: {
          type: "array",
          minItems: 1,
          description: "Optional: what the session was meant to be, in order (the exercises array given to push_strength_guide), as for compare_workout_to_plan: adds missing, extra and reordered exercises and set counts to the issues.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name as pushed to the guide." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Planned number of sets." },
              restSec: { type: "integer", minimum: 1, description: "Planned rest between sets, in seconds." },
            },
            required: ["name"],
          },
        },
      },
    },
  },
];

// Titles + annotations live in tool-meta.ts; a tool without an entry there
// fails at startup rather than shipping unannotated.
const tools = [...toolDefs, ...specTools].map((t) => {
  const meta = TOOL_META[t.name];
  if (!meta) throw new Error(`Tool "${t.name}" has no entry in tool-meta.ts`);
  return { ...t, ...meta };
});

// Suunto's gateway answers these with 401 OperationNotFound; advertising them
// only wastes tokens and invites failed calls.
const LEGACY_TOOLS = new Set(["get_workout_samples", "export_workout_gpx", "list_subscriptions"]);
const legacyEnabled = process.env.SUUNTO_ENABLE_LEGACY_TOOLS === "1";

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: legacyEnabled ? tools : tools.filter((t) => !LEGACY_TOOLS.has(t.name)),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, any>;

  try {
    // Checked before ensureReady(): otherwise a missing-credentials error
    // masks a typo'd tool name.
    const tool = tools.find((t) => t.name === name);
    if (!tool) return text(`Unknown tool: ${name}`, true);
    if (!legacyEnabled && LEGACY_TOOLS.has(name)) {
      return text(
        `${name} is hidden: Suunto no longer serves this endpoint (OperationNotFound). This is not an authentication problem. Set SUUNTO_ENABLE_LEGACY_TOOLS=1 to re-enable it.`,
        true,
      );
    }
    // Each tool declares a full inputSchema, but the MCP SDK doesn't
    // enforce it — a call could otherwise pass e.g. limit: -1 straight
    // through to the API layer instead of being rejected up front.
    const errors = validateAgainstSchema(tool.inputSchema, a);
    if (errors.length) return text(`Invalid arguments for ${name}: ${errors.join("; ")}`, true);
    // Demo mode writes nothing: every tool that is not read-only just says what it would do.
    // push_week_plan's dry run (its default) contacts nothing by construction, so it runs for real: it validates the guides.
    const demoDryRun = name === "push_week_plan" && a.dryRun !== false;
    if (demo && !tool.annotations.readOnlyHint && !LOCAL_STATE_TOOLS.has(name) && !demoDryRun) return text(demoWriteResult(name));
    if (!NO_CREDENTIALS_TOOLS.has(name)) ensureReady();
    switch (name) {
      case "list_workouts": {
        const since = a.since ? Date.parse(a.since) : undefined;
        const until = a.until ? Date.parse(a.until) : undefined;
        const data = await suunto.listWorkouts({
          since,
          until,
          limit: a.limit ?? 25,
        });
        return text(JSON.stringify(data));
      }
      case "get_workout": {
        const data = await suunto.getWorkout(a.workoutKey);
        return text(JSON.stringify(data));
      }
      case "get_workout_samples": {
        const data = await suunto.getWorkoutSamples(a.workoutKey);
        return text(JSON.stringify(data));
      }
      case "get_workout_fit": {
        const bytes = await suunto.getWorkoutFit(a.workoutKey);
        const parsed = await parseFit(bytes);
        const out = a.full ? parsed : summarizeFit(parsed);
        // Pretty-printed on purpose: full output is ~550 KB and spills to a
        // file, and callers slice the laps (near the top) by line range.
        return text(JSON.stringify(out, null, 2));
      }
      case "get_daily_snapshot":
        return text(JSON.stringify(a.to && a.to !== a.date ? await buildSnapshotRange(suunto, a.date, a.to) : await buildSnapshot(suunto, a.date)));
      case "get_baselines":
        return text(JSON.stringify(await buildBaselines(suunto, { date: a.date, days: a.days })));
      case "get_training_load":
        return text(JSON.stringify(await buildTrainingLoad(suunto, { date: a.date, days: a.days, seedCtl: a.seedCtl, seedAtl: a.seedAtl })));
      case "forecast_training_load":
        return text(JSON.stringify(await forecastTrainingLoad(suunto, { days: a.days, asOf: a.asOf })));
      case "adjust_guide": {
        const baselines = await buildBaselines(suunto, { date: a.date ?? localDate() });
        const m: any = baselines.metrics;
        const adjusted = adjustStrengthGuide(a.guide, { hrv: m.hrv?.latestVsBand, recoveryMorning: m.recoveryMorning?.latestVsBand });
        return text(JSON.stringify({ ...adjusted, ...(baselines.errors.length ? { baselineErrors: baselines.errors } : {}) }));
      }
      case "set_plan":
        return text(JSON.stringify(await setPlan(a, planStore)));
      case "get_plan":
        return text(JSON.stringify(await getPlan(planStore, { date: a.date })));
      case "get_catchup":
        return text(JSON.stringify(await buildCatchup(suunto, seenStore, planStore, { markSeen: a.markSeen === true })));
      case "get_tag_effects":
        // demo mode has a journal of its own (the real file is never read there)
        return text(JSON.stringify(await buildTagEffects(suunto, { date: a.date, days: a.days, tag: a.tag }, demo ? { loadJournal: () => (suunto as DemoClient).demoJournal() } : {})));
      case "get_benchmark":
        return text(JSON.stringify(await buildBenchmark(suunto, { guide: a.guide, exercise: a.exercise, weeks: a.weeks, date: a.date })));
      case "get_weekly_report":
        return text(JSON.stringify(await buildWeeklyReport(suunto, { week: a.week, save: a.save === true, overwrite: a.overwrite === true }, { planStore, reportStore, demo, loadJournal: demo ? () => (suunto as DemoClient).demoJournal() : undefined })));
      case "estimate_route_time":
        return text(JSON.stringify(await estimateRouteTime(suunto, archiveStore, { routeId: a.routeId, activity: a.activity, sunset: a.sunset, marginMinutes: a.marginMinutes })));
      case "archive_workouts":
        return text(JSON.stringify(await archiveWorkouts(suunto, archiveStore, { limit: a.limit })));
      case "get_archive_status":
        return text(JSON.stringify(await archiveStatus(archiveStore)));
      case "log_prediction":
        return text(JSON.stringify(await logPrediction(a, predictionStore)));
      case "void_prediction":
        return text(JSON.stringify(await voidPrediction(a, predictionStore)));
      case "score_predictions":
        return text(JSON.stringify(await scorePredictions(suunto, predictionStore, { rescoreUnresolvable: a.rescoreUnresolvable === true }, demo ? { loadJournal: () => (suunto as DemoClient).demoJournal() } : {})));
      case "get_prediction_stats":
        return text(JSON.stringify(predictionStats(await predictionStore.load())));
      case "start_experiment":
        return text(JSON.stringify(await startExperiment(a, experimentStore)));
      case "get_experiment":
        return text(JSON.stringify(await getExperiment(experimentStore, { id: a.id })));
      case "log_experiment_day":
        return text(JSON.stringify(await logExperimentDay(a, experimentStore)));
      case "analyze_experiment":
        return text(JSON.stringify(await analyzeExperiment(suunto, experimentStore, { id: a.id, early: a.early === true })));
      case "stop_experiment":
        return text(JSON.stringify(await stopExperiment(a, experimentStore)));
      case "draft_session_log":
        return text(JSON.stringify(await buildDraft(suunto, { workoutKey: a.workoutKey, date: a.date, plan: a.plan })));
      case "push_week_plan": {
        const result = await planWeek(a.guides, {
          dryRun: a.dryRun !== false,
          appName: cfg.appName,
          validate: (g) => validateAgainstSchema(strengthSpec, g, "guide"),
          push: (zip, title) => suunto.pushGuideVerified(zip, title),
        });
        return text(JSON.stringify(result), !result.ok);
      }
      case "get_workout_laps": {
        const data = await suunto.getWorkoutWithExtensions(a.workoutKey, LAP_EXTENSIONS);
        return text(JSON.stringify(shapeLaps(data)));
      }
      case "compare_workout_to_plan": {
        const data = await suunto.getWorkoutWithExtensions(a.workoutKey, LAP_EXTENSIONS);
        return text(JSON.stringify(compareWorkout(shapeLaps(data), a.plan)));
      }
      case "get_workout_rest_profile": {
        // one after the other: the laps call also rejects a malformed key before the FIT download
        const data = await suunto.getWorkoutWithExtensions(a.workoutKey, LAP_EXTENSIONS);
        const parsed = await parseFit(await suunto.getWorkoutFit(a.workoutKey));
        return text(JSON.stringify(buildRestProfile(shapeLaps(data), parsed, a.plan)));
      }
      case "get_exercise_history":
        return text(JSON.stringify(await buildExerciseHistory(suunto, { name: a.name, weeks: a.weeks, date: a.date })));
      case "log_session":
        return text(JSON.stringify(await logSession(a)));
      case "export_workout_gpx": {
        const bytes = await suunto.getWorkoutGpx(a.workoutKey);
        return text(new TextDecoder().decode(bytes));
      }
      // Compact JSON (no indentation): identical content, 25-30% fewer bytes
      // for the model to read — a week of daily activity was ~157 KB.
      case "get_daily_activity":
        return text(JSON.stringify(await suunto.getDailyActivity(a.date)));
      case "list_daily_activity":
        return text(JSON.stringify(await suunto.listDailyActivity(a.from, a.to)));
      case "get_sleep":
        return text(JSON.stringify(await suunto.getSleep(a.date)));
      case "list_sleep":
        return text(JSON.stringify(await suunto.listSleep(a.from, a.to)));
      case "get_recovery":
        return text(JSON.stringify(await suunto.getRecovery(a.date)));
      case "list_recovery":
        return text(JSON.stringify(await suunto.listRecovery(a.from, a.to)));
      case "get_daily_activity_statistics": {
        const data = await suunto.getDailyStats(a.startdate, a.enddate);
        return text(JSON.stringify(data));
      }
      case "list_subscriptions": {
        const data = await suunto.subscriptions();
        return text(JSON.stringify(data));
      }
      case "get_route": {
        return text(JSON.stringify(await suunto.getRoute(a.routeId)));
      }
      case "list_routes": {
        const data = await suunto.listRoutes();
        return text(JSON.stringify(data));
      }
      case "export_route": {
        const bytes = await suunto.exportRoute(a.routeId);
        return text(new TextDecoder().decode(bytes));
      }
      case "upload_route": {
        const { readFile, stat } = await import("node:fs/promises");
        const filePath: string = a.filePath;
        if (extname(filePath).toLowerCase() !== ".gpx") {
          return text(`Error: upload_route only accepts .gpx files, not "${extname(filePath) || "no extension"}".`, true);
        }
        if ((await stat(filePath)).size > MAX_GPX_BYTES) {
          return text(`Error: ${filePath} is larger than ${MAX_GPX_BYTES / 1_000_000} MB; split the route into smaller files.`, true);
        }
        const gpx = await readFile(filePath);
        // A renamed non-GPX file must not be pushed to Suunto's storage.
        if (!gpx.subarray(0, 4096).toString("utf8").includes("<gpx")) {
          return text("Error: the file does not look like GPX (no <gpx> element).", true);
        }
        const { items, check } = await suunto.importRouteVerified(gpx, a.activities ?? [1]);
        const routes = items.map((r: any) => ({
          id: r.id ?? null,
          name: r.description ?? null,
          activities: r.activities ?? null,
          segments: Array.isArray(r.segments) ? r.segments.length : null,
        }));
        return text(JSON.stringify({ count: routes.length, routes, check }));
      }
      case "upload_workout": {
        const { readFile } = await import("node:fs/promises");
        const filePath: string = a.filePath;
        // Only workout files: a prompt-injected call must not be able to push
        // any other local file (keys, token files) to Suunto's storage.
        const ext = extname(filePath).toLowerCase();
        if (ext !== ".fit" && ext !== ".gpx") {
          return text(`Error: upload_workout only accepts .fit or .gpx files, not "${ext || "no extension"}".`, true);
        }
        const contentType = ext === ".gpx" ? "application/gpx+xml" : "application/octet-stream";
        const fileBytes = await readFile(filePath);
        const { uploadId, status, check } = await suunto.uploadWorkoutVerified(fileBytes, contentType, {
          description: a.description,
          comment: a.comment,
          notifyUser: false,
          privacy: a.privacy ?? "DEFAULT",
        });
        return text(JSON.stringify({ uploadId, message: "Upload initiated. Use get_upload_status to check processing.", status, check }));
      }
      case "push_workout_guide": {
        if (!cfg.appName) {
          return text(
            "Error: SUUNTO_APP_NAME is not set. Set it in the env block of your MCP client config (or in .env when running from the repo folder) with the exact app name registered on apizone.suunto.com — the Guide API rejects uploads where manifest.json's owner doesn't match.",
            true,
          );
        }
        const zip = buildGuideZip(
          { title: a.title, date: a.date, exercises: a.exercises },
          cfg.appName,
        );
        const { data, check } = await suunto.pushGuideVerified(zip, a.title, a.guideId);
        return text(
          JSON.stringify({
            ...data,
            nextStep:
              "It should appear on the watch after your phone's next normal Suunto app sync. If it doesn't, open the Suunto app > your watch > SuuntoPlus Guides and pin it manually.",
            check,
          }),
        );
      }
      case "push_interval_guide": {
        if (!cfg.appName) {
          return text(
            "Error: SUUNTO_APP_NAME is not set. Set it in the env block of your MCP client config (or in .env when running from the repo folder) with the exact app name registered on apizone.suunto.com — the Guide API rejects uploads where manifest.json's owner doesn't match.",
            true,
          );
        }
        const zip = buildIntervalGuideZip(
          { title: a.title, date: a.date, blocks: a.blocks },
          cfg.appName,
        );
        const { data, check } = await suunto.pushGuideVerified(zip, a.title, a.guideId);
        return text(
          JSON.stringify({
            ...data,
            nextStep:
              "It should appear on the watch after your phone's next normal Suunto app sync. If it doesn't, open the Suunto app > your watch > SuuntoPlus Guides and pin it manually.",
            check,
          }),
        );
      }
      case "push_strength_guide": {
        if (!cfg.appName) {
          return text(
            "Error: SUUNTO_APP_NAME is not set. Set it in the env block of your MCP client config (or in .env when running from the repo folder) with the exact app name registered on apizone.suunto.com — the Guide API rejects uploads where manifest.json's owner doesn't match.",
            true,
          );
        }
        const zip = buildStrengthGuideZip(
          {
            title: a.title,
            date: a.date,
            exercises: a.exercises,
            restMode: a.restMode,
            lapGranularity: a.lapGranularity,
          },
          cfg.appName,
        );
        const { data, check } = await suunto.pushGuideVerified(zip, a.title, a.guideId);
        return text(
          JSON.stringify({
            ...data,
            nextStep:
              "It should appear on the watch after your phone's next normal Suunto app sync. If it doesn't, open the Suunto app > your watch > SuuntoPlus Guides and pin it manually.",
            check,
          }),
        );
      }
      case "list_guides": {
        const data = await suunto.listGuides();
        return text(JSON.stringify(data));
      }
      case "delete_guide": {
        await suunto.deleteGuide(a.guideId);
        return text(JSON.stringify({ ok: true, deletedGuideId: a.guideId }));
      }
      case "get_upload_status": {
        const data = await suunto.getUploadStatus(a.uploadId);
        return text(JSON.stringify(data));
      }
      case "generate_daily_digest": {
        const result = await generateDigest({
          suunto,
          averagesPath: cfg.digestAveragesPath,
          historyPath: cfg.digestHistoryPath,
          date: a.date,
          seedCtl: a.seedCtl,
          seedAtl: a.seedAtl,
        });
        return text(result.markdown);
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (err: any) {
    return text(`Error: ${err.message ?? String(err)}`, true);
  }
});

// Every tool result passes through here, so this is the one place demo mode marks
// its output (errors stay as they are: they carry no data).
function text(s: string, isError = false) {
  return {
    content: [{ type: "text", text: demo && !isError ? markDemo(s) : s }],
    ...(isError ? { isError: true } : {}),
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(demo ? "suunto-mcp ready on stdio — DEMO MODE: synthetic data, no credentials, no network" : "suunto-mcp ready on stdio");
