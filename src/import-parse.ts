// Reads a workout file exported from another system (FIT, GPX or TCX) into the summary import_workouts stores, and into the
// distance / altitude / moving-time points estimate_route_time fits a pace to. FIT goes through fit.ts (parseFit checks every
// file first). GPX and TCX are read with indexOf scans and no XML parser: nothing is ever decoded or expanded (no DTD, no
// entities), every scan moves forward only (a hostile file cannot make it quadratic), and a file over MAX_IMPORT_BYTES is
// refused by the caller before it is read. Anything not plausible is dropped or refused with a reason; nothing is guessed.
import { parseFit, type ParsedFit } from "./fit.js";
import { MAX_GAP_S, fitPts, haversine, type Pt } from "./route-time.js";

export const MAX_IMPORT_BYTES = 50_000_000;
export type ImportFormat = "fit" | "gpx" | "tcx";

export interface ImportSummary {
  startTime: string; // ISO 8601, UTC
  durationS: number;
  distanceM: number;
  avgHr?: number;
  maxHr?: number;
  ascentM?: number;
  sport?: string; // running, walking, hiking, cycling, swimming or the file's own word; absent when the file says nothing
  hasGps: boolean;
  droppedJumps?: number; // GPS positions dropped as jumps faster than a person moves; absent when none
}
export interface ParsedWorkout {
  summary: ImportSummary;
  pts: Pt[]; // as route-time's fitPts gives them for a FIT file; empty when the file has no distance or altitude
}

interface Sample {
  t: number; // Unix seconds
  lat?: number;
  lon?: number;
  ele?: number;
  hr?: number;
  dist?: number; // cumulative metres as the file gives them
  cum?: number; // cumulative metres used here (given, else along the accepted GPS positions)
}

const MIN_T = Date.UTC(1990, 0, 1) / 1000;
const MAX_JUMP_MS = 12; // m/s: a GPS jump faster than this is a glitch (30 for cycling and for a file that names no sport)
const MAX_JUMP_FAST_MS = 30;
const ASCENT_STEP_M = 3; // altitude moves smaller than this are noise and add no ascent

const num = (s: string | null | undefined): number => (s === null || s === undefined || s.trim() === "" ? NaN : Number(s));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const isoSeconds = (s: string | null): number => (s !== null && ISO.test(s.trim()) ? Date.parse(s.trim()) / 1000 : NaN);

// ---------- XML without a parser ----------

// Every <tag ...>body</tag> (or <tag .../>) in order; the tag is unqualified (GPX and TCX write trkpt / Trackpoint so).
function* elements(xml: string, tag: string): Generator<{ attrs: string; body: string }> {
  const open = `<${tag}`;
  let pos = 0;
  for (;;) {
    const at = xml.indexOf(open, pos);
    if (at < 0) return;
    const next = xml[at + open.length];
    if (next !== ">" && next !== "/" && next !== " " && next !== "\n" && next !== "\t" && next !== "\r") {
      pos = at + open.length;
      continue;
    }
    const gt = xml.indexOf(">", at);
    if (gt < 0) return;
    if (xml[gt - 1] === "/") {
      yield { attrs: xml.slice(at + open.length, gt - 1), body: "" };
      pos = gt + 1;
      continue;
    }
    const close = xml.indexOf(`</${tag}>`, gt);
    if (close < 0) return;
    yield { attrs: xml.slice(at + open.length, gt), body: xml.slice(gt + 1, close) };
    pos = close + tag.length + 3;
  }
}

// The text of the first <name> or <prefix:name> in `body` (no attributes on it), or null.
function textOf(body: string, name: string): string | null {
  const a = body.indexOf(`<${name}>`);
  const b = body.indexOf(`:${name}>`);
  const at = a >= 0 && (b < 0 || a < b) ? a : b;
  if (at < 0) return null;
  const from = at + name.length + 2;
  const end = body.indexOf("<", from);
  return body.slice(from, end < 0 ? undefined : end).trim();
}

const LAT = /(?:^|\s)lat\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const LON = /(?:^|\s)lon\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const attrOf = (re: RegExp, attrs: string): string | null => {
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? null) : null;
};

// ---------- samples to a summary ----------

export function normSport(raw: string | null | undefined): string | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (/run/.test(s)) return "running";
  if (/walk/.test(s)) return "walking";
  if (/hik/.test(s)) return "hiking";
  if (/cycl|bik|ride/.test(s)) return "cycling";
  if (/swim/.test(s)) return "swimming";
  if (s === "other" || s === "generic" || !/^[a-z][a-z _]{0,29}$/.test(s)) return undefined;
  return s.replace(/ /g, "_");
}

// FIT positions come out of fit-file-parser as raw semicircles; a value beyond +-180 can only be that.
const degrees = (v: unknown): number => (typeof v === "number" && Math.abs(v) > 180 ? (v * 180) / 2 ** 31 : Number(v));

// Drops what is not plausible: a timestamp outside 1990 .. tomorrow or earlier than the one before it, a position outside
// the globe, a position that jumps faster than a person moves (the sample keeps its heart rate and altitude, loses only the
// position). After 3 jumps in a row the next position is taken as a new start, so a fast mover is not dropped to the end of
// the file; the distance of that gap is not counted. A file that names no sport may be a bike ride: it gets the cycling limit.
// `dropped` counts the positions removed as jumps.
function clean(samples: Sample[], sport: string | undefined, now: Date): { kept: Sample[]; dropped: number } {
  const maxT = now.getTime() / 1000 + 86_400;
  const out: Sample[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.t) || s.t < MIN_T || s.t > maxT || (out.length > 0 && s.t < out[out.length - 1].t)) continue;
    if (s.lat !== undefined && !(Math.abs(s.lat) <= 90 && Math.abs(s.lon!) <= 180)) s.lat = s.lon = undefined;
    out.push(s);
  }
  const limit = sport === undefined || sport === "cycling" ? MAX_JUMP_FAST_MS : MAX_JUMP_MS;
  let dropped = 0;
  let last: Sample | null = null;
  let cum = 0;
  let jumps = 0;
  for (const s of out) {
    if (s.lat === undefined) continue;
    if (last !== null) {
      const d = haversine({ lat: last.lat!, lon: last.lon! }, { lat: s.lat, lon: s.lon! });
      const jump = d > limit * Math.max(s.t - last.t, 1);
      if (jump && jumps < 3) {
        s.lat = s.lon = undefined;
        jumps++;
        dropped++;
        continue;
      }
      if (!jump) cum += d;
    }
    jumps = 0;
    s.cum = cum;
    last = s;
  }
  // a distance the file gives is used instead (indoor files have no positions; a device's own distance is calibrated)
  const given = out.filter((s) => Number.isFinite(s.dist));
  if (given.length >= 2) {
    const base = given[0].dist!;
    let high = 0;
    for (const s of out) {
      s.cum = undefined;
      if (Number.isFinite(s.dist) && s.dist! - base >= high) s.cum = high = s.dist! - base;
    }
  }
  return { kept: out, dropped };
}

function ascentOf(samples: Sample[]): number | undefined {
  let ref: number | null = null;
  let up = 0;
  let n = 0;
  for (const s of samples) {
    if (s.ele === undefined || !(s.ele > -500 && s.ele < 9000)) continue;
    n++;
    if (ref === null) ref = s.ele;
    else if (Math.abs(s.ele - ref) >= ASCENT_STEP_M) {
      if (s.ele > ref) up += s.ele - ref;
      ref = s.ele;
    }
  }
  return n >= 2 ? Math.round(up) : undefined;
}

function summarise(samples: Sample[], sport: string | undefined, dropped: number): ImportSummary {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const hrs = samples.map((s) => s.hr).filter((h): h is number => h !== undefined && h >= 30 && h <= 250);
  let hrSum = 0;
  let hrMax = 0;
  for (const h of hrs) {
    hrSum += h;
    if (h > hrMax) hrMax = h;
  }
  let dist = 0;
  for (const s of samples) if (s.cum !== undefined && s.cum > dist) dist = s.cum;
  const ascentM = ascentOf(samples);
  return {
    startTime: new Date(first.t * 1000).toISOString(),
    durationS: Math.round(last.t - first.t),
    distanceM: Math.round(dist),
    ...(hrs.length > 0 ? { avgHr: Math.round(hrSum / hrs.length), maxHr: hrMax } : {}),
    ...(ascentM !== undefined ? { ascentM } : {}),
    ...(sport !== undefined ? { sport } : {}),
    hasGps: samples.filter((s) => s.lat !== undefined).length >= 2,
    ...(dropped > 0 ? { droppedJumps: dropped } : {}),
  };
}

// Distance, altitude and moving time as route-time reads a FIT file: a gap over MAX_GAP_S is a pause and adds no time.
function samplePts(samples: Sample[]): Pt[] {
  const pts: Pt[] = [];
  let t = 0;
  let last: number | null = null;
  for (const s of samples) {
    if (s.cum === undefined || s.ele === undefined) continue;
    if (last !== null && s.t - last <= MAX_GAP_S && s.t > last) t += s.t - last;
    last = s.t;
    pts.push({ d: s.cum, e: s.ele, t });
  }
  return pts;
}

function finish(samples: Sample[], sport: string | undefined, now: Date, what: string, needGps: boolean): ParsedWorkout {
  const { kept, dropped } = clean(samples, sport, now);
  if (kept.length < 2) throw new Error(`fewer than 2 points with a valid timestamp in the ${what} (timestamps must be ISO 8601 with Z or an offset, after 1990 and not in the future)`);
  const summary = summarise(kept, sport, dropped);
  if (needGps && !summary.hasGps) throw new Error(`fewer than 2 valid GPS points in the ${what}`);
  if (summary.durationS <= 0) throw new Error(`the ${what} has no elapsed time between its first and last point`);
  return { summary, pts: samplePts(kept) };
}

// ---------- the formats ----------

// The <type> of the first <trk>, looked for only before its segments and points (a waypoint's <type> is not the activity's).
function gpxSport(xml: string): string | null {
  const trk = elements(xml, "trk").next();
  if (trk.done) return null;
  const ends = [trk.value.body.indexOf("<trkseg"), trk.value.body.indexOf("<trkpt")].filter((i) => i >= 0);
  return textOf(ends.length > 0 ? trk.value.body.slice(0, Math.min(...ends)) : trk.value.body, "type");
}

function parseGpx(xml: string, now: Date): ParsedWorkout {
  if (!xml.includes("<gpx")) throw new Error("not a GPX file (no <gpx> element)");
  if (/<!ENTITY/i.test(xml)) throw new Error("refused: the file declares XML entities, which are never read");
  const samples: Sample[] = [];
  for (const p of elements(xml, "trkpt")) {
    const ele = num(textOf(p.body, "ele"));
    const hr = num(textOf(p.body, "hr"));
    const lat = num(attrOf(LAT, p.attrs));
    const lon = num(attrOf(LON, p.attrs));
    samples.push({
      t: isoSeconds(textOf(p.body, "time")),
      ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}),
      ...(Number.isFinite(ele) ? { ele } : {}),
      ...(Number.isFinite(hr) ? { hr } : {}),
    });
  }
  if (samples.length < 2) throw new Error("fewer than 2 track points (<trkpt>) in the GPX file");
  return finish(samples, normSport(gpxSport(xml)), now, "GPX file", true);
}

function parseTcx(xml: string, now: Date): ParsedWorkout {
  if (!xml.includes("<TrainingCenterDatabase")) throw new Error("not a TCX file (no <TrainingCenterDatabase> element)");
  if (/<!ENTITY/i.test(xml)) throw new Error("refused: the file declares XML entities, which are never read");
  const samples: Sample[] = [];
  for (const p of elements(xml, "Trackpoint")) {
    const lat = num(textOf(p.body, "LatitudeDegrees"));
    const lon = num(textOf(p.body, "LongitudeDegrees"));
    const ele = num(textOf(p.body, "AltitudeMeters"));
    const dist = num(textOf(p.body, "DistanceMeters"));
    const at = p.body.indexOf("<HeartRateBpm");
    const hr = at < 0 ? NaN : num(textOf(p.body.slice(at), "Value"));
    samples.push({
      t: isoSeconds(textOf(p.body, "Time")),
      ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}),
      ...(Number.isFinite(ele) ? { ele } : {}),
      ...(Number.isFinite(dist) ? { dist } : {}),
      ...(Number.isFinite(hr) ? { hr } : {}),
    });
  }
  const tag = xml.indexOf("<Activity ");
  const sportAttr = tag < 0 ? null : /\sSport\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(xml.slice(tag, xml.indexOf(">", tag) + 1));
  return finish(samples, normSport(sportAttr ? (sportAttr[1] ?? sportAttr[2]) : null), now, "TCX file", false);
}

async function parseFitWorkout(bytes: Buffer, now: Date): Promise<ParsedWorkout> {
  const parsed: ParsedFit = await parseFit(bytes); // checkFit first: fit-file-parser can spin forever on other bytes
  const ses = parsed.sessions?.[0] ?? {};
  const samples: Sample[] = [];
  for (const r of parsed.records ?? []) {
    const alt = r?.enhanced_altitude ?? r?.altitude; // kilometres: fit.ts configures the parser with lengthUnit "km"
    const lat = degrees(r?.position_lat);
    const lon = degrees(r?.position_long);
    samples.push({
      t: r?.timestamp instanceof Date ? r.timestamp.getTime() / 1000 : NaN,
      ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}),
      ...(typeof alt === "number" && Number.isFinite(alt) ? { ele: alt * 1000 } : {}),
      ...(typeof r?.heart_rate === "number" ? { hr: r.heart_rate } : {}),
      ...(typeof r?.distance === "number" && Number.isFinite(r.distance) ? { dist: r.distance * 1000 } : {}),
    });
  }
  const sport = normSport(typeof ses.sport === "string" ? ses.sport : null);
  const { kept, dropped } = clean(samples, sport, now);
  const sesStart = ses.start_time instanceof Date ? ses.start_time.getTime() / 1000 : NaN;
  const sesElapsed = Number(ses.total_elapsed_time);
  const fromSession = Number.isFinite(sesStart) && sesStart >= MIN_T && sesStart <= now.getTime() / 1000 + 86_400 && sesElapsed > 0;
  if (!fromSession && kept.length < 2) throw new Error("the FIT file has neither a session with a start time and elapsed time nor 2 records with a valid timestamp");
  const own = kept.length >= 2 ? summarise(kept, sport, dropped) : null;
  const summary: ImportSummary = {
    startTime: fromSession ? new Date(sesStart * 1000).toISOString() : own!.startTime,
    durationS: fromSession ? Math.round(sesElapsed) : own!.durationS,
    distanceM: Number(ses.total_distance) > 0 ? Math.round(ses.total_distance * 1000) : own?.distanceM ?? 0,
    ...(Number(ses.avg_heart_rate) > 0
      ? { avgHr: Math.round(ses.avg_heart_rate), ...(Number(ses.max_heart_rate) > 0 ? { maxHr: Math.round(ses.max_heart_rate) } : {}) }
      : own?.avgHr !== undefined ? { avgHr: own.avgHr, maxHr: own.maxHr } : {}),
    ...(Number(ses.total_ascent) > 0 ? { ascentM: Math.round(ses.total_ascent * 1000) } : own?.ascentM !== undefined ? { ascentM: own.ascentM } : {}),
    ...(sport !== undefined ? { sport } : {}),
    hasGps: own?.hasGps ?? false,
    ...(own?.droppedJumps !== undefined ? { droppedJumps: own.droppedJumps } : {}),
  };
  if (summary.durationS <= 0) throw new Error("the FIT file has no elapsed time");
  return { summary, pts: fitPts(parsed) };
}

export async function parseWorkout(bytes: Buffer, format: ImportFormat, now = new Date()): Promise<ParsedWorkout> {
  if (format === "fit") return parseFitWorkout(bytes, now);
  const xml = bytes.toString("utf8");
  return format === "gpx" ? parseGpx(xml, now) : parseTcx(xml, now);
}
