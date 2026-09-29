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

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const path = url.pathname;

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
    return res([{ Name: "stepcount", Aggregation: "sum", Sources: [{ Samples: [{ TimeISO8601: "2026-09-27T12:00:00+02:00", Value: 1234 }] }] }]);
  }
  if (path === "/v2/subscriptions") return res("... Access denied (OperationNotFound)", 401);
  return res("not found", 404);
};
