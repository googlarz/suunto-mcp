#!/usr/bin/env node
import "./env.js";

// CLI mode: any explicit command arg, OR running interactively in a terminal.
// MCP server mode: stdin is piped (how every MCP client spawns this binary).
const [, , firstArg] = process.argv;
if (firstArg !== undefined || process.stdin.isTTY) {
  const { runCli } = await import("./cli.js");
  await runCli(process.argv.slice(2));
  process.exit(0);
}

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
  { name: "suunto-mcp", version: "0.11.0" },
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
      "Returns the user's recent Suunto workouts ordered newest-first (Workout API v3). Each item: workoutKey (string id), activityId, sport, startTime (epoch ms), totalTime (s), totalDistance (m), totalCalories, avgHeartRate, maxHeartRate, totalAscent (m), totalDescent (m). Auto-paginates with offset-based pagination until limit is reached or no more workouts exist. Use get_workout for full detail (laps, HR zones, sport-specific metrics) on a single result. Read-only.",
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
      "Returns the full summary for one workout: all fields Suunto exposes including laps, HR zones, training-effect score, and sport-specific metrics (pace zones for running, power for cycling, etc.). Throws SuuntoNotFoundError if the workoutKey does not exist. Use list_workouts to discover valid workoutKey values. For second-by-second time-series (HR, pace, GPS) use get_workout_samples instead. Read-only.",
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
      "Returns the time-series sample stream for one workout. Each sample: timestamp (ms), heartRate (bpm), speed (m/s), altitude (m), power (W), cadence, latitude, longitude. Sampled at the device's recording interval (typically 1 s). Long workouts (>2 h) may return thousands of records — use get_workout_fit with full=false for a compact summary instead. Throws SuuntoNotFoundError if the key is invalid. Read-only.",
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
      "Downloads the workout's binary FIT file from Suunto and returns it parsed to JSON. Default (full=false): compact summary { sport, total_distance_km, avg_heart_rate, training_effect, laps, records_sample (first 5 / middle 5 / last 5 records) }. Set full=true to receive every parsed FIT record — responses are often >100 KB for long workouts. Use the default for analysis and summaries; full=true only when raw record-level data is required. Read-only.",
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
    name: "export_workout_gpx",
    description:
      "Returns the workout's GPS route as a GPX 1.1 XML string (not JSON). Each trackpoint contains lat, lon, elevation, and timestamp. Suitable for direct import into Strava, Komoot, Google Earth, or any GPX-compatible tool. Returns a valid but empty GPX document if the workout has no GPS data. Use get_workout_samples for numeric time-series (HR, power, cadence) instead of GPS. Read-only.",
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
      "Returns the 24/7 activity time-series samples for one calendar day from the /247samples API. Each sample includes a timestamp (ISO8601) and activity metrics such as steps and HR. Days without synced data return an empty payload. Use list_daily_activity to fetch a date range. Requires 24/7 Activity API subscription on apizone. Read-only.",
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
          description: "Calendar date YYYY-MM-DD. Suunto syncs once daily — today or future dates typically return SuuntoNotFoundError; use yesterday or earlier for reliable results.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_daily_activity",
    description:
      "Returns 24/7 activity time-series samples from the /247samples API for the date range [from, to] inclusive, ordered chronologically by timestamp. Each sample: { timestamp (ISO8601), steps, HR, and other activity metrics }. Days without synced data are omitted. Use get_daily_activity for a single day or get_daily_activity_statistics for aggregated daily step/energy totals. Requires 24/7 Activity API subscription on apizone. Read-only.",
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
          description: "End date YYYY-MM-DD, inclusive. Future dates are accepted but produce no entries. Prefer ranges ≤ 30 days for responsiveness.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_sleep",
    description:
      "Returns sleep time-series samples from the /247samples API for one calendar day: { timestamp (ISO8601), totalSleep (s), deepSleep (s), lightSleep (s), remSleep (s), awake (s), efficiency (%), sleepScore }. Days without recorded sleep return an empty payload. Use list_sleep for a date range. Requires Sleep API subscription on apizone; returns 404 without it. Read-only.",
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
          description: "Wake-up date YYYY-MM-DD. Keyed to the morning the session ended, not when it started. Suunto syncs once daily — use yesterday or earlier for reliable results.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_sleep",
    description:
      "Returns sleep time-series samples from the /247samples API for the date range [from, to] inclusive, ordered chronologically by timestamp. Each entry: { timestamp (ISO8601), totalSleep (s), deepSleep (s), lightSleep (s), remSleep (s), awake (s), efficiency (%), sleepScore }. Nights without recorded sleep are omitted. Use get_sleep for a single night. Requires Sleep API subscription on apizone; returns 404 without it. Read-only.",
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
          description: "First wake-up date YYYY-MM-DD, inclusive. Must be ≤ to. Nights without recorded sleep are silently omitted, not 404.",
        },
        to: {
          type: "string",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          maxLength: 10,
          examples: ["2026-04-30"],
          description: "Last wake-up date YYYY-MM-DD, inclusive. Future dates are accepted but produce no entries. Prefer ranges ≤ 30 days for responsiveness.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_recovery",
    description:
      "Returns recovery and HRV time-series samples from the /247samples API for one calendar day. Each sample: { timestamp (ISO8601), Balance (0.0–1.0 recovery balance), StressState (0=Invalid, 1=Relaxing, 2=Active, 3=Passive, 4=Stressful) }. Days without recovery data return an empty payload. Use list_recovery for a date range. Requires Recovery API subscription on apizone; returns 404 without it. Read-only.",
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
          description: "Calendar date YYYY-MM-DD. Suunto syncs once daily — today or future dates typically return SuuntoNotFoundError; use yesterday or earlier for reliable results.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "list_recovery",
    description:
      "Returns recovery and HRV time-series samples from the /247samples API for the date range [from, to] inclusive, ordered chronologically by timestamp. Each entry: { timestamp (ISO8601), Balance (0.0–1.0 recovery balance), StressState (0=Invalid, 1=Relaxing, 2=Active, 3=Passive, 4=Stressful) }. Days without recovery data are omitted. Use get_recovery for a single day. Requires Recovery API subscription on apizone; returns 404 without it. Read-only.",
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
          description: "End date YYYY-MM-DD, inclusive. Future dates are accepted but produce no entries. Prefer ranges ≤ 30 days for responsiveness.",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "get_daily_activity_statistics",
    description:
      "Returns aggregated daily step count and energy consumption (joules) from the /247 API for the given datetime range. Response is an array of AggregatedActivityData objects, each with a Name ('stepcount' or 'energyconsumption'), Aggregation ('sum'), and Sources array containing per-device Samples with TimeISO8601 and Value. Maximum fetch interval is 28 days. Samples with null Value indicate no data synced for that day. Prefer this tool over list_daily_activity when you need totals rather than intraday time-series. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        startdate: {
          type: "string",
          examples: ["2026-04-01T00:00:00"],
          description:
            "Start datetime in ISO-8601 format (e.g. 2026-04-01T00:00:00). Data is stored in UTC.",
        },
        enddate: {
          type: "string",
          examples: ["2026-04-30T23:59:59"],
          description:
            "End datetime in ISO-8601 format (e.g. 2026-04-30T23:59:59). Must be within 28 days of startdate.",
        },
      },
      required: ["startdate", "enddate"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "Returns all active webhook subscriptions on this Suunto account as an array of { id, eventType, callbackUrl, createdAt }. Returns an empty array if no webhooks are registered. Use to audit which event types are already wired before adding new subscriptions. Requires Subscriptions API product on apizone. Read-only.",
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
      "Uploads a FIT or GPX workout file to the user's Suunto account. Provide the absolute path to the file on disk. The file is pushed to Suunto and appears in the app after processing (usually a few seconds). Returns an uploadId you can poll with get_upload_status. Supported formats: .fit (binary) or .gpx (XML). Write operation.",
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
      case "get_daily_activity_statistics": {
        const data = await suunto.getDailyStats(a.startdate, a.enddate);
        return text(JSON.stringify(data, null, 2));
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
      case "get_upload_status": {
        const data = await suunto.getUploadStatus(a.uploadId);
        return text(JSON.stringify(data));
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
