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
  { name: "suunto-mcp", version: "0.1.0" },
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
      "List recent workouts from the user's Suunto account. Returns summary metadata (sport, duration, distance, HR, calories, start time) — not raw samples.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO 8601 datetime — only workouts on/after this time.",
        },
        until: {
          type: "string",
          description: "ISO 8601 datetime — only workouts on/before this time.",
        },
        limit: { type: "number", description: "Max workouts to return.", default: 25 },
      },
    },
  },
  {
    name: "get_workout",
    description:
      "Get the full summary of a single workout by its workoutKey (from list_workouts).",
    inputSchema: {
      type: "object",
      properties: { workoutKey: { type: "string" } },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_samples",
    description:
      "Get time-series samples for a workout (HR, speed, altitude, power, cadence, GPS).",
    inputSchema: {
      type: "object",
      properties: { workoutKey: { type: "string" } },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_fit",
    description:
      "Download the FIT file for a workout and return a parsed, summarized JSON view including session totals, laps, and a sample of records.",
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: { type: "string" },
        full: {
          type: "boolean",
          description:
            "If true, returns ALL parsed records (large). Default false returns a summary + sampled records.",
          default: false,
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "export_workout_gpx",
    description:
      "Download a workout's GPS track as a GPX XML string (for maps, route planners, Strava import).",
    inputSchema: {
      type: "object",
      properties: { workoutKey: { type: "string" } },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_daily_activity",
    description:
      "Get 24/7 activity summary for a single date: steps, calories, daily heart rate.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["date"],
    },
  },
  {
    name: "list_daily_activity",
    description:
      "Get 24/7 activity summaries for a date range (steps, calories, daily HR).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD (inclusive)" },
        to: { type: "string", description: "YYYY-MM-DD (inclusive)" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_sleep",
    description:
      "Get sleep data for a single night (stages, duration, score) keyed by the night's wake-up date.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["date"],
    },
  },
  {
    name: "list_sleep",
    description: "Get sleep data for a date range.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_recovery",
    description:
      "Get recovery / HRV data for a single date (resources, stress, recovery score).",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["date"],
    },
  },
  {
    name: "list_recovery",
    description: "Get recovery / HRV data for a date range.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "List active webhook subscriptions on this Suunto account (workouts, sleep, recovery, daily activity).",
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
