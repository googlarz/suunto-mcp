import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { memoryArchiveStore } from "./archive.js";
import { buildDemoFit } from "./demo-fit.js";
import { MAX_IMPORT_BYTES, normSport, parseWorkout } from "./import-parse.js";
import { fileImportStore, importDir, importStatus, importWorkouts, importedSource, memoryImportStore } from "./import.js";
import { estimateRouteTime } from "./route-time.js";

const { buildFit } = (await import(new URL("../test-fixtures/fit-builder.mjs", import.meta.url).href)) as { buildFit: (o: any) => Buffer };

const NOW = new Date("2026-11-17T12:00:00Z");
const T0 = Date.parse("2026-10-01T07:00:00Z") / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---------- synthetic files ----------

interface P { lat: number | string; lon: number | string; ele?: number; t?: number | string; hr?: number }
// 61 points, one every 5 s, 0.0001 degrees of latitude (11.12 m) apart: 300 s, about 667 m
const track = (o: { n?: number; t0?: number; stepS?: number; dLat?: number; ele?: (i: number) => number; hr?: (i: number) => number; lat0?: number } = {}): P[] =>
  Array.from({ length: (o.n ?? 60) + 1 }, (_, i) => ({ lat: (o.lat0 ?? 52) + i * (o.dLat ?? 0.0001), lon: 13.4, t: (o.t0 ?? T0) + i * (o.stepS ?? 5), ...(o.ele ? { ele: o.ele(i) } : {}), ...(o.hr ? { hr: o.hr(i) } : {}) }));
const timeOf = (t: number | string | undefined, tag = "time") => (t === undefined ? "" : `<${tag}>${typeof t === "number" ? iso(t) : t}</${tag}>`);
const gpx = (pts: P[], type?: string, head = ""): Buffer =>
  Buffer.from(`<?xml version="1.0"?>${head}<gpx version="1.1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk>${type ? `<type>${type}</type>` : ""}<trkseg>${pts
    .map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele !== undefined ? `<ele>${p.ele}</ele>` : ""}${timeOf(p.t)}${p.hr !== undefined ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>` : ""}</trkpt>`)
    .join("")}</trkseg></trk></gpx>`);
const tcx = (pts: (P & { dist?: number })[], sport = "Running"): Buffer =>
  Buffer.from(`<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="${sport}"><Id>x</Id><Lap StartTime="${iso(T0)}"><TotalTimeSeconds>300</TotalTimeSeconds><Track>${pts
    .map((p) => `<Trackpoint>${timeOf(p.t, "Time")}<Position><LatitudeDegrees>${p.lat}</LatitudeDegrees><LongitudeDegrees>${p.lon}</LongitudeDegrees></Position>${p.ele !== undefined ? `<AltitudeMeters>${p.ele}</AltitudeMeters>` : ""}${p.dist !== undefined ? `<DistanceMeters>${p.dist}</DistanceMeters>` : ""}${p.hr !== undefined ? `<HeartRateBpm><Value>${p.hr}</Value></HeartRateBpm>` : ""}</Trackpoint>`)
    .join("")}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`);
const demoFit = (start = T0, elapsedS = 1800): Buffer => buildDemoFit({ records: [{ unixS: start, hr: 120 }, { unixS: start + elapsedS, hr: 160 }], startUnixS: start, elapsedS, sport: 1, subSport: 0, calories: 300, avgHr: 150, maxHr: 175, distanceM: 5000 });

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-import-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function folder(dir: string, files: Record<string, Buffer | string>, name = "in"): Promise<string> {
  const d = join(dir, name);
  await mkdir(d, { recursive: true });
  for (const [n, b] of Object.entries(files)) await writeFile(join(d, n), b);
  return d;
}
const mode = async (p: string) => (await stat(p)).mode & 0o777;
const ls = async (dir: string) => (await readdir(dir)).sort();

// ---------- the readers ----------

test("GPX: start, duration, distance, heart rate (gpxtpx), ascent, sport and GPS are read; a hill adds ascent in 3 m steps", async () => {
  const w = await parseWorkout(gpx(track({ ele: (i) => 100 + i * 0.5, hr: (i) => 100 + i }), "running"), "gpx", NOW);
  assert.equal(w.summary.startTime, iso(T0));
  assert.equal(w.summary.durationS, 300);
  assert.ok(Math.abs(w.summary.distanceM - 667) <= 1, `${w.summary.distanceM}`);
  assert.deepEqual([w.summary.avgHr, w.summary.maxHr, w.summary.ascentM, w.summary.sport, w.summary.hasGps], [130, 160, 30, "running", true]);
  assert.equal(w.pts.length, 61);
  assert.ok(Math.abs(w.pts[60].e! - 130) < 1e-9 && w.pts[60].t === 300);
  const bare = (await parseWorkout(gpx(track()), "gpx", NOW)).summary;
  assert.deepEqual([bare.avgHr, bare.maxHr, bare.ascentM, bare.sport], [undefined, undefined, undefined, undefined]);
  assert.deepEqual((await parseWorkout(gpx(track(), "Hiking Trip"), "gpx", NOW)).summary.sport, "hiking");
});

test("TCX: the distance the file gives is used instead of the positions; heart rate, sport attribute and altitude are read", async () => {
  const pts = track({ ele: (i) => 50 + (i % 2) * 5, hr: (i) => 140 + (i % 3) }).map((p, i) => ({ ...p, dist: i * 10 }));
  const w = await parseWorkout(tcx(pts, "Biking"), "tcx", NOW);
  assert.deepEqual([w.summary.distanceM, w.summary.durationS, w.summary.sport, w.summary.hasGps, w.summary.maxHr], [600, 300, "cycling", true, 142]);
  assert.equal(w.pts[60].d, 600);
  // an indoor file: no positions at all, the distance still counts
  const indoor = await parseWorkout(tcx(pts.map(({ lat, lon, ...p }) => ({ ...p, lat: "", lon: "" })), "Other"), "tcx", NOW);
  assert.deepEqual([indoor.summary.hasGps, indoor.summary.distanceM, indoor.summary.sport], [false, 600, undefined]);
});

test("FIT: the session gives start, elapsed time, distance and heart rate; without a session the records do; positions in semicircles are read as degrees", async () => {
  const w = await parseWorkout(demoFit(), "fit", NOW);
  assert.deepEqual(w.summary, { startTime: iso(T0), durationS: 1800, distanceM: 5000, avgHr: 150, maxHr: 175, sport: "running", hasGps: false });
  const motion = await parseWorkout(buildFit({ records: Array.from({ length: 30 }, (_, i) => ({ unixS: T0 + i * 10, hr: 130 + i, distanceM: i * 12, altitudeM: 100 + i })), sessionStartUnixS: T0, sport: 17 }), "fit", NOW);
  assert.deepEqual([motion.summary.startTime, motion.summary.durationS, motion.summary.distanceM, motion.summary.maxHr, motion.summary.sport], [iso(T0), 290, 348, 159, "hiking"]);
  assert.equal(motion.pts.length, 30);
});

test("FIT positions are semicircles in the file: the reader turns them into degrees (distance and GPS agree with the same track as GPX), south and west included", async () => {
  const fit = (lat0: number, lon0: number) => buildFit({ records: Array.from({ length: 30 }, (_, i) => ({ unixS: T0 + i * 5, hr: 120, latDeg: lat0 + Math.sign(lat0) * i * 0.0001, lonDeg: lon0 })), sessionStartUnixS: T0, sport: 1 });
  for (const [lat, lon] of [[52, 13.4], [-33.9, -70.6]]) {
    const w = await parseWorkout(fit(lat, lon), "fit", NOW);
    assert.ok(Math.abs(w.summary.distanceM - 322) <= 1, `${lat}: ${w.summary.distanceM}`); // 29 steps of 11.12 m
    assert.deepEqual([w.summary.hasGps, w.summary.durationS, w.summary.droppedJumps], [true, 145, undefined]);
  }
  const same = await parseWorkout(gpx(track({ n: 29 })), "gpx", NOW);
  assert.equal(same.summary.distanceM, (await parseWorkout(fit(52, 13.4), "fit", NOW)).summary.distanceM);
});

test("normSport: running, walking, hiking, cycling and swimming are named the way estimate_route_time reads them; 'other' says nothing", () => {
  assert.deepEqual(["Trail Running", "walking", "HIKING", "e_bike_fitness", "Biking", "open_water_swimming", "Other", "9", "yoga", ""].map(normSport), ["running", "walking", "hiking", "cycling", "cycling", "swimming", undefined, undefined, "yoga", undefined]);
});

test("a GPS jump faster than 12 m/s is dropped, its distance is not counted, and a fast mover is not dropped to the end of the file (cycling: 30 m/s)", async () => {
  const pts = track();
  pts[30] = { ...pts[30], lat: 53.5 }; // 166 km away for one second
  const w = await parseWorkout(gpx(pts), "gpx", NOW);
  assert.ok(Math.abs(w.summary.distanceM - 667) <= 2, `${w.summary.distanceM}`);
  // 15 m/s: too fast for a runner (dropped, but the file recovers after 3 in a row), fine for a cyclist
  const fast = track({ dLat: 0.000675 }); // 75 m every 5 s
  const cyclist = (await parseWorkout(gpx(fast, "cycling"), "gpx", NOW)).summary;
  const runner = (await parseWorkout(gpx(fast, "running"), "gpx", NOW)).summary;
  assert.ok(cyclist.distanceM >= 4400, `${cyclist.distanceM}`);
  assert.ok(runner.distanceM < 1000 && runner.hasGps, `${runner.distanceM}`);
});

test("a file that names no sport gets the 30 m/s jump limit (it may be a bike ride) and says how many positions were dropped; a typed run is held to 12 m/s", async () => {
  const fast = track({ dLat: 0.000675 }); // 15 m/s
  const untyped = (await parseWorkout(gpx(fast), "gpx", NOW)).summary;
  assert.ok(untyped.distanceM >= 4400 && untyped.droppedJumps === undefined, JSON.stringify(untyped));
  const run = (await parseWorkout(gpx(fast, "running"), "gpx", NOW)).summary;
  assert.ok(run.droppedJumps! >= 45, `${run.droppedJumps}`);
  const glitch = track();
  glitch[30] = { ...glitch[30], lat: 53.5 };
  assert.equal((await parseWorkout(gpx(glitch), "gpx", NOW)).summary.droppedJumps, 1);
});

test("the sport of a GPX file is the first track's <type>, not a waypoint's", async () => {
  const sport = async (xml: string) => (await parseWorkout(Buffer.from(xml), "gpx", NOW)).summary.sport;
  const untyped = gpx(track()).toString();
  assert.equal(await sport(untyped.replace("<trk>", `<wpt lat="1" lon="2"><type>cycling</type></wpt><trk>`)), undefined);
  assert.equal(await sport(untyped.replace("<trk>", `<wpt lat="1" lon="2"><type>cycling</type></wpt><trk><type>hiking</type>`)), "hiking");
  assert.equal(await sport(untyped.replace("<trkseg>", `<trkseg><extensions><type>running</type></extensions>`)), undefined, "inside the segments is not the track's type");
});

test("bad points are dropped, not guessed: a latitude of 95, a time without a zone, a time before the one before it", async () => {
  const pts = track({ n: 4 });
  pts[1] = { ...pts[1], lat: 95 };
  pts[2] = { ...pts[2], t: "2026-10-01T07:00:10" };
  pts[3] = { ...pts[3], t: T0 - 100 };
  const w = await parseWorkout(gpx(pts), "gpx", NOW);
  assert.deepEqual([w.summary.durationS, w.summary.hasGps], [20, true]); // points 0, 1 (no position) and 4 are left
});

// ---------- what is refused ----------

const refusal = (bytes: Buffer, ext: "fit" | "gpx" | "tcx"): Promise<string> =>
  withTmp(async (dir) => {
    const r = await importWorkouts(memoryImportStore(), { path: await folder(dir, { [`f.${ext}`]: bytes }) }, NOW);
    assert.equal(r.newlyImported, 0, JSON.stringify(r.imported));
    assert.equal(r.refused.length, 1, JSON.stringify(r));
    return r.refused[0].reason;
  });

test("refused with a reason, nothing written: bytes that are not FIT (no hang), a truncated FIT, a FIT body of garbage, empty, XML in a .fit", async () => {
  await withTmp(async (dir) => {
    const store = fileImportStore(join(dir, "store"));
    const good = demoFit();
    const garbage = Buffer.from(buildFit({ records: [{ unixS: T0, hr: 100 }], sessionStartUnixS: T0 }));
    garbage.fill(0x00, 14, garbage.length - 2);
    const inDir = await folder(dir, { "a-random.fit": randomBytes(5000), "b-text.fit": Buffer.from("x".repeat(100)), "c-cut.fit": good.subarray(0, good.length - 5), "d-garbage.fit": garbage, "e-empty.fit": Buffer.alloc(0), "f-xml.fit": gpx(track()) });
    const started = Date.now();
    const r = await importWorkouts(store, { path: inDir }, NOW);
    assert.ok(Date.now() - started < 10_000, "no file made the parser spin");
    assert.equal(r.newlyImported, 0);
    const why = Object.fromEntries(r.refused.map((x) => [x.file, x.reason]));
    assert.match(why["a-random.fit"], /not a complete FIT file \(not a FIT file/);
    assert.match(why["b-text.fit"], /not a FIT file/);
    assert.match(why["c-cut.fit"], /truncated/);
    assert.match(why["d-garbage.fit"], /not a readable FIT file/);
    assert.match(why["e-empty.fit"], /empty/);
    assert.match(why["f-xml.fit"], /not a FIT file/);
    await assert.rejects(stat(join(dir, "store")), /ENOENT/, "nothing was written, not even the folder");
  });
});

test("refused: GPX and TCX that are not what they say, have too few points, bad times or declare entities", async () => {
  assert.match(await refusal(Buffer.from("<html><body>hi</body></html>"), "gpx"), /not a GPX file/);
  assert.match(await refusal(Buffer.from("<gpx></gpx>"), "gpx"), /fewer than 2 track points/);
  assert.match(await refusal(gpx(track({ n: 0 })), "gpx"), /fewer than 2 track points/);
  assert.match(await refusal(gpx(track().map(({ t, ...p }) => p)), "gpx"), /fewer than 2 points with a valid timestamp/);
  assert.match(await refusal(gpx(track().map((p, i) => ({ ...p, t: `2026-10-01T07:00:${String(i % 60).padStart(2, "0")}` }))), "gpx"), /valid timestamp/, "no zone");
  assert.match(await refusal(gpx(track({ t0: Date.parse("1970-01-02T00:00:00Z") / 1000 })), "gpx"), /valid timestamp/, "before 1990");
  assert.match(await refusal(gpx(track({ t0: NOW.getTime() / 1000 + 3 * 86_400 })), "gpx"), /valid timestamp/, "in the future");
  assert.match(await refusal(gpx(track().map((p, i) => ({ ...p, lat: i === 0 ? 40 : 95 }))), "gpx"), /fewer than 2 valid GPS points/);
  assert.match(await refusal(gpx(track().map((p) => ({ ...p, t: T0 }))), "gpx"), /no elapsed time/);
  assert.match(await refusal(gpx(track(), undefined, `<!DOCTYPE gpx [<!ENTITY a "aaaa">]>`), "gpx"), /entities/);
  assert.match(await refusal(Buffer.from("<gpx>"), "tcx"), /not a TCX file/);
  assert.match(await refusal(Buffer.from("<TrainingCenterDatabase></TrainingCenterDatabase>"), "tcx"), /fewer than 2 points/);
});

test("hostile XML: unclosed elements by the million are refused quickly (the scan never goes back)", async () => {
  const started = Date.now();
  assert.match(await refusal(Buffer.from(`<gpx>${"<trkpt ".repeat(300_000)}`), "gpx"), /fewer than 2 track points/);
  assert.match(await refusal(Buffer.from(`<gpx>${"<trkpt>".repeat(300_000)}`), "gpx"), /fewer than 2 track points/);
  assert.match(await refusal(Buffer.from(`<TrainingCenterDatabase>${"<Trackpoint>".repeat(300_000)}`), "tcx"), /fewer than 2 points/);
  assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
});

test("a file over 50 MB is refused without being read; a file of exactly that size is read", async () => {
  await withTmp(async (dir) => {
    const d = await folder(dir, {});
    await writeFile(join(d, "big.gpx"), "");
    await truncate(join(d, "big.gpx"), MAX_IMPORT_BYTES + 1); // sparse: nothing is written to disk
    const r = await importWorkouts(memoryImportStore(), { path: d }, NOW);
    assert.match(r.refused[0].reason, /larger than 50 MB; not read/);
    await truncate(join(d, "big.gpx"), MAX_IMPORT_BYTES);
    const at = await importWorkouts(memoryImportStore(), { path: d }, NOW);
    assert.match(at.refused[0].reason, /not a GPX file/, "it was read, and it is zeros");
  });
});

// ---------- the store ----------

test("import: files are stored byte for byte with a record, 0600 in a 0700 folder, the record last; the status counts them per source", async () => {
  await withTmp(async (dir) => {
    const store = fileImportStore(join(dir, "imported"));
    const a = gpx(track({ ele: (i) => 100 + i, hr: (i) => 120 + i }), "running");
    const b = tcx(track({ t0: T0 + 86_400 }).map((p, i) => ({ ...p, dist: i * 11 })));
    const c = demoFit(T0 + 2 * 86_400);
    const inDir = await folder(dir, { "run.gpx": a, "ride.tcx": b, "x.fit": c, "notes.txt": "hello", ".DS_Store": "", "._x.fit": "junk", "old.fit.gz": "gz" });
    await mkdir(join(inDir, "sub"));
    await writeFile(join(inDir, "sub", "deep.gpx"), a);
    const r = await importWorkouts(store, { path: inDir, source: "garmin" }, NOW);
    assert.deepEqual([r.found, r.newlyImported, r.remaining, r.refused, r.errors], [3, 3, 0, [], []]);
    assert.deepEqual(r.ignored, { otherTypes: 1, subfolders: 1, links: 0, hidden: 2, gzipped: 1 });
    const idA = sha(a).slice(0, 16);
    assert.deepEqual(await ls(join(dir, "imported")), [`${idA}.gpx`, `${idA}.json`, `${sha(b).slice(0, 16)}.json`, `${sha(b).slice(0, 16)}.tcx`, `${sha(c).slice(0, 16)}.fit`, `${sha(c).slice(0, 16)}.json`].sort());
    assert.ok((await readFile(join(dir, "imported", `${idA}.gpx`))).equals(a), "the file as given");
    const rec = JSON.parse(await readFile(join(dir, "imported", `${idA}.json`), "utf8"));
    assert.deepEqual([rec.version, rec.source, rec.format, rec.sha256, rec.bytes, rec.importedAt, rec.summary.sport, rec.summary.hasGps], [1, "garmin", "gpx", sha(a), a.length, NOW.toISOString(), "running", true]);
    assert.equal(await mode(join(dir, "imported")), 0o700);
    for (const f of await readdir(join(dir, "imported"))) assert.equal(await mode(join(dir, "imported", f)), 0o600, f);
    const st = await importStatus(store);
    assert.deepEqual([st.imported, st.bySource, st.oldest, st.newest, st.problems, st.incomplete, st.otherFiles], [3, { garmin: 3 }, "2026-10-01", "2026-10-03", [], [], 0]);
    assert.equal(st.bytes, a.length + b.length + c.length);
    assert.equal(st.dir, join(dir, "imported"));
  });
});

test("an existing folder keeps its mode; reading the status does not create a missing folder", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "imported");
    assert.equal((await importStatus(fileImportStore(target))).imported, 0);
    await assert.rejects(stat(target), /ENOENT/);
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await importWorkouts(fileImportStore(target), { path: await folder(dir, { "a.gpx": gpx(track()) }) }, NOW);
    assert.equal(await mode(target), 0o755);
  });
});

test("the same file again is skipped, by content and whatever its name; a single file path works; a folder of one file twice imports it once", async () => {
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    const a = gpx(track());
    const inDir = await folder(dir, { "a.gpx": a, "b-copy.gpx": a });
    const first = await importWorkouts(store, { path: inDir }, NOW);
    assert.deepEqual([first.newlyImported, first.alreadyImported.map((x) => x.file)], [1, ["b-copy.gpx"]]);
    const again = await importWorkouts(store, { path: join(inDir, "a.gpx"), source: "strava" }, NOW);
    assert.deepEqual([again.newlyImported, again.alreadyImported.length, again.found], [0, 1, 1]);
    assert.equal((await importStatus(store)).bySource.other, 1, "the first label stays");
  });
});

test("possibleDuplicate: the same activity from another system (start within 60 s, duration within 5 %) is not imported; one second or one percent beyond is", async () => {
  const base = gpx(track());
  const variant = (startShift: number, n: number) =>
    withTmp(async (dir) => {
      const store = memoryImportStore();
      await importWorkouts(store, { path: await folder(dir, { "a.gpx": base }, "first") }, NOW);
      return importWorkouts(store, { path: await folder(dir, { "b.gpx": gpx(track({ t0: T0 + startShift, n, dLat: 0.00012 })) }, "second") }, NOW);
    });
  const dup = await variant(60, 63); // 315 s: 15 s apart, the limit is 5 % of 315 = 15.75 s
  assert.deepEqual([dup.newlyImported, dup.possibleDuplicate.map((x) => x.file), dup.possibleDuplicate[0].startTime], [0, ["b.gpx"], iso(T0 + 60)]);
  assert.equal(dup.possibleDuplicate[0].sameAs.length, 16);
  assert.equal((await variant(61, 60)).newlyImported, 1, "61 s apart");
  assert.equal((await variant(0, 66)).newlyImported, 1, "330 s against 300 s");
  assert.equal((await variant(-60, 57)).possibleDuplicate.length, 1, "285 s against 300 s, starting a minute before");
});

test("a call reads at most 200 files (refused ones count), lists show 50 entries with the totals beside them, and `after` moves a repeat call on", async () => {
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    const inDir = await folder(dir, Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`f${String(i).padStart(3, "0")}.gpx`, `junk ${i}`])));
    const one = await importWorkouts(store, { path: inDir }, NOW);
    assert.deepEqual([one.found, one.examined, one.refusedCount, one.refused.length, one.remaining, one.nextAfter], [250, 200, 200, 50, 50, "f199.gpx"]);
    assert.ok(one.notes.some((n) => /call again with after: "f199.gpx"/.test(n)));
    assert.ok(one.notes.some((n) => /first 50 entries only/.test(n)));
    assert.equal((await importWorkouts(store, { path: inDir }, NOW)).nextAfter, "f199.gpx", "without `after` the same files are read again");
    const two = await importWorkouts(store, { path: inDir, after: one.nextAfter! }, NOW);
    assert.deepEqual([two.examined, two.refusedCount, two.remaining, two.nextAfter], [50, 50, 0, null]);
    await assert.rejects(importWorkouts(store, { path: inDir, after: 5 as any }, NOW), /after must be a file name/);
  });
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    const inDir = await folder(dir, Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`v${String(i).padStart(2, "0")}.gpx`, gpx(track({ t0: T0 + i * 7200 }))])));
    const a = await importWorkouts(store, { path: inDir }, NOW);
    assert.deepEqual([a.newlyImported, a.imported.length, a.remaining, a.nextAfter], [50, 50, 10, "v49.gpx"]);
    const b = await importWorkouts(store, { path: inDir, after: a.nextAfter! }, NOW);
    assert.deepEqual([b.newlyImported, b.remaining], [10, 0]);
    const c = await importWorkouts(store, { path: inDir }, NOW);
    assert.deepEqual([c.newlyImported, c.alreadyImportedCount, c.alreadyImported.length], [0, 60, 50]);
  });
});

test("the result says when workouts are stored with no sport (estimate_route_time ignores them) and what a demo-mode store does", async () => {
  await withTmp(async (dir) => {
    const r = await importWorkouts(memoryImportStore(), { path: await folder(dir, { "a.gpx": gpx(track()), "b.gpx": gpx(track({ t0: T0 + 86_400 }), "running") }) }, NOW);
    assert.equal(r.newlyImported, 2);
    assert.ok(r.notes.some((n) => /^1 imported workout\(s\) name no sport .*walking, hiking or running/.test(n)), r.notes.join("\n"));
    assert.match(r.notes[r.notes.length - 1], /^Nothing was written to disk \(demo mode/);
    await mkdir(join(dir, "s"));
    const disk = await importWorkouts(fileImportStore(join(dir, "s", "imp")), { path: await folder(dir, { "c.gpx": gpx(track({ t0: T0 + 9 * 86_400 })) }, "in2") }, NOW);
    assert.match(disk.notes[disk.notes.length - 1], /^Only new files were written, in the imports folder/);
  });
});

test("a FIFO in the folder is not opened (it would block): it is ignored and counted", { skip: process.platform === "win32" }, async () => {
  await withTmp(async (dir) => {
    const inDir = await folder(dir, { "a.gpx": gpx(track()) });
    execFileSync("mkfifo", [join(inDir, "pipe.gpx")]);
    const r = await importWorkouts(memoryImportStore(), { path: inDir }, NOW);
    assert.deepEqual([r.found, r.newlyImported, r.ignored.otherTypes], [1, 1, 1]);
  });
});

test("limit and remaining: at most `limit` new workouts per call, then the rest; already imported files do not use up the limit", async () => {
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    const files = Object.fromEntries([0, 1, 2].map((i) => [`w${i}.gpx`, gpx(track({ t0: T0 + i * 86_400 }))]));
    const inDir = await folder(dir, files);
    const one = await importWorkouts(store, { path: inDir, limit: 2 }, NOW);
    assert.deepEqual([one.newlyImported, one.remaining, one.notes[0].includes("call again")], [2, 1, true]);
    const two = await importWorkouts(store, { path: inDir, limit: 2 }, NOW);
    assert.deepEqual([two.newlyImported, two.alreadyImported.length, two.remaining], [1, 2, 0]);
    for (const limit of [0, 51, 1.5]) await assert.rejects(importWorkouts(store, { path: inDir, limit }, NOW), /limit must be a whole number from 1 to 50/);
  });
});

test("bad calls: a relative path, a missing path, a wrong extension, an unknown source", async () => {
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    await assert.rejects(importWorkouts(store, { path: "relative/dir" }, NOW), /absolute path/);
    await assert.rejects(importWorkouts(store, { path: "" }, NOW), /absolute path/);
    await assert.rejects(importWorkouts(store, { path: join(dir, "nope") }, NOW), /does not exist/);
    await assert.rejects(importWorkouts(store, { path: await folder(dir, { "a.txt": "x" }) + "/a.txt" }, NOW), /not a \.fit, \.gpx or \.tcx file/);
    await assert.rejects(importWorkouts(store, { path: dir, source: "polar" }, NOW), /source must be one of garmin, strava, apple, other/);
  });
});

test("links are never followed: a link to a file or a folder outside the given folder is not read; a path with .. is read as written", async () => {
  await withTmp(async (dir) => {
    const outside = await folder(dir, { "secret.gpx": gpx(track()), "other.gpx": gpx(track({ t0: T0 + 86_400 })) }, "outside");
    const inDir = await folder(dir, { "mine.gpx": gpx(track({ t0: T0 + 5 * 86_400 })) });
    await symlink(join(outside, "secret.gpx"), join(inDir, "link.gpx"));
    await symlink(outside, join(inDir, "linked-folder"));
    const store = memoryImportStore();
    const r = await importWorkouts(store, { path: inDir }, NOW);
    assert.deepEqual([r.found, r.newlyImported, r.ignored.links, r.imported.map((x) => x.file)], [1, 1, 2, ["mine.gpx"]]);
    // the named folder itself may be a link: the user named it
    await symlink(inDir, join(dir, "named-link"));
    const viaLink = await importWorkouts(memoryImportStore(), { path: join(dir, "named-link") }, NOW);
    assert.deepEqual([viaLink.found, viaLink.ignored.links], [1, 2]);
    const dots = await importWorkouts(memoryImportStore(), { path: join(inDir, "..", "outside") }, NOW);
    assert.equal(dots.found, 2);
  });
});

test("a record that is damaged, foreign or newer is never touched and a file that matches it is refused; a missing file is a problem too", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "imported");
    await mkdir(target);
    const files = [0, 1, 2, 3].map((i) => gpx(track({ t0: T0 + i * 86_400 })));
    const id = (i: number) => sha(files[i]).slice(0, 16);
    const summary = (await parseWorkout(files[0], "gpx", NOW)).summary;
    const rec = (i: number, over: object = {}) => JSON.stringify({ version: 1, source: "other", format: "gpx", sha256: sha(files[i]), bytes: files[i].length, importedAt: NOW.toISOString(), summary, ...over });
    // newer version, not JSON, a field this server does not know, and a valid record whose file is missing
    const written: Record<string, string> = { [`${id(0)}.json`]: rec(0, { version: 2 }), [`${id(1)}.json`]: "not json {", [`${id(2)}.json`]: rec(2, { extra: 1 }), [`${id(3)}.json`]: rec(3) };
    for (const [name, body] of Object.entries(written)) await writeFile(join(target, name), body);
    const store = fileImportStore(target);
    const st = await importStatus(store);
    assert.equal(st.imported, 0);
    assert.equal(st.problems.length, 4);
    assert.match(st.problems.find((p) => p.id === id(0))!.problem, /version 2, but this server reads and writes version 1 only\); left untouched/);
    assert.match(st.problems.find((p) => p.id === id(1))!.problem, /not a valid import record/);
    assert.match(st.problems.find((p) => p.id === id(2))!.problem, /is not a known field/);
    assert.match(st.problems.find((p) => p.id === id(3))!.problem, /\.gpx is missing/);
    const inDir = await folder(dir, Object.fromEntries(files.map((f, i) => [`w${i}.gpx`, f])));
    const r = await importWorkouts(store, { path: inDir }, NOW);
    assert.equal(r.newlyImported, 0);
    assert.equal(r.refused.length, 4);
    assert.ok(r.refused.every((x) => /damaged, foreign or of another version/.test(x.reason)));
    for (const [name, body] of Object.entries(written)) assert.equal(await readFile(join(target, name), "utf8"), body, `${name} untouched`);
    assert.deepEqual(await ls(target), Object.keys(written).sort(), "no data file was written next to a refused record");
  });
});

test("an interrupted import: an identical data file with no record is completed; a different one is left alone and reported", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "imported");
    await mkdir(target);
    const a = gpx(track());
    const b = gpx(track({ t0: T0 + 86_400 }));
    await writeFile(join(target, `${sha(a).slice(0, 16)}.gpx`), a);
    await writeFile(join(target, `${sha(b).slice(0, 16)}.gpx`), "somebody else's file");
    const store = fileImportStore(target);
    const st = await importStatus(store);
    assert.deepEqual([st.imported, st.incomplete.length], [0, 2]);
    const r = await importWorkouts(store, { path: await folder(dir, { "a.gpx": a, "b.gpx": b }) }, NOW);
    assert.deepEqual([r.newlyImported, r.errors.length, r.errors[0].file], [1, 1, "b.gpx"]);
    assert.match(r.errors[0].error, /already exists and differs; left untouched/);
    assert.equal(await readFile(join(target, `${sha(b).slice(0, 16)}.gpx`), "utf8"), "somebody else's file");
    assert.deepEqual((await importStatus(store)).imported, 1);
  });
});

test("the folder: SUUNTO_IMPORT_DIR moves it; demo mode's store keeps everything in memory and reports dir null", async () => {
  const before = process.env.SUUNTO_IMPORT_DIR;
  try {
    process.env.SUUNTO_IMPORT_DIR = "/somewhere/else";
    assert.equal(importDir(), "/somewhere/else");
    delete process.env.SUUNTO_IMPORT_DIR;
    assert.match(importDir(), /\.suunto-mcp\/imported$/);
  } finally {
    if (before === undefined) delete process.env.SUUNTO_IMPORT_DIR;
    else process.env.SUUNTO_IMPORT_DIR = before;
  }
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    const r = await importWorkouts(store, { path: await folder(dir, { "a.gpx": gpx(track()) }) }, NOW);
    assert.deepEqual([r.dir, r.newlyImported], [null, 1]);
    assert.deepEqual(await ls(dir), ["in"], "nothing written next to the input");
    const st = await importStatus(store);
    assert.deepEqual([st.dir, st.imported], [null, 1]);
  });
});

// ---------- estimate_route_time ----------

// A walk with the time model of route-time.test.ts: 0.8 s per metre flat, +5 s per metre climbed, +1 s per metre descended.
const piece = (dEle: number) => 100 * 0.8 + (dEle > 1 ? 5 * dEle : 0) + (dEle < -1 ? -dEle : 0);
const profile = [...Array(20).fill(10), ...Array(20).fill(-10), ...Array(10).fill(0)] as number[];
function walkPts(startS: number, shift = 0): P[] {
  const pts: P[] = [];
  let t = startS;
  let alt = 100;
  let i = 0;
  pts.push({ lat: 52 + shift, lon: 13.4, ele: alt, t });
  for (const d of profile) {
    for (let k = 0; k < 10; k++) {
      t += piece(d) / 10;
      alt += d / 10;
      pts.push({ lat: 52 + shift + ++i * 0.00009, lon: 13.4, ele: +alt.toFixed(3), t: Math.round(t) });
    }
  }
  return pts;
}
const routeGpx = (): Buffer => Buffer.from(`<gpx><rte><name>Test route</name>${Array.from({ length: 101 }, (_, i) => `<rtept lat="${(52 + i * 0.0009).toFixed(5)}" lon="13.4"><ele>${100 + Math.min(i, 30) * 8}</ele></rtept>`).join("")}</rte></gpx>`);
const clientOf = (): Pick<SuuntoClient, "exportRoute"> => ({ exportRoute: async () => routeGpx() });

test("estimate_route_time: imported workouts alone give a personal estimate, and model.sources says where it came from", async () => {
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    const inDir = await folder(dir, {
      "a.gpx": gpx(walkPts(T0), "hiking"),
      "b.gpx": gpx(walkPts(T0 + 86_400), "walking"),
      "c.tcx": tcx(walkPts(T0 + 2 * 86_400), "Other"), // no sport: not used
      "d.gpx": gpx(walkPts(T0 + 3 * 86_400), "running"), // another activity: not used for walking
      "e.fit": buildFit({ records: Array.from({ length: 501 }, (_, i) => ({ unixS: T0 + 4 * 86_400 + Math.round((i * piece(0)) / 10), hr: 120, distanceM: i * 10, altitudeM: 100 })), sessionStartUnixS: T0 + 4 * 86_400, sport: 11 }),
    });
    const r = await importWorkouts(store, { path: inDir, source: "garmin" }, NOW);
    assert.equal(r.newlyImported, 5, JSON.stringify(r.refused));
    const est = await estimateRouteTime(clientOf(), memoryArchiveStore(), { routeId: "r" }, { imported: await importedSource(store), now: NOW });
    assert.equal(est.basis, "personal", JSON.stringify(est.model));
    assert.deepEqual(est.model.sources, {
      suuntoArchive: 0,
      imported: 3,
      importedBySource: { garmin: 3 },
      importedSkipped: { otherSport: 2, noMotionData: 0, unreadable: 0, duplicateOfArchive: 0 },
    });
    assert.equal(est.model.workoutsConsidered, 0, "the existing field still counts the archive only");
    assert.ok(Math.abs(est.model.flatPaceSPerKm! - 800) < 25, `${est.model.flatPaceSPerKm}`);
    assert.ok(est.notes.some((n) => /workouts from other systems as well as your Suunto archive/.test(n)));
    assert.ok(!est.notes.some((n) => /archive is empty/.test(n)), "imports count as data");
    // the running workout is the one that counts for activity running
    const running = await estimateRouteTime(clientOf(), memoryArchiveStore(), { routeId: "r", activity: "running" }, { imported: await importedSource(store), now: NOW });
    assert.equal(running.model.sources.imported, 1);
  });
});

test("estimate_route_time: the Suunto archive comes first, an imported workout that starts within a minute of an archived one is not counted twice, and without imports nothing changes", async () => {
  await withTmp(async (dir) => {
    const store = memoryImportStore();
    const archive = memoryArchiveStore();
    const starts = [0, 1, 2].map((i) => T0 + i * 86_400);
    for (const [i, s] of starts.entries()) {
      const key = (i + 1).toString(16).padStart(24, "0");
      const records = walkPts(s).map((p, k) => ({ unixS: p.t as number, hr: 120, distanceM: k * 10, altitudeM: p.ele }));
      const real = buildFit({ records, sessionStartUnixS: s, sport: 11 });
      await archive.save(key, real, { version: 1, workoutKey: key, archivedAt: NOW.toISOString(), fit: { bytes: real.length, sha256: "a".repeat(64) }, workout: { startTime: s * 1000 } });
    }
    const inDir = await folder(dir, { "dup.gpx": gpx(walkPts(starts[1] + 30), "walking"), "own.gpx": gpx(walkPts(T0 + 10 * 86_400), "walking") });
    await importWorkouts(store, { path: inDir, source: "strava" }, NOW);
    const est = await estimateRouteTime(clientOf(), archive, { routeId: "r" }, { imported: await importedSource(store), now: NOW });
    assert.deepEqual(est.model.sources, { suuntoArchive: 3, imported: 1, importedBySource: { strava: 1 }, importedSkipped: { otherSport: 0, noMotionData: 0, unreadable: 0, duplicateOfArchive: 1 } });
    assert.equal(est.model.workoutsUsed, 4);
    const without = await estimateRouteTime(clientOf(), archive, { routeId: "r" }, { now: NOW });
    assert.deepEqual(without.model.sources, { suuntoArchive: 3, imported: 0, importedBySource: {}, importedSkipped: { otherSport: 0, noMotionData: 0, unreadable: 0, duplicateOfArchive: 0 } });
    assert.equal(without.model.workoutsUsed, 3);
  });
});

test("estimate_route_time: an imports folder that cannot be read does not stop the estimate, it is said in the notes", async () => {
  const broken = { records: new Map(), points: async () => [], error: "EACCES: permission denied" };
  const est = await estimateRouteTime(clientOf(), memoryArchiveStore(), { routeId: "r" }, { imported: broken, now: NOW });
  assert.equal(est.basis, "generic-naismith");
  assert.ok(est.notes.some((n) => /imports folder could not be read \(EACCES/.test(n)));
  await withTmp(async (dir) => {
    await writeFile(join(dir, "afile"), "");
    const src = await importedSource(fileImportStore(join(dir, "afile"))); // a file where the folder should be
    assert.match(src.error ?? "", /ENOTDIR/);
  });
});
