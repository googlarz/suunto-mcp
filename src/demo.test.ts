import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DemoClient, markDemo, demoWriteResult, isDemo } from "./demo.js";
import { localDate } from "./api.js";
import { addDays } from "./training-load.js";
import { parseFit, summarizeFit } from "./fit.js";
import { assessHr } from "./hr-quality.js";
import { LAP_EXTENSIONS, shapeLaps } from "./laps.js";
import { SuuntoNotFoundError } from "./errors.js";

// ---------- unit ----------

const NOW = new Date(2026, 10, 13, 20, 0, 0); // a Friday evening, machine-local

test("demo: SUUNTO_DEMO=1 and nothing else turns it on", () => {
  assert.equal(isDemo({ SUUNTO_DEMO: "1" }), true);
  for (const v of [undefined, "", "0", "true", "yes"]) assert.equal(isDemo({ SUUNTO_DEMO: v }), false, String(v));
});

test("demo: markDemo adds demo:true to objects and wraps everything else", () => {
  assert.deepEqual(JSON.parse(markDemo('{"a":1}')), { demo: true, a: 1 });
  assert.deepEqual(JSON.parse(markDemo("[1,2]")), { demo: true, data: [1, 2] });
  assert.deepEqual(JSON.parse(markDemo("null")), { demo: true, data: null });
  assert.deepEqual(JSON.parse(markDemo("<gpx/>")), { demo: true, data: "<gpx/>" });
  assert.ok(markDemo(JSON.stringify({ a: 1 }, null, 2)).includes("\n"), "pretty-printed input stays pretty-printed");
});

test("demo: the same seed and date give the same data; another seed does not", async () => {
  const grab = async (c: DemoClient) => {
    const day = localDate(1, NOW);
    return JSON.stringify([
      await c.listWorkouts({ limit: 100 }),
      await c.listSleep(addDays(day, -20), day),
      await c.listRecovery(addDays(day, -5), day),
      await c.listDailyActivity(day, day),
      await c.getDailyStats(`${addDays(day, -20)}T00:00:00`, `${day}T23:59:59`),
    ]);
  };
  const a = await grab(new DemoClient(NOW, 7));
  assert.equal(await grab(new DemoClient(NOW, 7)), a);
  assert.notEqual(await grab(new DemoClient(NOW, 8)), a);
  // an earlier clock changes which days exist, never what a finished day holds
  const earlier = new DemoClient(new Date(2026, 10, 12, 20, 0, 0), 7);
  const day = localDate(2, NOW);
  assert.equal(JSON.stringify(await earlier.listSleep(day, day)), JSON.stringify(await new DemoClient(NOW, 7).listSleep(day, day)));
});

test("demo: about 8 weeks, 3 gym sessions and 1-2 runs a week, nothing in the future", async () => {
  const c = new DemoClient(NOW, 7);
  const rows = (await c.listWorkouts({ limit: 1000 })).payload;
  assert.ok(rows.every((w: any) => w.startTime + w.totalTime * 1000 <= NOW.getTime()));
  const first = localDate(55, NOW);
  assert.ok(rows.every((w: any) => new Date(w.startTime + w.timeOffsetInMinutes * 60_000).toISOString().slice(0, 10) >= first));
  const byWeek = new Map<string, { gym: number; run: number }>();
  for (const w of rows) {
    const d = new Date(w.startTime + w.timeOffsetInMinutes * 60_000).toISOString().slice(0, 10);
    const mon = addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    const wk = byWeek.get(mon) ?? { gym: 0, run: 0 };
    wk[w.activityId === 23 ? "gym" : "run"]++;
    byWeek.set(mon, wk);
  }
  const full = [...byWeek].filter(([mon]) => mon > first && addDays(mon, 6) < localDate(0, NOW));
  assert.ok(full.length >= 6);
  for (const [, wk] of full) {
    assert.equal(wk.gym, 3);
    assert.ok(wk.run >= 1 && wk.run <= 2);
  }
});

test("demo: the FIT file parses, carries heart rate and a session summary", async () => {
  const c = new DemoClient(NOW, 7);
  const gym = (await c.listWorkouts({ limit: 100 })).payload.find((w: any) => w.activityId === 23);
  const summary = summarizeFit(await parseFit(await c.getWorkoutFit(gym.workoutKey)));
  assert.equal(summary.sport, "training");
  assert.ok(summary.records_sample!.count > 600);
  assert.ok(summary.avg_heart_rate! > 80);
  assert.ok(summary.laps > 10);
});

test("demo: unknown routes, unknown workouts and unserved paths fail like the real API", async () => {
  const c = new DemoClient(NOW, 7);
  await assert.rejects(() => c.getRoute("nope"), SuuntoNotFoundError);
  await assert.rejects(() => c.getWorkout("0".repeat(24)), SuuntoNotFoundError);
  await assert.rejects(() => c.getWorkout("xyz"), SuuntoNotFoundError);
  await assert.rejects(() => c.getUploadStatus("u1"), SuuntoNotFoundError);
});

test("demo: exactly one of the recent gym sessions deviates from its plan", async () => {
  const c = new DemoClient(NOW, 7);
  const gyms = (await c.listWorkouts({ limit: 100 })).payload.filter((w: any) => w.activityId === 23);
  const codes: string[][] = [];
  const { compareWorkout } = await import("./compare.js");
  for (const g of gyms) {
    const cmp = compareWorkout(shapeLaps(await c.getWorkoutWithExtensions(g.workoutKey, LAP_EXTENSIONS)));
    assert.equal(cmp.status, "ok");
    assert.equal(cmp.reliable, true);
    codes.push(cmp.deviations.map((d: any) => d.code));
  }
  assert.equal(codes.filter((c) => c.length > 0).length, 1);
  assert.ok(codes.find((c) => c.length)!.includes("long-set"));
});

test("demo: exactly one gym session has a heart-rate dropout; every other workout's HR passes the quality check", async () => {
  const c = new DemoClient(NOW, 7);
  const all = (await c.listWorkouts({ limit: 100 })).payload;
  const verdicts: [number, boolean | null][] = [];
  for (const w of all) verdicts.push([w.activityId, assessHr(await parseFit(await c.getWorkoutFit(w.workoutKey))).reliable]);
  assert.deepEqual(verdicts.filter(([, ok]) => ok !== true), [[23, false]]);
});

test("demo: demoWriteResult names the tool and what it would do", () => {
  assert.match(JSON.parse(demoWriteResult("push_strength_guide")).message, /Demo mode: nothing was written.*push_strength_guide would build/);
});

// ---------- e2e: the compiled server, no credentials, a fetch that throws ----------

const distIndex = fileURLToPath(new URL("./index.js", import.meta.url));
const throwingFetch = new URL("../test-fixtures/throwing-fetch.mjs", import.meta.url).href;

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; json: any }>;
type Rpc = (method: string, params?: unknown) => Promise<any>;

async function withDemo(fn: (call: Call, rpc: Rpc, fetchLog: () => Promise<string>) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "suunto-demo-"));
  const fetchLogPath = join(cwd, "fetch.log");
  const env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>),
    SUUNTO_DEMO: "1",
    FETCH_LOG: fetchLogPath,
    SUUNTO_CACHE_DIR: join(cwd, "cache"),
    SUUNTO_JOURNAL_PATH: join(cwd, "journal.json"),
    SUUNTO_PLAN_PATH: join(cwd, "plan.json"),
    SUUNTO_SEEN_PATH: join(cwd, "seen.json"),
    SUUNTO_ARCHIVE_DIR: join(cwd, "archive"),
  };
  const child = spawn(process.execPath, ["--import", throwingFetch, distIndex], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (msg: any) => void>();
  const noise: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    } catch {
      noise.push(line);
    }
  });
  let nextId = 1;
  const rpc: Rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no response to ${method} within 20s`)), 20_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo-e2e", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    assert.match(init.result.instructions, /DEMO MODE/, "the server instructions announce demo mode");
    const call: Call = async (name, args = {}) => {
      const r = (await rpc("tools/call", { name, arguments: args })).result;
      const text: string = r.content[0].text;
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { text, isError: r.isError === true, json };
    };
    await fn(call, rpc, () => readFile(fetchLogPath, "utf8").catch(() => ""));
    // demo data must never reach the cache, the journal, the plan or the seen marker
    assert.deepEqual(await readdir(cwd).then((f) => f.filter((x) => ["cache", "journal.json", "plan.json", "seen.json", "archive"].includes(x))), []);
    assert.deepEqual(noise, [], "the server wrote non-JSON-RPC output to stdout");
    assert.equal(await readFile(fetchLogPath, "utf8").catch(() => ""), "", "demo mode made a network call");
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}

const today = () => localDate(0);
const ok = async (call: Call, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.demo, true, `${name} result is missing the demo marker`);
  return r.json;
};

test("e2e demo: starts without credentials; tools/list works", async () => {
  await withDemo(async (_call, rpc) => {
    const names: string[] = (await rpc("tools/list")).result.tools.map((t: any) => t.name);
    assert.ok(names.includes("get_daily_snapshot") && names.includes("push_strength_guide"));
  });
});

test("e2e demo: get_daily_snapshot has sleep, recovery, steps and workouts, today and over 14 days", async () => {
  await withDemo(async (call) => {
    const yesterday = await ok(call, "get_daily_snapshot", { date: localDate(1) });
    assert.deepEqual(yesterday.errors, []);
    assert.ok(yesterday.sleep.main.durationS > 3 * 3600);
    assert.ok(yesterday.recovery.samples >= 40 && yesterday.recovery.morning.balance > 0);
    assert.ok(yesterday.activity.steps > 1000);

    const now = await ok(call, "get_daily_snapshot", { date: today() });
    assert.deepEqual(now.errors, []);
    assert.ok(now.activity.steps !== null && now.recovery !== null, "today has partial data");

    const range = await ok(call, "get_daily_snapshot", { date: localDate(13), to: today() });
    assert.equal(range.days.length, 14);
    assert.deepEqual(range.errors, []);
    for (const d of range.days) {
      assert.ok(d.sleep.main, `${d.date}: sleep`);
      assert.ok(d.recovery.samples > 0, `${d.date}: recovery`);
      assert.ok(d.activity.steps > 0, `${d.date}: steps`);
    }
    assert.ok(range.days.some((d: any) => d.workouts.length > 0), "workouts in the range");
  });
});

test("e2e demo: get_training_load has a non-zero CTL; get_baselines has bands", async () => {
  await withDemo(async (call) => {
    const load = await ok(call, "get_training_load", { date: today() });
    assert.ok(load.current.ctl > 5, `ctl ${load.current.ctl}`);
    assert.ok(load.current.atl > 0);

    const bl = await ok(call, "get_baselines", { date: today() });
    assert.deepEqual(bl.errors, []);
    for (const m of ["sleepDurationS", "sleepScore", "hrv", "recoveryMorning"]) {
      assert.ok(bl.metrics[m].n >= 7, `${m} n=${bl.metrics[m].n}`);
      assert.ok(bl.metrics[m].p25 !== null && bl.metrics[m].p75 !== null, `${m} has a band`);
    }
    assert.ok(bl.metrics.steps.n >= 7);
  });
});

test("e2e demo: forecast_training_load and adjust_guide read the synthetic data and write nothing", async () => {
  await withDemo(async (call, _rpc, fetchLog) => {
    const f = await ok(call, "forecast_training_load", { days: [{ date: addDays(today(), 1), tss: 80 }, { date: addDays(today(), 3), tss: 60 }] });
    assert.equal(f.demo, true);
    assert.deepEqual(f.series.map((p: any) => p.date), [1, 2, 3].map((n) => addDays(today(), n)));
    assert.ok(f.start.ctl > 5);
    const a = await ok(call, "adjust_guide", { guide: { title: "T", date: today(), exercises: [{ name: "Bench", detail: "70kg 4x8", sets: 4, restSec: 90 }] } });
    assert.equal(a.demo, true);
    assert.ok(["unchanged", "lighter", "reduced"].includes(a.level));
    assert.equal(await fetchLog(), "");
  });
});

test("e2e demo: list_workouts -> laps -> compare_workout_to_plan; one session deviates", async () => {
  await withDemo(async (call) => {
    const list = await ok(call, "list_workouts", { limit: 100 });
    const gyms = list.payload.filter((w: any) => w.extensionTypes.includes("MANUALLAP"));
    assert.ok(gyms.length >= 20);

    const laps = await ok(call, "get_workout_laps", { workoutKey: gyms[0].workoutKey });
    assert.ok(laps.lapCount >= 15);
    assert.ok(laps.laps.rows.every((r: any[]) => r[8] !== null), "every lap is labelled");
    assert.deepEqual(laps.checks, []);
    assert.equal(laps.laps.rows.at(-1)[7], "done");
    assert.ok(laps.guide.name);

    const withDeviation: string[] = [];
    for (const g of gyms) {
      const cmp = await ok(call, "compare_workout_to_plan", { workoutKey: g.workoutKey });
      assert.equal(cmp.status, "ok");
      assert.equal(cmp.reliable, true);
      if (cmp.deviations.length) withDeviation.push(g.workoutKey);
    }
    assert.equal(withDeviation.length, 1, "exactly one session shows a deviation");
  });
});

test("e2e demo: rest profile, FIT, sleep, recovery, activity, routes, guides all answer with the marker", async () => {
  await withDemo(async (call) => {
    const list = await ok(call, "list_workouts", { limit: 10 });
    const gym = list.payload.find((w: any) => w.extensionTypes.includes("MANUALLAP")).workoutKey;
    const rest = await ok(call, "get_workout_rest_profile", { workoutKey: gym });
    assert.equal(rest.status, "ok");
    assert.ok(rest.rests.length > 5);
    const fit = await ok(call, "get_workout_fit", { workoutKey: gym });
    assert.equal(fit.sport, "training");
    await ok(call, "get_workout", { workoutKey: gym });
    const y = localDate(1);
    assert.ok((await ok(call, "get_sleep", { date: localDate(2) })).data.length >= 1);
    assert.ok((await ok(call, "list_sleep", { from: localDate(6), to: y })).data.length >= 6);
    assert.ok((await ok(call, "get_recovery", { date: y })).data.length >= 40);
    assert.ok((await ok(call, "list_recovery", { from: localDate(3), to: y })).data.length >= 100);
    assert.equal((await ok(call, "get_daily_activity", { date: y })).data.length, 144);
    assert.ok((await ok(call, "list_daily_activity", { from: localDate(2), to: y })).data.length >= 288);
    assert.ok((await ok(call, "get_daily_activity_statistics", { startdate: `${localDate(3)}T00:00:00`, enddate: `${y}T23:59:59` })).data.length === 2);
    const routes = await ok(call, "list_routes");
    assert.equal(routes.data.length, 2);
    await ok(call, "get_route", { routeId: routes.data[0].id });
    const gpx = await ok(call, "export_route", { routeId: routes.data[0].id });
    assert.match(gpx.data, /<gpx/);
    // the real list is { error, payload, metadata } and each guide carries all of Suunto's fields
    const guides = await ok(call, "list_guides");
    assert.equal(guides.error, null);
    assert.equal(typeof guides.metadata.ts, "string");
    assert.equal(guides.payload.length, 3);
    const keys = ["id", "username", "type", "modificationTime", "fileModificationTime", "name", "description", "shortDescription", "owner", "url", "iconUrl", "backgroundUrl", "richText", "activities", "localDate", "usage", "pinned", "externalId", "ownerId", "catalogueId", "extended"];
    for (const g of guides.payload) {
      assert.deepEqual(Object.keys(g).sort(), [...keys].sort());
      assert.equal(g.type, "sequence");
      assert.equal(g.usage, "workout");
      assert.equal(typeof g.modificationTime, "number");
      assert.equal(typeof g.fileModificationTime, "number");
    }
  });
});

test("e2e demo: write tools return the demo message and write nothing", async () => {
  await withDemo(async (call, rpc, fetchLog) => {
    const writes: [string, Record<string, unknown>][] = [
      ["upload_workout", { filePath: "/definitely/not/here.fit" }],
      ["upload_route", { filePath: "/definitely/not/here.gpx" }],
      ["push_workout_guide", { title: "T", date: today(), exercises: [{ name: "A", detail: "x" }] }],
      ["push_interval_guide", { title: "T", date: today(), blocks: [{ segments: [{ label: "Warmup", durationSec: 60 }] }] }],
      ["push_strength_guide", { title: "T", date: today(), exercises: [{ name: "A", detail: "x", sets: 3, restSec: 60 }] }],
      ["push_week_plan", { guides: [{ title: "T", date: today(), exercises: [{ name: "A", detail: "x", sets: 3, restSec: 60 }] }], dryRun: false }],
      ["delete_guide", { guideId: "demo0001" }],
      ["generate_daily_digest", { date: localDate(1) }],
      ["log_session", { workoutKey: "0123456789abcdef01234567", note: "x" }],
    ];
    const tools: any[] = (await rpc("tools/list")).result.tools;
    const nonRead = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
    // set_plan, get_catchup and archive_workouts are not read-only either, but in demo mode they work on in-memory state (tested below)
    assert.deepEqual(nonRead.filter((n) => n !== "set_plan" && n !== "get_catchup" && n !== "archive_workouts"), writes.map(([n]) => n).sort(), "the write list in this test covers every non-read-only tool");
    for (const [name, args] of writes) {
      const r = await call(name, args);
      assert.equal(r.isError, false, `${name}: ${r.text}`);
      assert.equal(r.json.demo, true);
      assert.match(r.json.message, new RegExp(`Demo mode: nothing was written.*${name} would`), name);
    }
    assert.equal(await fetchLog(), "");
    // still a clean list afterwards: delete_guide did not delete
    assert.ok((await ok(call, "list_guides")).payload.length >= 1);
  });
});

test("e2e demo: set_plan / get_plan / get_catchup work in memory and write nothing to disk", async () => {
  await withDemo(async (call, rpc, fetchLog) => {
    const tools: any[] = (await rpc("tools/list")).result.tools;
    const ann = (n: string) => tools.find((t) => t.name === n).annotations;
    assert.deepEqual(ann("set_plan"), { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    assert.equal(ann("get_plan").readOnlyHint, true);
    assert.deepEqual(ann("get_catchup"), { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });

    assert.equal((await ok(call, "get_plan")).plan, null);
    const d = today();
    const set = await ok(call, "set_plan", { goal: "demo goal", sessions: [{ date: d, title: "Push A", guide: { title: "Push A", date: d, exercises: [{ name: "Bench", detail: "3x8 70kg", sets: 3, restSec: 90 }] } }] });
    assert.equal(set.saved, true);
    assert.equal(set.plan.sessions, 1);
    const got = await ok(call, "get_plan");
    assert.equal(got.todaySession.title, "Push A");
    assert.equal(got.todaySession.guide.exercises[0].name, "Bench");
    assert.equal(got.next7Days.length, 7);

    // invalid plans are refused with an error, strictly
    for (const bad of [{ goal: "g", sessions: [{ date: d, title: "x", guide: { title: "x", date: d } }] }, { goal: "g", mood: 1 }, { goal: "g", sessions: [{ date: d, title: "x", guide: { title: "x", date: "2030-01-01", exercises: [{ name: "A", detail: "x", sets: 3, restSec: 60 }] } }] }]) {
      const r = await call("set_plan", bad);
      assert.equal(r.isError, true, JSON.stringify(bad));
    }
    assert.equal((await ok(call, "get_plan")).plan.goal, "demo goal", "a refused call changes nothing");

    // catch-up on the synthetic data: the marker is in memory, markSeen false repeats the answer, true moves it
    const first = await ok(call, "get_catchup");
    assert.ok(first.newWorkouts.length > 0 && first.newNights.length > 0);
    assert.equal(first.marked, false);
    assert.deepEqual((await ok(call, "get_catchup")).newWorkouts, first.newWorkouts);
    assert.equal((await ok(call, "get_catchup", { markSeen: true })).marked, true);
    const after = await ok(call, "get_catchup");
    assert.deepEqual([after.newWorkouts.length, after.newNights.length], [0, 0]);
    assert.equal(after.since.firstCall, false);
    assert.equal(await fetchLog(), "");
  });
});

test("e2e demo: get_tag_effects and get_benchmark work on the synthetic sessions and write nothing to disk", async () => {
  await withDemo(async (call, _rpc, fetchLog) => {
    const tags = await ok(call, "get_tag_effects", { days: 56 });
    assert.deepEqual(tags.tags.map((t: any) => t.tag).sort(), ["long-run", "strength"]);
    const strength = tags.tags.find((t: any) => t.tag === "strength");
    assert.ok(strength.taggedNights >= 15, `strength nights ${strength.taggedNights}`);
    assert.equal(tags.thresholds.minTaggedNights, 15);
    assert.deepEqual(Object.keys(strength.metrics).sort(), ["hrv", "recoveryMorning", "sleepDurationS", "sleepScore"]);
    assert.ok(["insufficient", "within-noise", "differs"].includes(strength.verdict));
    assert.deepEqual(tags.errors, []);
    assert.equal((await ok(call, "get_tag_effects", { days: 56, tag: "STRENGTH" })).tags.length, 1);
    assert.equal((await call("get_tag_effects", { days: 29 })).isError, true, "days below 30 is refused by the schema");

    // three guides, each about 8 occurrences in the 8 demo weeks; the guide mode and the exercise mode agree
    for (let i = 0; i < 4; i++) {
      const pending = (await ok(call, "get_benchmark", { guide: "push a", weeks: 8 })).pending;
      if (pending === 0) break;
    }
    const push = await ok(call, "get_benchmark", { guide: "push a", weeks: 8 });
    assert.equal(push.mode, "guide");
    assert.ok(push.occurrences >= 6 && push.occurrences <= 9, `occurrences ${push.occurrences}`);
    assert.ok(push.sessions.every((s: any) => s.guide === "PUSH A" && typeof s.durationS === "number" && typeof s.tss === "number"));
    assert.ok(push.series.exercises.some((e: any) => e.name === "Bench Press" && e.kg.n === push.occurrences));
    assert.ok(["up", "down", "flat"].includes(push.series.durationS.trend));
    const bench = await ok(call, "get_benchmark", { exercise: "Bench Press", weeks: 8 });
    assert.equal(bench.mode, "exercise");
    assert.equal(bench.occurrences, push.occurrences);
    assert.equal((await call("get_benchmark", {})).isError, true);
    assert.equal((await call("get_benchmark", { guide: "a", exercise: "b" })).isError, true);
    assert.equal(await fetchLog(), "");
  });
});

test("e2e demo: archive_workouts and get_archive_status work in memory, bounded per call, and write nothing to disk", async () => {
  await withDemo(async (call, rpc, fetchLog) => {
    const tools: any[] = (await rpc("tools/list")).result.tools;
    const ann = (n: string) => tools.find((t) => t.name === n).annotations;
    assert.deepEqual(ann("archive_workouts"), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.deepEqual(ann("get_archive_status"), { readOnlyHint: true, openWorldHint: false });

    const empty = await ok(call, "get_archive_status");
    assert.deepEqual([empty.archived, empty.dir, empty.problems], [0, null, []]);
    const first = await ok(call, "archive_workouts", { limit: 5 });
    assert.deepEqual([first.newlyArchived, first.archived, first.dir], [5, 5, null]);
    assert.ok(first.remaining > 0);
    assert.equal((await ok(call, "get_archive_status")).archived, 5);
    // about 8 weeks of workouts: more than the 20 one call may download, so it takes a second call
    const second = await ok(call, "archive_workouts");
    assert.equal(second.newlyArchived, 20);
    assert.equal(second.remaining, first.remaining - 20);
    const rest = await ok(call, "archive_workouts");
    assert.equal(rest.remaining, 0);
    assert.equal(rest.newlyArchived, second.remaining);
    assert.deepEqual(rest.errors, []);
    const again = await ok(call, "archive_workouts");
    assert.deepEqual([again.newlyArchived, again.remaining, again.alreadyArchived], [0, 0, rest.archived]);
    const st = await ok(call, "get_archive_status");
    assert.equal(st.archived, rest.archived);
    assert.ok(st.fitBytes > 0 && st.oldest <= st.newest);
    assert.equal((await call("archive_workouts", { limit: 21 })).isError, true);
    assert.equal(await fetchLog(), "");
    // the archive folder the server was given (SUUNTO_ARCHIVE_DIR) is checked by withDemo: it must not exist afterwards
  });
});

test("e2e demo: errors stay plain errors, invalid arguments are still rejected", async () => {
  await withDemo(async (call) => {
    const bad = await call("get_workout_laps", { workoutKey: "not-a-key" });
    assert.equal(bad.isError, true);
    const invalid = await call("get_baselines", { date: "yesterday" });
    assert.equal(invalid.isError, true);
    const unknown = await call("no_such_tool");
    assert.equal(unknown.isError, true);
  });
});

test("e2e demo: the four prompts work and say the data is synthetic; resources carry the marker", async () => {
  await withDemo(async (_call, rpc) => {
    const prompts: any[] = (await rpc("prompts/list")).result.prompts;
    assert.equal(prompts.length, 4);
    for (const p of prompts) {
      const r = (await rpc("prompts/get", { name: p.name, arguments: {} })).result;
      const text: string = r.messages[0].content.text;
      assert.match(text, /^DEMO DATA \(synthetic\)/, p.name);
      assert.match(text, /get_daily_snapshot|get_training_load/);
    }
    const res = (await rpc("resources/read", { uri: "suunto://this-week/summary" })).result.contents[0];
    assert.equal(JSON.parse(res.text).demo, true);
    const sleep = (await rpc("resources/read", { uri: "suunto://today/sleep" })).result.contents[0];
    assert.equal(JSON.parse(sleep.text).demo, true);
  });
});

test("demo: npm run doctor says demo mode is on and skips credential and network checks", async () => {
  const doctor = fileURLToPath(new URL("./doctor.js", import.meta.url));
  const cwd = await mkdtemp(join(tmpdir(), "suunto-doctor-"));
  try {
    const env = { ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>), SUUNTO_DEMO: "1", FETCH_LOG: join(cwd, "fetch.log") };
    const child = spawn(process.execPath, ["--import", throwingFetch, doctor], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const [code] = await once(child, "close");
    assert.equal(code, 0, err);
    assert.match(err, /Demo mode.*SUUNTO_DEMO=1/);
    assert.ok(!/Credentials|Network|Pairing/.test(err), err);
    assert.equal(await readFile(join(cwd, "fetch.log"), "utf8").catch(() => ""), "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("e2e demo: the demo marker is not added when SUUNTO_DEMO is unset (real mode unchanged)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "suunto-nodemo-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>;
  const child = spawn(process.execPath, ["--import", throwingFetch, distIndex], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const send = (id: number, method: string, params: unknown = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } });
    const init = JSON.parse((await lines.next()).value);
    assert.equal(init.result.instructions, undefined, "no demo instructions in real mode");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    send(2, "tools/call", { name: "get_sleep", arguments: { date: "2026-01-01" } });
    const r = JSON.parse((await lines.next()).value).result;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Missing required env vars/);
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("e2e demo: exercise history works across the demo sessions and caches nothing", async () => {
  await withDemo(async (call) => {
    let index: any;
    for (let i = 0; i < 6; i++) {
      index = JSON.parse((await call("get_exercise_history", { weeks: 8 })).text);
      if (index.pending === 0) break;
    }
    assert.equal(index.demo, true);
    assert.ok(index.exercises.length >= 3, "the demo gym sessions share exercises");
    assert.equal(index.pending, 0, "repeated calls converge: demo sessions are kept in memory, never on disk");
    assert.ok(index.sessions > 8);
    assert.ok(index.exercises[0].sessions >= 6);
    assert.equal(index.notes.filter((n: string) => /unreliable heart-rate/.test(n)).length, 1, "the demo's one session with a sensor dropout is called out");
  });
});
