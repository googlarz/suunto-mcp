import { parseArgs } from "node:util";
import { loadConfig, assertCredentials } from "./config.js";
import { SuuntoClient } from "./api.js";
import { parseFit, summarizeFit } from "./fit.js";

function die(msg: string): never {
  console.error(`suunto-mcp: ${msg}`);
  process.exit(1);
}

function out(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export const HELP = `
Usage: suunto-mcp <command> [options]

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
  sync-to-health-skill --health-root <path> [--person-id ID] [--since YYYY-MM-DD]
                        Exports step data as a health-skill-compatible CSV and
                        imports it via care_workspace.py. Steps only — HRV/RHR/
                        VO2max/SpO2 have no genuine match in Suunto's API and
                        aren't force-mapped.
  daily-digest          <YYYY-MM-DD>
                        Builds a color-coded health digest (steps, sleep,
                        recovery, HRV, CTL/ATL/TSB training load) for one
                        date and appends it to SUUNTO_HISTORY.md (override
                        with SUUNTO_DIGEST_HISTORY_PATH). Running totals are
                        persisted in ~/.suunto-mcp/averages.json (override
                        with SUUNTO_DIGEST_AVERAGES_PATH) — Suunto's API has
                        no fitness/fatigue endpoint, so this is computed and
                        stored locally.

All commands output JSON to stdout. Pipe to jq for filtering:
  suunto-mcp list-workouts --limit 5 | jq '.payload[].sport'

(MCP stdio server starts automatically when stdin is piped.)
`.trim();

export async function runCli(argv: string[]) {
  const [cmd, ...rest] = argv;

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
          args: rest,
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
        const key = rest[0] ?? die("Usage: get-workout <workoutKey>");
        out(await suunto.getWorkout(key));
        break;
      }

      case "get-workout-samples": {
        const key = rest[0] ?? die("Usage: get-workout-samples <workoutKey>");
        out(await suunto.getWorkoutSamples(key));
        break;
      }

      case "get-workout-fit": {
        const { values, positionals } = parseArgs({
          args: rest,
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
        const key = rest[0] ?? die("Usage: export-workout-gpx <workoutKey>");
        const bytes = await suunto.getWorkoutGpx(key);
        process.stdout.write(new TextDecoder().decode(bytes) + "\n");
        break;
      }

      case "get-daily-activity": {
        const date = rest[0] ?? die("Usage: get-daily-activity <YYYY-MM-DD>");
        out(await suunto.getDailyActivity(date));
        break;
      }

      case "list-daily-activity": {
        const { values } = parseArgs({
          args: rest,
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
        const date = rest[0] ?? die("Usage: get-sleep <YYYY-MM-DD>");
        out(await suunto.getSleep(date));
        break;
      }

      case "list-sleep": {
        const { values } = parseArgs({
          args: rest,
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
        const date = rest[0] ?? die("Usage: get-recovery <YYYY-MM-DD>");
        out(await suunto.getRecovery(date));
        break;
      }

      case "list-recovery": {
        const { values } = parseArgs({
          args: rest,
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

      case "sync-to-health-skill": {
        const { values } = parseArgs({
          args: rest,
          options: {
            "health-root": { type: "string" },
            "person-id": { type: "string" },
            since: { type: "string" },
          },
        });
        const healthRoot = values["health-root"] ?? die("Usage: sync-to-health-skill --health-root <path> [--person-id ID] [--since YYYY-MM-DD]");
        const { exportHealthCsv, importIntoHealthSkill } = await import("./export-health.js");
        const result = await exportHealthCsv(cfg, {
          healthRoot,
          personId: values["person-id"],
          since: values.since,
        });
        if (result.skippedNote) console.error(result.skippedNote);
        if (result.rowCount === 0) {
          console.log("No new days to sync.");
          break;
        }
        const importOutput = importIntoHealthSkill(result.csvPath, healthRoot, values["person-id"]);
        console.log(`Exported ${result.rowCount} day(s) to ${result.csvPath}`);
        console.log(importOutput);
        break;
      }

      case "daily-digest": {
        const date = rest[0] ?? die("Usage: daily-digest <YYYY-MM-DD>");
        const { generateDigest } = await import("./daily-digest.js");
        const result = await generateDigest({
          suunto,
          averagesPath: cfg.digestAveragesPath,
          historyPath: cfg.digestHistoryPath,
          date,
        });
        console.log(result.markdown);
        console.log(`Appended to ${cfg.digestHistoryPath}`);
        break;
      }

      default:
        die(`Unknown command: ${cmd}. Run 'suunto-mcp --help' for usage.`);
    }
  } catch (err: any) {
    die(err.message ?? String(err));
  }
}
