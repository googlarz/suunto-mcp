# Advanced: npm install, Claude Code, CLI, webhooks, keychain

Moved out of the [README](../README.md).

## Install from npm instead of cloning the code

The package is published on npm as [`suunto-mcp`](https://www.npmjs.com/package/suunto-mcp), so you can skip Step 5 (no `git clone`, no build). You still need Node.js 20 or newer and the credentials from Part 1.

**Pair your account (replaces Step 7).** Run these in a terminal, with your own values:

```bash
export SUUNTO_CLIENT_ID=your-client-id SUUNTO_CLIENT_SECRET=your-client-secret SUUNTO_SUBSCRIPTION_KEY=your-subscription-key
npx -p suunto-mcp suunto-mcp-auth
npx -p suunto-mcp suunto-mcp-doctor
```

The first command opens the browser pairing page and saves your tokens to `~/.suunto-mcp/tokens.json`; the second checks that everything is connected.

**Connect to Claude Desktop (replaces Step 10).** Use `npx` instead of a path to the code:

```json
{
  "mcpServers": {
    "suunto": {
      "command": "npx",
      "args": ["-y", "suunto-mcp"],
      "env": {
        "SUUNTO_CLIENT_ID": "your-client-id",
        "SUUNTO_CLIENT_SECRET": "your-client-secret",
        "SUUNTO_SUBSCRIPTION_KEY": "your-subscription-key"
      }
    }
  }
}
```

The first start downloads the package, so it can take a few seconds. To stay on one version, write `"suunto-mcp@<version>"` in `args` (for example the current one from [npm](https://www.npmjs.com/package/suunto-mcp)). In Claude Code: `claude mcp add suunto -e SUUNTO_CLIENT_ID=... -e SUUNTO_CLIENT_SECRET=... -e SUUNTO_SUBSCRIPTION_KEY=... -- npx -y suunto-mcp`.


## Using with Claude Code instead of Claude Desktop

Run this in a terminal (use your own values and the real path to this folder), then `claude mcp list` to verify it's loaded:

```bash
claude mcp add suunto -e SUUNTO_CLIENT_ID=your-client-id -e SUUNTO_CLIENT_SECRET=your-client-secret -e SUUNTO_SUBSCRIPTION_KEY=your-subscription-key -- node /full/path/to/suunto-mcp/dist/index.js
```

Add `-e SUUNTO_APP_NAME=your-app-name` if you want to push guided workouts.


## CLI — query your data from the terminal

After building, you can query Suunto data directly without Claude. From the cloned folder use `node dist/index.js <command>`; with the npm package use `npx suunto-mcp <command>` (or just `suunto-mcp` if installed globally):

```bash
node dist/index.js list-workouts --limit 10
node dist/index.js get-workout <workoutKey>
node dist/index.js get-workout-laps <workoutKey>
node dist/index.js get-daily-snapshot 2026-04-20
node dist/index.js get-daily-snapshot 2026-04-14 --to 2026-04-20
node dist/index.js get-sleep 2026-04-20
node dist/index.js list-recovery --from 2026-04-01 --to 2026-04-30
```

Other commands: `list-approvals [ID] [--status S]` and `get-data-overview` (local files only, no credentials), `propose-next-week [MONDAY] [--rules JSON]` and `simulate-plan <DATE:TSS|DATE:TITLE>... [--goal-date D] [--as-of D] [--compare ENTRY]...` (the read-only mirrors of the two planning tools; they print, and write nothing), `get-plan [date]` (the plan from `set_plan`, local file only), `get-catchup` (what is new since the last `markSeen`; the terminal never moves the marker), `get-tag-effects [--days N] [--tag T]`, `get-benchmark --guide TITLE | --exercise NAME [--weeks N]`, `get-archive-status` (reads the archive folder only, no credentials; `archive_workouts` is MCP-only because it writes), `get-weekly-report [MONDAY] [--markdown]` (never saves: use the MCP tool for that), `estimate-route-time <routeId> [--activity walking|running] [--sunset ISO] [--margin MIN]`, `get-workout-fit`, `get-training-load`, `compare-workout`, `get-workout-rest-profile`, `list-routes`, `get-route`, `export-route`, `get-daily-activity`, `list-daily-activity`, `list-sleep`, `get-recovery`, `daily-digest`, `sync-to-health-skill`. Run it with `--help` for the full list and every option. Output is JSON (pipe into `jq` for filtering), except `export-route`, which prints GPX.


## Webhooks — get notified the moment a workout syncs

```bash
npm run webhook
```

Starts an HTTP receiver on port 8422 that logs workout events as they arrive. It listens on `127.0.0.1` only, so expose it through a tunnel (cloudflared, ngrok) or a reverse proxy and register the URL in apizone → webhooks.

**Set `SUUNTO_WEBHOOK_SECRET`** to the notification secret you configure in apizone's OAuth application settings. Every request is verified against Suunto's `X-HMAC-SHA256-Signature` header and rejected with 401 if it doesn't match. Without the secret the receiver rejects *everything* (set `SUUNTO_WEBHOOK_ALLOW_UNSIGNED=1` only for local testing). Other options: `PORT`, `SUUNTO_WEBHOOK_HOST` (default `127.0.0.1`), `SUUNTO_WEBHOOK_LOG` (default `~/.suunto-mcp/webhooks.ndjson`, written private and capped at 100 MB).

Most users can skip this whole section — asking Claude on demand is simpler.


## Keychain — store credentials more securely

To store your Suunto login tokens in your OS keychain (macOS Keychain, Windows Credential Manager) instead of a file:

```bash
SUUNTO_TOKEN_STORAGE=keychain npm install @napi-rs/keyring
SUUNTO_TOKEN_STORAGE=keychain npm run auth
```

