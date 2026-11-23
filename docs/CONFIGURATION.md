# Configuration: environment variables and local files

Moved out of the [README](../README.md).

## Environment variables

Set these in the `env` block of your Claude config (or in `.env` for terminal commands).

| Variable | Needed | What it does |
|---|---|---|
| `SUUNTO_CLIENT_ID`, `SUUNTO_CLIENT_SECRET`, `SUUNTO_SUBSCRIPTION_KEY` | yes | Your apizone credentials |
| `SUUNTO_DEMO` | no | `1` runs the server on synthetic data with no credentials and no network; see "Try it without an account" |
| `SUUNTO_APP_NAME` | to push guides | Exact app name registered on apizone |
| `SUUNTO_REDIRECT_URI` | no | OAuth callback; default `http://localhost:8421/callback` (must match apizone) |
| `SUUNTO_TOKEN_PATH` | no | Token file; default `~/.suunto-mcp/tokens.json` |
| `SUUNTO_TOKEN_STORAGE` | no | `keychain` to store tokens in the OS keychain |
| `SUUNTO_NO_BROWSER` | no | Don't open a browser during pairing; copy the URL yourself |
| `SUUNTO_DIGEST_HISTORY_PATH`, `SUUNTO_DIGEST_AVERAGES_PATH` | no | Where the daily digest writes |
| `SUUNTO_CACHE_DIR`, `SUUNTO_CACHE` | no | Folder of `get_exercise_history`'s cache (default `~/.suunto-mcp/cache/`); `SUUNTO_CACHE=off` turns the cache off |
| `SUUNTO_JOURNAL_PATH` | no | The `log_session` journal file; default `~/.suunto-mcp/journal.json` |
| `SUUNTO_PLAN_PATH` | no | The `set_plan` / `get_plan` plan file; default `~/.suunto-mcp/plan.json` |
| `SUUNTO_SEEN_PATH` | no | The `get_catchup` marker file; default `~/.suunto-mcp/seen.json` |
| `SUUNTO_PREDICTIONS_PATH` | no | The prediction ledger (`log_prediction`, `score_predictions`); default `~/.suunto-mcp/predictions.json` |
| `SUUNTO_EXPERIMENTS_PATH` | no | The `start_experiment` file (schedule, seed and day log); default `~/.suunto-mcp/experiments.json` |
| `SUUNTO_APPROVALS_PATH` | no | The approval queue (`queue_adjustment`, `list_approvals`, `resolve_approval`); default `~/.suunto-mcp/approvals.json` |
| `SUUNTO_ARCHIVE_DIR` | no | Folder of the `archive_workouts` archive (FIT files and workout summaries); default `~/.suunto-mcp/archive/` |
| `SUUNTO_IMPORT_DIR` | no | Folder of the `import_workouts` store (the imported files and their records); default `~/.suunto-mcp/imported/` |
| `SUUNTO_REPORTS_DIR` | no | Folder where `get_weekly_report` with `save: true` writes `week-<Monday>.md`; default `~/.suunto-mcp/reports/` |
| `SUUNTO_ENABLE_LEGACY_TOOLS` | no | `1` lists the three hidden tools (`get_workout_samples`, `export_workout_gpx`, `list_subscriptions`) that Suunto's servers no longer answer |
| `SUUNTO_DAILY_PREFIX` | no | Path prefix of the 24/7 (sleep, recovery, daily activity) endpoints; default `/247samples`. Only change it if your apizone entitlement uses another one |
| `SUUNTO_HEALTH_EXPORT_STATE_PATH` | no | State file of `sync-to-health-skill` (which days were already copied); default `~/.suunto-mcp/health-export-state.json` |
| `SUUNTO_WRITE_GAP_MS`, `SUUNTO_ROUTE_IMPORT_GAP_MS`, `SUUNTO_ROUTE_VERIFY_DELAY_MS`, `SUUNTO_UPLOAD_POLL_MS` | no | Pacing of writes to Suunto in milliseconds (all default to 2000 except the route read-back delay, 3000): the pause between guide pushes and workout uploads, between route imports, before a route is read back, and between upload status polls. Leave them alone unless you are testing |
| `SUUNTO_WEBHOOK_SECRET`, `SUUNTO_WEBHOOK_HOST`, `SUUNTO_WEBHOOK_LOG`, `SUUNTO_WEBHOOK_ALLOW_UNSIGNED`, `PORT` | webhook only | See the Webhooks section |


## Local files

Besides the tokens, suunto-mcp keeps these on your computer (all under `~/.suunto-mcp/` unless you move them with the variables above; files `0600`, and a folder the tool creates `0700`: an existing folder you point a variable at keeps the mode it has):

- `cache/<workoutKey>.json` — what `get_exercise_history` derived from a finished guided session (exercises, loads, sets, rest recovery; a few KB, never the raw FIT file). Sessions under 24 hours old are not cached. Safe to delete at any time: it is rebuilt on the next call (`rm -rf ~/.suunto-mcp/cache`). `SUUNTO_CACHE=off` stops it being read or written.
- `journal.json` — what you told `log_session`. Entries made from a confirmed `draft_session_log` are marked in a separate `sources` list in the same file (an older 1.0 server still reads every entry, but drops that list if it writes the journal). This is your own record, nothing rebuilds it: delete it (`rm -f ~/.suunto-mcp/journal.json`) only if you want it gone.
- `predictions.json` — the prediction ledger: every prediction you logged (what, when, the probability, the rule) and, once scored, its outcome. Nothing in it is ever edited or removed by the server (a void adds a reason). Your own record; delete it only if you want to start the scores over. A damaged, foreign or newer-version file is refused and left untouched: fix or delete it.
- `experiments.json` — your self-experiments: the pre-registered hypothesis and analysis plan, the random seed, the whole schedule and what you logged each day (a corrected day keeps its earlier answer). Never rewritten or deleted by the server, even when an experiment is stopped. Same refusal rule for a damaged or newer-version file.
- `approvals.json` — the approval queue: changes prepared for you (an adjusted guide, a week of guides) with their reasons, and what you decided. Nothing in it is pushed unless you approve with `push` set. Version 1, mode 0600; a damaged or newer-version file is refused and left untouched. `get_data_overview` lists this and every other file.
- `plan.json` — the training plan you set with `set_plan` (goal, phases, planned sessions). Your own record too; it is never sent to Suunto or the watch. A damaged file is refused, not overwritten: fix or delete it.
- `seen.json` — the small marker `get_catchup` uses to know what is new (the workouts already reported, the latest night and recovery sample seen, and the day its review window starts). Only written when `markSeen: true` is passed. Safe to delete: the next call looks back 7 days again. A damaged file stops the call and is never overwritten.
- `archive/<workoutKey>.fit` and `archive/<workoutKey>.json` — what `archive_workouts` copied from Suunto: the FIT file as Suunto sent it, and the workout's summary from the list plus the FIT's size and SHA-256 (the `.json` is written last and marks the workout as archived). A few hundred KB per workout, so a few years of training is some hundred MB. Your own copy of your data: nothing rebuilds a file you delete except calling `archive_workouts` again, which downloads it again. The tool never overwrites or deletes anything: a file that is damaged, foreign or does not match its record is reported and left for you to fix or move. Files are linked into place under a temporary name, so not even a second process can overwrite one (the folder's filesystem must support hard links). A FIT file with no record, left by an interrupted call, is listed as `incomplete` by `get_archive_status` and completed by the next `archive_workouts`. `estimate_route_time` reads these FIT files to learn your pace; `get_exercise_history`, `get_training_load` and the other tools still read from Suunto, not from the archive.
- `imported/<id>.fit|gpx|tcx` and `imported/<id>.json` — what `import_workouts` copied from the folder you named: the file exactly as given, and a record (source label, format, size, SHA-256, a summary read from it) written last as the mark "imported". `<id>` is the first 16 hex digits of the SHA-256, so the same file is never stored twice. Kept apart from `archive/`, which holds only what Suunto sent. Same rules as the archive: never overwritten or deleted by the server, files 0600 and the folder 0700, a damaged, foreign or newer record is reported and left alone.
- `reports/week-<Monday>.md` — what `get_weekly_report` wrote when you passed `save: true`: plain markdown for sharing, never any account id, token or workout key. A file that exists with different content is never replaced unless `overwrite: true` is passed. Your own copy: delete it whenever you like. `estimate_route_time` only reads the `archive/` files above and writes nothing.
