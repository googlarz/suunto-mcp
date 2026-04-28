import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, assertCredentials } from "./config.js";

const KEYS = [
  "SUUNTO_CLIENT_ID",
  "SUUNTO_CLIENT_SECRET",
  "SUUNTO_SUBSCRIPTION_KEY",
  "SUUNTO_REDIRECT_URI",
  "SUUNTO_TOKEN_PATH",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

test("config: defaults when env empty", () => {
  const c = loadConfig();
  assert.equal(c.clientId, "");
  assert.equal(c.redirectUri, "http://localhost:8421/callback");
  assert.match(c.tokenPath, /\.suunto-mcp[\\/]tokens\.json$/);
});

test("config: env values override defaults", () => {
  process.env.SUUNTO_CLIENT_ID = "cid";
  process.env.SUUNTO_REDIRECT_URI = "http://localhost:9999/cb";
  process.env.SUUNTO_TOKEN_PATH = "/tmp/x.json";
  const c = loadConfig();
  assert.equal(c.clientId, "cid");
  assert.equal(c.redirectUri, "http://localhost:9999/cb");
  assert.equal(c.tokenPath, "/tmp/x.json");
});

test("config: assertCredentials lists every missing var", () => {
  try {
    assertCredentials({
      clientId: "",
      clientSecret: "",
      subscriptionKey: "",
      redirectUri: "x",
      tokenPath: "x",
    });
    assert.fail("expected throw");
  } catch (err: any) {
    assert.match(err.message, /SUUNTO_CLIENT_ID/);
    assert.match(err.message, /SUUNTO_CLIENT_SECRET/);
    assert.match(err.message, /SUUNTO_SUBSCRIPTION_KEY/);
  }
});

test("config: assertCredentials passes when all present", () => {
  assert.doesNotThrow(() =>
    assertCredentials({
      clientId: "a",
      clientSecret: "b",
      subscriptionKey: "c",
      redirectUri: "x",
      tokenPath: "x",
    }),
  );
});
