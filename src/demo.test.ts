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
    SUUNTO_REPORTS_DIR: join(cwd, "reports"),
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
    assert.deepEqual(await readdir(cwd).then((f) => f.filter((x) => ["cache", "journal.json", "plan.json", "seen.json", "archive", "reports"].includes(x))), []);
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
    // set_plan, get_catchup, archive_workouts and get_weekly_report are not read-only either, but in demo mode they work on in-memory state (tested below);
    // so do the prediction ledger and experiment writers (tested in demo-state.test.ts and state-tools.test.ts)
    const inMemory = ["set_plan", "get_catchup", "archive_workouts", "get_weekly_report", "log_prediction", "void_prediction", "score_predictions", "start_experiment", "log_experiment_day", "stop_experiment", "queue_adjustment", "resolve_approval", "propose_next_week", "adjust_guide"];
    assert.deepEqual(nonRead.filter((n) => !inMemory.includes(n)), writes.map(([n]) => n).sort(), "the write list in this test covers every non-read-only tool");
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

test("e2e demo: push_week_plan's dry run (the default) validates and returns the plan; a real push still only returns the demo note", async () => {
  await withDemo(async (call, _rpc, fetchLog) => {
    const guides = [{ title: "T", date: today(), exercises: [{ name: "A", detail: "x", sets: 3, restSec: 60 }] }];
    const dry = await ok(call, "push_week_plan", { guides });
    assert.equal(dry.dryRun, true);
    assert.ok(Array.isArray(dry.notes) && dry.notes.length > 0);
    assert.equal((await ok(call, "push_week_plan", { guides, dryRun: true })).dryRun, true);
    const bad = await call("push_week_plan", { guides: [{ title: "T", date: today(), exercises: [] }] });
    assert.equal(bad.isError, true, "a dry run still rejects a guide that does not validate");
    const real = await ok(call, "push_week_plan", { guides, dryRun: false });
    assert.match(real.message, /Demo mode: nothing was written.*push_week_plan would/);
    assert.equal(real.dryRun, undefined);
    assert.equal(await fetchLog(), "");
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

test("e2e demo: get_weekly_report assembles the synthetic week, saves only in memory and writes nothing to disk", async () => {
  await withDemo(async (call, rpc, fetchLog) => {
    const tools: any[] = (await rpc("tools/list")).result.tools;
    assert.deepEqual(tools.find((t) => t.name === "get_weekly_report").annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    const r = await ok(call, "get_weekly_report");
    assert.match(r.markdown, /^# Weekly training report: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\n\n> DEMO DATA \(synthetic\)/);
    assert.ok(r.workouts.count > 0);
    assert.deepEqual(r.errors, []);
    assert.equal(r.saved, null);
    const saved = await ok(call, "get_weekly_report", { week: r.week.from, save: true });
    assert.deepEqual([saved.saved.status, saved.saved.path], ["written", null]);
    assert.equal((await ok(call, "get_weekly_report", { week: r.week.from, save: true })).saved.status, "unchanged");
    assert.equal((await call("get_weekly_report", { week: "2026-11-03" })).isError, true, "not a Monday");
    assert.equal((await call("get_weekly_report", { overwrite: true })).isError, true, "overwrite without save");
    assert.equal((await call("get_weekly_report", { save: "yes" })).isError, true, "schema type");
    assert.equal(await fetchLog(), "");
    // the reports folder the server was given (SUUNTO_REPORTS_DIR) is checked by withDemo: it must not exist afterwards
  });
});

test("e2e demo: estimate_route_time falls back to labelled Naismith (the demo FIT files carry no altitude), adds the latest start, and writes nothing", async () => {
  await withDemo(async (call, rpc, fetchLog) => {
    const tools: any[] = (await rpc("tools/list")).result.tools;
    assert.deepEqual(tools.find((t) => t.name === "estimate_route_time").annotations, { readOnlyHint: true, openWorldHint: true });
    const id = "d3e000000000000000000001";
    const plain = await ok(call, "estimate_route_time", { routeId: id });
    assert.equal(plain.basis, "generic-naismith");
    assert.equal(plain.model.status, "insufficient");
    assert.equal(plain.latestStart, null);
    assert.ok(plain.route.distanceM > 3000 && plain.estimate.totalTimeS > 2400, `${plain.route.distanceM} m, ${plain.estimate.totalTimeS} s`);
    // with archived demo workouts the running ones have no distance or altitude records: skipped, still insufficient
    while ((await ok(call, "archive_workouts")).remaining > 0);
    const running = await ok(call, "estimate_route_time", { routeId: id, activity: "running", sunset: "2026-11-15T16:05:00+01:00", marginMinutes: 20 });
    assert.equal(running.model.status, "insufficient");
    assert.ok(running.model.skipped.noMotionData > 0);
    assert.equal(Date.parse(running.latestStart.latestStartUtc), Date.parse("2026-11-15T16:05:00+01:00") - (20 * 60 + running.estimate.totalTimeS) * 1000);
    assert.equal((await call("estimate_route_time", { routeId: id, sunset: "tomorrow evening" })).isError, true);
    assert.equal((await call("estimate_route_time", { routeId: id, activity: "cycling" })).isError, true, "schema enum");
    assert.equal((await call("estimate_route_time", { routeId: id, marginMinutes: 400, sunset: "2026-11-15T16:05:00Z" })).isError, true, "schema maximum");
    assert.equal((await call("estimate_route_time", { routeId: "nope" })).isError, true);
    assert.equal(await fetchLog(), "");
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

// ---------- propose_next_week and simulate_plan in demo mode ----------

// calls again until the demo sessions are all read (8 uncached ones per call), as the result's `pending` says
async function proposeConverged(call: Call, args: Record<string, unknown> = {}) {
  let r: any;
  for (let i = 0; i < 8; i++) {
    r = await ok(call, "propose_next_week", args);
    if (r.pending === 0) break;
  }
  assert.equal(r.pending, 0);
  return r;
}

test("e2e demo: propose_next_week proposes from the demo programme and lifts, deterministically, and its output goes straight to set_plan and push_week_plan", async () => {
  await withDemo(async (call, rpc) => {
    const defs: any[] = (await rpc("tools/list")).result.tools;
    assert.deepEqual(defs.find((t) => t.name === "simulate_plan").annotations, { readOnlyHint: true, openWorldHint: true });
    // with queue: true it adds an entry to the local approval queue, so it is annotated for that (it never pushes)
    assert.deepEqual(defs.find((t) => t.name === "propose_next_week").annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    const a = await proposeConverged(call);
    const b = await proposeConverged(call);
    assert.equal(JSON.stringify(a), JSON.stringify(b), "the same on every call");
    assert.equal(a.status, "ok");
    assert.equal(a.planSource, "demo");
    assert.deepEqual(a.sessions.map((s: any) => s.title), ["PUSH A", "PULL B", "LEGS C"]);
    const squat = a.changes.find((c: any) => c.exercise === "Back Squat");
    assert.equal(squat.action, "deload", "the demo lifter missed it twice in a row");
    assert.ok(a.changes.every((c: any) => c.reasons.length > 0));
    assert.ok(a.changes.find((c: any) => c.exercise === "Bench Press").action !== "progress", "the newest bench session was a rep short");
    assert.equal(a.rulesUsed.find((r: any) => r.name === "stallSessions").value, 2);
    assert.ok(a.forecast.series.length >= 7 && a.risk.basis === "model-based");
    // straight on: the guides pass push_week_plan's own schema (dry run), the sessions pass set_plan (the demo's memory store)
    const week = await call("push_week_plan", { guides: a.guides });
    assert.equal(week.isError, false, week.text);
    assert.equal(week.json.dryRun, true);
    assert.deepEqual(week.json.wouldPush.map((w: any) => w.date), a.sessions.map((s: any) => s.date));
    const saved = await call("set_plan", { goal: "From the proposal", sessions: a.sessions });
    assert.equal(saved.isError, false, saved.text);
    // with a plan stored, the stored one is used
    assert.equal((await proposeConverged(call)).planSource, "stored");
  });
});

test("e2e demo: propose_next_week refuses a past weekStart and an unknown rule, and is insufficient when the plan has nothing to repeat", async () => {
  await withDemo(async (call) => {
    const past = await call("propose_next_week", { weekStart: "2020-01-06" });
    assert.equal(past.isError, true);
    assert.match(past.text, /must be after today/);
    const rule = await call("propose_next_week", { rules: { deloadPct: 99 } });
    assert.equal(rule.isError, true);
    assert.match(rule.text, /deloadPct/);
    const unknown = await call("propose_next_week", { rules: { bogus: 1 } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /rules.bogus is not a known rule/);
    const extra = await call("propose_next_week", { nope: 1 });
    assert.equal(extra.isError, true);
    assert.match(extra.text, /nope is not a known field/);
    await call("set_plan", { goal: "Runs only", sessions: [{ date: localDate(-3), title: "Run" }] });
    const thin = await ok(call, "propose_next_week");
    assert.equal(thin.status, "insufficient");
    assert.deepEqual([thin.sessions, thin.guides, thin.forecast], [[], [], null]);
    assert.match(thin.missing[0], /no session with a strength guide/);
  });
});

test("e2e demo: simulate_plan is deterministic, model-based, asks for tss where there is no estimate, and refuses what it does not know", async () => {
  await withDemo(async (call) => {
    const args = { sessions: [{ date: localDate(-3), title: "PUSH A" }, { date: localDate(-5), tss: 60 }], goalDate: localDate(-14), compare: { label: "lighter", sessions: [{ date: localDate(-3), tss: 20 }] } };
    const a = await ok(call, "simulate_plan", args);
    assert.equal(JSON.stringify(a), JSON.stringify(await ok(call, "simulate_plan", args)));
    assert.equal(a.modelBased, true);
    assert.equal(a.asOf, localDate(0));
    assert.equal(a.sessions.find((s: any) => s.title === "PUSH A").tssSource, "history");
    assert.ok(a.goal.band && a.series.length >= 14 && a.compare.difference.totalTss !== undefined);
    assert.ok(["ok", "insufficient"].includes(a.personalResponse.status));
    const noEstimate = await call("simulate_plan", { sessions: [{ date: localDate(-3), title: "NOT A GUIDE" }] });
    assert.equal(noEstimate.isError, true);
    assert.match(noEstimate.text, /Give its tss/);
    assert.match((await call("simulate_plan", { sessions: [{ date: localDate(-3), tss: 5, load: 1 }] })).text, /load is not a known field/);
    assert.match((await call("simulate_plan", { sessions: [{ date: localDate(0), tss: 5 }] })).text, /must be after asOf/);
    assert.match((await call("simulate_plan", {})).text, /Invalid arguments for simulate_plan/);
  });
});

// ---------- the approval queue, predictions, aliases and the data overview in demo mode ----------

const GUIDE_FOR = (date: string) => ({ title: "Approval check", date, exercises: [{ name: "Bench Press", detail: "70kg 3x8", sets: 3, restSec: 90 }] });

test("e2e demo: propose_next_week queue: true and predict: true; the queue lists it and resolve_approval with push: true NEVER calls the push path", async () => {
  await withDemo(async (call, rpc) => {
    const defs: any[] = (await rpc("tools/list")).result.tools;
    assert.deepEqual(defs.find((t) => t.name === "resolve_approval").annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.deepEqual(defs.find((t) => t.name === "list_approvals").annotations, { readOnlyHint: true, openWorldHint: false });
    assert.equal((await ok(call, "list_approvals")).items.length, 0);
    const plain = await proposeConverged(call);
    assert.equal(plain.queued, null);
    assert.deepEqual(plain.predictions, []);
    assert.equal((await ok(call, "list_approvals")).items.length, 0, "queue defaults to false");

    const q = await proposeConverged(call, { queue: true, predict: true });
    assert.equal(q.queued.queued, true);
    assert.ok(q.predictions.length > 0 || q.changes.every((c: any) => c.action !== "progress"), "a payload per increase");
    for (const p of q.predictions) {
      const logged = await call("log_prediction", p.payload);
      assert.equal(logged.isError, false, logged.text);
    }
    const listed = await ok(call, "list_approvals", { status: "pending" });
    assert.deepEqual(listed.items.map((i: any) => [i.id, i.kind, i.status, i.source]), [["a1", "week_plan", "pending", "propose_next_week"]]);
    const full = await ok(call, "list_approvals", { id: "a1" });
    assert.equal(full.items[0].call.tool, "push_week_plan");

    const approved = await ok(call, "resolve_approval", { id: "a1", decision: "approve", push: true, dryRun: false });
    assert.equal(approved.pushed, false);
    assert.match(approved.notes[0], /Demo mode: nothing was pushed/);
    assert.equal(approved.call.arguments.guides.length, q.guides.length);
    const again = await ok(call, "resolve_approval", { id: "a1", decision: "reject" });
    assert.deepEqual([again.alreadyResolved, again.decision], [true, "approve"], "the first answer, never twice");
    const bad = await call("resolve_approval", { id: "a1", decision: "reject", push: true });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /push: true needs decision approve/);
    // get_catchup summarizes what is waiting
    await ok(call, "queue_adjustment", { kind: "adjusted_guide", payload: GUIDE_FOR(localDate(-2)), reasons: ["HRV below band"], source: "adjust_guide" });
    const catchup = await ok(call, "get_catchup");
    assert.deepEqual([catchup.approvals.pending, catchup.approvals.items.map((i: any) => i.id)], [1, ["a2"]]);
  });
});

test("e2e demo: queue_adjustment refuses what push_strength_guide would refuse; adjust_guide queue: true stores a change only", async () => {
  await withDemo(async (call) => {
    const refused = await call("queue_adjustment", { kind: "adjusted_guide", payload: { title: "x", date: localDate(-1), exercises: [] } });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not a valid push_strength_guide spec/);
    assert.match((await call("queue_adjustment", { kind: "adjusted_guide", payload: { ...GUIDE_FOR(localDate(-1)), guideId: "g" } })).text, /guideId is not allowed/);
    assert.match((await call("queue_adjustment", { kind: "week_plan", payload: { guides: [] } })).text, /at least one guide|Invalid arguments/);
    assert.equal((await ok(call, "list_approvals")).items.length, 0, "nothing stored");
    const out = await ok(call, "adjust_guide", { guide: GUIDE_FOR(localDate(-1)), queue: true });
    assert.equal(out.queued.queued, out.adjusted, "only a change is worth a decision");
    const plain = await ok(call, "adjust_guide", { guide: GUIDE_FOR(localDate(-1)) });
    assert.equal(plain.queued, null);
    assert.equal((await ok(call, "list_approvals")).items.length, out.adjusted ? 1 : 0);
  });
});

test("e2e demo: from / to are accepted wherever since / until and startdate / enddate are; both given and different is an error", async () => {
  await withDemo(async (call) => {
    const since = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const until = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const old = await ok(call, "list_workouts", { since, until, limit: 100 });
    const alias = await ok(call, "list_workouts", { from: since, to: until, limit: 100 });
    assert.deepEqual(alias.payload, old.payload);
    assert.ok(old.payload.length > 0);
    const same = await ok(call, "list_workouts", { from: since, since, to: until, until, limit: 100 });
    assert.deepEqual(same.payload, old.payload, "both names with the same value are fine");
    const clash = await call("list_workouts", { since, from: until });
    assert.equal(clash.isError, true);
    assert.match(clash.text, /from and since mean the same thing but differ/);
    assert.match((await call("list_workouts", { until, to: since })).text, /to and until mean the same thing but differ/);

    const [start, end] = [`${localDate(8)}T00:00:00`, `${localDate(2)}T23:59:59`];
    const stats = await ok(call, "get_daily_activity_statistics", { startdate: start, enddate: end });
    const statsAlias = await ok(call, "get_daily_activity_statistics", { from: start, to: end });
    assert.deepEqual(statsAlias.data, stats.data);
    assert.deepEqual((await ok(call, "get_daily_activity_statistics", { startdate: start, enddate: end, from: start, to: end })).data, stats.data);
    assert.match((await call("get_daily_activity_statistics", { startdate: start, from: end, enddate: end })).text, /from and startdate mean the same thing but differ/);
    assert.match((await call("get_daily_activity_statistics", { startdate: start, enddate: end, to: start })).text, /to and enddate mean the same thing but differ/);
    assert.match((await call("get_daily_activity_statistics", { startdate: start })).text, /to \(or enddate\) is required/);
    assert.match((await call("get_daily_activity_statistics", {})).text, /from \(or startdate\) is required/);
  });
});

test("e2e demo: get_data_overview shows the in-memory counts, no paths, and changes nothing", async () => {
  await withDemo(async (call) => {
    await call("queue_adjustment", { kind: "adjusted_guide", payload: GUIDE_FOR(localDate(-1)) });
    const o = await ok(call, "get_data_overview");
    assert.equal(o.inMemory, true);
    const by = Object.fromEntries(o.files.map((f: any) => [f.name, f]));
    assert.deepEqual(Object.keys(by), ["journal", "plan", "seen", "predictions", "experiments", "approvals"]);
    assert.ok(by.predictions.counts.predictions >= 30 && by.journal.counts.entries > 0, "the demo ledger and journal");
    assert.deepEqual([by.approvals.counts, by.approvals.status, by.approvals.path], [{ approvals: 1, unresolved: 1 }, "in-memory", null]);
    assert.equal(by.plan.status, "missing", "no plan stored yet");
    assert.deepEqual(o.directories.map((d: any) => [d.name, d.status]), [["cache", "in-memory"], ["archive", "in-memory"], ["reports", "in-memory"]]);
    assert.deepEqual(o.warnings, []);
  });
});
