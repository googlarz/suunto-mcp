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

---

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

See [What you can push to your watch](#what-you-can-push-to-your-watch) below.

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

## Setup

> **Prefer one guided walkthrough with a pacing choice up front** (fast path
> vs. explained-step-by-step) and a proper explanation of how syncing works?
> See [GETTING_STARTED.md](GETTING_STARTED.md). What follows here is the same
> steps in reference form.

The setup has three parts:

1. **Register with Suunto's developer portal** — tells Suunto your app is allowed to read your data
2. **Install and configure** — gets the software running on your computer
3. **Connect to Claude** — lets the AI find and use it

---

### Try it without an account (demo mode)

Suunto takes 3–4 weeks to approve API access. You don't have to wait to see what this does: with `SUUNTO_DEMO=1` the server runs on realistic **synthetic** data (about 8 weeks, ending today) and needs no Suunto account, no credentials and no network. Only Node.js is required. Add this to the `mcpServers` block of the Claude Desktop config (the file from Step 9), then restart Claude:

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

What works: every read tool and the four prompts (`suunto-morning`, `suunto-weekly`, `suunto-gym-today`, `suunto-gym-review`) — workouts with guide-labelled gym laps (three sessions a week, one of them with a planted deviation for `compare_workout_to_plan` and one with a heart-rate dropout, so the `hrQuality` flag shows), one or two runs a week with TSS, nightly sleep with stages, score and HRV plus the odd nap, recovery every 30 minutes, daily steps and energy, two routes, three guides, and a small FIT file with heart rate for `get_workout_fit` and `get_workout_rest_profile`. Training load, baselines and snapshots are computed from that data by the normal code.

`log_prediction`, `void_prediction`, `score_predictions`, `get_prediction_stats`, `start_experiment`, `get_experiment`, `log_experiment_day`, `analyze_experiment`, `stop_experiment` and `draft_session_log` work too: the ledger starts with a month of synthetic predictions waiting to be scored and the experiments with one finished synthetic experiment, all in memory and never on disk. `set_plan`, `get_plan`, `get_catchup`, `archive_workouts`, `get_archive_status` and `get_weekly_report` (its `save` too) work too, on in-memory state only: the plan, the catch-up marker and the workout archive live as long as the server process and never reach the disk. `get_tag_effects` runs on a small synthetic journal (gym sessions tagged `strength`, Saturday runs `long-run`); your real journal is not read.

`push_week_plan` works as a dry run (its default: it validates the guides and returns what it would push, and contacts nothing). `propose_next_week` and `simulate_plan` work too: with no plan stored, the proposal starts from the demo programme (PUSH A, PULL B, LEGS C) and lifts the demo lifter logged, so it shows a hold and a deload; everything is generated and nothing is written. The approval queue (`queue_adjustment`, `list_approvals`, `resolve_approval`) and `get_data_overview` work on the in-memory stores; `resolve_approval` with `push: true` never pushes there.

What does not: anything else that writes (`upload_workout`, `upload_route`, `push_*_guide`, `push_week_plan` with `dryRun: false`, `delete_guide`, `generate_daily_digest`, `log_session`) writes nothing and only returns a short note on what it would do with real credentials. `get_upload_status` has no uploads to find.

You can't mistake demo data for real data: every tool result is JSON with a top-level `"demo": true` (a result that is a list, or text such as a GPX file, comes back as `{ "demo": true, "data": … }`), the server's instructions and the prompts say the data is synthetic, and the startup line says DEMO MODE. Errors are unchanged. `npm run doctor` with `SUUNTO_DEMO=1` just reports that demo mode is on. When your API access arrives, remove `SUUNTO_DEMO` and follow the setup below. Demo mode applies to the MCP server only, not to the terminal commands.

---

### One-click install (.mcpb bundle)

If you do not want to touch a terminal to try it, a `.mcpb` file is a single file you open with Claude Desktop. It carries its own copy of the server and its libraries, so installing it and using **demo mode** needs no Git, no `npm` and no setup of your own. (It still needs a Node.js runtime to run: the manifest asks the host for Node 20 or newer, and Claude Desktop is expected to provide one for extensions, which has not been checked here. Pairing your own account does need Node.js on your computer: see step 4.)

**What you do (plain steps):**

1. Get `suunto-mcp-<version>.mcpb`. There is no download link yet: whoever maintains your copy builds it with `npm run pack:mcpb` (it appears in the `build/` folder), or you build it yourself from the cloned folder the same way.
2. Double-click the file, or open Claude Desktop and drag it into **Settings, Extensions**. Claude shows an install screen; click **Install**.
3. The screen has a few boxes. Leave **Demo mode** ticked and everything else empty: you can ask Claude about a made-up training history straight away, with no Suunto account. Every answer is marked as demo data.
4. To use your own data later, three things are needed, and the file does not replace any of them:
   - **Suunto's developer API access** (the 3-4 week approval in Part 1 below; there is no way around it).
   - **Your three values in the boxes**: untick **Demo mode**, fill in the client ID, client secret and subscription key from apizone.suunto.com, restart Claude. Claude Desktop stores these as sensitive values.
   - **One-time pairing, in a terminal, with Node.js 20 or newer installed on your computer** (download it from nodejs.org; the bundle's own copy is not something you can run from a terminal). Run `npx -y -p suunto-mcp suunto-mcp-auth` with the same three values set as environment variables in that terminal (`SUUNTO_CLIENT_ID`, `SUUNTO_CLIENT_SECRET`, `SUUNTO_SUBSCRIPTION_KEY`; and the redirect address from Step 3 must be registered on apizone). Your browser opens, you approve, and the tokens are saved to `~/.suunto-mcp/tokens.json`, which the bundle then reads. The bundle adds no new sign-in: this is the same `suunto-mcp-auth` as Step 7 (`npm run auth` in a cloned folder also works, and needs Git as well).

**What is in the file:** `manifest.json`, the compiled server (`dist/`), its production dependencies (`node_modules/`), a minimal `package.json` and the licence. Nothing else: no sources, tests, `.env`, token or credential files (the packer refuses any file with such a name, and a test checks the produced file's listing). Nothing is uploaded anywhere by the command; it only writes `build/suunto-mcp-<version>.mcpb` (the `build/` folder is not committed).

**Not verified (read before relying on it):**

- The file has not been opened in Claude Desktop or any other host: the manifest follows the published MCPB manifest spec (version 0.3), and a test starts the unpacked entry point the way a host does, but host-side behaviour is untested. In particular it is unknown how a given host writes a ticked box (the bundle accepts `true` or `1`) or an empty optional box (a blank value, or the literal `${user_config...}` text: both are treated as not set).
- No signing: the file is unsigned, so a host may warn that it comes from an unknown publisher.
- No automatic updates: a new version means a new file. The version in `manifest.json` must equal `package.json` (a test enforces it).
- No icon: the manifest declares none.
- Built as plain JavaScript (the optional OS-keychain module is left out, so `SUUNTO_TOKEN_STORAGE=keychain` is not available in the bundle); only the platform it was packed on has been checked.
- Packing needs network access once (`npm ci` of the production dependencies from `package-lock.json`).

### Part 1: Register with Suunto's developer portal (~5 min to submit, then wait 3–4 weeks)

Suunto has a free developer portal called **apizone** where you register apps that can access your data. You'll create an account, subscribe to the data plan, and register a small "app" — don't worry, there's nothing to build, it's just a name and a password you make up.

#### Step 1: Create your apizone account

Go to [apizone.suunto.com](https://apizone.suunto.com) and sign up or sign in.

**Use the same email you use for the Suunto app.** If you have a Sports Tracker account, that works too — it's the same login system.

#### Step 2: Subscribe to the Developer API

After signing in, follow the [How to start](https://apizone.suunto.com/how-to-start) guide — it walks you through subscribing to the **Developer API**. This is free and gives you access to your workout history.

> **Heads up:** Suunto's website states that API access is only for commercial partners — ignore that. Private users do get access, it just takes **3–4 weeks** for the subscription to be approved. Submit it and wait. It will come through.

> You may see other products like "Sleep API", "Recovery API", "Daily Activity API". The Developer API is enough to get started (workouts). Subscribe to the other three as well if you want sleep, recovery, steps, the daily snapshot or the daily digest — they are listed next to the Developer API, and you can also add them later.

---

> ⏳ **Stop here and wait.** Once you've subscribed, Suunto needs to approve your request. This takes **3–4 weeks**. You'll get an email when it's done. Come back to Steps 3–4 only after your subscription shows as **Active** in your apizone profile.

---

#### Step 3: Register your app *(do this after approval)*

You're going to tell Suunto: "I have a small program, here's its name and a secret password — please let it read my data."

1. Go to your [apizone profile page](https://apizone.suunto.com/profile)
2. Scroll down to **OAuth application settings**
3. Fill in the form:

   | Field | What to enter |
   |-------|--------------|
   | **App name** | `suunto-mcp` (or anything you like) |
   | **Client secret** | Make up a unique password — something only you'd know, e.g. `alice-suunto-2026` with your own name. Write it down. Don't use this exact example. |
   | **Redirect URI** | `http://localhost:8421/callback` — copy this **exactly** |

4. Click **Save**

After saving, the form shows a **Client ID** — a long code that Suunto generated for you. Copy it.

> **What are these three things?**
> — **Client ID**: your app's username, generated by Suunto
> — **Client Secret**: your app's password, chosen by you
> — **Redirect URI**: where Suunto sends you back after you approve access — must match exactly, typos break it
>
> The Client Secret is never shown again after you save. If you forget it, just set a new one in the same form.

#### Step 4: Get your subscription key *(do this after approval)*

The subscription key is a second passcode that goes on every data request. Here's how to find it:

1. Still on the [apizone profile page](https://apizone.suunto.com/profile)
2. Scroll to the **Subscriptions** section
3. Your Developer API subscription is listed there. Next to it you'll see a **Primary Key** — click the button next to it to reveal it, then copy the key.

**Save all three values** before continuing — you'll need them in Part 2:
- Client ID (from the OAuth app form above)
- Client Secret (the password you made up)
- Subscription Key (from the Subscriptions section)

---

### Part 2: Install and configure (~10 min, after Suunto approves you)

> **Used the "Let Claude Code install it" option above?** Claude already ran
> every command below — skip to [Part 3](#part-3-connect-to-claude-desktop-5-min).
> These steps are for anyone doing it by hand.

#### Step 5: Download the code

Open **Terminal** on Mac (press ⌘Space and type "Terminal") or **Command Prompt** on Windows. Then run these commands one at a time:

```bash
git clone https://github.com/googlarz/suunto-mcp
cd suunto-mcp
npm install
npm run build
```

This downloads the code, installs what it needs, and builds it. Takes 1–2 minutes. If you see any errors, check the [Troubleshooting](#troubleshooting) section.

#### Step 6: Add your credentials

You'll create a file called `.env` in the suunto-mcp folder and put your three values in it. Even if Claude is doing the rest of this for you, type these three values in yourself rather than pasting them into the chat — keeps them out of your conversation history.

**On Mac:**
```bash
cp .env.example .env
open -e .env
```

This copies the template and opens it in TextEdit. Replace each placeholder with your actual values, then save and close.

**On Windows:**
```bash
copy .env.example .env
notepad .env
```

The file looks like this — replace the parts after the `=` signs:

```
SUUNTO_CLIENT_ID=your-client-id-here
SUUNTO_CLIENT_SECRET=your-client-secret-here
SUUNTO_SUBSCRIPTION_KEY=your-subscription-key-here
```

Save and close the file.

> **Only if you want to push guided workouts to your watch** (see [What you can push](#what-you-can-push-to-your-watch)), add one more line: `SUUNTO_APP_NAME=your-app-name-here` — it must exactly match the app name you registered on apizone.suunto.com in Step 3, or the watch will reject the upload. Not needed for anything else.

#### Step 7: Pair your Suunto account

```bash
npm run auth
```

Here's exactly what happens:

**① Terminal** — you see a long URL printed and the message "Opening Suunto authorization in your browser…"

**② Browser opens** — Suunto's login page appears. It looks identical to the Suunto app login: email + password fields at the top, then "Sign in with Apple" and "Sign in with Facebook" below. Sign in with whichever you use.

**③ Permissions screen** — after logging in, a screen appears asking you to approve access for "suunto-mcp". It lists what the app will be able to read (your workouts). Click **Authorize**.

**④ Browser confirmation** — the page shows: *"Suunto MCP connected. You can close this tab."*

**⑤ Terminal confirmation** — prints: *"Paired successfully. Tokens saved."*

Done — you won't need to do this again. The connection stays active and renews itself automatically.

> **Browser didn't open automatically?** Copy the long URL from the terminal and paste it into your browser manually.

#### Step 8: Check everything is working

```bash
npm run doctor
```

This runs a health check. You should see output like:

```
Suunto MCP — health check

  ✓  Node version             20.18.0 (require ≥ 20)
  ✓  Credentials              client_id, client_secret, subscription_key set
  ✓  Network → cloudapi-oauth.suunto.com   reachable (HTTP 200)
  ✓  Pairing                  paired (user: your-username), token expires in 47 min
  ✓  API probe (list_workouts)  received 1 workout
```

The exact lines vary a little, and more appear for the Sleep, Recovery and Daily Activity products. If any line shows ✗, the message tells you exactly what to fix — resolve it before moving on. A `!` is only a warning (for example, an optional product you haven't subscribed to).

---

### Part 3: Connect to Claude Desktop (~5 min)

> **Used the "Let Claude Code install it" option?** This part is done too —
> Claude edited your config directly. Restart Claude Desktop and jump to
> [Step 11](#step-11-test-it).

Now you'll tell Claude Desktop where to find Suunto MCP.

#### Step 9: Open the Claude config file

Open this file in a text editor (create it if it doesn't exist yet):

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**Quick way on Mac** — run this in Terminal:
```bash
mkdir -p ~/Library/Application\ Support/Claude && open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Quick way on Windows** — run this in Command Prompt:
```
notepad "%APPDATA%\Claude\claude_desktop_config.json"
```
(If it asks "file not found — create it?", click Yes.)

#### Step 10: Add Suunto MCP

First, find the actual path to the suunto-mcp folder. In Terminal, while inside the folder, run:

```bash
pwd
```

It'll print something like `/Users/yourname/suunto-mcp`. Copy that.

Now paste the following into the config file. Replace `/Users/yourname/suunto-mcp` with the path you got from `pwd`, and replace the credential placeholders with your actual values.

> **If the file already has other servers configured**, don't replace the whole file — just add the `"suunto"` section alongside them. The structure must be valid JSON, so keep all the curly braces balanced. When in doubt, compare your file to the example below.
>
> **If the file is empty**, paste the whole block as-is.

```json
{
  "mcpServers": {
    "suunto": {
      "command": "node",
      "args": ["/Users/yourname/suunto-mcp/dist/index.js"],
      "env": {
        "SUUNTO_CLIENT_ID": "your-client-id",
        "SUUNTO_CLIENT_SECRET": "your-client-secret",
        "SUUNTO_SUBSCRIPTION_KEY": "your-subscription-key"
      }
    }
  }
}
```

To also push guided workouts to your watch, add one more line inside `"env"`: put a comma at the end of the `SUUNTO_SUBSCRIPTION_KEY` line, then add `"SUUNTO_APP_NAME": "your-app-name"` (exactly the app name registered on apizone) on a new line after it. If you only ask Claude about your data, you don't need it.

Anything the server needs must be in this `"env"` block — a `.env` file is only read by the terminal commands (`npm run auth`, `npm run doctor`, the CLI) when you run them from this folder.

Save the file.

#### Step 11: Test it

**Three things, in order — this is the only part of setup nothing can do for you:**

1. **Quit Claude Desktop completely.** Not just closing the window —
   ⌘Q on Mac, or right-click the icon in the taskbar → Quit on Windows.
   Config changes only load on a fresh start.
2. **Reopen Claude Desktop.**
3. **Ask it:**
   > *"What was my most recent workout?"*

If Claude answers with your actual sport, date, and distance — you're done.
If it doesn't, don't guess — go to [Troubleshooting](#troubleshooting).

---

## Example conversation

```
You:    Compare my last three long runs. Has my heart-rate drift improved?

Claude: Looking up your workouts…
        Found 3 runs over 90 minutes in the last 6 weeks:
          • Apr 12 — 22.4 km, 2h09, avg HR 148, last-30min drift +6 bpm
          • Apr 19 — 24.0 km, 2h21, avg HR 144, last-30min drift +4 bpm
          • Apr 26 — 25.1 km, 2h28, avg HR 142, last-30min drift +2 bpm
        Drift is trending down despite slightly longer runs — your aerobic
        base is improving. Pace at the same HR is also ~3 s/km faster.
```

---

## What data is available

| Category | What you can ask about | Requires |
|----------|----------------------|---------|
| **Workouts** | Any recorded activity — runs, hikes, rides, swims, ski tours. Distance, time, heart rate, pace, elevation, power, and lap-by-lap data for guided sessions. | Developer API *(already subscribed)* |
| **Sleep** | Sleep duration, stages (light/deep/REM), sleep score. | Sleep API subscription on apizone |
| **Recovery** | Recovery balance and stress state through the day (HRV comes with the sleep data). Balance is the watch's *Resources* percentage (0.96 = 96%); stress state 1 = Recovering, 2 = Active. The app's single *Recovery state* percentage is not in the API. | Recovery API subscription on apizone |
| **Daily activity** | Steps, calories, 24/7 heart rate. | Daily Activity API subscription on apizone |

To add sleep, recovery, or daily activity: go back to [apizone.suunto.com](https://apizone.suunto.com), find each product, and subscribe. Then run `npm run doctor` to confirm they're active.

---

## What you can push to your watch

Suunto MCP isn't read-only. Claude can also send things back to your account:

| You want to | Ask Claude | Requires |
|---|---|---|
| Get a gym plan on your wrist | *"Plan today's workout and send it to my watch"* | `SUUNTO_APP_NAME` set (see Step 6) |
| Upload a workout from another device | *"Upload this FIT file as a Suunto workout"* | — |
| Grab a saved route as GPX | *"Export my Sunday route as GPX"* | — |

**Guided workouts** show up as a SuuntoPlus Guide: exercise name and weight/reps on screen, lap button advances to the next one, a stopwatch (not a countdown) between exercises with a preview of what's next, a vibrate when a new exercise starts, and a "session complete" screen at the end. There's no live push to the watch itself — it appears after your phone's next normal Suunto app sync, same as any other watch data.

This pairs naturally with a coaching workflow: describe your goals, equipment, and current lifts to Claude, and it can write a real progressive program and push each session directly — see [Pairs well with health-skill](#pairs-well-with-health-skill) below for recovery-aware programming.

---

## Prompts

MCP clients that support prompts (for example Claude Desktop) list these as one-click workflows. Each fills in the exact dates and tells Claude which tools to call.

| Prompt | What it does | Optional argument |
|---|---|---|
| `suunto-morning` | Morning briefing: last night's sleep, recovery on waking (set against your own recent band), yesterday's load and workouts, how ready today is | `date` (YYYY-MM-DD, default today) |
| `suunto-weekly` | Weekly review: sleep, HRV, recovery and training load against the week before, each gym session against its plan | `endDate` (YYYY-MM-DD, default yesterday) |
| `suunto-gym-today` | Readiness gate: cut planned intensity 20-30% if last night's HRV or sleep score is below your own recent band (`get_baselines`), otherwise train as planned | `date` (YYYY-MM-DD, default today) |
| `suunto-gym-review` | Review of a day's guided gym session: sets done against the plan, deviations with their basis, heart-rate recovery in the rests; says plainly when the numbers are unreliable | `date` (YYYY-MM-DD, default today) |

---

## Daily health digest

Ask Claude *"generate my daily digest for yesterday"* and it writes a color-coded markdown summary — steps, sleep, recovery balance, HRV, and a training-load model (Fitness/Fatigue/Form) — appended to `SUUNTO_HISTORY.md` in the folder the server runs from (set `SUUNTO_DIGEST_HISTORY_PATH` to choose another file).

**Fitness (CTL), Fatigue (ATL), and Form (TSB) aren't Suunto API fields** — there's no endpoint for them. They're computed here from each workout's real `tss.trainingStressScore` using standard 42-day/7-day exponential decay, the same math training-load tools like TrainingPeaks use. The running values persist in `~/.suunto-mcp/averages.json` (override with `SUUNTO_DIGEST_AVERAGES_PATH`) since there's nowhere else to keep them.

**How close is it to the watch?** Checked on one day against the Suunto app: Fatigue matched (11), Form matched (2), Fitness came out about 1 lower (13.1 vs 14). Treat Fitness as ±1 of your watch; seed it from the app if you need it exact.

A few things worth knowing before you rely on it:
- **CTL/ATL start at 0** on first use and take 4–6 weeks to converge to a realistic number — there's no API to read your watch's own displayed Fitness/Fatigue. To skip the cold-start, tell Claude the numbers off your watch on your very first digest (*"my watch shows Fitness 42, Fatigue 38, seed the digest with those"*) — or pass `--seed-ctl 42 --seed-atl 38` on the CLI. Only works on the first-ever digest; ignored after that.
- **TSB colors match your watch's own legend** (🔵 Optimal >+10, 🟢 Balanced 0 to +10, 🟡 Compromised −10 to 0, 🔴 Strained <−10) — not an invented scale.
- **Ramp rate** (this week's CTL vs. 7 days ago) has its own scale: 🔴 above +8/week means you're loading too fast — real injury risk, not just "good progress." 🟢 +3 to +8 is building well, 🟡 −2 to +2 is holding steady, 🟠 below −2 means fitness is slipping.
- **Recovery Balance** is reported as morning (the lowest point overnight) vs. peak (the highest point that day) — they use different color scales, since peak is naturally higher than the overnight low.
- **HRV** below your normal range for 2+ days in a row, or morning recovery below 65% for 2+ days in a row, adds a note to check your blood pressure — sustained low HRV/recovery is a real physiological signal worth a second data point on.
- **Rolling baselines** track each metric separately, with a separate bucket for "party nights" (>20,000 steps) so an outlier day doesn't skew your normal-day average.
- **Run dates in chronological order.** The digest refuses a date on or before the last one it processed, so a missed day can't be filled in after a later one has run — the running totals move forward one day at a time.
- Requires Sleep and Recovery API subscriptions on apizone for those sections to populate — without them, the digest still generates, those sections just say "no data" instead of erroring.

CLI: `suunto-mcp daily-digest 2026-04-20 [--seed-ctl 42 --seed-atl 38]`. MCP tool: `generate_daily_digest`.

---

## Predictions, experiments and session drafts

Three small tools for checking your own judgement. They keep local files only (see [Local files](#local-files)); nothing here writes to Suunto or to the watch.

### A prediction ledger: how good are my guesses?

Say *"I'll train tomorrow, 80% sure"* or *"I think my HRV stays in my usual band tomorrow night, 55%"* and Claude writes it down with `log_prediction` **before** it happens: its `date` must be after today (and at most 60 days ahead), so a prediction is always about the future. Once written, a prediction cannot be edited. The only way out is `void_prediction`, with a reason, on a day before its `date`; from the day itself it can no longer be voided. A voided prediction stays in the ledger and is counted separately. Logging the same prediction twice (same kind, date and parameters, while the first is still open) is refused, so nothing counts double. Two days after its date, `score_predictions` looks at your watch data and settles it:

- **hit** or **miss**, when the data decides it;
- **unresolvable**, when the data to decide is truly missing (no HRV that night, no `log_session` entry for a lift): it is never guessed, and counts as neither;
- **pending** (stays unscored, with the reason), while the watch has not synced anything from a later day: a workout or a night that is not there yet may simply not have synced. Only workouts that started after the prediction was made count.

The four kinds the server can score by itself: `session_done` (a workout exists on that date), `hrv_in_band` (the night after the date has an HRV inside your own middle half, the same band `get_baselines` shows), `recovery_morning_at_least` (the morning recovery after that night reaches a level you name) and `reps_hit` (an exercise, sets x reps at a load, on a date: scored from what you told `log_session`, because the watch does not record reps and weights). A `reps_hit` scored from an entry that came from a confirmed `draft_session_log` (its sets began as the guide's plan) is marked `draft-confirmed`, and the statistics show its hit rate apart from the others: someone who confirms drafts without checking would otherwise turn every lift prediction into a hit.

`get_prediction_stats` then says whether your probabilities were any good: the hit rate, the Brier score (0 is perfect; it also shows what you would have scored by always saying your overall hit rate) and a table of "when I said 60-80%, how often was I right". It says **nothing** until 20 predictions have been scored (per group: overall, per kind, per rule), and a row of the table needs 5. `rule` lets a skill or routine label its own predictions, so each rule gets its own score.

### Self-experiments: does X change my sleep?

`start_experiment` sets up a small randomized trial on yourself: what to do on an intervention day, what to do on a control day, which nightly number to judge (sleep duration, sleep score, HRV or recovery on waking), how many days (14 to 60), optionally which weekdays and a washout of up to 2 days after each intervention day. The hypothesis and the way it will be analysed are written down first, and the whole schedule is drawn up front: eligible days come in pairs, one intervention and one control in random order, so the two arms are balanced and you cannot pick the easy days. The random seed is stored and the schedule is never redrawn. One active experiment per outcome at a time.

Each day `get_experiment` says what today is. `log_experiment_day` records whether you really did it (say so when you did not: it is analysed both ways). After the planned end, `analyze_experiment` compares the nights after intervention days with the nights after control days: the difference of medians, a permutation test over the pairs (the arms swapped within each pair; with no washout that is exactly the randomization, so the p-value is exact when the intervention does nothing, and with a washout it is an approximation, checked by simulation), the same noise scale `get_tag_effects` uses, nights per arm and missing nights. With fewer than 6 nights with a value in an arm it says **insufficient** and claims nothing. Otherwise a difference is reported only when it is both unlikely by chance (p at most 0.05) and larger than that noise. It states plainly what was randomized (which day of each pair got the intervention) and what was not controlled (everything else about those days, no blinding, carry-over between nights, missing nights). Early looks need `early: true` and are flagged as exploratory; `stop_experiment` ends one with a reason and deletes nothing.

### Draft a session log: zero-typing logging

After a guided gym session, `draft_session_log` (by `workoutKey`, or by `date` for the latest guided session that day) builds the `log_session` entry for you: each exercise with the guide's sets x reps at its load. **Those reps and weights are the plan, not what you did**, because the watch only records the guide's text; every number is marked as an assumption. The draft also lists what the watch data contradicts or cannot show (a set that looks like a double lap press, a missing or extra set, laps after "Session complete", an unreliable mapping, a heart-rate dropout) and the exact things Claude should ask you. It never logs anything itself: you confirm or correct it, and only then does Claude call `log_session` with `source: "draft"`.

---

## Plan next week and test a plan

Two tools for the week ahead. Neither sends anything to the watch: they hand you a proposal or a what-if, you decide. `simulate_plan` writes nothing at all; `propose_next_week` writes nothing either (it hands back a `queuePayload` that you can pass to `queue_adjustment`, see [Approvals](#approvals-nothing-reaches-your-watch-without-your-yes)).

### Propose next week

`propose_next_week` takes the plan you stored with `set_plan`, repeats its latest guided week one week on, and sets each lift's load from what **you** logged with `log_session`, plus how recovered and loaded you are. Ask *"What should next week look like?"* and Claude shows the result; to use it, Claude passes `sessions` to `set_plan` (mode `merge`) and `guides` to `push_week_plan` (a dry run first). There is no automatic write.

The rules are few, named, and listed with their values in every answer (`rulesUsed`). You can change some of them with `rules`; each has a range.

| Rule | Default | What it does |
|---|---|---|
| progress | +2.5 kg (`incrementKg`, at most 5% of the load, at least 1.25 kg) | If in your latest logged session of that lift **in that same session (the same guide)** every planned set reached its planned reps at one weight, the load goes up one step, but never more than one step above the load the plan itself has for it, and never to less than that load. A heavier day of another guide is no evidence. |
| hold | | Anything else with a log: repeat the load you actually did, kept between the plan's own load and one step above it. Only a deload rule ever takes a load below the plan's. |
| deload | -10% (`deloadPct`), rounded to 1.25 kg | `stallSessions` (2) logged sessions of the lift in a row without hitting the plan; or today's TSB below `tsbDeloadBelow` (-25); or HRV and recovery on waking both below your usual band. |
| no evidence, no increase | | A lift you did not log (the watch records only the plan, not what you lifted) is left as it is. One of HRV / recovery below your band, or a part of the history not read yet, also blocks every increase. A lift with no kg figure (`BW 3x15`) is never touched. |
| risk flags | TSB below -30 (`tsbRiskFloor`); week's TSS more than 30% over your average week of the 28 days before (`weeklyJumpPct`) | Shown in `risk`, with the forecast of CTL / ATL / TSB for the proposed week (the same projection as `forecast_training_load`, from today's values). |

Every exercise comes back with what was decided and why (`changes[].reasons`). With too little to go on (no plan, no guided session to repeat, fewer than 2 logged sessions in the last 8 weeks, no lift with a log), the answer is `insufficient`, says what is missing, and proposes nothing. All numbers are model-based: simple rules applied to your own data, not a prescription. The first call can ask you to call again (`pending`) while it reads your older sessions, as `get_exercise_history` does.

### Simulate a plan

`simulate_plan` answers *"what would this do to me?"* before you commit. Give it sessions (a date plus a `tss`, or a title such as `PUSH A` whose TSS is estimated from your own last 90 days of that session; with no estimate it asks for `tss` instead of guessing), optionally a `goalDate` and a second plan to `compare`. You get, day by day, Fitness (CTL), Fatigue (ATL) and Form (TSB) from today's values; TSB on the goal date against a stated "fresh" band (+5 to +25); the CTL ramp per week; and the days and weeks where the risk rules trip (TSB below -30, CTL up more than 8 in a full week, a full week more than 30% over your average week). These are rules of thumb with contested evidence, not safe/unsafe lines, and every number is a projection of a simple model, not a prediction of how you will feel.

`personalResponse` appears only when your own history allows it. It compares your HRV and recovery on waking the night after a high-load day (at or above the median of your training days) with the night after the other days, using the same test as `get_tag_effects`: at least 15 nights of each, and a gap larger than the noise. Below that it says `insufficient` and what is missing (nights counted against the 15 needed). When there is a difference, it tells you the shift to expect; when there is none beyond the noise, it claims nothing. It is an association in your data, not a cause.

---

## Approvals: nothing reaches your watch without your yes

The approval queue is the safe way to let Claude prepare changes for you. `queue_adjustment` stores a prepared change in `~/.suunto-mcp/approvals.json`: an adjusted guide (what `adjust_guide` returned) or a week of guides (what `propose_next_week` returned). It is checked the way the push tool checks it, so a change that would not push is refused when it is queued. **Queueing never pushes.** `propose_next_week` and `adjust_guide` queue nothing themselves: each hands back a `queuePayload` (exactly the arguments of `queue_adjustment`), and Claude passes it on when you ask for it. A change is for the day of its guide, so a guide dated before today is refused, `forDate` can only be that date, and an approval cannot outlive that day (it expires at the end of it, in the server's local time, or earlier if you say so).

Later you look at the queue (`list_approvals`: pending, expired, decided, each with its reasons; `get_catchup` also shows what is pending) and decide with `resolve_approval`:

- **reject**: recorded, nothing else.
- **approve**: recorded; you get the payload and a `call` in the **dry-run form** (`push_week_plan` with `dryRun: true`), plus a line saying that `resolve_approval` with `push: true` is the only way to push. Nothing is pushed, and no ready real-push call is handed out.
- **approve with `push: true`** (same call): pushes through the existing push path. A week of guides is a dry run unless you also say `dryRun: false`. This is the only way anything in the queue reaches the watch.

An item that expired cannot be approved, and neither can one with a guide dated before today (rejecting is always possible). Resolving an item twice gives you the first answer back and never pushes twice. Real pushes need `SUUNTO_APP_NAME`, as `push_strength_guide` does; in demo mode the queue lives in memory and `push: true` never pushes. Whether a pushed guide shows on a real watch is as unverified as `push_strength_guide` itself (see Known limits). Every writer of the file (queueing and resolving, a push included) runs one at a time **within the server process**, so a queued item is never lost behind a slow push (it waits for it); two server processes writing in the same moments could still collide, as with the other local files.

### Predictions that follow a recommendation

`propose_next_week` with `predict: true` hands back, for each load it proposes to raise, a ready `log_prediction` payload: "I will complete these sets and reps at this weight on that day", labelled with the rule `progression`. Claude shows them; you log the ones you want (it never logs them itself). The probability is a stated mapping: your own hit rate for the `progression` rule once 20 of them have been scored (predictions scored from a confirmed `draft_session_log` are left out of that count, since they began as the plan itself), else 0.65, never below 0.5 or above 0.9. The loop: **propose** (with `predict`) -> **log** the predictions -> train and `log_session` what you did -> `score_predictions` -> `get_prediction_stats` (its `byRule` view shows how the `progression` rule is doing). If your increases hold up, the probabilities rise with them; if they do not, the numbers say so.

---

## Troubleshooting

**Always run `npm run doctor` first** — it pinpoints most problems automatically.

| What you see | What it means | How to fix it |
|---|---|---|
| Claude returns an error or nothing | Something isn't connected yet | Run `npm run doctor` and fix any lines with ✗ |
| Empty workout list | Watch hasn't synced recently | Open the Suunto app on your phone and wait for the sync to complete |
| "Not authenticated" | The pairing step didn't finish | Run `npm run auth` again |
| You logged in but nothing happened | The browser tab closed or timed out before Suunto confirmed | Close all Suunto tabs and run `npm run auth` again — click Authorize promptly |
| "Token request failed" or "400 error" | Client Secret or Redirect URI don't match apizone | Go to apizone → profile → OAuth application settings and confirm both values match exactly |
| "401" error on every request | Usually the subscription key is wrong or incomplete | Go to apizone → profile → Subscriptions, reveal and re-copy the Primary Key |
| "401" with "RateLimitExceeded" | Suunto's gateway reports a rate limit as 401 | Wait about 2 minutes and ask again — the key is fine |
| "401" with "OperationNotFound", or an error from a hidden legacy tool | Suunto no longer serves that endpoint (`get_workout_samples`, `export_workout_gpx`, `list_subscriptions` — hidden unless `SUUNTO_ENABLE_LEGACY_TOOLS=1`) | Nothing to fix on your side; re-pairing will not help |
| "403 Forbidden" on workouts | Developer API subscription isn't active | Sign in to apizone and confirm it's listed as Active |
| Sleep / recovery / activity returns "not found" | Those need separate subscriptions | Go to apizone and subscribe to the Sleep, Recovery, or Daily Activity API |
| Laps missing, doubled or out of order in a guided gym session | The watch's buttons were locked, the exercise was restarted, or a lap was pressed outside the guide | Ask for `get_workout_laps` and read its `checks` list — it says which of these happened; don't trust set-by-set reading while `checks` is non-empty |
| A workout has no heart rate | Heart-rate tracking was off, e.g. battery mode **Tour** | Choose a different battery mode before the workout; the data can't be recovered afterwards |
| Daily calories look far too low | The daily-statistics energy looks like *active* energy, not total (resting + active) — this is not verified against the watch | Treat it as active kcal; don't read it as total daily burn |
| Numbers differ from the Suunto app | Balance equals the app's *Resources* % (0.96 = 96%). The app's single *Recovery state* % is not available through the API. Fitness (CTL) computed here can be about 1 point off the watch | Use the app for Recovery state %; seed the digest from the app if you need CTL exact |
| Got an SSL error after Apple sign-in | Known Suunto quirk with Apple login | Close the error tab, go back to the auth URL the terminal printed, and continue |
| "State mismatch" error | A second auth flow started before the first finished | Close all auth-related tabs and run `npm run auth` fresh |
| `npm run build` failed with an error | Node.js version too old or not installed | Run `node --version` — it must be 20 or higher. Reinstall from [nodejs.org](https://nodejs.org) |
| Terminal says "EADDRINUSE" or port in use | Something else is using port 8421 | Restart your computer, or run `lsof -i :8421` to see what's using it |
| Guide upload fails with an "owner" error | `SUUNTO_APP_NAME` doesn't exactly match your registered app name | Check apizone → your app → confirm the exact name, fix the env var, restart Claude |
| Pushed a guide but it's not on the watch | Watch hasn't synced with your phone yet | Open the Suunto app and let it sync; it should appear without any extra steps |

---

## FAQ

**Is this safe? Will Suunto lock my account?**
Suunto built this API specifically for people to connect their own tools — it's explicitly allowed. You're using it exactly as intended.

**Is my data leaving my computer?**
Your data travels directly between your computer and Suunto's servers. Suunto MCP is just the bridge. When Claude asks about your workouts, it goes: Claude → Suunto MCP (on your machine) → Suunto's servers → back. No third-party services see your data.

**Which Suunto watches work?**
Any watch that syncs to the Suunto app: Race, Vertical, 9 Peak Pro, 9 Peak, 5 Peak, Wing, Ocean, and older models. If it appears in your Suunto app, it works here.

**Do I need to do anything when I record a new workout?**
No. Just ask Claude — it always pulls live data from Suunto.

**What if I want to disconnect and stop using this?**
See [Disconnecting](#disconnecting) below. You can fully revoke access in under a minute.

**Can I use this with AI apps other than Claude?**
Yes — anything that supports MCP: Claude Code, Cursor, Windsurf, and others.

**My Suunto app username is different from my email — which do I use?**
Use your email address to sign in to apizone. Your username will appear once you're authenticated.

---

## Privacy

- All data flows **directly between your computer and Suunto's servers**. No third-party servers, no analytics.
- Your login credentials are stored locally at `~/.suunto-mcp/tokens.json` — not uploaded anywhere.
- Suunto shows your connected app as "suunto-mcp" in apizone → profile → Authorized applications. You can revoke it there at any time.
- The AI only sees data it explicitly requests for your question — not your entire history at once.
- Everything suunto-mcp saves (tokens, plan, journal, cache, workout archive, saved weekly reports) stays on your computer as local files; none of it is uploaded to any service. The only network calls are to Suunto's API, and nothing else is sent anywhere: no analytics, no crash reports, no telemetry. What the AI app (for example Claude) receives is what a tool returns for your question.
- Demo mode makes no network calls at all and writes no files; its data is generated on your computer.
- A weekly report's markdown (`get_weekly_report`) holds no account id, token, workout key or file path, but it does contain your own numbers, plan goal and session titles, so read it before you share it.

---

## Known limits / not yet verified on real devices

None of the following has been checked against a real watch or real Suunto files; the tests use synthetic data. Treat each as open until you have seen it work on your own. What stays stable from release to release, and what does not, is in [docs/CONTRACT.md](docs/CONTRACT.md).

- **Guides on the watch.** How the `TODAY` popup (the `last` / `target` hint of `push_strength_guide`) and the newer step titles and popups (`3/6 - 2/3`, `SET 2/3`, `LAST SET`) render on a real watch has not been checked on a device.
- **Guides dated in the future.** `push_week_plan` pushes guides up to 14 dates ahead. Whether the watch shows each one on its day, and when it appears after the phone's sync, has not been verified.
- **Location-triggered guides.** Not implemented. Guides are pushed by date only.
- **Units of `recoveryTime`, `pte` and `peakEpoc`.** Suunto does not document them, so `get_workout_laps` passes them through under their own names with no unit claimed.
- **FIT checks.** The integrity check looks at the FIT header and the length only; the CRC is not checked. The heart-rate quality thresholds (coverage, dropout gaps, plausible range 30-230 bpm, stuck-sensor and jump rules) were set lenient on purpose and have not been validated on real Suunto files. The timebase alignment in `get_workout_rest_profile` and whether Suunto's FIT export carries the SuuntoPlus developer fields are likewise unverified.
- **`get_tag_effects`.** Its false-alarm rates (roughly 9% of tags at 15 nights per group with no real difference, more when nights are correlated) come from a simulation, not from real nights. It reports an association, never a cause.
- **Predictions, experiments and drafts.** Their thresholds (20 scored predictions for any rate, 5 per calibration row, 6 nights per arm for an experiment verdict, p at most 0.05, scoring from the second day after the date) are design choices checked by simulation and unit tests on synthetic data, not on a real watch's nights; the permutation test over pairs uses a difference of medians, which has little power when the nights vary a lot. `score_predictions` has not seen real Suunto sleep, recovery or workout data from a long run of days, and a draft has not been compared with real guided sessions beyond the fixtures.
- **`propose_next_week` and `simulate_plan`.** Their thresholds (deload after 2 missed sessions in a row, 10% deload, TSB -25 and -30, a week 30% over your 4-week average, a CTL ramp over 8 a week, the fresh band of TSB +5 to +25, at least 2 sessions of a title for a TSS estimate, 15 nights of each kind for `personalResponse`) are conventions or design choices, not validated on real athletes or real Suunto data. The projections inherit the 1-point CTL offset noted for `get_training_load`. A session's TSS for a title is the median of your own past sessions of it, so a new session type needs a `tss`. Nothing here has been checked against how a real lifter responds.
- **Names.** `from` / `to` are the preferred names of a range's ends (`list_workouts`, `get_daily_activity_statistics`); `since` / `until` and `startdate` / `enddate` keep working. The three hidden legacy tools (`get_workout_samples`, `export_workout_gpx`, `list_subscriptions`) are deprecated and may be removed in a later 1.x minor release.
- **The approval queue's push.** It uses the same push path as `push_strength_guide` and `push_week_plan`, so everything noted for them (how a guide shows on a real watch, delivery after the phone's next sync) applies; it has not been run against a real account.
- **`estimate_route_time`.** The model (flat pace plus extra time per metre climbed and descended, fitted to your archived workouts) has not been checked against real finished times; its in-sample error is a fit to the past, not a forecast. Without enough archived workouts it falls back to a generic rule that is not your pace.
- **Daily calories.** The energy in `get_daily_activity_statistics` looks like active energy, not total; not verified against the watch.
- **The `.mcpb` bundle.** Not opened in a real host, not signed, no automatic updates (see [One-click install](#one-click-install-mcpb-bundle)).
- **Deleting a route.** Whether Suunto's API accepts a DELETE on a route is unconfirmed, and no tool offers it: remove routes in the Suunto app.

---

## Upgrading

- **npx:** `npx -y suunto-mcp` fetches the newest version on a fresh start; if you pinned a version in `args`, change it. Restart Claude afterwards.
- **Cloned folder:** `git pull`, `npm install`, `npm run build`, then restart Claude.

See [CHANGELOG.md](CHANGELOG.md) for what changed. From 1.0 on, [docs/CONTRACT.md](docs/CONTRACT.md) says what stays compatible within 1.x (tool names, input schemas, documented output fields, local file formats) and what does not.

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
| `SUUNTO_REPORTS_DIR` | no | Folder where `get_weekly_report` with `save: true` writes `week-<Monday>.md`; default `~/.suunto-mcp/reports/` |
| `SUUNTO_ENABLE_LEGACY_TOOLS` | no | `1` lists the three hidden tools (`get_workout_samples`, `export_workout_gpx`, `list_subscriptions`) that Suunto's servers no longer answer |
| `SUUNTO_DAILY_PREFIX` | no | Path prefix of the 24/7 (sleep, recovery, daily activity) endpoints; default `/247samples`. Only change it if your apizone entitlement uses another one |
| `SUUNTO_HEALTH_EXPORT_STATE_PATH` | no | State file of `sync-to-health-skill` (which days were already copied); default `~/.suunto-mcp/health-export-state.json` |
| `SUUNTO_WRITE_GAP_MS`, `SUUNTO_ROUTE_IMPORT_GAP_MS`, `SUUNTO_ROUTE_VERIFY_DELAY_MS`, `SUUNTO_UPLOAD_POLL_MS` | no | Pacing of writes to Suunto in milliseconds (all default to 2000 except the route read-back delay, 3000): the pause between guide pushes and workout uploads, between route imports, before a route is read back, and between upload status polls. Leave them alone unless you are testing |
| `SUUNTO_WEBHOOK_SECRET`, `SUUNTO_WEBHOOK_HOST`, `SUUNTO_WEBHOOK_LOG`, `SUUNTO_WEBHOOK_ALLOW_UNSIGNED`, `PORT` | webhook only | See the Webhooks section |

---

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
- `reports/week-<Monday>.md` — what `get_weekly_report` wrote when you passed `save: true`: plain markdown for sharing, never any account id, token or workout key. A file that exists with different content is never replaced unless `overwrite: true` is passed. Your own copy: delete it whenever you like. `estimate_route_time` only reads the `archive/` files above and writes nothing.

## Disconnecting

To fully remove access:

1. Log in to [apizone.suunto.com](https://apizone.suunto.com) → profile → **Authorized applications** → remove suunto-mcp. Suunto immediately stops honoring the connection.
2. Delete local credentials:
   ```bash
   rm -f ~/.suunto-mcp/tokens.json
   ```
   If you used `SUUNTO_TOKEN_STORAGE=keychain`, delete the "suunto-mcp" entry in your system keychain instead. The daily digest also keeps `~/.suunto-mcp/averages.json` and `SUUNTO_HISTORY.md`, `get_exercise_history` keeps `~/.suunto-mcp/cache/` and `log_session` keeps `~/.suunto-mcp/journal.json`, `set_plan` keeps `~/.suunto-mcp/plan.json` and `get_catchup` keeps `~/.suunto-mcp/seen.json` and `archive_workouts` keeps `~/.suunto-mcp/archive/` — delete them too if you want the health data gone (`rm -rf ~/.suunto-mcp/cache ~/.suunto-mcp/journal.json`).
3. Remove the `"suunto"` block from your Claude config and restart Claude.

---

## Pairs well with health-skill

If you use [googlarz/health-skill](https://github.com/googlarz/health-skill) — a Claude skill for symptom triage and health Q&A — you can connect both to Claude: health-skill handles the health side while Claude reads your training, sleep, and recovery data from Suunto MCP in the same conversation. Together they can answer questions like *"given my recovery scores this week, should I keep tomorrow's interval session?"* with real numbers.

The same combination works for planning, not just Q&A: Claude can check your actual HRV and sleep before writing a session, scale it back on a bad recovery day instead of a generic one, and push the result straight to your watch with `push_strength_guide` (gym) or `push_interval_guide` (cardio). Ask for it directly — *"check my recovery and plan today's gym session"* — no extra setup beyond having both connected.

To also store your daily step counts in health-skill's own records, run `suunto-mcp sync-to-health-skill --health-root <your health folder>` (add `--person-id` for a household member). It copies steps only, and only for days that are finished — today's total is picked up tomorrow.

For the full version — real progressive-overload programming that persists week to week instead of a one-off ask — install [googlarz/gym-skill](https://github.com/googlarz/gym-skill): `/gym setup` once, then `/gym plan`/`/gym today`/`/gym log`/`/gym review` going forward.

---

## Advanced

<details>
<summary>Install from npm instead of cloning the code</summary>

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

</details>

<details>
<summary>Using with Claude Code instead of Claude Desktop</summary>

Run this in a terminal (use your own values and the real path to this folder), then `claude mcp list` to verify it's loaded:

```bash
claude mcp add suunto -e SUUNTO_CLIENT_ID=your-client-id -e SUUNTO_CLIENT_SECRET=your-client-secret -e SUUNTO_SUBSCRIPTION_KEY=your-subscription-key -- node /full/path/to/suunto-mcp/dist/index.js
```

Add `-e SUUNTO_APP_NAME=your-app-name` if you want to push guided workouts.

</details>

<details>
<summary>CLI — query your data from the terminal</summary>

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

</details>

<details>
<summary>Webhooks — get notified the moment a workout syncs</summary>

```bash
npm run webhook
```

Starts an HTTP receiver on port 8422 that logs workout events as they arrive. It listens on `127.0.0.1` only, so expose it through a tunnel (cloudflared, ngrok) or a reverse proxy and register the URL in apizone → webhooks.

**Set `SUUNTO_WEBHOOK_SECRET`** to the notification secret you configure in apizone's OAuth application settings. Every request is verified against Suunto's `X-HMAC-SHA256-Signature` header and rejected with 401 if it doesn't match. Without the secret the receiver rejects *everything* (set `SUUNTO_WEBHOOK_ALLOW_UNSIGNED=1` only for local testing). Other options: `PORT`, `SUUNTO_WEBHOOK_HOST` (default `127.0.0.1`), `SUUNTO_WEBHOOK_LOG` (default `~/.suunto-mcp/webhooks.ndjson`, written private and capped at 100 MB).

Most users can skip this whole section — asking Claude on demand is simpler.

</details>

<details>
<summary>Keychain — store credentials more securely</summary>

To store your Suunto login tokens in your OS keychain (macOS Keychain, Windows Credential Manager) instead of a file:

```bash
SUUNTO_TOKEN_STORAGE=keychain npm install @napi-rs/keyring
SUUNTO_TOKEN_STORAGE=keychain npm run auth
```

</details>

<details>
<summary>All available tools (reference)</summary>

Claude picks the right tool automatically — you don't need to know these. For the curious:

**Workouts**

| Tool | What it does |
|------|-------------|
| `list_workouts` | Recent workouts, filtered by date |
| `get_workout` | Summary numbers for one workout (no laps — use `get_workout_laps`) |
| `get_daily_snapshot` | One call for a whole day: last night's sleep (main sleep, naps), the day's lowest and highest recovery balance (and the value on waking and at bedtime), steps, energy and workouts. Pass `to` for up to 14 days in one request |
| `get_baselines` | Your own recent norms: median and the middle-half band (p25-p75) of the last 14-90 days (default 28, ending the day before `date`) for sleep duration, sleep score, HRV, recovery on waking, the day's lowest recovery and steps, plus where `date` sits in it (`below` / `within` / `above`). Quantiles use linear interpolation between order statistics; a band needs 7 days with a value. A missing day is never counted as 0. Not a medical reference. Read-only |
| `get_training_load` | Fitness (CTL), Fatigue (ATL) and Form (TSB) day by day, plus weekly totals and the 7-day ramp rate, computed from workout TSS (Suunto's API has no such numbers). Up to 120 days ending at `date`; CTL can be about 1 point off the watch. Read-only — doesn't touch the digest files |
| `forecast_training_load` | Projects Fitness (CTL), Fatigue (ATL) and Form (TSB) for planned days (`days`: `[{ date, tss }]`, the same TSS unit `get_training_load` shows; a date left out is a rest day), rolled forward from today's values (`asOf`, default today) with the same 42-day/7-day model. Up to 120 days ahead. A projection of the model, not a prediction of how you will respond. CLI: `suunto-mcp forecast-training-load 2026-11-17:60 2026-11-19:80`. Read-only |
| `propose_next_week` | Proposes next week's strength sessions from the stored plan, your logged lifts (`log_session`) and your recovery and load: a load step up only when the latest logged session hit every planned set and rep, a repeat otherwise, a 10% deload after 2 sessions in a row that missed or when TSB or recovery are low; nothing is raised without a log. Returns `sessions` (for `set_plan`), `guides` (for `push_week_plan`), the reasons per exercise, the rules used, a CTL/ATL/TSB forecast and a risk note; `insufficient` when the history is too thin. Writes nothing by default (reading the history fills only the derived-data cache); `queuePayload` is queue_adjustment's exact arguments (nothing is queued by the proposal); `predict: true` adds ready `log_prediction` payloads. Model-based. |
| `simulate_plan` | A what-if for a candidate week or plan (`sessions` with `tss` or a title to estimate it from your history; optional `goalDate` and `compare`): CTL/ATL/TSB day by day, TSB on the goal date against the fresh band, the CTL ramp per week, the days and weeks where the risk rules trip, and, only with enough history, how your own next-night HRV and recovery have differed after high-load days (`personalResponse`). Read-only, keeps no state. Every number is model-based. |
| `queue_adjustment` | Stores a prepared change (`kind` `adjusted_guide` with push_strength_guide's arguments, or `week_plan` with `{ guides }`) in the local approval queue after the push tool's own validation; optional `forDate`, `reasons`, `source`, `expiresAt` (default the end of the day). Writes only `approvals.json`; never pushes. |
| `list_approvals` | The approval queue from the local file: pending, expired, approved, rejected, with reasons; `status` filters, `id` returns one item with its payload and the exact call. Read-only, no credentials. |
| `resolve_approval` | The user's decision on one item: `reject` records it; `approve` records it and returns the payload and the exact call; `approve` with `push: true` in the same call pushes through the existing push path (a week plan as a dry run unless `dryRun: false`). Expired items cannot be approved; resolving twice returns the first result and never pushes twice. Demo mode never pushes. |
| `get_data_overview` | Every local file the server keeps (journal, plan, seen, predictions, experiments, approvals; cache, archive and reports folders): path, status, version, size, counts, permission warnings, files it would refuse. Read-only, no credentials, changes nothing. |
| `get_workout_laps` | Lap-by-lap table for one workout: time, heart rate, calories and the guide step of each lap — the way to read back a guided gym session set by set; it also reports when the table looks unreliable (a missing or doubled lap, no heart rate) |
| `compare_workout_to_plan` | Reads a guided gym session back against its plan: maps the laps to exercises, sets and rests and lists deviations (missing or extra sets and exercises, short or long sets, rests off target, laps outside the guide), each marked with what it rests on (the labels, your plan, or a heuristic). Pass the exercises array you pushed as `plan` to also check order, set counts and rest targets. With restMode `countdown` rest overruns are not measurable. Read-only |
| `get_workout_rest_profile` | How the heart rate recovered during each rest of a guided gym session. Reads the FIT file's record-level HR and joins it to the guide's laps (exercise, set), so it works with restMode `countdown`, where the rest lap always lasts exactly its target. Per rest: peak HR (smoothed over 3 samples, searched from 15 s before the rest to 30 s into it, because optical HR lags 20–30 s), HR at the end, total drop, seconds after the peak to fall 10, 20 and 30 bpm, bpm per minute over the first minute, and how many seconds have an HR sample; plus medians per exercise. Also lists the SuuntoPlus app's developer fields found in the FIT (`get_workout_fit` shows them too). `hrQuality` (`{ reliable, reasons, coverage }`) rates the whole session's HR: under 80% of the session covered (dropouts are gaps of over 10 s between samples, so the sampling rate does not matter), over 2% of samples outside 30–230 bpm, the same value for over 3 minutes, or frequent jumps of over 40 bpm between adjacent samples make it `false` (and the profile's `reliable` false, with the reasons in `note`; the numbers are still returned); `null` means the FIT has no heart rate at all. The rest windows are placed on the FIT timeline by the workout start time; not yet checked against a real workout. Optional `plan` as for `compare_workout_to_plan`. Read-only |
| `adjust_guide` | Adjusts a strength guide spec to how recovered you are, and **returns** it with the reasons; it pushes nothing (push the returned `guide` with `push_strength_guide` if you agree). Compares today's HRV and recovery on waking with your own band (`get_baselines`, last 28 days). Rules: neither below the band, or no reading yet: unchanged (it never adds load); one below: one set less on every exercise with 3+ sets; both below: that plus every load 10% lower, rounded to 2.5 kg (a plate breakdown is dropped when the load changed, and an exercise's `target` whenever that exercise changed at all, with a reason; `last` stays). The band is the middle half of your own days, not a medical reference. Read-only |
| `get_exercise_history` | Progression of strength exercises across guided sessions: for one exercise (`name`) or an index of all of them, per session the load (the first `NNkg` in the guide's text, or the weight you logged), sets done against planned, the guide's rest and the heart-rate recovery after set 1 (end-of-rest HR, drop, seconds to fall 20 bpm), plus a median end-of-rest HR you can use as `push_strength_guide`'s `restTargetHr` (sessions whose heart-rate data is unreliable, see `get_workout_rest_profile`'s `hrQuality`, are marked `reliable: false`, left out of that median and named in a note with the reasons; a session unreliable for another reason is marked and left out the same way, but not named). With `name` it also returns `suggestion` (`last`, `target`, `reason`): the newest session as e.g. `3x8@60kg`, and a simple next target (when a `log_session` entry shows every planned set done with every planned rep at one weight: the same sets and reps, up by 2.5 kg but at most 5% of the load, in 1.25 kg steps and at least 1.25 kg; a short set, different weights between sets, a missing load or a rep range such as `3x8-12`, `3x8–12` or `3x8 to 12` give a repeat instead); it pushes nothing. `weeks` 1–26 (default 8) ending at `date`. Weights and reps are what the guide *planned*, the watch does not record them; `log_session` corrects that. Each session is read once and its small derived result cached locally; at most 8 uncached sessions are read per call, so the answer says how many are `pending` — call again until 0, unless a note says calling again will not help (the cache folder is not writable, or sessions keep failing). Names the guide cut to 40 characters are grouped with their longer form only when that is certain, otherwise they stay separate and a note lists them. Writes only the local cache (see *Local files*), never anything at Suunto |
| `log_session` | Records what you say actually happened in a session (reps, weight, RPE, notes per exercise) in a local journal file. An optional `source: "draft"` marks an entry made from a confirmed `draft_session_log`. One entry per workout; logging the same workout again replaces it and returns the old entry. Optional `tags` (up to 8 short labels of at most 24 characters, e.g. `deload`; trimmed, no control characters, no duplicates ignoring case) are stored on the entry; a call with only tags sets the tags of the existing entry and keeps the rest of it; `get_tag_effects` compares the nights after tagged sessions with the others. A call with nothing at all is refused (`nothing to log`), and unknown fields (such as `weight`; use `kg` inside a set) are refused with an error naming the field. `get_exercise_history` shows it and uses its weights. Never contacts Suunto |
| `set_plan` | Stores your training plan as local state in `~/.suunto-mcp/plan.json`: a goal, optional start/end dates, phases (`name`, `from`, `to`, `focus`) and planned sessions per date (`date`, `title`, optional strength-guide spec). `mode: replace` (default) makes the call the whole plan and overwrites the stored one (the result returns the previous plan in full, and the tool is flagged destructive for that reason); `merge` updates it and merges sessions by date. Strict validation (unknown fields, bad dates, sessions or phases outside start..end, duplicate dates and size limits are refused; a damaged plan file is never overwritten). Never contacts Suunto, needs no credentials, and never pushes anything to the watch: pushing stays with `push_week_plan` / `push_strength_guide` |
| `get_plan` | Reads that plan: today's session (with its guide spec), the current phase and the 7 days after today (a day without a session is a rest day), or one `date`. Local file only, read-only, needs no credentials |
| `get_catchup` | What is new since you last caught up: new workouts (date, type, duration, TSS), new finished nights with sleep and recovery on waking, new recovery samples, plan items done / missed / pending by date (any workout on a planned date counts as done), and days since the last session. Reads Suunto only. The first call looks back 7 days (plus a margin of up to 14 hours for time zones); later calls start at the day every section was last read completely, never more than 14 days back. The marker in `~/.suunto-mcp/seen.json` moves only with `markSeen: true`; without it the call is a pure read and repeats the same answer. A section that failed (or an unreadable plan file) keeps the review window open, so what it missed is reported on the next call. Because `markSeen: true` writes the marker, the tool is not flagged read-only and clients may ask before running it |
| `get_tag_effects` | Does the night after a tagged session look different? For each tag you gave `log_session`, compares the nights that followed a day with a tagged session with the nights that followed other training days (rest days are in neither group): sleep duration, sleep score, HRV and recovery on waking, the same per-night values as `get_baselines`, over the last 30-180 nights (default 90). Reports n, the median and mean difference per metric, the threshold and a verdict that is `insufficient` unless there are at least **15 tagged and 15 untagged nights** with a value, and otherwise `tagged-higher` / `tagged-lower` only when the median difference is **larger than 3 standard errors** of the difference of two medians (`3 * 1.25 * (IQR of the untagged nights / 1.35) * sqrt(1/nTagged + 1/nUntagged)`; equal is within noise). Four metrics are tested per tag, so a tag is flagged by chance now and then: in simulations with no real difference about 9% of tags at 15 nights per group, 5% at 20 and 3% at 30 (11% to 22% when nights are correlated), so read one `differs` as a lead, not a finding. An association in your own data, never a cause. Reads Suunto and the local journal, writes nothing |
| `log_prediction` | Writes down a prediction with a probability **before** it happens, in a local ledger (`predictions.json`). Input `date` (after today, at most 60 days ahead), `kind`: `session_done`, `hrv_in_band`, `recovery_morning_at_least`, `reps_hit`. Immutable once logged; an identical open prediction is refused; `rule` labels who made it. Local file only, needs no credentials |
| `void_prediction` | Voids a prediction with a reason, only on a day before its `date`; it stays in the ledger and is counted apart. Cannot be undone (annotated destructive). Local file only |
| `score_predictions` | Scores every due prediction as `hit`, `miss` or `unresolvable` (data truly missing: never guessed; data that may just not have synced yet stays `pending`, reported with its reason) from Suunto's data and your journal, 20 per call (`remaining` says if more are left); reads Suunto, writes only the outcomes locally |
| `get_prediction_stats` | Per kind and per rule: scored count, hit rate, Brier score and a calibration table by stated probability, shown only from 20 scored predictions (a table row from 5); below that `insufficient`. Predictions scored from a confirmed draft are reported apart (`basis`). Local file only, read-only |
| `start_experiment` | A randomized self-experiment on `sleepDurationS`, `sleepScore`, `hrv` or `recoveryMorning`: pre-registered hypothesis and analysis, a schedule of intervention, control and washout days drawn up front in balanced pairs (seeded, never redrawn), 14-60 days, optional `eligible` weekdays and `washout` 0-2. One active experiment per metric. Local file only |
| `get_experiment` | Today's assignment (what to do), progress and adherence of your experiments; with `id` the full schedule and log. Local file only, read-only |
| `log_experiment_day` | Records whether you actually followed that day's assignment (`followed` true or false, optional note); a correction keeps the earlier answer. Local file only |
| `analyze_experiment` | Difference in medians between the nights after intervention and control days, a permutation test over the randomized pairs (all swaps up to 15 pairs, else 20000 seeded draws; exact without a washout, an approximation with one), effect against `get_tag_effects`' noise scale, nights per arm and missing nights; intention to treat and per protocol both reported; `insufficient` under 6 nights per arm; what was and was not randomized in plain words. After the planned end, or `early: true` (exploratory). Read-only |
| `stop_experiment` | Stops an experiment with a reason; nothing is deleted, but it cannot be undone (annotated destructive). Local file only |
| `draft_session_log` | Proposes the `log_session` entry for a guided session from the watch data (`workoutKey`, or `date`): the guide's sets x reps at load, **all marked as assumed** because the watch does not record what you lifted, plus every deviation the laps show and what to ask you. Never logs anything: after you confirm, call `log_session` with `source: "draft"`. Read-only |
| `get_benchmark` | A repeatable session over time: give a `guide` title (e.g. `PUSH A`) or an `exercise` name and get, oldest first, each occurrence's duration, TSS, median end-of-rest heart rate and per exercise (one entry per session, repeated blocks merged) the load, planned reps and rest heart rate, with first / last / best and a trend per series. Trend rule: median of the older half against the median of the newer half of the occurrences (the middle one left out when odd), `up` / `down` beyond 3% of the older median, else `flat`; `insufficient` below 3 occurrences. Uses `get_exercise_history`'s reader, cache and 8-uncached-sessions-per-call limit (call again until `pending` is 0) |
| `archive_workouts` | Copies your workouts to local files so your history is not limited to what Suunto's list reaches (or to the 600 workouts `get_training_load` reads): per workout the FIT file and a JSON record (summary, FIT size, SHA-256) in `~/.suunto-mcp/archive/`. Incremental: skips what is archived, downloads at most 20 FIT files per call, newest first, and reports `remaining` (call again until it is 0). Checks each FIT file (non-empty, FIT header, not truncated) before marking it archived. Writes only new local files: never changes anything at Suunto, never deletes or overwrites (a damaged or foreign file is reported in `refused` and left alone). Annotated not read-only, not destructive, not idempotent (each call archives the next batch), open-world |
| `get_archive_status` | What the local archive holds: workouts archived, FIT bytes, the date span, and every file that does not check out. Local files only, read-only, needs no credentials |
| `get_weekly_report` | A shareable report for one finished Monday-to-Sunday week (`week` = its Monday, default the last full week): workouts, sleep, HRV, waking recovery and steps as the week's median against your own 28 days before it, training load at the end of the week, the week's guided strength sessions, plan adherence and tag effects. Returns the numbers plus a self-contained `markdown` text with no account id, token, workout key or file path; a section without enough data says "insufficient data", and tag effects appear only when not insufficient. With `save: true` it also writes `~/.suunto-mcp/reports/week-<Monday>.md` (never replaces a different file unless `overwrite: true`). Reads about 30 requests from Suunto, changes nothing there |
| `estimate_route_time` | How long a saved route takes **you**: reads the route's GPX and fits your own pace on flat, uphill and downhill ground to your archived walking/hiking (or running) workouts (run `archive_workouts` first). Gives the total, splits for ascent, descent and flat stretches, and with a `sunset` you supply (ISO time with offset, nothing is looked up) the latest start with a margin. With too little archived data it says `insufficient` and falls back to a clearly labelled generic Naismith estimate (5 km/h plus 1 h per 600 m climbed). An estimate of moving time, not a promise. Read-only |
| `get_workout_fit` | Raw FIT file decoded to structured data (large — `full: true` is about 550 KB for a strength session) |
| `get_workout_samples` | **Hidden by default** — Suunto's servers reject this call (OperationNotFound, checked on one account, September 2026); set `SUUNTO_ENABLE_LEGACY_TOOLS=1` to list it; use `get_workout_fit` |
| `export_workout_gpx` | **Hidden by default** — Suunto's servers reject this call (OperationNotFound, checked on one account, September 2026); set `SUUNTO_ENABLE_LEGACY_TOOLS=1` to list it |

**24/7 health** *(requires individual product subscriptions on apizone)*

| Tool | What it does |
|------|-------------|
| `get_daily_activity` / `list_daily_activity` | Steps, calories, daily heart rate |
| `get_sleep` / `list_sleep` | Sleep stages, duration, score |
| `get_recovery` / `list_recovery` | Recovery balance and stress state through the day |
| `get_daily_activity_statistics` | Aggregated daily stats over a date range |

**Routes**

| Tool | What it does |
|------|-------------|
| `list_routes` | Your newest saved routes (Suunto returns at most 5) |
| `get_route` | One route by its ID — works for routes `list_routes` doesn't show |
| `export_route` | Export a route as GPX |

**Uploads & guided workouts** *(write — send data back to your account)*

| Tool | What it does |
|------|-------------|
| `upload_workout` | Upload a FIT file as a new workout — Suunto's own docs say only FIT is currently supported for this endpoint, despite what you might read elsewhere |
| `upload_route` | Import a GPX file as a route (one route per `<rte>`/`<trk>`); it shows up in the Suunto app's route library and syncs to the watch for navigation. Takes `activities` (default running). Imports run one at a time and each route is read back from Suunto (`check.verified`), so sending several files at once is safe. Cannot be deleted from here — remove it in the app |
| `get_upload_status` | Check whether an upload finished processing |
| `push_workout_guide` | Push a structured workout (exercises, weights, rest, notifications) as a SuuntoPlus Guide — requires `SUUNTO_APP_NAME` |
| `push_interval_guide` | Push an auto-advancing interval/cardio guide (timed or distance-based segments, target HR ranges) — requires `SUUNTO_APP_NAME` |
| `push_strength_guide` | Push a per-set strength session (prep stopwatch, set/rest lap tracking, configurable rest mode, `3/6 - 2/3` step titles (exercise/set), optional rest target HR, optional per-exercise `last` / `target` hints such as `3x8@60kg` / `3x8@62.5kg` shown in a `TODAY` popup when the exercise's prep step starts, at most 36 characters (a long `last` is shortened, then dropped, so the target is never cut; if nothing fits there is no popup), not part of the lap labels; how the titles and popups render on a real watch is not yet verified, see [Known limits](#known-limits--not-yet-verified-on-real-devices)) — requires `SUUNTO_APP_NAME` |
| `push_week_plan` | Push a week of strength guides in one call: one NEW guide per date (the arguments of `push_strength_guide` per guide, without `guideId`; at most 14, dates must differ), each read back like `push_strength_guide`. **`dryRun` defaults to true**: it then only validates every guide and returns what it would push, without contacting Suunto; pass `dryRun: false` to push. The first failure stops the push and the result names what was pushed, what failed and what was left. Pushing the same plan twice creates duplicates (`list_guides` / `delete_guide`). Requires `SUUNTO_APP_NAME` for a real push |
| `list_guides` | List all SuuntoPlus Guides on your account |
| `delete_guide` | Permanently delete a guide by id |

**Other**

| Tool | What it does |
|------|-------------|
| `list_subscriptions` | **Hidden by default** — Suunto's servers reject this call (OperationNotFound, checked on one account, September 2026); set `SUUNTO_ENABLE_LEGACY_TOOLS=1` to list it |
| `generate_daily_digest` | Writes the daily health digest to `SUUNTO_HISTORY.md` (see *Daily health digest*) — a write tool |

</details>

---

## Credits

- [Suunto APIzone](https://apizone.suunto.com/) — for opening their API to everyone
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard this speaks
- [`fit-file-parser`](https://www.npmjs.com/package/fit-file-parser) — FIT binary decoding

## License

MIT — use it, fork it, improve it.
