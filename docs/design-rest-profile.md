# Design: `get_workout_rest_profile`

Status: implemented, not yet checked against a real workout (see §6).

A read-only MCP tool that reports how the heart rate recovered during each rest of a guided gym session. `compare_workout_to_plan` reports a rest lap's max HR (`peak`) and min HR (`end`) only. With `restMode: countdown` the watch advances by itself, so the lap lasts exactly the target and the recovery curve inside it is invisible in lap totals. The FIT file's record-level HR has it.

Code: `src/rest-profile.ts` (pure, no I/O), tests in `src/rest-profile.test.ts` and `src/e2e.test.ts`, synthetic FIT builder in `test-fixtures/fit-builder.mjs`.

## 1. Inputs

- The lap table (`shapeLaps` of `/v3/workouts/{key}` with the lap extensions), exactly what `get_workout_laps` returns.
- The parsed FIT file (`parseFit` of `/v3/workouts/{key}/fit`), from which only `records[].heart_rate`, `records[].timestamp`, `sessions[0].start_time` and the developer-data messages are read.
- Optionally `plan`, passed to `compareWorkout` unchanged.

`compareWorkout(laps, plan)` does the mapping from laps to exercises, sets and rests; nothing in `compare.ts` was changed. Each rest row there is `[k, lap, durationS, targetS, ...]`: `lap` is the first lap of the rest, `durationS` the sum over a split rest, and `k` the set the rest announces ("Next: set k/S"), so the rest happened after set `k - 1`. The rest's start is that lap's `startOffsetS` from the lap table.

A workout guide (`push_workout_guide`) has no rest rows; the rest lap before exercise n+1 is that exercise's `prep`, and is reported as the rest after exercise n (set = its set count, 1). The first exercise's lead-in is not a rest after anything and is left out. In `strength-perSet`, the transition after an exercise's last set (into the next exercise's prep lap) is **not profiled**: that lap is setup time with plates and walking, not a rest of the guide's, and the lap table does not mark where the rest ends and the setup begins. A strength guide with `lapGranularity: perExercise` has no between-set rests, so `rests` is empty and `note` says so. Any other `status` from `compareWorkout` (`no-laps`, `no-guide-labels`, `unknown-label-format`) passes through with empty `rests`.

## 2. Timebase

Lap `startOffsetS` is seconds from the workout `startTime` of the Suunto API (`shapeLaps`: `(marker.startTime - payload.startTime) / 1000`). The HR series needs the same time zero. `hrSeries` takes it, in this order:

1. the lap table's `startTime` (`alignment.workoutStartSource = "laps.startTime"`): the clock the lap offsets count from, so the windows line up by construction;
2. else the FIT's first `sessions[].start_time` (`"session.start_time"`);
3. else the first record's timestamp (`"first-record"`). The first record can come later than the workout start (HR not yet locked), which would shift every window by that delay; this is the last resort.

The FIT's session start is not used as time zero when the lap table has a start, because the lap offsets are measured on the lap table's clock. It is kept to measure that skew: `alignment` reports `lapStartTimeMs`, `fitStartMs` (the FIT's own start: session start_time, else the first record) and `startSkewS` = session start minus lap-table start. It is null without both of those, because a first record is not a second reading of the start. The windows are **not** corrected for the skew: which clock is right is unknown, so the lap table's, which the lap offsets are measured on, is the one used. A skew above 2 s is added to `note`; above 10 s `reliable` is false as well. Timestamps from fit-file-parser are `Date` objects; epoch ms and ISO strings are accepted as well.

## 3. Metrics per rest

Window: `[startOffsetS, startOffsetS + durationS]`. HR samples are the FIT records with a numeric `heart_rate` from 30 to 250 bpm (anything else is a sensor dropout or glitch), sorted by time; of records with the same timestamp the last is kept. Everything below, except `endHr`, reads a 3-sample centred moving average of that series, so a single spike or dip cannot set the peak or a threshold crossing.

| Field | Definition |
|---|---|
| `peakHr`, `peakAtS` | Highest smoothed HR in `[start - 15 s, min(start + 30 s, end)]` (the latest one on a tie, so a flat plateau puts the peak at its end and `t10S` etc. count from there). `peakHr` is that smoothed value, so a sharp peak reads a little lower than its raw sample (a one-sample spike of 175 in a flat 140 gives 151.7). Optical HR lags the effort by 20-30 s, so the peak of a set often lands inside the rest, or just before it. `peakAtS` is seconds from the rest start, negative if before it. |
| `endHr` | Mean of the raw samples in the last 5 s of the rest (`(end - 5, end]`). |
| `dropTotal` | `peakHr - endHr` (smoothed peak minus raw tail mean). |
| `t10S`, `t20S`, `t30S` | Seconds from the peak sample until the smoothed HR is first `<= peakHr - 10 / 20 / 30`. Only samples after the peak up to the end of the rest are searched; null if never reached. |
| `recoveryBpmPerMin` | `(peakHr - smoothed HR at the last sample within 60 s of the peak) / seconds between them * 60`. If fewer than 60 s of the rest remain after the peak, the rest is the span. |
| `sampleCount` | HR samples inside the window. |
| `coverage` | Fraction of the window's whole seconds that have at least one sample (0 to 1). |

With fewer than 5 samples inside the window every metric is null and `note` says how many there were. The same happens when the rest has samples but none in the peak search window (an HR gap at the start of a long rest): `note` is "no HR sample in the peak search window". This is not an error: a rest without HR (strap dropped, battery mode Tour) must not fail the whole call. Defaults live in `DEFAULTS` of `rest-profile.ts` and can be overridden through `restRecovery`'s `opts` (used by tests only).

A rest that `compareWorkout` flags `rest-split` (a lap pressed during it) gets a note on its own entry; the window is the sum of its laps.

`perExercise` holds the medians of `t20S`, `endHr` and `recoveryBpmPerMin` over an exercise's rests, ignoring nulls (null if none).

## 4. Developer fields

SuuntoPlus apps can write extra channels into the FIT as FIT developer fields. fit-file-parser exposes them as `developer_data_ids` (apps) and `field_descriptions` (name, units, `developer_data_index`, `field_definition_number`, `fit_base_type_id`), and puts each value into every record under the field's own `field_name`. `developerInfo` (defined in `src/fit.ts`, re-exported from `rest-profile.ts`) returns `{ apps, fields, devChannels }`, where `devChannels` are the field names that have a value in at least one record, or null when the FIT has neither messages. It is also added to the `get_workout_fit` summary (`developer`), with every existing field unchanged. The rest-profile metrics do not use the developer values.

## 5. Output size

A few hundred bytes per rest, a few KB per session; the FIT download itself is about 550 KB for a 35-lap session and is not returned.

## 6. Limits and unverified points

- **Timebase alignment** (§2) is the main unverified point: whether the Suunto API `startTime` and the FIT `session.start_time` are the same instant to within a second, and whether lap `startTime`s are on that same clock. The check needs one real workout (read-only): compare `alignment.startSkewS` and see whether `peakAtS` sits near 0 to +30 s for the rests of a hard set.
- **Developer fields**: it is not verified that Suunto's FIT export contains the SuuntoPlus app's developer fields at all. The parser path is tested with a synthetic FIT that has one (`test-fixtures/fit-builder.mjs`); `developer: null` or an empty `devChannels` on a real workout means the export has none.
- **HR sampling rate**: the metrics assume roughly 1 Hz records. Real density is unverified; `coverage` and `sampleCount` show it per rest. At lower rates `t10S` etc. are quantised to the sample spacing and the 5 s tail mean has fewer points.
- Optical HR is itself delayed and smoothed by the watch, so t10/t20/t30 describe the sensor's curve, not cardiac recovery to clinical standards; compare them between rests and sessions, not against published norms.
- The peak search window is a heuristic (15 s before, 30 s after). A rest that starts while the HR is still climbing for longer than 30 s will report the peak at the window's edge.
- Two sets with an unrecorded lap press, or any case where `compareWorkout` marks the mapping `reliable: false`, can attach a rest to the wrong exercise or set; `reliable` and `note` pass through.
- Countdown rests: `plannedRestS` is the guide's rest as `compareWorkout` derives it (the median of the actual rest laps when no target is in the label), so `plannedRestS` and `actualDurationS` agree there by construction.
