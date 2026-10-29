// Preloaded with `node --import` into the real compiled server / CLI by
// src/e2e.test.ts, so end-to-end tests run against canned Suunto responses
// instead of the network. Never shipped: it lives outside src/ and dist/.
const KEY = "6aba8afee2ab172bb4c5fc8d";
const START = Date.UTC(2026, 8, 27, 6, 0, 0);
const HOUR = 3_600_000;

const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function stamp(instantMs, offsetMin) {
  const local = new Date(instantMs + offsetMin * 60_000).toISOString().slice(0, 23);
  const a = Math.abs(offsetMin);
  return `${local}${offsetMin < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const inWindow = (t, url) => t >= Number(url.searchParams.get("from")) && t <= Number(url.searchParams.get("to"));

function marker(offsetS, durationS, hr, energy, notes) {
  return { startTime: START + offsetS * 1000, endTime: START + (offsetS + durationS) * 1000, totals: { duration: durationS, energy, hr, intervalNotes: notes } };
}

function sleepRows(url) {
  const sleeps = [
    // one sleep re-sent three times as Suunto revises it
    { id: 1, at: Date.UTC(2026, 8, 27, 21, 10), revisions: [100, 27000, 26000] },
    { id: 2, at: Date.UTC(2026, 8, 28, 1, 31), revisions: [17000] }, // 03:31 local
    { id: 3, at: Date.UTC(2026, 8, 28, 6, 0), revisions: [5400] }, // 08:00 local, a morning nap
    { id: 4, at: Date.UTC(2026, 8, 28, 12, 0), revisions: [3600] }, // 14:00 local, an afternoon nap
  ];
  return sleeps.flatMap((s) =>
    s.revisions.map((duration) => {
      const bedtime = stamp(s.at, 120);
      return { timestamp: bedtime, entryData: { SleepId: s.id, IsNap: duration < 10800, Duration: duration, BedtimeStart: bedtime, SleepQualityScore: duration > 20000 ? 80 : undefined } };
    }),
  ).filter((r) => inWindow(Date.parse(r.timestamp), url));
}

function recoveryRows(url) {
  const rows = [];
  for (let t = Date.UTC(2026, 8, 25, 22); t < Date.UTC(2026, 8, 28, 22); t += HOUR / 2) rows.push({ timestamp: stamp(t, 120), entryData: { Balance: 0.5, StressState: 1 } });
  return rows.filter((r) => inWindow(Date.parse(r.timestamp), url));
}

// Like route imports below: two writes of one kind in flight at once are not reliable.
const inFlight = {};
async function overlapped(kind) {
  inFlight[kind] = (inFlight[kind] ?? 0) + 1;
  await new Promise((r) => setTimeout(r, 40));
  const overlap = inFlight[kind] > 1;
  inFlight[kind]--;
  return overlap;
}
const guides = new Map(); // id -> name, what /v2/guides/items lists
const uploadPolls = new Map(); // uploadId -> status polls so far

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const path = url.pathname;

  if ((path === "/v2/guides/files" && init.method === "POST") || (/^\/v2\/guides\/files\/[^/]+$/.test(path) && init.method === "PUT")) {
    if (await overlapped("guide")) return res("General error", 500);
    // the zip is stored uncompressed and manifest.json comes first
    const name = /"name":"([^"]*)"/.exec(new TextDecoder().decode(init.body))?.[1] ?? "";
    const id = init.method === "PUT" ? path.split("/").pop() : `guide${guides.size}`;
    guides.set(id, name);
    return res(process.env.STUB_GUIDE_NO_ID ? { name } : { id, name });
  }
  if (path === "/v2/guides/items") {
    return res(process.env.STUB_GUIDE_LIST === "empty" ? [] : [...guides].map(([id, name]) => ({ id, name })));
  }
  if (path === "/v2/upload" && init.method === "POST") {
    if (await overlapped("upload")) return res("General error", 500);
    const uploadId = `upload${uploadPolls.size}`;
    uploadPolls.set(uploadId, 0);
    return res({ uploadId, uploadUrl: `https://uploads.stub.test/${uploadId}` });
  }
  if (url.host === "uploads.stub.test" && init.method === "PUT") {
    if (await overlapped("upload")) return res("General error", 500);
    return res("", 201);
  }
  if (/^\/v2\/upload\/upload\d+$/.test(path)) {
    const id = path.split("/").pop();
    const polls = uploadPolls.get(id) + 1;
    uploadPolls.set(id, polls);
    const status = process.env.STUB_UPLOAD_STATUS ?? (polls === 1 ? "Processing" : "Processed");
    return res(status === "Processed" ? { uploadId: id, status, workoutKey: KEY } : { uploadId: id, status });
  }

  if (path === "/v2/route/6acd201e1cc20768cf51aa4f" || path === "/v2/route/000000000000000000000000") {
    if (path.endsWith("0000")) return res({ statusCode: 404, message: "Resource not found" }, 404);
    return res({ id: "6acd201e1cc20768cf51aa4f", description: "Wasserfallsteig near Bad Urach", visibility: "PRIVATE", activityIds: [11], startPoint: { altitude: 456.57, latitude: 48.49514, longitude: 9.37211 }, totalDistance: 9669.2, created: 1791827998437, modified: 1791827998463, watchEnabled: true, turnWaypointsEnabled: false });
  }
  if (/^\/v2\/route\/route\d+$/.test(path) && (init.method ?? "GET") === "GET") {
    return res({ id: path.split("/").pop(), description: "Stub", watchEnabled: process.env.STUB_ROUTE_WATCH !== "off", totalDistance: 1234.5 });
  }
  if (/^\/v2\/route\/[0-9a-f]+\/export$/.test(path) || /^\/v2\/route\/route\d+\/export$/.test(path)) {
    // like the real endpoint: 500 unless GPX is asked for
    if (init.headers?.Accept !== "application/gpx+xml") return res("", 500);
    return res('<?xml version="1.0"?><gpx version="1.1"><rte><name>Stub route</name><rtept lat="1" lon="2"/></rte></gpx>');
  }
  if (path === "/v2/route/import") {
    if (init.method !== "POST" || init.headers?.["Content-Type"] !== "application/gpx+xml") return res("bad request", 400);
    // like the real backend under load: two imports at once are not reliable
    globalThis.__routeImportsInFlight = (globalThis.__routeImportsInFlight ?? 0) + 1;
    await new Promise((r) => setTimeout(r, 40));
    const overlapped = globalThis.__routeImportsInFlight > 1;
    globalThis.__routeImportsInFlight--;
    if (overlapped) return res("General error", 500);
    const gpx = new TextDecoder().decode(init.body);
    // one route per <rte>/<trk>, named from its <name>, like the real endpoint
    const names = [...gpx.matchAll(/<(?:rte|trk)>\s*<name>([^<]*)<\/name>/g)].map((m) => m[1]);
    const activities = (url.searchParams.get("activities") ?? "1").split(",").map(Number);
    return res({ items: names.map((description, i) => ({ id: `route${i}`, username: "u", description, activities, segments: [{ start: {}, end: {} }] })) });
  }

  if (path === "/v3/workouts/") {
    const total = Number(process.env.STUB_WORKOUTS ?? 3);
    const pad = "x".repeat(Number(process.env.STUB_PAD ?? 0));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const all = Array.from({ length: total }, (_, i) => ({
      workoutKey: i.toString(16).padStart(24, "0"),
      activityId: 23,
      startTime: START - i * 3 * HOUR,
      timeOffsetInMinutes: 120,
      pad,
    }));
    return res({ payload: all.slice(offset, offset + limit), metadata: { count: total } });
  }
  if (path === `/v3/workouts/${KEY}`) {
    const wanted = (url.searchParams.get("extensions") ?? "").split(",");
    const extensions = [];
    if (wanted.includes("IntensityExtension")) extensions.push({ type: "IntensityExtension", zones: { heartRate: { zone1: { totalTime: 100 }, zone2: { totalTime: 200 }, zone3: { totalTime: 50 }, zone4: { totalTime: 0 }, zone5: { totalTime: 0 } } } });
    if (wanted.includes("ManualLapStreamExtension")) {
      extensions.push({
        type: "ManualLapStreamExtension",
        markers: [
          marker(0, 20, { min: 80, avg: 95, max: 110 }, 3, "60kg 3x10\fBench press"),
          marker(20, 45, { min: 100, avg: 128, max: 150 }, 9, "Bench press\f60kg 3x10"),
          marker(65, 60, { min: 120, avg: 130, max: 140 }, 4, "90s target · Next: set 2/3"),
          marker(125, 3, { min: 118, avg: 119, max: 120 }, 0, "Session complete"),
        ],
      });
    }
    if (wanted.includes("SummaryExtension")) extensions.push({ type: "SummaryExtension", pte: 2, peakEpoc: 14, recoveryTime: 12360, apps: [{ name: "MONDAY", authorId: "a", id: "yn8oz6vu" }] });
    return res({ error: null, payload: { workoutKey: KEY, activityId: 23, startTime: START, totalTime: 128, tssList: [{ calculationMethod: "HR", trainingStressScore: 24.4 }], extensions }, metadata: {} });
  }
  if (path === "/v3/workouts/000000000000000000000000") return res("", 200);
  if (path === "/247samples/sleep") return res(sleepRows(url));
  if (path === "/247samples/recovery") return res(recoveryRows(url));
  if (path === "/247/daily-activity-statistics") {
    // the real endpoint answers 400 to an offset written +0200
    if (/[+-]\d{4}$/.test(url.searchParams.get("startdate") ?? "")) return res("Invalid arguments", 400);
    const day = (url.searchParams.get("startdate") ?? "2026-09-27").slice(0, 10);
    return res([
      { Name: "stepcount", Aggregation: "sum", Sources: [{ Samples: [{ TimeISO8601: `${day}T12:00:00+02:00`, Value: 1234 }] }] },
      { Name: "energyconsumption", Aggregation: "sum", Sources: [{ Samples: [{ TimeISO8601: `${day}T12:00:00+02:00`, Value: 10_000_000 }] }] },
    ]);
  }
  if (path === "/v2/subscriptions") return res("... Access denied (OperationNotFound)", 401);
  return res("not found", 404);
};
