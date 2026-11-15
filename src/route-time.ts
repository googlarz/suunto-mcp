// estimate_route_time: how long a saved Suunto route takes THIS user, from their own pace on hills. The model is
// time = flat * distance + up * metres climbed + down * metres descended (Naismith's rule with the three constants fitted
// to the user's archived walking/hiking (or running) workouts: record-level distance, altitude and time from the FIT
// files archive_workouts keeps). Without enough such data it says so (model.status "insufficient") and falls back to
// Naismith's generic rule, clearly labelled. Reads one GPX from Suunto and the local archive; writes nothing.
import type { SuuntoClient } from "./api.js";
import { checkFit, type ArchiveStore } from "./archive.js";
import { parseFit, type ParsedFit } from "./fit.js";
import { isValidCalendarDate } from "./schema-validate.js";

// ---------- constants (each one has a boundary test) ----------

export const PIECE_M = 100; // tracks are cut into pieces of this length; each piece has one gradient
export const MIN_TAIL_M = 10; // a leftover shorter than this at the end of a track is dropped
export const ELE_DEADBAND_M = 1; // a piece rising or falling by no more than this counts as level (altitude noise)
export const GRADE_THRESHOLD = 0.03; // a piece at or above +3 % is ascent, at or below -3 % descent, else flat
export const MIN_SPLIT_M = 300; // a stretch shorter than this is merged into the one before it
export const MIN_WORKOUTS = 3;
export const MIN_WORKOUT_M = 1_000; // a workout with less usable track is not counted
export const MIN_DISTANCE_M = 15_000;
export const MIN_ASCENT_M = 300;
export const MIN_DESCENT_M = 300;
export const MAX_FILES = 40; // archived workouts looked at per call, newest first
export const MAX_USED = 25; // usable workouts the model is fitted to
export const MAX_GAP_S = 30; // a pause between two records longer than this is not walking time
export const MAX_GRADE = 0.5; // a training piece steeper than this is an altitude glitch
export const MIN_SPEED = 0.15; // m/s: a training piece slower or faster than these bounds is not walking or running
export const MAX_SPEED = 8;
export const MAX_GPX_BYTES = 10_000_000;
// Naismith: 5 km/h on the flat plus 1 hour per 600 m climbed, nothing for descent.
export const GENERIC = { flat: 3600 / 5000, up: 3600 / 600, down: 0 };
// A fitted constant outside these bounds is not a pace: the data cannot support a model.
const BOUNDS = { flat: [0.2, 3], up: [0, 20], down: [-3, 5] } as const;

const GROUPS = { walking: ["walking", "hiking"], running: ["running"] } as const;
export type Activity = keyof typeof GROUPS;

// ---------- geometry ----------

export interface Pt {
  d: number; // metres from the start
  e: number | null; // altitude in metres, null when unknown
  t: number | null; // moving time in seconds from the start, null for a route
}
export interface Piece {
  dist: number;
  dEle: number; // 0 when the altitude is unknown
  time: number | null;
}

export function parseGpx(gpx: string): { name: string | null; points: { lat: number; lon: number; ele: number | null }[] } {
  const tag = /<rtept\b/.test(gpx) ? "rtept" : "trkpt";
  const points: { lat: number; lon: number; ele: number | null }[] = [];
  for (const m of gpx.matchAll(new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "g"))) {
    const attr = (n: string) => Number(new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`).exec(m[1])?.[1]);
    const lat = attr("lat");
    const lon = attr("lon");
    const ele = m[2] === undefined ? NaN : Number(/<ele>\s*([^<\s]+)\s*<\/ele>/.exec(m[2])?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  const name = /<name>\s*(?:<!\[CDATA\[)?([^<\]]*?)(?:\]\]>)?\s*<\/name>/.exec(gpx)?.[1]?.trim();
  return { name: name ? name.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").slice(0, 200) : null, points };
}

const R = 6_371_008.8;
function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Altitude is used only when EVERY point has it: a partial profile would invent climbs.
export function gpxPts(points: { lat: number; lon: number; ele: number | null }[]): Pt[] {
  const hasEle = points.every((p) => p.ele !== null);
  let d = 0;
  return points.map((p, i) => {
    if (i > 0) d += haversine(points[i - 1], p);
    return { d, e: hasEle ? p.ele : null, t: null };
  });
}

// Cuts a track into pieces of pieceM metres (the last one shorter, dropped under MIN_TAIL_M), interpolating altitude and
// time linearly, so a route with a point every 5 m and a FIT file with one every second are read on the same grid.
export function toPieces(pts: Pt[], pieceM = PIECE_M): Piece[] {
  const out: Piece[] = [];
  if (pts.length < 2) return out;
  const total = pts[pts.length - 1].d;
  let i = 0;
  const at = (g: number): Pt => {
    while (i < pts.length - 2 && pts[i + 1].d < g) i++;
    const a = pts[i];
    const b = pts[i + 1];
    const f = b.d === a.d ? 1 : Math.min(1, Math.max(0, (g - a.d) / (b.d - a.d)));
    const mix = (x: number | null, y: number | null) => (x === null || y === null ? null : x + (y - x) * f);
    return { d: g, e: mix(a.e, b.e), t: mix(a.t, b.t) };
  };
  const push = (a: Pt, b: Pt) => out.push({ dist: b.d - a.d, dEle: a.e === null || b.e === null ? 0 : b.e - a.e, time: a.t === null || b.t === null ? null : b.t - a.t });
  let prev = at(pts[0].d);
  for (let g = pts[0].d + pieceM; g < total; g += pieceM) {
    const cur = at(g);
    push(prev, cur);
    prev = cur;
  }
  if (total - prev.d >= MIN_TAIL_M) push(prev, at(total));
  return out;
}

export const climb = (p: Piece): { up: number; down: number } => ({ up: p.dEle > ELE_DEADBAND_M ? p.dEle : 0, down: p.dEle < -ELE_DEADBAND_M ? -p.dEle : 0 });
export const kindOf = (grade: number): "ascent" | "descent" | "flat" => (grade >= GRADE_THRESHOLD ? "ascent" : grade <= -GRADE_THRESHOLD ? "descent" : "flat");

// ---------- the user's own pace ----------

// One archived workout as points. fit-file-parser is configured with lengthUnit "km" (see fit.ts), so distance and altitude
// come out in kilometres. Time is moving time: a gap between records over MAX_GAP_S is a pause and adds nothing.
export function fitPts(parsed: ParsedFit): Pt[] {
  const pts: Pt[] = [];
  let t = 0;
  let last: number | null = null;
  for (const r of parsed.records ?? []) {
    const d = Number(r?.distance) * 1000;
    const alt = r?.enhanced_altitude ?? r?.altitude;
    const e = typeof alt === "number" && Number.isFinite(alt) ? alt * 1000 : null;
    const at = r?.elapsed_time !== undefined ? Number(r.elapsed_time) : r?.timestamp instanceof Date ? r.timestamp.getTime() / 1000 : NaN;
    if (!Number.isFinite(d) || !Number.isFinite(at) || e === null || (pts.length > 0 && d < pts[pts.length - 1].d)) continue;
    if (last !== null && at - last <= MAX_GAP_S && at > last) t += at - last;
    last = at;
    pts.push({ d, e, t });
  }
  return pts;
}

// Pieces fit for fitting: a time, a plausible speed, no altitude glitch.
export const trainingPieces = (pieces: Piece[]): Piece[] =>
  pieces.filter((p) => p.time !== null && p.time > 0 && p.dist / p.time >= MIN_SPEED && p.dist / p.time <= MAX_SPEED && Math.abs(p.dEle) / p.dist <= MAX_GRADE);

export interface Model {
  flat: number; // seconds per metre on the flat
  up: number; // extra seconds per metre climbed
  down: number; // extra seconds per metre descended (negative: faster downhill)
}

// Least squares of time on [distance, climbed, descended] over all pieces (normal equations, Gaussian elimination).
export function fitModel(pieces: Piece[]): Model | null {
  const m = [0, 0, 0].map(() => [0, 0, 0, 0]);
  for (const p of pieces) {
    const x = [p.dist, climb(p).up, climb(p).down];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i][j] += x[i] * x[j];
      m[i][3] += x[i] * p.time!;
    }
  }
  for (let c = 0; c < 3; c++) {
    const pivot = [0, 1, 2].filter((r) => r >= c).reduce((a, b) => (Math.abs(m[b][c]) > Math.abs(m[a][c]) ? b : a));
    [m[c], m[pivot]] = [m[pivot], m[c]];
    if (Math.abs(m[c][c]) < 1e-9) return null;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return { flat: m[0][3] / m[0][0], up: m[1][3] / m[1][1], down: m[2][3] / m[2][2] };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const predict = (p: Piece, m: Model): number => {
  const { up, down } = climb(p);
  return Math.max(0.5 * m.flat * p.dist, m.flat * p.dist + m.up * up + m.down * down); // a steep descent never makes a piece take less than half its flat time
};

export interface ModelResult {
  status: "ok" | "insufficient";
  reason?: string;
  workoutsUsed: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  model?: Model;
  inSampleErrorPct?: number | null;
}

// `workouts`: the pieces of each candidate workout. Needs MIN_WORKOUTS workouts of at least MIN_WORKOUT_M each and, together,
// MIN_DISTANCE_M, MIN_ASCENT_M and MIN_DESCENT_M (without climbing in the data the climbing constant cannot be fitted).
export function buildModel(workouts: Piece[][]): ModelResult {
  const used = workouts.map(trainingPieces).filter((w) => sum(w.map((p) => p.dist)) >= MIN_WORKOUT_M);
  const all = used.flat();
  const stats = { workoutsUsed: used.length, distanceM: Math.round(sum(all.map((p) => p.dist))), ascentM: Math.round(sum(all.map((p) => climb(p).up))), descentM: Math.round(sum(all.map((p) => climb(p).down))) };
  const no = (reason: string): ModelResult => ({ status: "insufficient", reason, ...stats });
  if (used.length < MIN_WORKOUTS) return no(`only ${used.length} usable workout(s) with at least ${MIN_WORKOUT_M} m of track, distance, altitude and time (at least ${MIN_WORKOUTS} needed)`);
  if (sum(all.map((p) => p.dist)) < MIN_DISTANCE_M) return no(`${stats.distanceM} m of usable track in total (at least ${MIN_DISTANCE_M} m needed)`);
  if (sum(all.map((p) => climb(p).up)) < MIN_ASCENT_M) return no(`${stats.ascentM} m of climbing in total (at least ${MIN_ASCENT_M} m needed to fit the effect of hills)`);
  if (sum(all.map((p) => climb(p).down)) < MIN_DESCENT_M) return no(`${stats.descentM} m of descent in total (at least ${MIN_DESCENT_M} m needed)`);
  const model = fitModel(all);
  if (model === null) return no("the data have no variation in gradient to fit");
  for (const k of ["flat", "up", "down"] as const) {
    if (model[k] < BOUNDS[k][0] || model[k] > BOUNDS[k][1]) return no(`the fitted ${k} constant (${model[k].toFixed(2)} s/m) is outside what a pace can be (${BOUNDS[k][0]} to ${BOUNDS[k][1]}), so the data cannot support a model`);
  }
  const errs = used.map((w) => Math.abs(sum(w.map((p) => predict(p, model))) - sum(w.map((p) => p.time!))) / sum(w.map((p) => p.time!))).sort((a, b) => a - b);
  const mid = errs.length >> 1;
  const median = errs.length % 2 ? errs[mid] : (errs[mid - 1] + errs[mid]) / 2;
  return { status: "ok", ...stats, model, inSampleErrorPct: Math.round(median * 1000) / 10 };
}

// ---------- the estimate ----------

export interface Split {
  kind: "ascent" | "descent" | "flat";
  startM: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  timeS: number;
}

export function estimate(pieces: Piece[], m: Model) {
  // consecutive pieces of one kind form a run; a run shorter than MIN_SPLIT_M is merged into the one before it
  const runs: Split[] = [];
  let at = 0;
  let total = 0;
  for (const p of pieces) {
    const { up, down } = climb(p);
    const time = predict(p, m);
    total += time;
    const kind = kindOf(p.dEle / p.dist);
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) {
      last.distanceM += p.dist;
      last.ascentM += up;
      last.descentM += down;
      last.timeS += time;
    } else runs.push({ kind, startM: at, distanceM: p.dist, ascentM: up, descentM: down, timeS: time });
    at += p.dist;
  }
  const merged: Split[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r.distanceM < MIN_SPLIT_M || last.kind === r.kind)) {
      last.distanceM += r.distanceM;
      last.ascentM += r.ascentM;
      last.descentM += r.descentM;
      last.timeS += r.timeS;
    } else merged.push({ ...r });
  }
  const splits = merged.map((s) => ({ ...s, startM: Math.round(s.startM), distanceM: Math.round(s.distanceM), ascentM: Math.round(s.ascentM), descentM: Math.round(s.descentM), timeS: Math.round(s.timeS) }));
  return { totalTimeS: Math.round(total), splits };
}

const fmtDur = (s: number): string => {
  const min = Math.round(s / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
};

// The sunset is the user's own (no lookup is made): latest start = sunset - margin - estimated time, written with the
// sunset's own UTC offset.
const SUNSET = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const MAX_MARGIN_MIN = 360;
export function latestStart(totalTimeS: number, sunset: string, marginMinutes: number, now = new Date()) {
  const m = SUNSET.exec(sunset);
  if (!m || !isValidCalendarDate(m[1]) || Number.isNaN(Date.parse(sunset))) throw new Error(`sunset "${sunset}" must be an ISO 8601 date-time with its UTC offset, e.g. 2026-11-15T16:05:00+01:00.`);
  if (!Number.isInteger(marginMinutes) || marginMinutes < 0 || marginMinutes > MAX_MARGIN_MIN) throw new Error(`marginMinutes must be a whole number from 0 to ${MAX_MARGIN_MIN}, got ${marginMinutes}.`);
  const offsetMin = m[2] === "Z" ? 0 : (m[2][0] === "-" ? -1 : 1) * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(4, 6)));
  const startMs = Date.parse(sunset) - (marginMinutes * 60 + totalTimeS) * 1000;
  const local = new Date(startMs + offsetMin * 60_000).toISOString().slice(0, 19);
  return {
    sunset,
    marginMinutes,
    latestStart: `${local}${m[2]}`,
    latestStartUtc: new Date(startMs).toISOString(),
    finishBy: new Date(Date.parse(sunset) - marginMinutes * 60_000).toISOString(),
    alreadyPast: startMs < now.getTime(),
  };
}

// ---------- the call ----------

export interface RouteTimeOpts {
  routeId: string;
  activity?: Activity;
  sunset?: string;
  marginMinutes?: number;
}
export interface RouteTimeDeps {
  parse?: (bytes: Buffer) => Promise<ParsedFit>;
  now?: Date;
}
type Client = Pick<SuuntoClient, "exportRoute">;

export async function estimateRouteTime(client: Client, store: ArchiveStore, opts: RouteTimeOpts, deps: RouteTimeDeps = {}) {
  const activity = opts.activity ?? "walking";
  if (!(activity in GROUPS)) throw new Error(`activity must be "walking" or "running", got "${activity}".`);
  const margin = opts.marginMinutes ?? 30;
  if (opts.sunset !== undefined) latestStart(0, opts.sunset, margin); // refuse a bad sunset or margin before anything is read
  else if (opts.marginMinutes !== undefined) throw new Error("marginMinutes only applies together with sunset.");

  const gpx = await client.exportRoute(opts.routeId);
  if (gpx.length > MAX_GPX_BYTES) throw new Error(`The route file is larger than ${MAX_GPX_BYTES / 1_000_000} MB.`);
  const parsedGpx = parseGpx(gpx.toString("utf8"));
  if (parsedGpx.points.length < 2) throw new Error("The route has fewer than 2 track points, so there is nothing to estimate.");
  const pts = gpxPts(parsedGpx.points);
  const routePieces = toPieces(pts);
  if (routePieces.length === 0) throw new Error("The route is shorter than a few metres, so there is nothing to estimate.");
  const hasElevation = pts[0].e !== null;

  // the user's own workouts, newest first, from the local archive only (no Suunto request)
  const parse = deps.parse ?? parseFit;
  const scan = await store.scan();
  const records = [...scan.records.values()]
    .sort((a, b) => (Number((b.workout as any).startTime) || 0) - (Number((a.workout as any).startTime) || 0))
    .slice(0, MAX_FILES);
  const workouts: Piece[][] = [];
  const skipped = { otherSport: 0, noMotionData: 0, unreadable: 0 };
  for (const r of records) {
    if (workouts.length >= MAX_USED) break;
    try {
      const bytes = await store.readFit(r.workoutKey);
      // fit-file-parser can spin forever on bytes that are not a FIT file (seen on repeated garbage input), so only a file
      // that passes the archive's own header and length check reaches it
      if (checkFit(bytes) !== null) throw new Error("not a complete FIT file");
      const fit = await parse(bytes);
      const sport = String(fit.sessions?.[0]?.sport ?? "").toLowerCase();
      if (!(GROUPS[activity] as readonly string[]).includes(sport)) {
        skipped.otherSport++;
        continue;
      }
      const wp = toPieces(fitPts(fit));
      if (wp.length === 0) skipped.noMotionData++;
      else workouts.push(wp);
    } catch {
      skipped.unreadable++;
    }
  }
  const fitted = buildModel(workouts);
  const personal = fitted.status === "ok";
  const model = personal ? fitted.model! : GENERIC;
  const est = estimate(routePieces, model);

  const sumOf = (f: (p: Piece) => number) => Math.round(sum(routePieces.map(f)));
  const byKind = Object.fromEntries((["flat", "ascent", "descent"] as const).map((k) => {
    const s = est.splits.filter((x) => x.kind === k);
    return [k, { distanceM: sum(s.map((x) => x.distanceM)), timeS: sum(s.map((x) => x.timeS)) }];
  }));
  const notes = [
    "An ESTIMATE of walking (or running) time without stops, photos, food or navigation pauses: add time for those. Weather, load, trail surface and fatigue are not modelled, and a route's altitude (often from a map, not a barometer) differs from what your watch records.",
  ];
  if (!personal) notes.push(`Your own pace could not be modelled (${fitted.reason}); the estimate below is the generic Naismith rule (5 km/h plus 1 h per 600 m climbed, nothing for descent), NOT your pace. Archive more ${activity} workouts with archive_workouts (FIT files with altitude and distance) to get a personal estimate.`);
  if (activity === "running" && !personal) notes.push("The generic fallback is a WALKING rule even though activity is running.");
  if (!hasElevation) notes.push("The route has no altitude on every point, so climbing and descent are not counted: the estimate is flat-ground time and a hilly route will take longer.");
  if (records.length === 0) notes.push("The local archive is empty or missing: run archive_workouts first.");

  return {
    route: { name: parsedGpx.name, points: parsedGpx.points.length, distanceM: sumOf((p) => p.dist), ascentM: sumOf((p) => climb(p).up), descentM: sumOf((p) => climb(p).down), hasElevation },
    activity,
    basis: personal ? "personal" : "generic-naismith",
    model: {
      status: fitted.status,
      ...(fitted.reason ? { reason: fitted.reason } : {}),
      workoutsUsed: fitted.workoutsUsed,
      workoutsConsidered: records.length,
      skipped,
      distanceM: fitted.distanceM,
      ascentM: fitted.ascentM,
      descentM: fitted.descentM,
      ...(personal ? { flatPaceSPerKm: Math.round(model.flat * 1000), ascentSPerM: Math.round(model.up * 100) / 100, descentSPerM: Math.round(model.down * 100) / 100, inSampleErrorPct: fitted.inSampleErrorPct } : {}),
    },
    estimate: { totalTimeS: est.totalTimeS, totalTime: fmtDur(est.totalTimeS), byKind, splits: est.splits },
    latestStart: opts.sunset === undefined ? null : latestStart(est.totalTimeS, opts.sunset, margin, deps.now),
    assumptions: [
      "Time = flat pace x distance + extra time per metre climbed + extra time per metre descended; constants fitted by least squares to the pieces (100 m each) of your archived workouts of the same kind (walking and hiking, or running), the newest 25 usable ones of the 40 newest archived.",
      `Ascent, descent and flat are pieces at or above +3 %, at or below -3 % and in between; stretches under ${MIN_SPLIT_M} m are merged into the one before. Altitude changes of 1 m or less per 100 m count as level.`,
      "In-sample error is how far the model is from your own workouts' total times (median over them): it says how well it fits the past, not how close this estimate will be.",
      ...(opts.sunset === undefined ? [] : [`Latest start = the sunset you gave minus ${margin} min margin minus the estimated time. The sunset is not looked up and daylight after it (twilight, a headlamp) is not considered.`]),
    ],
    notes,
  };
}
