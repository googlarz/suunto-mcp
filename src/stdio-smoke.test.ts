import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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

test("stdio: every tool has a title and annotations consistent with what it does", async () => {
  await withServer(async (call) => {
    const { tools } = (await call("tools/list")).result;
    assert.ok(tools.length >= 24, `expected at least 24 tools, got ${tools.length}`);
    for (const t of tools) {
      assert.ok(t.title && t.title.length > 3, `${t.name}: missing title`);
      assert.ok(t.annotations, `${t.name}: missing annotations`);
      assert.equal(typeof t.annotations.readOnlyHint, "boolean", `${t.name}: readOnlyHint must be explicit`);
      assert.equal(t.annotations.openWorldHint, !["log_session", "set_plan", "get_plan"].includes(t.name), `${t.name}: talks to Suunto's cloud (log_session, set_plan and get_plan alone are local files)`);

      // get_catchup reads by name but is not read-only: markSeen: true writes its local marker
      const catchup = t.name === "get_catchup";
      const readsOnly = /^(get|list|export|compare|forecast|adjust)_/.test(t.name) && !catchup;
      const writes = /^(push|delete|upload|generate|log|set)_/.test(t.name) || catchup;
      assert.ok(readsOnly !== writes, `${t.name}: unclassified tool name — add it to a rule here and to tool-meta.ts`);
      assert.equal(t.annotations.readOnlyHint, readsOnly, `${t.name}: readOnlyHint disagrees with its name`);
      if (/^(push_.*_guide|delete_guide|generate_daily_digest|log_session)$/.test(t.name)) {
        assert.equal(t.annotations.destructiveHint, true, `${t.name}: overwrites or deletes, must be flagged destructive`);
      }
      // a replace wipes the stored plan; get_catchup only writes a small marker and is the same call twice
      if (t.name === "set_plan") assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      if (catchup) assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
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
