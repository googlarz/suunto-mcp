import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessHr,
  DROPOUT_GAP_S,
  FLAT_RUN_MAX_GAP_S,
  FLAT_RUN_MAX_S,
  JUMP_BPM,
  JUMP_MAX_GAP_S,
  MAX_IMPLAUSIBLE_SHARE,
  MAX_JUMP_SHARE,
  MAX_PLAUSIBLE_HR,
  MIN_COVERAGE,
  MIN_JUMPS,
  MIN_PLAUSIBLE_HR,
} from "./hr-quality.js";

const T0 = Date.UTC(2026, 9, 1, 16, 0, 0);
type Rec = { timestamp: Date; heart_rate?: unknown };
const rec = (t: number, hr: unknown): Rec => ({ timestamp: new Date(T0 + t * 1000), heart_rate: hr });
// 1 Hz records t = 0..n-1; fn(t) is the HR, null drops the record
const session = (n: number, fn: (t: number) => number | null, extra: object = {}) => {
  const records: Rec[] = [];
  for (let t = 0; t < n; t++) {
    const hr = fn(t);
    if (hr !== null) records.push(rec(t, hr));
  }
  return { records, ...extra } as any;
};
// a plausible, never-flat signal around `base`: a slow wave with a small wobble
const wave = (base: number) => (t: number) => Math.round(base + 25 * Math.sin(t / 150) + 3 * Math.sin(t * 1.7));
const normal = wave(120);

test("assessHr: a normal 60 minute session is reliable with full coverage and no reasons", () => {
  assert.deepEqual(assessHr(session(3600, normal)), { reliable: true, reasons: [], coverage: 1 });
});

test("assessHr: no records, or records without any heart rate, is 'no HR data' (reliable null), not 'unreliable'", () => {
  for (const parsed of [{}, { records: [] }, session(600, () => null), { records: [{ timestamp: new Date(T0) }, rec(1, undefined), rec(2, "x"), rec(3, NaN)] }]) {
    const q = assessHr(parsed as any);
    assert.equal(q.reliable, null);
    assert.equal(q.coverage, 0);
    assert.deepEqual(q.reasons, ["no heart rate data in the FIT file"]);
  }
});

test("assessHr: a dropout that leaves under MIN_COVERAGE of the session is unreliable and the reason says how much", () => {
  const q = assessHr(session(3000, (t) => (t >= 1000 && t < 2000 ? null : normal(t))));
  assert.equal(q.reliable, false);
  assert.equal(q.coverage, 0.67);
  assert.equal(q.reasons.length, 1);
  assert.match(q.reasons[0], /67%/);
});

test("assessHr: a gap just inside the allowed coverage does not flag", () => {
  const n = 1000;
  const lost = Math.floor(n * (1 - MIN_COVERAGE)) - 5;
  const q = assessHr(session(n, (t) => (t >= 300 && t < 300 + lost ? null : normal(t))));
  assert.equal(q.reliable, true, q.reasons.join("; "));
});

test("assessHr: the session's timer time counts a recording that stopped early as missing HR", () => {
  // 600 s of HR but the session says 1200 s of timer time
  const q = assessHr(session(600, normal, { sessions: [{ total_timer_time: 1200 }] }));
  assert.equal(q.reliable, false);
  assert.equal(q.coverage, 0.5);
});

test("assessHr: several implausible readings (0 and 255) are unreliable; one glitch is not", () => {
  const glitch = assessHr(session(1800, (t) => (t === 500 ? 255 : normal(t))));
  assert.equal(glitch.reliable, true, glitch.reasons.join("; "));
  const bad = assessHr(session(1800, (t) => (t % 20 === 0 ? (t % 40 === 0 ? 0 : 255) : normal(t))));
  assert.equal(bad.reliable, false);
  assert.ok(bad.reasons.some((r) => /implausible/.test(r)));
});

test("assessHr: 30 and 230 bpm are plausible; 29 and 231 are not", () => {
  const edge = (base: number, hr: number) => assessHr(session(1000, (t) => (t % 10 === 0 ? hr : Math.round(base + 3 * Math.sin(t)))));
  assert.equal(edge(40, 30).reliable, true);
  assert.equal(edge(215, 230).reliable, true);
  assert.equal(edge(40, 29).reliable, false);
  assert.equal(edge(215, 231).reliable, false);
});

test("assessHr: an identical value for longer than FLAT_RUN_MAX_S is a flat-line; exactly that long is not", () => {
  const flat = (len: number) => assessHr(session(1800, (t) => (t >= 600 && t <= 600 + len ? 111 : normal(t))));
  assert.equal(flat(FLAT_RUN_MAX_S).reliable, true);
  const q = flat(FLAT_RUN_MAX_S + 30);
  assert.equal(q.reliable, false);
  assert.ok(q.reasons.some((r) => /flat/.test(r)));
});

test("assessHr: identical values on both sides of a long dropout are not one flat-line", () => {
  // 150 s of 111, 300 s of nothing, 150 s of 111: each run is under the limit and the gap splits them
  const q = assessHr(session(1800, (t) => (t >= 400 && t <= 550 ? 111 : t > 550 && t < 850 ? null : t >= 850 && t <= 1000 ? 111 : normal(t))));
  assert.equal(q.reliable, true, q.reasons.join("; "));
});

test("assessHr: frequent instantaneous jumps are unreliable; a few are not", () => {
  const few = assessHr(session(1800, (t) => (t % 300 === 0 && t > 0 ? normal(t) + 60 : normal(t))));
  assert.equal(few.reliable, true, few.reasons.join("; "));
  const many = assessHr(session(1800, (t) => (t % 20 === 0 ? normal(t) + 60 : normal(t))));
  assert.equal(many.reliable, false);
  assert.ok(many.reasons.some((r) => /jump/.test(r)));
});

// ---------- sampling rate ----------

// n records `stepS` seconds apart (t = i * stepS); fn(i) null drops the record
const every = (stepS: number, n: number, fn: (i: number) => number | null, extra: object = {}) => {
  const records: Rec[] = [];
  for (let i = 0; i < n; i++) {
    const hr = fn(i);
    if (hr !== null) records.push(rec(i * stepS, hr));
  }
  return { records, ...extra } as any;
};

test("assessHr: a recording sampled every 2, 5 or 10 s with no dropouts is reliable with full coverage (1 Hz is not assumed)", () => {
  for (const step of [1, 2, 5, 10]) {
    assert.deepEqual(assessHr(every(step, 3600 / step + 1, (i) => normal(i * step))), { reliable: true, reasons: [], coverage: 1 }, `every ${step} s`);
  }
});

test("assessHr: a real 60 s gap is flagged at 1, 2 and 5 s sampling alike", () => {
  for (const step of [1, 2, 5]) {
    const q = assessHr(every(step, 240 / step + 1, (i) => (i * step > 90 && i * step < 150 ? null : normal(i * step)))); // 240 s, samples at 90 s and 150 s around the gap
    assert.equal(q.reliable, false, `every ${step} s`);
    assert.equal(q.coverage, 0.75, `every ${step} s`);
    assert.match(q.reasons[0], /75%/);
  }
});

test("assessHr: a dropout at the start or the end of the recording counts like one in the middle", () => {
  // HR missing for the first 100 s and the last 100 s of a 400 s recording; the empty records still say the recording ran
  const parsed = session(401, (t) => (t >= 100 && t <= 300 ? normal(t) : null));
  parsed.records = [...[0, 400].map((t) => rec(t, null)), ...parsed.records];
  const q = assessHr(parsed);
  assert.equal(q.coverage, 0.5);
  assert.equal(q.reliable, false);
});

test("assessHr: a pause shorter than the timer-time gap is not a dropout (timer time excludes pauses)", () => {
  // 1000 s of wall clock, 120 s of it paused with no records: the timer says 880 s
  const parsed = every(1, 1001, (i) => (i > 400 && i < 520 ? null : normal(i)), { sessions: [{ total_timer_time: 880 }] });
  const q = assessHr(parsed);
  assert.equal(q.reliable, true, q.reasons.join("; "));
  assert.equal(q.coverage, 1);
});

// ---------- thresholds, both sides of each (the constants themselves are pinned below) ----------

test("thresholds: the documented values", () => {
  assert.deepEqual(
    { MIN_COVERAGE, DROPOUT_GAP_S, MIN_PLAUSIBLE_HR, MAX_PLAUSIBLE_HR, MAX_IMPLAUSIBLE_SHARE, FLAT_RUN_MAX_S, FLAT_RUN_MAX_GAP_S, JUMP_BPM, JUMP_MAX_GAP_S, MIN_JUMPS, MAX_JUMP_SHARE },
    { MIN_COVERAGE: 0.8, DROPOUT_GAP_S: 10, MIN_PLAUSIBLE_HR: 30, MAX_PLAUSIBLE_HR: 230, MAX_IMPLAUSIBLE_SHARE: 0.02, FLAT_RUN_MAX_S: 180, FLAT_RUN_MAX_GAP_S: 10, JUMP_BPM: 40, JUMP_MAX_GAP_S: 2, MIN_JUMPS: 5, MAX_JUMP_SHARE: 0.01 },
  );
});

test("MIN_COVERAGE: exactly that coverage passes, one more second of gap flags", () => {
  // 1001 samples = 1000 s; dropping the samples between 300 s and 500 s leaves a 200 s gap = coverage 0.8
  const gap = (to: number) => assessHr(session(1001, (t) => (t > 300 && t < to ? null : normal(t))));
  const at = gap(500);
  assert.equal(at.coverage, 0.8);
  assert.equal(at.reliable, true, at.reasons.join("; "));
  const below = gap(501);
  assert.equal(below.reliable, false);
  assert.ok(below.reasons.some((r) => /dropouts/.test(r)));
});

test("DROPOUT_GAP_S: samples exactly that far apart are no dropout, one second further they are", () => {
  const ok = assessHr(every(DROPOUT_GAP_S, 361, (i) => normal(i * DROPOUT_GAP_S)));
  assert.deepEqual(ok, { reliable: true, reasons: [], coverage: 1 });
  const bad = assessHr(every(DROPOUT_GAP_S + 1, 361, (i) => normal(i * (DROPOUT_GAP_S + 1))));
  assert.equal(bad.reliable, false);
  assert.ok(bad.reasons.some((r) => /dropouts/.test(r)));
});

test("MAX_IMPLAUSIBLE_SHARE: exactly that share passes, one more implausible sample flags", () => {
  const share = (count: number) => {
    const bad = new Set(Array.from({ length: count }, (_, k) => 20 + 40 * k));
    return assessHr(session(1000, (t) => (bad.has(t) ? 0 : normal(t))));
  };
  const at = share(MAX_IMPLAUSIBLE_SHARE * 1000);
  assert.equal(at.reliable, true, at.reasons.join("; "));
  const over = share(MAX_IMPLAUSIBLE_SHARE * 1000 + 1);
  assert.equal(over.reliable, false);
  assert.ok(over.reasons.some((r) => /implausible/.test(r)));
});

test("MIN_PLAUSIBLE_HR and MAX_PLAUSIBLE_HR: the limits themselves are plausible, one bpm beyond is not", () => {
  const all = (hr: number) => assessHr(every(1, 200, (i) => (i % 2 === 0 ? hr : hr + (hr < 100 ? 1 : -1))));
  assert.equal(all(MIN_PLAUSIBLE_HR).reliable, true);
  assert.equal(all(MAX_PLAUSIBLE_HR).reliable, true);
  assert.equal(all(MIN_PLAUSIBLE_HR - 2).reliable, false);
  assert.equal(all(MAX_PLAUSIBLE_HR + 2).reliable, false);
});

test("FLAT_RUN_MAX_S: a flat run of exactly that many seconds passes, one more second flags", () => {
  const flat = (len: number) => assessHr(session(1800, (t) => (t >= 600 && t <= 600 + len ? 111 : normal(t))));
  assert.equal(flat(FLAT_RUN_MAX_S).reliable, true);
  const over = flat(FLAT_RUN_MAX_S + 1);
  assert.equal(over.reliable, false);
  assert.ok(over.reasons.some((r) => /flat/.test(r)));
});

test("FLAT_RUN_MAX_GAP_S: equal values that far apart still make one run, one second further they do not", () => {
  const flatFor = (step: number) => assessHr(every(step, 31, () => 111)).reasons.some((r) => /flat/.test(r));
  assert.equal(flatFor(FLAT_RUN_MAX_GAP_S), true);
  assert.equal(flatFor(FLAT_RUN_MAX_GAP_S + 1), false);
});

// A staircase of `shifts` level changes, each a jump of exactly `diff` bpm between neighbouring samples
// `stepS` apart. The signal alternates by 1 bpm so it is never flat; shifts up fall on even samples and
// shifts down on odd ones so that the alternation does not change the size of any jump.
function jumpy(diff: number, shifts: number, stepS: number, n: number) {
  const at = Array.from({ length: shifts }, (_, k) => 2 * Math.floor((Math.floor(n / (shifts + 1)) * (k + 1)) / 2) + (k % 2));
  const values = Array.from({ length: n }, (_, i) => 100 + (i % 2) + (at.filter((p) => p <= i).length % 2 === 1 ? diff + 1 : 0));
  const steps = values.slice(1).map((v, i) => Math.abs(v - values[i]));
  assert.equal(steps.filter((d) => d > 1).length, shifts, "one big step per shift");
  assert.ok(steps.filter((d) => d > 1).every((d) => d === diff), `every jump is ${diff} bpm`);
  return assessHr(every(stepS, n, (i) => values[i]));
}
const jumpReason = (q: { reasons: string[] }) => q.reasons.some((r) => /jump/.test(r));

test("JUMP_BPM: jumps of exactly that size do not count, one bpm more does", () => {
  assert.equal(jumpReason(jumpy(JUMP_BPM, 10, 1, 501)), false);
  assert.equal(jumpReason(jumpy(JUMP_BPM + 1, 10, 1, 501)), true);
});

test("MIN_JUMPS: one jump fewer than that never flags, even above the share limit; that many do", () => {
  // 300 adjacent pairs: 4 jumps are 1.3%, 5 are 1.7%, both above MAX_JUMP_SHARE
  assert.ok((MIN_JUMPS - 1) / 300 > MAX_JUMP_SHARE);
  assert.equal(jumpReason(jumpy(JUMP_BPM + 10, MIN_JUMPS - 1, 1, 301)), false);
  assert.equal(jumpReason(jumpy(JUMP_BPM + 10, MIN_JUMPS, 1, 301)), true);
});

test("MAX_JUMP_SHARE: exactly that share of the adjacent pairs passes, one more jump flags", () => {
  // 500 adjacent pairs: 5 jumps are exactly 1%
  assert.equal(5 / 500, MAX_JUMP_SHARE);
  assert.equal(jumpReason(jumpy(JUMP_BPM + 10, 5, 1, 501)), false);
  assert.equal(jumpReason(jumpy(JUMP_BPM + 10, 6, 1, 501)), true);
});

test("JUMP_MAX_GAP_S: samples exactly that far apart are compared for jumps, one second further they are not", () => {
  assert.equal(jumpReason(jumpy(JUMP_BPM + 10, 10, JUMP_MAX_GAP_S, 501)), true);
  assert.equal(jumpReason(jumpy(JUMP_BPM + 10, 10, JUMP_MAX_GAP_S + 1, 501)), false);
});

test("assessHr: reasons accumulate, records may be unsorted or use epoch ms, and the input is not modified", () => {
  const parsed = session(1000, (t) => (t % 10 === 0 ? 0 : t >= 300 && t < 700 ? null : normal(t)));
  const reversed = { records: [...parsed.records].reverse() };
  const before = JSON.stringify(reversed);
  const q = assessHr(reversed as any);
  assert.equal(q.reliable, false);
  assert.ok(q.reasons.length >= 2, q.reasons.join("; "));
  assert.equal(JSON.stringify(reversed), before);
  const ms = { records: parsed.records.map((r: Rec) => ({ ...r, timestamp: r.timestamp.getTime() })) };
  assert.deepEqual(assessHr(ms as any), q);
});
