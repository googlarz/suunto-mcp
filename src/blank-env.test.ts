import { test } from "node:test";
import assert from "node:assert/strict";
import { dropBlankEnv } from "./blank-env.js";
import { loadConfig } from "./config.js";

test("dropBlankEnv: removes blank SUUNTO_* and PORT values so ?? defaults apply", () => {
  const env: NodeJS.ProcessEnv = { SUUNTO_TOKEN_PATH: "", SUUNTO_DAILY_PREFIX: "", PORT: "", SUUNTO_CLIENT_ID: "abc" };
  dropBlankEnv(env);
  assert.equal("SUUNTO_TOKEN_PATH" in env, false);
  assert.equal("SUUNTO_DAILY_PREFIX" in env, false);
  assert.equal("PORT" in env, false);
  assert.equal(env.SUUNTO_CLIENT_ID, "abc", "non-blank values are untouched");
});

test("dropBlankEnv: leaves unrelated blank variables alone", () => {
  const env: NodeJS.ProcessEnv = { HTTP_PROXY: "", SUUNTO_APP_NAME: "" };
  dropBlankEnv(env);
  assert.equal(env.HTTP_PROXY, "", "not ours to touch");
  assert.equal("SUUNTO_APP_NAME" in env, false);
});

test("regression: a blank SUUNTO_TOKEN_PATH no longer reaches loadConfig as an empty path", () => {
  const saved = { p: process.env.SUUNTO_TOKEN_PATH, d: process.env.SUUNTO_DAILY_PREFIX };
  try {
    process.env.SUUNTO_TOKEN_PATH = "";
    process.env.SUUNTO_DAILY_PREFIX = "";
    // Before the fix this returned tokenPath "" (ENOENT open '' during pairing).
    assert.equal(loadConfig().tokenPath, "");
    dropBlankEnv();
    assert.match(loadConfig().tokenPath, /\.suunto-mcp[\\/]tokens\.json$/);
    assert.equal(process.env.SUUNTO_DAILY_PREFIX, undefined);
  } finally {
    if (saved.p === undefined) delete process.env.SUUNTO_TOKEN_PATH;
    else process.env.SUUNTO_TOKEN_PATH = saved.p;
    if (saved.d === undefined) delete process.env.SUUNTO_DAILY_PREFIX;
    else process.env.SUUNTO_DAILY_PREFIX = saved.d;
  }
});
