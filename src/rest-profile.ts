// get_workout_rest_profile: per-rest recovery metrics from the FIT file's
// record-level heart rate, joined to the guide's lap labels (exercise, set) from
// compare_workout_to_plan. Pure: it takes the lap table and the parsed FIT and
// does no I/O. Design and limits: docs/design-rest-profile.md.
import { compareWorkout, type PlanItem } from "./compare.js";
import { developerInfo, type DeveloperInfo, type ParsedFit } from "./fit.js";

export { developerInfo, type DeveloperInfo };
import { LAP_COLUMNS, type shapeLaps } from "./laps.js";

export interface HrSample {
  tS: number; // seconds since the workout start (see hrSeries)
  hr: number;
}

export type StartSource = "session.start_time" | "laps.startTime" | "first-record";

export interface RestWindow {
  startOffsetS: number; // from the workout start, as the lap table's startOffsetS
  durationS: number;
}

export interface RestRecoveryOpts {
  peakLookbackS: number; // the peak is searched from this many seconds before the rest starts...
  peakLookaheadS: number; // ...to this many after it started (never past the end of the rest)
  endTailS: number; // endHr is the mean over the last this-many seconds of the rest
  minSamples: number; // fewer HR samples inside the rest and every metric is null
}

const DEFAULTS: RestRecoveryOpts = { peakLookbackS: 15, peakLookaheadS: 30, endTailS: 5, minSamples: 5 };
const RATE_SPAN_S = 60;

export interface RestRecovery {
  peakHr: number | null;
  peakAtS: number | null; // seconds from the start of the rest; negative when the peak came before it
  endHr: number | null;
  dropTotal: number | null; // peakHr - endHr
  t10S: number | null; // seconds after the peak until the smoothed HR is first <= peak - 10 (20, 30 alike)
  t20S: number | null;
  t30S: number | null;
  recoveryBpmPerMin: number | null; // over the first 60 s after the peak, or what the rest has left of it
  sampleCount: number; // HR samples inside the rest window
  coverage: number; // fraction of the window's seconds with at least one HR sample
  note: string | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function toMs(v: unknown): number | null {
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Samples outside this range are sensor dropouts or garbage (a strap off the skin reads 0, a glitch 255).
const MIN_HR = 30;
const MAX_HR = 250;

// Heart rate over time from the FIT records, in seconds since the workout start.
// Time zero is the FIT session's start_time, else the lap table's startTime
// (`lapStartMs`, the clock the lap offsets count from), else the first record's
// timestamp. fit-file-parser returns timestamps as Dates; epoch ms and ISO
// strings are accepted too. Records without a numeric heart_rate in 30-250 bpm
// are dropped; of several records with the same timestamp the last one is kept.
// fitStartMs is the FIT's own start (session start_time, else the first record) and
// sessionStartMs the session's alone, both for comparing with the lap table.
export function hrSeries(
  parsed: ParsedFit,
  lapStartMs: number | null = null,
): { samples: HrSample[]; startMs: number | null; startSource: StartSource | null; fitStartMs: number | null; sessionStartMs: number | null } {
  const records = parsed.records ?? [];
  const sessionStartMs = toMs(parsed.sessions?.[0]?.start_time);
  const firstMs = records.map((r) => toMs(r?.timestamp)).find((ms) => ms !== null) ?? null;
  const fitStartMs = sessionStartMs ?? firstMs;
  const startMs = sessionStartMs ?? lapStartMs ?? firstMs;
  const startSource: StartSource | null = sessionStartMs !== null ? "session.start_time" : lapStartMs !== null ? "laps.startTime" : firstMs !== null ? "first-record" : null;
  if (startMs === null) return { samples: [], startMs, startSource, fitStartMs, sessionStartMs };

  const sorted: HrSample[] = [];
  for (const r of records) {
    const ms = toMs(r?.timestamp);
    if (ms === null || typeof r?.heart_rate !== "number" || !Number.isFinite(r.heart_rate) || r.heart_rate < MIN_HR || r.heart_rate > MAX_HR) continue;
    sorted.push({ tS: (ms - startMs) / 1000, hr: r.heart_rate });
  }
  sorted.sort((a, b) => a.tS - b.tS); // stable: equal timestamps keep file order
  const samples: HrSample[] = [];
  for (const x of sorted) {
    if (samples.length && samples[samples.length - 1].tS === x.tS) samples[samples.length - 1] = x;
    else samples.push(x);
  }
  return { samples, startMs, startSource, fitStartMs, sessionStartMs };
}

function noData(sampleCount: number, coverage: number, note: string): RestRecovery {
  return { peakHr: null, peakAtS: null, endHr: null, dropTotal: null, t10S: null, t20S: null, t30S: null, recoveryBpmPerMin: null, sampleCount, coverage, note };
}

// Recovery during one rest. `series` must be sorted by time (hrSeries does it).
// Everything is read off a 3-sample centred moving average, so one spike or dip
// cannot set the peak or a threshold crossing; peakHr is the smoothed value (a
// plateau is unchanged, a sharp peak comes out a little lower than its raw sample).
// The peak is searched in [start - 15 s, start + 30 s], clipped to the end of the
// rest, because optical HR lags the effort by 20-30 s and keeps rising into the
// rest. endHr is a mean of raw samples.
export function restRecovery(series: HrSample[], window: RestWindow, opts: Partial<RestRecoveryOpts> = {}): RestRecovery {
  const o = { ...DEFAULTS, ...opts };
  const s0 = window.startOffsetS;
  const end = s0 + window.durationS;

  const inWindow = series.filter((x) => x.tS >= s0 && x.tS <= end);
  const bins = Math.ceil(window.durationS);
  const covered = new Set(inWindow.filter((x) => x.tS < end).map((x) => Math.floor(x.tS - s0)));
  const coverage = bins > 0 ? r2(Math.min(1, covered.size / bins)) : 0;
  if (inWindow.length < o.minSamples) {
    return noData(inWindow.length, coverage, `only ${inWindow.length} HR sample(s) inside the rest; at least ${o.minSamples} needed`);
  }

  const smoothed = (i: number) => {
    const w = series.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, x) => a + x.hr, 0) / w.length;
  };

  const lo = s0 - o.peakLookbackS;
  const hi = Math.min(s0 + o.peakLookaheadS, end);
  let peakIdx = -1;
  let peakSm = -Infinity;
  series.forEach((x, i) => {
    if (x.tS < lo || x.tS > hi) return;
    const sm = smoothed(i);
    if (sm > peakSm) {
      peakSm = sm;
      peakIdx = i;
    }
  });
  // A gap in the HR at the start of a long rest: samples exist later in it, but none where the peak is searched.
  if (peakIdx === -1) return noData(inWindow.length, coverage, "no HR sample in the peak search window");
  const peak = series[peakIdx];

  const tail = inWindow.filter((x) => x.tS > end - o.endTailS);
  const endHr = tail.length ? r1(tail.reduce((a, x) => a + x.hr, 0) / tail.length) : null;

  const after: { i: number; x: HrSample }[] = [];
  for (let i = peakIdx + 1; i < series.length && series[i].tS <= end; i++) after.push({ i, x: series[i] });
  const timeTo = (drop: number): number | null => {
    const hit = after.find(({ i }) => smoothed(i) <= peakSm - drop + 1e-9);
    return hit ? r1(hit.x.tS - peak.tS) : null;
  };

  const spanEnd = peak.tS + Math.min(RATE_SPAN_S, end - peak.tS);
  const last = [...after].reverse().find(({ x }) => x.tS <= spanEnd);
  const dt = last ? last.x.tS - peak.tS : 0;

  return {
    peakHr: r1(peakSm),
    peakAtS: r1(peak.tS - s0),
    endHr,
    dropTotal: endHr !== null ? r1(peakSm - endHr) : null,
    t10S: timeTo(10),
    t20S: timeTo(20),
    t30S: timeTo(30),
    recoveryBpmPerMin: last && dt >= 1 ? r1(((peakSm - smoothed(last.i)) / dt) * 60) : null,
    sampleCount: inWindow.length,
    coverage,
    note: null,
  };
}

export interface RestProfileRest extends RestRecovery {
  exercise: string;
  exerciseN: number;
  set: number | null; // the set after which the rest happened
  plannedRestS: number | null;
  actualDurationS: number;
}

export interface PerExerciseRecovery {
  name: string;
  n: number;
  medianT20S: number | null;
  medianEndHr: number | null;
  medianRecoveryBpmPerMin: number | null;
}

export interface RestProfile {
  workoutKey: string | null;
  status: ReturnType<typeof compareWorkout>["status"];
  restMode: "countdown" | "stopwatch" | null;
  reliable: boolean;
  note: string | null;
  rests: RestProfileRest[];
  perExercise: PerExerciseRecovery[];
  developer: DeveloperInfo | null;
  alignment: {
    workoutStartSource: StartSource | null;
    lapStartTimeMs: number | null;
    fitStartMs: number | null; // the FIT's own start: session start_time, else the first record
    startSkewS: number | null; // FIT session start_time minus the lap table's startTime (null without both)
  };
}

// Skews up to this many seconds are normal rounding between the two sources; above
// SKEW_UNRELIABLE_S the two clocks plainly disagree and the rest windows cannot be trusted.
const SKEW_NOTE_S = 2;
const SKEW_UNRELIABLE_S = 60;

function median(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return r1(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

export function buildRestProfile(laps: ReturnType<typeof shapeLaps>, parsed: ParsedFit, plan?: PlanItem[]): RestProfile {
  const cmp = compareWorkout(laps, plan);
  const lapStartTimeMs = typeof laps.startTime === "number" ? laps.startTime : null;
  const { samples, startSource, fitStartMs, sessionStartMs } = hrSeries(parsed, lapStartTimeMs);
  const alignment = {
    workoutStartSource: startSource,
    lapStartTimeMs,
    fitStartMs,
    // Only the session's start_time is a second reading of the workout start; a first record may legitimately come later.
    startSkewS: sessionStartMs !== null && lapStartTimeMs !== null ? r1((sessionStartMs - lapStartTimeMs) / 1000) : null,
  };
  const developer = developerInfo(parsed);
  const head = { workoutKey: cmp.workoutKey, status: cmp.status, restMode: cmp.restMode, reliable: cmp.reliable };
  if (cmp.status !== "ok") return { ...head, note: cmp.note, rests: [], perExercise: [], developer, alignment };

  // Each lap's offset from the workout start: the join key between the lap table and the FIT timeline.
  const I = LAP_COLUMNS.indexOf("i");
  const OFFSET = LAP_COLUMNS.indexOf("startOffsetS");
  const offsetOfLap = new Map(laps.laps.rows.map((r) => [r[I] as number, r[OFFSET] as number | null]));

  // One entry per rest: strength guides carry them as rest rows; in a workout guide
  // the "prep" of exercise n+1 is the rest after exercise n.
  const items: { ex: { n: number; name: string }; set: number | null; plannedRestS: number | null; lap: number; durationS: number }[] = [];
  cmp.exercises.forEach((ex, idx) => {
    if (cmp.format === "strength-perSet") {
      for (const [k, lap, durationS, targetS] of ex.rests) items.push({ ex, set: k - 1, plannedRestS: targetS, lap, durationS });
    } else if (cmp.format === "workout" && idx > 0 && ex.prep) {
      const prev = cmp.exercises[idx - 1];
      items.push({ ex: prev, set: prev.sets.length || null, plannedRestS: null, lap: ex.prep[0], durationS: ex.prep[1] });
    }
  });

  const splitLaps = new Set(cmp.deviations.filter((d) => d.code === "rest-split").flatMap((d) => d.laps));

  const rests: RestProfileRest[] = items.map((it) => {
    const startOffsetS = offsetOfLap.get(it.lap) ?? null;
    const rec =
      startOffsetS === null
        ? noData(0, 0, `lap ${it.lap} has no startOffsetS, so it cannot be placed in the FIT timeline`)
        : restRecovery(samples, { startOffsetS, durationS: it.durationS });
    const split = splitLaps.has(it.lap) ? "the rest spans several laps (a lap was pressed during it), so its window may include part of the next set" : null;
    const note = [rec.note, split].filter((n): n is string => n !== null).join("; ") || null;
    return { exercise: it.ex.name, exerciseN: it.ex.n, set: it.set, plannedRestS: it.plannedRestS, actualDurationS: it.durationS, ...rec, note };
  });

  const perExercise: PerExerciseRecovery[] = [];
  for (const ex of cmp.exercises) {
    const own = rests.filter((r) => r.exerciseN === ex.n);
    if (own.length === 0) continue;
    perExercise.push({
      name: ex.name,
      n: ex.n,
      medianT20S: median(own.map((r) => r.t20S)),
      medianEndHr: median(own.map((r) => r.endHr)),
      medianRecoveryBpmPerMin: median(own.map((r) => r.recoveryBpmPerMin)),
    });
  }

  const skewS = alignment.startSkewS;
  const skewUnreliable = skewS !== null && Math.abs(skewS) > SKEW_UNRELIABLE_S;
  const notes = [
    cmp.note,
    rests.length === 0 ? "This guide has no between-set rests to profile (the strength-perExercise format records one lap per exercise)." : null,
    rests.length > 0 && samples.length === 0 ? "The FIT file has no heart rate records, so no rest could be profiled." : null,
    skewS !== null && Math.abs(skewS) > SKEW_NOTE_S
      ? `The FIT session start is ${skewS} s from the lap table's startTime: rest windows may be shifted by that much${skewUnreliable ? ", so the profile is unreliable" : ""}.`
      : null,
  ].filter((n): n is string => n !== null);

  return { ...head, reliable: head.reliable && !skewUnreliable, note: notes.length ? notes.join(" ") : null, rests, perExercise, developer, alignment };
}
