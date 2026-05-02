#!/usr/bin/env node
import "./env.js";
import { parseArgs } from "node:util";
import { loadConfig, assertCredentials } from "./config.js";
import { SuuntoClient } from "./api.js";
import { parseFit, summarizeFit } from "./fit.js";

function die(msg: string): never {
  console.error(`suunto: ${msg}`);
  process.exit(1);
}

function out(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

const HELP = `
Usage: suunto-mcp-cli <command> [options]

Workout commands:
  list-workouts        [--since ISO] [--until ISO] [--limit N]
  get-workout          <workoutKey>
  get-workout-samples  <workoutKey>
  get-workout-fit      <workoutKey> [--full]
  export-workout-gpx   <workoutKey>

24/7 health commands:
  get-daily-activity   <YYYY-MM-DD>
  list-daily-activity  --from YYYY-MM-DD --to YYYY-MM-DD
  get-sleep            <YYYY-MM-DD>
  list-sleep           --from YYYY-MM-DD --to YYYY-MM-DD
  get-recovery         <YYYY-MM-DD>
  list-recovery        --from YYYY-MM-DD --to YYYY-MM-DD

Other:
  list-subscriptions

All commands output JSON to stdout. Pipe to jq for filtering:
  suunto-mcp-cli list-workouts --limit 5 | jq '.[].sport'
`.trim();

const [, , cmd, ...argv] = process.argv;

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(0);
}

const cfg = loadConfig();
assertCredentials(cfg);
const suunto = new SuuntoClient(cfg);

try {
  switch (cmd) {
    case "list-workouts": {
      const { values } = parseArgs({
        args: argv,
        options: {
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "string" },
        },
      });
      out(await suunto.listWorkouts({
        since: values.since ? Date.parse(values.since) : undefined,
        until: values.until ? Date.parse(values.until) : undefined,
        limit: values.limit ? Number(values.limit) : 25,
      }));
      break;
    }

    case "get-workout": {
      const key = argv[0] ?? die("Usage: get-workout <workoutKey>");
      out(await suunto.getWorkout(key));
      break;
    }

    case "get-workout-samples": {
      const key = argv[0] ?? die("Usage: get-workout-samples <workoutKey>");
      out(await suunto.getWorkoutSamples(key));
      break;
    }

    case "get-workout-fit": {
      const { values, positionals } = parseArgs({
        args: argv,
        options: { full: { type: "boolean", default: false } },
        allowPositionals: true,
      });
      const key = positionals[0] ?? die("Usage: get-workout-fit <workoutKey> [--full]");
      const bytes = await suunto.getWorkoutFit(key);
      const parsed = await parseFit(bytes);
      out(values.full ? parsed : summarizeFit(parsed));
      break;
    }

    case "export-workout-gpx": {
      const key = argv[0] ?? die("Usage: export-workout-gpx <workoutKey>");
      const bytes = await suunto.getWorkoutGpx(key);
      process.stdout.write(new TextDecoder().decode(bytes) + "\n");
      break;
    }

    case "get-daily-activity": {
      const date = argv[0] ?? die("Usage: get-daily-activity <YYYY-MM-DD>");
      out(await suunto.getDailyActivity(date));
      break;
    }

    case "list-daily-activity": {
      const { values } = parseArgs({
        args: argv,
        options: {
          from: { type: "string" },
          to: { type: "string" },
        },
      });
      if (!values.from || !values.to) die("Usage: list-daily-activity --from YYYY-MM-DD --to YYYY-MM-DD");
      out(await suunto.listDailyActivity(values.from!, values.to!));
      break;
    }

    case "get-sleep": {
      const date = argv[0] ?? die("Usage: get-sleep <YYYY-MM-DD>");
      out(await suunto.getSleep(date));
      break;
    }

    case "list-sleep": {
      const { values } = parseArgs({
        args: argv,
        options: {
          from: { type: "string" },
          to: { type: "string" },
        },
      });
      if (!values.from || !values.to) die("Usage: list-sleep --from YYYY-MM-DD --to YYYY-MM-DD");
      out(await suunto.listSleep(values.from!, values.to!));
      break;
    }

    case "get-recovery": {
      const date = argv[0] ?? die("Usage: get-recovery <YYYY-MM-DD>");
      out(await suunto.getRecovery(date));
      break;
    }

    case "list-recovery": {
      const { values } = parseArgs({
        args: argv,
        options: {
          from: { type: "string" },
          to: { type: "string" },
        },
      });
      if (!values.from || !values.to) die("Usage: list-recovery --from YYYY-MM-DD --to YYYY-MM-DD");
      out(await suunto.listRecovery(values.from!, values.to!));
      break;
    }

    case "list-subscriptions": {
      out(await suunto.subscriptions());
      break;
    }

    default:
      die(`Unknown command: ${cmd}. Run with --help for usage.`);
  }
} catch (err: any) {
  die(err.message ?? String(err));
}
