import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The new local-state tools through the real server: demo mode keeps them in memory and writes nothing, and without demo mode
// they work with no Suunto credentials at all, on the files the environment names.
const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const fixedClock = new URL("../test-fixtures/fixed-clock.mjs", import.meta.url).href;
const throwingFetch = new URL("../test-fixtures/throwing-fetch.mjs", import.meta.url).href;

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;

async function withServer(demo: boolean, fn: (call: Call, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "suunto-state-"));
  const env: Record<string, string> = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>),
    ...(demo ? { SUUNTO_DEMO: "1" } : {}),
    TZ: "Europe/Berlin",
    FIXED_NOW: "2026-11-13T19:00:00Z", // a Friday, 20:00 in Berlin
    SUUNTO_PREDICTIONS_PATH: join(dir, "predictions.json"),
    SUUNTO_EXPERIMENTS_PATH: join(dir, "experiments.json"),
    SUUNTO_JOURNAL_PATH: join(dir, "journal.json"),
    SUUNTO_CACHE_DIR: join(dir, "cache"),
    SUUNTO_PLAN_PATH: join(dir, "plan.json"),
    SUUNTO_SEEN_PATH: join(dir, "seen.json"),
    SUUNTO_TOKEN_PATH: join(dir, "tokens.json"),
  };
  const child = spawn(process.execPath, ["--import", fixedClock, "--import", throwingFetch, serverPath], { cwd: dir, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    } catch {
      /* stdout purity is asserted by the stdio smoke test */
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no response to ${method} within 30s`)), 30_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "state", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await fn(async (name, args = {}) => {
      const r = (await rpc("tools/call", { name, arguments: args })).result;
      const text: string = r.content[0].text;
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* an error message */
      }
      return { isError: r.isError === true, text, json };
    }, dir);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = (dir: string) => readdir(dir);

test("demo: the prediction and experiment tools work on in-memory state and write no file, even with every path set", async () => {
  await withServer(true, async (call, dir) => {
    const stats0 = (await call("get_prediction_stats")).json;
    assert.equal(stats0.demo, true);
    assert.equal(stats0.overall.logged, 32, "the deterministic demo ledger");
    const logged = await call("log_prediction", { date: "2026-11-14", kind: "session_done", probability: 0.7, rule: "demo-rule" });
    assert.equal(logged.isError, false, logged.text);
    assert.equal(logged.json.saved.id, "p33");
    assert.equal((await call("get_prediction_stats")).json.overall.logged, 33, "state lives in memory across calls");
    const voided = await call("void_prediction", { id: "p33", reason: "test" });
    assert.equal(voided.json.voided.reason, "test");
    const scored = await call("score_predictions");
    assert.deepEqual([scored.isError, scored.json.scored.length, scored.json.remaining], [false, 20, 12]);
    assert.equal((await call("score_predictions")).json.remaining, 0);

    const exp = (await call("get_experiment")).json;
    assert.equal(exp.experiments.length, 1);
    assert.equal(exp.experiments[0].status, "finished");
    const started = await call("start_experiment", { name: "Demo too", intervention: "a", control: "b", metric: "hrv", days: 14 });
    assert.equal(started.isError, false, started.text);
    assert.equal(started.json.experiment.id, "e2");
    assert.equal((await call("log_experiment_day", { id: "e2", followed: true, date: "2026-11-14" })).isError, true, "tomorrow is not loggable");
    assert.equal((await call("stop_experiment", { id: "e2", reason: "demo" })).json.stopped.reason, "demo");
    const analysis = (await call("analyze_experiment", { id: "e1" })).json;
    assert.deepEqual([analysis.demo, analysis.exploratory, analysis.intentionToTreat.nIntervention], [true, false, 14]);
    const draft = await call("draft_session_log", { date: "2026-11-13" });
    assert.equal(draft.isError, false, draft.text);

    assert.deepEqual(await exists(dir), [], "nothing was created in the folder the paths point into");
  });
});

test("demo: log_session stays a no-op (its note), and draft_session_log writes nothing either", async () => {
  await withServer(true, async (call, dir) => {
    const d = (await call("draft_session_log", { date: "2026-11-13" })).json;
    assert.equal(d.status, "ok");
    const r = await call("log_session", { workoutKey: d.workoutKey, note: "x", source: "draft" });
    assert.match(r.text, /Demo mode: nothing was written/);
    assert.deepEqual(await exists(dir), []);
  });
});

test("without demo mode the local tools need no Suunto credentials and write their files (0600), and the reading ones need none either", async () => {
  await withServer(false, async (call, dir) => {
    assert.equal((await call("get_prediction_stats")).json.overall.logged, 0);
    const p = await call("log_prediction", { date: "2026-11-14", kind: "hrv_in_band", probability: 0.5 });
    assert.equal(p.isError, false, p.text);
    assert.equal(JSON.parse(await readFile(join(dir, "predictions.json"), "utf8")).predictions[0].id, "p1");
    assert.equal((await stat(join(dir, "predictions.json"))).mode & 0o777, 0o600);
    assert.equal((await call("void_prediction", { id: "p1", reason: "r" })).json.alreadyVoided, false);

    const e = await call("start_experiment", { name: "X", intervention: "do", control: "don't", metric: "sleepScore", days: 14 });
    assert.equal(e.isError, false, e.text);
    assert.equal(e.json.experiment.startDate, "2026-11-14");
    assert.equal((await call("get_experiment")).json.experiments[0].status, "upcoming");
    assert.equal((await call("log_experiment_day", { followed: true })).isError, true, "no experiment is running yet");
    assert.equal((await call("stop_experiment", { id: "e1", reason: "r" })).isError, false);
    assert.equal((await stat(join(dir, "experiments.json"))).mode & 0o777, 0o600);

    // what reads Suunto still needs credentials
    for (const [name, args] of [["score_predictions", {}], ["analyze_experiment", { early: true }], ["draft_session_log", { date: "2026-11-13" }]] as const) {
      const r = await call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /SUUNTO_CLIENT_ID|credentials|token/i, name);
    }
    assert.deepEqual((await exists(dir)).sort(), ["experiments.json", "predictions.json"]);
  });
});

test("tools: bad arguments are refused before anything is read or written", async () => {
  await withServer(false, async (call, dir) => {
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ["log_prediction", { date: "2026-11-14", kind: "weather", probability: 0.5 }, /Invalid arguments for log_prediction.*kind/],
      ["log_prediction", { date: "2026-11-14", kind: "session_done", probability: 1.5 }, /probability.*<= 1/],
      ["log_prediction", { kind: "session_done", probability: 0.5 }, /missing required property "date"/],
      ["log_prediction", { date: "0123456789abcdef01234567", kind: "reps_hit", probability: 0.5, exercise: "Squat", sets: 3, reps: 5 }, /Invalid arguments for log_prediction.*date/],
      ["log_prediction", { date: "2026-11-13", kind: "session_done", probability: 0.5 }, /must be after today \(2026-11-13\)/],
      ["log_prediction", { about: "2026-11-14", date: "2026-11-14", kind: "session_done", probability: 0.5 }, /about is not a known field/],
      ["void_prediction", { id: "p1" }, /missing required property "reason"/],
      ["start_experiment", { name: "X", intervention: "a", control: "b", metric: "steps", days: 14 }, /metric.*one of/],
      ["start_experiment", { name: "X", intervention: "a", control: "b", metric: "hrv", days: 13 }, /days.*>= 14/],
      ["start_experiment", { name: "X", intervention: "a", control: "b", metric: "hrv", days: 14, washout: 3 }, /washout.*<= 2/],
      ["start_experiment", { name: "X", intervention: "a", control: "b", metric: "hrv", days: 14, eligible: ["funday"] }, /one of: mon/],
      ["log_experiment_day", {}, /missing required property "followed"/],
      ["stop_experiment", { id: "e1" }, /missing required property "reason"/],
      ["draft_session_log", { workoutKey: "abc" }, /does not match required pattern|at least 24/],
      ["log_session", { workoutKey: "0123456789abcdef01234567", note: "x", source: "manual" }, /source.*one of: draft/],
    ];
    for (const [name, args, re] of bad) {
      const r = await call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, re, name);
    }
    assert.deepEqual(await exists(dir), []);
  });
});

async function cli(dir: string, args: string[], extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [serverPath, ...args], { cwd: dir, env: { ...env, SUUNTO_PREDICTIONS_PATH: join(dir, "predictions.json"), SUUNTO_EXPERIMENTS_PATH: join(dir, "experiments.json"), ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI: get-prediction-stats and get-experiment need no credentials, create nothing and refuse a damaged file; the Suunto-reading ones need credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-state-cli-"));
  try {
    const stats = await cli(dir, ["get-prediction-stats"]);
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual([JSON.parse(stats.stdout).overall.logged, JSON.parse(stats.stdout).overall.verdict], [0, "insufficient"]);
    const exp = await cli(dir, ["get-experiment"]);
    assert.equal(exp.code, 0, exp.stderr);
    assert.deepEqual(JSON.parse(exp.stdout).experiments, []);
    assert.deepEqual(await readdir(dir), [], "reading creates no file");

    assert.equal((await cli(dir, ["get-prediction-stats", "extra"])).code, 1);
    assert.equal((await cli(dir, ["get-experiment", "e1", "e2"])).code, 1);
    assert.match((await cli(dir, ["get-experiment", "e1"])).stderr, /no experiment e1/);

    await writeFile(join(dir, "predictions.json"), "{ broken");
    const bad = await cli(dir, ["get-prediction-stats"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /predictions\.json is not valid JSON/);
    assert.equal(await readFile(join(dir, "predictions.json"), "utf8"), "{ broken");
    await writeFile(join(dir, "experiments.json"), JSON.stringify({ version: 2, experiments: [] }));
    assert.match((await cli(dir, ["get-experiment"])).stderr, /experiments version 2, but this server reads and writes version 1 only/);

    for (const args of [["analyze-experiment"], ["draft-session-log", "0123456789abcdef01234567"]]) {
      const r = await cli(dir, args);
      assert.equal(r.code, 1, args[0]);
      assert.match(r.stderr, /SUUNTO_CLIENT_ID|credentials/i, args[0]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
