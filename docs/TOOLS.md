# What you can ask and what the tools do

Examples, the data Claude can read, what it can push to your watch, the prompts, and the full tool reference. Moved out of the [README](../README.md). The wording of each tool's description in release 1.3.0 (before it was shortened in 1.3.1) is kept in [TOOL-DETAILS.md](TOOL-DETAILS.md).

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


## What data is available

| Category | What you can ask about | Requires |
|----------|----------------------|---------|
| **Workouts** | Any recorded activity — runs, hikes, rides, swims, ski tours. Distance, time, heart rate, pace, elevation, power, and lap-by-lap data for guided sessions. | Developer API *(already subscribed)* |
| **Sleep** | Sleep duration, stages (light/deep/REM), sleep score. | Sleep API subscription on apizone |
| **Recovery** | Recovery balance and stress state through the day (HRV comes with the sleep data). Balance is the watch's *Resources* percentage (0.96 = 96%); stress state 1 = Recovering, 2 = Active. The app's single *Recovery state* percentage is not in the API. | Recovery API subscription on apizone |
| **Daily activity** | Steps, calories, 24/7 heart rate. | Daily Activity API subscription on apizone |

To add sleep, recovery, or daily activity: go back to [apizone.suunto.com](https://apizone.suunto.com), find each product, and subscribe. Then run `npm run doctor` to confirm they're active.


## What you can push to your watch

Suunto MCP isn't read-only. Claude can also send things back to your account:

| You want to | Ask Claude | Requires |
|---|---|---|
| Get a gym plan on your wrist | *"Plan today's workout and send it to my watch"* | `SUUNTO_APP_NAME` set (see Step 6) |
| Upload a workout from another device | *"Upload this FIT file as a Suunto workout"* | — |
| Grab a saved route as GPX | *"Export my Sunday route as GPX"* | — |

**Guided workouts** show up as a SuuntoPlus Guide: exercise name and weight/reps on screen, lap button advances to the next one, a stopwatch (not a countdown) between exercises with a preview of what's next, a vibrate when a new exercise starts, and a "session complete" screen at the end. There's no live push to the watch itself — it appears after your phone's next normal Suunto app sync, same as any other watch data.

This pairs naturally with a coaching workflow: describe your goals, equipment, and current lifts to Claude, and it can write a real progressive program and push each session directly — see [Pairs well with health-skill](#pairs-well-with-health-skill) below for recovery-aware programming.


## Prompts

MCP clients that support prompts (for example Claude Desktop) list these as one-click workflows. Each fills in the exact dates and tells Claude which tools to call.

| Prompt | What it does | Optional argument |
|---|---|---|
| `suunto-morning` | Morning briefing: last night's sleep, recovery on waking (set against your own recent band), yesterday's load and workouts, how ready today is | `date` (YYYY-MM-DD, default today) |
| `suunto-weekly` | Weekly review: sleep, HRV, recovery and training load against the week before, each gym session against its plan | `endDate` (YYYY-MM-DD, default yesterday) |
| `suunto-gym-today` | Readiness gate: cut planned intensity 20-30% if last night's HRV or sleep score is below your own recent band (`get_baselines`), otherwise train as planned | `date` (YYYY-MM-DD, default today) |
| `suunto-gym-review` | Review of a day's guided gym session: sets done against the plan, deviations with their basis, heart-rate recovery in the rests; says plainly when the numbers are unreliable | `date` (YYYY-MM-DD, default today) |


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


## Predictions, experiments and session drafts

Three small tools for checking your own judgement. They keep local files only (see [Local files](CONFIGURATION.md#local-files)); nothing here writes to Suunto or to the watch.

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


## Approvals: nothing reaches your watch without your yes

The approval queue is the safe way to let Claude prepare changes for you. `queue_adjustment` stores a prepared change in `~/.suunto-mcp/approvals.json`: an adjusted guide (what `adjust_guide` returned) or a week of guides (what `propose_next_week` returned). It is checked the way the push tool checks it, so a change that would not push is refused when it is queued. **Queueing never pushes.** `propose_next_week` and `adjust_guide` queue nothing themselves: each hands back a `queuePayload` (exactly the arguments of `queue_adjustment`), and Claude passes it on when you ask for it. A change is for the day of its guide, so a guide dated before today is refused, `forDate` can only be that date, and an approval cannot outlive that day (it expires at the end of it, in the server's local time, or earlier if you say so).

Later you look at the queue (`list_approvals`: pending, expired, decided, each with its reasons; `get_catchup` also shows what is pending) and decide with `resolve_approval`:

- **reject**: recorded, nothing else.
- **approve**: recorded; you get the payload and a `call` in the **dry-run form** (`push_week_plan` with `dryRun: true`), plus a line saying that `resolve_approval` with `push: true` is the only way to push. Nothing is pushed, and no ready real-push call is handed out.
- **approve with `push: true`** (same call): pushes through the existing push path. A week of guides is a dry run unless you also say `dryRun: false`. This is the only way anything in the queue reaches the watch.

An item that expired cannot be approved, and neither can one with a guide dated before today (rejecting is always possible). Resolving an item twice gives you the first answer back and never pushes twice. Real pushes need `SUUNTO_APP_NAME`, as `push_strength_guide` does; in demo mode the queue lives in memory and `push: true` never pushes. Whether a pushed guide shows on a real watch is as unverified as `push_strength_guide` itself (see Known limits). Every writer of the file (queueing and resolving, a push included) runs one at a time **within the server process**, so a queued item is never lost behind a slow push (it waits for it); two server processes writing in the same moments could still collide, as with the other local files.

### Predictions that follow a recommendation

`propose_next_week` with `predict: true` hands back, for each load it proposes to raise, a ready `log_prediction` payload: "I will complete these sets and reps at this weight on that day", labelled with the rule `progression`. Claude shows them; you log the ones you want (it never logs them itself). The probability is a stated mapping: your own hit rate for the `progression` rule once 20 of them have been scored (predictions scored from a confirmed `draft_session_log` are left out of that count, since they began as the plan itself), else 0.65, never below 0.5 or above 0.9. The loop: **propose** (with `predict`) -> **log** the predictions -> train and `log_session` what you did -> `score_predictions` -> `get_prediction_stats` (its `byRule` view shows how the `progression` rule is doing). If your increases hold up, the probabilities rise with them; if they do not, the numbers say so.


## Pairs well with health-skill

If you use [googlarz/health-skill](https://github.com/googlarz/health-skill) — a Claude skill for symptom triage and health Q&A — you can connect both to Claude: health-skill handles the health side while Claude reads your training, sleep, and recovery data from Suunto MCP in the same conversation. Together they can answer questions like *"given my recovery scores this week, should I keep tomorrow's interval session?"* with real numbers.

The same combination works for planning, not just Q&A: Claude can check your actual HRV and sleep before writing a session, scale it back on a bad recovery day instead of a generic one, and push the result straight to your watch with `push_strength_guide` (gym) or `push_interval_guide` (cardio). Ask for it directly — *"check my recovery and plan today's gym session"* — no extra setup beyond having both connected.

To also store your daily step counts in health-skill's own records, run `suunto-mcp sync-to-health-skill --health-root <your health folder>` (add `--person-id` for a household member). It copies steps only, and only for days that are finished — today's total is picked up tomorrow.

For the full version — real progressive-overload programming that persists week to week instead of a one-off ask — install [googlarz/gym-skill](https://github.com/googlarz/gym-skill): `/gym setup` once, then `/gym plan`/`/gym today`/`/gym log`/`/gym review` going forward.


## All available tools (reference)

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
| `import_workouts` | Imports workouts exported from other systems (Garmin Connect, a Strava bulk export, GPX/TCX/FIT from Apple Watch apps and others) from a folder or one file you name (absolute path, `.fit`, `.gpx`, `.tcx`, one folder level; copy files out of `~/Downloads` first) into `~/.suunto-mcp/imported/`, apart from the Suunto archive. `source` (`garmin`, `strava`, `apple`, `other`) is a label. Stores the file as given plus a JSON record with a summary (start, duration, distance, heart rate, ascent, sport, GPS); skips a file already imported (by SHA-256), does not import a workout that starts within 60 s of a stored one and lasts within 5 % of it (`possibleDuplicate`), and refuses files that fail the checks (`refused`, with the reason; nothing is written for them). A call reads at most 200 files and imports at most `limit` (default 50) new workouts; when `remaining` is above 0, call again with `after` set to the `nextAfter` it returned (refused files leave nothing behind, so `after` is what moves the folder on). The lists in the result show their first 50 entries, with the totals in `...Count` fields. Local only: never contacts Suunto or any network. Annotated not read-only, not destructive, not idempotent, not open-world |
| `get_import_status` | What the local imports folder holds: workouts per source, bytes, the date span, and every file that does not check out. Local files only, read-only, needs no credentials |
| `get_weekly_report` | A shareable report for one finished Monday-to-Sunday week (`week` = its Monday, default the last full week): workouts, sleep, HRV, waking recovery and steps as the week's median against your own 28 days before it, training load at the end of the week, the week's guided strength sessions, plan adherence and tag effects. Returns the numbers plus a self-contained `markdown` text with no account id, token, workout key or file path; a section without enough data says "insufficient data", and tag effects appear only when not insufficient. With `save: true` it also writes `~/.suunto-mcp/reports/week-<Monday>.md` (never replaces a different file unless `overwrite: true`). Reads about 30 requests from Suunto, changes nothing there |
| `estimate_route_time` | How long a saved route takes **you**: reads the route's GPX and fits your own pace on flat, uphill and downhill ground to your archived walking/hiking (or running) workouts (run `archive_workouts` first; workouts from `import_workouts` fill in after them and `model.sources` says how many of each were used; `model.workoutsUsed` counts imported workouts too, while `workoutsConsidered` and `skipped` count the Suunto archive only). Gives the total, splits for ascent, descent and flat stretches, and with a `sunset` you supply (ISO time with offset, nothing is looked up) the latest start with a margin. With too little archived data it says `insufficient` and falls back to a clearly labelled generic Naismith estimate (5 km/h plus 1 h per 600 m climbed). An estimate of moving time, not a promise. Read-only |
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
| `push_strength_guide` | Push a per-set strength session (prep stopwatch, set/rest lap tracking, configurable rest mode, `3/6 - 2/3` step titles (exercise/set), optional rest target HR, optional per-exercise `last` / `target` hints such as `3x8@60kg` / `3x8@62.5kg` shown in a `TODAY` popup when the exercise's prep step starts, at most 36 characters (a long `last` is shortened, then dropped, so the target is never cut; if nothing fits there is no popup), not part of the lap labels; how the titles and popups render on a real watch is not yet verified, see [Known limits](LIMITS.md#known-limits--not-yet-verified-on-real-devices)) — requires `SUUNTO_APP_NAME` |
| `push_week_plan` | Push a week of strength guides in one call: one NEW guide per date (the arguments of `push_strength_guide` per guide, without `guideId`; at most 14, dates must differ), each read back like `push_strength_guide`. **`dryRun` defaults to true**: it then only validates every guide and returns what it would push, without contacting Suunto; pass `dryRun: false` to push. The first failure stops the push and the result names what was pushed, what failed and what was left. Pushing the same plan twice creates duplicates (`list_guides` / `delete_guide`). Requires `SUUNTO_APP_NAME` for a real push |
| `list_guides` | List all SuuntoPlus Guides on your account |
| `delete_guide` | Permanently delete a guide by id |

**Other**

| Tool | What it does |
|------|-------------|
| `list_subscriptions` | **Hidden by default** — Suunto's servers reject this call (OperationNotFound, checked on one account, September 2026); set `SUUNTO_ENABLE_LEGACY_TOOLS=1` to list it |
| `generate_daily_digest` | Writes the daily health digest to `SUUNTO_HISTORY.md` (see *Daily health digest*) — a write tool |

