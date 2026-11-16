import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// index.ts connects its stdio transport at import time, so it can't be
// imported and asserted on — run the real compiled server and speak MCP to
// it. Uses dist-test/ (compiled by `npm test`), not dist/, because CI runs
// tests before the build step. The server starts in an empty temp cwd with
// no SUUNTO_* variables, so it cannot pick up the developer's real .env and
// every assertion here holds with zero credentials.
const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));

async function withServer(fn: (call: (method: string, params?: unknown) => Promise<any>) => Promise<void>, extraEnv: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "suunto-smoke-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("SUUNTO_") && k !== "PORT"),
  );
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [serverPath], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (msg: any) => void>();
  const noise: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    } catch {
      noise.push(line); // stray stdout text corrupts the MCP protocol for strict clients
    }
  });
  let nextId = 1;
  const call = (method: string, params: unknown = {}) =>
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
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await fn(call);
    assert.deepEqual(noise, [], "the server wrote non-JSON-RPC output to stdout");
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("stdio: reports the package.json version, not a hardcoded one", async () => {
  const expected = JSON.parse(await readFile(pkgPath, "utf8")).version;
  await withServer(async (call) => {
    const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    assert.equal(init.result.serverInfo.version, expected);
  });
});

// tools that touch local files only and never read Suunto
const LOCAL_ONLY = ["log_session", "set_plan", "get_plan", "get_archive_status", "log_prediction", "void_prediction", "get_prediction_stats", "start_experiment", "get_experiment", "log_experiment_day", "stop_experiment", "queue_adjustment", "list_approvals", "get_data_overview"];

test("stdio: every tool has a title and annotations consistent with what it does", async () => {
  await withServer(async (call) => {
    const { tools } = (await call("tools/list")).result;
    assert.ok(tools.length >= 24, `expected at least 24 tools, got ${tools.length}`);
    for (const t of tools) {
      assert.ok(t.title && t.title.length > 3, `${t.name}: missing title`);
      assert.ok(t.annotations, `${t.name}: missing annotations`);
      assert.equal(typeof t.annotations.readOnlyHint, "boolean", `${t.name}: readOnlyHint must be explicit`);
      assert.equal(t.annotations.openWorldHint, !LOCAL_ONLY.includes(t.name), `${t.name}: talks to Suunto's cloud (${LOCAL_ONLY.join(", ")} alone are local files)`);

      // get_catchup and get_weekly_report read by name but are not read-only: markSeen: true and save: true write a local file
      const catchup = t.name === "get_catchup" || t.name === "get_weekly_report";
      const readsOnly = /^(get|list|export|compare|forecast|adjust|estimate|analyze|draft|propose|simulate)_/.test(t.name) && !catchup;
      const writes = /^(push|delete|upload|generate|log|set|archive|void|score|start|stop|queue|resolve)_/.test(t.name) || catchup;
      assert.ok(readsOnly !== writes, `${t.name}: unclassified tool name — add it to a rule here and to tool-meta.ts`);
      assert.equal(t.annotations.readOnlyHint, readsOnly, `${t.name}: readOnlyHint disagrees with its name`);
      if (/^(push_.*_guide|delete_guide|generate_daily_digest|log_session)$/.test(t.name)) {
        assert.equal(t.annotations.destructiveHint, true, `${t.name}: overwrites or deletes, must be flagged destructive`);
      }
      // a replace wipes the stored plan; get_catchup only writes a small marker and is the same call twice
      if (t.name === "set_plan") assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      if (t.name === "get_catchup") assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      // the report's save writes one local file, and overwrite: true can replace a different one (destructive); the same call twice leaves the same file
      if (t.name === "get_weekly_report") assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
      if (t.name === "estimate_route_time") assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: true });
      // archive_workouts writes only new local files and reads Suunto: not destructive, not idempotent (each call archives more), open-world
      if (t.name === "archive_workouts") assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      if (t.name === "get_archive_status") assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false });
      // 1.1: the prediction ledger and the experiments only add to their files (nothing replaced), but a void and a stop cannot be undone (destructive); a new prediction or experiment is a new entry (not idempotent); a void, a stop and a day log
      // repeated leave the same state (idempotent); score_predictions scores the next batch each call (not idempotent) and reads Suunto
      const NEW: Record<string, object> = {
        log_prediction: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        void_prediction: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        score_predictions: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        get_prediction_stats: { readOnlyHint: true, openWorldHint: false },
        start_experiment: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        get_experiment: { readOnlyHint: true, openWorldHint: false },
        log_experiment_day: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        analyze_experiment: { readOnlyHint: true, openWorldHint: true },
        stop_experiment: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        draft_session_log: { readOnlyHint: true, openWorldHint: true },
        // 1.2: planning tools: they read Suunto and return a proposal or a what-if, and write nothing
        propose_next_week: { readOnlyHint: true, openWorldHint: true },
        adjust_guide: { readOnlyHint: true, openWorldHint: true }, // as in 1.1.0: it returns a spec and a queuePayload, queues nothing
        // 1.2: the approval queue: only resolve_approval can lead to a push, and only with push: true on an approve; it never overwrites. Not idempotent: an approve without push can be followed by the push itself
        queue_adjustment: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        list_approvals: { readOnlyHint: true, openWorldHint: false },
        resolve_approval: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        get_data_overview: { readOnlyHint: true, openWorldHint: false },
        simulate_plan: { readOnlyHint: true, openWorldHint: true },
      };
      if (t.name in NEW) assert.deepEqual(t.annotations, NEW[t.name], t.name);
    }
  });
});

test("stdio: an unknown tool name is reported as unknown, not masked by missing credentials", async () => {
  await withServer(async (call) => {
    const res = (await call("tools/call", { name: "no_such_tool", arguments: {} })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Unknown tool: no_such_tool/);
  });
});

test("stdio: invalid arguments are rejected before any credential or API work", async () => {
  await withServer(async (call) => {
    const res = (await call("tools/call", { name: "list_workouts", arguments: { limit: -1 } })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Invalid arguments for list_workouts/);
  });
});

test("stdio: set_plan and get_plan work with no Suunto credentials (they only touch a local file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-plan-smoke-"));
  const planFile = join(dir, "plan.json");
  try {
    await withServer(async (call) => {
      const set = (await call("tools/call", { name: "set_plan", arguments: { goal: "no creds" } })).result;
      assert.notEqual(set.isError, true, set.content[0].text);
      const got = (await call("tools/call", { name: "get_plan", arguments: {} })).result;
      assert.notEqual(got.isError, true, got.content[0].text);
      assert.equal(JSON.parse(got.content[0].text).plan.goal, "no creds");
      // a tool that reads Suunto still needs them
      const snap = (await call("tools/call", { name: "get_catchup", arguments: {} })).result;
      assert.equal(snap.isError, true);
      assert.match(snap.content[0].text, /SUUNTO_CLIENT_ID|credentials/i);
    }, { SUUNTO_PLAN_PATH: planFile });
    assert.equal(JSON.parse(await readFile(planFile, "utf8")).plan.goal, "no creds");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI: get-plan works with no Suunto credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-plan-cli-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>;
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [serverPath, "get-plan"], { cwd: dir, env: { ...env, SUUNTO_PLAN_PATH: join(dir, "plan.json") }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c));
      child.stderr.on("data", (c: Buffer) => (stderr += c));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).plan, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stdio and CLI: get_archive_status needs no Suunto credentials, creates nothing, and reports a damaged record without touching it; archive_workouts still needs them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-archive-smoke-"));
  const archive = join(dir, "archive");
  const key = "5e1f7c0de000000000000001";
  try {
    await withServer(async (call) => {
      const st = JSON.parse((await call("tools/call", { name: "get_archive_status", arguments: {} })).result.content[0].text);
      assert.deepEqual([st.archived, st.dir, st.problems], [0, archive, []]);
      const w = (await call("tools/call", { name: "archive_workouts", arguments: {} })).result;
      assert.equal(w.isError, true);
      assert.match(w.content[0].text, /SUUNTO_CLIENT_ID|credentials/i);
    }, { SUUNTO_ARCHIVE_DIR: archive });
    await assert.rejects(stat(archive), /ENOENT/, "reading the status does not create the folder");

    await mkdir(archive);
    await writeFile(join(archive, `${key}.json`), "not an archive record");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>;
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [serverPath, "get-archive-status"], { cwd: dir, env: { ...env, SUUNTO_ARCHIVE_DIR: archive }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c));
      child.stderr.on("data", (c: Buffer) => (stderr += c));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(out.code, 0, out.stderr);
    const status = JSON.parse(out.stdout);
    assert.equal(status.archived, 0);
    assert.equal(status.problems[0].workoutKey, key);
    assert.equal(await readFile(join(archive, `${key}.json`), "utf8"), "not an archive record");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
