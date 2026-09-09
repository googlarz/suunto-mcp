import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refresh,
  getValidAccessToken,
  __resetRefreshSingleton,
  __setCachedTokensForTest,
  withTokenLock,
} from "./auth.js";
import { loadTokens, saveTokens } from "./storage.js";
import { SuuntoNotAuthenticatedError, SuuntoTokenError } from "./errors.js";

const baseCfg = {
  clientId: "cid",
  clientSecret: "sec",
  subscriptionKey: "sub",
  redirectUri: "http://localhost:8421/callback",
  tokenPath: "",
  appName: "test-app",
  digestAveragesPath: "",
  digestHistoryPath: "",
};

const origFetch = globalThis.fetch;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "suunto-auth-"));
  __resetRefreshSingleton();
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  await rm(tmp, { recursive: true });
});

test("auth: buildAuthorizeUrl includes required oauth params", () => {
  const url = buildAuthorizeUrl(baseCfg, "stateXYZ");
  const u = new URL(url);
  assert.equal(
    u.origin + u.pathname,
    "https://cloudapi-oauth.suunto.com/oauth/authorize",
  );
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(
    u.searchParams.get("redirect_uri"),
    "http://localhost:8421/callback",
  );
  assert.equal(u.searchParams.get("state"), "stateXYZ");
});

test("auth: exchangeCode posts auth-code grant with Basic auth", async () => {
  let captured: any;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response(
      JSON.stringify({
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
        user: "demo",
      }),
      { status: 200 },
    );
  }) as any;

  const bundle = await exchangeCode(baseCfg, "the-code");

  assert.equal(captured.url, "https://cloudapi-oauth.suunto.com/oauth/token");
  assert.equal(captured.init.method, "POST");
  const expectedBasic = "Basic " + Buffer.from("cid:sec").toString("base64");
  assert.equal(captured.init.headers.Authorization, expectedBasic);
  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "the-code");
  assert.equal(bundle.accessToken, "AT");
  assert.equal(bundle.user, "demo");
});

test("auth: refresh uses refresh_token grant", async () => {
  let body = "";
  globalThis.fetch = (async (_url: any, init: any) => {
    body = init.body;
    return new Response(
      JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 60 }),
      { status: 200 },
    );
  }) as any;

  const bundle = await refresh(baseCfg, "the-rt");
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "the-rt");
  assert.equal(bundle.accessToken, "AT2");
});

test("auth: token error wraps response as SuuntoTokenError", async () => {
  globalThis.fetch = (async () =>
    new Response("invalid_grant", { status: 400 })) as any;
  await assert.rejects(
    () => exchangeCode(baseCfg, "x"),
    (err: unknown) =>
      err instanceof SuuntoTokenError && /400.*invalid_grant/.test((err as Error).message),
  );
});

test("auth: getValidAccessToken returns existing token if not expired", async () => {
  const path = join(tmp, "tokens.json");
  await saveTokens(path, {
    accessToken: "still-good",
    refreshToken: "rt",
    expiresAt: Date.now() + 600_000,
  });
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as any;
  const token = await getValidAccessToken({ ...baseCfg, tokenPath: path });
  assert.equal(token, "still-good");
  assert.equal(called, false);
});

test("auth: getValidAccessToken adopts a fresher token another process already wrote to disk, instead of refreshing with a stale refresh token", async () => {
  const path = join(tmp, "tokens.json");
  // Simulate: this process already had a near-expiry token cached in
  // memory from earlier (not reachable via a fresh disk load, since a
  // brand-new process always loads whatever's currently on disk).
  __setCachedTokensForTest({
    accessToken: "about-to-expire",
    refreshToken: "old-refresh-token",
    expiresAt: Date.now() + 30_000, // within the 60s refresh window
  });
  // Meanwhile, another process (a second MCP server instance, or a fresh
  // `npm run auth`) already rotated the token file on disk.
  await saveTokens(path, {
    accessToken: "rotated-by-another-process",
    refreshToken: "new-refresh-token",
    expiresAt: Date.now() + 3_600_000,
  });
  let refreshCalled = false;
  globalThis.fetch = (async () => {
    refreshCalled = true;
    // If this fires, the fix failed — it means we tried to use the stale
    // refresh token instead of noticing the fresher one already on disk.
    return new Response("invalid_grant", { status: 400 });
  }) as any;
  const token = await getValidAccessToken({ ...baseCfg, tokenPath: path });
  assert.equal(token, "rotated-by-another-process");
  assert.equal(refreshCalled, false, "must not attempt a refresh when disk already has a fresh token");
});

test("auth: getValidAccessToken refreshes when expiring within 60s", async () => {
  const path = join(tmp, "tokens.json");
  await saveTokens(path, {
    accessToken: "old",
    refreshToken: "rt",
    expiresAt: Date.now() + 30_000,
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: "fresh",
        refresh_token: "rt2",
        expires_in: 3600,
      }),
      { status: 200 },
    )) as any;
  const token = await getValidAccessToken({ ...baseCfg, tokenPath: path });
  assert.equal(token, "fresh");
  const persisted = await loadTokens(path);
  assert.equal(persisted?.accessToken, "fresh");
  assert.equal(persisted?.refreshToken, "rt2");
});

test("auth: throws SuuntoNotAuthenticatedError when token file absent", async () => {
  const path = join(tmp, "missing.json");
  await assert.rejects(
    () => getValidAccessToken({ ...baseCfg, tokenPath: path }),
    (err: unknown) => err instanceof SuuntoNotAuthenticatedError,
  );
});

test("auth: concurrent refreshes share a single in-flight request", async () => {
  const path = join(tmp, "tokens.json");
  await saveTokens(path, {
    accessToken: "old",
    refreshToken: "rt-original",
    expiresAt: Date.now() + 10_000, // expiring within 60s
  });

  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify({
        access_token: `fresh-${calls}`,
        refresh_token: `rt-${calls}`,
        expires_in: 3600,
      }),
      { status: 200 },
    );
  }) as any;

  const cfg = { ...baseCfg, tokenPath: path };
  const tokens = await Promise.all([
    getValidAccessToken(cfg),
    getValidAccessToken(cfg),
    getValidAccessToken(cfg),
    getValidAccessToken(cfg),
  ]);

  assert.equal(calls, 1, "only one refresh request should be sent");
  assert.deepEqual(new Set(tokens), new Set(["fresh-1"]));
});

// withTokenLock is tested directly, bypassing getValidAccessToken's
// in-process inFlightRefresh dedup — that dedup already prevents two
// refreshes from the SAME process, so testing through it would only prove
// the in-process case again. The actual gap this closes is two separate
// processes (no shared inFlightRefresh) racing on the same token file.
test("withTokenLock: serializes two concurrent 'processes' racing on the same lock path", async () => {
  const lockTarget = join(tmp, "tokens.json");
  const order: string[] = [];
  const holdLockFor = (label: string, ms: number) =>
    withTokenLock(lockTarget, async () => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${label}:end`);
    });
  await Promise.all([holdLockFor("A", 40), holdLockFor("B", 10)]);
  // Whichever ran first must fully finish before the other starts —
  // interleaved starts (A:start, B:start, ...) would mean no real mutex.
  assert.ok(
    (order[0] === "A:start" && order[1] === "A:end") || (order[0] === "B:start" && order[1] === "B:end"),
    `expected the first holder to finish before the second started, got: ${order.join(", ")}`,
  );
});

test("withTokenLock: reclaims a stale lock left by a crashed holder instead of blocking forever", async () => {
  const lockTarget = join(tmp, "tokens.json");
  const { mkdirSync, utimesSync } = await import("node:fs");
  const lockPath = `${lockTarget}.lock`;
  mkdirSync(lockPath);
  // Back-date the lock well past the staleness threshold, simulating a
  // process that crashed while holding it.
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  let ran = false;
  await withTokenLock(lockTarget, async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
