import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJournal, logSession, parseLogInput } from "./journal.js";

const KEY = "5e1f7c0de000000000000001";
const NOW = new Date("2026-11-01T12:00:00Z");

async function withDir<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-journal-"));
  try {
    return await fn(join(dir, "sub", "journal.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("journal: valid input is normalised and stamped; optional parts stay out", () => {
  const e = parseLogInput({ workoutKey: KEY.toUpperCase(), note: "ok", exercises: [{ name: "Back Squat", sets: [{ reps: 6, kg: 100, rpe: 8.5 }, {}] }] }, NOW);
  assert.deepEqual(e, { workoutKey: KEY, loggedAt: NOW.toISOString(), note: "ok", exercises: [{ name: "Back Squat", sets: [{ reps: 6, kg: 100, rpe: 8.5 }, {}] }] });
  assert.deepEqual(parseLogInput({ workoutKey: KEY }, NOW), { workoutKey: KEY, loggedAt: NOW.toISOString() });
});

test("journal: strict validation", () => {
  const ok = { workoutKey: KEY };
  const bad: [unknown, RegExp][] = [
    [null, /object/],
    [{}, /workoutKey/],
    [{ workoutKey: "abc" }, /workoutKey/],
    [{ workoutKey: `${KEY}0` }, /workoutKey/],
    [{ ...ok, note: 5 }, /note must be a string/],
    [{ ...ok, note: "x".repeat(501) }, /at most 500/],
    [{ ...ok, feeling: "x".repeat(501) }, /feeling/],
    [{ ...ok, exercises: "squat" }, /array/],
    [{ ...ok, exercises: Array.from({ length: 41 }, () => ({ name: "a" })) }, /at most 40/],
    [{ ...ok, exercises: [{}] }, /name is required/],
    [{ ...ok, exercises: [{ name: "  " }] }, /must not be empty/],
    [{ ...ok, exercises: [{ name: "a", note: "x".repeat(501) }] }, /note/],
    [{ ...ok, exercises: [{ name: "a", sets: Array.from({ length: 21 }, () => ({})) }] }, /at most 20/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ reps: -1 }] }] }, /reps must be between 0 and 200/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ reps: 201 }] }] }, /reps/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ reps: 5.5 }] }] }, /reps must be an integer/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ kg: -0.1 }] }] }, /kg/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ kg: 1000.5 }] }] }, /kg/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ kg: "100" }] }] }, /kg must be a finite number/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ rpe: 0.5 }] }] }, /rpe/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ rpe: 11 }] }] }, /rpe/],
    [{ ...ok, exercises: [{ name: "a", sets: [{ rpe: NaN }] }] }, /rpe/],
  ];
  for (const [input, re] of bad) assert.throws(() => parseLogInput(input, NOW), re, JSON.stringify(input)?.slice(0, 80));
  // the limits themselves are fine
  assert.doesNotThrow(() => parseLogInput({ ...ok, note: "x".repeat(500), exercises: Array.from({ length: 40 }, () => ({ name: "a", sets: Array.from({ length: 20 }, () => ({ reps: 0, kg: 1000, rpe: 1 })) })) }, NOW));
});

test("journal: logging writes a 0600 file (directory 0700) and leaves no temp file", async () => {
  await withDir(async (path) => {
    const r = await logSession({ workoutKey: KEY, note: "all as planned except squat set 3: 6 reps", exercises: [{ name: "Back Squat", sets: [{ reps: 5 }, { reps: 5 }, { reps: 6 }] }] }, path, NOW);
    assert.equal(r.replaced, null);
    assert.equal(r.entries, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(path, "..")), ["journal.json"]);
    assert.deepEqual((await loadJournal(path))[KEY], r.saved);
  });
});

test("journal: the same workoutKey again replaces the entry and returns the previous one; other keys are kept", async () => {
  await withDir(async (path) => {
    const other = "5e1f7c0de000000000000002";
    const first = await logSession({ workoutKey: KEY, note: "first" }, path, NOW);
    await logSession({ workoutKey: other, note: "other" }, path, NOW);
    const second = await logSession({ workoutKey: KEY, note: "second" }, path, new Date(NOW.getTime() + 1000));
    assert.deepEqual(second.replaced, first.saved);
    assert.equal(second.entries, 2);
    const all = await loadJournal(path);
    assert.equal(all[KEY].note, "second");
    assert.equal(all[other].note, "other");
  });
});

test("journal: concurrent calls do not lose entries", async () => {
  await withDir(async (path) => {
    const keys = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(24, "0"));
    await Promise.all(keys.map((workoutKey) => logSession({ workoutKey, note: workoutKey }, path, NOW)));
    assert.deepEqual(Object.keys(await loadJournal(path)).sort(), keys);
  });
});

test("journal: invalid input writes nothing; an unreadable journal is not overwritten", async () => {
  await withDir(async (path, dir) => {
    await assert.rejects(logSession({ workoutKey: "nope" }, path, NOW), /workoutKey/);
    assert.deepEqual(await readdir(dir), [], "no file, no directory");
    assert.deepEqual(await loadJournal(path), {}, "a missing journal is an empty one");
    await writeFile(join(dir, "broken.json"), "{ not json");
    await assert.rejects(logSession({ workoutKey: KEY }, join(dir, "broken.json"), NOW), /not valid JSON/);
    assert.equal(await readFile(join(dir, "broken.json"), "utf8"), "{ not json");
  });
});
