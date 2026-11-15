import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDocStore, memoryDocStore, serialQueue } from "./local-store.js";
import { mulberry32 } from "./prng.js";

interface Doc {
  items: number[];
}
const parse = (raw: Record<string, unknown>): Doc => {
  const extra = Object.keys(raw).find((k) => k !== "version" && k !== "items");
  if (extra !== undefined) throw new Error(`${extra} is not a known field`);
  if (!Array.isArray(raw.items)) throw new Error("items must be an array");
  return { items: raw.items as number[] };
};

async function withDir<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-store-"));
  try {
    return await fn(join(dir, "sub", "doc.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("local-store: a missing file is no document; save then load round-trips with version 1", async () => {
  await withDir(async (path) => {
    const store = fileDocStore(path, "demo", parse);
    assert.equal(await store.load(), null);
    await store.save({ items: [1, 2] });
    assert.deepEqual(await store.load(), { items: [1, 2] });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, items: [1, 2] });
  });
});

test("local-store: the file is owner-only (0600), a created folder 0700, and no temp file is left behind", async () => {
  await withDir(async (path, dir) => {
    await fileDocStore(path, "demo", parse).save({ items: [] });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "sub"))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(dir, "sub")), ["doc.json"]);
  });
});

test("local-store: damaged, foreign, other-version and invalid files are refused with the file named", async () => {
  await withDir(async (path, dir) => {
    await mkdir(join(dir, "sub"), { recursive: true });
    const store = fileDocStore(path, "demo", parse);
    const cases: [string, RegExp][] = [
      ["{not json", /is not valid JSON/],
      ["[1,2]", /is not a suunto-mcp demo file/],
      ["null", /is not a suunto-mcp demo file/],
      [JSON.stringify({ items: [] }), /version unknown, but this server reads and writes version 1 only; it is left untouched/],
      [JSON.stringify({ version: 2, items: [] }), /demo version 2, but this server reads and writes version 1 only/],
      [JSON.stringify({ version: "1", items: [] }), /version "1"/],
      [JSON.stringify({ version: 1, entries: {} }), /is invalid \(entries is not a known field\); fix or delete it/],
      [JSON.stringify({ version: 1, items: "x" }), /is invalid \(items must be an array\)/],
    ];
    for (const [content, re] of cases) {
      await writeFile(path, content);
      await assert.rejects(store.load(), (err: Error) => re.test(err.message) && err.message.includes(path), content);
      assert.equal(await readFile(path, "utf8"), content, "a refused load leaves the file as it was");
    }
  });
});

test("local-store: memory store holds a copy, never the caller's object", async () => {
  const store = memoryDocStore<Doc>();
  assert.equal(await store.load(), null);
  const doc = { items: [1] };
  await store.save(doc);
  doc.items.push(2);
  assert.deepEqual(await store.load(), { items: [1] });
  const loaded = (await store.load())!;
  loaded.items.push(3);
  assert.deepEqual(await store.load(), { items: [1] });
});

test("serialQueue: calls run one after the other, and a failure does not stop the next", async () => {
  const q = serialQueue();
  const log: string[] = [];
  const slow = q(async () => {
    await new Promise((r) => setTimeout(r, 20));
    log.push("slow");
    throw new Error("boom");
  });
  const fast = q(async () => {
    log.push("fast");
    return 7;
  });
  await assert.rejects(slow, /boom/);
  assert.equal(await fast, 7);
  assert.deepEqual(log, ["slow", "fast"]);
});

test("prng: mulberry32 is deterministic, stays in [0, 1) and differs between seeds", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const other = mulberry32(12346);
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => other()));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
});

test("prng: the first values of seed 1 are pinned (a changed generator would change every stored schedule's check)", () => {
  const g = mulberry32(1);
  assert.deepEqual([g(), g(), g()].map((x) => Math.round(x * 1e6) / 1e6), [0.627074, 0.002736, 0.527447]);
});
