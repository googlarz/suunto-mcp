# Changelog

Versions on npm: 0.14.1, 0.14.4, 0.15.1 and later. The tags v0.14.0, v0.14.2, v0.14.3, v0.14.5 and v0.15.0 exist on GitHub but were never published to npm. Pre-0.15.1 notes are in the GitHub Releases.

## 0.21.0
- MCP prompts (new `prompts` capability): `suunto-morning`, `suunto-weekly` and `suunto-gym-today`, one-click workflows in clients that show prompts. Each takes an optional date (`date` or `endDate`), validated as a real calendar date (invalid values are an invalid-params error), and writes the explicit dates and tool calls into the prompt text.
- `get_workout_samples`, `export_workout_gpx` and `list_subscriptions` are no longer listed to the model: Suunto rejects them (OperationNotFound). Calling one by name returns an error saying so. Set `SUUNTO_ENABLE_LEGACY_TOOLS=1` to bring them back. The CLI commands are unchanged.
- `push_workout_guide`, `push_interval_guide`, `push_strength_guide` and `upload_workout` now report whether the write arrived, not only that it was sent. Guide pushes read the guide back from the guide list (by id, by name if Suunto returned no id) and add `check: { verified, note? }`. `upload_workout` polls the upload status for up to about 20 s and adds `status` and `check: { verified, note? }` (`verified` once the status is `Processed`). Existing result fields are unchanged.
- Guide pushes and workout uploads are queued one at a time per process with a short pause (`SUUNTO_WRITE_GAP_MS`, default 2000), like route imports since 0.19.2, so several calls at once are safe. `SUUNTO_UPLOAD_POLL_MS` (default 2000) sets the pause between upload status polls.
- New tool `get_training_load` (read-only): Fitness (CTL), Fatigue (ATL) and Form (TSB) per day for up to 120 days ending at `date` (default 28), with weekly totals, the 7-day ramp rate and `notes`. Computed from workout TSS with the digest's model; reads 120 days of warm-up before the window so it isn't cold-started from 0, or starts from `seedCtl`/`seedAtl`. CTL can be about 1 point off the watch. Reports when the 500-workout limit is reached instead of hiding it.
- The digest's CTL/ATL maths moved to `src/training-load.ts`, shared by both; digest output is unchanged.
- New tool `compare_workout_to_plan` (read-only): maps the laps of a guided gym session (`push_strength_guide` perSet or perExercise, countdown or stopwatch, and `push_workout_guide`) to exercises, sets and rests, and reports planned against actual with deviations that each name their basis (`labels`, `plan` or `heuristic`). The optional `plan` is the exercises array that was pushed (`name`, `sets`, `restSec` are read). `no-heart-rate` stays in `checks` but does not make the result unreliable. Stopwatch and workout-guide label formats are derived from the guide code and not yet checked against a real session.
- `get_workout_laps`: the description and a code comment no longer say that prep and set labels look alike (their halves are swapped) or that laps after "Session complete" have no label (they carry it). Text only, no behaviour change.

## 0.20.0
- New tool `get_route`: one route by id (distance, start/end, activities, `watchEnabled`), including routes beyond the 5 that `list_routes` returns. `list_routes` now says so in its description.

## 0.19.2
- `upload_route` imports one route at a time with a short pause and reads each route back from Suunto (point count against the file, `watchEnabled`), returning `check: { verified, … }`. Seven routes sent in the same second had left the watch with 3 of 7; the same files imported one by one all arrived. Several `upload_route` calls at once are queued by the server, so callers don't have to take care of it. `verified: false` carries a note instead of a silent success.

## 0.19.1
- Fix: `export_route` always failed with a 500 because it did not ask Suunto for GPX; it now sends `Accept: application/gpx+xml` and returns the track.

## 0.19.0
- New tool `upload_route`: imports a `.gpx` file as a route via `POST /v2/route/import` (verified live). Each `<rte>`/`<trk>` becomes its own PRIVATE route, named from the file; `activities` (default `[1]`) is set by the call, not by the GPX. Only real `.gpx` files up to 10 MB are accepted. Routes can't be deleted through the API — remove them in the Suunto app.

## 0.18.1
- **Security:** `upload_workout` accepts only `.fit` and `.gpx` files, and only uploads to an `https` URL.
- **Security:** the webhook receiver (`suunto-mcp-webhook`) listens on `127.0.0.1` by default (`SUUNTO_WEBHOOK_HOST` to change), rejects requests when `SUUNTO_WEBHOOK_SECRET` is not set (`SUUNTO_WEBHOOK_ALLOW_UNSIGNED=1` for local testing), writes its log with mode 0600 and stops appending at 100 MB.
- **Security:** the token file and its folder are created private (0600/0700) from the first write; the digest `averages.json` is written 0600. Existing files keep their old mode until they are rewritten.
- Dependencies: `npm audit` clean; `@modelcontextprotocol/sdk` floor raised to 1.31.
- `get_daily_snapshot`: an invalid `date`/`to` is an error everywhere (CLI included); reaching the workout limit is reported in `errors` instead of silently dropping workouts; limit is 25 workouts per day.
- `get_workout_laps`: a lap pressed after the guide's "Session complete" lap no longer triggers `unlabelled-laps`.
- CLI: `get-daily-snapshot --to` with no value is an error.
- CI: pinned action SHAs, read-only permissions, smoke test of the packed tarball.

## 0.18.0
- `get_daily_snapshot`: `sleep.main` adds `latencyS`, `wasoS`, `wakeBeforeOffBedS` (seconds); `recovery` adds `morning` (value at waking) and `atBedtime`. The single-day snapshot is now the one-day case of the range code.

## 0.17.0
- `get_daily_snapshot` takes an optional `to` (up to 14 days): `{ from, to, days, errors }`, four requests for the whole range. CLI: `get-daily-snapshot <date> --to <date>`.

## 0.16.0
- New tool `get_daily_snapshot`: the night before a date, the day's recovery low/high, steps, energy and workouts in one call; each section fails on its own.

## 0.15.3
- `get_workout_laps` adds `feeling` and `checks` (duplicate-rest, unlabelled-laps, no-session-complete, no-heart-rate).

## 0.15.2
- `doctor` and the "Not authenticated" error name the pairing command for npm installs (`npx -p suunto-mcp suunto-mcp-auth`). README: npm badge and an `npx` install route.

## 0.15.1
- New: `get_workout_laps` — per-set / per-rest lap table (~3 KB instead of ~550 KB FIT).
- Fixed: 24/7 day/night bucketing (rows placed by their own local date; sleep = noon-to-noon night, one row per sleep); the digest no longer records no-data days as 0 steps or a fabricated rest day; gateway errors classified (rate limit / dead endpoint / auth); blank `.env` values and the 64 KB CLI cutoff; the health bridge exports finished days only; stats accept `+0200` offsets.
- Marked unavailable: `get_workout_samples`, `export_workout_gpx`, `list_subscriptions` (rejected by Suunto).
- Published via npm trusted publishing (provenance) and the MCP registry.
