**Title:** Built a tool that lets Claude AI plan your gym sessions and push them straight to your Suunto watch

I made an open-source connector (suunto-mcp) that plugs your Suunto account into Claude (Anthropic's AI). Started as just pulling workout/sleep/recovery data into chats, but the part I actually wanted from day one just shipped: **Claude plans your gym sessions and syncs them to your watch — no app, no manual typing, no separate training software.**

Screenshots below are from my Vertical 2.

## How it works

1. You talk to Claude about your training — goals, equipment, injuries, current lifts. It also pulls your actual HRV/sleep from the watch, so it won't program a heavy session the day after bad recovery.
2. Claude writes the real session — exercises, weights, sets/reps, progression — and pushes it directly into your Suunto account via the official Cloud API (as a SuuntoPlus Guide).
3. It just shows up on your watch on the next normal sync — no extra pinning step needed in my testing.
4. On the watch: exercise name + weight/reps on screen, lap button advances to the next one. Between exercises there's a rest screen — a stopwatch (counts up, no forced target) plus a preview of what's next, and you lap when you're ready. Vibrate + "up next" notification when a new exercise starts.
5. After the session, Claude reads back what you actually did (from the workout log) and adjusts next week.

## Setup

Free, open source, MIT licensed: https://github.com/googlarz/suunto-mcp

You'll need Suunto API access — the docs say it's commercial-only, but private users can get approved too, it just takes 3-4 weeks. Once approved, setup with Claude is ~10 minutes.

Also works well with health-skill (github.com/googlarz/health-skill) if you want your recovery data driving the programming, not just displayed.

Happy to answer questions on the watch-side mechanics — had to reverse-engineer a chunk of the SuuntoPlus Guide format since the public docs are thin on it.
