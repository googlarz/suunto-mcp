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
} from "./auth.js";
import { loadTokens, saveTokens } from "./storage.js";
import { SuuntoNotAuthenticatedError, SuuntoTokenError } from "./errors.js";

const baseCfg = {
  clientId: "cid",
  clientSecret: "sec",
  subscriptionKey: "sub",
  redirectUri: "http://localhost:8421/callback",
  tokenPath: "",
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
