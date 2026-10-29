# Design: `compare_workout_to_plan`

Status: design, ready to implement. Nothing here is built yet.

A read-only MCP tool that maps the manual laps of a guided gym session to exercises, sets and rests, and reports planned against actual. It also reports deviations honestly, and each deviation says what it rests on. It closes the loop that today's consumers (the evening wrap-up and the gym coach skill) do by hand on `get_workout_laps` output.

Sources read: `src/laps.ts`, `src/laps.test.ts`, `src/guide-zip.ts`, the `push_*_guide` and `get_workout_laps` descriptions in `src/index.ts`, `test-fixtures/fetch-stub.mjs`, and three real lap tables (45, 51 and 69 laps; see §9). No row of the real data is copied into the repo. The fixtures in `test-fixtures/compare/` are synthetic.

Key decisions:

1. **The lap labels are the plan.** A pushed guide is a fixed sequence of steps. A lap press advances exactly one step (except in a countdown rest and in "Session complete", where it only logs a lap), so the label sequence encodes exercises, set counts and rest targets. `plan` is optional. It is only used to check the session against the coach's intent: missing, extra or reordered exercises, set counts and rest targets.
2. **Every deviation carries a `basis`.** `labels` means it follows from the guide mechanics. `plan` means it was found against the caller's plan. `heuristic` means a threshold guess. Extra sets can never be read directly from the labels (the guide fixes the set count). They show up as heuristics (`long-set`, `rest-split`, `after-complete`) or against a plan (`extra-set`).
3. **Countdown rests are not compliance data.** In countdown mode the watch auto-advances, so a rest lap always lasts exactly its target. This holds for all three real sessions. Rest overruns therefore land inside the next set's lap. Rest-long/short is reported only for stopwatch rests.

---

## 1. What the laps can tell (a)

### 1.1 Label grammar (from `src/guide-zip.ts`, after `cleanLabel` joins lines with ` | `)

| Guide / step | Raw text (truncated to N chars before joining) | Label as returned by `get_workout_laps` | `kind` |
|---|---|---|---|
| strength prep (every exercise) | `${plates ?? detail}\n${name}`, N=40 | `2x20/side \| Back Squat` | step |
| strength set (perSet) / work step (perExercise) | `${name}\n${detail}`, N=40 | `Back Squat \| 100kg 3x5` | step |
| strength rest, restMode countdown | `Next: set ${k}/${S}`, N=40 | `Next: set 2/3` | rest |
| strength rest, restMode stopwatch | `${restSec}s target · Next: set ${k}/${S}`, N=40 | `90s target · Next: set 2/3` | rest |
| workout guide exercise step | two text fields: name, detail (N=54 each) | `Push-Up \| BW 3x15` | step |
| workout guide rest (between exercises) | `Next: ${nextName}` (N=54), next detail (N=54) | `Next: Dumbbell Curl \| 12kg 3x12` | rest |
| both, final step | `Session complete` | `Session complete` | done |

Lap sequences that the step transitions imply:

- **strength perSet:** per exercise `prep, set 1, rest(2/S), set 2, …, rest(S/S), set S`. Then the next exercise's prep follows. A single "Session complete" closes the session. Prep, set and stopwatch-rest steps advance on a lap press. A countdown rest advances on its own after `restSec`. The next set step then logs a lap itself (`createManualLap`). A lap press during a countdown rest logs a lap but does not advance, so the rest splits into consecutive laps with the same label. That is lapChecks' `duplicate-rest`.
- **strength perExercise:** per exercise `prep, work`. There are no rest laps.
- **workout guide:** `ex 1, rest(Next: ex 2), ex 2, …, ex N, Session complete`. All steps advance on a lap press.
- **"Session complete"** has no transition. Every further lap press logs another lap with the same label (§9 finding 1).

Prep and set labels are not the same text. Their halves are swapped (`load | name` against `name | detail`), and the prep shows `plates` instead of `detail` when plates were given. The design still separates them **by position**, because position is unambiguous and text is not (when `name === detail`, or when truncation hides the swap). Text is used only for consistency checks.

### 1.2 Derivable from the labels alone

| Item | Source | Notes |
|---|---|---|
| Exercise order and names | set/work label, first part | The name is cut if `name.length >= 40` (strength) or `>= 54` (workout) |
| Display detail (load, sets×reps text) | set/work label, rest of the parts | Can be cut by the 40-char cap. Passed through as text, not interpreted |
| Planned sets (perSet) | `S` in `Next: set k/S` | For an exercise with 1 set (no rest laps) that the guide passed through: 1 |
| Planned sets (perExercise, workout, or an exercise cut short) | last `N×` token in detail (`3x5` → 3) | Informational; null when the detail has no `N×R` |
| Rest target (perSet stopwatch) | `(\d+)s target` in the rest label | Exact |
| Rest target (perSet countdown) | median duration of the exercise's rest gaps | The watch auto-advances, so the duration *is* the target (verified: §9) |
| Sets done, per-set time and HR, rest time and HR | lap rows | — |
| Whether the guide ran to the end | presence of a `Session complete` lap | — |
| Work after the guide ended | laps after the first `Session complete`, except the last | — |
| Exercises the guide had but the session never reached | **not derivable** | A prep label does not carry the exercise count (`i/N` is in the step title, which is not in `intervalNotes`) |

### 1.3 The optional `plan`

```json
[{ "name": "Back Squat", "sets": 3, "restSec": 120 }]
```

| Field | Required | Why it exists |
|---|---|---|
| `name` | yes | Matches plan entries to session exercises. This yields `missing-exercise` (including "not reached" when the session ended early, which labels cannot show), `extra-exercise` and `order-differs`. It also recovers names cut by the label cap (prefix match, §3.7). |
| `sets` | no | The coach's intended set count. Against perSet laps it gives a certain `extra-set` / `missing-set`, for example when the program changed after the guide was pushed. It is ignored for perExercise and workout formats, because there sets are not lapped. |
| `restSec` | no | The coach's intended rest. Compared with the guide's rest target (countdown or stopwatch) → `rest-target-mismatch`. Actual rest is always judged against the guide's own target, because that is what the user saw. |

The field names and types match a `push_strength_guide` exercise item (`name`, `sets`, `restSec`). So the caller can pass the exact array it pushed: `detail`, `plates` and any other field are ignored (the validator does not reject unknown properties). A `push_workout_guide` exercises array (`name`, `detail`) is also valid.

Fields left out on purpose:

- **reps and load:** laps carry no rep count and no weight. The tool could only echo them, and the `detail` text already shows what the guide displayed.
- **order:** the array order is the order.

---

## 2. Tool interface (b)

### 2.1 Input schema (`src/index.ts`, `toolDefs`)

```json
{
  "type": "object",
  "properties": {
    "workoutKey": {
      "type": "string",
      "minLength": 1,
      "description": "The 24-character workoutKey returned by list_workouts. Anything else fails with a not-found error without calling Suunto."
    },
    "plan": {
      "type": "array",
      "minItems": 1,
      "description": "Optional: what the session was meant to be, in order. Pass the exercises array given to push_strength_guide or push_workout_guide as-is — only name, sets and restSec are read. Without it the plan is read from the lap labels alone.",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "minLength": 1, "description": "Exercise name as pushed to the guide, e.g. 'Back Squat'." },
          "sets": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Planned number of sets." },
          "restSec": { "type": "integer", "minimum": 1, "description": "Planned rest between sets, in seconds." }
        },
        "required": ["name"]
      }
    }
  },
  "required": ["workoutKey"]
}
```

`tool-meta.ts`: `compare_workout_to_plan: { title: "Compare workout to plan", annotations: READ }`.

Tool description (copy verbatim):

> Compares one guided gym session with its plan: maps the manual laps (the same data get_workout_laps returns) to exercises, sets and rests, and reports planned vs actual with honest deviations. Works for sessions pushed with push_strength_guide (lapGranularity perSet or perExercise, restMode countdown or stopwatch) and push_workout_guide. The plan — exercise order, set counts, rest targets — is read from the lap labels, so `plan` is optional; pass the exercises array you pushed to also check the session against it (missing, extra or reordered exercises, set counts, rest targets). Output: { workoutKey, guide, status ('ok' | 'no-laps' | 'no-guide-labels' | 'unknown-label-format'), format ('strength-perSet' | 'strength-perExercise' | 'workout'), restMode ('countdown' | 'stopwatch' | null), complete (the guide's 'Session complete' lap was reached), reliable, note, checks (get_workout_laps' checks, passed through), lapCount, baselineHr (heart rate of lap 1, the first prep — null for workout guides), cols, exercises: [{ n, name, detail, plan (index into plan or null), planned: { sets, restS }, prep, sets, rests }], afterComplete, unattributed, deviations: [{ code, basis ('labels' | 'plan' | 'heuristic'), ex, plan, laps, detail }] }. prep, sets, rests, afterComplete and unattributed rows are arrays in the column order given by cols. A rest row's peak is the rest lap's max HR and end its min HR (optical HR lags 20–30 s, so the peak lands in the rest, not in the set); endVsBaseline is end minus baselineHr. Deviation codes: unexpected-sequence, rest-split, rest-short, rest-long, short-set, long-set, missing-set, extra-set, rest-target-mismatch, extra-exercise, ended-early, unlabelled-lap, after-complete, order-differs, missing-exercise. reliable is false when checks is non-empty or the laps break the guide's step order; the mapping is then best effort and note says why. With restMode countdown a rest lap always lasts exactly its target (the watch advances by itself), so extra rest ends up inside the next set's lap and is not measurable. About 1–4 KB. Read-only.

### 2.2 Output schema

Top level, in this key order:

| Key | Type | Meaning |
|---|---|---|
| `workoutKey` | string | from the lap table |
| `guide` | `{id,name}` \| null | from the lap table |
| `status` | `"ok"` \| `"no-laps"` \| `"no-guide-labels"` \| `"unknown-label-format"` | anything other than `ok`: no analysis (§6) |
| `format` | `"strength-perSet"` \| `"strength-perExercise"` \| `"workout"` \| null | null unless status ok |
| `restMode` | `"countdown"` \| `"stopwatch"` \| null | strength-perSet only, from the first set-rest label |
| `complete` | boolean \| null | a `Session complete` lap exists; null unless status ok |
| `reliable` | boolean | §5 |
| `note` | string \| null | why it is not reliable, or why there is no analysis; null when status ok and reliable |
| `checks` | `[{code,detail}]` | `get_workout_laps` checks, verbatim |
| `lapCount` | integer | from the lap table |
| `baselineHr` | integer \| null | §4 |
| `cols` | object | always `{"prep":["lap","durationS","hrMax","hrMin"],"set":["k","lap","durationS","hrAvg","hrMax"],"rest":["k","lap","durationS","targetS","peak","end","drop","endVsBaseline"],"lap":["lap","durationS","hrAvg","hrMax"]}` |
| `exercises` | array | below |
| `afterComplete` | `lap` rows | laps after the first `Session complete`, except the last (closing) lap |
| `unattributed` | `lap` rows | guided-part laps left out of the mapping: null labels and orphan rests |
| `deviations` | array | §3.8, sorted per §3.9 |

Exercise object, in this key order: `n` (1-based session order), `name`, `detail` (string or null), `plan` (0-based index into the caller's plan, or null), `planned: {sets, restS}` (from the labels, §3.6), `prep` (`prep` row or null), `sets` (`set` rows; `k` is null when the lap covers the whole exercise: perExercise and workout), `rests` (`rest` rows; perSet only, otherwise `[]`).

Deviation object, in this key order: `code`, `basis`, `ex` (exercise `n` or null), `plan` (plan index or null), `laps` (lap numbers, possibly `[]`), `detail` (exact templates in §3.8).

Example: `test-fixtures/compare/extra-set.expected.json`, a 17-lap session with a plan. The tool returns it as compact JSON (`JSON.stringify(x)`, no indentation): 1.6 KB. The real 45-, 51- and 69-lap sessions come out at 2.6, 2.6 and 3.9 KB (the lap tables themselves are 3.4–4.8 KB).

```json
{"workoutKey":"5e1f7c0de000000000000002","guide":{"id":"synth002","name":"LEGS B"},
 "status":"ok","format":"strength-perSet","restMode":"countdown","complete":true,"reliable":true,"note":null,
 "checks":[],"lapCount":17,"baselineHr":90,
 "cols":{"prep":["lap","durationS","hrMax","hrMin"],"set":["k","lap","durationS","hrAvg","hrMax"],
         "rest":["k","lap","durationS","targetS","peak","end","drop","endVsBaseline"],"lap":["lap","durationS","hrAvg","hrMax"]},
 "exercises":[
  {"n":1,"name":"Romanian Deadlift","detail":"90kg 3x8","plan":0,"planned":{"sets":3,"restS":120},
   "prep":[1,88,96,86],
   "sets":[[1,2,34.2,101,117],[2,4,36,108,124],[3,6,88.5,124,141]],
   "rests":[[2,3,120,120,135,99,36,9],[3,5,120,120,138,102,36,12]]},
  {"n":2,"name":"Leg Press","detail":"160kg 4x10","plan":1,"planned":{"sets":4,"restS":90},
   "prep":[7,132.4,139,98],
   "sets":[[1,8,42,106,121],[2,10,44.1,111,127],[3,12,45.3,114,131],[4,14,46,116,134]],
   "rests":[[2,9,90,90,133,103,30,13],[3,11,90,90,136,106,30,16],[4,13,90,90,139,108,31,18]]}],
 "afterComplete":[[15,175,112,136],[16,36.4,109,122]],
 "unattributed":[],
 "deviations":[
  {"code":"long-set","basis":"heuristic","ex":1,"plan":null,"laps":[6],"detail":"set 3 lasted 88.5 s against a median of 35.1 s for the other sets: it may contain an extra set, or a lap press was forgotten"},
  {"code":"extra-set","basis":"plan","ex":2,"plan":1,"laps":[14],"detail":"4 sets recorded, the plan has 3"},
  {"code":"after-complete","basis":"labels","ex":null,"plan":null,"laps":[15,16],"detail":"2 lap(s) pressed after 'Session complete': work after the guide ended (an extra set, say), not attributed to an exercise"}]}
```

Non-ok skeleton, for example `no-laps`. Every analysis field is empty:
`{"workoutKey":…,"guide":…,"status":"no-laps","format":null,"restMode":null,"complete":null,"reliable":false,"note":"No laps: the workout has no manual laps, so there is nothing to compare.","checks":[…],"lapCount":0,"baselineHr":null,"cols":{…},"exercises":[],"afterComplete":[],"unattributed":[],"deviations":[]}`

---

## 3. Algorithm (c)

New module `src/compare.ts` exports the pure function `compareWorkout(laps: ReturnType<typeof shapeLaps>, plan?: PlanItem[])`. The tool handler is `compareWorkout(shapeLaps(await suunto.getWorkoutWithExtensions(a.workoutKey, LAP_EXTENSIONS)), a.plan)` → `text(JSON.stringify(...))`.

### 3.0 Constants and helpers

```
SET_REST        = /^(?:(\d+)s target\s*·\s*)?Next: set (\d+)\/(\d+)$/   // groups: target, k, S
STRENGTH_CAP    = 40    // TEXT_WITH_SIBLING_FIELDS_MAX in guide-zip.ts
WORKOUT_CAP     = 54
SHORT_SET_RATIO = 0.25;  SHORT_SET_MAX_S = 10
LONG_SET_RATIO  = 2;     LONG_SET_MIN_EXTRA_S = 30
REST_TOL_RATIO  = 0.2;   REST_TOL_MIN_S = 10
REST_MISMATCH_S = 2      // |plan.restSec − guide rest| must exceed this
CODE_ORDER = [unexpected-sequence, rest-split, rest-short, rest-long, short-set, long-set, missing-set,
              extra-set, rest-target-mismatch, extra-exercise, ended-early, unlabelled-lap,
              after-complete, order-differs, missing-exercise]

r1(x)         = Math.round(x*10)/10
parts(label)  = label.split(" | ")
rawLen(label) = label.length − 2*(parts(label).length − 1)       // length before " | " replaced "\n"
norm(s)       = s.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim()
links(a,b)    = A=norm(a), B=norm(b); A===B ? A.length>0 : min(len)>=3 && (A.startsWith(B) || B.startsWith(A))
median(xs)    = middle value, or the mean of the two middle values
detailSets(d) = d null → null; else the LAST match of /(\d{1,3})\s*[x×]\s*\d/gi → Number(group 1), none → null
                // last match: "2x32kg 3x40m" → 3, "3x45s" → 3, "BW 3x15" → 3
nextName(lbl) = parts(lbl)[0] with /^Next:\s*/ removed
maxOf(xs)     = max of the non-null values, or null
lapRow(r)     = [r.i, r.durationS, r.hrAvg, r.hrMax]
```

A row is read as `{i, durationS (=dur), hrAvg, hrMax, hrMin, kind, label}` by column index (`LAP_COLUMNS`).

### 3.1 Status gate

```
if lapCount == 0                      → skeleton, status "no-laps"
if every row.label is null            → skeleton, status "no-guide-labels"
```

Notes (exact):
- `no-laps`: `No laps: the workout has no manual laps, so there is nothing to compare.`
- `no-guide-labels`: `The laps carry no guide labels (no guide ran), so they cannot be mapped to exercises.`
- `unknown-label-format`: `The lap labels match neither the push_strength_guide nor the push_workout_guide format; read them with get_workout_laps.`

`plan` is ignored in every non-ok status: no deviations.

### 3.2 Split

```
firstDone = index of the first row with kind "done" (−1 if none)
complete  = firstDone != −1
guided    = complete ? rows[0 .. firstDone) : rows
tail      = complete ? rows[firstDone ..]   : []
cutLap    = complete ? null : guided.last.i      // its end is the recording stop, not a lap press
afterComplete = tail without its last row        // the last tail lap only closes the recording
```

### 3.3 Format

Look at the guided laps only (`kind` already comes from `lapKind`):

```
rests    = guided rows with kind "rest";  setRests = rests whose label matches SET_REST
steps    = guided rows with kind "step"
if setRests.length > 0 and setRests.length == rests.length → "strength-perSet"
elif rests.length > 0 and setRests.length == 0            → "workout"
elif rests.length == 0 and steps.length == 1               → "workout"            // one-exercise workout guide
elif rests.length == 0 and steps.length >= 2               → "strength-perExercise" (also perSet where every exercise has 1 set — same laps, same result)
else                                                        → skeleton, status "unknown-label-format"   // mixed rest kinds, or no step at all
restMode  = perSet ? (SET_REST.exec(setRests[0].label)[1] ? "stopwatch" : "countdown") : null
```

### 3.4 Strength segmentation (perSet and perExercise)

Position rules over the labelled guided laps. A null-label lap is pushed to `unattributed` and skipped: it does not change `prev`.

| previous labelled lap (`prev`) | this lap is a step | this lap is a rest |
|---|---|---|
| none (session start) | **prep** of a new exercise | orphan: `unattributed` + unexpected-sequence (ex null), `prev` unchanged |
| prep | **set 1** | unexpected-sequence "a rest lap straight after the prep"; still opens a rest gap |
| set | **prep** of a new exercise | **rest gap** (k from the label) |
| rest | **set k** (k of that gap) | same label → **split**: append to the current gap. Different label → unexpected-sequence "two different rest laps in a row", opens a new gap |

```
cur=null; prev=null; gap=null
for r in guided:
  if r.label == null: unattributed += r; nullLaps += r.i; continue
  if r.kind == "rest":
    if cur == null: unattributed += r; UNEXPECTED(null,[r.i],"a rest lap before the first exercise"); continue
    if prev == "rest" and gap.label == r.label: gap.parts += r; continue
    (target,k,S) = SET_REST groups of r.label         // always matches in perSet; perExercise has no rests
    lastK = cur.sets.last.k or 0
    if   prev == "prep": UNEXPECTED(cur.n,[r.i],"a rest lap straight after the prep")
    elif prev == "rest": UNEXPECTED(cur.n,[gap.parts.last.i, r.i],"two different rest laps in a row")
    elif k != lastK+1:   UNEXPECTED(cur.n,[r.i],`the rest announces set ${k} after set ${lastK}`)
    if cur.S undefined: cur.S = S  elif cur.S != S: UNEXPECTED(cur.n,[r.i],`the rest says ${S} sets, an earlier rest said ${cur.S}`)
    gap = {k, label:r.label, target (number or null), parts:[r]}; cur.gaps += gap; prev="rest"; continue
  # step
  if prev in (null, "set"): cur = new exercise {n, prep:r, sets:[], gaps:[], label:null}; prev="prep"; continue
  k = format=="strength-perSet" ? (prev=="rest" ? gap.k : 1) : null
  if cur.label == null:
    cur.label = r.label
    if parts(cur.prep.label).length >= 2 and not links(parts(cur.prep.label).last, parts(r.label)[0]):
      UNEXPECTED(cur.n,[cur.prep.i, r.i],"the prep and the first set name different exercises")
  elif r.label != cur.label: UNEXPECTED(cur.n,[r.i],"this set's label differs from set 1's")
  cur.sets += {k, r}; prev="set"
if complete and prev=="rest": UNEXPECTED(cur.n,[gap.parts[0].i],"'Session complete' straight after a rest lap")
if complete and prev=="prep": UNEXPECTED(cur.n,[cur.prep.i],"'Session complete' straight after a prep lap")
```

`UNEXPECTED(ex, laps, detail)` adds `{code:"unexpected-sequence", basis:"labels", ex, plan:null, laps, detail}`.

### 3.5 Workout-guide segmentation

```
pending=null; prev=null
for r in guided:
  if r.label == null: unattributed += r; nullLaps += r.i; continue
  if r.kind == "rest":
    if prev=="rest" and pending and pending.label == r.label: pending.parts += r; continue
    if prev=="rest" and pending:
       UNEXPECTED(null,[pending.parts[0].i, r.i],"two different rest laps in a row; the first is left out"); unattributed += pending.parts
    elif no exercise yet: UNEXPECTED(null,[r.i],"a rest lap before the first exercise")     // kept as the next exercise's prep
    pending = {label:r.label, parts:[r]}; prev="rest"; continue
  n = exercises.length+1
  if prev=="step": UNEXPECTED(n,[r.i],"two exercise laps in a row with no rest lap between")
  if pending and not links(nextName(pending.label), parts(r.label)[0]):
     UNEXPECTED(n,[pending.parts[0].i, r.i],"the rest lap announced a different exercise")
  exercise {n, prep:pending, sets:[{k:null, r}], label:r.label}; pending=null; prev="step"
if pending:                                    // stopped during the rest before an exercise
  if complete: UNEXPECTED(null,[pending.parts[0].i],"'Session complete' straight after a rest lap")
  exercise {n, prep:pending, sets:[], label:null}          // name and detail come from the "Next:" label
```

### 3.6 Per-exercise fields

```
name, detail, cut:
  label != null (a set/work lap exists): p=parts(label); name=p[0]; detail=p[1..].join(" | ") or null
       cut = workout ? p[0].length >= 54 : (p.length==1 and rawLen(label) >= 40)
  workout, not started:  name=nextName(prep.label); detail=parts(prep.label)[1..].join(" | ") or null; cut = parts(prep.label)[0].length >= 54
  strength, prep only:   name=parts(prep.label).last; detail=null (the prep shows plates OR detail, which cannot be told apart); cut = rawLen(prep.label) >= 40
  (`cut` is internal: it only enables prefix matching in §3.7; it is not output)

planned.sets:
  perSet:  cur.S ?? (exercise is not the last one, or complete ? 1 : detailSets(detail))
  else:    detailSets(detail)
planned.restS (perSet with ≥1 gap, else null):
  gaps[0].target != null → gaps[0].target                                   // stopwatch
  else round(median(gapTotal(g) for g in gaps where g is not cut)) or null if all cut   // countdown
  gapTotal(g) = r1(sum of part durations);  g is cut when its last part's i == cutLap

prep row:
  strength: [prep.i, prep.durationS, prep.hrMax, prep.hrMin]
  workout:  [parts[0].i, r1(Σ durations), maxOf(hrMax), parts.last.hrMin], or null for exercise 1
set row:   [k, r.i, r.durationS, r.hrAvg, r.hrMax]
rest row:  [g.k, g.parts[0].i, gapTotal(g), g.target ?? planned.restS, peak, end, drop, endVsBaseline]   (§4)
```

### 3.7 Plan matching

```
used = {}
pass 1 (exact), session order: ex.plan = first j not in used with norm(plan[j].name) == norm(ex.name) and norm(ex.name) != ""
pass 2 (cut names), session order, only for unmatched ex with cut and norm(ex.name).length >= 3:
        ex.plan = first j not in used with norm(plan[j].name).startsWith(norm(ex.name))
```

Normalisation: Unicode NFKD, combining marks dropped, lower-case, every run of non-letters and non-digits becomes one space, then trimmed. So `Push-Up` = `push up`, `Bench Press 15°` = `bench press 15`, `Überzug` = `uberzug`. There are no synonyms and no fuzzy distance: callers should pass the names they pushed. Duplicate names (the same exercise twice) match greedily in order.

### 3.8 Deviation classes

Each deviation is `{code, basis, ex, plan, laps, detail}`. `${x}` is JavaScript template interpolation with default number formatting. `m` is printed as `r1(m)`.

| code | basis | emitted when | ex / plan / laps | detail (exact) |
|---|---|---|---|---|
| `unexpected-sequence` | labels | a position rule above is broken | see §3.4/§3.5 | see §3.4/§3.5 |
| `rest-split` | labels | perSet gap with ≥2 laps (a lap pressed during a countdown rest — the **"extra set inside a too-long rest"** signature) | ex n / null / all part laps | `the rest before set ${k} spans ${n} laps: a lap was pressed during a countdown rest (a set done inside the rest looks like this)` |
| `rest-split` | labels | workout prep (rest) with ≥2 laps | ex n / null / all part laps | `the rest before this exercise spans ${n} laps` |
| `rest-short` | labels | stopwatch gap (label target), not cut, `total < target − tol`, `tol = max(10, round(0.2·target))` | ex n / null / [first part] | `rest before set ${k}: ${total} s against a ${target} s target` |
| `rest-long` | labels | same, `total > target + tol` | same | same template |
| `short-set` | heuristic | perSet, exercise with ≥2 sets, set not cut, `d < 0.25·m and d < 10` where m = median of the **other** sets' durations | ex n / null / [set lap] | `set ${k} lasted ${d} s against a median of ${m} s for the other sets: likely an accidental double lap press, so the set may not have been done` |
| `long-set` | heuristic | same scope, `d >= 2·m and d − m >= 30` (an extra set done inside the set lap, typically the last set) | ex n / null / [set lap] | `set ${k} lasted ${d} s against a median of ${m} s for the other sets: it may contain an extra set, or a lap press was forgotten` |
| `missing-set` | plan | perSet, matched, `plan.sets` given, `sets.length < plan.sets` | ex n / j / [] | `${done} of ${plan.sets} planned sets recorded` |
| `missing-set` | labels | perSet, no `plan.sets` for this exercise, `planned.sets` known, `sets.length < planned.sets` | ex n / null / [] | `${done} of ${planned.sets} sets recorded` |
| `missing-set` | labels | strength exercise with 0 sets, unless perSet with `plan.sets` (then the plan row above covers it) | ex n / null / [] | `no set recorded: the session ended during the prep` |
| `missing-set` | labels | workout exercise with 0 sets | ex n / null / [] | `the exercise was not started: the session ended during the rest before it` |
| `extra-set` | plan | perSet, matched, `plan.sets` given, `sets.length > plan.sets` | ex n / j / laps of sets beyond `plan.sets` | `${done} sets recorded, the plan has ${plan.sets}` |
| `rest-target-mismatch` | plan | perSet, matched, `plan.restSec` given, `planned.restS` not null, abs diff > 2 | ex n / j / [] | `the guide's rest was ${planned.restS} s, the plan has ${plan.restSec} s` |
| `extra-exercise` | plan | plan given, exercise unmatched | ex n / null / [] | `"${name}" is not in the plan` |
| `ended-early` | labels | `complete == false` | last exercise n (null if none) / null / [cutLap] | `no 'Session complete' lap: the recording stopped inside the guide; exercises after this one are not visible in the laps (pass plan to list them)` |
| `unlabelled-lap` | labels | null-label laps in the guided part | null / null / those laps | `laps without a guide label inside the guided part; left out of the mapping` |
| `after-complete` | labels | `afterComplete` non-empty (another place an extra set shows up) | null / null / those laps | `${count} lap(s) pressed after 'Session complete': work after the guide ended (an extra set, say), not attributed to an exercise` |
| `order-differs` | plan | matched plan indices, in session order, are not non-decreasing | null / null / [] | `plan entries in session order: ${seq.join(", ")}` |
| `missing-exercise` | plan | plan index j unmatched | null / j / [] | `"${name}" was not reached: the session ended early` when `!complete and j > max matched index`, else `"${name}" is not in this session` |

How each deviation class named in the brief is reported:

- **Extra set.** It cannot appear in the label sequence, because the guide fixes the set count. It is reported as `extra-set` (plan, certain), `long-set` (an extra set inside a set lap), `rest-split` (inside a countdown rest) or `after-complete` (after the guide). The last three are evidence, not verdicts.
- **Missing set.** `missing-set` with basis plan or labels. `short-set` covers a set that was likely skipped by a double press.
- **Rest longer or shorter than target.** `rest-long` / `rest-short`, for stopwatch only. In countdown mode only the plan-versus-guide `rest-target-mismatch` is possible.
- **Unlabelled laps.** `unlabelled-lap` plus the `unattributed` rows.
- **Duplicate rest.** `rest-split`; the gap is merged into one rest row.
- **No "Session complete".** `ended-early`, plus `missing-set` for the cut exercise and `missing-exercise` ("not reached") for plan entries after it.
- **Order differs.** `order-differs`.
- **Exercise missing or extra.** `missing-exercise` / `extra-exercise`.

### 3.9 Ordering, reliability, note

```
sort deviations by (ex ?? ∞, laps[0] ?? ∞, CODE_ORDER index, plan ?? −1)
reasons  = unique([...checks.map(c => c.code), ...("unexpected-sequence" if any such deviation)])
reliable = reasons.length == 0
note     = reliable ? null : `Positional mapping is unreliable (${reasons.join(", ")}); exercises, sets and rests below are best effort.`
```

---

## 4. Metric definitions (d)

| Metric | Definition |
|---|---|
| set time | `durationS` of the set lap, from lap press to lap press. In countdown mode this includes any time the user kept resting after the countdown ended. |
| set HR | `hrAvg`, `hrMax` of the set lap, as recorded. Optical HR lags 20–30 s, so a set's real peak usually lands in the following rest lap. |
| rest seconds | `r1(Σ durationS)` of the rest gap's laps (a split gap is summed) |
| rest target `targetS` | stopwatch: the label's `Ns target`. Countdown: the exercise's `planned.restS` (median of uncut gap totals). Equal to the duration by construction. |
| rest HR `peak` | `max(hrMax)` over the gap's laps: the lagged peak of the set before it |
| rest HR `end` | `hrMin` of the gap's **last** lap |
| `drop` | `peak − end` (null if either is null) |
| `baselineHr` | `hrAvg` of lap 1, an approximation of pre-start HR. For strength formats lap 1 is the first prep (standing around, loading). **Null for `workout`**: there lap 1 is the first exercise itself. |
| `endVsBaseline` | `end − baselineHr` (null if either is null) |
| prep `hrMax`/`hrMin` | the prep lap's own values. It is self-paced, with no target. For the workout guide it is the rest gap before the exercise (max of hrMax, last hrMin). |

This keeps the evening wrap-up convention: per exercise sets (time, HR avg/max) | rest (s) | rest HR peak → end | end vs baseline. With `lapCount` 0 the result is `status:"no-laps"` with no analysis. Durations are rounded to 0.1 s (`r1`). HR values are integers, as in the lap table.

---

## 5. How `checks` propagate (e)

`checks` is copied verbatim. If it is non-empty, or any `unexpected-sequence` was emitted, then `reliable:false` and `note` names the reasons. The output is still produced in full. The positional rules are applied regardless, and `rest-split` merging and `unattributed` keep the mapping usable.

- `duplicate-rest` → merged gap and `rest-split`.
- `unlabelled-laps` → `unattributed` and `unlabelled-lap`.
- `no-session-complete` → `ended-early`.
- `no-heart-rate` → every HR field is null and `baselineHr` is null. Duration heuristics still run.

Non-ok statuses have `reliable:false` and the status note. Checks are still passed through.

---

## 6. Failure and edge cases (f)

| Case | Result |
|---|---|
| `lapCount` 0 (unguided gym, cycling, interval guide) | `status:"no-laps"`, no analysis |
| all labels null (no guide ran) | `status:"no-guide-labels"`. No positional mapping is attempted even with `plan` (§8 Q8) |
| labels in no known format (mixed `Next: set k/S` and `Next: <name>` rests, or only a `Session complete` lap) | `status:"unknown-label-format"` |
| single exercise | Works in every format. A one-exercise workout guide is `step, done` → `workout` |
| perSet session where every exercise has 1 set | Same laps as perExercise → `strength-perExercise`. `k` is null and `planned.sets` comes from the detail |
| session stopped during the very first strength prep | 1 step lap, no rests → classified `workout`, with the name taken from the prep's first part (load text). Accepted: no sets were done anyway |
| stopped during a prep | prep-only exercise: name from the prep label's last part, `detail` null, `missing-set` |
| stopped during a rest | That gap is cut: no rest-short/long and no countdown inference from it. `ended-early` |
| last set cut by the stop | Not judged by short-set/long-set |
| name ≥ 40 chars (strength) / ≥ 54 (workout) | Shown cut. Plan matching falls back to a prefix match |
| `name === detail`, or both halves truncated alike | Position still decides prep vs set; the link check passes (equal) |
| no heart rate | HR fields null; `reliable:false` via the `no-heart-rate` check (§8 Q1) |
| HR null on lap 1 only | `baselineHr` null, `endVsBaseline` null |
| `plan` with an unmatched duplicate | `missing-exercise` for the leftover entry |
| work done after "Session complete" without a lap press | Hidden in the closing lap, which is not reported. `get_workout_laps` shows it |
| an older guide's rest label `Next: Bench press → 60kg` | `workout` format; the link check passes via prefix |

---

## 7. Test plan (g)

### Fixtures (`test-fixtures/compare/`)

Each case has `<case>.laps.json` (exact `get_workout_laps` output; `kind` and `checks` were produced by the repo's own `lapKind`/`lapChecks`), an optional `<case>.plan.json`, and `<case>.expected.json` (the output defined by this document).

| case | format / restMode | plan | what it covers |
|---|---|---|---|
| `clean-3ex` | perSet / countdown | yes (the pushed array, with `detail`/`plates` to show they are ignored) | clean session with plates, 3/3/2 sets; no deviations |
| `extra-set` | perSet / countdown | yes | `long-set` (heuristic), `extra-set` (plan), `after-complete` (3 "Session complete" laps) |
| `missing-set` | perSet / countdown | yes | `short-set` (3.8 s set), `missing-set` (plan) |
| `stopwatch` | perSet / stopwatch | no | label targets, `rest-long`, `rest-short`, in-tolerance rests |
| `checks-split-rest` | perSet / countdown | no | `duplicate-rest` ×2 → `reliable:false`, merged gap, `rest-split` |
| `ended-early` | perSet / countdown | yes | `no-session-complete` → `reliable:false`, cut rest gap, `ended-early`, `missing-set` (plan), `missing-exercise` "not reached" |
| `workout-guide` | workout | yes | rest laps as prep, `baselineHr` null, `order-differs`, `missing-exercise`, `extra-exercise`, `Push-up`/`Push-Up` normalisation |
| `per-exercise` | perExercise | no | `k` null, `planned.sets` from detail (`2x32kg 3x40m` → 3) |
| `no-laps` | — | no | status `no-laps` |
| `unguided` | — | no | status `no-guide-labels` |

### Unit tests (`src/compare.test.ts`)

1. For each fixture: `compareWorkout(laps, plan)` deep-equals `expected`. Also check fixture integrity: each row's `kind` equals `lapKind(label)`, and `checks` equals `lapChecks(rows)`.
2. `norm`: `Push-Up`/`push up`, `Bench Press 15°` → `bench press 15`, `Überzug` → `uberzug`.
3. `detailSets`: `100kg 3x5`→3, `BW 3x15`→3, `2x32kg 3x40m`→3, `3x45s`→3, `15kg 3x8-12/side`→3, `3 × 5`→3, `heavy triple`→null.
4. Format detection: perSet; workout with rests; a single step lap → workout; ≥2 steps without rests → perExercise; mixed set and non-set rests → `unknown-label-format`; a table whose only lap is `Session complete` → `unknown-label-format`.
5. The existing e2e stub table (prep, set 1, `90s target · Next: set 2/3` lasting 60 s, `Session complete`) → deviations, in order, `unexpected-sequence` [3], `rest-short` [3], `missing-set` [] (labels, "1 of 3 sets recorded"); `reliable:false`.
6. A null-label lap between a rest and a set → in `unattributed`, `unlabelled-lap` [i], and the following set still gets the rest's k.
7. A rest before any step → `unattributed` and `unexpected-sequence` "a rest lap before the first exercise".
8. Set label changes within an exercise → `unexpected-sequence` "this set's label differs from set 1's".
9. Prep `x | Squat` followed by set `Bench | y` → link failure. A one-part prep label (load ≥ 39 chars) → no link check.
10. Truncation: a one-part set label with raw length 40 matches plan `<that name> Extended` by prefix. A two-part label of raw length 40 does not.
11. Duplicate plan names (`Plank` twice) match in order.
12. All HR null → HR fields null, `baselineHr` null, `short-set`/`long-set` still evaluated, `reliable:false`.
13. Strength session stopped during the second exercise's prep (`prep, set, rest, set, prep`, no `Session complete`) → a prep-only exercise 2 named from the prep's last part, with `detail` null and `missing-set` "no set recorded: the session ended during the prep", plus `ended-early` on that prep lap.
14. Workout session stopped during a rest → a not-started exercise named via `nextName`, `missing-set` "the exercise was not started…".
15. Countdown target = median of uncut gaps; when every gap is cut → `planned.restS` null and the rest rows' `targetS` null.
16. Stopwatch tolerance edges: target 90 → tol 18: 108 not long, 108.1 long, 72 not short, 71.9 short. Target 30 → tol 10.
17. short/long-set edges: `d=9.9, m=40` short; `d=10, m=40` not (needs `< 10`); `d=80, m=40` long; `d=50, m=25` not (extra 25 < 30).
18. `rest-target-mismatch`: plan 90 vs countdown 120 → flagged; 122 vs 120 → not; 123 vs 120 → flagged.
19. `plan` ignored for non-ok statuses (`no-laps` with a plan → no deviations).
20. Size: a synthetic 35-lap perSet session (17 sets) serialises below 4,000 bytes.

### End-to-end (`src/e2e.test.ts`, real compiled server with `fetch-stub.mjs`)

Stub change: serve the `clean-3ex` fixture's workoutKey (`5e1f7c0de000000000000001`). Build the markers from `clean-3ex.laps.json` rows: `startTime = fixture.startTime + startOffsetS*1000`, `totals: {duration, energy: kcal, hr: {min, avg, max}, intervalNotes: label?.replaceAll(" | ", "\f") ?? null}`. Add a SummaryExtension with `apps: [{id: guide.id, name: guide.name}]`, and set `startTime`/`totalTime` from the fixture. Leave the existing 4-lap key unchanged.

1. `compare_workout_to_plan {workoutKey: clean key, plan: clean-3ex.plan.json}` → not an error, no newline in the text, `JSON.parse(text)` deep-equals `clean-3ex.expected.json`.
2. Same without `plan` → every `exercises[].plan` is null, no plan-basis deviations, everything else equal.
3. The existing stub key → `reliable:false`, deviation codes `["unexpected-sequence","rest-short","missing-set"]`.
4. Invalid input → `isError`, before any request: `plan: []` (minItems), `plan: [{sets: 3}]` (missing `name`), `plan: [{name: "x", sets: 0}]`, `workoutKey: "abc"` (same not-found error as `get_workout_laps`).
5. `tools/list` includes `compare_workout_to_plan` with `readOnlyHint: true`.

---

## 8. Open questions for the orchestrator (h)

1. **Should `no-heart-rate` alone make `reliable:false`?** The brief says any check does. HR loss does not affect positional mapping, though: the HR fields are just null. *Recommendation:* exempt `no-heart-rate` from `reasons`, but keep it in `checks`. This is a one-line change in §3.9 and changes no fixture.
2. **Plan field names.** This design uses `{name, sets?, restSec?}` (the `push_strength_guide` item names) instead of the brief's `{exercise, sets, reps?, restS?}`. The pushed array can then be passed as-is, and `reps` is dropped because laps cannot measure reps. *Recommendation:* accept.
3. **Countdown rests are not measurable.** All real sessions use countdown, so "rest vs target" is always on target and overruns hide inside the next set. *Recommendation:* no tool change. Consumers must not present countdown rest as compliance. If rest compliance matters to the coach, it should push with `restMode:"stopwatch"`.
4. **Heuristic thresholds** (short-set `<0.25·m and <10 s`, long-set `≥2·m and +30 s`, stopwatch tolerance `max(10 s, 20%)`). They were checked against the three real sessions: they flag exactly the two suspicious laps (§9) and nothing else. *Recommendation:* ship them as named constants and revisit after more sessions.
5. **Wrong existing docs.** `lapChecks`' comment says laps after "Session complete" have no label, but real ones carry "Session complete". The `get_workout_laps` description says prep and set labels "look alike", but their halves are swapped. *Recommendation:* fix both texts in the same PR, comments and description only. Do not add a lapChecks code for after-complete laps, because they do not disturb the guided part's positions.
6. **Unverified label formats.** The stopwatch-rest and workout-guide labels are derived from `guide-zip.ts`; no real session in either format was available. *Recommendation:* ship. Ask the user to run one short stopwatch session (and one `push_workout_guide` session) and diff it against the fixtures.
7. **Countdown split assumption.** This design assumes a lap press during a countdown rest does not restart the countdown, so the split parts sum to `restSec`. It is not verified; no real split exists yet. *Recommendation:* ship. If a real split shows a longer sum, the countdown target (a median) is unaffected and only that gap's `durationS` differs.
8. **Guide-less session plus `plan`.** One could map unlabelled laps by position when the lap count fits the plan. *Recommendation:* out of scope. It is too easy to be confidently wrong, and the tool returns `no-guide-labels`.

---

## 9. What the real data showed (3 real per-set countdown sessions, read-only)

1. **Laps after "Session complete" are labelled "Session complete" (kind `done`), not null.** One session has 3 such laps (192 s, 39 s, 1.5 s). This contradicts the comment and test in `lapChecks`. As a result no check fires for them today.
2. **Countdown rest laps last exactly `restSec`.** Every rest lap in all three sessions has an integral duration equal to its target. Rest overruns are invisible in the rest lap.
3. **Prep and set labels have swapped halves** (`<plates or detail> | <name>` against `<name> | <detail>`). The `get_workout_laps` description says they look alike.
4. **The lap count follows `2 × total sets + 1`** for all three sessions, plus the extra "Session complete" laps in one of them.
5. **Signatures of extra or missing sets.** A last-set lap of about 94 s against a ~36 s median, with higher HR, looks like an extra set inside the lap (→ `long-set`). A 4.3 s set lap straight after a 104 s prep looks like a double press (→ `short-set`). No split rest occurred.
6. **Lap start offsets drift by up to ±1 s** against the previous lap's end. The design uses only durations, never offsets.
7. `feeling` is null in all three. No stopwatch session, workout-guide session or perExercise session is in the sample.

---

## 10. Implementation touchpoints

- `src/compare.ts` (new): `compareWorkout`, `PlanItem` type, and the constants and helpers in §3.0. It is pure and makes no I/O.
- `src/compare.test.ts` (new): §7 unit tests. Fixtures are read via `new URL("../test-fixtures/compare/<f>", import.meta.url)`, which works from `dist-test/`.
- `src/index.ts`: tool definition (§2.1) after `get_workout_laps`, plus `case "compare_workout_to_plan"`.
- `src/tool-meta.ts`: a READ entry. The server refuses to start without it.
- `test-fixtures/fetch-stub.mjs`: the second workout key (§7 e2e).
- `src/e2e.test.ts`: the §7 e2e cases.
- `README.md` tool list and a `CHANGELOG.md` "Unreleased" entry. The version bump is the orchestrator's call.
