import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTokens } from "./storage.js";
import { exportHealthCsv, saveLastExportedDate } from "./export-health.js";
import { localDate } from "./api.js";

const origFetch = globalThis.fetch;
const prevStatePath = process.env.SUUNTO_HEALTH_EXPORT_STATE_PATH;
let tmp: string;
let statePath: string;
let cfg: any;

// Local dates, like the code under test: a day is "finished" by the local calendar.
function today(): string {
  return localDate(0);
}
function daysAgo(n: number): string {
  return localDate(n);
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

test("exportHealthCsv: today's partial total is never exported — health-skill cannot dedupe it", async () => {
  const result = await exportHealthCsv(cfg, { healthRoot: tmp, since: daysAgo(3) });
  const csv = await readFile(result.csvPath, "utf8");
  const dates = csv.trim().split("\n").slice(1).map((line) => line.split(",")[0]);
  assert.deepEqual(dates, [daysAgo(3), daysAgo(2), daysAgo(1)]);
  assert.ok(!dates.includes(today()));
});

test("exportHealthCsv: two runs on the same day never emit the same date twice", async () => {
  const first = await exportHealthCsv(cfg, { healthRoot: tmp });
  saveLastExportedDate(first.maxDate!);
  const second = await exportHealthCsv(cfg, { healthRoot: tmp });
  assert.equal(second.rowCount, 0, "everything completed is already synced; today is not exported");
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

test("exportHealthCsv: an unreadable state file stops the sync — it is not a first run (that would export the last 27 days twice)", async () => {
  for (const content of ["{ not json", "", "{}", '{"lastDate":""}', '{"lastDate":"yesterday"}', '{"lastDate":20260927}', "null"]) {
    await writeFile(statePath, content);
    await assert.rejects(() => exportHealthCsv(cfg, { healthRoot: tmp }), /can't be used[\s\S]*a second time/, JSON.stringify(content));
  }
  await writeFile(statePath, JSON.stringify({ lastDate: daysAgo(2) }));
  const ok = await exportHealthCsv(cfg, { healthRoot: tmp });
  assert.equal(ok.rowCount, 1, "with a good watermark only yesterday is new");
});

test("saveLastExportedDate: writes the watermark whole and leaves no temp file", async () => {
  saveLastExportedDate("2026-09-27");
  saveLastExportedDate("2026-09-28");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { lastDate: "2026-09-28" });
  assert.deepEqual((await readdir(tmp)).filter((f) => f.includes(".tmp-")), []);
});
