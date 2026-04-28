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

const ISO_DATE = "Calendar date in YYYY-MM-DD format (e.g. 2026-04-20).";
const READ_ONLY_NOTE =
  "Read-only — does not modify any data on the user's Suunto account.";

const tools = [
  {
    name: "list_workouts",
    description:
      "List the user's recent workouts (runs, rides, hikes, swims, gym sessions, etc.) from the Suunto cloud. " +
      "Returns lightweight summary metadata only — sport, sub-sport, duration, distance, average and max heart rate, calories, ascent/descent, and start time — not the full time-series. " +
      "Use this first to find a workout's `workoutKey`, then call `get_workout`, `get_workout_samples`, `get_workout_fit`, or `export_workout_gpx` for deeper detail. " +
      "Auto-paginates internally up to `limit`. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "ISO 8601 datetime (e.g. 2026-04-01T00:00:00Z). Only workouts that started on or after this time are returned. Omit for no lower bound.",
        },
        until: {
          type: "string",
          description:
            "ISO 8601 datetime. Only workouts that started on or before this time are returned. Omit for no upper bound.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of workouts to return. Defaults to 25. The server will fetch additional pages from Suunto as needed to satisfy this limit.",
          default: 25,
        },
      },
    },
  },
  {
    name: "get_workout",
    description:
      "Fetch the full summary of one specific workout, identified by its `workoutKey` (obtained from `list_workouts`). " +
      "Returns the same shape as a `list_workouts` entry but with all fields the Suunto API exposes for a single workout — laps, HR zones, training-effect metrics, sport-specific stats. " +
      "Use this when the user asks for details about a particular session beyond what `list_workouts` returns. " +
      "For raw time-series (HR per second, GPS points), use `get_workout_samples` or `get_workout_fit` instead. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          description:
            "The opaque identifier returned in `workoutKey` by `list_workouts`. Required.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_samples",
    description:
      "Fetch the time-series sample stream for one workout: heart rate, speed, altitude, power, cadence, and GPS coordinates recorded at the device's sample rate. " +
      "Use this for second-by-second analysis — HR drift, pace splits, climb profiles. " +
      "Response can be large for long workouts (hours of 1-second samples). For the full FIT file with structured laps and events, use `get_workout_fit`. " +
      "For just the GPS track in a portable format, use `export_workout_gpx`. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          description: "The `workoutKey` from `list_workouts`. Required.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_workout_fit",
    description:
      "Download the workout's FIT file (the binary format produced by the watch) and return it as parsed, structured JSON. " +
      "By default returns a summary view (session totals, lap count, sample of records). Set `full: true` to return every parsed record — useful for full ride/run analysis but can be hundreds of KB of JSON. " +
      "Prefer this over `get_workout_samples` when the user wants laps, training-effect, or structured metadata. " +
      "Prefer `export_workout_gpx` when the user only wants the GPS route. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          description: "The `workoutKey` from `list_workouts`. Required.",
        },
        full: {
          type: "boolean",
          description:
            "If true, return ALL parsed FIT records (potentially hundreds of KB). Default false returns a compact summary plus three sampled records (first / middle / last).",
          default: false,
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "export_workout_gpx",
    description:
      "Export a workout's GPS track as a GPX XML string. " +
      "Use this when the user wants to import the route into another platform (Strava, Komoot, Google Earth, route planners) or when they ask for a map of the activity. " +
      "Returns plain GPX 1.1 text, not parsed JSON — the caller (or AI) is expected to use it as-is. " +
      "If you need structured GPS data for analysis, use `get_workout_samples` or `get_workout_fit` instead. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        workoutKey: {
          type: "string",
          description: "The `workoutKey` from `list_workouts`. Required.",
        },
      },
      required: ["workoutKey"],
    },
  },
  {
    name: "get_daily_activity",
    description:
      "Fetch the 24/7 activity summary for one specific calendar day: steps, active calories, total calories, and daily heart-rate averages/min/max. " +
      "Use this for questions like \"how many steps did I take yesterday?\" or \"what was my resting HR last Sunday?\". " +
      "For workouts (a specific run/ride/etc.), use `list_workouts` instead — daily activity covers the whole day, not a single session. " +
      "Requires the apizone Activity API product subscription on the user's app; otherwise returns 403/404. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: ISO_DATE },
      },
      required: ["date"],
    },
  },
  {
    name: "list_daily_activity",
    description:
      "Fetch 24/7 activity summaries for a date range — one entry per day with steps, calories, and daily HR. " +
      "Use this for trend questions (\"my step count over the last 14 days\", \"resting HR trend this month\"). " +
      "For a single day, prefer `get_daily_activity`. For workouts within the range, use `list_workouts`. " +
      "Range is inclusive on both ends. Requires the Activity API product on apizone. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: ISO_DATE + " First day (inclusive).",
        },
        to: { type: "string", description: ISO_DATE + " Last day (inclusive)." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_sleep",
    description:
      "Fetch the sleep summary for one night, keyed by the wake-up date. " +
      "Returns sleep stages (deep / light / REM / awake), total duration, sleep efficiency, and the Suunto sleep score where available. " +
      "Use this for questions like \"how did I sleep last night?\" or \"sleep score on April 20\". " +
      "For trends across multiple nights, use `list_sleep`. " +
      "Requires the apizone Sleep API product subscription; otherwise returns 403/404. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description:
            ISO_DATE +
            " Specifically the wake-up date — a sleep that ended on the morning of 2026-04-20 is keyed as 2026-04-20.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_sleep",
    description:
      "Fetch sleep summaries across a date range — one entry per night, keyed by wake-up date. " +
      "Useful for sleep trends (\"average sleep score this week\", \"how often did I get under 7 hours last month\"). " +
      "For a single night, prefer `get_sleep`. " +
      "Range is inclusive on both ends. Requires the Sleep API product on apizone. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: ISO_DATE + " First wake-up date (inclusive)." },
        to: { type: "string", description: ISO_DATE + " Last wake-up date (inclusive)." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_recovery",
    description:
      "Fetch the recovery / HRV / stress summary for one date. " +
      "Returns Suunto's resources/recovery score, HRV-based stress trend, and any auto-derived training-readiness signal where available. " +
      "Use this to answer \"am I recovered enough for hard intervals today?\" or to ground training-load advice in real data instead of guessing. " +
      "For trends, use `list_recovery`. " +
      "Requires the apizone Recovery API product subscription. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: ISO_DATE } },
      required: ["date"],
    },
  },
  {
    name: "list_recovery",
    description:
      "Fetch recovery / HRV / stress summaries across a date range — one entry per day. " +
      "Useful for recovery trend analysis (\"is my HRV trending down this block?\", \"recovery scores during taper week\"). " +
      "For a single day, prefer `get_recovery`. " +
      "Range is inclusive on both ends. Requires the Recovery API product on apizone. " +
      READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: ISO_DATE + " First day (inclusive)." },
        to: { type: "string", description: ISO_DATE + " Last day (inclusive)." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "List the webhook subscriptions currently active for this Suunto account. " +
      "Subscriptions are how Suunto pushes new workouts / sleep / recovery / activity events to a registered webhook URL — useful for keeping a local cache fresh without polling. " +
      "A fresh account typically returns an empty list. " +
      "This server does not currently expose tools to create or delete subscriptions; that is on the roadmap. " +
      READ_ONLY_NOTE,
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
