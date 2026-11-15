import { test } from "node:test";
import assert from "node:assert/strict";
import { assessHr, FLAT_RUN_MAX_S, MIN_COVERAGE } from "./hr-quality.js";

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
