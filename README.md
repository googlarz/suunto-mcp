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

## Setup

### 1. Get a Suunto API key

Suunto opened their platform to all developers in March 2026 — anyone can
sign up.

1. Go to [apizone.suunto.com](https://apizone.suunto.com/) and create an account.
2. Create a new app. You'll be asked for a redirect URI — use:
   ```
   http://localhost:8421/callback
   ```
3. Note three values from your app dashboard:
   - **Client ID**
   - **Client Secret**
   - **Subscription Key** (this is the Azure API Management key Suunto uses)

> Publishing to the Suunto store needs a partner agreement. **Personal use
> doesn't.** You can use your own app credentials with your own account
> immediately.

### 2. Install

```bash
git clone https://github.com/YOUR-USERNAME/suunto-mcp
cd suunto-mcp
npm install
npm run build
```

### 3. Configure

```bash
cp .env.example .env
# Open .env and paste in your three values from step 1.
```

### 4. Pair your Suunto account

```bash
npm run auth
```

This prints a URL. Open it in your browser, log in to Suunto, click
**Authorize**. The page will redirect back and confirm the pairing. Tokens are
saved (encrypted, mode 600) to `~/.suunto-mcp/tokens.json`.

You only do this once. The MCP server refreshes tokens automatically.

### 5. Plug into Claude

#### Claude Desktop / Claude Code

Add to your MCP config (e.g. `~/.claude/mcp_config.json` or the equivalent in
Claude Desktop):

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

Restart Claude. Ask: *"What Suunto tools do you have?"* — and you're off.

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

- All data flows **directly between your machine and Suunto's API.**
- Tokens are stored locally at `~/.suunto-mcp/tokens.json` with file mode 600.
- Nothing is sent anywhere else. No analytics, no third-party servers.
- The AI only sees what you (or your prompt) explicitly ask for.

---

## Troubleshooting

**"Not authenticated"** → run `npm run auth` again.

**"Token request failed: 401"** → your client secret or subscription key is
wrong, or your redirect URI doesn't match the one registered in the Suunto
portal exactly.

**"Suunto API 403"** → the access token doesn't have the scope for that
endpoint, or your subscription key isn't entitled to that product. Check your
app's API subscriptions on apizone.suunto.com.

**Empty workout list** → make sure your watch has actually synced to the
Suunto app. The cloud is the source — if it's not in the phone app, it's not
in the API.

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
