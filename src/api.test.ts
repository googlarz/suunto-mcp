import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTokens } from "./storage.js";
import { SuuntoClient, retryDelayMs, nextRetryDelayMs } from "./api.js";
import {
  SuuntoApiError,
  SuuntoAuthError,
  SuuntoEmptyResponseError,
  SuuntoEndpointUnavailableError,
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

test("api: gateway 401 RateLimitExceeded is a rate limit, fails fast, and is not retried", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response('{"statusCode":401,"message":"Rate limit is exceeded (RateLimitExceeded)"}', { status: 401 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/247samples/sleep"),
    (err: unknown) =>
      err instanceof SuuntoRateLimitError &&
      !(err instanceof SuuntoAuthError) &&
      /Wait about 2 minutes/.test(err.message),
  );
  assert.equal(n, 1);
});

test("api: gateway 401 OperationNotFound is 'endpoint unavailable', not an auth failure", async () => {
  globalThis.fetch = (async () =>
    new Response('{"message":"Access denied (OperationNotFound)"}', { status: 401 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/v2/subscriptions"),
    (err: unknown) =>
      err instanceof SuuntoEndpointUnavailableError &&
      err instanceof SuuntoApiError &&
      !(err instanceof SuuntoAuthError) &&
      err.status === 401 &&
      /OperationNotFound/.test(err.body) &&
      /not an authentication problem/.test(err.message),
  );
});

test("api: a 401 with any other body stays an auth error", async () => {
  globalThis.fetch = (async () =>
    new Response('{"message":"Access denied due to invalid subscription key"}', { status: 401 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/v3/workouts/"),
    (err: unknown) => err instanceof SuuntoAuthError && !(err instanceof SuuntoEndpointUnavailableError),
  );
});

test("api: a 200 with an empty body is NotFound, not 'Unexpected end of JSON input'", async () => {
  globalThis.fetch = (async () => new Response("", { status: 200 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.getWorkout("000000000000000000000000"),
    (err: unknown) => err instanceof SuuntoNotFoundError && /empty body/.test(err.message),
  );
});

test("api: a malformed workout key is rejected before any request", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("{}", { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  for (const bad of ["", "not-a-key", "6aba8afee2ab172bb4c5fc8", "../workouts/6aba8afee2ab172bb4c5fc8d", "6aba8afee2ab172bb4c5fc8dd"]) {
    await assert.rejects(() => c.getWorkout(bad), (err: unknown) => err instanceof SuuntoNotFoundError);
    await assert.rejects(() => c.getWorkoutFit(bad), (err: unknown) => err instanceof SuuntoNotFoundError);
  }
  assert.equal(n, 0);
});

test("api: a real 24-hex workout key reaches /v3/workouts/{key}", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await c.getWorkout("6aba8afee2ab172bb4c5fc8d");
  await c.getWorkoutFit("6ABA8AFEE2AB172BB4C5FC8D");
  assert.deepEqual(urls, [
    "https://cloudapi.suunto.com/v3/workouts/6aba8afee2ab172bb4c5fc8d",
    "https://cloudapi.suunto.com/v3/workouts/6ABA8AFEE2AB172BB4C5FC8D/fit",
  ]);
});

test("api: list_* range tools reject from > to instead of returning an empty list", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("[]", { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  for (const call of [() => c.listSleep("2026-09-10", "2026-09-01"), () => c.listRecovery("2026-09-10", "2026-09-01"), () => c.listDailyActivity("2026-09-10", "2026-09-01")]) {
    await assert.rejects(call, /must be on or before/);
  }
  assert.equal(n, 0);
  await c.listSleep("2026-09-01", "2026-09-01"); // a single day is fine
  assert.equal(n, 1);
});

test("api: a 403 on the FIT download says an unknown key is the likely cause, and stays a Forbidden error", async () => {
  globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.getWorkoutFit("000000000000000000000000"),
    (err: unknown) =>
      err instanceof SuuntoForbiddenError && /check the key against list_workouts/.test(err.message) && err.body.startsWith("Forbidden"),
  );
  // other endpoints keep the plain message
  await assert.rejects(
    () => c.json<any>("/v2/test"),
    (err: unknown) => err instanceof SuuntoForbiddenError && !/list_workouts/.test(err.message),
  );
});

test("api: getDailyStats rewrites a +0200 offset to +02:00 (Suunto answers 400 to the former) and leaves other forms alone", async () => {
  const seen: string[][] = [];
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url));
    seen.push([u.searchParams.get("startdate")!, u.searchParams.get("enddate")!]);
    return new Response("[]", { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await c.getDailyStats("2026-09-27T00:00:00+0200", "2026-09-27T23:59:59+0200");
  await c.getDailyStats("2026-09-27T00:00:00+02:00", "2026-09-27T23:59:59-05:30");
  await c.getDailyStats("2026-09-27T00:00:00", "2026-09-27T23:59:59");
  await c.getDailyStats("2026-01-05T00:00-0100", "2026-01-05T23:59-0100");
  assert.deepEqual(seen, [
    ["2026-09-27T00:00:00+02:00", "2026-09-27T23:59:59+02:00"],
    ["2026-09-27T00:00:00+02:00", "2026-09-27T23:59:59-05:30"],
    ["2026-09-27T00:00:00", "2026-09-27T23:59:59"],
    ["2026-01-05T00:00-01:00", "2026-01-05T23:59-01:00"],
  ]);
});

test("api: getWorkoutWithExtensions asks for the named extensions on the validated key", async () => {
  let url = "";
  globalThis.fetch = (async (u: any) => {
    url = String(u);
    return new Response("{}", { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await c.getWorkoutWithExtensions("6aba8afee2ab172bb4c5fc8d", ["ManualLapStreamExtension", "SummaryExtension"]);
  assert.equal(url, "https://cloudapi.suunto.com/v3/workouts/6aba8afee2ab172bb4c5fc8d?extensions=ManualLapStreamExtension,SummaryExtension");
  await assert.rejects(() => c.getWorkoutWithExtensions("nope", ["SummaryExtension"]), (err: unknown) => err instanceof SuuntoNotFoundError);
});

test("api: Retry-After is honoured but capped at 30 s", () => {
  assert.equal(retryDelayMs(2, 0), 2000);
  assert.equal(retryDelayMs(3600, 0), 30_000);
  assert.equal(retryDelayMs(-5, 0) >= 500, true, "a negative header is ignored, not slept on");
  // no header → exponential backoff with jitter, attempt 0 is 500–750 ms
  const d = retryDelayMs(0, 0);
  assert.ok(d >= 500 && d < 750, `backoff ${d}`);
});

test("api: the total time spent retrying is bounded at 45 s, not 4 x the per-wait cap", () => {
  assert.equal(nextRetryDelayMs(30, 0, 0), 30_000, "the first 30 s wait fits");
  assert.equal(nextRetryDelayMs(90, 0, 0), null, "asked to wait 90 s: a capped retry would fail again, so give up");
  assert.equal(nextRetryDelayMs(30, 1, 30_000), null, "a second 30 s wait would reach 60 s — give up instead");
  assert.equal(nextRetryDelayMs(10, 1, 30_000), 10_000, "30 s + 10 s = 40 s fits");
  assert.equal(nextRetryDelayMs(15, 1, 30_000), 15_000, "exactly 45 s is allowed");
  assert.equal(nextRetryDelayMs(16, 1, 30_000), null, "46 s is not");
  // plain backoff (no header): 0.5+1+2+4 s ≈ 7.5 s in total always fits
  let waited = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const d = nextRetryDelayMs(0, attempt, waited);
    assert.notEqual(d, null);
    waited += d!;
  }
  assert.ok(waited < 10_000);
});

test("api: an empty 200 is its own NotFound subclass, so callers can tell it from a plain 404", async () => {
  globalThis.fetch = (async () => new Response("  \n", { status: 200 })) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(
    () => c.json<any>("/247samples/sleep"),
    (err: unknown) => err instanceof SuuntoEmptyResponseError && err instanceof SuuntoNotFoundError && err.name === "SuuntoEmptyResponseError",
  );
});

test("api: list_* range tools reject dates that are not real calendar dates (the CLI passes raw arguments)", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("[]", { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-9-1", "2026-09-02"], ["2026-09-01", "tomorrow"], ["", ""], ["2026-13-01", "2026-13-02"]]) {
    await assert.rejects(() => c.listSleep(from, to), /not a valid calendar date/);
    await assert.rejects(() => c.listRecovery(from, to), /not a valid calendar date/);
  }
  for (const bad of ["2026-02-30", "2026-9-1", "tomorrow", "", "2026-13-01"]) {
    await assert.rejects(() => c.getDailyActivity(bad), /not a valid calendar date/);
    await assert.rejects(() => c.getSleep(bad), /not a valid calendar date/);
    await assert.rejects(() => c.getRecovery(bad), /not a valid calendar date/);
  }
  assert.equal(n, 0);
});

test("api: the two unavailable workout endpoints still validate the key before any request", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("{}", { status: 200 });
  }) as any;
  const c = new SuuntoClient(cfg);
  await assert.rejects(() => c.getWorkoutSamples("nope"), (err: unknown) => err instanceof SuuntoNotFoundError);
  await assert.rejects(() => c.getWorkoutGpx("nope"), (err: unknown) => err instanceof SuuntoNotFoundError);
  assert.equal(n, 0);
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
  // evening bedtimes: each is the night of its own date
  const unsorted = [
    { timestamp: "2026-04-03T22:00:00Z", sleepScore: 80 },
    { timestamp: "2026-04-01T22:00:00Z", sleepScore: 70 },
    { timestamp: "2026-04-02T22:00:00Z", sleepScore: 75 },
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ payload: unsorted }), { status: 200 })) as any;
  const c = new SuuntoClient(cfg);
  const out = await c.listSleep("2026-04-01", "2026-04-03");
  assert.deepEqual(
    out.payload.map((e: any) => e.timestamp),
    ["2026-04-01T22:00:00Z", "2026-04-02T22:00:00Z", "2026-04-03T22:00:00Z"],
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
    // a wide window around the date; rows are placed by their own local date (see day-windows.test.ts)
    assert.equal(u.searchParams.get("from"), String(Date.UTC(2026, 3, 20) - 14 * 3_600_000));
    assert.equal(u.searchParams.get("to"), String(Date.UTC(2026, 3, 22) - 1));
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
