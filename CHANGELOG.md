# Changelog

Versions on npm: 0.14.1, 0.14.4, 0.15.1 and later. The tags v0.14.0, v0.14.2, v0.14.3, v0.14.5 and v0.15.0 exist on GitHub but were never published to npm. Pre-0.15.1 notes are in the GitHub Releases.

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
