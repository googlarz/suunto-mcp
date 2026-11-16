import { parseArgs } from "node:util";
import { loadConfig, assertCredentials } from "./config.js";
import { SuuntoClient } from "./api.js";
import { parseFit, summarizeFit } from "./fit.js";
import { LAP_EXTENSIONS, shapeLaps } from "./laps.js";
import { buildSnapshot, buildSnapshotRange } from "./snapshot.js";
import { buildTrainingLoad, forecastTrainingLoad } from "./training-load.js";
import { compareWorkout } from "./compare.js";
import { buildRestProfile } from "./rest-profile.js";
import { buildExerciseHistory } from "./history.js";
import { filePlanStore, getPlan } from "./plan.js";
import { buildCatchup, fileSeenStore } from "./catchup.js";
import { buildTagEffects } from "./tag-effects.js";
import { buildBenchmark } from "./benchmark.js";
import { archiveStatus, fileArchiveStore } from "./archive.js";
import { buildWeeklyReport, fileReportStore } from "./report.js";
import { estimateRouteTime } from "./route-time.js";
import { filePredictionStore, predictionStats } from "./predictions.js";
import { analyzeExperiment, fileExperimentStore, getExperiment } from "./experiments.js";
import { buildDraft } from "./draft.js";
import { proposeNextWeek } from "./propose-week.js";
import { simulatePlan } from "./simulate-plan.js";
import { fileApprovalStore, listApprovals } from "./approvals.js";
import { dataOverview } from "./data-overview.js";

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
  get-workout-laps     <workoutKey>
  get-workout-fit      <workoutKey> [--full]
  get-workout-samples  <workoutKey>   (currently rejected by Suunto)
  export-workout-gpx   <workoutKey>   (currently rejected by Suunto)

Analysis commands:
  get-training-load    <YYYY-MM-DD> [--days N]
  forecast-training-load <YYYY-MM-DD:TSS>... [--as-of YYYY-MM-DD]   (CTL/ATL/TSB for planned days, from today's values)
  propose-next-week    [MONDAY YYYY-MM-DD] [--rules JSON]   (next week's strength sessions from your plan, your logged lifts and recovery, with reasons, a forecast and a risk note; read-only: prints the proposal, writes nothing)
  simulate-plan        <YYYY-MM-DD:TSS | YYYY-MM-DD:TITLE>... [--goal-date D] [--as-of D] [--compare ENTRY]...   (what-if: CTL/ATL/TSB day by day, ramp, risk days, your own response when your history allows; model-based, read-only)
  compare-workout      <workoutKey>   (laps only, no plan comparison)
  get-workout-rest-profile <workoutKey>
  get-exercise-history [name] [--weeks N]   (load, sets, rest recovery per session; writes only the local cache)
  get-plan             [YYYY-MM-DD]   (the plan from set_plan: today and the next 7 days, or one day; reads the local plan file only)
  list-approvals       [ID] [--status pending|expired|done|all]   (the approval queue: what waits for a yes; reads the local file only, no credentials; deciding is MCP-only: resolve_approval)
  get-data-overview    (every local file the server keeps: path, version, size, counts, mode warnings, unreadable or newer-version files; reads the files only, no credentials, changes nothing)
  get-tag-effects      [--days N] [--tag T] [--date YYYY-MM-DD]   (journal tags against the next night's sleep, HRV and recovery; read-only)
  get-benchmark        --guide TITLE | --exercise NAME [--weeks N]   (a repeatable session over time: load, rest HR, duration, TSS; writes only the local cache)
  get-archive-status   (what the local workout archive holds; reads the archive folder only, no credentials)
  get-weekly-report    [MONDAY YYYY-MM-DD] [--markdown]   (a finished week: workouts, sleep and recovery against your usual, training load, plan, tags; prints JSON or just the markdown; never saves: use the MCP tool with save for that)
  get-prediction-stats (how good the logged predictions were: hit rate, Brier score, calibration, per kind and rule; reads the local ledger only, no credentials; log, void and score with the MCP tools)
  get-experiment       [ID]   (self-experiments: status, today's assignment, adherence; with an id the full schedule and log; reads the local file only, no credentials)
  analyze-experiment   [ID] [--early]   (permutation test, intention to treat and per protocol; --early is exploratory; read-only)
  draft-session-log    <workoutKey> | --date YYYY-MM-DD   (a proposed log_session payload from the watch data, every rep and weight assumed; prints it, never logs it)
  get-catchup          (what is new since the last markSeen: workouts, nights, recovery, plan items; never moves the marker, use the MCP tool with markSeen for that)

Route commands:
  list-routes
  get-route            <routeId>
  export-route         <routeId>   (prints the GPX text)
  estimate-route-time  <routeId> [--activity walking|running] [--sunset ISO-WITH-OFFSET] [--margin MINUTES]   (the route's time from your own archived pace, else generic Naismith; read-only)

24/7 health commands:
  get-daily-activity   <YYYY-MM-DD>
  list-daily-activity  --from YYYY-MM-DD --to YYYY-MM-DD
  get-daily-snapshot   <YYYY-MM-DD> [--to YYYY-MM-DD]
  get-sleep            <YYYY-MM-DD>
  list-sleep           --from YYYY-MM-DD --to YYYY-MM-DD
  get-recovery         <YYYY-MM-DD>
  list-recovery        --from YYYY-MM-DD --to YYYY-MM-DD

Other:
  list-subscriptions   (currently rejected by Suunto)
  sync-to-health-skill --health-root <path> [--person-id ID] [--since YYYY-MM-DD]
                        Exports step data as a health-skill-compatible CSV and
                        imports it via care_workspace.py. Steps only — HRV/RHR/
                        VO2max/SpO2 have no genuine match in Suunto's API and
                        aren't force-mapped. Only finished days are exported.
                        --since re-exports that window even if already synced,
                        and health-skill does not dedupe: those days are stored
                        twice.
  daily-digest          <YYYY-MM-DD> [--seed-ctl N --seed-atl N]
                        Builds a color-coded health digest (steps, sleep,
                        recovery, HRV, CTL/ATL/TSB training load) for one
                        date and appends it to SUUNTO_HISTORY.md (override
                        with SUUNTO_DIGEST_HISTORY_PATH). Running totals are
                        persisted in ~/.suunto-mcp/averages.json (override
                        with SUUNTO_DIGEST_AVERAGES_PATH) — Suunto's API has
                        no fitness/fatigue endpoint, so this is computed and
                        stored locally. --seed-ctl/--seed-atl only apply on
                        the very first run: pass the Fitness/Fatigue values
                        shown on your watch to skip the ~4-6 week cold-start.

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

  // only reads the local plan file, so it needs no Suunto credentials
  if (cmd === "get-plan") {
    if (rest.length > 1) die("Usage: get-plan [YYYY-MM-DD]");
    try {
      out(await getPlan(filePlanStore(), { date: rest[0] }));
    } catch (err: any) {
      die(err.message ?? String(err));
    }
    return;
  }

  // these two only read local files, so they need no Suunto credentials either (queue_adjustment and resolve_approval are MCP-only: they write)
  if (cmd === "list-approvals") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { status: { type: "string" } } });
    if (positionals.length > 1) die("Usage: list-approvals [ID] [--status pending|expired|done|all]");
    try {
      out(await listApprovals(fileApprovalStore(), { status: values.status, id: positionals[0] }));
    } catch (err: any) {
      die(err.message ?? String(err));
    }
    return;
  }
  if (cmd === "get-data-overview") {
    if (rest.length > 0) die("Usage: get-data-overview (it takes no options)");
    try {
      out(await dataOverview());
    } catch (err: any) {
      die(err.message ?? String(err));
    }
    return;
  }

  // only reads the local archive folder, so it needs no Suunto credentials either (archive_workouts is MCP-only: it writes)
  if (cmd === "get-archive-status") {
    if (rest.length > 0) die("Usage: get-archive-status (it takes no options)");
    try {
      out(await archiveStatus(fileArchiveStore()));
    } catch (err: any) {
      die(err.message ?? String(err));
    }
    return;
  }

  // these two only read their local files, so they need no Suunto credentials either
  if (cmd === "get-prediction-stats") {
    if (rest.length > 0) die("Usage: get-prediction-stats (it takes no options)");
    try {
      out(predictionStats(await filePredictionStore().load()));
    } catch (err: any) {
      die(err.message ?? String(err));
    }
    return;
  }
  if (cmd === "get-experiment") {
    if (rest.length > 1) die("Usage: get-experiment [ID]");
    try {
      out(await getExperiment(fileExperimentStore(), { id: rest[0] }));
    } catch (err: any) {
      die(err.message ?? String(err));
    }
    return;
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

      case "get-workout-laps": {
        const key = rest[0] ?? die("Usage: get-workout-laps <workoutKey>");
        out(shapeLaps(await suunto.getWorkoutWithExtensions(key, LAP_EXTENSIONS)));
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

      case "get-training-load": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { days: { type: "string" } } });
        const date = positionals[0] ?? die("Usage: get-training-load <YYYY-MM-DD> [--days N]");
        const days = values.days !== undefined ? Number(values.days) : undefined;
        if (days !== undefined && !Number.isInteger(days)) die(`--days must be a whole number, got "${values.days}"`);
        out(await buildTrainingLoad(suunto, { date, days }));
        break;
      }

      case "forecast-training-load": {
        const usage = "Usage: forecast-training-load <YYYY-MM-DD:TSS>... [--as-of YYYY-MM-DD]";
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "as-of": { type: "string" } } });
        if (positionals.length === 0) die(usage);
        const days = positionals.map((p) => {
          const [date, tss, ...extra] = p.split(":");
          if (!date || tss === undefined || tss === "" || extra.length > 0 || !Number.isFinite(Number(tss))) die(`"${p}" is not DATE:TSS (e.g. 2026-11-17:60). ${usage}`);
          return { date, tss: Number(tss) };
        });
        out(await forecastTrainingLoad(suunto, { days, asOf: values["as-of"] }));
        break;
      }

      case "propose-next-week": {
        const usage = "Usage: propose-next-week [MONDAY YYYY-MM-DD] [--rules JSON, e.g. '{\"deloadPct\":15}']";
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { rules: { type: "string" } } });
        if (positionals.length > 1) die(usage);
        let rules: unknown;
        if (values.rules !== undefined) {
          try {
            rules = JSON.parse(values.rules);
          } catch {
            die(`--rules must be a JSON object, got "${values.rules}". ${usage}`);
          }
        }
        out(await proposeNextWeek(suunto, filePlanStore(), { ...(positionals[0] !== undefined ? { weekStart: positionals[0] } : {}), ...(rules !== undefined ? { rules } : {}) }));
        break;
      }

      case "simulate-plan": {
        const usage = "Usage: simulate-plan <YYYY-MM-DD:TSS | YYYY-MM-DD:TITLE>... [--goal-date YYYY-MM-DD] [--as-of YYYY-MM-DD] [--compare ENTRY]...  (ENTRY is DATE:TSS or DATE:TITLE, repeated for each session of the compared plan)";
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "goal-date": { type: "string" }, "as-of": { type: "string" }, compare: { type: "string", multiple: true } } });
        if (positionals.length === 0) die(usage);
        // DATE:TSS when what follows the first colon is a number, else DATE:TITLE (a title may hold colons)
        const session = (entry: string) => {
          const at = entry.indexOf(":");
          const [date, what] = at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
          if (!date || what === "") die(`"${entry}" is not DATE:TSS or DATE:TITLE (e.g. 2026-11-17:60 or 2026-11-17:PUSH A). ${usage}`);
          return Number.isFinite(Number(what)) ? { date, tss: Number(what) } : { date, title: what };
        };
        out(
          await simulatePlan(suunto, {
            sessions: positionals.map(session),
            ...(values["goal-date"] !== undefined ? { goalDate: values["goal-date"] } : {}),
            ...(values["as-of"] !== undefined ? { asOf: values["as-of"] } : {}),
            ...(values.compare !== undefined ? { compare: { sessions: values.compare.map(session) } } : {}),
          }),
        );
        break;
      }

      case "compare-workout": {
        const key = rest[0] ?? die("Usage: compare-workout <workoutKey>");
        const data = await suunto.getWorkoutWithExtensions(key, LAP_EXTENSIONS);
        out(compareWorkout(shapeLaps(data)));
        break;
      }

      case "get-workout-rest-profile": {
        const key = rest[0] ?? die("Usage: get-workout-rest-profile <workoutKey>");
        const data = await suunto.getWorkoutWithExtensions(key, LAP_EXTENSIONS);
        const parsed = await parseFit(await suunto.getWorkoutFit(key));
        out(buildRestProfile(shapeLaps(data), parsed));
        break;
      }

      case "get-exercise-history": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { weeks: { type: "string" } } });
        const weeks = values.weeks !== undefined ? Number(values.weeks) : undefined;
        if (weeks !== undefined && !Number.isInteger(weeks)) die(`--weeks must be a whole number, got "${values.weeks}"`);
        out(await buildExerciseHistory(suunto, { name: positionals[0], weeks }));
        break;
      }

      case "get-tag-effects": {
        const usage = "Usage: get-tag-effects [--days N] [--tag T] [--date YYYY-MM-DD]";
        const { values } = parseArgs({ args: rest, options: { days: { type: "string" }, tag: { type: "string" }, date: { type: "string" } } });
        const days = values.days !== undefined ? Number(values.days) : undefined;
        if (days !== undefined && !Number.isInteger(days)) die(`--days must be a whole number, got "${values.days}". ${usage}`);
        out(await buildTagEffects(suunto, { date: values.date, days, tag: values.tag }));
        break;
      }

      case "get-benchmark": {
        const usage = "Usage: get-benchmark --guide TITLE | --exercise NAME [--weeks N]";
        const { values } = parseArgs({ args: rest, options: { guide: { type: "string" }, exercise: { type: "string" }, weeks: { type: "string" } } });
        const weeks = values.weeks !== undefined ? Number(values.weeks) : undefined;
        if (weeks !== undefined && !Number.isInteger(weeks)) die(`--weeks must be a whole number, got "${values.weeks}". ${usage}`);
        if ((values.guide === undefined) === (values.exercise === undefined)) die(usage);
        out(await buildBenchmark(suunto, { guide: values.guide, exercise: values.exercise, weeks }));
        break;
      }

      case "get-weekly-report": {
        const usage = "Usage: get-weekly-report [MONDAY YYYY-MM-DD] [--markdown]";
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { markdown: { type: "boolean", default: false } } });
        if (positionals.length > 1) die(usage);
        const report = await buildWeeklyReport(suunto, { week: positionals[0] }, { planStore: filePlanStore(), reportStore: fileReportStore() });
        if (values.markdown) process.stdout.write(report.markdown);
        else out(report);
        break;
      }

      case "analyze-experiment": {
        const usage = "Usage: analyze-experiment [ID] [--early]";
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { early: { type: "boolean", default: false } } });
        if (positionals.length > 1) die(usage);
        out(await analyzeExperiment(suunto, fileExperimentStore(), { id: positionals[0], early: values.early }));
        break;
      }

      case "draft-session-log": {
        const usage = "Usage: draft-session-log <workoutKey> | --date YYYY-MM-DD";
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { date: { type: "string" } } });
        if (positionals.length > 1 || (positionals.length === 1) === (values.date !== undefined)) die(usage);
        out(await buildDraft(suunto, { workoutKey: positionals[0], date: values.date }));
        break;
      }

      case "get-catchup": {
        if (rest.length > 0) die("Usage: get-catchup (it takes no options and never moves the marker)");
        out(await buildCatchup(suunto, fileSeenStore(), filePlanStore(), {}, new Date(), fileApprovalStore()));
        break;
      }

      case "get-route": {
        const id = rest[0] ?? die("Usage: get-route <routeId>");
        out(await suunto.getRoute(id));
        break;
      }

      case "list-routes": {
        out(await suunto.listRoutes());
        break;
      }

      case "export-route": {
        const id = rest[0] ?? die("Usage: export-route <routeId>");
        const bytes = await suunto.exportRoute(id);
        process.stdout.write(new TextDecoder().decode(bytes) + "\n");
        break;
      }

      case "estimate-route-time": {
        const usage = "Usage: estimate-route-time <routeId> [--activity walking|running] [--sunset 2026-11-15T16:05:00+01:00] [--margin MINUTES]";
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { activity: { type: "string" }, sunset: { type: "string" }, margin: { type: "string" } } });
        const routeId = positionals[0] ?? die(usage);
        if (positionals.length > 1) die(usage);
        const marginMinutes = values.margin !== undefined ? Number(values.margin) : undefined;
        out(await estimateRouteTime(suunto, fileArchiveStore(), { routeId, activity: values.activity as any, sunset: values.sunset, marginMinutes }));
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

      case "get-daily-snapshot": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { to: { type: "string" } } });
        const date = positionals[0] ?? die("Usage: get-daily-snapshot <YYYY-MM-DD> [--to YYYY-MM-DD]");
        if (values.to === "") die("Usage: get-daily-snapshot <YYYY-MM-DD> [--to YYYY-MM-DD] (--to needs a date)");
        out(values.to && values.to !== date ? await buildSnapshotRange(suunto, date, values.to) : await buildSnapshot(suunto, date));
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
        const { exportHealthCsv, importIntoHealthSkill, saveLastExportedDate } = await import("./export-health.js");
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
        // Commit the watermark only after the import actually succeeds — if
        // it throws, runCli's outer catch reports the error and the next
        // run retries this same window instead of silently skipping it.
        const importOutput = importIntoHealthSkill(result.csvPath, healthRoot, values["person-id"]);
        if (result.maxDate) saveLastExportedDate(result.maxDate);
        console.log(`Exported ${result.rowCount} day(s) to ${result.csvPath}`);
        console.log(importOutput);
        break;
      }

      case "daily-digest": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            "seed-ctl": { type: "string" },
            "seed-atl": { type: "string" },
          },
          allowPositionals: true,
        });
        const date = positionals[0] ?? die("Usage: daily-digest <YYYY-MM-DD> [--seed-ctl N --seed-atl N]");
        // Number("abc") is NaN, not an error — validate explicitly so a typo
        // doesn't silently poison the CTL/ATL sidecar (JSON.stringify(NaN)
        // becomes null, corrupting every digest run after this one).
        const parseSeed = (raw: string | undefined, flag: string): number | undefined => {
          if (raw === undefined) return undefined;
          const n = Number(raw);
          if (!Number.isFinite(n)) die(`${flag} must be a number, got "${raw}"`);
          return n;
        };
        const seedCtl = parseSeed(values["seed-ctl"], "--seed-ctl");
        const seedAtl = parseSeed(values["seed-atl"], "--seed-atl");
        const { generateDigest } = await import("./daily-digest.js");
        const result = await generateDigest({
          suunto,
          averagesPath: cfg.digestAveragesPath,
          historyPath: cfg.digestHistoryPath,
          date,
          seedCtl,
          seedAtl,
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
