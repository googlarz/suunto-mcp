<p align="center">
  <img src="assets/logo.svg" alt="Suunto MCP" width="640"/>
</p>

# Suunto MCP

[![CI](https://github.com/googlarz/suunto-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/googlarz/suunto-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/suunto-mcp.svg)](https://www.npmjs.com/package/suunto-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![suunto-mcp MCP server](https://glama.ai/mcp/servers/googlarz/suunto-mcp/badges/score.svg)](https://glama.ai/mcp/servers/googlarz/suunto-mcp)

**Ask Claude anything about your training.** Suunto MCP connects your Suunto watch data to Claude so you can just talk to your data instead of clicking through dashboards.

> *Built by a Suunto user who wanted to ask "how was my last long run?" and get a real answer with numbers — and to feed live training data into a personal AI coach.*

> 🏃 **For regular Suunto users:** Suunto's API docs say access is for commercial partners only — **that's not the full picture.** Private users get access too. It just takes **3–4 weeks** for approval after you apply. Submit, wait, enjoy. Don't let that disclaimer stop you. ✅

## What you can do

Once it's set up, just ask:

- *"How many kilometers did I run this month?"*
- *"Compare my last three long runs — has my heart-rate drift improved?"*
- *"How did my heart rate hold up set by set in last night's gym session?"*
- *"What's my average resting HR trend over the last two weeks?"*
- *"Summarize my training week in the style of a coaching report."*
- *"I've been feeling off — how do my recovery scores compare to last month?"*
- *"Find every workout where I averaged above 160 bpm."*
- *"Which of my runs this year had the most elevation?"*
- *"What should next week's gym sessions look like, given what I actually lifted?"*
- *"If I add a hard session on Thursday, where does my form end up on race day?"*

Claude figures out what data to pull. You just ask.

It's not just read-only either — Claude can push things to your watch too:

- *"Plan tonight's gym session and send it to my watch."*
- *"Upload yesterday's Garmin export as a Suunto workout."*
- *"Export my last route as GPX so I can share it."*

See [What you can push to your watch](docs/TOOLS.md#what-you-can-push-to-your-watch) in the docs.

---

## 🤖 Don't want to do this yourself? Let Claude Code install it

If you already have [Claude Code](https://claude.ai/code), you don't need to run a single terminal command. Just open it and say:

> *"Please install and set up suunto-mcp from https://github.com/googlarz/suunto-mcp"*

Claude Code will clone the repo, run all the install commands, and add everything to your Claude Desktop config — on its own. That's exactly how this project's author set it up: no manual terminal work.

Three things stay yours no matter what, by design, not because of missing tooling:
1. **Creating the apizone.suunto.com account** — Claude can't create accounts on your behalf.
2. **The apizone web form** (naming your app, revealing your subscription key) — it's your account session; Claude tells you exactly where to click, but can't click there for you.
3. **Clicking "Authorize"** during login — that's OAuth working as intended. An app that could approve its own access wouldn't be secure.

Claude will tell you exactly what to do and when for each of these.

**If you want to do it manually, keep reading.**

---

## What you need

Before starting, make sure you have:

- [ ] **A Suunto watch** synced to the Suunto app (any modern model — Race, Vertical, 9 Peak, 5 Peak, Ocean, etc.)
- [ ] **Claude Desktop** (or another MCP-compatible AI app)
- [ ] **Node.js** — free, [download here](https://nodejs.org), choose the "LTS" version
- [ ] **Git** — free, [download here](https://git-scm.com/downloads)
- [ ] **~5 min to submit** + 3–4 week wait for Suunto approval + ~15 min to install

Once it's done, you never redo it.

---

## Quick start

**Try it in about 5 minutes, with no Suunto account.** Suunto takes 3–4 weeks to approve API access, but you don't have to wait to see what this does. With `SUUNTO_DEMO=1` the server runs on realistic **synthetic** data (about 8 weeks, ending today) with no credentials and no network. Only Node.js is required. Add this to the `mcpServers` block of your Claude Desktop config (the file from [Step 9](docs/SETUP.md#step-9-open-the-claude-config-file)), then restart Claude:

```json
{
  "mcpServers": {
    "suunto-demo": {
      "command": "npx",
      "args": ["-y", "suunto-mcp"],
      "env": { "SUUNTO_DEMO": "1" }
    }
  }
}
```

Every demo answer is marked `"demo": true`, so you can't mistake it for real data. What works and what does not in demo mode: [Try it without an account](docs/SETUP.md#try-it-without-an-account-demo-mode).

**Prefer a single file to double-click?** The [one-click `.mcpb` bundle](docs/SETUP.md#one-click-install-mcpb-bundle) opens in Claude Desktop (not yet verified in a real host).

**Using your own watch data** takes three parts. The full steps, with screenshots-in-words for each click, are in [docs/SETUP.md](docs/SETUP.md):

1. **Register with Suunto's developer portal** (about 5 minutes to submit, then the 3–4 week wait) — [Part 1](docs/SETUP.md#part-1-register-with-suuntos-developer-portal-5-min-to-submit-then-wait-34-weeks).
2. **Install and configure** the server on your computer (about 10 minutes) — [Part 2](docs/SETUP.md#part-2-install-and-configure-10-min-after-suunto-approves-you).
3. **Connect it to Claude Desktop** (about 5 minutes) — [Part 3](docs/SETUP.md#part-3-connect-to-claude-desktop-5-min).

If something goes wrong: [Troubleshooting](docs/SETUP.md#troubleshooting) and the [FAQ](docs/FAQ.md).

---

## Safety at a glance

- **Reading is the default.** Most tools only read your Suunto data. Tools that write to your Suunto account (`upload_*`, `push_*`, `delete_guide`) say so in their description and are marked as writes, so Claude or your MCP app can ask you first.
- **The approval queue never pushes on its own.** Planning tools (`set_plan`, `propose_next_week`, `adjust_guide`, `simulate_plan`, `queue_adjustment`) never push anything. `push_week_plan` does a dry run unless `dryRun: false` is passed, and `resolve_approval` is the one place where your explicit approval becomes a push. The direct tools (`push_workout_guide`, `push_interval_guide`, `push_strength_guide`, `upload_workout`, `upload_route`, `delete_guide`) act as soon as they are called: your MCP app's permission prompt is the gate there, so don't set it to allow them without asking. See [Approvals](docs/TOOLS.md#approvals-nothing-reaches-your-watch-without-your-yes).
- **Your own notes stay honest.** What you log (`log_session`, predictions, experiments) is stored locally and is never invented: the watch records only a guide's planned text, so weights and reps come from you.
- **Everything saved is a local file** in `~/.suunto-mcp/`. `get_data_overview` lists the journal, plan, catch-up marker, predictions, experiments, approval queue and the cache, archive and reports folders. It does not cover `tokens.json`, the daily digest's history and averages, the webhook log or the `imported/` folder. Remove everything as described in [Disconnecting](docs/SETUP.md#disconnecting).

## Privacy

- All data flows **directly between your computer and Suunto's servers**. No third-party servers, no analytics.
- Your login credentials are stored locally at `~/.suunto-mcp/tokens.json` — not uploaded anywhere.
- Suunto shows your connected app as "suunto-mcp" in apizone → profile → Authorized applications. You can revoke it there at any time.
- The AI only sees data it explicitly requests for your question — not your entire history at once.
- Everything suunto-mcp saves (tokens, plan, journal, cache, workout archive, imported workouts, saved weekly reports) stays on your computer as local files; none of it is uploaded to any service. The only network calls are to Suunto's API, and nothing else is sent anywhere: no analytics, no crash reports, no telemetry. What the AI app (for example Claude) receives is what a tool returns for your question. Workout files you import (`import_workouts`) are read from the folder you name, copied byte for byte into `~/.suunto-mcp/imported/` and go nowhere else; that tool never contacts Suunto or any network.
- Demo mode makes no network calls at all and writes no files; its data is generated on your computer.
- A weekly report's markdown (`get_weekly_report`) holds no account id, token, workout key or file path, but it does contain your own numbers, plan goal and session titles, so read it before you share it.

---

## Not yet verified on real devices

None of the following has been checked against a real watch or real Suunto files; the tests use synthetic data. Treat each as open until you have seen it work on your own: how guide titles and popups look on a real watch; guides dated in the future; the FIT integrity and heart-rate quality checks; the unit of `recoveryTime`, `pte` and `peakEpoc`; the statistics behind `get_tag_effects`, predictions, experiments, `propose_next_week` and `simulate_plan`; `estimate_route_time`; `import_workouts` on real Garmin, Strava or Apple exports; the approval queue's push; the `.mcpb` bundle. The complete list, each with its detail, is in [docs/LIMITS.md](docs/LIMITS.md). What stays stable from release to release, and what does not, is in [docs/CONTRACT.md](docs/CONTRACT.md).

---

## Documentation

| Document | What is in it |
|---|---|
| [Setup, troubleshooting, upgrading, disconnecting](docs/SETUP.md) | The full step-by-step setup (demo mode, one-click bundle, the three parts), what to do when something breaks, how to upgrade and how to remove everything |
| [Tools and what to ask](docs/TOOLS.md) | Example conversations, the data available, what you can push to your watch, prompts, the daily digest, predictions and experiments, planning next week, approvals, and the full tool reference |
| [Full tool descriptions](docs/TOOL-DETAILS.md) | The complete 1.3.0 wording of every tool description, with the output fields and long explanations |
| [Configuration](docs/CONFIGURATION.md) | Every environment variable and every local file |
| [Known limits](docs/LIMITS.md) | What has not been verified on a real watch |
| [FAQ](docs/FAQ.md) | Short answers to common questions |
| [Advanced](docs/ADVANCED.md) | Install from npm, use with Claude Code, the command-line tool, webhooks, keychain storage |
| [GETTING_STARTED.md](GETTING_STARTED.md) | One guided walkthrough with a pacing choice up front |
| [docs/CONTRACT.md](docs/CONTRACT.md) | What stays compatible within 1.x |
| [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) | Release notes, how to contribute, how to report a vulnerability |

---

## Credits

- [Suunto APIzone](https://apizone.suunto.com/) — for opening their API to everyone
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard this speaks
- [`fit-file-parser`](https://www.npmjs.com/package/fit-file-parser) — FIT binary decoding

## License

MIT — use it, fork it, improve it.
