#!/usr/bin/env node
import "./env.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, assertCredentials } from "./config.js";
import { SuuntoClient } from "./api.js";
import { parseFit, summarizeFit } from "./fit.js";
import { RESOURCES, readResource } from "./resources.js";

const cfg = loadConfig();
const suunto = new SuuntoClient(cfg);

// Credential check runs lazily — at the moment a tool or resource actually
// tries to hit the API. This lets MCP introspection (ListTools,
// ListResources) succeed without credentials, which catalogs like
// glama.ai use to verify the server boots correctly.
function ensureReady() {
  assertCredentials(cfg);
}

const server = new Server(
  { name: "suunto-mcp", version: "0.9.1" },
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

const tools = [
  {
    name: "list_workouts",
    description:
      "Returns the user's recent Suunto workouts ordered newest-first. Each item: workoutKey (string id), activityId, sport, startTime (epoch ms), totalTime (s), totalDistance (m), totalCalories, avgHeartRate, maxHeartRate, totalAscent (m), totalDescent (m). Auto-paginates across pages until limit is reached or no more workouts exist. Use get_workout for full detail (laps, HR zones, sport-specific metrics) on a single result. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 lower bound on startTime (inclusive). Example: 2026-04-01T00:00:00Z.",
        },
        until: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 upper bound on startTime (inclusive).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 25,
          description: "Maximum number of workouts to return (1–1000). Defaults to 25.",
        },
      },
    },
  },
  {
    name: "get_workout",
    description:
      "Returns the full summary for one workout: all fields Suunto exposes including laps, HR zones, training-effect score, and sport-specific metrics (pace zones for running, power for cycling, etc.). Throws SuuntoNotFoundError if the workoutKey does not exist. Use list_workouts to discover valid workoutKey values. For second-by-second time-series (HR, pace, GPS) use get_workout_samples instead. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Unique workout identifier from list_workouts.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_samples",
    description:
      "Returns the time-series sample stream for one workout. Each sample: timestamp (ms), heartRate (bpm), speed (m/s), altitude (m), power (W), cadence, latitude, longitude. Sampled at the device's recording interval (typically 1 s). Long workouts (>2 h) may return thousands of records — use get_workout_fit with full=false for a compact summary instead. Throws SuuntoNotFoundError if the key is invalid. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Unique workout identifier from list_workouts.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_fit",
    description:
      "Downloads the workout's binary FIT file from Suunto and returns it parsed to JSON. Default (full=false): compact summary { sport, total_distance_km, avg_heart_rate, training_effect, laps, records_sample (first 5 / middle 5 / last 5 records) }. Set full=true to receive every parsed FIT record — responses are often >100 KB for long workouts. Use the default for analysis and summaries; full=true only when raw record-level data is required. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Unique workout identifier from list_workouts.",
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
    name: "export_workout_gpx",
    description:
      "Returns the workout's GPS route as a GPX 1.1 XML string (not JSON). Each trackpoint contains lat, lon, elevation, and timestamp. Suitable for direct import into Strava, Komoot, Google Earth, or any GPX-compatible tool. Returns a valid but empty GPX document if the workout has no GPS data. Use get_workout_samples for numeric time-series (HR, power, cadence) instead of GPS. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "Unique workout identifier from list_workouts.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_daily_activity",
    description:
      "Returns the 24/7 activity summary for one calendar day: { steps, activeCalories, totalCalories, avgHeartRate, minHeartRate, maxHeartRate, restingHeartRate }. Throws SuuntoNotFoundError if the watch did not sync data for that date. Use list_daily_activity to fetch a date range efficiently. Requires Activity API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Calendar date YYYY-MM-DD. Example: 2026-04-20.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_daily_activity",
    description:
      "Returns 24/7 activity summaries for each day in [from, to] inclusive, ordered chronologically. Each entry: { date, steps, activeCalories, totalCalories, avgHeartRate, minHeartRate, maxHeartRate, restingHeartRate }. Days where the watch did not sync are omitted from the result. Use get_daily_activity for a single day. Requires Activity API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Start date YYYY-MM-DD, inclusive. Example: 2026-04-01.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "End date YYYY-MM-DD, inclusive. Example: 2026-04-30.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_sleep",
    description:
      "Returns the sleep summary for one night keyed by the morning wake-up date: { totalSleep (s), deepSleep (s), lightSleep (s), remSleep (s), awake (s), efficiency (%), sleepScore }. A session ending the morning of 2026-04-20 is keyed to 2026-04-20. Throws SuuntoNotFoundError if no sleep was recorded for that date. Use list_sleep for a date range. Requires Sleep API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Wake-up date YYYY-MM-DD. Example: 2026-04-20.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_sleep",
    description:
      "Returns sleep summaries for each night in [from, to] inclusive, keyed by wake-up date, ordered chronologically. Each entry: { date, totalSleep (s), deepSleep (s), lightSleep (s), remSleep (s), awake (s), efficiency (%), sleepScore }. Nights where no sleep was recorded are omitted. Use get_sleep for a single night. Requires Sleep API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "First wake-up date YYYY-MM-DD, inclusive. Example: 2026-04-01.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Last wake-up date YYYY-MM-DD, inclusive. Example: 2026-04-30.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_recovery",
    description:
      "Returns the recovery and HRV summary for one date: { recoveryScore (0–100), hrv (ms, rMSSD), stressLevel, readiness }. Throws SuuntoNotFoundError if no recovery data exists for that date. Use list_recovery for a date range. Requires Recovery API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Calendar date YYYY-MM-DD. Example: 2026-04-20.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_recovery",
    description:
      "Returns recovery and HRV summaries for each day in [from, to] inclusive, ordered chronologically. Each entry: { date, recoveryScore (0–100), hrv (ms, rMSSD), stressLevel, readiness }. Days without recovery data are omitted. Use get_recovery for a single day. Requires Recovery API subscription on apizone; returns 404 without it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Start date YYYY-MM-DD, inclusive. Example: 2026-04-01.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "End date YYYY-MM-DD, inclusive. Example: 2026-04-30.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "Returns all active webhook subscriptions on this Suunto account as an array of { id, eventType, callbackUrl, createdAt }. Returns an empty array if no webhooks are registered. Use to audit which event types are already wired before adding new subscriptions. Requires Subscriptions API product on apizone. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, any>;

  try {
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
        return text(JSON.stringify(data, null, 2));
      }
      case "get_workout": {
        const data = await suunto.getWorkout(a.workoutKey);
        return text(JSON.stringify(data, null, 2));
      }
      case "get_workout_samples": {
        const data = await suunto.getWorkoutSamples(a.workoutKey);
        return text(JSON.stringify(data, null, 2));
      }
      case "get_workout_fit": {
        const bytes = await suunto.getWorkoutFit(a.workoutKey);
        const parsed = await parseFit(bytes);
        const out = a.full ? parsed : summarizeFit(parsed);
        return text(JSON.stringify(out, null, 2));
      }
      case "export_workout_gpx": {
        const bytes = await suunto.getWorkoutGpx(a.workoutKey);
        return text(new TextDecoder().decode(bytes));
      }
      case "get_daily_activity":
        return text(JSON.stringify(await suunto.getDailyActivity(a.date), null, 2));
      case "list_daily_activity":
        return text(
          JSON.stringify(await suunto.listDailyActivity(a.from, a.to), null, 2),
        );
      case "get_sleep":
        return text(JSON.stringify(await suunto.getSleep(a.date), null, 2));
      case "list_sleep":
        return text(JSON.stringify(await suunto.listSleep(a.from, a.to), null, 2));
      case "get_recovery":
        return text(JSON.stringify(await suunto.getRecovery(a.date), null, 2));
      case "list_recovery":
        return text(JSON.stringify(await suunto.listRecovery(a.from, a.to), null, 2));
      case "list_subscriptions": {
        const data = await suunto.subscriptions();
        return text(JSON.stringify(data, null, 2));
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
