import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { saveTokens } from "./storage.js";

// End to end: the real compiled server and CLI, with fetch replaced by canned
// Suunto responses (test-fixtures/fetch-stub.mjs, preloaded with --import). This
// exercises what unit tests can't: tool wiring in index.ts/cli.ts, real MCP
// framing, exit behaviour with piped stdout.
const distIndex = fileURLToPath(new URL("./index.js", import.meta.url));
const stub = new URL("../test-fixtures/fetch-stub.mjs", import.meta.url).href; // a file URL: --import needs one on Windows
const srcIndex = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function withStubbedEnv<T>(fn: (ctx: { cwd: string; env: Record<string, string> }) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "suunto-e2e-"));
  try {
    const tokenPath = join(cwd, "tokens.json");
    await saveTokens(tokenPath, { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
    const clean = Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_") && k !== "PORT") as [string, string][];
    const env = {
      ...Object.fromEntries(clean),
      SUUNTO_CLIENT_ID: "id",
      SUUNTO_CLIENT_SECRET: "sec",
      SUUNTO_SUBSCRIPTION_KEY: "key",
      SUUNTO_TOKEN_PATH: tokenPath,
      // real defaults pause 2 s between imports and 3 s before the read-back
      SUUNTO_ROUTE_IMPORT_GAP_MS: "0",
      SUUNTO_ROUTE_VERIFY_DELAY_MS: "0",
      // real defaults pause 2 s between guide pushes / uploads and between upload status polls
      SUUNTO_WRITE_GAP_MS: "0",
      SUUNTO_UPLOAD_POLL_MS: "0",
      // the history cache and the journal must never touch the real home directory
      SUUNTO_CACHE_DIR: join(cwd, "cache"),
      SUUNTO_JOURNAL_PATH: join(cwd, "journal.json"),
    };
    return await fn({ cwd, env });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

async function withMcp(fn: (call: Call, listTools: () => Promise<string[]>, toolDefs: () => Promise<any[]>, rpc: (method: string, params?: unknown) => Promise<any>) => Promise<void>, extraEnv: Record<string, string> = {}, preload = stub) {
  await withStubbedEnv(async ({ cwd, env: baseEnv }) => {
    const env = { ...baseEnv, ...extraEnv };
    const child = spawn(process.execPath, ["--import", preload, distIndex], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    const pending = new Map<number, (msg: any) => void>();
    const noise: string[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      } catch {
        noise.push(line); // anything on stdout that is not JSON-RPC corrupts the protocol
      }
    });
    let nextId = 1;
    const rpc = (method: string, params: unknown = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`no response to ${method} within 15s`)), 15_000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await fn(async (name, args = {}) => {
        const r = (await rpc("tools/call", { name, arguments: args })).result;
        return { text: r.content[0].text, isError: r.isError === true };
      }, async () => (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name), async () => (await rpc("tools/list")).result.tools, rpc);
      assert.deepEqual(noise, [], "the server wrote non-JSON-RPC output to stdout");
    } finally {
      child.kill();
    }
  });
}

const KEY = "6aba8afee2ab172bb4c5fc8d";

test("e2e get_workout_laps: compact table with kinds, guide and zones", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("get_workout_laps", { workoutKey: KEY });
    assert.equal(isError, false, text);
    assert.ok(!text.includes("\n"), "compact JSON, no pretty-printing");
    assert.ok(text.length < 2_000, `expected a small table, got ${text.length} B`);
    const out = JSON.parse(text);
    assert.equal(out.lapCount, 4);
    assert.deepEqual(out.laps.rows.map((r: any[]) => r[7]), ["step", "step", "rest", "done"], "the stopwatch-mode rest label is still a rest");
    assert.equal(out.laps.rows[0][8], "60kg 3x10 | Bench press");
    assert.deepEqual(out.guide, { id: "yn8oz6vu", name: "MONDAY" });
    assert.deepEqual(out.hrZoneTimeS, [100, 200, 50, 0, 0]);
    assert.equal(out.tss[0].value, 24.4);
    assert.deepEqual(out.checks, [], "a clean session has no findings");
    assert.equal(out.feeling, null);
  });
});

test("e2e get_workout_laps: an unknown key and a malformed key fail cleanly", async () => {
  await withMcp(async (call) => {
    const unknown = await call("get_workout_laps", { workoutKey: "000000000000000000000000" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /empty body|does not exist/);
    assert.doesNotMatch(unknown.text, /Unexpected end of JSON/);
    const malformed = await call("get_workout_laps", { workoutKey: "abc" });
    assert.equal(malformed.isError, true);
    assert.match(malformed.text, /not a workout key/);
  });
});

const CLEAN_KEY = "5e1f7c0de000000000000001";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/compare/${name}`, import.meta.url), "utf8"));

test("e2e compare_workout_to_plan: the clean fixture session with its plan matches the expected output", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("compare_workout_to_plan", { workoutKey: CLEAN_KEY, plan: fixture("clean-3ex.plan.json") });
    assert.equal(isError, false, text);
    assert.ok(!text.includes("\n"), "compact JSON, no pretty-printing");
    assert.deepEqual(JSON.parse(text), fixture("clean-3ex.expected.json"));
  });
});

test("e2e compare_workout_to_plan: without a plan the plan is read from the labels alone", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("compare_workout_to_plan", { workoutKey: CLEAN_KEY });
    assert.equal(isError, false, text);
    const out = JSON.parse(text);
    const expected = fixture("clean-3ex.expected.json");
    assert.ok(out.exercises.every((e: any) => e.plan === null));
    assert.ok(out.deviations.every((d: any) => d.basis !== "plan"));
    expected.exercises.forEach((e: any) => (e.plan = null));
    expected.deviations = expected.deviations.filter((d: any) => d.basis !== "plan");
    assert.deepEqual(out, expected);
  });
});

test("e2e compare_workout_to_plan: the stub's 4-lap session is flagged unreliable", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("compare_workout_to_plan", { workoutKey: KEY });
    assert.equal(isError, false, text);
    const out = JSON.parse(text);
    assert.equal(out.reliable, false);
    assert.deepEqual(out.deviations.map((d: any) => d.code), ["unexpected-sequence", "rest-short", "missing-set"]);
  });
});

test("e2e compare_workout_to_plan: invalid input is rejected before any request", async () => {
  await withMcp(async (call) => {
    const bad: Record<string, unknown>[] = [
      { workoutKey: CLEAN_KEY, plan: [] },
      { workoutKey: CLEAN_KEY, plan: [{ sets: 3 }] },
      { workoutKey: CLEAN_KEY, plan: [{ name: "x", sets: 0 }] },
    ];
    for (const args of bad) {
      const r = await call("compare_workout_to_plan", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, /Invalid arguments for compare_workout_to_plan/);
    }
    const malformed = await call("compare_workout_to_plan", { workoutKey: "abc" });
    assert.equal(malformed.isError, true);
    assert.match(malformed.text, /not a workout key/);
  });
});

test("e2e tools/list: compare_workout_to_plan is listed as read-only", async () => {
  await withMcp(async (_call, _names, toolDefs) => {
    const tool = (await toolDefs()).find((t: any) => t.name === "compare_workout_to_plan");
    assert.ok(tool, "listed");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.title, "Compare workout to plan");
  });
});

test("e2e get_workout_rest_profile: the clean fixture session, rests joined to the FIT's heart rate", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("get_workout_rest_profile", { workoutKey: CLEAN_KEY });
    assert.equal(isError, false, text);
    assert.ok(!text.includes("\n"), "compact JSON");
    assert.ok(text.length < 8_000, `expected a small result, got ${text.length} B`);
    const out = JSON.parse(text);
    assert.equal(out.workoutKey, CLEAN_KEY);
    assert.equal(out.status, "ok");
    assert.equal(out.restMode, "countdown");
    assert.equal(out.reliable, true);
    assert.deepEqual(out.rests.map((r: any) => [r.exerciseN, r.exercise, r.set, r.actualDurationS]), [[1, "Back Squat", 1, 120], [1, "Back Squat", 2, 120], [2, "Bench Press", 1, 90], [2, "Bench Press", 2, 90], [3, "Seated Cable Row", 1, 60]]);
    const first = out.rests[0]; // lap 3: HR falls from 138 to 101 over 123.4-243.4 s
    assert.ok(first.peakHr >= 134 && first.peakHr <= 138, `peak ${first.peakHr}`);
    assert.ok(first.peakAtS >= 0 && first.peakAtS <= 3, `peak at ${first.peakAtS} s`);
    assert.ok(first.endHr >= 101 && first.endHr <= 104, `end ${first.endHr}`);
    assert.ok(first.t20S !== null && first.t20S > 50 && first.t20S < 80, `t20 ${first.t20S}`);
    assert.ok(first.coverage >= 0.99, `coverage ${first.coverage}`);
    assert.deepEqual(out.perExercise.map((e: any) => e.name), ["Back Squat", "Bench Press", "Seated Cable Row"]);
    assert.equal(out.alignment.workoutStartSource, "laps.startTime");
    assert.equal(out.alignment.startSkewS, 0);
    assert.deepEqual(out.developer.fields, [{ name: "rest_recovery", units: "bpm", devIdx: 0, fieldNo: 0, baseType: 2 }]);
    assert.deepEqual(out.developer.devChannels, ["rest_recovery"]);
  });
});

test("e2e get_workout_rest_profile: the plan is accepted and checked like compare_workout_to_plan", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("get_workout_rest_profile", { workoutKey: CLEAN_KEY, plan: fixture("clean-3ex.plan.json") });
    assert.equal(isError, false, text);
    assert.equal(JSON.parse(text).rests.length, 5);
  });
});

test("e2e get_workout_rest_profile: invalid input is rejected before any request", async () => {
  await withMcp(async (call) => {
    for (const args of [{}, { workoutKey: "" }, { workoutKey: CLEAN_KEY, plan: [] }, { workoutKey: CLEAN_KEY, plan: [{ sets: 3 }] }]) {
      const r = await call("get_workout_rest_profile", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, /Invalid arguments for get_workout_rest_profile/);
    }
    const malformed = await call("get_workout_rest_profile", { workoutKey: "abc" });
    assert.equal(malformed.isError, true);
    assert.match(malformed.text, /not a workout key/);
  });
});

test("e2e tools/list: get_workout_rest_profile is listed as read-only", async () => {
  await withMcp(async (_call, _names, toolDefs) => {
    const tool = (await toolDefs()).find((t: any) => t.name === "get_workout_rest_profile");
    assert.ok(tool, "listed");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.title, "Get workout rest recovery profile");
    assert.match(tool.description, /Read-only\.$/);
  });
});

test("e2e get_workout_fit: the summary carries the developer fields", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("get_workout_fit", { workoutKey: CLEAN_KEY });
    assert.equal(isError, false, text);
    const out = JSON.parse(text);
    assert.deepEqual(out.developer.devChannels, ["rest_recovery"]);
  });
});

test("e2e get_sleep / list_sleep: the night of a date, one row per sleep, longest revision", async () => {
  await withMcp(async (call) => {
    const night = JSON.parse((await call("get_sleep", { date: "2026-09-27" })).text);
    assert.deepEqual(night.map((r: any) => [r.entryData.SleepId, r.entryData.Duration]), [[1, 27000], [2, 17000], [3, 5400]], "23:10, 03:31 and the 08:00 nap are all the night of the 27th");
    const next = JSON.parse((await call("get_sleep", { date: "2026-09-28" })).text);
    assert.deepEqual(next.map((r: any) => r.entryData.SleepId), [4], "the afternoon nap starts the next night");
    const range = JSON.parse((await call("list_sleep", { from: "2026-09-27", to: "2026-09-28" })).text);
    assert.deepEqual(range.map((r: any) => r.entryData.SleepId), [1, 2, 3, 4]);
    assert.deepEqual(JSON.parse((await call("get_sleep", { date: "2026-09-29" })).text), []);
  });
});

test("e2e get_daily_snapshot: the night before the date, the day's recovery, steps and energy", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("get_daily_snapshot", { date: "2026-09-28" });
    assert.equal(isError, false, text);
    assert.ok(!text.includes("\n"), "compact JSON");
    const snap = JSON.parse(text);
    assert.equal(snap.sleepNightOf, "2026-09-27");
    assert.equal(snap.sleep.main.sleepId, 1);
    assert.equal(snap.sleep.main.durationS, 27000);
    assert.deepEqual(snap.sleep.naps.map((n: any) => n.sleepId), [3]);
    assert.equal(snap.recovery.samples, 48);
    assert.deepEqual(snap.activity, { steps: 1234, energyKcal: 2390 });
    assert.deepEqual(snap.workouts, [], "the stub's workouts are on the 27th");
    assert.deepEqual(snap.errors, []);
    const day27 = JSON.parse((await call("get_daily_snapshot", { date: "2026-09-27" })).text);
    assert.equal(day27.workouts.length, 3);
    assert.equal(day27.sleep.main, null, "no sleep began between noon on the 26th and noon on the 27th");
  });
});

test("e2e get_daily_snapshot with `to`: each day matches the single-day call; a range over 14 days is refused", async () => {
  await withMcp(async (call) => {
    const range = JSON.parse((await call("get_daily_snapshot", { date: "2026-09-27", to: "2026-09-28" })).text);
    assert.deepEqual([range.from, range.to, range.days.map((d: any) => d.date)], ["2026-09-27", "2026-09-28", ["2026-09-27", "2026-09-28"]]);
    assert.deepEqual(range.errors, []);
    for (const day of range.days) {
      const single = JSON.parse((await call("get_daily_snapshot", { date: day.date })).text);
      assert.deepEqual({ ...single, errors: undefined, activity: undefined }, { ...day, errors: undefined, activity: undefined });
    }
    const tooLong = await call("get_daily_snapshot", { date: "2026-09-01", to: "2026-09-20" });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.text, /limited to 14 days/);
  });
});

test("e2e get_daily_snapshot: an invalid date is rejected before any request", async () => {
  await withMcp(async (call) => {
    const r = await call("get_daily_snapshot", { date: "2026-02-30" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Invalid arguments/);
  });
});

test("e2e get_training_load: the stub's three 50-TSS workouts on the 27th, rolled into CTL/ATL/TSB", async () => {
  await withMcp(
    async (call) => {
      const { text, isError } = await call("get_training_load", { date: "2026-09-28", days: 7 });
      assert.equal(isError, false, text);
      assert.ok(!text.includes("\n"), "compact JSON");
      const out = JSON.parse(text);
      assert.deepEqual([out.from, out.to, out.series.length], ["2026-09-22", "2026-09-28", 7]);
      // 150·K_CTL = 3.53, 150·K_ATL = 19.97; a rest day later 3.45 / 17.31
      assert.deepEqual(out.series.slice(-2), [
        { date: "2026-09-27", tss: 150, ctl: 3.5, atl: 20, tsb: -16.4 },
        { date: "2026-09-28", tss: 0, ctl: 3.4, atl: 17.3, tsb: -13.9 },
      ]);
      assert.deepEqual(out.current, { ctl: 3.4, atl: 17.3, tsb: -13.9, rampRate7d: 3.4 });
      assert.deepEqual(out.weeks, [
        { weekStart: "2026-09-21", workouts: 3, durationS: 5400, tss: 150 },
        { weekStart: "2026-09-28", workouts: 0, durationS: 0, tss: 0 },
      ]);
      assert.ok(out.notes.some((n: string) => /Little history/.test(n)));
      assert.ok(!out.notes.some((n: string) => /limit/.test(n)));

      const empty = JSON.parse((await call("get_training_load", { date: "2026-06-01" })).text);
      assert.ok(empty.notes.some((n: string) => /No workouts at all/.test(n)), "the stub's workouts are after the window");

      for (const args of [{ date: "2026-02-30" }, { date: "2026-09-28", days: 121 }, { date: "2026-09-28", seedCtl: -1 }]) {
        const bad = await call("get_training_load", args);
        assert.equal(bad.isError, true, JSON.stringify(args));
        assert.match(bad.text, /Invalid arguments/);
      }
    },
    { STUB_WORKOUT_TSS: "50" },
  );
});

test("e2e get_baselines: 15 stub days of history before the 25th, hand-computed band and the 25th against it", async () => {
  await withMcp(
    async (call) => {
      const { text, isError } = await call("get_baselines", { date: "2026-09-25", days: 15 });
      assert.equal(isError, false, text);
      assert.ok(!text.includes("\n"), "compact JSON");
      const out = JSON.parse(text);
      assert.deepEqual([out.date, out.from, out.to, out.days, out.errors], ["2026-09-25", "2026-09-10", "2026-09-24", 15, []]);
      // The window is k = 1..15 (k = 0 is the 25th). HRV 40 + k = 41..55: p25 = (44 + 45) / 2, median x[7] = 48, p75 = (51 + 52) / 2;
      // the last 7 days k = 1..7 -> 41..47, median 44. The 25th itself has 40, below the band.
      assert.deepEqual(out.metrics.hrv, { n: 15, median: 48, p25: 44.5, p75: 51.5, last7Median: 44, latest: 40, latestVsBand: "below" });
      assert.deepEqual(out.metrics.sleepDurationS, { n: 15, median: 25000, p25: 25000, p75: 25000, last7Median: 25000, latest: 25000, latestVsBand: "within" });
      // steps 1000 (k + 1) = 2000..16000: p25 = (5000 + 6000) / 2, median 9000, p75 = (12000 + 13000) / 2; the 25th's own 1000 is never reported
      assert.deepEqual(out.metrics.steps, { n: 15, median: 9000, p25: 5500, p75: 12500, last7Median: 5000, latest: null, latestVsBand: null });
      // waking Balance 0.5 + 0.01 k: median k = 8 -> 0.58; k = 0 -> 0.5 is below p25
      assert.equal(out.metrics.recoveryMorning.median, 0.58);
      assert.deepEqual([out.metrics.recoveryMorning.latest, out.metrics.recoveryMorning.latestVsBand], [0.5, "below"]);
      assert.deepEqual([out.metrics.recoveryLow.median, out.metrics.recoveryLow.latest], [0.38, null]);
      assert.ok(out.notes.some((n: string) => /not a medical reference/.test(n)));

      // too little history: the stub has nothing before 2026-08-17 (40 days back from the 25th)
      const thin = JSON.parse((await call("get_baselines", { date: "2026-08-01", days: 14 })).text);
      assert.equal(thin.metrics.hrv.n, 0);
      assert.equal(thin.metrics.hrv.latestVsBand, null);

      for (const args of [{ date: "2026-02-30" }, { date: "2026-09-25", days: 13 }, { date: "2026-09-25", days: 91 }, { date: "2026-09-25", days: 20.5 }]) {
        const bad = await call("get_baselines", args);
        assert.equal(bad.isError, true, JSON.stringify(args));
        assert.match(bad.text, /Invalid arguments/);
      }
    },
    { STUB_HISTORY_DAYS: "40" },
  );
});

test("e2e get_training_load: reaching the workout limit is reported", async () => {
  await withMcp(
    async (call) => {
      const out = JSON.parse((await call("get_training_load", { date: "2026-09-28" })).text);
      assert.ok(out.notes.some((n: string) => /Reached the 600-workout limit/.test(n)));
    },
    { STUB_WORKOUTS: "700" },
  );
});

test("e2e get_recovery: exactly the local day's 48 half-hour rows, in order", async () => {
  await withMcp(async (call) => {
    const rows = JSON.parse((await call("get_recovery", { date: "2026-09-27" })).text);
    assert.equal(rows.length, 48);
    assert.ok(rows.every((r: any) => r.timestamp.startsWith("2026-09-27")));
    assert.equal(rows[0].timestamp.slice(11, 16), "00:00");
    assert.equal(rows.at(-1).timestamp.slice(11, 16), "23:30");
  });
});

test("e2e get_daily_activity_statistics: an offset written +0200 is rewritten before it reaches Suunto", async () => {
  await withMcp(async (call) => {
    const ok = await call("get_daily_activity_statistics", { startdate: "2026-09-27T00:00:00+0200", enddate: "2026-09-27T23:59:59+0200" });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(JSON.parse(ok.text)[0].Sources[0].Samples[0].Value, 1234);
  });
});

test("e2e list_subscriptions: a removed endpoint is reported as such, not as an authentication problem", async () => {
  await withMcp(async (call) => {
    const r = await call("list_subscriptions");
    assert.equal(r.isError, true);
    assert.match(r.text, /no longer serves this endpoint/);
    assert.match(r.text, /not an authentication problem/);
  }, { SUUNTO_ENABLE_LEGACY_TOOLS: "1" });
});

const LEGACY = ["get_workout_samples", "export_workout_gpx", "list_subscriptions"];

test("e2e tools/list: the dead legacy tools are hidden by default", async () => {
  await withMcp(async (_call, listTools) => {
    const names = await listTools();
    assert.ok(names.includes("list_workouts"));
    for (const n of LEGACY) assert.ok(!names.includes(n), `${n} should be hidden`);
  });
});

test("e2e tools/list: SUUNTO_ENABLE_LEGACY_TOOLS=1 brings the legacy tools back", async () => {
  await withMcp(async (_call, listTools) => {
    const names = await listTools();
    for (const n of LEGACY) assert.ok(names.includes(n), `${n} should be listed`);
  }, { SUUNTO_ENABLE_LEGACY_TOOLS: "1" });
});

test("e2e: calling a hidden legacy tool explains why and how to re-enable it", async () => {
  await withMcp(async (call) => {
    for (const n of LEGACY) {
      const r = await call(n, n === "list_subscriptions" ? {} : { workoutKey: KEY });
      assert.equal(r.isError, true);
      assert.match(r.text, /no longer serves this endpoint \(OperationNotFound\)/);
      assert.match(r.text, /not an authentication problem/);
      assert.match(r.text, /SUUNTO_ENABLE_LEGACY_TOOLS=1/);
    }
  });
});

test("e2e CLI: output larger than a pipe buffer arrives whole (it used to stop at 64 KB)", async () => {
  await withStubbedEnv(async ({ cwd, env }) => {
    const child = spawn(process.execPath, ["--import", stub, distIndex, "list-workouts", "--limit", "200"], {
      cwd,
      env: { ...env, STUB_WORKOUTS: "200", STUB_PAD: "1500" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    const [code] = (await once(child, "close")) as [number];
    assert.equal(code, 0, stderr);
    const out = Buffer.concat(chunks).toString("utf8");
    assert.ok(out.length > 300_000, `only ${out.length} bytes arrived`);
    assert.equal(JSON.parse(out).payload.length, 200);
  });
});

async function runCli(args: string[]) {
  return withStubbedEnv(async ({ cwd, env }) => {
    const child = spawn(process.execPath, ["--import", stub, distIndex, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    const [code] = (await once(child, "close")) as [number];
    return { code, stdout, stderr };
  });
}

test("e2e CLI: forecast-training-load takes DATE:TSS pairs and prints the projection; a malformed pair is refused", async () => {
  const ok = await runCli(["forecast-training-load", "2026-09-29:100", "--as-of", "2026-09-28"]);
  assert.equal(ok.code, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual(out.series, [{ date: "2026-09-29", tss: 100, ctl: 2.4, atl: 13.3, tsb: -11 }]);
  for (const bad of [["2026-09-29"], ["2026-09-29:"], ["2026-09-29:abc"], []]) {
    const r = await runCli(["forecast-training-load", ...bad]);
    assert.notEqual(r.code, 0, bad.join(" "));
    assert.match(r.stderr, /Usage: forecast-training-load/);
  }
});

test("e2e CLI: get-route and export-route print the route JSON and the GPX", async () => {
  const route = await runCli(["get-route", "6acd201e1cc20768cf51aa4f"]);
  assert.equal(route.code, 0, route.stderr);
  assert.equal(JSON.parse(route.stdout).description, "Wasserfallsteig near Bad Urach");
  const gpx = await runCli(["export-route", "6acd201e1cc20768cf51aa4f"]);
  assert.equal(gpx.code, 0, gpx.stderr);
  assert.match(gpx.stdout, /<gpx[^>]*>[\s\S]*<name>Stub route<\/name>/);
});

test("e2e estimate_route_time: read-only, asks Suunto for the route GPX and refuses a one-point route; the CLI mirror and get-weekly-report refuse bad input without a request", async () => {
  await withMcp(async (call, _list, defs) => {
    const tool = (await defs()).find((t) => t.name === "estimate_route_time");
    assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: true });
    const r = await call("estimate_route_time", { routeId: "6acd201e1cc20768cf51aa4f" });
    assert.equal(r.isError, true);
    assert.match(r.text, /fewer than 2 track points/);
    const badSunset = await call("estimate_route_time", { routeId: "6acd201e1cc20768cf51aa4f", sunset: "5pm" });
    assert.equal(badSunset.isError, true);
    assert.match(badSunset.text, /UTC offset|Invalid arguments/);
  });
  const cli = await runCli(["estimate-route-time", "6acd201e1cc20768cf51aa4f", "--margin", "ten"]);
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /marginMinutes only applies together with sunset|whole number/);
  const none = await runCli(["estimate-route-time"]);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /Usage: estimate-route-time/);
  const week = await runCli(["get-weekly-report", "2026-11-03"]);
  assert.notEqual(week.code, 0);
  assert.match(week.stderr, /must be a Monday/);
});

test("e2e: downloaded bytes that are not a FIT file are refused with a clear error, however often, instead of reaching fit-file-parser (which can spin forever on them)", async () => {
  const BAD = "badf17badf17badf17badf17";
  await withMcp(async (call) => {
    // the parser used to hang on the third non-FIT input in one process; each call waits at most 15 s (withMcp's request timeout)
    for (let i = 0; i < 4; i++) {
      for (const [tool, args] of [["get_workout_fit", { workoutKey: BAD }], ["get_workout_fit", { workoutKey: BAD, full: true }], ["get_workout_rest_profile", { workoutKey: BAD }]] as const) {
        const r = await call(tool, args);
        assert.equal(r.isError, true, `${tool} round ${i}`);
        assert.match(r.text, /not a complete FIT file \(not a FIT file \(no FIT header\)\)/, tool);
      }
    }
  });
  const cli = await runCli(["get-workout-fit", BAD]);
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /not a complete FIT file/);
});

test("e2e CLI: a new command without its argument exits non-zero with the usage line", async () => {
  const r = await runCli(["compare-workout"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Usage: compare-workout <workoutKey>/);
});

test("get_workout_fit stays pretty-printed: callers slice its ~550 KB output by line range", async () => {
  const source = await readFile(srcIndex, "utf8");
  const handler = source.slice(source.indexOf('case "get_workout_fit"'), source.indexOf('case "export_workout_gpx"'));
  assert.match(handler, /JSON\.stringify\(out, null, 2\)/, "compacting this output breaks line-range slicing of spilled results");
});

test("e2e upload_workout: only .fit and .gpx files are accepted, before any request or file read", async () => {
  await withMcp(async (call) => {
    for (const filePath of ["/etc/hosts", "/Users/x/.suunto-mcp/tokens.json", "/tmp/noextension"]) {
      const r = await call("upload_workout", { filePath });
      assert.equal(r.isError, true, filePath);
      assert.match(r.text, /only accepts \.fit or \.gpx/);
    }
  });
});

const gpxFile = async (body: string, name = "route.gpx") => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(await mkdtemp(join(tmpdir(), "suunto-route-")), name);
  await writeFile(path, body);
  return path;
};

test("e2e upload_route: one route per <rte>/<trk>, named from the file, with the requested activities", async () => {
  await withMcp(async (call) => {
    const path = await gpxFile(`<?xml version="1.0"?><gpx version="1.1"><rte><name>Morning loop</name><rtept lat="1" lon="2"/></rte><trk><name>Long ride</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`);
    const r = await call("upload_route", { filePath: path, activities: [3, 5] });
    assert.equal(r.isError, false, r.text);
    const { check: _check, ...listed } = JSON.parse(r.text);
    assert.deepEqual(listed, {
      count: 2,
      routes: [
        { id: "route0", name: "Morning loop", activities: [3, 5], segments: 1 },
        { id: "route1", name: "Long ride", activities: [3, 5], segments: 1 },
      ],
    });
    assert.deepEqual(JSON.parse(r.text).check, { verified: true, watchEnabled: true, distanceM: 2469, pointsInFile: 2, pointsInRoute: 2 });
    const dflt = JSON.parse((await call("upload_route", { filePath: path })).text);
    assert.deepEqual(dflt.routes[0].activities, [1], "running is the default");
  });
});

test("e2e upload_route: only real .gpx files are accepted, before any request", async () => {
  await withMcp(async (call) => {
    const notGpx = await gpxFile("just some text", "route.gpx");
    const wrongExt = await gpxFile(`<gpx><rte><name>x</name></rte></gpx>`, "route.txt");
    for (const [filePath, pattern] of [
      [notGpx, /does not look like GPX/],
      [wrongExt, /only accepts \.gpx/],
      ["/etc/hosts", /only accepts \.gpx/],
    ] as const) {
      const r = await call("upload_route", { filePath });
      assert.equal(r.isError, true, filePath);
      assert.match(r.text, pattern);
    }
    const bad = await call("upload_route", { filePath: notGpx, activities: [] });
    assert.equal(bad.isError, true, "an empty activities list is invalid");
    assert.match(bad.text, /Invalid arguments/);
  });
});

test("e2e export_route: asks for GPX explicitly and returns the track", async () => {
  await withMcp(async (call) => {
    const r = await call("export_route", { routeId: "6acd201e1cc20768cf51aa4f" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /<gpx[^>]*>[\s\S]*<name>Stub route<\/name>/);
  });
});

test("e2e upload_route: simultaneous calls are queued, so none of them collides", async () => {
  await withMcp(async (call) => {
    const path = await gpxFile(`<?xml version="1.0"?><gpx version="1.1"><rte><name>One</name><rtept lat="1" lon="2"/></rte></gpx>`);
    const results = await Promise.all([1, 2, 3, 4].map(() => call("upload_route", { filePath: path })));
    for (const r of results) {
      assert.equal(r.isError, false, r.text);
      assert.equal(JSON.parse(r.text).check.verified, true);
    }
  });
});

test("e2e upload_route: a route that is read back disabled for the watch is reported, not hidden", async () => {
  await withMcp(
    async (call) => {
      const path = await gpxFile(`<?xml version="1.0"?><gpx version="1.1"><rte><name>One</name><rtept lat="1" lon="2"/></rte></gpx>`);
      const r = await call("upload_route", { filePath: path });
      assert.equal(r.isError, false, r.text);
      const out = JSON.parse(r.text);
      assert.equal(out.count, 1, "the import itself went through");
      assert.equal(out.check.verified, false);
      assert.equal(out.check.watchEnabled, false);
      assert.match(out.check.note, /not enabled for the watch/);
    },
    { STUB_ROUTE_WATCH: "off" },
  );
});

const guidePushes: [string, Record<string, unknown>][] = [
  ["push_workout_guide", { title: "Push A", date: "2026-10-29", exercises: [{ name: "Bench press", detail: "60kg 3x10" }] }],
  ["push_interval_guide", { title: "Intervals", date: "2026-10-29", blocks: [{ segments: [{ label: "Work", durationSec: 60 }] }] }],
  ["push_strength_guide", { title: "Gym B", date: "2026-10-29", exercises: [{ name: "Squat", detail: "80kg 3x5", sets: 3, restSec: 90 }] }],
];

test("e2e push_*_guide: simultaneous pushes are queued and each is read back from the guide list", async () => {
  await withMcp(
    async (call) => {
      const results = await Promise.all([...guidePushes, ...guidePushes].map(([name, args]) => call(name, args)));
      const ids = new Set<string>();
      for (const r of results) {
        assert.equal(r.isError, false, r.text);
        const out = JSON.parse(r.text);
        assert.deepEqual(out.check, { verified: true });
        assert.match(out.nextStep, /next normal Suunto app sync/, "existing fields are kept");
        ids.add(out.id);
      }
      assert.equal(ids.size, 6);
      const updated = JSON.parse((await call("push_workout_guide", { ...guidePushes[0][1], guideId: "guide0" })).text);
      assert.deepEqual([updated.id, updated.check], ["guide0", { verified: true }]);
    },
    { SUUNTO_APP_NAME: "app" },
  );
});

test("e2e push_strength_guide: restTargetHr outside 41-200 is rejected by the schema, in range is accepted", async () => {
  await withMcp(
    async (call) => {
      const ex = (restTargetHr: number) => ({ title: "G", date: "2026-10-29", exercises: [{ name: "Squat", detail: "80kg 3x5", sets: 3, restSec: 90, restTargetHr }] });
      for (const bad of [40, 201, 120.5]) {
        const r = await call("push_strength_guide", ex(bad));
        assert.equal(r.isError, true, `${bad}: ${r.text}`);
        assert.match(r.text, /restTargetHr/);
      }
      const ok = await call("push_strength_guide", ex(120));
      assert.equal(ok.isError, false, ok.text);
    },
    { SUUNTO_APP_NAME: "app" },
  );
});

test("e2e push_*_guide: a guide missing from the read-back is reported, not hidden", async () => {
  await withMcp(
    async (call) => {
      for (const [name, args] of guidePushes) {
        const r = await call(name, args);
        assert.equal(r.isError, false, r.text);
        const out = JSON.parse(r.text);
        assert.ok(out.id, "the push itself went through");
        assert.equal(out.check.verified, false);
        assert.match(out.check.note, /is not in the guide list/);
      }
    },
    { SUUNTO_APP_NAME: "app", STUB_GUIDE_LIST: "empty" },
  );
});

test("e2e push_*_guide: without an id in the response the guide is matched by name", async () => {
  await withMcp(
    async (call) => {
      const out = JSON.parse((await call(...guidePushes[2])).text);
      assert.deepEqual(out.check, { verified: true });
    },
    { SUUNTO_APP_NAME: "app", STUB_GUIDE_NO_ID: "1" },
  );
});

test("e2e upload_workout: simultaneous uploads are queued and polled until Suunto has processed them", async () => {
  await withMcp(async (call) => {
    const filePath = await gpxFile("not really FIT", "w.fit");
    const results = await Promise.all([1, 2, 3, 4].map(() => call("upload_workout", { filePath })));
    const ids = new Set<string>();
    for (const r of results) {
      assert.equal(r.isError, false, r.text);
      const out = JSON.parse(r.text);
      assert.equal(out.status, "Processed");
      assert.deepEqual(out.check, { verified: true });
      assert.match(out.message, /Upload initiated/, "existing fields are kept");
      ids.add(out.uploadId);
    }
    assert.equal(ids.size, 4);
  });
});

test("e2e upload_workout: an Error status or unfinished processing is verified:false with a note", async () => {
  for (const [status, note] of [["Error", /finished processing with status "Error"/], ["Processing", /had not finished after 10 status checks/]] as const) {
    await withMcp(
      async (call) => {
        const r = await call("upload_workout", { filePath: await gpxFile("x", "w.fit") });
        assert.equal(r.isError, false, r.text);
        const out = JSON.parse(r.text);
        assert.equal(out.status, status);
        assert.equal(out.check.verified, false);
        assert.match(out.check.note, note);
      },
      { STUB_UPLOAD_STATUS: status },
    );
  }
});

test("e2e get_route: one route by id with its flags; an unknown id is an error", async () => {
  await withMcp(async (call) => {
    const r = await call("get_route", { routeId: "6acd201e1cc20768cf51aa4f" });
    assert.equal(r.isError, false, r.text);
    const route = JSON.parse(r.text);
    assert.deepEqual([route.description, route.totalDistance, route.watchEnabled, route.activityIds], ["Wasserfallsteig near Bad Urach", 9669.2, true, [11]]);
    const missing = await call("get_route", { routeId: "000000000000000000000000" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /404/);
    const noId = await call("get_route", {});
    assert.equal(noId.isError, true, "routeId is required");
  });
});

test("e2e push_*_guide: a same-named guide last modified a week ago does not count as this push arriving", async () => {
  await withMcp(
    async (call) => {
      for (const [name, args] of guidePushes) {
        const r = await call(name, args);
        assert.equal(r.isError, false, r.text);
        const out = JSON.parse(r.text);
        assert.equal(out.check.verified, false);
        assert.match(out.check.note, /not modified by this push/);
      }
    },
    { SUUNTO_APP_NAME: "app", STUB_GUIDE_STALE: "1", STUB_GUIDE_NO_ID: "1" },
  );
});

test("e2e prompts: list, get, invalid params, and every tool named in a prompt exists", async () => {
  await withMcp(async (_call, listTools, _defs, rpc) => {
    const list = (await rpc("prompts/list")).result.prompts;
    assert.deepEqual(
      list.map((p: any) => [p.name, p.arguments.map((a: any) => a.name)]),
      [["suunto-morning", ["date"]], ["suunto-weekly", ["endDate"]], ["suunto-gym-today", ["date"]], ["suunto-gym-review", ["date"]]],
    );
    const tools = new Set(await listTools());
    for (const p of list) {
      const arg = p.arguments[0].name;
      const r = (await rpc("prompts/get", { name: p.name, arguments: { [arg]: "2026-10-28" } })).result;
      assert.equal(r.messages.length, 1);
      assert.equal(r.messages[0].role, "user");
      assert.equal(r.messages[0].content.type, "text");
      const named = r.messages[0].content.text.match(/\b(?:get|list|compare)_[a-z_]+\b/g) ?? [];
      assert.ok(named.length > 0, `${p.name} names no tool`);
      for (const n of named) assert.ok(tools.has(n), `${p.name} names ${n}, which tools/list does not have`);
    }
    const bad = await rpc("prompts/get", { name: "suunto-morning", arguments: { date: "2026-02-30" } });
    assert.equal(bad.error.code, -32602);
    assert.equal((await rpc("prompts/get", { name: "nope" })).error.code, -32602);
  });
});

// ---------- get_exercise_history and log_session ----------

const HISTORY_ENV = { STUB_HISTORY_LAPS: "1" };

test("e2e get_exercise_history + log_session: index, cache, by-name history, journal merge and replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-hist-e2e-"));
  const cache = join(dir, "cache");
  const journal = join(dir, "journal.json");
  try {
    await withMcp(
      async (call) => {
        const args = { date: "2026-10-05", weeks: 2 };
        const index = await call("get_exercise_history", args);
        assert.equal(index.isError, false, index.text);
        assert.ok(!index.text.includes("\n"), "compact JSON");
        const out = JSON.parse(index.text);
        assert.equal(out.from, "2026-09-22");
        assert.equal(out.sessions, 1, "the workout without laps is not a session");
        assert.deepEqual(out.exercises.map((e: any) => [e.name, e.sessions, e.lastDate, e.lastDetail]), [
          ["Back Squat", 1, "2026-10-01", "100kg 3x5"],
          ["Bench Press", 1, "2026-10-01", "70kg 3x8"],
          ["Seated Cable Row", 1, "2026-10-01", "55kg 2x12"],
        ]);
        assert.equal(out.pending, 0);
        assert.equal(out.errors.length, 1, "the workout the stub has no laps for is skipped");
        assert.equal(out.errors[0].workoutKey, "dead00000000000000000001");

        // the derived record is on disk with the documented modes; the failure is not
        assert.deepEqual(await readdir(cache), [`${CLEAN_KEY}.json`]);
        assert.equal((await stat(cache)).mode & 0o777, 0o700);
        assert.equal((await stat(join(cache, `${CLEAN_KEY}.json`))).mode & 0o777, 0o600);

        // a second call is served from it: change the file and the change shows
        const file = join(cache, `${CLEAN_KEY}.json`);
        const entry = JSON.parse(await readFile(file, "utf8"));
        entry.data.exercises[0].detail = "cached 90kg";
        await writeFile(file, JSON.stringify(entry));
        const named = JSON.parse((await call("get_exercise_history", { ...args, name: "back squat" })).text);
        const c = (n: string) => named.sessions.cols.indexOf(n);
        assert.equal(named.sessions.rows.length, 1);
        assert.equal(named.sessions.rows[0][c("detail")], "cached 90kg");
        assert.equal(named.sessions.rows[0][c("kg")], 100);
        assert.equal(named.sessions.rows[0][c("loadSource")], "label");
        assert.equal(named.sessions.rows[0][c("workoutKey")], CLEAN_KEY);
        assert.equal(typeof named.sessions.rows[0][c("restEndHr")], "number");
        assert.deepEqual(named.summary, { sessions: 1, firstLoadKg: 100, lastLoadKg: 100, restEndHrMedian: named.summary.restEndHrMedian });
        assert.ok(named.summary.restEndHrMedian >= 101 && named.summary.restEndHrMedian <= 104);

        // log what really happened; the journal wins for the load and is attached
        const first = await call("log_session", { workoutKey: CLEAN_KEY, note: "all as planned except squat set 3: 6 reps", exercises: [{ name: "Back Squat", sets: [{ reps: 5, kg: 95 }, { reps: 5, kg: 97.5 }, { reps: 6, kg: 97.5, rpe: 9 }] }] });
        assert.equal(first.isError, false, first.text);
        const firstOut = JSON.parse(first.text);
        assert.equal(firstOut.replaced, null);
        assert.equal(firstOut.entries, 1);
        assert.equal((await stat(journal)).mode & 0o777, 0o600);
        const second = JSON.parse((await call("log_session", { workoutKey: CLEAN_KEY, note: "corrected", exercises: [{ name: "Back Squat", sets: [{ reps: 5, kg: 100 }] }] })).text);
        assert.deepEqual(second.replaced, firstOut.saved, "the previous entry is handed back");
        assert.equal(second.entries, 1);
        const merged = JSON.parse((await call("get_exercise_history", { ...args, name: "Back Squat" })).text);
        const row = merged.sessions.rows[0];
        assert.equal(row[c("kg")], 100);
        assert.equal(row[c("loadSource")], "journal");
        assert.deepEqual(row[c("journal")], { note: "corrected", sets: [{ reps: 5, kg: 100 }] });

        // invalid arguments are refused and leave the journal alone
        const before = await readFile(journal, "utf8");
        for (const bad of [{ workoutKey: "abc" }, { workoutKey: CLEAN_KEY }, { workoutKey: CLEAN_KEY, note: "x", weight: 100 }, { workoutKey: CLEAN_KEY, exercises: [{ name: "x", sets: [{ reps: 5, weight: 100 }] }] }, { workoutKey: CLEAN_KEY, exercises: [{ name: "x", sets: [{ reps: 201 }] }] }, { workoutKey: CLEAN_KEY, exercises: Array.from({ length: 41 }, () => ({ name: "x" })) }, { workoutKey: CLEAN_KEY, exercises: [{ name: "x", sets: Array.from({ length: 21 }, () => ({})) }] }]) {
          const r = await call("log_session", bad);
          assert.equal(r.isError, true, JSON.stringify(bad).slice(0, 60));
        }
        assert.equal(await readFile(journal, "utf8"), before);
        for (const bad of [{ weeks: 0 }, { weeks: 27 }, { date: "2026-02-31" }, { name: "" }]) {
          const r = await call("get_exercise_history", bad);
          assert.equal(r.isError, true, JSON.stringify(bad));
          assert.match(r.text, /Invalid arguments for get_exercise_history/);
        }
      },
      { ...HISTORY_ENV, SUUNTO_CACHE_DIR: cache, SUUNTO_JOURNAL_PATH: journal },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("e2e get_exercise_history: SUUNTO_CACHE=off writes no cache entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-hist-e2e-"));
  try {
    await withMcp(
      async (call) => {
        const r = await call("get_exercise_history", { date: "2026-10-05", weeks: 2 });
        assert.equal(r.isError, false, r.text);
        assert.equal(JSON.parse(r.text).sessions, 1);
      },
      { ...HISTORY_ENV, SUUNTO_CACHE: "off", SUUNTO_CACHE_DIR: join(dir, "cache") },
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("e2e: the test environment keeps the history cache and the journal out of the real home directory", async () => {
  await withMcp(async (call) => {
    assert.equal((await call("get_exercise_history", { date: "2026-10-05", weeks: 2 })).isError, false);
    assert.equal((await call("log_session", { workoutKey: CLEAN_KEY, note: "test" })).isError, false);
  }, HISTORY_ENV);
  const home = join(homedir(), ".suunto-mcp");
  await assert.rejects(stat(join(home, "cache", `${CLEAN_KEY}.json`)), { code: "ENOENT" });
  const journalText = await readFile(join(home, "journal.json"), "utf8").catch(() => "");
  assert.ok(!journalText.includes(CLEAN_KEY), "the test journal entry reached the real journal");
});

test("e2e tools/list: get_exercise_history is read-only, log_session an idempotent local write that overwrites (destructive)", async () => {
  await withMcp(async (_call, _names, toolDefs) => {
    const defs = await toolDefs();
    const history = defs.find((t: any) => t.name === "get_exercise_history");
    const log = defs.find((t: any) => t.name === "log_session");
    assert.deepEqual(history.annotations, { readOnlyHint: true, openWorldHint: true });
    assert.deepEqual(log.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    const sch = log.inputSchema;
    assert.equal(sch.additionalProperties, false);
    assert.equal(sch.properties.exercises.items.additionalProperties, false);
    assert.equal(sch.properties.exercises.items.properties.sets.items.additionalProperties, false);
    assert.match(log.description, /nothing to log/i);
    assert.match(log.description, /unknown field/i);
    assert.match(history.description, /writes nothing but that cache/);
    assert.match(history.description, /CALL AGAIN until pending is 0/);
    assert.match(log.description, /never contacts Suunto/);
  });
});

test("e2e CLI: get-exercise-history rejects a bad --weeks before any request", async () => {
  const cases: [string, RegExp][] = [["abc", /--weeks must be a whole number/], ["0", /weeks must be a whole number from 1 to 26/]];
  for (const [weeks, re] of cases) {
    const r = await runCli(["get-exercise-history", "--weeks", weeks]);
    assert.notEqual(r.code, 0, weeks);
    assert.match(r.stderr, re);
  }
});

// ---------- forecast_training_load, adjust_guide, push_week_plan ----------

test("e2e forecast_training_load: rolls the stub's state at the end of the 28th forward, rest days included", async () => {
  await withMcp(async (call) => {
    const { text, isError } = await call("forecast_training_load", { asOf: "2026-09-28", days: [{ date: "2026-09-30", tss: 60 }, { date: "2026-09-29", tss: 0 }] });
    assert.equal(isError, false, text);
    assert.ok(!text.includes("\n"), "compact JSON");
    const out = JSON.parse(text);
    assert.deepEqual(out.start, { ctl: 3.4, atl: 17.3, tsb: -13.9 }, "get_training_load's current values on the 28th (see above)");
    // from 3.4 / 17.3: a rest day -> 3.32 / 15.0; then 60 TSS -> 4.65 / 20.99
    assert.deepEqual(out.series, [
      { date: "2026-09-29", tss: 0, ctl: 3.3, atl: 15, tsb: -11.7 },
      { date: "2026-09-30", tss: 60, ctl: 4.7, atl: 21, tsb: -16.3 },
    ]);
    const bad = await call("forecast_training_load", { asOf: "2026-09-28", days: [{ date: "2026-09-28", tss: 10 }] });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /after asOf/);
    const invalid = await call("forecast_training_load", { days: [{ date: "2026-09-29", tss: -5 }] });
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, /Invalid arguments/);
  }, { STUB_WORKOUT_TSS: "50" });
});

const weekGuide = (title: string, date: string) => ({ title, date, exercises: [{ name: "Squat", detail: "80kg 3x5", sets: 3, restSec: 90 }, { name: "Row", detail: "60kg 3x8", sets: 3, restSec: 60 }] });

test("e2e adjust_guide: HRV and waking recovery both below the stub's band -> reduced spec, nothing pushed", async () => {
  await withMcp(
    async (call) => {
      const { text, isError } = await call("adjust_guide", { date: "2026-09-25", guide: weekGuide("Legs", "2026-09-26") });
      assert.equal(isError, false, text);
      const out = JSON.parse(text);
      assert.equal(out.level, "reduced");
      assert.deepEqual(out.signals, { hrv: "below", recoveryMorning: "below" });
      assert.deepEqual(out.guide.exercises.map((e: any) => [e.sets, e.detail]), [[2, "72.5kg 2x5"], [2, "55kg 2x8"]]);
      // no history for that day: nothing to compare, nothing changed
      const none = JSON.parse((await call("adjust_guide", { date: "2026-08-01", guide: weekGuide("Legs", "2026-08-02") })).text);
      assert.deepEqual([none.level, none.adjusted], ["unchanged", false]);
      const bad = await call("adjust_guide", { guide: { title: "x", date: "2026-09-26" } });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /Invalid arguments.*exercises/);
    },
    { STUB_HISTORY_DAYS: "40" },
  );
});

test("e2e push_week_plan: dryRun is the default and makes no network call at all; dryRun false pushes one guide per date", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-week-"));
  const log = join(dir, "fetch.log");
  try {
    const guides = [weekGuide("Legs", "2026-10-02"), weekGuide("Push", "2026-09-30")];
    await withMcp(
      async (call, _list, defs) => {
        const tool = (await defs()).find((t) => t.name === "push_week_plan");
        assert.equal(tool.annotations.readOnlyHint, false, "a write tool");
        for (const args of [{ guides }, { guides, dryRun: true }]) {
          const r = await call("push_week_plan", args);
          assert.equal(r.isError, false, r.text);
          const out = JSON.parse(r.text);
          assert.equal(out.dryRun, true);
          assert.deepEqual(out.wouldPush.map((g: any) => [g.date, g.title, g.sets]), [["2026-09-30", "Push", 6], ["2026-10-02", "Legs", 6]]);
        }
        const dup = await call("push_week_plan", { guides: [guides[0], guides[0]] });
        assert.equal(dup.isError, true);
        assert.match(dup.text, /more than once/);
        const withId = await call("push_week_plan", { guides: [{ ...guides[0], guideId: "x" }] });
        assert.equal(withId.isError, true);
        assert.match(withId.text, /guideId/);
        const noEx = await call("push_week_plan", { guides: [{ title: "x", date: "2026-09-30" }] });
        assert.equal(noEx.isError, true);
        assert.match(noEx.text, /exercises/);
        // the network is only reached by a real push (and fails here: every fetch throws)
        assert.equal((await readFile(log, "utf8").catch(() => "")), "", "nothing so far touched the network");
        const real = await call("push_week_plan", { guides, dryRun: false });
        assert.equal(real.isError, true);
      },
      { SUUNTO_APP_NAME: "app", FETCH_LOG: log },
      new URL("../test-fixtures/throwing-fetch.mjs", import.meta.url).href,
    );
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(calls.length, 1, `the first push attempt failed and stopped the plan: ${calls.join(", ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await withMcp(
    async (call) => {
      const r = await call("push_week_plan", { guides: [weekGuide("Legs", "2026-10-02"), weekGuide("Push", "2026-09-30")], dryRun: false });
      assert.equal(r.isError, false, r.text);
      const out = JSON.parse(r.text);
      assert.deepEqual([out.dryRun, out.ok], [false, true]);
      assert.deepEqual(out.pushed.map((g: any) => [g.date, g.check]), [["2026-09-30", { verified: true }], ["2026-10-02", { verified: true }]]);
      assert.equal(new Set(out.pushed.map((g: any) => g.id)).size, 2, "two separate guides");
    },
    { SUUNTO_APP_NAME: "app" },
  );

  await withMcp(async (call) => {
    const r = await call("push_week_plan", { guides: [weekGuide("Legs", "2026-10-02")], dryRun: false });
    assert.equal(r.isError, true);
    assert.match(r.text, /SUUNTO_APP_NAME/);
  });
});

test("e2e get_weekly_report: assembles a past week from the stub, saves 0600 into SUUNTO_REPORTS_DIR, refuses to replace a different file, and leaks no credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-report-"));
  const reports = join(dir, "reports");
  try {
    await withMcp(
      async (call, _list, defs) => {
        const tool = (await defs()).find((t) => t.name === "get_weekly_report");
        assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
        const week = "2026-09-21"; // the stub's workouts and sleep are on 2026-09-27 / 28
        const r = await call("get_weekly_report", { week, save: true });
        assert.equal(r.isError, false, r.text);
        const out = JSON.parse(r.text);
        assert.deepEqual(out.week, { from: week, to: "2026-09-27" });
        assert.equal(out.saved.status, "written");
        assert.equal(out.saved.path, join(reports, `week-${week}.md`));
        assert.equal(await readFile(out.saved.path, "utf8"), out.markdown);
        assert.equal((await stat(out.saved.path)).mode & 0o777, 0o600);
        assert.equal((await stat(reports)).mode & 0o777, 0o700);
        assert.doesNotMatch(out.markdown, /Bearer|tokens\.json|apizone/);
        assert.doesNotMatch(out.markdown, /[0-9a-f]{24}/, "no workout key");
        const again = JSON.parse((await call("get_weekly_report", { week, save: true })).text);
        assert.equal(again.saved.status, "unchanged");
        await writeFile(out.saved.path, "my own notes");
        const refused = JSON.parse((await call("get_weekly_report", { week, save: true })).text);
        assert.equal(refused.saved.status, "refused");
        assert.equal(await readFile(out.saved.path, "utf8"), "my own notes");
        assert.equal(JSON.parse((await call("get_weekly_report", { week, save: true, overwrite: true })).text).saved.status, "overwritten");
        assert.equal((await call("get_weekly_report", { week: "2026-09-22" })).isError, true, "not a Monday");
        assert.equal((await call("get_weekly_report", { week: "2999-01-04" })).isError, true, "a week that has not ended");
      },
      { SUUNTO_REPORTS_DIR: reports, SUUNTO_CACHE: "off" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- the CLI mirrors of propose_next_week and simulate_plan ----------

async function runCliWith(args: string[], extraEnv: Record<string, string> = {}) {
  return withStubbedEnv(async ({ cwd, env }) => {
    const child = spawn(process.execPath, ["--import", stub, distIndex, ...args], { cwd, env: { ...env, SUUNTO_PLAN_PATH: join(cwd, "plan.json"), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    const [code] = (await once(child, "close")) as [number];
    return { code, stdout, stderr, files: await readdir(cwd) };
  });
}

test("e2e CLI: simulate-plan takes DATE:TSS and DATE:TITLE entries, prints the model-based what-if, and refuses a malformed entry", async () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10); // 2 days of slack either way: UTC vs local date
  const ok = await runCliWith(["simulate-plan", `${day(4)}:60`, `${day(6)}:80`, "--goal-date", day(14), "--compare", `${day(4)}:30`]);
  assert.equal(ok.code, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.modelBased, true);
  assert.deepEqual(out.sessions.map((s: any) => [s.tss, s.tssSource]), [[60, "given"], [80, "given"]]);
  assert.equal(out.goal.date, day(14));
  assert.equal(out.compare.sessions.length, 1);
  assert.deepEqual(ok.files.filter((f) => f !== "tokens.json"), [], "nothing written");
  for (const bad of [[], ["2026-11-20"], ["2026-11-20:"], [":50"], ["2026-11-20:50", "--compare", "x"]]) {
    const r = await runCliWith(["simulate-plan", ...bad]);
    assert.notEqual(r.code, 0, bad.join(" "));
    assert.match(r.stderr, /Usage: simulate-plan|is not DATE:TSS or DATE:TITLE/);
  }
  const title = await runCliWith(["simulate-plan", `${day(4)}:NO SUCH GUIDE`]);
  assert.notEqual(title.code, 0);
  assert.match(title.stderr, /no TSS estimate.*Give its tss/);
});

test("e2e CLI: propose-next-week reads the plan file, prints the proposal (here: no plan, so insufficient), writes nothing, and refuses bad rules and weeks", async () => {
  const none = await runCliWith(["propose-next-week"]);
  assert.equal(none.code, 0, none.stderr);
  const out = JSON.parse(none.stdout);
  assert.equal(out.status, "insufficient");
  assert.match(out.missing[0], /No training plan is stored/);
  assert.ok(!none.files.includes("plan.json"), "the plan file was not created");
  const badRules = await runCliWith(["propose-next-week", "--rules", "{nope"]);
  assert.notEqual(badRules.code, 0);
  assert.match(badRules.stderr, /--rules must be a JSON object/);
  const unknownRule = await runCliWith(["propose-next-week", "--rules", '{"bogus":1}']);
  assert.match(unknownRule.stderr, /rules.bogus is not a known rule/);
  const notMonday = await runCliWith(["propose-next-week", "2030-01-02"]);
  assert.match(notMonday.stderr, /is not a Monday/);
  const tooMany = await runCliWith(["propose-next-week", "2030-01-07", "2030-01-14"]);
  assert.match(tooMany.stderr, /Usage: propose-next-week/);
});

test("e2e CLI: --help lists the two new commands", async () => {
  const r = await runCliWith(["--help"]);
  assert.match(r.stdout, /propose-next-week\s+\[MONDAY/);
  assert.match(r.stdout, /simulate-plan\s+<YYYY-MM-DD:TSS/);
});
