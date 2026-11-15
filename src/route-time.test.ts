import { test } from "node:test";
import assert from "node:assert/strict";
import type { SuuntoClient } from "./api.js";
import { memoryArchiveStore, type ArchiveStore } from "./archive.js";
import { parseFit } from "./fit.js";
import {
  ELE_DEADBAND_M, GENERIC, GRADE_THRESHOLD, MAX_FILES, MAX_USED, MIN_ASCENT_M, MIN_DESCENT_M, MIN_DISTANCE_M, MIN_SPLIT_M, MIN_TAIL_M, MIN_WORKOUTS, MIN_WORKOUT_M,
  buildModel, climb, estimate, estimateRouteTime, fitModel, fitPts, gpxPts, kindOf, latestStart, parseGpx, toPieces, type Piece,
} from "./route-time.js";

// ---------- helpers ----------

const TRUE = { flat: 0.8, up: 5, down: 1 }; // seconds per metre
const piece = (dEle: number, dist = 100): Piece => ({ dist, dEle, time: dist * TRUE.flat + TRUE.up * (dEle > ELE_DEADBAND_M ? dEle : 0) + TRUE.down * (dEle < -ELE_DEADBAND_M ? -dEle : 0) });
// 5 km: 10 pieces climbing 10 m, 10 descending 10 m, 30 level
const workout = (ups = 10, up = 10): Piece[] => [...Array(ups).fill(up), ...Array(10).fill(-10), ...Array(50 - ups - 10).fill(0)].map((d) => piece(d));
const three = (): Piece[][] => [workout(), workout(), workout()];

const { buildFit } = (await import(new URL("../test-fixtures/fit-builder.mjs", import.meta.url).href)) as { buildFit: (o: any) => Buffer };

// ---------- GPX ----------

test("parseGpx: route points with altitude, track points as the fallback, a missing altitude is null, junk is skipped", () => {
  const rte = parseGpx(`<gpx><rte><name>Hill &amp; dale</name><rtept lat="52.5" lon="13.4"><ele>40.5</ele></rtept><rtept lat='52.6' lon='13.5'><ele>41</ele></rtept></rte></gpx>`);
  assert.equal(rte.name, "Hill & dale");
  assert.deepEqual(rte.points, [{ lat: 52.5, lon: 13.4, ele: 40.5 }, { lat: 52.6, lon: 13.5, ele: 41 }]);
  const trk = parseGpx(`<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2"><ele>3</ele></trkpt></trkseg></trk></gpx>`);
  assert.deepEqual(trk.points, [{ lat: 1, lon: 2, ele: null }, { lat: 1.1, lon: 2, ele: 3 }]);
  assert.equal(parseGpx(`<gpx><rtept lat="95" lon="2"><ele>1</ele></rtept><rtept lat="x" lon="2"/></gpx>`).points.length, 0);
  assert.equal(parseGpx("<gpx></gpx>").name, null);
});

test("gpxPts: altitude is used only when every point has it", () => {
  const pts = [{ lat: 0, lon: 0, ele: 1 }, { lat: 0.001, lon: 0, ele: 2 }, { lat: 0.002, lon: 0, ele: null }];
  assert.ok(gpxPts(pts).every((p) => p.e === null));
  const all = gpxPts(pts.map((p) => ({ ...p, ele: 5 })));
  assert.ok(Math.abs(all[2].d - 222.39) < 0.1, `${all[2].d}`);
});

// ---------- pieces and their boundaries ----------

const line = (...ds: number[]) => ds.map((d) => ({ d, e: d / 10, t: null }));

test("toPieces: 100 m pieces with interpolated altitude; a tail under 10 m is dropped, 10 m is kept", () => {
  assert.equal(MIN_TAIL_M, 10);
  const full = toPieces(line(0, 50, 1000));
  assert.equal(full.length, 10);
  assert.ok(full.every((p) => Math.abs(p.dist - 100) < 1e-9 && Math.abs(p.dEle - 10) < 1e-9));
  assert.equal(toPieces(line(0, 1009.99)).length, 10);
  const kept = toPieces(line(0, 1010));
  assert.equal(kept.length, 11);
  assert.ok(Math.abs(kept[10].dist - 10) < 1e-9);
  assert.deepEqual(toPieces(line(0)), []);
  assert.equal(toPieces([{ d: 0, e: null, t: null }, { d: 250, e: null, t: null }]).every((p) => p.dEle === 0), true);
});

test("climb: a rise of exactly 1 m per piece is level, anything above counts", () => {
  assert.equal(ELE_DEADBAND_M, 1);
  assert.deepEqual(climb({ dist: 100, dEle: 1, time: null }), { up: 0, down: 0 });
  assert.deepEqual(climb({ dist: 100, dEle: -1, time: null }), { up: 0, down: 0 });
  assert.deepEqual(climb({ dist: 100, dEle: 1.01, time: null }), { up: 1.01, down: 0 });
  assert.deepEqual(climb({ dist: 100, dEle: -1.01, time: null }), { up: 0, down: 1.01 });
});

test("kindOf: +3 % and -3 % exactly are ascent and descent, just inside is flat", () => {
  assert.equal(GRADE_THRESHOLD, 0.03);
  assert.deepEqual([kindOf(0.03), kindOf(0.0299), kindOf(0), kindOf(-0.0299), kindOf(-0.03)], ["ascent", "flat", "flat", "flat", "descent"]);
});

// ---------- the model ----------

test("fitModel: recovers the constants the times were made from", () => {
  const m = fitModel(three().flat())!;
  assert.ok(Math.abs(m.flat - 0.8) < 1e-9 && Math.abs(m.up - 5) < 1e-9 && Math.abs(m.down - 1) < 1e-9, JSON.stringify(m));
  assert.equal(fitModel([piece(0), piece(0)]), null, "no climbing at all: the system is singular");
});

test("buildModel: exactly at every minimum it fits (3 workouts, 15 km, 300 m up, 300 m down)", () => {
  assert.deepEqual([MIN_WORKOUTS, MIN_DISTANCE_M, MIN_ASCENT_M, MIN_DESCENT_M, MIN_WORKOUT_M], [3, 15_000, 300, 300, 1_000]);
  const r = buildModel(three());
  assert.equal(r.status, "ok");
  assert.deepEqual([r.workoutsUsed, r.distanceM, r.ascentM, r.descentM], [3, 15_000, 300, 300]);
  assert.equal(r.inSampleErrorPct, 0);
});

test("buildModel: one workout, 100 m of distance, 0.1 m of climbing or of descent short is insufficient and says which", () => {
  const two = buildModel([workout(), workout()]);
  assert.equal(two.status, "insufficient");
  assert.match(two.reason!, /only 2 usable workout\(s\).*at least 3 needed/);
  const shortDistance = buildModel([workout(), workout(), workout().slice(1)]); // 14,900 m, ascent still 300
  assert.equal(shortDistance.status, "insufficient");
  assert.match(shortDistance.reason!, /14900 m of usable track.*15000 m needed/);
  const shortClimb = buildModel([workout(), workout(), [...workout().slice(1), piece(9.9)]]); // the first piece (+10 m) swapped for +9.9 m on a level stretch of the same length
  assert.equal(shortClimb.distanceM, 15_000);
  assert.equal(shortClimb.status, "insufficient");
  assert.match(shortClimb.reason!, /m of climbing in total \(at least 300 m needed/);
  const shortDescent = buildModel([workout(), workout(), workout().map((p) => (p.dEle === -10 ? piece(-9.99) : p))]);
  assert.equal(shortDescent.status, "insufficient");
  assert.match(shortDescent.reason!, /m of descent in total \(at least 300 m needed/);
});

test("buildModel: a workout needs 1,000 m of track to count (999 m does not)", () => {
  const tenPieces = Array.from({ length: 10 }, () => piece(0));
  const short = buildModel([workout(), workout(), tenPieces.slice(1)]);
  assert.match(short.reason!, /only 2 usable/);
  const exact = buildModel([workout(), workout(), tenPieces]);
  assert.doesNotMatch(exact.reason ?? "", /only 2 usable/);
  assert.equal(exact.workoutsUsed, 3);
});

test("buildModel: pieces without a time, too slow, too fast or on a 51 % slope are not trained on", () => {
  const bad: Piece[] = [
    { dist: 100, dEle: 0, time: null },
    { dist: 100, dEle: 0, time: 100 / 0.14 }, // 0.14 m/s
    { dist: 100, dEle: 0, time: 100 / 8.1 },
    { dist: 100, dEle: 51, time: 400 },
  ];
  const r = buildModel([[...workout(), ...bad], workout(), workout()]);
  assert.equal(r.status, "ok");
  assert.equal(r.distanceM, 15_000, "none of the four bad pieces was counted");
  const edges: Piece[] = [{ dist: 100, dEle: 0, time: 100 / 0.15 }, { dist: 100, dEle: 0, time: 100 / 8 }, { dist: 100, dEle: 50, time: 400 }];
  assert.equal(buildModel([[...workout(), ...edges], workout(), workout()]).distanceM, 15_300, "0.15 m/s, 8 m/s and a 50 % slope are still fine");
});

test("buildModel: an implausible fit (a flat constant of 0.1 s/m) is insufficient, not a wild pace", () => {
  const fast = (w: Piece[]) => w.map((p) => ({ ...p, time: p.time! / 5 }));
  const r = buildModel(three().map(fast));
  assert.equal(r.status, "insufficient");
  assert.match(r.reason!, /fitted flat constant.*cannot support a model/);
});

// ---------- the estimate ----------

test("estimate: flat, ascent and descent splits; a 100 m stretch is merged into the one before it", () => {
  const route = [0, 0, 0, 0, 5, 5, 5, 5, 0, -5, -5, -5, -5].map((d) => piece(d));
  const e = estimate(route, TRUE);
  assert.deepEqual(e.splits.map((s) => [s.kind, s.startM, s.distanceM, s.ascentM, s.descentM, s.timeS]), [
    ["flat", 0, 400, 0, 0, 320],
    ["ascent", 400, 500, 20, 0, 500], // 4 x (80 + 25) + the 80 s flat piece merged into it
    ["descent", 900, 400, 0, 20, 340],
  ]);
  assert.equal(e.totalTimeS, 1160);
});

test("estimate: a stretch of exactly 300 m stands on its own, 299 m is merged", () => {
  assert.equal(MIN_SPLIT_M, 300);
  const three100 = [5, 5, 5, 5, 0, 0, 0, 5, 5, 5, 5].map((d) => piece(d));
  assert.deepEqual(estimate(three100, TRUE).splits.map((s) => [s.kind, s.distanceM]), [["ascent", 400], ["flat", 300], ["ascent", 400]]);
  const short = [5, 5, 5, 5, 0, 0, 5, 5, 5, 5, 5].map((d) => piece(d));
  assert.deepEqual(estimate(short, TRUE).splits.map((s) => [s.kind, s.distanceM]), [["ascent", 1100]], "the 200 m flat stretch is merged and the two ascents join");
  assert.deepEqual(estimate([piece(0, 299), piece(5, 400)], TRUE).splits.map((s) => [s.kind, s.distanceM]), [["flat", 699]], "a first stretch too short stays, the next one merges into it");
});

test("estimate: a steep descent never takes less than half the flat time of the piece", () => {
  const p: Piece = { dist: 100, dEle: -50, time: null };
  assert.equal(estimate([p], { flat: 0.8, up: 5, down: -2 }).totalTimeS, 40); // 80 - 100 would be negative
});

test("buildModel: reports the steepest descent and ascent seen in the training pieces", () => {
  const r = buildModel(three());
  assert.deepEqual(r.gradeRange, { min: -0.1, max: 0.1 });
  assert.equal(buildModel([workout(), workout()]).gradeRange, undefined, "no model, no range");
});

test("estimate: pieces steeper than anything in the user's workouts are marked, not silently extrapolated (the range edge itself is inside)", () => {
  const range = { min: -0.1, max: 0.1 };
  const route = [0, 10, 10.01, 15, -10, -10.01, -12].map((d) => piece(d));
  const e = estimate(route, TRUE, range);
  assert.equal(e.outsideRangeM, 400, "10.01 %, 15 %, -10.01 % and -12 % are outside; +10 % and -10 % are not");
  assert.equal(estimate(route, TRUE).outsideRangeM, 0, "without a range nothing is marked");
  assert.deepEqual(estimate([piece(10), piece(10)], TRUE, range).splits.map((s) => s.outsideRangeM), [0]);
  assert.deepEqual(estimate([piece(10), piece(15), piece(15), piece(15)], TRUE, range).splits.map((s) => [s.kind, s.distanceM, s.outsideRangeM]), [["ascent", 400, 300]]);
});

test("estimateRouteTime: a route steeper than the user's own workouts gets a note and the metres that are extrapolated", async () => {
  const store = memoryArchiveStore();
  for (let i = 0; i < 3; i++) await archived(store, walk(profile(), 1_800_000_000 + i * 86_400), 1_800_000_000_000 + i * 86_400_000);
  // 3 km at 8 % (inside the workouts' +/-10 %), then 2 km at 20 % (outside)
  const gentle = await estimateRouteTime(clientOf(gpxOf((i) => 100 + Math.min(i, 30) * 8, 30)), store, { routeId: "r" });
  assert.equal(gentle.basis, "personal");
  assert.equal(gentle.estimate.outsideRangeM, 0);
  assert.ok(!gentle.notes.some((x: string) => /steeper than anything/.test(x)));
  const steep = await estimateRouteTime(clientOf(gpxOf((i) => 100 + (i < 30 ? i * 8 : 240 + (i - 30) * 20), 50)), store, { routeId: "r" });
  assert.equal(steep.basis, "personal");
  assert.ok(steep.estimate.outsideRangeM >= 1900 && steep.estimate.outsideRangeM <= 2100, `${steep.estimate.outsideRangeM}`);
  assert.ok(Math.abs(steep.model.gradeRangePct!.min + 10) < 1.5 && Math.abs(steep.model.gradeRangePct!.max - 10) < 1.5, JSON.stringify(steep.model.gradeRangePct)); // +/-10 % up to the FIT altitude's 0.2 m steps
  const note = steep.notes.find((x: string) => /steeper than anything/.test(x))!;
  assert.match(note, /About [12]\d{3} m \(\d+ %\) of the route is steeper than anything in your workouts \(-\d+(\.\d)? % to \+\d+(\.\d)? %\)/);
  assert.ok(steep.estimate.splits.some((s) => s.outsideRangeM > 0));
  // the generic fallback has no personal range to be outside of
  const generic = await estimateRouteTime(clientOf(gpxOf((i) => 100 + i * 20, 30)), memoryArchiveStore(), { routeId: "r" });
  assert.equal(generic.estimate.outsideRangeM, 0);
  assert.ok(!generic.notes.some((x: string) => /steeper than anything/.test(x)));
});

// ---------- the sunset ----------

test("latestStart: sunset minus the margin minus the time, in the sunset's own offset", () => {
  const now = new Date("2026-11-15T06:00:00Z");
  const r = latestStart(7500, "2026-11-15T16:05:00+01:00", 30, now); // 2 h 05 min
  assert.equal(r.latestStart, "2026-11-15T13:30:00+01:00");
  assert.equal(r.latestStartUtc, "2026-11-15T12:30:00.000Z");
  assert.equal(r.finishBy, "2026-11-15T15:05:00.000Z".replace("15:05", "14:35"));
  assert.equal(r.alreadyPast, false);
  assert.equal(latestStart(7500, "2026-11-15T16:05:00+01:00", 0, now).latestStart, "2026-11-15T14:00:00+01:00");
  assert.equal(latestStart(7500, "2026-11-15T16:05:00Z", 30, now).latestStart, "2026-11-15T13:30:00Z");
  assert.equal(latestStart(7500, "2026-11-15T16:05:00-05:00", 30, now).latestStart, "2026-11-15T13:30:00-05:00");
  assert.equal(latestStart(20_000, "2026-11-15T04:00:00+01:00", 30, now).latestStart, "2026-11-14T21:56:40+01:00", "it can fall on the day before");
  assert.equal(latestStart(7500, "2026-11-15T16:05:00+01:00", 30, new Date("2026-11-15T12:30:01Z")).alreadyPast, true);
  assert.equal(latestStart(7500, "2026-11-15T16:05:00+01:00", 30, new Date("2026-11-15T12:30:00Z")).alreadyPast, false);
});

test("latestStart: a sunset without an offset or with an impossible date, and a margin out of 0..360, are refused", () => {
  for (const bad of ["2026-11-15T16:05:00", "2026-11-15", "16:05", "2026-02-30T16:05:00Z", "yesterday", "2026-11-15T16:05:00+1"]) assert.throws(() => latestStart(100, bad, 30), /must be an ISO 8601 date-time with its UTC offset/, bad);
  assert.doesNotThrow(() => latestStart(100, "2026-11-15T16:05:00Z", 360));
  assert.doesNotThrow(() => latestStart(100, "2026-11-15T16:05:00Z", 0));
  for (const m of [-1, 361, 1.5, NaN]) assert.throws(() => latestStart(100, "2026-11-15T16:05:00Z", m), /marginMinutes must be a whole number from 0 to 360/);
});

// ---------- the FIT files and the whole call ----------

// A walk made from the model above: a record every 10 m, each taking its piece's time / 10, altitude linear inside a piece.
function walk(profile: number[], startUnixS: number, sport = 11, start = 100): Buffer {
  const records: any[] = [];
  let t = startUnixS;
  let d = 0;
  let alt = start;
  records.push({ unixS: t, hr: 120, distanceM: 0, altitudeM: alt });
  for (const dEle of profile) {
    const secs = piece(dEle).time! / 10;
    for (let k = 0; k < 10; k++) {
      t += secs;
      d += 10;
      alt += dEle / 10;
      records.push({ unixS: Math.round(t), hr: 120, distanceM: d, altitudeM: alt });
    }
  }
  return buildFit({ records, sessionStartUnixS: startUnixS, sport });
}
const profile = (): number[] => workout().map((p) => p.dEle);

let n = 0;
async function archived(store: ArchiveStore, fit: Buffer, startTime: number, extra: object = {}) {
  const key = (++n).toString(16).padStart(24, "0");
  await store.save(key, fit, { version: 1, workoutKey: key, archivedAt: "2026-11-15T00:00:00.000Z", fit: { bytes: fit.length, sha256: "a".repeat(64) }, workout: { startTime, ...extra } });
  return key;
}
const gpxOf = (ele: (i: number) => number | null, steps = 100): Buffer =>
  Buffer.from(`<gpx><rte><name>Test route</name>${Array.from({ length: steps + 1 }, (_, i) => `<rtept lat="${(52 + i * 0.0009).toFixed(5)}" lon="13.4">${ele(i) === null ? "" : `<ele>${ele(i)}</ele>`}</rtept>`).join("")}</rte></gpx>`);
const clientOf = (gpx: Buffer): Pick<SuuntoClient, "exportRoute"> & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, exportRoute: async (id: string) => (calls.push(id), gpx) };
};

test("parseFit units: a real FIT file gives distance, altitude and moving time in metres and seconds", async () => {
  const pts = fitPts(await parseFit(walk(profile(), 1_800_000_000)));
  const last = pts[pts.length - 1];
  assert.ok(Math.abs(last.d - 5000) < 1, `${last.d}`);
  assert.ok(Math.abs(last.e! - 100) < 0.5, "back at the start altitude");
  assert.ok(Math.abs(Math.max(...pts.map((p) => p.e!)) - 200) < 0.5, "the climb is 100 m");
  const expected = workout().reduce((s, p) => s + p.time!, 0);
  assert.ok(Math.abs(last.t! - expected) / expected < 0.02, `${last.t} against ${expected}`);
});

test("fitPts: a pause longer than 30 s adds no time, a gap of exactly 30 s does", () => {
  const rec = (t: number, d: number) => ({ elapsed_time: t, distance: d / 1000, altitude: 0.1 });
  const thirty = fitPts({ records: [rec(0, 0), rec(30, 30), rec(60, 60)] });
  assert.equal(thirty[2].t, 60);
  const paused = fitPts({ records: [rec(0, 0), rec(30, 30), rec(31, 30), rec(500, 31), rec(501, 32)] });
  assert.deepEqual(paused.map((p) => p.t), [0, 30, 31, 31, 32], "the 469 s gap is a pause");
  assert.deepEqual(fitPts({ records: [{ elapsed_time: 0, distance: 0 }, rec(1, 1)] }).length, 1, "a record without altitude is skipped");
});

test("estimateRouteTime: personal model from three archived walks, per-kind splits and the latest start", async () => {
  const store = memoryArchiveStore();
  for (let i = 0; i < 3; i++) await archived(store, walk(profile(), 1_800_000_000 + i * 86_400), 1_800_000_000_000 + i * 86_400_000);
  await archived(store, walk(profile(), 1_700_000_000, 1), 1_700_000_000_000); // a run: not used for walking
  // 10 km route: 3 km flat, 3 km climbing 240 m (8 %), 4 km flat
  const gpx = gpxOf((i) => (i < 30 ? 100 : i < 60 ? 100 + (i - 30) * 8 : 340), 100);
  const client = clientOf(gpx);
  const r = await estimateRouteTime(client, store, { routeId: "r1", sunset: "2026-11-15T16:05:00+01:00", marginMinutes: 45 }, { now: new Date("2026-11-15T05:00:00Z") });
  assert.deepEqual(client.calls, ["r1"], "one request to Suunto, nothing else");
  assert.equal(r.basis, "personal");
  assert.deepEqual([r.model.status, r.model.workoutsUsed, r.model.workoutsConsidered, r.model.skipped.otherSport], ["ok", 3, 4, 1]);
  assert.ok(Math.abs(r.model.flatPaceSPerKm! - 800) < 40, `${r.model.flatPaceSPerKm}`);
  assert.ok(Math.abs(r.model.ascentSPerM! - 5) < 0.5, `${r.model.ascentSPerM}`);
  assert.equal(r.route.name, "Test route");
  assert.ok(r.route.ascentM > 230 && r.route.ascentM < 250, `${r.route.ascentM}`);
  const flat = r.route.distanceM * 0.8;
  assert.ok(Math.abs(r.estimate.totalTimeS - (flat + 5 * r.route.ascentM + 1 * r.route.descentM)) / r.estimate.totalTimeS < 0.05, `${r.estimate.totalTimeS}`);
  assert.deepEqual(r.estimate.splits.map((s) => s.kind), ["flat", "ascent", "flat"]);
  assert.equal(Math.abs(r.estimate.splits.reduce((s, x) => s + x.timeS, 0) - r.estimate.totalTimeS) <= 2, true);
  assert.match(r.estimate.totalTime, /^\d+ h \d\d min$|^\d+ min$/);
  const ls = r.latestStart!;
  assert.equal(Date.parse(ls.latestStartUtc), Date.parse("2026-11-15T16:05:00+01:00") - (45 * 60 + r.estimate.totalTimeS) * 1000);
  assert.match(ls.latestStart, /\+01:00$/);
  assert.ok(r.notes.every((x: string) => !/NOT your pace/.test(x)));
  assert.ok(r.assumptions.some((x: string) => /ESTIMATE|estimate/.test(x)) || r.notes.some((x: string) => /ESTIMATE/.test(x)));
  // the same archive for running: one run is not enough
  const running = await estimateRouteTime(clientOf(gpx), store, { routeId: "r1", activity: "running" });
  assert.equal(running.basis, "generic-naismith");
  assert.match(running.model.reason!, /only 1 usable/);
  assert.ok(running.notes.some((x: string) => /WALKING rule/.test(x)));
});

test("estimateRouteTime: an empty archive says insufficient and falls back to labelled Naismith (5 km/h + 1 h per 600 m)", async () => {
  const gpx = gpxOf((i) => 100 + i * 6, 100); // about 11.1 km, 600 m up
  const r = await estimateRouteTime(clientOf(gpx), memoryArchiveStore(), { routeId: "r" });
  assert.equal(r.basis, "generic-naismith");
  assert.equal(r.model.status, "insufficient");
  assert.deepEqual([r.model.workoutsUsed, r.model.workoutsConsidered], [0, 0]);
  assert.ok(Math.abs(r.estimate.totalTimeS - (GENERIC.flat * r.route.distanceM + GENERIC.up * r.route.ascentM)) <= 5, `${r.estimate.totalTimeS}`);
  assert.ok(r.notes.some((x: string) => /NOT your pace/.test(x)) && r.notes.some((x: string) => /archive_workouts first/.test(x)));
  assert.equal(r.latestStart, null);
});

test("estimateRouteTime: a route without altitude counts flat ground only, and says so", async () => {
  const r = await estimateRouteTime(clientOf(gpxOf(() => null, 50)), memoryArchiveStore(), { routeId: "r" });
  assert.equal(r.route.hasElevation, false);
  assert.deepEqual([r.route.ascentM, r.route.descentM], [0, 0]);
  assert.ok(Math.abs(r.estimate.totalTimeS - GENERIC.flat * r.route.distanceM) <= 2);
  assert.ok(r.notes.some((x: string) => /no altitude on every point/.test(x)));
});

test("estimateRouteTime: at most 40 archived files are looked at and the model stops at 25 usable ones", async () => {
  const reads: string[] = [];
  const inner = memoryArchiveStore();
  const store: ArchiveStore = { ...inner, readFit: async (k) => (reads.push(k), inner.readFit(k)) };
  const fit = walk(profile(), 1_800_000_000);
  for (let i = 0; i < 45; i++) await archived(inner, fit, 1_800_000_000_000 + i * 1000);
  const r = await estimateRouteTime(clientOf(gpxOf((i) => 100 + (i % 10), 20)), store, { routeId: "r" });
  assert.equal(MAX_USED, 25);
  assert.equal(r.model.workoutsUsed, 25);
  assert.equal(reads.length, 25);
  // unusable ones count against the 40-file limit
  reads.length = 0;
  const junk = memoryArchiveStore();
  const junkStore: ArchiveStore = { ...junk, readFit: async (k) => (reads.push(k), junk.readFit(k)) };
  for (let i = 0; i < 45; i++) await archived(junk, Buffer.from("not a fit"), 1_800_000_000_000 + i * 1000);
  const j = await estimateRouteTime(clientOf(gpxOf(() => 1, 20)), junkStore, { routeId: "r" });
  assert.equal(MAX_FILES, 40);
  assert.deepEqual([reads.length, j.model.workoutsConsidered, j.model.skipped.unreadable], [40, 40, 40]);
  assert.equal(new Set(reads).size, 40);
});

test("estimateRouteTime: refuses a bad sunset, a margin without a sunset, a route with fewer than 2 points, before reading the archive", async () => {
  const store = memoryArchiveStore();
  let scans = 0;
  const spy: ArchiveStore = { ...store, scan: async () => (scans++, store.scan()) };
  const ok = clientOf(gpxOf(() => 1, 5));
  await assert.rejects(estimateRouteTime(ok, spy, { routeId: "r", sunset: "tomorrow" }), /UTC offset/);
  await assert.rejects(estimateRouteTime(ok, spy, { routeId: "r", marginMinutes: 10 }), /only applies together with sunset/);
  await assert.rejects(estimateRouteTime(ok, spy, { routeId: "r", activity: "cycling" as any }), /walking" or "running/);
  assert.equal(ok.calls.length, 0, "nothing was requested");
  await assert.rejects(estimateRouteTime(clientOf(Buffer.from('<gpx><rte><rtept lat="1" lon="1"/></rte></gpx>')), spy, { routeId: "r" }), /fewer than 2 track points/);
  assert.equal(scans, 0);
});

test("archive store readFit: returns the stored file, refuses a key that is not archived or not a key", async () => {
  const store = memoryArchiveStore();
  const key = await archived(store, Buffer.from("abc"), 1);
  assert.equal((await store.readFit(key)).toString(), "abc");
  await assert.rejects(store.readFit("0".repeat(24)), /is not archived/);
  const { fileArchiveStore } = await import("./archive.js");
  await assert.rejects(fileArchiveStore("/nonexistent-dir-for-test").readFit("../etc/passwd"), /is not a workout key/);
});
