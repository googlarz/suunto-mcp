// Heart-rate data quality of one workout, from the FIT's record-level HR. Pure: no I/O.
// An optical sensor on the wrist drops out, locks onto cadence or reads garbage now and then; a
// rest profile or a recovery median built on such a session is wrong without looking wrong. The
// rules are deliberately lenient: a normal session must never be flagged, only plainly broken ones.
import type { ParsedFit } from "./fit.js";

export interface HrQuality {
  reliable: boolean | null; // null: the FIT has no heart rate at all (distinct from false: it has some, and it is not trustworthy)
  reasons: string[]; // one sentence per rule that fired; empty when reliable
  coverage: number; // 0-1: share of the session not lost to dropouts (gaps over DROPOUT_GAP_S without a plausible HR sample)
}

// Below this a fifth of the session is missing: dropouts that long hide whole sets and rests.
export const MIN_COVERAGE = 0.8;
// Samples further apart than this are a dropout, whatever the sampling rate (watches record every 1-5 s;
// optical HR reads are lost for more than 10 s only when the sensor lost the skin).
export const DROPOUT_GAP_S = 10;
// Outside 30-230 bpm is a strap off the skin (0) or a sensor glitch (255), not a heart.
export const MIN_PLAUSIBLE_HR = 30;
export const MAX_PLAUSIBLE_HR = 230;
// One stray glitch in a session is normal; more than 2% of the samples is a broken sensor.
export const MAX_IMPLAUSIBLE_SHARE = 0.02;
// Real HR moves by at least a bpm within three minutes; the same value for longer is a stuck sensor (or a held last value).
export const FLAT_RUN_MAX_S = 180;
// A run of equal values is only one run while samples keep coming; a longer gap (dropout, pause) ends it.
export const FLAT_RUN_MAX_GAP_S = 10;
// Heart rate cannot change by 40 bpm between two samples at most 2 s apart: it is cadence lock or noise.
export const JUMP_BPM = 40;
export const JUMP_MAX_GAP_S = 2;
// Jumps flag a session only when there are at least this many and more than this share of the adjacent
// sample pairs: a handful of artifacts in an hour is normal.
export const MIN_JUMPS = 5;
export const MAX_JUMP_SHARE = 0.01;

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function toMs(v: unknown): number | null {
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// The recording runs from its first to its last record (a record without HR still counts as the recording).
// Missing time is every stretch of it between two plausible samples (or to the window's ends) longer than
// DROPOUT_GAP_S, so the sampling rate does not matter: 1, 2 or 5 s between samples is no dropout. The session's
// length is its timer time (pauses excluded) when the FIT has it, else the window: a recording that stopped before
// the timer did counts the difference as missing, and a pause (timer shorter than the window) is not held against it.
export function assessHr(parsed: ParsedFit): HrQuality {
  const stamped = (parsed.records ?? []).map((r) => ({ ms: toMs(r?.timestamp), hr: r?.heart_rate })).filter((r): r is { ms: number; hr: unknown } => r.ms !== null);
  const byTime = new Map<number, number>(); // one sample per timestamp, the last wins (as hrSeries)
  for (const r of stamped) if (typeof r.hr === "number" && Number.isFinite(r.hr)) byTime.set(r.ms, r.hr);
  if (byTime.size === 0) return { reliable: null, reasons: ["no heart rate data in the FIT file"], coverage: 0 };

  const all = [...byTime].map(([ms, hr]) => ({ t: ms / 1000, hr })).sort((a, b) => a.t - b.t);
  const ok = all.filter((s) => s.hr >= MIN_PLAUSIBLE_HR && s.hr <= MAX_PLAUSIBLE_HR);
  const first = stamped.reduce((m, r) => Math.min(m, r.ms), Infinity) / 1000;
  const last = stamped.reduce((m, r) => Math.max(m, r.ms), -Infinity) / 1000;
  const span = last - first;
  const timer = parsed.sessions?.[0]?.total_timer_time;
  const hasTimer = typeof timer === "number" && Number.isFinite(timer) && timer > 0;
  const durationS = Math.max(1, hasTimer ? timer : span);
  let missing = 0;
  let prev = first;
  for (const s of ok) {
    if (s.t - prev > DROPOUT_GAP_S) missing += s.t - prev;
    prev = s.t;
  }
  if (last - prev > DROPOUT_GAP_S) missing += last - prev;
  if (hasTimer) missing += timer - span;
  const present = ok.length === 0 ? 0 : (durationS - Math.min(durationS, Math.max(0, missing))) / durationS;
  const coverage = r2(present);

  const reasons: string[] = [];
  if (present < MIN_COVERAGE) reasons.push(`heart rate is present for only ${pct(present)} of the session (at least ${pct(MIN_COVERAGE)} expected): sensor dropouts`);

  const bad = all.length - ok.length;
  if (bad / all.length > MAX_IMPLAUSIBLE_SHARE) reasons.push(`${bad} of ${all.length} samples (${pct(bad / all.length)}) are implausible (outside ${MIN_PLAUSIBLE_HR}-${MAX_PLAUSIBLE_HR} bpm)`);

  // flat-lines and jumps are read off the plausible samples only, so a glitch is counted once, by the rule above
  let longest = 0;
  let runStart = 0;
  let jumps = 0;
  let pairs = 0;
  for (let i = 1; i < ok.length; i++) {
    const gap = ok[i].t - ok[i - 1].t;
    if (ok[i].hr !== ok[i - 1].hr || gap > FLAT_RUN_MAX_GAP_S) runStart = i;
    longest = Math.max(longest, ok[i].t - ok[runStart].t);
    if (gap <= JUMP_MAX_GAP_S) {
      pairs++;
      if (Math.abs(ok[i].hr - ok[i - 1].hr) > JUMP_BPM) jumps++;
    }
  }
  if (longest > FLAT_RUN_MAX_S) reasons.push(`heart rate stays at the same value for ${Math.round(longest)} s (a flat-line over ${FLAT_RUN_MAX_S} s: a stuck sensor)`);
  if (jumps >= MIN_JUMPS && jumps / pairs > MAX_JUMP_SHARE) reasons.push(`${jumps} jumps of more than ${JUMP_BPM} bpm between adjacent samples (${pct(jumps / pairs)} of them): sensor noise`);

  return { reliable: reasons.length === 0, reasons, coverage };
}
