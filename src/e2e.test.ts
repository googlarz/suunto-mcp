import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    };
    return await fn({ cwd, env });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

async function withMcp(fn: (call: Call) => Promise<void>) {
  await withStubbedEnv(async ({ cwd, env }) => {
    const child = spawn(process.execPath, ["--import", stub, distIndex], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
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
      });
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
