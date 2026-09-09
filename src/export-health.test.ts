import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTokens } from "./storage.js";
import { exportHealthCsv, saveLastExportedDate } from "./export-health.js";

const origFetch = globalThis.fetch;
const prevStatePath = process.env.SUUNTO_HEALTH_EXPORT_STATE_PATH;
let tmp: string;
let statePath: string;
let cfg: any;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Every date in the window gets the same step count — enough to exercise
// the watermark logic without needing per-date fixtures.
function mockFetchWithSteps(steps: number) {
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url));
    if (u.pathname.includes("/oauth/")) {
      return new Response("{}", { status: 200 });
    }
    const start = u.searchParams.get("startdate")!.slice(0, 10);
    const end = u.searchParams.get("enddate")!.slice(0, 10);
    const samples = [];
    for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      samples.push({ TimeISO8601: `${d.toISOString().slice(0, 10)}T00:00:00Z`, Value: steps });
    }
    return new Response(
      JSON.stringify([{ Name: "stepcount", Sources: [{ Samples: samples }] }]),
      { status: 200 },
    );
  }) as any;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "suunto-export-"));
  const tokenPath = join(tmp, "tokens.json");
  await saveTokens(tokenPath, { accessToken: "t", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
  cfg = { clientId: "cid", clientSecret: "sec", subscriptionKey: "key", redirectUri: "x", tokenPath };
  statePath = join(tmp, "state.json");
  process.env.SUUNTO_HEALTH_EXPORT_STATE_PATH = statePath;
  mockFetchWithSteps(4000);
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  if (prevStatePath === undefined) delete process.env.SUUNTO_HEALTH_EXPORT_STATE_PATH;
  else process.env.SUUNTO_HEALTH_EXPORT_STATE_PATH = prevStatePath;
  await rm(tmp, { recursive: true });
});

test("exportHealthCsv: never advances the watermark to include today", async () => {
  const result = await exportHealthCsv(cfg, { healthRoot: tmp, since: daysAgo(3) });
  assert.ok(result.maxDate, "expected a watermark candidate");
  assert.ok(result.maxDate! < today(), `watermark ${result.maxDate} must be strictly before today (${today()})`);
});

test("exportHealthCsv: watermark is not committed by exportHealthCsv itself — only an explicit save persists it", async () => {
  await exportHealthCsv(cfg, { healthRoot: tmp, since: daysAgo(3) });
  const raw = await readFile(statePath, "utf8").catch(() => null);
  assert.equal(raw, null, "exportHealthCsv must not write the state file on its own");
});

test("saveLastExportedDate: caller-committed watermark is what the next export dedupes against", async () => {
  const first = await exportHealthCsv(cfg, { healthRoot: tmp, since: daysAgo(3) });
  saveLastExportedDate(first.maxDate!); // simulate: import succeeded, caller commits
  const second = await exportHealthCsv(cfg, { healthRoot: tmp });
  assert.ok(second.rowCount < first.rowCount, "second export should see fewer new rows after the watermark advanced");
});

test("exportHealthCsv: an explicit --since is not silently dropped by an already-advanced watermark", async () => {
  saveLastExportedDate(daysAgo(1)); // pretend everything through yesterday is already synced
  const result = await exportHealthCsv(cfg, { healthRoot: tmp, since: daysAgo(5) });
  assert.ok(result.rowCount > 0, "--since must re-export its window even though the watermark is already ahead of it");
});
