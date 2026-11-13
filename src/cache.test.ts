import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CACHE_SCHEMA, MIN_AGE_MS, readCache, writeCache } from "./cache.js";

const pkgVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const KEY = "5e1f7c0de000000000000001";
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const OLD = NOW - 3 * MIN_AGE_MS;

async function withCache<T>(fn: (dir: string) => Promise<T>, env: Record<string, string> = {}): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "suunto-cache-"));
  const dir = join(root, "nested", "cache");
  const saved = { dir: process.env.SUUNTO_CACHE_DIR, off: process.env.SUUNTO_CACHE };
  process.env.SUUNTO_CACHE_DIR = dir;
  delete process.env.SUUNTO_CACHE;
  Object.assign(process.env, env);
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of [["SUUNTO_CACHE_DIR", saved.dir], ["SUUNTO_CACHE", saved.off]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("cache: write then read round-trips; the directory is 0700, the file 0600, no temp file is left", async () => {
  await withCache(async (dir) => {
    assert.equal(await readCache(KEY), null, "nothing cached yet");
    assert.equal(await writeCache(KEY, OLD, { a: 1 }, NOW), true);
    assert.deepEqual(await readCache(KEY), { a: 1 });
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, `${KEY}.json`))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), [`${KEY}.json`]);
  });
});

test("cache: an entry with another schema number is ignored", async () => {
  await withCache(async (dir) => {
    await writeCache(KEY, OLD, { a: 1 }, NOW);
    const file = join(dir, `${KEY}.json`);
    const entry = JSON.parse(await readFile(file, "utf8"));
    assert.equal(entry.schema, CACHE_SCHEMA);
    await writeFile(file, JSON.stringify({ ...entry, schema: CACHE_SCHEMA + 1 }));
    assert.equal(await readCache(KEY), null);
    await writeFile(file, "{ not json");
    assert.equal(await readCache(KEY), null, "a corrupt file is a miss, not an error");
  });
});

test("cache: a workout that started less than 24 h ago is not cached; exactly 24 h is", async () => {
  await withCache(async (dir) => {
    assert.equal(await writeCache(KEY, NOW - MIN_AGE_MS + 1, { a: 1 }, NOW), false);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
    assert.equal(await writeCache(KEY, null, { a: 1 }, NOW), false, "no start time: age unknown");
    assert.equal(await writeCache(KEY, NOW - MIN_AGE_MS, { a: 1 }, NOW), true);
  });
});

test("cache: SUUNTO_CACHE=off neither reads nor writes", async () => {
  await withCache(async (dir) => {
    await writeCache(KEY, OLD, { a: 1 }, NOW);
    process.env.SUUNTO_CACHE = "off";
    assert.equal(await readCache(KEY), null, "an existing entry is not read");
    assert.equal(await writeCache("5e1f7c0de000000000000002", OLD, { b: 2 }, NOW), false);
    assert.deepEqual(await readdir(dir), [`${KEY}.json`], "nothing new was written");
  });
});

test("cache: a key that is not 24 hex characters is rejected before any path is built", async () => {
  await withCache(async (dir) => {
    for (const bad of ["../../etc/passwd", "5e1f7c0de00000000000000", "5e1f7c0de0000000000000011", "zzzzzzzzzzzzzzzzzzzzzzzz", "", "5e1f7c0de000000000000001/../x"]) {
      await assert.rejects(readCache(bad), /not a workout key/, bad);
      await assert.rejects(writeCache(bad, OLD, {}, NOW), /not a workout key/, bad);
    }
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });
});

test("cache: an upper-case key reads the same entry as its lower-case form", async () => {
  await withCache(async () => {
    await writeCache("ABCDEF0123456789ABCDEF01", OLD, { a: 1 }, NOW);
    assert.deepEqual(await readCache("abcdef0123456789abcdef01"), { a: 1 });
  });
});

test("cache: an entry written by another version of the server is ignored; ours carries the package version", async () => {
  await withCache(async (dir) => {
    await writeCache(KEY, OLD, { a: 1 }, NOW);
    const file = join(dir, `${KEY}.json`);
    const entry = JSON.parse(await readFile(file, "utf8"));
    assert.equal(entry.version, pkgVersion);
    assert.deepEqual(await readCache(KEY), { a: 1 });
    await writeFile(file, JSON.stringify({ ...entry, version: "0.0.0-other" }));
    assert.equal(await readCache(KEY), null, "same schema number, other server version");
    const { version: _gone, ...noVersion } = entry;
    await writeFile(file, JSON.stringify(noVersion));
    assert.equal(await readCache(KEY), null, "an entry without a version is from before versions were recorded");
  });
});

test("cache: a folder that cannot be created makes the write return false, not throw", async () => {
  await withCache(async (dir) => {
    await writeCache(KEY, OLD, { a: 1 }, NOW); // creates `dir`
    process.env.SUUNTO_CACHE_DIR = join(dir, `${KEY}.json`, "below-a-file");
    assert.equal(await writeCache("5e1f7c0de000000000000002", OLD, { b: 2 }, NOW), false);
  });
});
