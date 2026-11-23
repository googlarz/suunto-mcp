# Setup, troubleshooting, upgrading and disconnecting

The full setup guide for suunto-mcp, moved out of the [README](../README.md). Prefer one guided walkthrough? See [GETTING_STARTED.md](../GETTING_STARTED.md).

## Setup

> **Prefer one guided walkthrough with a pacing choice up front** (fast path
> vs. explained-step-by-step) and a proper explanation of how syncing works?
> See [GETTING_STARTED.md](../GETTING_STARTED.md). What follows here is the same
> steps in reference form.

The setup has three parts:

1. **Register with Suunto's developer portal** — tells Suunto your app is allowed to read your data
2. **Install and configure** — gets the software running on your computer
3. **Connect to Claude** — lets the AI find and use it


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

`log_prediction`, `void_prediction`, `score_predictions`, `get_prediction_stats`, `start_experiment`, `get_experiment`, `log_experiment_day`, `analyze_experiment`, `stop_experiment` and `draft_session_log` work too: the ledger starts with a month of synthetic predictions waiting to be scored and the experiments with one finished synthetic experiment, all in memory and never on disk. `set_plan`, `get_plan`, `get_catchup`, `archive_workouts`, `get_archive_status`, `import_workouts`, `get_import_status` and `get_weekly_report` (its `save` too) work too, on in-memory state only: the plan, the catch-up marker, the workout archive and the imported workouts live as long as the server process and never reach the disk (`import_workouts` still reads the files you point it at). `get_tag_effects` runs on a small synthetic journal (gym sessions tagged `strength`, Saturday runs `long-run`); your real journal is not read.

`push_week_plan` works as a dry run (its default: it validates the guides and returns what it would push, and contacts nothing). `propose_next_week` and `simulate_plan` work too: with no plan stored, the proposal starts from the demo programme (PUSH A, PULL B, LEGS C) and lifts the demo lifter logged, so it shows a hold and a deload; everything is generated and nothing is written. The approval queue (`queue_adjustment`, `list_approvals`, `resolve_approval`) and `get_data_overview` work on the in-memory stores; `resolve_approval` with `push: true` never pushes there.

What does not: anything else that writes (`upload_workout`, `upload_route`, `push_*_guide`, `push_week_plan` with `dryRun: false`, `delete_guide`, `generate_daily_digest`, `log_session`) writes nothing and only returns a short note on what it would do with real credentials. `get_upload_status` has no uploads to find.

You can't mistake demo data for real data: every tool result is JSON with a top-level `"demo": true` (a result that is a list, or text such as a GPX file, comes back as `{ "demo": true, "data": … }`), the server's instructions and the prompts say the data is synthetic, and the startup line says DEMO MODE. Errors are unchanged. `npm run doctor` with `SUUNTO_DEMO=1` just reports that demo mode is on. When your API access arrives, remove `SUUNTO_DEMO` and follow the setup below. Demo mode applies to the MCP server only, not to the terminal commands.


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


> ⏳ **Stop here and wait.** Once you've subscribed, Suunto needs to approve your request. This takes **3–4 weeks**. You'll get an email when it's done. Come back to Steps 3–4 only after your subscription shows as **Active** in your apizone profile.


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

> **Only if you want to push guided workouts to your watch** (see [What you can push](TOOLS.md#what-you-can-push-to-your-watch)), add one more line: `SUUNTO_APP_NAME=your-app-name-here` — it must exactly match the app name you registered on apizone.suunto.com in Step 3, or the watch will reject the upload. Not needed for anything else.

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


## Upgrading

- **npx:** `npx -y suunto-mcp` fetches the newest version on a fresh start; if you pinned a version in `args`, change it. Restart Claude afterwards.
- **Cloned folder:** `git pull`, `npm install`, `npm run build`, then restart Claude.

See [CHANGELOG.md](../CHANGELOG.md) for what changed. From 1.0 on, [docs/CONTRACT.md](CONTRACT.md) says what stays compatible within 1.x (tool names, input schemas, documented output fields, local file formats) and what does not.

## Disconnecting

To fully remove access:

1. Log in to [apizone.suunto.com](https://apizone.suunto.com) → profile → **Authorized applications** → remove suunto-mcp. Suunto immediately stops honoring the connection.
2. Delete local credentials:
   ```bash
   rm -f ~/.suunto-mcp/tokens.json
   ```
   If you used `SUUNTO_TOKEN_STORAGE=keychain`, delete the "suunto-mcp" entry in your system keychain instead. The daily digest also keeps `~/.suunto-mcp/averages.json` and `SUUNTO_HISTORY.md`, `get_exercise_history` keeps `~/.suunto-mcp/cache/` and `log_session` keeps `~/.suunto-mcp/journal.json`, `set_plan` keeps `~/.suunto-mcp/plan.json` and `get_catchup` keeps `~/.suunto-mcp/seen.json` and `archive_workouts` keeps `~/.suunto-mcp/archive/` — delete them too if you want the health data gone (`rm -rf ~/.suunto-mcp/cache ~/.suunto-mcp/journal.json`).
3. Remove the `"suunto"` block from your Claude config and restart Claude.

