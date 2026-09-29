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

async function withServer(fn: (call: (method: string, params?: unknown) => Promise<any>) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "suunto-smoke-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("SUUNTO_") && k !== "PORT"),
  );
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
      assert.equal(t.annotations.openWorldHint, true, `${t.name}: talks to Suunto's cloud`);

      const readsOnly = /^(get|list|export)_/.test(t.name);
      const writes = /^(push|delete|upload|generate)_/.test(t.name);
      assert.ok(readsOnly !== writes, `${t.name}: unclassified tool name — add it to a rule here and to tool-meta.ts`);
      assert.equal(t.annotations.readOnlyHint, readsOnly, `${t.name}: readOnlyHint disagrees with its name`);
      if (/^(push_.*_guide|delete_guide|generate_daily_digest)$/.test(t.name)) {
        assert.equal(t.annotations.destructiveHint, true, `${t.name}: overwrites or deletes, must be flagged destructive`);
      }
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
