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
  { name: "suunto-mcp", version: "0.9.0" },
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
      "Returns the user's recent Suunto workouts as an array of summaries. Each item: workoutKey (string id), activityId, sport, startTime (epoch ms), totalTime (s), totalDistance (m), totalCalories, avgHeartRate, maxHeartRate, totalAscent (m), totalDescent (m). Auto-paginates up to limit. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 datetime lower bound on startTime. Example: 2026-04-01T00:00:00Z.",
        },
        until: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 datetime upper bound on startTime.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 25,
          description: "Maximum workouts to return.",
        },
      },
    },
  },
  {
    name: "get_workout",
    description:
      "Returns the full summary object for one workout: every field Suunto exposes (laps, HR zones, training-effect, sport-specific metrics) keyed by the given workoutKey. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "The workoutKey from list_workouts.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_samples",
    description:
      "Returns the time-series sample stream for one workout: timestamp, heartRate (bpm), speed (m/s), altitude (m), power (W), cadence, latitude, longitude — sampled at the device's recording rate. Response can be large for long workouts. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "The workoutKey from list_workouts.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_fit",
    description:
      "Downloads the workout's FIT file (binary) from Suunto and returns it parsed to JSON. Default response is a compact summary { sport, total_distance_km, avg_heart_rate, training_effect, laps, records_sample (first/middle/last) }. Set full=true for every parsed record (often >100 KB). No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "The workoutKey from list_workouts.",
        },
        full: {
          type: "boolean",
          default: false,
          description: "If true, return all parsed records instead of the summary.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "export_workout_gpx",
    description:
      "Returns the workout's GPS track as a GPX 1.1 XML string (raw text, not JSON). Suitable for import into Strava, Komoot, Google Earth, or other route tools. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          minLength: 1,
          description: "The workoutKey from list_workouts.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_daily_activity",
    description:
      "Returns the 24/7 activity summary for one calendar day: { steps, activeCalories, totalCalories, avgHeartRate, minHeartRate, maxHeartRate, restingHeartRate }. Requires the Activity API product on apizone. No mutations.",
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
      "Returns 24/7 activity summaries for each day in [from, to] inclusive — one entry per day with steps, calories, heart-rate stats. Requires the Activity API product on apizone. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Start date YYYY-MM-DD, inclusive.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "End date YYYY-MM-DD, inclusive.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_sleep",
    description:
      "Returns the sleep summary for one night, keyed by wake-up date: { totalSleep (s), deepSleep, lightSleep, remSleep, awake, efficiency, sleepScore }. Requires the Sleep API product on apizone. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Wake-up date YYYY-MM-DD. A sleep ending the morning of 2026-04-20 is keyed 2026-04-20.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_sleep",
    description:
      "Returns sleep summaries for each night in [from, to] inclusive, keyed by wake-up date. Same per-night fields as get_sleep. Requires the Sleep API product on apizone. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "First wake-up date YYYY-MM-DD, inclusive.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Last wake-up date YYYY-MM-DD, inclusive.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_recovery",
    description:
      "Returns recovery / HRV summary for one date: { recoveryScore, hrv (ms), stressLevel, readiness }. Requires the Recovery API product on apizone. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Calendar date YYYY-MM-DD.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_recovery",
    description:
      "Returns recovery / HRV summaries for each day in [from, to] inclusive. Same per-day fields as get_recovery. Requires the Recovery API product on apizone. No mutations.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Start date YYYY-MM-DD, inclusive.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "End date YYYY-MM-DD, inclusive.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "Returns the webhook subscriptions currently active on this Suunto account: { id, eventType, callbackUrl, createdAt }. Empty list on a fresh account. No mutations.",
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
