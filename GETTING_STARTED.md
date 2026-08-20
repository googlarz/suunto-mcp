# Getting started

One guide, start to finish: Suunto API access → suunto-mcp installed →
Claude reading your data → (optionally) Claude checking it for you every
morning without being asked.

> **Safety note for anyone copy-pasting from this guide:** every credential
> shown below (`your-client-id`, `alice-suunto-2026`, etc.) is a placeholder.
> Nothing in this file is a real key. Never paste your actual Client Secret
> or Subscription Key into a chat, an issue, or a public gist — treat them
> like a password.

---

## Pick your pace

**In a hurry?** Open [Claude Code](https://claude.ai/code) and say:

> *"Please install and set up suunto-mcp from https://github.com/googlarz/suunto-mcp"*

Claude does the terminal work for you and tells you exactly when it needs
you (creating the apizone account, clicking Authorize — it can't do those
two for you). Skip the rest of this file; come back to
[How syncing actually works](#how-syncing-actually-works) once it's running.

**Want to understand each step as you go, or do it by hand?** Keep reading —
same steps, explained.

**Already have Suunto API access approved?** Jump straight to
[Part 2](#part-2-install-suunto-mcp).

---

## What you'll have at the end

Claude will be able to answer questions about your real Suunto data —
workouts, sleep, recovery — the moment you ask, and (if you want)
push a planned workout to your watch. There's no dashboard to check and
nothing to keep running: Claude fetches whatever's currently synced each
time you ask it something, and optionally checks in on its own every
morning if you set that up. One-time setup, no maintenance after.

---

## Part 1: Get Suunto API access

*(Skip this whole part if you're already approved — go to [Part 2](#part-2-install-suunto-mcp).)*

Suunto's own docs say API access is commercial-only. **That's not the full
picture** — private users get approved too, it just takes **3–4 weeks**.
Submit the request now; the wait is the only slow part of this whole guide.

1. Create an account at [apizone.suunto.com](https://apizone.suunto.com) —
   use the same email as your Suunto app (or Sports Tracker; same login).
2. Follow apizone's [How to start](https://apizone.suunto.com/how-to-start)
   guide to subscribe to the **Developer API** (free). Skip Sleep/Recovery/
   Daily Activity API for now — the Developer API alone is enough to begin.
3. **Wait for approval.** You'll get an email; your subscription shows
   **Active** in your apizone profile when it's ready. This is the one part
   of the whole process you can't speed up — everything else here takes
   minutes.

Once approved, come back and register your app:

4. Go to your [apizone profile](https://apizone.suunto.com/profile) →
   **OAuth application settings** and fill in:

   | Field | Enter |
   |-------|-------|
   | App name | `suunto-mcp` (or anything) |
   | Client secret | A password you make up, e.g. `alice-suunto-2026` — don't use this exact example, write down your own |
   | Redirect URI | `http://localhost:8421/callback` — copy exactly |

   Save. Suunto shows you a **Client ID** — copy it.
5. Scroll to **Subscriptions** on the same profile page, find your
   Developer API subscription, and reveal its **Primary Key** (your
   Subscription Key).

You now have three values — Client ID, Client Secret, Subscription Key.
Write them down somewhere private. You'll paste them into a local file in
the next part, never into this chat or anywhere public.

---

## Part 2: Install suunto-mcp

```bash
git clone https://github.com/googlarz/suunto-mcp
cd suunto-mcp
npm install
npm run build
```

Then create your credentials file:

```bash
cp .env.example .env
open -e .env          # Mac — use `notepad .env` on Windows
```

Replace the placeholders with your real three values from Part 1:

```
SUUNTO_CLIENT_ID=your-client-id-here
SUUNTO_CLIENT_SECRET=your-client-secret-here
SUUNTO_SUBSCRIPTION_KEY=your-subscription-key-here
```

Save and close — `.env` stays on your machine, it's never committed or sent
anywhere except directly to Suunto's API.

Pair your account:

```bash
npm run auth
```

A browser opens to Suunto's real login page. Sign in, click **Authorize**,
and the terminal confirms *"Paired successfully."* One-time — it renews
itself after this.

Check everything's working:

```bash
npm run doctor
```

Every line should show ✓. If one shows ✗, its message tells you exactly
what to fix.

---

## Part 3: Connect to Claude

Add suunto-mcp to your Claude config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on Mac,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows — create the file
if it doesn't exist):

```json
{
  "mcpServers": {
    "suunto": {
      "command": "node",
      "args": ["/absolute/path/to/suunto-mcp/dist/index.js"],
      "env": {
        "SUUNTO_CLIENT_ID": "your-client-id",
        "SUUNTO_CLIENT_SECRET": "your-client-secret",
        "SUUNTO_SUBSCRIPTION_KEY": "your-subscription-key"
      }
    }
  }
}
```

Get the real path with `pwd` while inside the suunto-mcp folder. If the file
already has other servers, add the `"suunto"` block alongside them — don't
replace the whole file.

Restart Claude Desktop, then ask:

> *"What was my most recent workout?"*

Real sport, date, distance back → done.

---

## How syncing actually works

This trips people up, so it gets its own section instead of being buried in
troubleshooting.

**There's no "sync button" and nothing runs in the background by default.**
The chain is: your watch → the Suunto phone app (over Bluetooth) → Suunto's
own cloud → suunto-mcp reads from that cloud the moment you ask Claude
something. suunto-mcp never talks to your watch directly and never stores a
copy of your data — every question pulls fresh from Suunto's servers.

That means:
- **Freshness depends on your phone**, not on suunto-mcp. If you ask Claude
  about "today's workout" right after training but before your phone's Suunto
  app has synced, Claude sees yesterday's data — not because anything's
  broken, just because Suunto hasn't received it yet. Open the Suunto app,
  let it sync, then ask again.
- **Pushed guides work the same way in reverse.** When Claude pushes a
  workout to your account (see the main [README](README.md#what-you-can-push-to-your-watch)),
  it lands on Suunto's servers instantly — but it only reaches your *watch*
  on the next normal phone sync. No extra step needed, just not instant.
- **Nothing is polling in the background.** Claude only fetches data when
  you (or a scheduled prompt, see below) actually ask a question. There's no
  daily-sync job inside suunto-mcp itself to configure.

If you want something to run every morning without you asking — that's not
suunto-mcp syncing on a schedule, it's a scheduled *Claude prompt* that asks
suunto-mcp questions on your behalf. That's the next section.

---

## Optional: check in automatically every morning

If your Claude setup supports scheduling recurring prompts (Claude Code's
`/schedule`, or an equivalent in whatever client you use), you can have it
check your recovery and yesterday's training each morning without opening
anything.

The prompt to schedule:

> Check my Suunto recovery (HRV balance) and sleep from last night, and my
> most recent workout. Give me a two-sentence summary — how recovered I am,
> and whether I should train hard or ease up today. If my watch hasn't
> synced yet (data looks like it's from before last night), say so instead
> of guessing.

That last sentence matters — without it, a scheduled check run before your
phone has synced will confidently report stale data as if it were current.
Building that in from the start avoids a confusing first morning.

This is a client-side scheduling feature, not something suunto-mcp ships or
configures — set it up the same way you'd schedule any other recurring
Claude prompt.

---

## Troubleshooting

Full table (every error message and its fix) lives in the main
[README's Troubleshooting section](README.md#troubleshooting) — this guide
only covers the happy path.

---

## For Claude: setting this up for someone

If a user asks you to install and configure suunto-mcp for them, follow
this procedure rather than diving straight into commands:

1. **Ask their pace preference first** — do they want you to just handle it
   end-to-end and only interrupt them for the two steps you can't do
   (creating the apizone account, clicking Authorize), or do they want you
   to explain each step as you go? Match your narration to their answer.
2. Check whether they already have Suunto API access approved. If not, walk
   them through Part 1 registration, then **stop and tell them plainly**
   that the 3–4 week wait is real and there's nothing to do until they get
   the approval email — don't imply you can speed this up.
3. Once they confirm approval, run Part 2 yourself (clone, install, build,
   `.env`, `npm run auth`, `npm run doctor`). Never ask them to paste
   credential values into the chat — tell them which file to edit and what
   to put in it, let them do that part themselves.
4. Wire up Part 3 (Claude config) for them, using the real path from `pwd`.
5. Verify with the test question before declaring it done.
6. **Only after it's confirmed working**, mention the optional daily
   automation from this guide — offer it, don't assume they want it, and if
   they say yes, include the stale-data caveat sentence in the scheduled
   prompt verbatim.
