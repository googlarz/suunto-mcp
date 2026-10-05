#!/usr/bin/env node
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
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { loadConfig, assertCredentials } from "./config.js";
import { SuuntoClient } from "./api.js";
import { parseFit, summarizeFit } from "./fit.js";
import { RESOURCES, readResource } from "./resources.js";
import { buildGuideZip, buildIntervalGuideZip, buildStrengthGuideZip } from "./guide-zip.js";
import { generateDigest } from "./daily-digest.js";
import { validateAgainstSchema } from "./schema-validate.js";
import { TOOL_META } from "./tool-meta.js";
import { LAP_EXTENSIONS, shapeLaps } from "./laps.js";
import { buildSnapshot, buildSnapshotRange } from "./snapshot.js";

const cfg = loadConfig();
const suunto = new SuuntoClient(cfg);

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
  assertCredentials(cfg);
}

const server = new Server(
  { name: "suunto-mcp", version: pkgVersion },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  ensureReady();
  const contents = await readResource(req.params.uri, suunto);
  return { contents: [contents] };
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
      "One call for \"how was this day, and the night before it\": the aggregation the other tools leave to the caller. Output: { date, sleepNightOf, sleep, recovery, activity, workouts, errors }. sleep describes the NIGHT THAT LED INTO the date (sleepNightOf = the previous date, i.e. sleeps that began between noon on the previous day and noon on the date): { main (the longest non-nap sleep: sleepId, bedtimeStart, bedtimeEnd, durationS, deepS, lightS, remS, score, avgHrv, hrAvg, hrMin, spo2Max), otherNights (further non-nap sleeps, when the watch split a night), nightSleepS (total of main + otherNights, null when there is none), naps }. Suunto marks any sleep shorter than about 3 hours as a nap, so a short night appears under naps with main null. recovery covers the local calendar day: { samples, low: { balance, at }, high, first, last, stressStateSamples (samples per StressState) } or null without data. low is the day's lowest balance — not necessarily overnight (after an evening workout it can fall in the evening). activity: { steps, energyKcal } for the local day — energyKcal is the daily-statistics energy converted from joules; real days come out around 700-1,500 kcal, well below a resting rate, so it looks like ACTIVE energy rather than a total (not verified against the watch). A value is null, never 0, when Suunto has no sample for the date. workouts: the day's workouts (by their own local date) with { workoutKey, activityId, startLocal, totalTimeS, kcal, hrAvg, hrMax, tss (HR method), guide, hasLaps } — pass a workoutKey with hasLaps to get_workout_laps. Each section is fetched independently: one that fails is null and explained in errors, the others are still valid. With `to`, returns { from, to, days: [...], errors } instead (errors is shared by the whole range; a failed section is null in every day). Use this instead of combining get_sleep, get_recovery, get_daily_activity_statistics and list_workouts by hand. Read-only.",
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
    name: "get_workout_laps",
    description:
      "Returns the manual laps of one workout as a compact table, plus its training-load fields — the way to read back a guided gym session set by set (push_strength_guide records one lap per set and per rest; push_workout_guide one lap per exercise and one per rest between exercises). A session from push_interval_guide auto-advances and is expected to record no manual laps (unverified), so it should return an empty table. About 2.5 KB for a 35-lap strength session, versus ~550 KB for get_workout_fit full=true. Output: { workoutKey, activityId, startTime (epoch ms), totalTimeS, guide: { id, name } | null (the guide that ran, as recorded by Suunto — not looked up in list_guides, because guides are often deleted afterwards), tss: [{ method (seen so far: 'HR', 'MET'), value }], pte, peakEpoc, recoveryTime (from the workout's summary extension; units not verified, and it can differ from the recoveryTime that list_workouts and get_workout carry), hrZoneTimeS: [zone1..zone5 seconds], feeling (the answer to the watch's 'How was it?' question, passed through as Suunto sends it; null when skipped), lapCount, checks: [{ code, detail }], laps: { cols, rows } }. checks lists reasons not to trust positional reading of the table (empty when clean): 'duplicate-rest' (the same rest label twice in a row — a set lap is missing or a rest was split), 'no-session-complete' (a guided table without its final lap — session ended early, buttons locked or watch restarted), 'unlabelled-laps' (some laps have no guide label), 'no-heart-rate' (no lap has heart rate, e.g. battery mode Tour). laps.cols = [i (1-based), startOffsetS (from workout start), durationS, hrAvg, hrMax, hrMin (bpm), kcal, kind, label]; each row is an array in that order. label is the text of the guide step that was active during the lap (lines joined with ' | '), or null when no guide ran. kind is 'rest' when the label contains 'Next:' at its start or after a '·' (a per-set rest lap reads 'Next: set k/S', or '<restSec>s target · Next: set k/S' with restMode 'stopwatch'), 'done' for the final 'Session complete' lap, 'step' for any other labelled lap, null when there is no label. A per-set strength guide yields, per exercise, a prep lap, then set 1, rest, set 2, rest, … — 2 × sets laps — and one trailing 'Session complete' lap for the whole session; a prep lap and a set lap look alike in the label, so tell them apart by position. Real sessions can deviate (skipped or repeated rest laps), so check the labels rather than only counting. A workout without manual laps (unguided gym, cycling) returns lapCount 0 and laps.rows [] — not an error. Call list_workouts first for the workoutKey.",
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
      "Returns all routes saved in the user's Suunto account. Each route: id, description, visibility, distance (m), start/end coordinates, waypoint count. Use export_route to get the GPX track for navigation. Read-only.",
    inputSchema: { type: "object", properties: {} },
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
    name: "upload_workout",
    description:
      "Uploads a workout file to the user's Suunto account. Provide the absolute path to the file on disk. The file is pushed to Suunto and appears in the app after processing (usually a few seconds). Returns an uploadId you can poll with get_upload_status. Suunto's own upload API docs state only .fit (binary) is currently supported for this endpoint — a .gpx path is still accepted here (sent as application/gpx+xml) in case that changes, but treat it as unverified; use .fit for a workout that must reliably show up. Write operation.",
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
      "Pushes a text-step workout guide to the user's Suunto account via the SuuntoPlus Guide Cloud API. Each exercise becomes one step, advanced by a lap-button press on the watch. Requires SUUNTO_APP_NAME env var to exactly match the app name registered on apizone.suunto.com. There is no live push to the watch itself — delivery depends on the phone's normal Suunto app sync. In testing it showed up on the watch after the next ordinary sync with no manual pinning needed; if it doesn't appear, check the Suunto app under SuuntoPlus Guides and pin it there. For gym sessions prefer push_strength_guide: it records one lap per set and per rest, which get_workout_laps can read back. Write operation.",
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
      "Pushes an interval/cardio guide (warmup, timed or distance-based work intervals, recoveries, optional repeats) to the user's Suunto account via the SuuntoPlus Guide Cloud API. Unlike push_workout_guide (manual lap-per-exercise), interval segments auto-advance by elapsed time or distance — hands-off during a run or ride. Each segment can show a target heart-rate range alongside live HR. Requires SUUNTO_APP_NAME env var to exactly match the app name registered on apizone.suunto.com. Same delivery caveat as push_workout_guide: appears after the phone's next normal Suunto app sync, no live push. Write operation.",
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
      "Pushes a resistance-training guide to the user's Suunto account via the SuuntoPlus Guide Cloud API — the tool to use for gym sessions. Per exercise: a prep step (self-paced stopwatch showing the plate breakdown if given, otherwise the weight/sets detail, plus the exercise name and live HR; a lap press starts the exercise), then with lapGranularity 'perSet' (default) each set is its own step ended by a lap press, and each rest between sets is its own step showing 'Next: set k/S'. restMode 'countdown' (default) counts down restSec and auto-advances into the next set with a vibration; 'stopwatch' counts up and waits for a lap press. lapGranularity 'perExercise' gives one step per exercise after its prep, with no between-set rests and no per-set laps. Every prep, set and rest is its own lap and the guide ends with one extra 'Session complete' step, so a perSet session records 2 × (total sets) + 1 laps. Read them back after the workout with get_workout_laps — its labels are the step texts. Requires SUUNTO_APP_NAME to exactly match the app name registered on apizone.suunto.com. Without guideId a new guide is created on every call (see list_guides / delete_guide to tidy up); with guideId that guide is overwritten. There is no live push to the watch: it appears after the phone's next normal Suunto app sync. Write operation.",
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
              plates: {
                type: "string",
                description: "Per-side plate breakdown for barbell exercises, e.g. '2x20+1x5/side' — shown on the prep screen instead of detail, since that's when the bar actually gets loaded. Omit for non-barbell exercises (dumbbell, machine, bodyweight, cable); compute the math yourself before calling this tool, it isn't done here.",
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

// Titles + annotations live in tool-meta.ts; a tool without an entry there
// fails at startup rather than shipping unannotated.
const tools = toolDefs.map((t) => {
  const meta = TOOL_META[t.name];
  if (!meta) throw new Error(`Tool "${t.name}" has no entry in tool-meta.ts`);
  return { ...t, ...meta };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, any>;

  try {
    // Checked before ensureReady(): otherwise a missing-credentials error
    // masks a typo'd tool name.
    const tool = tools.find((t) => t.name === name);
    if (!tool) return text(`Unknown tool: ${name}`, true);
    // Each tool declares a full inputSchema, but the MCP SDK doesn't
    // enforce it — a call could otherwise pass e.g. limit: -1 straight
    // through to the API layer instead of being rejected up front.
    const errors = validateAgainstSchema(tool.inputSchema, a);
    if (errors.length) return text(`Invalid arguments for ${name}: ${errors.join("; ")}`, true);
    ensureReady();
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
      case "get_workout_laps": {
        const data = await suunto.getWorkoutWithExtensions(a.workoutKey, LAP_EXTENSIONS);
        return text(JSON.stringify(shapeLaps(data)));
      }
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
      case "list_routes": {
        const data = await suunto.listRoutes();
        return text(JSON.stringify(data));
      }
      case "export_route": {
        const bytes = await suunto.exportRoute(a.routeId);
        return text(new TextDecoder().decode(bytes));
      }
      case "upload_workout": {
        const { readFile } = await import("node:fs/promises");
        const filePath: string = a.filePath;
        const ext = filePath.split(".").pop()?.toLowerCase();
        const contentType = ext === "gpx" ? "application/gpx+xml" : "application/octet-stream";
        const fileBytes = await readFile(filePath);
        const { uploadId, uploadUrl } = await suunto.initiateUpload({
          description: a.description,
          comment: a.comment,
          notifyUser: false,
          privacy: a.privacy ?? "DEFAULT",
        });
        await suunto.uploadFile(uploadUrl, fileBytes, contentType);
        return text(JSON.stringify({ uploadId, message: "Upload initiated. Use get_upload_status to check processing." }));
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
        const data = a.guideId
          ? await suunto.updateGuide(a.guideId, zip)
          : await suunto.createGuide(zip);
        return text(
          JSON.stringify({
            ...data,
            nextStep:
              "It should appear on the watch after your phone's next normal Suunto app sync. If it doesn't, open the Suunto app > your watch > SuuntoPlus Guides and pin it manually.",
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
        const data = a.guideId
          ? await suunto.updateGuide(a.guideId, zip)
          : await suunto.createGuide(zip);
        return text(
          JSON.stringify({
            ...data,
            nextStep:
              "It should appear on the watch after your phone's next normal Suunto app sync. If it doesn't, open the Suunto app > your watch > SuuntoPlus Guides and pin it manually.",
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
        const data = a.guideId
          ? await suunto.updateGuide(a.guideId, zip)
          : await suunto.createGuide(zip);
        return text(
          JSON.stringify({
            ...data,
            nextStep:
              "It should appear on the watch after your phone's next normal Suunto app sync. If it doesn't, open the Suunto app > your watch > SuuntoPlus Guides and pin it manually.",
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

function text(s: string, isError = false) {
  return {
    content: [{ type: "text", text: s }],
    ...(isError ? { isError: true } : {}),
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("suunto-mcp ready on stdio");
