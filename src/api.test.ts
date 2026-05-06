import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTokens } from "./storage.js";
import { SuuntoClient } from "./api.js";
import {
  SuuntoApiError,
  SuuntoAuthError,
  SuuntoForbiddenError,
  SuuntoNotFoundError,
  SuuntoRateLimitError,
} from "./errors.js";

const origFetch = globalThis.fetch;
let tmp: string;
let cfg: any;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "suunto-api-"));
  const path = join(tmp, "tokens.json");
  await saveTokens(path, {
    accessToken: "valid-token",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
  });
  cfg = {
    clientId: "cid",
    clientSecret: "sec",
    subscriptionKey: "sub-key",
    redirectUri: "x",
    tokenPath: path,
  };
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  await rm(tmp, { recursive: true });
});

test("api: sends bearer token + subscription key", async () => {
  let captured: any;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  const data = await c.json<any>("/v2/test");
  assert.equal(captured.url, "https://cloudapi.suunto.com/v2/test");
  assert.equal(captured.headers.Authorization, "Bearer valid-token");
  assert.equal(captured.headers["Ocp-Apim-Subscription-Key"], "sub-key");
  assert.deepEqual(data, { ok: true });
});

test("api: retries on 429 then succeeds", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (n === 1)
      return new Response("rate-limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  const data = await c.json<any>("/v2/test");
  assert.equal(n, 2);
  assert.deepEqual(data, { ok: true });
});

test("api: retries on 500 then succeeds", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (n === 1) return new Response("oops", { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await c.json<any>("/v2/test");
  assert.equal(n, 2);
});

test("api: 4xx (non-429) errors are not retried", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("bad", { status: 400 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/v2/test"),
    (err: unknown) => err instanceof SuuntoApiError && (err as SuuntoApiError).status === 400,
  );
  assert.equal(n, 1);
});

test("api: 401 throws SuuntoAuthError", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/v2/test"),
    (err: unknown) => err instanceof SuuntoAuthError,
  );
});

test("api: 403 throws SuuntoForbiddenError", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 403 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/v2/test"),
    (err: unknown) => err instanceof SuuntoForbiddenError,
  );
});

test("api: 404 throws SuuntoNotFoundError", async () => {
  globalThis.fetch = (async () => new Response("missing", { status: 404 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/v2/test"),
    (err: unknown) => err instanceof SuuntoNotFoundError,
  );
});

test("api: 429 after retries exhausted throws SuuntoRateLimitError with retryAfter", async () => {
  globalThis.fetch = (async () =>
    new Response("rate", {
      status: 429,
      headers: { "retry-after": "0" },
    })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/v2/test"),
    (err: unknown) => err instanceof SuuntoRateLimitError,
  );
});

test("api: bytes() returns raw Buffer", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 })) as any;
  const c = new SuuntoClient(cfg);
  const out = await c.bytes("/v2/raw");
  assert.deepEqual(Array.from(out), [1, 2, 3, 4]);
});

test("api: listWorkouts auto-paginates until limit reached", async () => {
  let call = 0;
  let secondOffset: string | null = null;
  globalThis.fetch = (async (url: any) => {
    call++;
    const u = new URL(String(url));
    if (call === 1) {
      assert.equal(u.searchParams.get("offset"), "0");
      assert.equal(u.searchParams.get("limit"), "50");
      return new Response(
        JSON.stringify({
          payload: Array.from({ length: 50 }, (_, i) => ({ workoutKey: `w${i}` })),
        }),
        { status: 200 },
      );
    }
    secondOffset = u.searchParams.get("offset");
    return new Response(
      JSON.stringify({
        payload: Array.from({ length: 5 }, (_, i) => ({ workoutKey: `w${50 + i}` })),
      }),
      { status: 200 },
    );
  }) as any;

  const c = new SuuntoClient(cfg);
  const out = await c.listWorkouts({ limit: 55 });
  assert.equal(call, 2);
  assert.equal(out.payload.length, 55);
  assert.equal(secondOffset, "50");
});

test("api: listWorkouts stops when first page satisfies limit", async () => {
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    return new Response(
      JSON.stringify({
        payload: Array.from({ length: 5 }, (_, i) => ({
          workoutKey: `w${i}`,
          startTime: 100 - i,
        })),
      }),
      { status: 200 },
    );
  }) as any;
  const c = new SuuntoClient(cfg);
  const out = await c.listWorkouts({ limit: 10 });
  assert.equal(out.payload.length, 5);
  assert.equal(call, 1);
});

test("api: listWorkouts honors since parameter", async () => {
  let captured: string | null = null;
  globalThis.fetch = (async (url: any) => {
    captured = new URL(String(url)).searchParams.get("since");
    return new Response(JSON.stringify({ payload: [] }), { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await c.listWorkouts({ since: 1234, limit: 10 });
  assert.equal(captured, "1234");
});

test("api: listDailyActivity sorts payload chronologically by timestamp", async () => {
  const unsorted = [
    { timestamp: "2026-04-03T00:00:00Z", steps: 3 },
    { timestamp: "2026-04-01T00:00:00Z", steps: 1 },
    { timestamp: "2026-04-02T00:00:00Z", steps: 2 },
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ payload: unsorted }), { status: 200 })) as any;
  const c = new SuuntoClient(cfg);
  const out = await c.listDailyActivity("2026-04-01", "2026-04-03");
  assert.deepEqual(
    out.payload.map((e: any) => e.timestamp),
    ["2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", "2026-04-03T00:00:00Z"],
  );
});

test("api: listSleep sorts payload chronologically by timestamp", async () => {
  const unsorted = [
    { timestamp: "2026-04-03T00:00:00Z", sleepScore: 80 },
    { timestamp: "2026-04-01T00:00:00Z", sleepScore: 70 },
    { timestamp: "2026-04-02T00:00:00Z", sleepScore: 75 },
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ payload: unsorted }), { status: 200 })) as any;
  const c = new SuuntoClient(cfg);
  const out = await c.listSleep("2026-04-01", "2026-04-03");
  assert.deepEqual(
    out.payload.map((e: any) => e.timestamp),
    ["2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", "2026-04-03T00:00:00Z"],
  );
});

test("api: listRecovery sorts payload chronologically by timestamp", async () => {
  const unsorted = [
    { timestamp: "2026-04-03T00:00:00Z", Balance: 0.6 },
    { timestamp: "2026-04-01T00:00:00Z", Balance: 0.8 },
    { timestamp: "2026-04-02T00:00:00Z", Balance: 0.7 },
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ payload: unsorted }), { status: 200 })) as any;
  const c = new SuuntoClient(cfg);
  const out = await c.listRecovery("2026-04-01", "2026-04-03");
  assert.deepEqual(
    out.payload.map((e: any) => e.timestamp),
    ["2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", "2026-04-03T00:00:00Z"],
  );
});

test("api: daily-prefix override is applied", async () => {
  const prev = process.env.SUUNTO_DAILY_PREFIX;
  process.env.SUUNTO_DAILY_PREFIX = "/v3/daily";
  try {
    let capturedUrl = "";
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as any;
    const c = new SuuntoClient(cfg);
    await c.getSleep("2026-04-20");
    const u = new URL(capturedUrl);
    assert.equal(u.pathname, "/v3/daily/sleep");
    assert.equal(u.searchParams.get("from"), String(Date.parse("2026-04-20T00:00:00.000Z")));
    assert.equal(u.searchParams.get("to"), String(Date.parse("2026-04-20T23:59:59.999Z")));
  } finally {
    if (prev === undefined) delete process.env.SUUNTO_DAILY_PREFIX;
    else process.env.SUUNTO_DAILY_PREFIX = prev;
  }
});

test("api: getDailyStats passes ISO-8601 params to /247/daily-activity-statistics", async () => {
  let capturedUrl = "";
  globalThis.fetch = (async (url: any) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify([]), { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await c.getDailyStats("2026-04-01T00:00:00", "2026-04-30T23:59:59");
  const u = new URL(capturedUrl);
  assert.equal(u.pathname, "/247/daily-activity-statistics");
  assert.equal(u.searchParams.get("startdate"), "2026-04-01T00:00:00");
  assert.equal(u.searchParams.get("enddate"), "2026-04-30T23:59:59");
});
