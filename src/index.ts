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
import { adjustQueuePayload, adjustStrengthGuide, planWeek } from "./week-plan.js";
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
import { fileImportStore, importStatus, importWorkouts, importedSource, memoryImportStore } from "./import.js";
import { buildBenchmark } from "./benchmark.js";
import { buildWeeklyReport, fileReportStore, memoryReportStore } from "./report.js";
import { estimateRouteTime } from "./route-time.js";
import { DemoClient, DEMO_INSTRUCTIONS, DEMO_NOTICE, demoPlan, demoWriteResult, isDemo, markDemo } from "./demo.js";
import { RULES as PROPOSE_RULES, proposeNextWeek } from "./propose-week.js";
import { simulatePlan } from "./simulate-plan.js";
import { fileApprovalStore, listApprovals, memoryApprovalStore, queueAdjustment, resolveApproval, STATUS_FILTERS as APPROVAL_STATUSES } from "./approvals.js";
import { dataOverview } from "./data-overview.js";
import { aliased, requiredAliased } from "./aliases.js";

const cfg = loadConfig();
// SUUNTO_DEMO=1: synthetic data, no credentials, no network (see demo.ts).
const demo = isDemo();
const suunto = demo ? new DemoClient() : new SuuntoClient(cfg);
// Local state of set_plan / get_plan / get_catchup: in demo mode it lives in memory and never reaches the disk.
const planStore = demo ? memoryPlanStore() : filePlanStore();
const seenStore = demo ? memorySeenStore() : fileSeenStore();
// The local workout archive (archive_workouts / get_archive_status): in memory in demo mode, never on disk.
const archiveStore = demo ? memoryArchiveStore() : fileArchiveStore();
// The workouts imported from other systems (import_workouts / get_import_status): in memory in demo mode, never on disk.
const importStore = demo ? memoryImportStore() : fileImportStore();
// Where get_weekly_report saves its markdown: in memory in demo mode, never on disk.
const reportStore = demo ? memoryReportStore() : fileReportStore();
// The prediction ledger and the experiments: in memory in demo mode (seeded with deterministic demo data), never on disk.
const predictionStore = demo ? memoryPredictionStore() : filePredictionStore();
const experimentStore = demo ? memoryExperimentStore() : fileExperimentStore();
// The approval queue (queue_adjustment / list_approvals / resolve_approval): in memory in demo mode, and the push path is never called there.
const approvalStore = demo ? memoryApprovalStore() : fileApprovalStore();
if (demo) await seedDemoState(predictionStore, experimentStore);
// Not read-only (they can write local state) but they never change anything at Suunto, so demo mode runs them on the
// in-memory stores instead of answering with the generic "nothing was written" note.
const LOCAL_STATE_TOOLS = new Set(["set_plan", "get_catchup", "archive_workouts", "import_workouts", "get_weekly_report", "log_prediction", "void_prediction", "score_predictions", "start_experiment", "log_experiment_day", "stop_experiment", "queue_adjustment", "resolve_approval"]);
// These only touch local files, so they work before any Suunto credentials are set up.
const NO_CREDENTIALS_TOOLS = new Set(["set_plan", "get_plan", "get_archive_status", "import_workouts", "get_import_status", "log_prediction", "void_prediction", "get_prediction_stats", "start_experiment", "get_experiment", "log_experiment_day", "stop_experiment", "queue_adjustment", "list_approvals", "resolve_approval", "get_data_overview"]);

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
      "Recent Suunto workouts, newest first (auto-paginated up to limit). Per item: workoutKey, activityId (numeric, no sport name; get_workout_fit has session.sport), startTime (epoch ms), totalTime (s), distance/ascent/descent (m), energyConsumption (kcal), hrdata {avg, max} (max is the account's overall max HR; hrdata.workoutMaxHR is this workout's), summary/intensity extensions. Laps: get_workout_laps.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          format: "date-time",
          examples: ["2026-04-01T00:00:00Z"],
          description: "ISO 8601 lower bound on startTime (inclusive). Same as `from` (preferred); both given and different is an error.",
        },
        from: {
          type: "string",
          format: "date-time",
          examples: ["2026-04-01T00:00:00Z"],
          description: "Preferred name of `since`.",
        },
        until: {
          type: "string",
          format: "date-time",
          examples: ["2026-04-30T23:59:59Z"],
          description: "ISO 8601 upper bound on startTime (inclusive). Same as `to` (preferred); both given and different is an error.",
        },
        to: {
          type: "string",
          format: "date-time",
          examples: ["2026-04-30T23:59:59Z"],
          description: "Preferred name of `until`.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 25,
          description: "1-1000 (default 25).",
        },
      },
    },
  },
  {
    name: "get_workout",
    description:
      "Base summary of one workout (~1.6 KB): list_workouts' scalar fields plus tss, recoveryTime, extensionTypes. No laps (get_workout_laps) or records (get_workout_fit). SuuntoNotFoundError for a malformed (not 24 hex characters) or unknown workoutKey.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "24-hex id from list_workouts.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_samples",
    description:
      "DEPRECATED (hidden unless SUUNTO_ENABLE_LEGACY_TOOLS=1; outside the 1.x contract; may be removed in a later 1.x minor release). UNAVAILABLE — Suunto's API gateway currently rejects this endpoint (/v2/workout/samples) with 401 OperationNotFound on the account it was tested with (September 2026), so the call fails with an 'endpoint unavailable' error; it is not an authentication problem. Use get_workout_fit with full=true for record-level data (heart rate etc.), or get_workout_laps for laps. Kept so the tool starts working again if Suunto restores the endpoint. Read-only.",
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
      "Downloads the workout's FIT file, parsed. Default: compact summary (sport, distance, avg HR, training effect, laps as a COUNT, records_sample). full=true returns every record and lap (~550 KB for 35 laps, usually spills to a file); for laps use get_workout_laps. An unknown workoutKey fails with 403 here.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "24-hex id from list_workouts.",
        },
        full: {
          type: "boolean",
          default: false,
          description: "true: all parsed records. Default false.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_daily_snapshot",
    description:
      "One call for a day and the night before it: sleep, recovery, activity and workouts, each fetched independently (a failed section is null and explained in errors). sleep is the night that led INTO date (main = longest non-nap sleep, durations in seconds; sleeps under about 3 h are naps, so a short night has main null). recovery covers the local day (low is its lowest balance, not necessarily overnight; atBedtime is the sample nearest the main sleep's start, which falls on the previous local day, null without a main sleep or a sample within an hour). energyKcal looks like ACTIVE energy (unverified). A value is null, never 0, when Suunto has no sample. With `to`: { from, to, days, errors }. Use instead of combining get_sleep, get_recovery, get_daily_activity_statistics and list_workouts.",
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
          description: "Local day YYYY-MM-DD (first day with `to`). Today is partial until the watch syncs.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-26"],
          description: "Optional last day (inclusive, at most 14 days after `date`); one request per section for the range.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "get_baselines",
    description:
      "The user's own recent norms to judge a day against: the band of the last `days` days (default 28, ending the day BEFORE `date`) for sleepDurationS, sleepScore, hrv, recoveryMorning, recoveryLow (Balance x100 = the watch's Resources %) and steps. Sleep values come from the main sleep that led INTO each day (under about 3 h is a nap, not counted). A day without data has no value, never 0. Per metric: n, median, p25, p75 (null when n < 7), last7Median, latest (null when missing, and always for steps and recoveryLow), latestVsBand (below | within | above). The band is the user's own middle half, not a medical reference. A failing section leaves its metrics empty and is listed in errors.",
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
          description: "Local day YYYY-MM-DD being judged. Today may be incomplete.",
        },
        days: {
          type: "integer",
          minimum: 14,
          maximum: 90,
          description: "Window length in days (default 28).",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "get_training_load",
    description:
      "Fitness (CTL, 42-day), Fatigue (ATL, 7-day) and Form (TSB = CTL - ATL) day by day up to `date`, computed from each workout's TSS (0 when Suunto has none) with the standard exponential model, as in generate_daily_digest (Suunto's API has no such endpoint). CTL can be about 1 point off the watch. Without seeds the 120 days before the window warm it up; with little history CTL reads low (4-6 weeks to converge), which notes says. Result: current, weeks, series (end-of-day; tss 0 = rest day), notes. Touches no digest files.",
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
          description: "Last day of the series, YYYY-MM-DD.",
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 120,
          description: "Days covered (default 28).",
        },
        seedCtl: {
          type: "number",
          minimum: 0,
          description: "Optional: CTL at the end of the day before the series starts, read off the watch or app; skips the warm-up (a missing seed starts at 0).",
        },
        seedAtl: {
          type: "number",
          minimum: 0,
          description: "Same as seedCtl, for ATL.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "forecast_training_load",
    description:
      "Projects CTL, ATL and TSB for planned days with get_training_load's model from the end of `asOf` (default today, not in the future; to plan today pass yesterday). Give each planned day's `tss` (an easy hour is about 40-60, a hard one 80-100+); days left out are rest days; dates must be after asOf and at most 120 days out. Workouts already in the account after asOf are not read: list them in `days`. A model projection, not a prediction. Writes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "array",
          minItems: 1,
          maxItems: 120,
          description: "Planned days, one entry per date.",
          items: {
            type: "object",
            properties: {
              date: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", minLength: 10, maxLength: 10, description: "YYYY-MM-DD, after asOf." },
              tss: { type: "number", minimum: 0, maximum: 1000, description: "The day's total planned training stress." },
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
          description: "Last day counted as done, YYYY-MM-DD (default today).",
        },
      },
      required: ["days"],
    },
  },
  {
    name: "get_workout_laps",
    description:
      "Manual laps of one workout as a compact table plus training-load fields: how to read a guided gym session back set by set (push_strength_guide records a lap per set and per rest; push_workout_guide one per exercise and rest; push_interval_guide auto-advances and is expected, unverified, to record none). ~2.5 KB for 35 laps. Result: guide, tss, pte, peakEpoc, recoveryTime (units not verified), hrZoneTimeS, feeling, lapCount, checks, laps {cols, rows}. checks lists reasons not to trust positional reading: duplicate-rest, no-session-complete (ended early or watch restarted), unlabelled-laps, no-heart-rate. kind: rest (label has 'Next:'), done (final 'Session complete'), step or null. A per-set strength guide gives per exercise a prep lap, then set, rest, set, rest, ...; prep and set labels look alike, so use position and check labels, not just counts. No manual laps: lapCount 0, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "24-hex id from list_workouts; anything else fails with not-found without calling Suunto.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "compare_workout_to_plan",
    description:
      "Compares one guided gym session with its plan: maps the manual laps (as in get_workout_laps) to exercises, sets and rests and reports planned vs actual. Works for push_strength_guide and push_workout_guide sessions. The plan is read from the lap labels; pass the pushed exercises as `plan` to also check against them. baselineHr is the HR of lap 1 (the first prep), not resting HR. Result: status (ok | no-laps | no-guide-labels | unknown-label-format), reliable, note, checks, exercises (prep, sets, rests rows; columns in `cols`), deviations [{ code, basis, ex, plan, laps, detail }] (e.g. missing-set, extra-set, rest-short, ended-early, order-differs, missing-exercise). A rest row's peak is the rest lap's max HR and end its min HR (optical HR lags 20-30 s). reliable is false when checks has anything but no-heart-rate or the laps break the guide's step order; the mapping is then best effort and note says why. With restMode countdown a rest lap lasts exactly its target, so extra rest is not measurable.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "24-hex id from list_workouts; anything else fails with not-found.",
        },
        plan: {
          type: "array",
          minItems: 1,
          description: "Optional: the exercises array given to push_strength_guide or push_workout_guide, as-is (name, sets, restSec are read).",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name as pushed." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Planned sets." },
              restSec: { type: "integer", minimum: 1, description: "Planned rest between sets, seconds." },
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
      "Per-rest heart-rate recovery of one guided gym session: the FIT's record-level HR joined to the guide's lap labels (compare_workout_to_plan's mapping; a status other than 'ok' returns empty rests). Per rest: peakHr, endHr (mean of the last 5 s), dropTotal, t10S/t20S/t30S (seconds after the peak until smoothed HR first fell 10/20/30 bpm; null if never), recoveryBpmPerMin, coverage. peakHr is the highest smoothed value from 15 s before the rest to 30 s after its start (optical HR lags). Samples outside 30-230 bpm are ignored; a rest with under 5 samples returns nulls plus a note. hrQuality.reliable is false for gaps (under 80% covered), out-of-range samples (over 2%), a flat value over 180 s or frequent jumps over 40 bpm; numbers are still returned, best effort. perExercise strength guides have no rests. How the rest windows line up with the FIT timeline was not checked on a real workout (alignment.startSkewS; reliable is false beyond 10 s); whether FIT files carry SuuntoPlus developer fields is unverified. Downloads the ~550 KB FIT. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "24-hex id from list_workouts; anything else fails with not-found.",
        },
        plan: {
          type: "array",
          minItems: 1,
          description: "Optional: the exercises array given to push_strength_guide or push_workout_guide, as-is.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name as pushed." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Planned sets." },
              restSec: { type: "integer", minimum: 1, description: "Planned rest between sets, seconds." },
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
      "Progression of strength exercises across guided gym sessions: load, sets, rest and HR recovery week after week. Each session is read once and cached in ~/.suunto-mcp/cache/ (SUUNTO_CACHE=off disables it); it writes nothing but that cache and changes nothing at Suunto. Covers `weeks` (default 8, max 26) ending at `date`. At most 8 uncached sessions are read per call (newest first): `pending` is how many remain, so CALL AGAIN until pending is 0 before drawing conclusions, unless a note says it will not help. Failed sessions are skipped and listed in `errors`. IMPORTANT: the watch records only the guide's TEXT, so weights and reps are what was PLANNED; a log_session entry replaces the label's weight (loadSource 'journal'). Without `name`: an index. With `name` (ignoring case, accents, punctuation): a sessions table (kg null when unknown, never guessed; restEndHr, restT20S and the other rest columns cover the rest after set 1 only), summary and suggestion { last, target, reason }: a next target, never pushed; the load rises by a small step only when log_session shows every planned set and rep done at ONE weight, otherwise it repeats.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "Exercise name, e.g. 'Back Squat'. Omit for an index." },
        weeks: { type: "integer", minimum: 1, maximum: 26, description: "Weeks covered (default 8, max 26)." },
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "Last day of the range, YYYY-MM-DD (default today).",
        },
      },
    },
  },
  {
    name: "log_session",
    description:
      "Records what the user says ACTUALLY happened in a gym session (reps, weights, RPE, notes), because the watch only records the guide's planned text. Writes only ~/.suunto-mcp/journal.json (SUUNTO_JOURNAL_PATH overrides it); never contacts Suunto. One entry per workoutKey: logging it again REPLACES the entry (the old one is returned as `replaced`). A call with no note, feeling, tags or exercises is refused (nothing to log). Unknown fields (e.g. `weight`) are refused (unknown field error naming it); use `kg` in a set. A call with ONLY tags keeps the entry's other fields. Only record what the user told you. Limits: reps 0-200, kg 0-1000, rpe 1-10, texts 500 characters, 40 exercises with 20 sets each, 8 tags of 1-24 characters (trimmed, no control characters, no case-insensitive duplicates). source 'draft' marks an entry made from a confirmed draft_session_log.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workoutKey: { type: "string", minLength: 24, maxLength: 24, pattern: "^[0-9a-fA-F]{24}$", description: "24-hex id of the session, from list_workouts." },
        note: { type: "string", maxLength: 500, description: "How the session went, in the user's words." },
        feeling: { type: "string", maxLength: 500, description: "How the user felt, e.g. 'tired'." },
        tags: {
          type: "array",
          maxItems: 8,
          description: "Optional labels, e.g. ['deload', 'poor-sleep']. Sent alone, they set the tags and leave the rest.",
          items: { type: "string", minLength: 1, maxLength: 24 },
        },
        source: { type: "string", enum: ["draft"], description: "'draft' when the exercises come from a confirmed draft_session_log." },
        exercises: {
          type: "array",
          maxItems: 40,
          description: "What was actually done per exercise; leave out exercises that went as planned.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 500, description: "Exercise name as in get_exercise_history." },
              sets: {
                type: "array",
                maxItems: 20,
                description: "Sets in order, as done.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    reps: { type: "integer", minimum: 0, maximum: 200, description: "Reps done." },
                    kg: { type: "number", minimum: 0, maximum: 1000, description: "Weight in kg." },
                    rpe: { type: "number", minimum: 1, maximum: 10, description: "RPE 1-10." },
                  },
                },
              },
              note: { type: "string", maxLength: 500, description: "A note on this exercise." },
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
      "DEPRECATED (hidden unless SUUNTO_ENABLE_LEGACY_TOOLS=1; outside the 1.x contract; may be removed in a later 1.x minor release). UNAVAILABLE — Suunto's API gateway currently rejects this endpoint (/v2/workout/exportGpx) with 401 OperationNotFound on the account it was tested with (September 2026), so the call fails with an 'endpoint unavailable' error; it is not an authentication problem. Would return the workout's GPS route as a GPX 1.1 XML string. Kept so the tool starts working again if Suunto restores the endpoint. Read-only.",
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
      "24/7 activity samples for one local day from /247samples: { timestamp, entryData: { HR (bpm), StepCount, EnergyConsumption (joules) } }, one per 10 minutes (144 rows; 138 or 150 on clock-change days). [] when nothing synced. Needs the 24/7 Activity API subscription.",
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
          description: "Local day YYYY-MM-DD. Today and future dates return an empty or partial payload, not an error.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_daily_activity",
    description:
      "24/7 activity samples (rows as in get_daily_activity) for the local days [from, to]; days without data are absent. Daily totals: get_daily_activity_statistics. Needs the 24/7 Activity API subscription.",
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
          description: "Start date YYYY-MM-DD, inclusive.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-30"],
          description: "End date YYYY-MM-DD, inclusive. Prefer 3-7 days: a day is ~15 KB.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_sleep",
    description:
      "The sleeps of one NIGHT from /247samples. A date means the night of that date: sleeps that began between 12:00 on it and 12:00 the next day (the watch's local time), so last night is under yesterday's date and an afternoon nap belongs to the night after it. One row per sleep (longest revision kept): entryData has SleepId, IsNap, BedtimeStart/End, Duration (s), Deep/Light/REMSleepDuration (s), SleepQualityScore, AvgHRV (ms), HRAvg, HRMin (bpm). IsNap is true for sleeps under about 3 hours and can flip while recording, so it also marks a fragment of a split night: do not drop rows by IsNap alone; group rows by BedtimeStart and Duration yourself. [] when no sleep began in the window. Needs the Sleep API subscription (404 without).",
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
          description: "Date of the NIGHT, YYYY-MM-DD, not the wake-up date. Last night is under yesterday's date.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_sleep",
    description:
      "The sleeps of the nights [from, to] from /247samples, by bedtime; night-dating rule and rows as in get_sleep (IsNap caveat applies). Nights without sleep are absent. Needs the Sleep API subscription (404 without).",
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
          description: "First bedtime date YYYY-MM-DD, inclusive.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-30"],
          description: "Last bedtime date YYYY-MM-DD, inclusive. Prefer 30 days or less.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_recovery",
    description:
      "Recovery-balance samples for one local day from /247samples: entryData { Balance (0.0-1.0), StressState (0=Invalid, 1=Relaxing, 2=Active, 3=Passive, 4=Stressful) }, 48 half-hourly rows (46 or 50 on clock-change days). [] without data. Needs the Recovery API subscription (404 without).",
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
          description: "Local day YYYY-MM-DD. Today and future dates return an empty or partial payload, not an error.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_recovery",
    description:
      "Recovery-balance samples (rows as in get_recovery) for the local days [from, to]; days without data are absent. Needs the Recovery API subscription (404 without).",
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
          description: "Start date YYYY-MM-DD, inclusive.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-30"],
          description: "End date YYYY-MM-DD, inclusive. Prefer 14 days or less (~4 KB a day).",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_daily_activity_statistics",
    description:
      "Daily step count and energy (joules) from /247 for a datetime range: Name ('stepcount' | 'energyconsumption'), Sources[].Samples[] { TimeISO8601, Value }. The window must be under 28 days (exactly 28 is rejected). Null Value = no data synced. Daily samples are stamped local noon and a one-day window was seen returning that day and the next, so select by the date in TimeISO8601. `from`/`to` are the preferred names of `startdate`/`enddate`.",
    inputSchema: {
      type: "object",
      properties: {
        startdate: {
          type: "string",
          examples: ["2026-04-01T00:00:00"],
          description:
            "Start datetime ISO 8601, with or without UTC offset (+0200 is rewritten to +02:00, which Suunto requires). Same as `from` (preferred).",
        },
        enddate: {
          type: "string",
          examples: ["2026-04-27T23:59:59"],
          description:
            "End datetime, same forms, under 28 days after startdate. Same as `to` (preferred).",
        },
        from: {
          type: "string",
          examples: ["2026-04-01T00:00:00"],
          description: "Preferred name of `startdate`; both given and different is an error.",
        },
        to: {
          type: "string",
          examples: ["2026-04-27T23:59:59"],
          description: "Preferred name of `enddate`; both given and different is an error.",
        },
      },
    },
  },
  {
    name: "list_subscriptions",
    description:
      "DEPRECATED (hidden unless SUUNTO_ENABLE_LEGACY_TOOLS=1; outside the 1.x contract; may be removed in a later 1.x minor release). UNAVAILABLE — Suunto's API gateway currently rejects this endpoint (/v2/subscriptions) with 401 OperationNotFound on the account it was tested with (September 2026), so the call fails with an 'endpoint unavailable' error rather than returning a list. Would return the active webhook subscriptions as an array of { id, eventType, callbackUrl, createdAt }. Kept so the tool starts working again if Suunto restores the endpoint. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_routes",
    description:
      "The user's saved Suunto routes, at most 5: Suunto's list endpoint ignores limit/offset, so an account with more routes is NOT fully listed. Look a route up by id with get_route (ids come from upload_route, the Suunto app or the route webhook). GPX: export_route.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_route",
    description:
      "One saved Suunto route by id (activityIds, start/center/end points, totalDistance m, created/modified epoch ms, watchEnabled, ...). Works for routes list_routes does not show. Whether the route is on the watch cannot be seen here (the Suunto app's sync decides).",
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
      "Exports a saved Suunto route as a GPX 1.1 XML string (for Komoot, Strava, Garmin Connect, etc.). Get the id from list_routes.",
    inputSchema: {
      type: "object",
      properties: {
        routeId: {
          type: "string",
          minLength: 1,
          description: "Route ID from list_routes.",
        },
      },
      required: ["routeId"],
    },
  },
  {
    name: "upload_route",
    description:
      "Imports a GPX file (absolute path) as a PRIVATE route in the user's Suunto account, which can then sync to the watch. Each <rte> or <trk> becomes its own route. Activities come from the `activities` argument, NOT the GPX (default [1] = running). Queued one at a time (about 3 s each) and read back: check.verified false with a note means the import went through but the read-back did not match; say so instead of reporting success. A route cannot be deleted through this server (use the Suunto app). Needs the Route API on the subscription. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          minLength: 1,
          description: "Absolute path to the .gpx file.",
        },
        activities: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
          maxItems: 20,
          default: [1],
          description: "Suunto activity IDs (1 = running; others in Suunto's Activities.pdf). Optional.",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "upload_workout",
    description:
      "Uploads a workout file (absolute path) to the user's Suunto account. Waits up to about 20 s and returns { uploadId, status, check: { verified, note? } }: verified is true when status reaches 'Processed'; otherwise note says why (e.g. 'Error', or not finished: poll get_upload_status later). Queued one at a time. Suunto documents only .fit for this endpoint; .gpx is accepted but unverified. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          minLength: 1,
          description: "Absolute path to the .fit or .gpx file.",
        },
        description: {
          type: "string",
          description: "Short title shown in the Suunto app.",
        },
        comment: {
          type: "string",
          description: "Longer notes.",
        },
        privacy: {
          type: "string",
          enum: ["DEFAULT", "PRIVATE", "FOLLOWERS", "PUBLIC"],
          default: "DEFAULT",
          description: "Visibility. DEFAULT uses the account's setting.",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "push_workout_guide",
    description:
      "Pushes a text-step workout guide (one step per exercise, advanced by a lap press) to the user's Suunto account via the SuuntoPlus Guide Cloud API. Needs SUUNTO_APP_NAME to exactly match the app name registered on apizone.suunto.com. No live push: it appears after the phone's next Suunto app sync. For gym sessions prefer push_strength_guide. Returns Suunto's response (guide id) plus check { verified, note? }: verified:false means the guide was not found in the guide list after the push; say so instead of reporting success. Queued one at a time. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Session name shown in the Suunto app.",
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
              name: { type: "string", minLength: 1, description: "Exercise name." },
              detail: { type: "string", minLength: 1, description: "Sets/reps/weight display string, e.g. '60kg 3x10'." },
            },
            required: ["name", "detail"],
          },
        },
        guideId: {
          type: "string",
          description: "Updates this existing guide instead of creating a new one.",
        },
      },
      required: ["title", "date", "exercises"],
    },
  },
  {
    name: "push_interval_guide",
    description:
      "Pushes an interval/cardio guide (warmup, timed or distance work intervals, recoveries, repeats; segments auto-advance, optional target HR range) to the user's Suunto account via the SuuntoPlus Guide Cloud API. Needs SUUNTO_APP_NAME to exactly match the app name registered on apizone.suunto.com. No live push: it appears after the phone's next Suunto app sync. Returns Suunto's response (guide id) plus check { verified, note? }: verified:false means the guide was not found in the guide list after the push; say so instead of reporting success. Queued one at a time. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Session name shown in the Suunto app.",
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
            "Ordered blocks. times>1 repeats the block's segments as a unit; warmup and cooldown go in their own times=1 blocks.",
          items: {
            type: "object",
            properties: {
              times: {
                type: "integer",
                minimum: 1,
                default: 1,
                description: "Repeat count (omit or 1 for none).",
              },
              segments: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", minLength: 1, description: "Segment name, shown as the step title (truncated to 13 characters)." },
                    durationSec: { type: "integer", minimum: 1, description: "Auto-advance after this many seconds. Exactly one of durationSec or distanceM." },
                    distanceM: { type: "number", minimum: 1, description: "Auto-advance after this many meters. Exactly one of distanceM or durationSec." },
                    targetHrMin: { type: "integer", description: "Lower target HR (bpm). Give with targetHrMax or omit both." },
                    targetHrMax: { type: "integer", description: "Upper target HR (bpm)." },
                    notifyText: { type: "string", description: "Optional vibrate + popup text at segment start." },
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
          description: "Updates this existing guide instead of creating a new one.",
        },
      },
      required: ["title", "date", "blocks"],
    },
  },
  {
    name: "push_strength_guide",
    description:
      "Pushes a resistance-training guide to the user's Suunto account via the SuuntoPlus Guide Cloud API: the tool for gym sessions. Per exercise a self-paced prep step (a lap press starts it); with lapGranularity 'perSet' (default) each set is a step ended by a lap press, with a rest step between sets (restMode 'countdown' auto-advances after restSec; 'stopwatch' waits for a lap press); 'perExercise' gives one step per exercise, no between-set rests. Text lines are cut to the watch's 40 characters by shortening the exercise name (weight/plates line capped at 36); lap labels carry the shortened name (compare_workout_to_plan matches by prefix). The guide ends with an extra 'Session complete' step, so a perSet session records 2 x (total sets) + 1 laps (get_workout_laps). Needs SUUNTO_APP_NAME to exactly match the app name registered on apizone.suunto.com. Without guideId a NEW guide is created on every call (list_guides / delete_guide tidy up); with guideId that guide is overwritten. No live push: it appears after the phone's next Suunto app sync. Returns Suunto's response (guide id) plus check { verified, note? }: verified:false means the guide was not found in the guide list after the push; say so instead of reporting success. Queued one at a time. Titles and popups on a real watch are not yet verified. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Session name shown in the Suunto app.",
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
              name: { type: "string", minLength: 1, description: "Exercise name." },
              detail: { type: "string", minLength: 1, description: "Display string for set steps (and prep unless 'plates' is given), with weight and sets, e.g. '60kg 3x10'." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Number of sets." },
              restSec: {
                type: "integer",
                minimum: 1,
                description: "Rest between sets in seconds (countdown length; only a label in 'stopwatch' mode).",
              },
              last: { type: "string", minLength: 1, maxLength: 36, description: "Optional: last time, e.g. '3x8@60kg' (get_exercise_history suggestion.last). Shown with target in a 'TODAY' popup at prep (36 characters max: shortened, then dropped). Unverified on a real watch." },
              target: { type: "string", minLength: 1, maxLength: 36, description: "Optional: today's target, e.g. '3x8@62.5kg' (suggestion.target)." },
              plates: {
                type: "string",
                description: "Per-side plates for barbell lifts, e.g. '2x20+1x5/side', shown on prep. Compute it yourself.",
              },
              restTargetHr: {
                type: "integer",
                minimum: 41,
                maximum: 200,
                description: "Optional HR (bpm, 41-200) to recover to: a gauge on this exercise's rests, visual only.",
              },
            },
            required: ["name", "detail", "sets", "restSec"],
          },
        },
        restMode: {
          type: "string",
          enum: ["countdown", "stopwatch"],
          default: "countdown",
          description: "'countdown' (default) or 'stopwatch'. No effect with perExercise.",
        },
        lapGranularity: {
          type: "string",
          enum: ["perSet", "perExercise"],
          default: "perSet",
          description: "'perSet' (default; a lap per set and rest) or 'perExercise'.",
        },
        guideId: {
          type: "string",
          description: "Overwrites this existing guide instead of creating a new one.",
        },
      },
      required: ["title", "date", "exercises"],
    },
  },
  {
    name: "list_guides",
    description:
      "All SuuntoPlus Guides on the user's account (from the push_*_guide tools), newest first: id, name, description, owner, localDate, usage. Use the id with delete_guide or a push_*_guide's guideId.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_guide",
    description:
      "Permanently deletes one SuuntoPlus Guide from the user's account by id (from list_guides). A copy already synced to the watch is not un-pinned. Write operation (irreversible).",
    inputSchema: {
      type: "object",
      properties: {
        guideId: {
          type: "string",
          minLength: 1,
          description: "Guide id from list_guides or a push_*_guide response.",
        },
      },
      required: ["guideId"],
    },
  },
  {
    name: "get_upload_status",
    description:
      "Processing status of a workout upload from upload_workout: Queued, Processing, Processed or Error, and once processed the workoutKey.",
    inputSchema: {
      type: "object",
      properties: {
        uploadId: {
          type: "string",
          minLength: 1,
          description: "Upload ID from upload_workout.",
        },
      },
      required: ["uploadId"],
    },
  },
  {
    name: "generate_daily_digest",
    description:
      "Builds a daily health digest (steps, sleep, recovery, HRV, training-load model) for one date and appends it as markdown to a history file. Keeps running CTL/ATL and per-metric averages in a sidecar file (SUUNTO_DIGEST_AVERAGES_PATH, default ~/.suunto-mcp/averages.json). Sleep and recovery sections need those API subscriptions; without them they say 'no data'. Write operation (updates the sidecar, appends to the history).",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Day to summarize, YYYY-MM-DD. Use yesterday or earlier.",
        },
        seedCtl: {
          type: "number",
          description: "Only for the very first digest (no sidecar yet): the Fitness (CTL) shown on the watch instead of 0. Ask the user.",
        },
        seedAtl: {
          type: "number",
          description: "Same as seedCtl, for ATL.",
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
// push_strength_guide's own input check, as the approval queue and push_week_plan use it
const validateGuide = (g: unknown): string[] => validateAgainstSchema(strengthSpec, g, "guide");
const dateProp = (description?: string) => ({ type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", minLength: 10, maxLength: 10, ...(description ? { description } : {}) });
const specTools = [
  {
    name: "set_plan",
    description:
      "Stores the training plan as LOCAL state (goal, optional start/end, phases, planned sessions per date) in ~/.suunto-mcp/plan.json (SUUNTO_PLAN_PATH overrides it). Writes only that file, never contacts Suunto and NEVER pushes anything to the watch: take a session's `guide` from get_plan and send it with push_strength_guide / push_week_plan. mode 'replace' (default) is DESTRUCTIVE: the call IS the whole plan (goal required; anything left out becomes empty); `previous` in the result holds the replaced plan, so setting it again undoes the call. mode 'merge': given goal/start/end/phases replace the stored ones, sessions merge by date; at least one field is needed, a first merge needs a goal, start and end cannot be cleared. A session is { date, title, guide? } (guide = a push_strength_guide spec dated like the session). Strict: unknown fields, bad dates, items outside start..end, duplicate dates, and over 20 phases / 200 sessions / 500 characters of text (100 for names and titles) / 8000 characters of guide JSON are refused and nothing is written. A damaged or other-version plan file is refused, never overwritten. Demo mode keeps the plan in memory.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", maxLength: 500, description: "The goal in the user's words. Required unless merging into an existing plan." },
        start: dateProp("First day, YYYY-MM-DD."),
        end: dateProp("Last day, YYYY-MM-DD."),
        phases: {
          type: "array",
          maxItems: 20,
          description: "Training phases (merge: a given list replaces the stored one).",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100, description: "e.g. 'Base'." },
              from: dateProp(),
              to: dateProp(),
              focus: { type: "string", maxLength: 500, description: "What the phase is about." },
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
              guide: { ...strengthSpec, description: "Optional strength guide spec for that day (push_strength_guide's arguments without guideId); its `date` must equal the session's." },
            },
            required: ["date", "title"],
          },
        },
        mode: { type: "string", enum: ["replace", "merge"], default: "replace", description: "'replace' (default): the call is the whole plan. 'merge': update the stored plan." },
      },
    },
  },
  {
    name: "get_plan",
    description:
      "Reads the plan stored by set_plan. Local only: no Suunto call, writes nothing. Without `date`: the plan, currentPhase, todaySession (with its guide spec) and next7Days (the 7 days AFTER today; null session = rest day). With `date`: that day's phase and session. No plan: plan null. A damaged plan file is an error naming the file. Pushes nothing: pass a session's `guide` to push_strength_guide or push_week_plan.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...dateProp("One day to look up, YYYY-MM-DD. Omit for the whole plan."), examples: ["2026-11-17"] },
      },
    },
  },
  {
    name: "get_catchup",
    description:
      "What is new since the user last caught up: new workouts, finished nights, recovery samples, plan items (from set_plan) in the review window as done / missed / pending by DATE (any workout on a planned date counts as done), daysSinceLastSession. Toward Suunto it only reads. The first call looks back 7 days; later ones start at the review window's first day (at most 14 days back; older goes into notes unread). 'New' means after the marker in ~/.suunto-mcp/seen.json (SUUNTO_SEEN_PATH overrides it). markSeen false (default) is a PURE READ: nothing is written, the same call repeats the same answer. Pass markSeen: true only once the user has actually been told: it moves the markers of the sections read, but the review window moves only when EVERY section was read (no entry in `errors`); more workouts than one call reads: call again with markSeen: true. An unreadable seen.json is an error, never overwritten. A night still being recorded and naps are not reported. Demo mode keeps the marker in memory. Annotated not read-only only because markSeen: true writes that marker.",
    inputSchema: {
      type: "object",
      properties: {
        markSeen: { type: "boolean", default: false, description: "true: move the marker to what this answer covers (only after telling the user). Default false: leave it." },
      },
    },
  },
  {
    name: "get_tag_effects",
    description:
      "Does the night after a session with a given tag (log_session `tags`) look different from the night after a session without it? Per tag and metric (sleepDurationS, sleepScore, hrv, recoveryMorning) it compares nights after tagged sessions with nights after other training days, over the `days` nights ending the day before `date` (default 90, range 30-180). Rest days are in neither group; sessions without a journal entry count as untagged; several sessions in a day are ONE night. A metric is 'insufficient' unless 15+ tagged AND 15+ untagged nights have a value; then 'tagged-higher' / 'tagged-lower' only when |medianDiff| exceeds noiseThreshold (3 standard errors of the difference of medians), else 'within-noise'. A tag is 'differs' when ANY of its 4 metrics is; with no real difference about 9% of tags get flagged at 15 nights per group, 3% at 30 (11-22% with correlated nights): treat one 'differs' as a lead, not a finding. It reports an ASSOCIATION, NEVER a cause: say so, and state n and the thresholds. Reads Suunto's workout, sleep and recovery lists and the local journal; writes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...dateProp("The day after the last night read, YYYY-MM-DD (default today)."), examples: ["2026-11-15"] },
        days: { type: "integer", minimum: 30, maximum: 180, description: "Nights covered (default 90, range 30-180)." },
        tag: { type: "string", minLength: 1, maxLength: 24, description: "Only this tag (ignoring case). Omit for all tags." },
      },
    },
  },
  {
    name: "archive_workouts",
    description:
      "Copies the user's workouts to local files so history does not depend on how far back Suunto's list reaches: <workoutKey>.fit (as Suunto sent it) and <workoutKey>.json (summary, FIT size, SHA-256) in ~/.suunto-mcp/archive/ (SUUNTO_ARCHIVE_DIR moves it; files 0600; needs a filesystem with hard links). Incremental: archived workouts are skipped; at most `limit` FIT files per call (1-20, default 20, newest first); `remaining` says how many are missing: CALL AGAIN until it is 0, unless a note says it will not help (failures are in `errors`). Each FIT is checked before its record is written (non-empty, FIT header, not shorter than the header says; CRC not checked). Only NEW files are written: nothing at Suunto changes and nothing is ever deleted or overwritten; a damaged, other-version, misfiled or size-mismatched record goes to `refused` and is left alone. Reads the newest 1000 workouts per call: older ones are not reachable. estimate_route_time reads the archive; other tools do not. Demo mode keeps the archive in memory. Annotated not read-only (writes local files), not idempotent (each call archives the next batch).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Most FIT files to download this call (1-20, default 20)." },
      },
    },
  },
  {
    name: "get_archive_status",
    description:
      "What is in the local archive made by archive_workouts (~/.suunto-mcp/archive/), from the folder alone: archived count, bytes, oldest/newest, problems (damaged or foreign record, missing FIT, size mismatch: never repaired or deleted), incomplete (a FIT without a record from an interrupted run; the next archive_workouts completes it), otherFiles. Local only: no Suunto call, writes nothing. It cannot say how many workouts are still missing (archive_workouts reports `remaining`).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "import_workouts",
    description:
      "Imports workouts exported from OTHER systems (Garmin or Strava export, GPX from an Apple Watch app or any tracker) into a local store, ~/.suunto-mcp/imported/ (SUUNTO_IMPORT_DIR moves it), apart from the Suunto archive. `path` is an ABSOLUTE path to one .fit, .gpx or .tcx file or a folder (only files directly in it; no subfolders, links, hidden files, .gz or .zip: unpack first). macOS-protected folders (~/Downloads, ~/Desktop, ~/Documents) cannot be read: have the user copy the files to e.g. /tmp/workouts. Files are stored byte for byte plus a <id>.json record (SHA-256, summary; files 0600); nothing is ever overwritten or deleted. The same file again is skipped; a DIFFERENT file starting within 60 s of a stored one and lasting within 5 % of it is NOT imported but listed in possibleDuplicate. A file that is not what its extension says, is truncated, over 50 MB or fails the checks (valid timestamps not in the future, positions on the globe, GPS jumps over 12 m/s dropped (30 for cycling or unknown sport), 2+ GPS points for GPX) is listed in refused and nothing is written. A call examines at most 200 files and imports at most `limit` new ones: CALL AGAIN with `after` = nextAfter until remaining is 0. Lists show their first 50 entries (*Count fields hold totals). No Suunto call, no network. estimate_route_time also uses imported walking, hiking or running workouts (sport from a FIT session, a GPX's first track <type> (untyped files, likely including Apple Watch GPX, do not count; unverified) or a TCX Sport attribute (TCX walks and hikes do not count)). Only a FIT file's first session is read. Sleep, HRV and recovery are NOT imported; Apple Health's export.xml is not supported. Parsers verified on synthetic files only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute path to one .fit, .gpx or .tcx file, or a folder (not recursive)." },
        source: { type: "string", enum: ["garmin", "strava", "apple", "other"], default: "other", description: "Label kept in each record: garmin, strava, apple or other (default)." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Most new workouts this call (1-50, default 50)." },
        after: { type: "string", maxLength: 1024, description: "Only files sorting after this name are looked at: pass the previous call's nextAfter." },
      },
      required: ["path"],
    },
  },
  {
    name: "get_import_status",
    description:
      "What is in the local imports folder made by import_workouts (~/.suunto-mcp/imported/), from the folder alone: imported count, bySource, bytes, oldest/newest, problems (damaged, foreign or newer record, missing file, size mismatch: never repaired or deleted), incomplete (a file without a record from an interrupted import; importing it again completes it), otherFiles. Local only: no Suunto call, writes nothing, does not create a missing folder.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_benchmark",
    description:
      "One repeatable session as a series over its occurrences, to see whether it is improving: give `guide` (a guide's title, e.g. 'PUSH A') or `exercise`, over `weeks` (default 8, max 26) ending at `date`. Uses get_exercise_history's reader (same cache, limit of 8 uncached sessions per call and `pending`: CALL AGAIN until it is 0 before drawing conclusions) and adds duration and TSS. Result: sessions (oldest first) and series per metric with n, first, last, best, better, trend, change. TREND: with 3+ values the median of the older half is compared with the newer half: 'up' / 'down' beyond 3% of the older median, else 'flat'; under 3 values 'insufficient'. No significance test: it says what moved, not that the move is real, and 'up' is not 'better' for every series (see `better`). Weights and reps are what the guide PLANNED unless log_session logged weights. Writes only the history cache.",
    inputSchema: {
      type: "object",
      properties: {
        guide: { type: "string", minLength: 1, maxLength: 100, description: "A guide's title, e.g. 'PUSH A' (ignoring case, accents, punctuation). Give this or `exercise`." },
        exercise: { type: "string", minLength: 1, maxLength: 200, description: "Exercise name as in get_exercise_history's index. Give this or `guide`." },
        weeks: { type: "integer", minimum: 1, maximum: 26, description: "Weeks covered (default 8, max 26)." },
        date: { ...dateProp("Last day of the range, YYYY-MM-DD (default today)."), examples: ["2026-11-15"] },
      },
    },
  },
  {
    name: "get_weekly_report",
    description:
      "A shareable report for one FINISHED Monday-to-Sunday week, built from the other tools: workouts, sleep/HRV/recovery/steps (week median vs the user's own prior 28 days), training load, guided strength sessions, plan adherence and tag effects. `week` is the Monday (default: the last full week); an unfinished week, a non-Monday or an invalid date is refused. A failing section is null and explained in errors; one with too little data says 'insufficient data'. `markdown` is meant to be shared: no account id, token, workout key or file path, user text escaped; it does hold the plan goal, session titles and tag names, so read it before sharing. workouts.tss (sum of the sessions) can differ from load.weekTss (the load model's own figure); the markdown says so. Reads about 30 requests from Suunto. save: true also writes the markdown to ~/.suunto-mcp/reports/week-<Monday>.md (SUUNTO_REPORTS_DIR moves it; 0600): a different existing file is never replaced unless `overwrite: true` is also given (a refused save is saved.status 'refused', the report is still returned); `overwrite` without `save` is refused. Nothing is sent anywhere (demo mode: save stays in memory). Annotated not read-only (destructive only via overwrite: true) because save writes a local file.",
    inputSchema: {
      type: "object",
      properties: {
        week: { ...dateProp("The Monday of the week, YYYY-MM-DD (default: the last full week). Must be finished."), examples: ["2026-11-02"] },
        save: { type: "boolean", default: false, description: "true: also write the markdown to the reports folder. Default false." },
        overwrite: { type: "boolean", default: false, description: "With save: replace a DIFFERENT existing file of that name; otherwise it is left and the save refused." },
      },
    },
  },
  {
    name: "estimate_route_time",
    description:
      "How long a saved Suunto route will take THIS user, from their own pace on hills: reads the route's GPX (one request) and the local archive (archive_workouts; no Suunto request) and fits time = flat pace x distance + time per metre climbed + per metre descended (Naismith's rule, fitted to the newest 25 usable of the 40 newest archived walking/hiking workouts, or running ones with activity 'running'). import_workouts workouts count too (walking, hiking, running): model.workoutsUsed includes them while workoutsConsidered and skipped count the Suunto archive only. Needs 3+ usable workouts of 1 km+ with 15 km of track, 300 m climbing and 300 m descent together; otherwise model.status is 'insufficient' and the estimate is the generic Naismith rule (5 km/h plus 1 h per 600 m climbed), basis 'generic-naismith': tell the user it is NOT their pace (demo mode always falls back). A route without altitude is estimated as flat, with a note. inSampleErrorPct is fit to the past, not a forecast. `sunset` is an ISO 8601 date-time WITH UTC offset supplied by the USER (nothing is looked up); latestStart = sunset - marginMinutes - the estimate. An ESTIMATE of moving time: no stops, weather, load or fatigue.",
    inputSchema: {
      type: "object",
      properties: {
        routeId: { type: "string", minLength: 1, description: "Route ID from list_routes or upload_route." },
        activity: { type: "string", enum: ["walking", "running"], default: "walking", description: "Which archived workouts set the pace: 'walking' (walking or hiking, default) or 'running'." },
        sunset: { type: "string", minLength: 16, maxLength: 40, examples: ["2026-11-15T16:05:00+01:00"], description: "Optional: sunset (or any finish-by time), ISO 8601 with UTC offset, supplied by the user. Adds latestStart." },
        marginMinutes: { type: "integer", minimum: 0, maximum: 360, default: 30, description: "With sunset: minutes to be back before it (default 30, 0-360)." },
      },
      required: ["routeId"],
    },
  },
  {
    name: "adjust_guide",
    description:
      "Adjusts a strength guide spec (push_strength_guide's arguments) to how recovered the user is on `date` (default today) and RETURNS the adjusted spec with reasons. It pushes nothing: show the user the changes and push the returned `guide` with push_strength_guide only if they agree. Uses get_baselines (HRV and waking recovery vs the user's 28-day band). Neither below the band, or no reading yet -> unchanged (it never adds load or sets); one below -> one set less on every exercise with 3+ sets (the 'NxM' in detail is rewritten; without one the sets stay and a reason says so); both below -> that plus every load in detail (first '<n>kg') 10% lower rounded to 2.5 kg, plates dropped when the load changed, `target` dropped for changed exercises. Result: level (unchanged | lighter | reduced), signals, reasons, changes, guide, queuePayload (for queue_adjustment; null when nothing changed). The band is the user's own middle half, not a medical reference.",
    inputSchema: {
      type: "object",
      properties: {
        guide: { ...strengthSpec, description: "Strength guide spec to adjust: push_strength_guide's arguments without guideId." },
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-20"],
          description: "Day whose HRV and recovery are compared, YYYY-MM-DD (default today). No reading leaves the guide unchanged.",
        },
      },
      required: ["guide"],
    },
  },
  {
    name: "push_week_plan",
    description:
      "Pushes a week of strength guides: one NEW SuuntoPlus guide per date, built and sent like push_strength_guide (same arguments per guide, without guideId). dryRun defaults to TRUE: it only validates every guide and returns what it would push, without contacting Suunto; show that to the user and call again with dryRun: false only when they agree. With dryRun false everything is validated first, then the guides are pushed in date order (queued, each read back from the guide list); the first failure stops the push and the result lists failed and notPushed (say which days are missing). Pushing the same plan twice creates duplicates (list_guides / delete_guide tidy up; push_strength_guide with guideId overwrites one). At most 14 guides. Needs SUUNTO_APP_NAME for a real push; guides appear after the phone's next Suunto app sync. Write operation (dryRun false).",
    inputSchema: {
      type: "object",
      properties: {
        guides: { type: "array", minItems: 1, maxItems: 14, items: strengthSpec, description: "One strength guide spec per date (dates must differ)." },
        dryRun: { type: "boolean", default: true, description: "true (default): validate only. false: push the guides." },
      },
      required: ["guides"],
    },
  },
  {
    name: "log_prediction",
    description:
      "Writes down a prediction BEFORE the fact, with a probability, in the local ledger ~/.suunto-mcp/predictions.json (SUUNTO_PREDICTIONS_PATH overrides it); never contacts Suunto. Immutable: it can only be voided (void_prediction, before its `date`). score_predictions scores it later; get_prediction_stats says whether the probabilities were any good. `date`: strictly AFTER today, at most 60 days ahead. `kind`: session_done (a workout exists on `date`); hrv_in_band (the night after `date` has an HRV within the user's p25..p75 band, get_baselines); recovery_morning_at_least (plus `threshold`: waking recovery after the night after `date`); reps_hit (plus `exercise`, `sets`, `reps`, optional `kg`: at least that many sets reached that many reps at that weight or more; scored from log_session entries, so 'unresolvable' until sets are logged). `probability` is the caller's honest judgement. An identical open prediction is refused with its id. Scored from the second day after `date`. Unknown or kind-foreign fields are refused. At most 2000. Not idempotent. Demo mode keeps the ledger in memory.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...dateProp("The local day it is about, YYYY-MM-DD: after today, at most 60 days ahead.") },
        kind: { type: "string", enum: [...PREDICTION_KINDS], description: "session_done, hrv_in_band, recovery_morning_at_least or reps_hit." },
        probability: { type: "number", minimum: 0, maximum: 1, description: "0 to 1." },
        exercise: { type: "string", minLength: 1, maxLength: 200, description: "reps_hit: exercise name as in get_exercise_history." },
        sets: { type: "integer", minimum: 1, maximum: 20, description: "reps_hit: sets predicted to reach the reps." },
        reps: { type: "integer", minimum: 1, maximum: 200, description: "reps_hit: reps per set." },
        kg: { type: "number", minimum: 0, maximum: 1000, description: "reps_hit: weight in kg (that or more). Omit for any weight." },
        threshold: { type: "number", minimum: 0, maximum: 1, description: "recovery_morning_at_least: Balance on waking, 0 to 1 (0.6 = 60% Resources)." },
        note: { type: "string", maxLength: 500, description: "Free text." },
        rule: { type: "string", minLength: 1, maxLength: 64, description: "The rule or skill behind it, e.g. 'weekly-plan'." },
      },
      required: ["date", "kind", "probability"],
    },
  },
  {
    name: "void_prediction",
    description:
      "Voids a prediction with a reason, only on a day strictly BEFORE its `date` (afterwards it is scored whatever the caller now thinks). It stays in the ledger with the reason and is never scored; get_prediction_stats counts voided ones apart, so voiding cannot hide one. A scored prediction cannot be voided. Voiding twice returns the first void. Local file only. Destructive: a void cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "Prediction id, e.g. 'p3'." },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "Why it is withdrawn." },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "score_predictions",
    description:
      "Scores every DUE, unscored prediction (log_prediction) as 'hit', 'miss' or 'unresolvable' and stores the outcome in ~/.suunto-mcp/predictions.json; toward Suunto it only reads. Rules: session_done = a workout exists on the date; hrv_in_band = HRV of the night after the date within the 28-day band, inclusive; recovery_morning_at_least = waking Balance after that night at least the threshold; reps_hit = the journal's logged sets decide (without them only fewer set laps than predicted in a reliable per-set guide proves a miss). Only workouts after the prediction was made count. A missing workout or night leaves the prediction PENDING (with the reason) until the watch has synced a LATER day: a missing sync is never scored. UNRESOLVABLE (no HRV that night, under 7 nights for a band, nothing logged) is never guessed and counts as neither hit nor miss. A failed request leaves it unscored (see `errors`), retried next call. Scored outcomes are final; unresolvable ones are re-read only with rescoreUnresolvable: true. At most 20 per call, oldest first: `remaining` says how many are left. Demo mode scores a synthetic ledger in memory. Annotated not read-only (writes outcomes locally), not idempotent; nothing changes at Suunto.",
    inputSchema: {
      type: "object",
      properties: {
        rescoreUnresolvable: { type: "boolean", default: false, description: "true: also re-read 'unresolvable' predictions (more data may have arrived). Default false." },
      },
    },
  },
  {
    name: "get_prediction_stats",
    description:
      "How good the logged predictions were, from the local ledger only (no Suunto call, writes nothing): overall, per kind and per `rule`: counts and, ONLY with 20+ scored in the group, hitRate, meanProbability, brier (lower is better), brierBaseRate (a brier below it means the probabilities carried information) and a calibration table. Below 20 scored the rates are null and verdict is 'insufficient': no claim is made. `basis` reports predictions scored from a confirmed draft_session_log apart. Also dueUnscored (call score_predictions) and recent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_experiment",
    description:
      "Starts a randomized self-experiment on one nightly outcome (e.g. 'does no caffeine after noon change my sleep score?'). It PRE-REGISTERS the hypothesis and analysis plan and draws the whole schedule up front: each day is an intervention day, a control day, a washout day (`washout` days after each intervention day, never analysed) or unassigned (weekday not in `eligible`). Eligible days are paired in order, each pair holding one intervention and one control day in random order from a stored seed (never redrawn); a last unpaired day is dropped. Starts tomorrow unless startDate (today or later, at most 60 days ahead) says otherwise; needs 6+ intervention and 6+ control days or it is refused. One active experiment per metric. `metric` is read for the night AFTER each assigned day. Then get_experiment, log_experiment_day, and analyze_experiment after the planned end. Local file ~/.suunto-mcp/experiments.json (SUUNTO_EXPERIMENTS_PATH overrides it); no Suunto call. Not idempotent (each call starts another experiment). Demo mode keeps it in memory.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100, description: "Short name, e.g. 'No caffeine after noon'." },
        intervention: { type: "string", minLength: 1, maxLength: 500, description: "What to do on an intervention day." },
        control: { type: "string", minLength: 1, maxLength: 500, description: "What to do on a control day, e.g. 'usual routine'." },
        metric: { type: "string", enum: [...OUTCOME_METRICS], description: "Nightly outcome: sleepDurationS, sleepScore, hrv or recoveryMorning." },
        days: { type: "integer", minimum: 14, maximum: 60, description: "Calendar days the experiment lasts." },
        eligible: { type: "array", maxItems: 7, items: { type: "string", enum: [...WEEKDAYS] }, description: "Weekdays that may carry an intervention or control day (default all), e.g. ['mon','tue']." },
        washout: { type: "integer", minimum: 0, maximum: 2, default: 0, description: "Days after each intervention day left out (default 0)." },
        startDate: { ...dateProp("First day, YYYY-MM-DD (default tomorrow).") },
      },
      required: ["name", "intervention", "control", "metric", "days"],
    },
  },
  {
    name: "get_experiment",
    description:
      "Reads the experiments in ~/.suunto-mcp/experiments.json: status (upcoming, running, finished, stopped), metric, dates, TODAY's assignment (arm intervention | control | washout | none, instruction, followed), progress and adherence. With `id`, `selected` is the whole experiment (hypothesis, analysis plan, seed, schedule, day log). Local file only: no Suunto call, writes nothing. A damaged or other-version file is an error naming it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "Experiment id, e.g. 'e1', for the full schedule and log." },
      },
    },
  },
  {
    name: "log_experiment_day",
    description:
      "Records what ACTUALLY happened on an experiment day: `followed` true or false (did the user do what that day's arm said), optional note. Only intervention and control days can be logged, not future days, not after a stop. `date` defaults to today; `id` defaults to the one experiment running today (required when none or several run). Logging a day again with a different answer keeps the earlier one under `earlier`. analyze_experiment reports intention to treat and per protocol, so honest logging, including false, matters. Local file only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "Experiment id (default: the one running today)." },
        date: { ...dateProp("The day, YYYY-MM-DD (default today; not in the future).") },
        followed: { type: "boolean", description: "true: the user did what that day's arm said. false: not." },
        note: { type: "string", maxLength: 500, description: "Optional." },
      },
      required: ["followed"],
    },
  },
  {
    name: "analyze_experiment",
    description:
      "Analyzes an experiment (default: the newest): the difference in MEDIANS of the outcome on the night after intervention days minus after control days, with a two-sided permutation test over the randomized pairs (deterministic; exact WITHOUT a washout, approximate WITH one: `pValueBasis`) and the effect against get_tag_effects' noiseThreshold. intentionToTreat (every assigned day) is the PRIMARY analysis; perProtocol (followed days only) is not protected by the randomization. verdict: 'insufficient' with under 6 nights with a value in either arm (nothing is claimed); 'intervention-higher' / 'intervention-lower' only when p <= 0.05 AND the median difference exceeds noiseThreshold; else 'no-clear-difference', which does not show there is no effect. `statement`, `randomized` and `notControlled` say it in plain language. Allowed only from the second day after the planned end; earlier needs early: true and is flagged exploratory, as is a stopped experiment. Reads Suunto's sleep list (and recovery for recoveryMorning) and the local file; writes nothing. A failed request is an error, never silently 'missing nights'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "Experiment id (default: the newest)." },
        early: { type: "boolean", default: false, description: "true: analyze before the planned end (flagged exploratory). Default false." },
      },
    },
  },
  {
    name: "stop_experiment",
    description:
      "Stops an experiment with a reason. Nothing is deleted: schedule, seed and log stay, and analyze_experiment still analyzes what was logged up to the stop date, flagged exploratory. A stop cannot be undone (destructive); a stopped experiment accepts no more day logs and no longer blocks a new one on the same metric. An experiment past its last day cannot be stopped (analyze it). Stopping twice changes nothing. Local file only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "Experiment id, e.g. 'e1'." },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "Why it is stopped." },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "draft_session_log",
    description:
      "ZERO-LOGGING DRAFT: proposes the log_session payload for a guided gym session so the user only confirms it. Give `workoutKey`, or `date` for the latest guided session of that day (exactly one). It reads the laps (compare_workout_to_plan's mapping; `plan` as there) and the FIT's HR quality, and builds per exercise sets x reps @ load from the guide's text. IMPORTANT: the watch records only the guide's PLANNED text, never reps and weights done, so every rep count and weight in the draft is an ASSUMPTION (assumed: true) the user must confirm or correct before anything is logged. Per-set guides: the set count is the number of set laps; per-exercise and workout guides: the plan's. It lists every deviation and what to ask (`confirm`). A distance or time after the x ('3x40m') is not taken as reps; a missing weight is left out, never guessed. It NEVER writes anything: after the user confirms or corrects the draft, call log_session with it and source: 'draft'. Downloads the ~550 KB FIT.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: { type: "string", minLength: 24, maxLength: 24, pattern: "^[0-9a-fA-F]{24}$", description: "24-hex id of the session." },
        date: { ...dateProp("Instead of workoutKey: the local date; the latest guided session of that day is drafted.") },
        plan: {
          type: "array",
          minItems: 1,
          description: "Optional: the exercises array given to push_strength_guide, as for compare_workout_to_plan.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, description: "Exercise name as pushed." },
              sets: { type: "integer", minimum: 1, maximum: 100, description: "Planned sets." },
              restSec: { type: "integer", minimum: 1, description: "Planned rest, seconds." },
            },
            required: ["name"],
          },
        },
      },
    },
  },
  {
    name: "propose_next_week",
    description:
      "Proposes next week's strength sessions from the stored plan (set_plan), what the journal says the user ACTUALLY lifted (log_session) and how recovered they are. Writes and pushes NOTHING: show the proposal to the user; to queue it pass `queuePayload` to queue_adjustment (nothing reaches the watch until resolve_approval). predict: true also returns a log_prediction payload per increase (never logged here). Repeats the latest guided plan week one week on (weekStart: a Monday after today, default next Monday). Loads follow NAMED rules in `rulesUsed` (`rules` overrides some within stated ranges; unknown names refused): PROGRESS when the lift's latest logged session hit every planned rep at one weight (+ one step: at most incrementKg 2.5 kg, 5% of the load, at least 1.25 kg); HOLD on other evidence; DELOAD (deloadPct 10%) after stallSessions (2) logged misses in a row, or when today's TSB is below tsbDeloadBelow (-25), or when HRV and waking recovery are both below the user's band. NEVER raises a load without evidence: no log_session entry for the plan's sets x reps, HRV or recovery below the band, or an unread history means no increase; a lift whose detail has no kg or 'NxM' is untouched. status 'insufficient' (`missing` says why) with no plan, no guided session, under 2 logged sessions in 8 weeks or no usable lift. Result: sessions (for set_plan merge), guides (for push_week_plan), changes with reasons, forecast, risk (heuristic: forecast TSB below -30, or week TSS over 30% above the 4-week average), queuePayload. MODEL-BASED: projections and rule outputs, not predictions of how the user will respond.",
    inputSchema: {
      type: "object",
      properties: {
        predict: { type: "boolean", default: false, description: "true: also return a log_prediction payload per proposed increase (never logged here). Default false." },
        weekStart: { ...dateProp("The Monday the week starts on, YYYY-MM-DD; after today. Default: next Monday."), examples: ["2026-11-16"] },
        rules: {
          type: "object",
          description: "Optional overrides of the named rules (unknown names are refused), each a number inside its stated range.",
          properties: Object.fromEntries(
            Object.entries(PROPOSE_RULES).map(([name, def]) => [name, { type: "integer" in def && def.integer ? "integer" : "number", minimum: def.min, maximum: def.max, default: def.default, description: def.text }]),
          ),
        },
      },
    },
  },
  {
    name: "simulate_plan",
    description:
      "A WHAT-IF for a candidate week or multi-week plan: its effect on Fitness (CTL), Fatigue (ATL) and Form (TSB) day by day before the user commits. READ-ONLY, keeps no state. `sessions`: [{ date, tss?, title?, guide? }], each after `asOf` (default today; at most 120 days ahead); several on a date add up. TSS is the given `tss`, else the median of the user's own sessions with the same title (or guide.title) in the last 90 days (2+ needed); with no estimate the call is REFUSED and asks for `tss` (never a guess). propose_next_week's `sessions` fit as they are. Optional `goalDate` (TSB that day vs the fresh band 5-25) and `compare` (a second plan over the same days). Same model as forecast_training_load (CTL can be about 1 point off the watch). risks: a day with TSB below -30, or a full week whose CTL rises by over 8 or whose TSS is over 30% above the previous 28-day average (heuristics with contested evidence, not safe/unsafe lines). personalResponse is the user's OWN history (next-night HRV and recovery after high-load days vs others, by get_tag_effects' rule, 15+ nights each; else 'insufficient') and responseToPlan claims a shift ONLY where history differed beyond noise: an association, not a cause. EVERY number is MODEL-BASED, never a prediction of how the user will feel. An unreadable section is named in errors instead of failing the call.",
    inputSchema: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          description: "The candidate plan, one entry per session.",
          items: {
            type: "object",
            properties: {
              date: { ...dateProp("YYYY-MM-DD, after asOf.") },
              title: { type: "string", minLength: 1, maxLength: 100, description: "e.g. 'PUSH A': TSS is estimated from the user's sessions of that title when `tss` is missing." },
              tss: { type: "number", minimum: 0, maximum: 1000, description: "Training stress in get_training_load's unit (easy hour about 40-60, hard 80-100+). Overrides any estimate." },
              guide: { type: "object", description: "Optional strength guide spec; its `title` feeds the TSS estimate, its `date` must equal the session's.", properties: { title: { type: "string" }, date: { ...dateProp() } } },
            },
            required: ["date"],
          },
        },
        goalDate: { ...dateProp("Optional race or test day, YYYY-MM-DD, after asOf: the result gives TSB that day."), examples: ["2026-12-06"] },
        asOf: { ...dateProp("Last day counted as done (default today). The simulation starts the day after.") },
        compare: {
          type: "object",
          description: "Optional second candidate plan over the same days.",
          properties: {
            sessions: { type: "array", minItems: 1, maxItems: 200, description: "Same shape as sessions.", items: { type: "object", properties: { date: { ...dateProp() }, title: { type: "string", minLength: 1, maxLength: 100 }, tss: { type: "number", minimum: 0, maximum: 1000 }, guide: { type: "object" } }, required: ["date"] } },
            label: { type: "string", maxLength: 100, description: "Name for the compared plan." },
          },
          required: ["sessions"],
        },
      },
      required: ["sessions"],
    },
  },
  {
    name: "queue_adjustment",
    description:
      "Stores a prepared change in the local APPROVAL QUEUE (~/.suunto-mcp/approvals.json, SUUNTO_APPROVALS_PATH moves it; 0600) so the user can decide later. Writes only that file, never contacts Suunto and NEVER pushes anything: nothing reaches the watch unless the user approves with resolve_approval (decision approve AND push: true in the same call). `kind` 'adjusted_guide': `payload` is push_strength_guide's exact arguments (adjust_guide's `guide`; a guideId is refused); 'week_plan': `payload` is { guides } (propose_next_week's `guides`). The payload is validated as the push tool does (schema, then each guide built as a dry run); one that would not pass is refused and nothing is stored. `forDate` is the guide's day (the earliest for a week_plan): omit it or pass exactly that date; a guide dated before today is refused. `expiresAt` (ISO 8601) defaults to the end of forDate in server local time; earlier is allowed, later never. A `queuePayload` from propose_next_week or adjust_guide goes in as it is. At most 1000 approvals; none is deleted automatically. Demo mode keeps the queue in memory.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["adjusted_guide", "week_plan"], description: "adjusted_guide (one strength guide) or week_plan ({ guides })." },
        payload: { type: "object", description: "The exact arguments of the push tool: a guide spec for adjusted_guide, { guides: [...] } for week_plan." },
        forDate: { ...dateProp("Optional: must equal the guide's own date (the earliest for a week_plan), the default.") },
        reasons: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 }, description: "Short sentences shown with the approval." },
        source: { type: "string", maxLength: 64, description: "Where it came from, e.g. 'adjust_guide' (default 'manual')." },
        expiresAt: { type: "string", format: "date-time", description: "ISO 8601 moment after which it can no longer be approved; at most the end of forDate." },
      },
      required: ["kind", "payload"],
    },
  },
  {
    name: "list_approvals",
    description:
      "Lists the approval queue (filled by queue_adjustment) from the local file only: no Suunto call, writes nothing. Status: pending, expired (not decided before expiresAt: can no longer be approved, can still be rejected), approved, rejected. `status` filters; with `id` the item in full: `payload`, `call` (the DRY-RUN form, push_week_plan with dryRun true: never a ready real push) and `howToPush`.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...APPROVAL_STATUSES], default: "all", description: "pending, expired, done (approved or rejected) or all (default)." },
        id: { type: "string", minLength: 2, maxLength: 20, description: "One approval's id, e.g. 'a3', for the full item." },
      },
    },
  },
  {
    name: "resolve_approval",
    description:
      "The user's decision on one queued approval, and THE ONE PLACE where an explicit yes becomes a push to the watch. 'reject': recorded, nothing is pushed. 'approve': recorded; the result carries the `payload`, a DRY-RUN `call` and `howToPush`; nothing is pushed unless `push: true` is passed in the SAME call, which pushes one new strength guide (adjusted_guide) or, for week_plan, does a DRY RUN unless `dryRun: false` is also passed (a real week push stops at the first failure and is never retried automatically: days already pushed would be duplicated). `push: true` with reject is refused. An EXPIRED item cannot be approved or pushed (it can be rejected), nor can a guide dated before today. Resolving a resolved item returns the first result (`alreadyResolved`) and never pushes twice; an item approved without push can still be pushed once, so this tool is NOT idempotent. A failed push records nothing and can be retried. Real pushes need SUUNTO_APP_NAME and credentials; guides appear after the phone's next Suunto app sync. Demo mode: push: true NEVER calls the push path. Writes the decision locally and may push; a push only creates new guides.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 20, description: "Approval id from list_approvals, e.g. 'a3'." },
        decision: { type: "string", enum: ["approve", "reject"], description: "approve: the user said yes. reject: the user said no (nothing is pushed)." },
        note: { type: "string", maxLength: 500, description: "Optional remark, stored with the decision." },
        push: { type: "boolean", default: false, description: "true (with approve only): also push now. Default false: record the decision and return the call to make. Pass it only when the user has said to push." },
        dryRun: { type: "boolean", description: "week_plan with push: true only: true (default) validates and sends nothing; false pushes for real." },
      },
      required: ["id", "decision"],
    },
  },
  {
    name: "get_data_overview",
    description:
      "Every local file the server keeps, in one look, with no Suunto call and no credentials: journal, plan, catch-up marker, prediction ledger, experiments, approval queue (path, status, version, size, mode, counts) and the cache, archive and reports folders. status: ok, missing, unreadable, damaged, foreign (not a suunto-mcp file of that kind), newer-version (refused, left untouched) or in-memory (demo). `modeWarning` flags a file not 0600 (or a folder not 0700). Nothing is modified, created or repaired.",
    inputSchema: { type: "object", properties: {} },
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
        const sinceRaw = aliased(a, "from", "since") as string | undefined;
        const untilRaw = aliased(a, "to", "until") as string | undefined;
        const since = sinceRaw ? Date.parse(sinceRaw) : undefined;
        const until = untilRaw ? Date.parse(untilRaw) : undefined;
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
        return text(JSON.stringify({ ...adjusted, queuePayload: adjustQueuePayload(adjusted), ...(baselines.errors.length ? { baselineErrors: baselines.errors } : {}) }));
      }
      case "set_plan":
        return text(JSON.stringify(await setPlan(a, planStore)));
      case "get_plan":
        return text(JSON.stringify(await getPlan(planStore, { date: a.date })));
      case "get_catchup":
        return text(JSON.stringify(await buildCatchup(suunto, seenStore, planStore, { markSeen: a.markSeen === true }, new Date(), approvalStore)));
      case "get_tag_effects":
        // demo mode has a journal of its own (the real file is never read there)
        return text(JSON.stringify(await buildTagEffects(suunto, { date: a.date, days: a.days, tag: a.tag }, demo ? { loadJournal: () => (suunto as DemoClient).demoJournal() } : {})));
      case "get_benchmark":
        return text(JSON.stringify(await buildBenchmark(suunto, { guide: a.guide, exercise: a.exercise, weeks: a.weeks, date: a.date })));
      case "get_weekly_report":
        return text(JSON.stringify(await buildWeeklyReport(suunto, { week: a.week, save: a.save === true, overwrite: a.overwrite === true }, { planStore, reportStore, demo, loadJournal: demo ? () => (suunto as DemoClient).demoJournal() : undefined })));
      case "estimate_route_time":
        return text(JSON.stringify(await estimateRouteTime(suunto, archiveStore, { routeId: a.routeId, activity: a.activity, sunset: a.sunset, marginMinutes: a.marginMinutes }, { imported: await importedSource(importStore) })));
      case "archive_workouts":
        return text(JSON.stringify(await archiveWorkouts(suunto, archiveStore, { limit: a.limit })));
      case "get_archive_status":
        return text(JSON.stringify(await archiveStatus(archiveStore)));
      case "import_workouts":
        return text(JSON.stringify(await importWorkouts(importStore, { path: a.path, source: a.source, limit: a.limit, after: a.after })));
      case "get_import_status":
        return text(JSON.stringify(await importStatus(importStore)));
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
      case "propose_next_week":
        // demo mode: the lifts it logged and the programme's plan are generated (nothing is read from or written to the disk there)
        return text(JSON.stringify(await proposeNextWeek(suunto, planStore, a, { predictions: predictionStore, ...(demo ? { journal: await (suunto as DemoClient).demoLiftJournal(), demoPlan } : {}) })));
      case "queue_adjustment":
        return text(JSON.stringify(await queueAdjustment(a, approvalStore, { validate: validateGuide })));
      case "list_approvals":
        return text(JSON.stringify(await listApprovals(approvalStore, { status: a.status, id: a.id })));
      case "resolve_approval": {
        // the one place a user's yes becomes a push: decision approve AND push: true, in the same call
        if (a.push === true && a.decision === "approve" && !demo) ensureReady();
        return text(JSON.stringify(await resolveApproval(a, approvalStore, { demo, appName: cfg.appName, validate: validateGuide, push: (zip, title) => suunto.pushGuideVerified(zip, title) })));
      }
      case "get_data_overview":
        return text(
          JSON.stringify(
            await dataOverview(
              demo
                ? {
                    journal: { entries: await (suunto as DemoClient).demoJournal() },
                    plan: (await planStore.load()) ? { plan: (await planStore.load())!.plan } : undefined,
                    seen: (await seenStore.load()) ?? undefined,
                    predictions: (await predictionStore.load()) ?? undefined,
                    experiments: (await experimentStore.load()) ?? undefined,
                    approvals: (await approvalStore.load()) ?? undefined,
                  }
                : undefined,
            ),
          ),
        );
      case "simulate_plan":
        return text(JSON.stringify(await simulatePlan(suunto, a)));
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
        const data = await suunto.getDailyStats(requiredAliased(a, "from", "startdate") as string, requiredAliased(a, "to", "enddate") as string);
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
