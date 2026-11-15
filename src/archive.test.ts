import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { MAX_DOWNLOADS, archiveDir, archiveStatus, archiveWorkouts, checkFit, clearFailedDownloads, fileArchiveStore, memoryArchiveStore } from "./archive.js";
import { buildDemoFit } from "./demo-fit.js";

const NOW = new Date("2026-11-15T12:00:00Z");
const keyOf = (n: number) => n.toString(16).padStart(24, "0");
const fitFor = (n: number): Buffer => buildDemoFit({ records: [{ unixS: 1_800_000_000 + n, hr: 100 + (n % 50) }], startUnixS: 1_800_000_000 + n, elapsedS: 60, sport: 10, subSport: 20, calories: 10, avgHr: 100, maxHr: 120 });
const workout = (n: number, extra: object = {}) => ({ workoutKey: keyOf(n), activityId: 23, startTime: Date.parse("2026-11-01T07:00:00Z") + n * 86_400_000, timeOffsetInMinutes: 0, totalTime: 3600, extensions: [{ type: "SummaryExtension", apps: [] }], ...extra });

function fake(workouts: any[], opts: { fit?: (key: string) => Buffer | Error } = {}) {
  const fitCalls: string[] = [];
  const listCalls: any[] = [];
  const client = {
    listWorkouts: async (o: any) => {
      listCalls.push(o);
      return { payload: [...workouts].sort((a, b) => b.startTime - a.startTime).slice(0, o.limit ?? 25) };
    },
    getWorkoutFit: async (key: string) => {
      fitCalls.push(key);
      const r = opts.fit ? opts.fit(key) : fitFor(parseInt(key, 16));
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as SuuntoClient;
  return { client, fitCalls, listCalls };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-archive-"));
  try {
    return await fn(join(dir, "archive"));
  } finally {
    await rm(join(dir), { recursive: true, force: true });
  }
}
const ls = async (dir: string) => (await readdir(dir)).sort();
const mode = async (p: string) => (await stat(p)).mode & 0o777;

// ---------- the FIT check ----------

test("checkFit: non-empty, a 12 or 14 byte header with .FIT at byte 8, and not shorter than the header says", () => {
  const good = fitFor(1);
  assert.equal(checkFit(good), null);
  assert.match(checkFit(Buffer.alloc(0))!, /empty/);
  assert.match(checkFit(Buffer.from("<html>403 Forbidden</html>"))!, /not a FIT file/);
  assert.match(checkFit(Buffer.from("x".repeat(40)))!, /not a FIT file/);
  const bad = Buffer.from(good);
  bad[10] = 0x58; // ".FXT"
  assert.match(checkFit(bad)!, /not a FIT file/);
  const oddHeader = Buffer.from(good);
  oddHeader[0] = 13;
  assert.match(checkFit(oddHeader)!, /not a FIT file/);
  // truncated: one byte short of header + data + CRC is refused, the exact length and trailing bytes are not
  assert.match(checkFit(good.subarray(0, good.length - 1))!, /truncated/);
  assert.equal(checkFit(good.subarray(0, good.length)), null);
  assert.equal(checkFit(Buffer.concat([good, Buffer.from([0, 0])])), null);
  // a 12 byte header is valid too (dataSize 0 + 2 CRC bytes: exactly 14 bytes)
  const twelve = Buffer.from([12, 0x20, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0]);
  assert.equal(checkFit(twelve), null);
  assert.match(checkFit(twelve.subarray(0, 13))!, /truncated/);
  assert.match(checkFit(twelve.subarray(0, 11))!, /not a FIT file|too short/);
});

// ---------- archiving ----------

test("archive: copies each workout's summary and FIT into one json + one fit file per key, 0700 folder, 0600 files, nothing left over", async () => {
  await withDir(async (dir) => {
    const ws = [workout(1), workout(2), workout(3)];
    const { client, fitCalls } = fake(ws);
    const res: any = await archiveWorkouts(client, fileArchiveStore(dir), {}, NOW);
    assert.deepEqual([res.newlyArchived, res.archived, res.remaining, res.listed, res.errors, res.refused], [3, 3, 0, 3, [], []]);
    assert.deepEqual(fitCalls, [keyOf(3), keyOf(2), keyOf(1)], "newest first");
    assert.deepEqual(await ls(dir), [1, 2, 3].flatMap((n) => [`${keyOf(n)}.fit`, `${keyOf(n)}.json`]));
    assert.equal(await mode(dir), 0o700);
    for (const n of [1, 2, 3]) {
      assert.equal(await mode(join(dir, `${keyOf(n)}.fit`)), 0o600);
      assert.equal(await mode(join(dir, `${keyOf(n)}.json`)), 0o600);
      const fit = await readFile(join(dir, `${keyOf(n)}.fit`));
      assert.deepEqual(fit, fitFor(n));
      const rec = JSON.parse(await readFile(join(dir, `${keyOf(n)}.json`), "utf8"));
      assert.deepEqual(Object.keys(rec).sort(), ["archivedAt", "fit", "version", "workout", "workoutKey"]);
      assert.equal(rec.version, 1);
      assert.equal(rec.workoutKey, keyOf(n));
      assert.equal(rec.archivedAt, NOW.toISOString());
      assert.deepEqual(rec.fit, { bytes: fit.length, sha256: createHash("sha256").update(fit).digest("hex") });
      assert.deepEqual(rec.workout, ws[n - 1]);
    }
  });
});

test("archive: a second call skips what is archived (no download), and only the new workout is fetched", async () => {
  await withDir(async (dir) => {
    const ws = [workout(1), workout(2)];
    const store = fileArchiveStore(dir);
    await archiveWorkouts(fake(ws).client, store, {}, NOW);
    const again = fake(ws);
    const res: any = await archiveWorkouts(again.client, store, {}, NOW);
    assert.deepEqual([res.newlyArchived, res.alreadyArchived, res.remaining, again.fitCalls], [0, 2, 0, []]);
    const more = fake([...ws, workout(3)]);
    const res3: any = await archiveWorkouts(more.client, store, {}, NOW);
    assert.deepEqual([res3.newlyArchived, res3.archived, more.fitCalls], [1, 3, [keyOf(3)]]);
  });
});

test("archive: at most 20 downloads per call (default and maximum), the rest is reported as remaining and the next call continues", async () => {
  assert.equal(MAX_DOWNLOADS, 20);
  await withDir(async (dir) => {
    const ws = Array.from({ length: 25 }, (_, i) => workout(i + 1));
    const store = fileArchiveStore(dir);
    const a = fake(ws);
    const first: any = await archiveWorkouts(a.client, store, {}, NOW);
    assert.deepEqual([first.newlyArchived, first.remaining, a.fitCalls.length], [20, 5, 20]);
    assert.match(first.notes.join(" "), /call again/);
    const b = fake(ws);
    const second: any = await archiveWorkouts(b.client, store, {}, NOW);
    assert.deepEqual([second.newlyArchived, second.remaining, second.archived], [5, 0, 25]);
    assert.deepEqual(b.fitCalls.sort(), [1, 2, 3, 4, 5].map(keyOf).sort(), "the oldest five were left for the second call");
  });
});

test("archive: limit is 1 to 20; 0, 21 and fractions are refused before anything is read", async () => {
  const store = memoryArchiveStore();
  const { client, listCalls } = fake([workout(1)]);
  for (const limit of [0, 21, 1.5, NaN, -1]) await assert.rejects(archiveWorkouts(client, store, { limit }, NOW), /limit must be a whole number from 1 to 20/);
  assert.equal(listCalls.length, 0);
  const one: any = await archiveWorkouts(fake([workout(1), workout(2)]).client, store, { limit: 1 }, NOW);
  assert.deepEqual([one.newlyArchived, one.remaining], [1, 1]);
  const twenty: any = await archiveWorkouts(fake([workout(1), workout(2)]).client, memoryArchiveStore(), { limit: 20 }, NOW);
  assert.equal(twenty.newlyArchived, 2);
});

test("archive: a download that is empty, not a FIT file or truncated is NOT archived; the rest are, and it is retried later", async () => {
  clearFailedDownloads();
  await withDir(async (dir) => {
    const ws = [workout(1), workout(2), workout(3), workout(4)];
    const bad: Record<string, Buffer> = { [keyOf(4)]: Buffer.alloc(0), [keyOf(3)]: Buffer.from("<html>nope</html>"), [keyOf(2)]: fitFor(2).subarray(0, 20) };
    const store = fileArchiveStore(dir);
    const res: any = await archiveWorkouts(fake(ws, { fit: (k) => bad[k] ?? fitFor(parseInt(k, 16)) }).client, store, {}, NOW);
    assert.deepEqual([res.newlyArchived, res.remaining], [1, 3]);
    assert.deepEqual(res.errors.map((e: any) => e.workoutKey).sort(), [keyOf(2), keyOf(3), keyOf(4)].sort());
    assert.deepEqual(await ls(dir), [`${keyOf(1)}.fit`, `${keyOf(1)}.json`], "nothing at all was written for the failed ones");
    const healed: any = await archiveWorkouts(fake(ws).client, store, {}, NOW);
    assert.deepEqual([healed.newlyArchived, healed.remaining, healed.archived], [3, 0, 4]);
  });
});

test("archive: a download that throws is listed in errors; failing keys do not starve the others on the next call", async () => {
  clearFailedDownloads();
  const ws = [workout(3), workout(2), workout(1)];
  const store = memoryArchiveStore();
  const failing = (k: string) => (k === keyOf(3) ? new Error("HTTP 500 boom") : fitFor(parseInt(k, 16)));
  const a = fake(ws, { fit: failing });
  const first: any = await archiveWorkouts(a.client, store, { limit: 1 }, NOW);
  assert.deepEqual([first.newlyArchived, first.errors.length, first.remaining], [0, 1, 3]);
  assert.match(first.errors[0].error, /boom/);
  const b = fake(ws, { fit: failing });
  await archiveWorkouts(b.client, store, { limit: 1 }, NOW);
  assert.deepEqual(b.fitCalls, [keyOf(2)], "the key that failed is tried after the ones not tried yet");
  clearFailedDownloads();
});

test("archive: never deletes or overwrites: a damaged, foreign or mismatched record is refused, reported and left byte for byte", async () => {
  await withDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    const good = fake([workout(1)]);
    await archiveWorkouts(good.client, fileArchiveStore(dir), {}, NOW);
    const goodJson = await readFile(join(dir, `${keyOf(1)}.json`), "utf8");
    const rec = JSON.parse(goodJson);
    const files: Record<number, string> = {
      2: "{ this is not json",
      3: JSON.stringify({ ...rec, workoutKey: keyOf(3), version: 2 }),
      4: JSON.stringify({ ...rec, workoutKey: keyOf(1) }), // filed under another key
      5: JSON.stringify({ ...rec, workoutKey: keyOf(5), extra: true }),
      6: JSON.stringify([1, 2]),
      7: JSON.stringify({ ...rec, workoutKey: keyOf(7), fit: { bytes: -1, sha256: "x" } }),
    };
    for (const [n, body] of Object.entries(files)) {
      await writeFile(join(dir, `${keyOf(+n)}.json`), body);
      await writeFile(join(dir, `${keyOf(+n)}.fit`), fitFor(1)); // the FIT is there and the right size: only the record itself is wrong
    }
    const before = Object.fromEntries(await Promise.all((await ls(dir)).map(async (f) => [f, await readFile(join(dir, f))])));
    const ws = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => workout(n));
    const run = fake(ws);
    const res: any = await archiveWorkouts(run.client, fileArchiveStore(dir), {}, NOW);
    assert.deepEqual(run.fitCalls, [keyOf(8)], "only the one workout with no file is downloaded");
    assert.deepEqual(res.refused.map((r: any) => r.workoutKey).sort(), [2, 3, 4, 5, 6, 7].map(keyOf).sort());
    assert.ok(res.refused.every((r: any) => /left untouched/.test(r.problem)), JSON.stringify(res.refused));
    const why = (n: number) => res.refused.find((r: any) => r.workoutKey === keyOf(n)).problem;
    assert.match(why(2), /not a valid archive record/);
    assert.match(why(3), /version 2/);
    assert.match(why(4), /another workout's key/);
    assert.match(why(5), /extra is not a known field/);
    assert.match(why(6), /not an archive record/);
    assert.match(why(7), /fit must be/);
    assert.equal(res.newlyArchived, 1);
    for (const [f, body] of Object.entries(before)) assert.deepEqual(await readFile(join(dir, f)), body, `${f} must be untouched`);
    assert.deepEqual(await ls(dir), [...Object.keys(before), `${keyOf(8)}.fit`, `${keyOf(8)}.json`].sort());
  });
});

test("archive: a FIT file already there is never overwritten: a different one blocks that key, an identical one lets the record be completed", async () => {
  await withDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${keyOf(1)}.fit`), Buffer.from("somebody else's file"));
    await writeFile(join(dir, `${keyOf(2)}.fit`), fitFor(2)); // an interrupted earlier run
    const res: any = await archiveWorkouts(fake([workout(1), workout(2)]).client, fileArchiveStore(dir), {}, NOW);
    assert.equal(res.newlyArchived, 1);
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].workoutKey, keyOf(1));
    assert.match(res.errors[0].error, /already exists and differs; left untouched/);
    assert.equal(await readFile(join(dir, `${keyOf(1)}.fit`), "utf8"), "somebody else's file");
    assert.deepEqual(await ls(dir), [`${keyOf(1)}.fit`, `${keyOf(2)}.fit`, `${keyOf(2)}.json`], "no record for the blocked one");
  });
});

test("archive: a key that is not 24 hex characters never reaches a path; foreign files in the folder are left alone and counted", async () => {
  await withDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.txt"), "mine");
    await writeFile(join(dir, `${keyOf(171).toUpperCase()}.json`), "{}");
    const ws = [workout(1), { ...workout(2), workoutKey: "../../etc/passwd" }, { ...workout(3), workoutKey: keyOf(3).slice(1) }, { startTime: 1 }];
    const run = fake(ws);
    const res: any = await archiveWorkouts(run.client, fileArchiveStore(dir), {}, NOW);
    assert.deepEqual(run.fitCalls, [keyOf(1)]);
    assert.equal(res.newlyArchived, 1);
    assert.deepEqual(await ls(dir), [`${keyOf(1)}.fit`, `${keyOf(1)}.json`, `${keyOf(171).toUpperCase()}.json`, "notes.txt"].sort());
    const st: any = await archiveStatus(fileArchiveStore(dir));
    assert.equal(st.archived, 1);
    assert.equal(st.otherFiles, 2);
  });
});

test("archive: two calls at once download each workout once", async () => {
  const store = memoryArchiveStore();
  const ws = [workout(1), workout(2), workout(3)];
  const a = fake(ws);
  const b = fake(ws);
  const [r1, r2]: any[] = await Promise.all([archiveWorkouts(a.client, store, {}, NOW), archiveWorkouts(b.client, store, {}, NOW)]);
  assert.equal(a.fitCalls.length + b.fitCalls.length, 3);
  assert.equal(r1.newlyArchived + r2.newlyArchived, 3);
});

// ---------- status ----------

test("archive status: counts, span and size; a missing folder is an empty archive and is not created", async () => {
  await withDir(async (dir) => {
    const empty: any = await archiveStatus(fileArchiveStore(dir));
    assert.deepEqual([empty.archived, empty.fitBytes, empty.oldest, empty.newest, empty.problems], [0, 0, null, null, []]);
    assert.equal(empty.dir, dir);
    await assert.rejects(stat(dir), /ENOENT/);
    await archiveWorkouts(fake([workout(1), workout(3)]).client, fileArchiveStore(dir), {}, NOW);
    const st: any = await archiveStatus(fileArchiveStore(dir));
    assert.equal(st.archived, 2);
    assert.equal(st.oldest, "2026-11-02");
    assert.equal(st.newest, "2026-11-04");
    assert.equal(st.fitBytes, fitFor(1).length + fitFor(3).length);
    assert.deepEqual(st.problems, []);
  });
});

test("archive status: a missing or resized FIT file, a damaged record and a folder that is a file are reported, never repaired or deleted", async () => {
  await withDir(async (dir) => {
    await archiveWorkouts(fake([workout(1), workout(2), workout(3)]).client, fileArchiveStore(dir), {}, NOW);
    await rm(join(dir, `${keyOf(1)}.fit`));
    await writeFile(join(dir, `${keyOf(2)}.fit`), Buffer.concat([fitFor(2), Buffer.from([1])]));
    await writeFile(join(dir, `${keyOf(3)}.json`), "garbage");
    const st: any = await archiveStatus(fileArchiveStore(dir));
    assert.equal(st.archived, 0);
    assert.deepEqual(st.problems.map((p: any) => p.workoutKey).sort(), [1, 2, 3].map(keyOf).sort());
    assert.match(st.problems.find((p: any) => p.workoutKey === keyOf(1)).problem, /\.fit is missing/);
    assert.match(st.problems.find((p: any) => p.workoutKey === keyOf(2)).problem, /size differs/);
    assert.equal(await readFile(join(dir, `${keyOf(3)}.json`), "utf8"), "garbage");
    // and archive_workouts leaves all three alone
    const run = fake([workout(1), workout(2), workout(3)]);
    const res: any = await archiveWorkouts(run.client, fileArchiveStore(dir), {}, NOW);
    assert.deepEqual([run.fitCalls, res.newlyArchived, res.refused.length], [[], 0, 3]);
    assert.equal((await stat(join(dir, `${keyOf(2)}.fit`))).size, fitFor(2).length + 1);
    await assert.rejects(stat(join(dir, `${keyOf(1)}.fit`)), /ENOENT/);
  });
  await withDir(async (dir) => {
    await mkdir(join(dir, ".."), { recursive: true });
    await writeFile(dir, "i am a file");
    await assert.rejects(archiveStatus(fileArchiveStore(dir)), /ENOTDIR|not a directory/i);
    await assert.rejects(archiveWorkouts(fake([workout(1)]).client, fileArchiveStore(dir), {}, NOW), /ENOTDIR|not a directory/i);
    assert.equal(await readFile(dir, "utf8"), "i am a file");
  });
});

// ---------- demo / in-memory ----------

test("archive: the in-memory store behaves the same and writes nothing to the folder SUUNTO_ARCHIVE_DIR names", async () => {
  await withDir(async (dir) => {
    const saved = process.env.SUUNTO_ARCHIVE_DIR;
    process.env.SUUNTO_ARCHIVE_DIR = dir;
    try {
      assert.equal(archiveDir(), dir);
      const store = memoryArchiveStore();
      const res: any = await archiveWorkouts(fake([workout(1), workout(2)]).client, store, {}, NOW);
      assert.equal(res.newlyArchived, 2);
      const st: any = await archiveStatus(store);
      assert.deepEqual([st.archived, st.dir], [2, null]);
      assert.equal(st.fitBytes, fitFor(1).length + fitFor(2).length);
      const again: any = await archiveWorkouts(fake([workout(1), workout(2)]).client, store, {}, NOW);
      assert.equal(again.newlyArchived, 0);
      await assert.rejects(stat(dir), /ENOENT/);
    } finally {
      if (saved === undefined) delete process.env.SUUNTO_ARCHIVE_DIR;
      else process.env.SUUNTO_ARCHIVE_DIR = saved;
    }
  });
});

test("archive: the default folder is ~/.suunto-mcp/archive", () => {
  const saved = process.env.SUUNTO_ARCHIVE_DIR;
  delete process.env.SUUNTO_ARCHIVE_DIR;
  try {
    assert.match(archiveDir(), /[\\/]\.suunto-mcp[\\/]archive$/);
  } finally {
    if (saved !== undefined) process.env.SUUNTO_ARCHIVE_DIR = saved;
  }
});
