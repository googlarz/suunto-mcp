import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTokens, saveTokens, __resetStorageCache } from "./storage.js";

const origStorageEnv = process.env.SUUNTO_TOKEN_STORAGE;
process.env.SUUNTO_TOKEN_STORAGE = "file";
__resetStorageCache();
process.on("exit", () => {
  if (origStorageEnv === undefined) delete process.env.SUUNTO_TOKEN_STORAGE;
  else process.env.SUUNTO_TOKEN_STORAGE = origStorageEnv;
});

test("storage: save then load round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-mcp-"));
  try {
    const path = join(dir, "tokens.json");
    const bundle = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 12345,
      user: "u",
    };
    await saveTokens(path, bundle);
    assert.deepEqual(await loadTokens(path), bundle);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("storage: load returns null when file missing", async () => {
  const result = await loadTokens("/nonexistent/abc/xyz.json");
  assert.equal(result, null);
});

test("storage: saved file has 0600 permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-mcp-"));
  try {
    const path = join(dir, "tokens.json");
    await saveTokens(path, {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 0,
    });
    const s = await stat(path);
    assert.equal(s.mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("storage: saveTokens creates parent dir if missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suunto-mcp-"));
  try {
    const path = join(dir, "nested", "deep", "tokens.json");
    await saveTokens(path, {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 0,
    });
    assert.ok(await loadTokens(path));
  } finally {
    await rm(dir, { recursive: true });
  }
});
