#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, assertCredentials } from "./config.js";
import { SuuntoClient } from "./api.js";
import { parseFit, summarizeFit } from "./fit.js";

const cfg = loadConfig();
assertCredentials(cfg);
const suunto = new SuuntoClient(cfg);

const server = new Server(
  { name: "suunto-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

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
