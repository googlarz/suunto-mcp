<p align="center">
  <img src="assets/logo.svg" alt="Suunto MCP" width="640"/>
</p>

# Suunto MCP

[![CI](https://github.com/googlarz/suunto-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/googlarz/suunto-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Bring your Suunto watch into the conversation.**

> ⏳ **Status: awaiting API access.** I've applied for a Suunto apizone API
> key and am waiting on approval. Until then, the code is implemented
> end-to-end against the documented Suunto API surface but has not been
> verified against a live account. Expect to file at least one issue once
> real credentials land. PRs from anyone with API access already are very
> welcome.

This is a small bridge that lets AI assistants like Claude read your Suunto
training data — runs, hikes, sleep, recovery — so you can just *talk* to your
watch.

> _Built by a Suunto user (hi 👋) who wanted to ask his coach-shaped
> chatbot "how was my last long run?" instead of clicking through
> dashboards — and to plug live training data into a personal
> [health-skill](https://github.com/googlarz/health-skill) for context-aware
> health Q&A._

---

## What can you do with it?

Once it's set up, you can ask things like:

- *"How many kilometers did I run this month?"*
- *"Compare my last three long runs — was my heart rate drift better?"*
- *"Pull the GPX of yesterday's hike and write a short journal entry."*
- *"What's my average resting HR trend over the last 2 weeks?"*
- *"Find every workout above 160bpm average and show me the route."*
- *"Summarize my training week in the style of a coaching report."*

The AI does the work. You just ask.

## Is this for me?

**Yes, if** you own any modern Suunto watch (Race, Vertical, 9 Peak, 5 Peak,
Ocean, etc.) and you sync it to the Suunto app on your phone.

**No coding required to use it** — just follow the setup below. The hard part
(parsing Suunto's API, refreshing tokens, decoding the binary FIT file format)
is already done for you.

---

## How it works (in one picture)

```
Your Suunto watch ─► Suunto app ─► Suunto cloud ─► Suunto MCP ─► Claude (or any MCP client)
```

This project is the second-to-last box. It speaks Suunto on one side and the
Model Context Protocol on the other.

---

## Prerequisites

- A Suunto watch synced to the Suunto app (your data must already be in
  Suunto's cloud — this tool reads from there, not the watch directly)
- **Node.js ≥ 20** ([nodejs.org](https://nodejs.org) — install if needed)
- An MCP-capable client: Claude Desktop, Claude Code, Cursor, or any
  MCP-compatible app
- ~10 minutes if you already have an apizone account, ~25 minutes from scratch

## Setup

### 1. Get a Suunto API key

Suunto opened their platform to all developers in March 2026 — anyone can
sign up. **Publishing to the Suunto store needs a partner agreement;
personal use doesn't.**

1. Go to [apizone.suunto.com](https://apizone.suunto.com/) → **Sign up**.
2. Once signed in, click **Apps** → **Create app**. Give it any name (e.g.
   "Personal MCP"). For **redirect URI** use exactly:
   ```
   http://localhost:8421/callback
   ```
3. From the app overview page, copy the **Client ID** and **Client Secret**
   (you may need to click *Regenerate* to reveal the secret once).
4. Click **Subscribe to APIs** and subscribe your app to **all** of these
   products — each is a separate subscription:
   - **Workouts API** (required)
   - **Activity API** — for steps, calories, daily HR
   - **Sleep API** — for sleep stages and score
   - **Recovery API** — for HRV / recovery score
   - **Subscriptions API** — for webhook management

   Without a subscription, calls to that product return **403/404**.
5. Go to your **user profile** → **Subscriptions** tab and copy the
   **primary subscription key**. This is the `Ocp-Apim-Subscription-Key`
   that Suunto's Azure API Management gateway requires on every call.

> 🛟 If you can't find a value, run `npm run doctor` after step 3 below —
> it will tell you exactly which one is missing or wrong.

### 2. Install

```bash
git clone https://github.com/googlarz/suunto-mcp
cd suunto-mcp
npm install
npm run build
```

> A `Dockerfile` is also included for containerized deployments and for
> [glama.ai](https://glama.ai/mcp/servers/googlarz/suunto-mcp)'s automated
> introspection checks.

### 3. Configure

```bash
cp .env.example .env
$EDITOR .env   # paste the 3 values from step 1
```

### 4. Pair your Suunto account

```bash
npm run auth
```

Your browser opens automatically to Suunto's authorization page. Click
**Authorize**. The page redirects back to a local success screen and tokens
are saved to `~/.suunto-mcp/tokens.json` (mode `0600`). You only do this
once — the server refreshes tokens automatically.

> If the browser doesn't open, copy the URL from the terminal manually.
> Set `SUUNTO_NO_BROWSER=1` to disable the auto-open behavior.

### 5. Verify it works

```bash
npm run doctor
```

This runs an end-to-end health check: Node version, env vars, network
reachability, token freshness, a live `list_workouts` probe, and which
24/7 products you're subscribed to. Fix any `✗` lines before moving on.

### 6. Plug into Claude

#### Claude Desktop

Edit (creating if missing):

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

#### Claude Code

Edit `~/.claude/mcp_config.json` (or run `claude mcp add` if your version
supports the CLI flow).

#### Config (works for both)

**Once published to npm** (no clone needed):

```json
{
  "mcpServers": {
    "suunto": {
      "command": "npx",
      "args": ["-y", "suunto-mcp"],
      "env": {
        "SUUNTO_CLIENT_ID": "...",
        "SUUNTO_CLIENT_SECRET": "...",
        "SUUNTO_SUBSCRIPTION_KEY": "..."
      }
    }
  }
}
```

**From a local clone:**

```json
{
  "mcpServers": {
    "suunto": {
      "command": "node",
      "args": ["/absolute/path/to/suunto-mcp/dist/index.js"],
      "env": {
        "SUUNTO_CLIENT_ID": "...",
        "SUUNTO_CLIENT_SECRET": "...",
        "SUUNTO_SUBSCRIPTION_KEY": "..."
      }
    }
  }
}
```

Restart Claude. Quick sanity check — ask:

> *"What was my most recent workout?"*

If you get a real answer with sport, distance, and date, you're connected.

---

## Example conversation

```
You:    Compare my last three long runs. Has my heart-rate drift improved?

Claude: Pulling your recent workouts… (calls list_workouts)
        Found 3 runs over 90 minutes in the last 6 weeks:
          • Apr 12 — 22.4 km, 2h09, avg HR 148, last-30min drift +6 bpm
          • Apr 19 — 24.0 km, 2h21, avg HR 144, last-30min drift +4 bpm
          • Apr 26 — 25.1 km, 2h28, avg HR 142, last-30min drift +2 bpm
        Drift is trending down despite slightly longer runs — your aerobic
        base is improving. Pace at the same HR is also ~3 s/km faster.
```

---

## Tools exposed to the AI

**Workouts**

| Tool                  | What it does                                                  |
|-----------------------|---------------------------------------------------------------|
| `list_workouts`       | Recent workouts, filter by date range, auto-paginates         |
| `get_workout`         | Full summary for one workout                                  |
| `get_workout_samples` | Time-series HR / pace / altitude / power / GPS                |
| `get_workout_fit`     | Downloads the FIT file and returns parsed, structured JSON    |
| `export_workout_gpx`  | GPX track export — for maps, Strava, route planning           |

**24/7 health data** (requires the Activity / Sleep / Recovery API products to be enabled on your apizone subscription)

| Tool                  | What it does                                                  |
|-----------------------|---------------------------------------------------------------|
| `get_daily_activity`  | Steps, calories, daily HR for a single day                    |
| `list_daily_activity` | Steps, calories, daily HR for a date range                    |
| `get_sleep`           | Sleep stages, duration, score for a night                     |
| `list_sleep`          | Sleep data over a date range                                  |
| `get_recovery`        | Recovery / HRV / stress for a single day                      |
| `list_recovery`       | Recovery data over a date range                               |

**Webhooks**

| Tool                  | What it does                                                  |
|-----------------------|---------------------------------------------------------------|
| `list_subscriptions`  | Active webhook subscriptions on the account                   |

The AI picks the right one for your question. You don't need to know which.

---

## Optional: webhooks

Suunto can push notifications to you the moment a new workout finishes
syncing — no polling.

```bash
npm run webhook
```

This starts a tiny HTTP receiver on port 8422 that logs every event to
`~/.suunto-mcp/webhooks.ndjson`. Expose it to the public internet (cloudflared,
ngrok, your own VPS) and register the URL in your Suunto app settings.

For most personal setups, skip this. Polling on demand is simpler.

---

## Pairs well with `health-skill`

If you already use [googlarz/health-skill](https://github.com/googlarz/health-skill)
— a Claude skill for symptom triage, lab interpretation, and lifestyle
guidance — Suunto MCP gives it a live feed of your training, sleep, and
recovery data. Together they answer questions like *"is my resting HR drift
this week consistent with the cold I had?"* or *"given my recovery scores,
should I keep this week's intervals?"* with real numbers instead of guesses.

## Privacy

As of v0.1:

- All data flows **directly between your machine and Suunto's API**. No
  third-party servers, no analytics.
- Tokens are stored locally at `~/.suunto-mcp/tokens.json` (mode `0600`),
  or in your OS keychain if you opted in.
- Suunto sees that *an app called "Suunto MCP"* is authorized on your
  account (visible in apizone → user profile → Authorized applications).
- The AI only sees data it explicitly requests via tools or resources.

If a future version offers a hosted-proxy option for non-tech users, this
section will be updated explicitly. The default will always remain
local-first.

---

## Troubleshooting

**Run `npm run doctor` first** — it pinpoints most issues automatically.

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required env vars` | `.env` not loaded or not filled in | `cp .env.example .env`, fill it, retry |
| `Not authenticated` / `SuuntoNotAuthenticatedError` | Tokens missing | Run `npm run auth` |
| `Token request failed: 400` | Wrong client secret, or redirect URI doesn't match apizone exactly | Re-copy from apizone, ensure `http://localhost:8421/callback` is registered |
| `SuuntoAuthError (401)` on every call | Subscription key wrong or expired | Re-copy primary key from apizone → user profile → Subscriptions |
| `SuuntoForbiddenError (403)` on `list_workouts` | App not subscribed to the Workouts product | apizone → your app → Subscribe to APIs → Workouts |
| `404` on `get_sleep` / `get_recovery` / `get_daily_activity` | App not subscribed to that 24/7 product | Subscribe in apizone (each product is separate) |
| Empty workout list | Watch hasn't synced to the Suunto cloud | Open Suunto app on your phone, wait for sync |
| `npm run auth` hangs / browser never opens | Port 8421 already in use, or running headless | `lsof -i :8421` to check; set `SUUNTO_NO_BROWSER=1` and copy URL manually |
| OAuth callback page says "State mismatch" | Started a second auth flow before the first finished | Close all auth tabs and run `npm run auth` once |
| Tokens "disappear" after switching to keychain | File-based tokens don't migrate automatically | Re-run `npm run auth` after enabling keychain |

## Disconnecting / cleanup

To remove access:

1. **Revoke the OAuth grant on Suunto's side** — log in to apizone → user
   profile → Authorized applications → remove your app. Suunto stops
   honoring the tokens immediately.
2. **Delete local tokens**:
   ```bash
   rm -f ~/.suunto-mcp/tokens.json
   ```
   If you were using the keychain backend, delete the entry named
   `suunto-mcp / tokens` in your OS keychain (Keychain Access on macOS,
   etc.).
3. **Remove the MCP entry** from your Claude config and restart Claude.
4. **Optional — delete your apizone app** if you no longer want it
   listed as a registered application.

---

## MCP Resources (ambient context)

In addition to tools, the server exposes **resources** — passive data the
client can pull without the model having to call a tool:

| URI | What |
|---|---|
| `suunto://recent/workout` | Most recent workout summary |
| `suunto://today/sleep` | Last night's sleep |
| `suunto://today/recovery` | Today's recovery / HRV |
| `suunto://today/activity` | Today's steps / calories / HR |
| `suunto://this-week/summary` | Aggregated training totals for the current ISO week |

Clients that surface MCP resources (Claude Desktop, Cursor) will let you
attach these directly into a conversation — useful for "given my recovery
today, should I…" style questions.

## Reliability

- **Automatic retries** with exponential backoff + jitter on `429`, `500`,
  `502`, `503`, `504` (up to 4 attempts).
- **`Retry-After` header is honored** when Suunto returns one.
- **Auto-pagination** in `list_workouts` — keeps fetching pages until your
  `limit` is met or there's nothing left.
- **Token refresh is automatic** — the access token is silently re-issued
  before each request if it's within 60 seconds of expiry.
- **Concurrent-refresh deduplication** — multiple parallel calls share a
  single in-flight refresh, so Suunto never sees a double `refresh_token`
  grant (which would invalidate the older token and log you out).
- **Structured error types** — `SuuntoAuthError`, `SuuntoForbiddenError`,
  `SuuntoNotFoundError`, `SuuntoRateLimitError`, `SuuntoApiError`,
  `SuuntoNotAuthenticatedError`, `SuuntoTokenError`. Lets clients
  distinguish "re-authenticate" from "wait and retry" from "this resource
  doesn't exist."

## Token storage

By default, tokens are written to `~/.suunto-mcp/tokens.json` with file
mode `0600`. For stronger protection, opt into the OS keychain
(macOS Keychain, Linux libsecret, Windows Credential Manager):

```bash
SUUNTO_TOKEN_STORAGE=keychain npm install @napi-rs/keyring
SUUNTO_TOKEN_STORAGE=keychain npm run auth
```

The keychain backend is an optional dependency — `npm install` will not
fail if it can't be built on your platform; it just falls back to the
file-based default.

## Health check

```bash
npm run doctor
```

Output:

```
Suunto MCP — health check

  ✓  Node version                     20.18.0 (require ≥ 20)
  ✓  Credentials                      client_id, client_secret, subscription_key set
  ✓  Network → cloudapi-oauth.suunto.com  reachable (HTTP 302)
  ✓  Pairing                          paired (user: dawid), token expires in 47 min
  ✓  API probe (list_workouts)        received 1 workout (latest: 1714137600000)
  ✓  Daily activity product           subscribed
  !  Sleep product                    not subscribed on apizone
  ✓  Recovery product                 subscribed
```

Run this whenever something feels off. It pinpoints the exact failing
layer (Node, env, network, auth, API quota, missing product subscription).

## Tests

```bash
npm test
```

40 unit + integration tests cover:
- OAuth URL building, code exchange, refresh, token-expiry refresh logic
- Concurrent-refresh deduplication (4 parallel calls → 1 token request)
- Token storage (round-trip, file permissions, missing-file fallback, parent-dir creation)
- API client: bearer + subscription-key headers, retry on 429/500 with `Retry-After`, no retry on 4xx, byte-stream downloads
- Structured error types (`SuuntoAuthError`, `SuuntoForbiddenError`, `SuuntoNotFoundError`, `SuuntoRateLimitError`)
- `list_workouts` auto-pagination across multiple pages
- FIT integration: parser accepts a minimum-valid byte stream, rejects garbage and empty input
- FIT summary extraction, empty-FIT handling, record sampling
- MCP resources: enumeration, dispatch, today's-date wiring, week aggregation
- Config loading, env overrides, missing-credential errors

CI runs on Node 20 and 22 on every push and PR.

## Roadmap

- [ ] Webhook subscription management tools (create / delete / renew)
- [ ] Webhook signature verification
- [ ] Cached workout index for faster "this month" queries
- [ ] Workout Upload API (push third-party workouts back to Suunto)
- [ ] HTTP / SSE transport (currently stdio only)
- [ ] Recorded API fixture for end-to-end tests

PRs welcome.

---

## Credits

- [Suunto APIzone](https://apizone.suunto.com/) — the people who opened the door
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard this server speaks
- [`fit-file-parser`](https://www.npmjs.com/package/fit-file-parser) — for decoding FIT binaries

## License

MIT. Use it, fork it, improve it.
