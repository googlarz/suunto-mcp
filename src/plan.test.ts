import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePlanStore, getPlan, memoryPlanStore, parsePlan, setPlan, MAX_GUIDE_CHARS, MAX_PHASES, MAX_SESSIONS } from "./plan.js";

const NOW = new Date(2026, 10, 15, 12, 0, 0); // local noon, Sunday 2026-11-15

async function withDir<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-plan-"));
  try {
    return await fn(join(dir, "sub", "plan.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const base = { goal: "Sub-50 10k", start: "2026-11-01", end: "2027-01-31" };
const guide = (d: string) => ({ title: "Push A", date: d, exercises: [{ name: "Bench", detail: "3x8 70kg", sets: 3, restSec: 90 }] });

test("plan: a valid call is stored and summarised", async () => {
  const store = memoryPlanStore();
  const r = await setPlan({ ...base, phases: [{ name: "Base", from: "2026-11-01", to: "2026-11-30", focus: "volume" }], sessions: [{ date: "2026-11-16", title: "Push A", guide: guide("2026-11-16") }] }, store, { now: NOW });
  assert.deepEqual(r.plan, { goal: "Sub-50 10k", start: "2026-11-01", end: "2027-01-31", phases: 1, sessions: 1 });
  assert.equal(r.previous, null);
  assert.equal((await store.load())?.updatedAt, NOW.toISOString());
});

test("plan: strict validation rejects bad input and writes nothing", async () => {
  const s = (d: string, extra: object = {}) => ({ date: d, title: "T", ...extra });
  const bad: [unknown, RegExp][] = [
    [null, /object/],
    [{}, /goal is required/],
    [{ goal: " " }, /goal must not be empty/],
    [{ goal: 5 }, /goal must be a string/],
    [{ goal: "x".repeat(501) }, /goal must be at most 500/],
    [{ goal: "g", mood: "x" }, /mood is not a known field/],
    [{ goal: "g", mode: "append" }, /mode must be/],
    [{ goal: "g", start: "2026-13-01" }, /start must be a calendar date/],
    [{ goal: "g", start: "2026-12-01", end: "2026-11-01" }, /start .* on or before end/],
    [{ goal: "g", phases: "base" }, /phases must be an array/],
    [{ goal: "g", phases: Array.from({ length: MAX_PHASES + 1 }, () => ({ name: "a", from: "2026-11-01", to: "2026-11-02" })) }, /at most 20/],
    [{ goal: "g", phases: [{ name: "a", from: "2026-11-05", to: "2026-11-02" }] }, /from .* on or before to/],
    [{ goal: "g", phases: [{ name: "a", from: "2026-11-01", to: "2026-11-02", extra: 1 }] }, /phases\[0\]\.extra is not a known field/],
    [{ goal: "g", phases: [{ from: "2026-11-01", to: "2026-11-02" }] }, /name is required/],
    [{ goal: "g", sessions: [s("2026-11-16"), s("2026-11-16")] }, /more than once/],
    [{ goal: "g", sessions: [s("2026-02-30")] }, /sessions\[0\]\.date must be a calendar date/],
    [{ goal: "g", sessions: [{ date: "2026-11-16" }] }, /title is required/],
    [{ goal: "g", sessions: [s("2026-11-16", { notes: "x" })] }, /sessions\[0\]\.notes is not a known field/],
    [{ goal: "g", sessions: Array.from({ length: MAX_SESSIONS + 1 }, (_, i) => s(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))) }, /at most 200/],
    [{ ...base, sessions: [s("2026-10-31")] }, /outside the plan's start\.\.end/],
    [{ ...base, phases: [{ name: "a", from: "2026-10-30", to: "2026-11-05" }] }, /phases\[0\] .*outside the plan's start\.\.end/],
    [{ ...base, phases: [{ name: "a", from: "2027-01-30", to: "2027-02-05" }] }, /phases\[0\] .*outside the plan's start\.\.end/],
    [{ goal: "g", sessions: [s("2026-11-16", { guide: "bench" })] }, /guide must be an object/],
    [{ goal: "g", sessions: [s("2026-11-16", { guide: { ...guide("2026-11-17") } })] }, /guide\.date .* must equal the session date/],
    [{ goal: "g", sessions: [s("2026-11-16", { guide: { pad: "x".repeat(MAX_GUIDE_CHARS) } })] }, /guide must be at most/],
  ];
  for (const [input, re] of bad) {
    const store = memoryPlanStore();
    await assert.rejects(setPlan(input, store, { now: NOW }), re, JSON.stringify(input)?.slice(0, 90));
    assert.equal(await store.load(), null, "nothing stored");
  }
});

test("plan: replace swaps the whole plan and reports the previous one; merge keeps other dates", async () => {
  const store = memoryPlanStore();
  const s = (d: string, title: string) => ({ date: d, title });
  await setPlan({ goal: "old", sessions: [s("2026-11-16", "A"), s("2026-11-17", "B")], phases: [{ name: "p", from: "2026-11-01", to: "2026-11-30" }] }, store);
  const merged = await setPlan({ mode: "merge", sessions: [s("2026-11-17", "B2"), s("2026-11-18", "C")] }, store);
  assert.deepEqual(merged.replacedDates, ["2026-11-17"]);
  const stored = (await store.load())!.plan;
  assert.deepEqual(stored.sessions.map((x) => `${x.date}:${x.title}`), ["2026-11-16:A", "2026-11-17:B2", "2026-11-18:C"]);
  assert.equal(stored.goal, "old", "merge without a goal keeps it");
  assert.equal(stored.phases.length, 1, "merge without phases keeps them");
  await setPlan({ mode: "merge", goal: "new", phases: [] }, store);
  assert.deepEqual([(await store.load())!.plan.goal, (await store.load())!.plan.phases.length, (await store.load())!.plan.sessions.length], ["new", 0, 3]);
  const replaced = await setPlan({ goal: "fresh" }, store);
  assert.deepEqual(replaced.previous, { goal: "new", phases: [], sessions: [{ date: "2026-11-16", title: "A" }, { date: "2026-11-17", title: "B2" }, { date: "2026-11-18", title: "C" }] }, "the whole previous plan comes back, so a replace loses nothing");
  assert.equal((await store.load())!.plan.sessions.length, 0);
});

test("plan: merge needs something to merge and a goal when there is no plan yet; a merge that breaks the range is refused", async () => {
  const store = memoryPlanStore();
  await assert.rejects(setPlan({ mode: "merge", sessions: [{ date: "2026-11-16", title: "A" }] }, store), /first call needs a goal/);
  await setPlan({ ...base }, store);
  await assert.rejects(setPlan({ mode: "merge" }, store), /nothing to set/);
  const before = JSON.stringify(await store.load());
  await assert.rejects(setPlan({ mode: "merge", sessions: [{ date: "2027-02-01", title: "late" }] }, store), /outside/);
  await assert.rejects(setPlan({ mode: "merge", end: "2026-10-01" }, store), /on or before end/);
  assert.equal(JSON.stringify(await store.load()), before);
});

test("plan: a file store writes a 0600 file in a 0700 folder, no temp file, and reads it back", async () => {
  await withDir(async (path) => {
    const store = filePlanStore(path);
    assert.equal(await store.load(), null, "a missing file is no plan");
    await setPlan({ ...base, sessions: [{ date: "2026-11-16", title: "A" }] }, store, { now: NOW });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(path, "..")), ["plan.json"]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
    assert.equal((await store.load())?.plan.goal, "Sub-50 10k");
  });
});

test("plan: a corrupt, foreign, other-version or invalid file is refused and left untouched", async () => {
  await withDir(async (_p, dir) => {
    const cases: [string, RegExp][] = [
      ["{ not json", /not valid JSON/],
      ['{"version":1}', /not a suunto-mcp plan/],
      ['{"version":2,"plan":{"goal":"g","phases":[],"sessions":[]}}', /version/],
      ['{"plan":{"goal":"g","phases":[],"sessions":[]}}', /version/],
      ['{"version":1,"plan":{"goal":"g","phases":[],"sessions":[{"date":"2026-11-16"}]}}', /invalid plan/],
      ['{"version":1,"plan":{"goal":"g","phases":[],"sessions":[],"extra":1}}', /invalid plan/],
    ];
    for (const [body, re] of cases) {
      const file = join(dir, "p.json");
      await writeFile(file, body);
      const store = filePlanStore(file);
      for (const mode of ["replace", "merge"]) await assert.rejects(setPlan({ goal: "new", mode }, store), re, `${mode} ${body}`);
      await assert.rejects(getPlan(store, {}, NOW), re);
      assert.equal(await readFile(file, "utf8"), body, "the file is untouched");
    }
    assert.deepEqual((await readdir(dir)).sort(), ["p.json"], "no temp file left behind");
  });
});

test("plan: concurrent merges do not lose sessions", async () => {
  await withDir(async (path) => {
    const store = filePlanStore(path);
    await setPlan({ goal: "g" }, store);
    const dates = Array.from({ length: 10 }, (_, i) => `2026-11-${String(10 + i).padStart(2, "0")}`);
    await Promise.all(dates.map((date) => setPlan({ mode: "merge", sessions: [{ date, title: date }] }, store)));
    assert.deepEqual((await store.load())!.plan.sessions.map((s) => s.date), dates);
  });
});

test("plan: parsePlan is strict about what is read back", () => {
  assert.throws(() => parsePlan({ goal: "g", phases: [], sessions: [{ date: "2026-11-16", title: "t", guide: 5 }] }), /guide must be an object/);
  assert.deepEqual(parsePlan({ goal: "g", phases: [], sessions: [{ date: "2026-11-17", title: "b" }, { date: "2026-11-16", title: "a" }] }).sessions.map((s) => s.date), ["2026-11-16", "2026-11-17"], "sorted by date");
});

test("get_plan: no plan is a note, not an error", async () => {
  const r: any = await getPlan(memoryPlanStore(), {}, NOW);
  assert.equal(r.plan, null);
  assert.equal(r.today, "2026-11-15");
});

test("get_plan: today's full session, the next 7 days with rest days as null, the current phase, no guide bodies in the list", async () => {
  const store = memoryPlanStore();
  await setPlan({ ...base, phases: [{ name: "Base", from: "2026-11-01", to: "2026-11-30" }, { name: "Build", from: "2026-12-01", to: "2026-12-31" }], sessions: [{ date: "2026-11-15", title: "Today", guide: guide("2026-11-15") }, { date: "2026-11-17", title: "Tue" }, { date: "2026-11-22", title: "Sun", guide: guide("2026-11-22") }, { date: "2026-11-23", title: "beyond" }] }, store);
  const r: any = await getPlan(store, {}, NOW);
  assert.equal(r.todaySession.title, "Today");
  assert.equal(r.todaySession.guide.title, "Push A", "today's session carries its guide");
  assert.equal(r.currentPhase.name, "Base");
  assert.deepEqual(r.next7Days.map((d: any) => d.date), ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
  assert.deepEqual(r.next7Days.map((d: any) => d.session?.title ?? null), [null, "Tue", null, null, null, null, "Sun"]);
  assert.equal(r.next7Days[6].session.hasGuide, true);
  assert.equal(r.plan.sessions.length, 4);
  assert.equal(JSON.stringify(r.plan).includes("exercises"), false, "the list has no guide bodies");
});

test("get_plan: with a date, that day's session (with guide) and phase; an unplanned date is null", async () => {
  const store = memoryPlanStore();
  await setPlan({ ...base, phases: [{ name: "Base", from: "2026-11-01", to: "2026-11-30" }], sessions: [{ date: "2026-11-20", title: "Thu", guide: guide("2026-11-20") }] }, store);
  const r: any = await getPlan(store, { date: "2026-11-20" }, NOW);
  assert.equal(r.session.guide.title, "Push A");
  assert.equal(r.phase.name, "Base");
  assert.equal(((await getPlan(store, { date: "2026-12-24" }, NOW)) as any).session, null);
  await assert.rejects(getPlan(store, { date: "2026-02-30" }, NOW), /not a valid calendar date/);
});

test("get_plan does not write: the file's bytes and mtime are unchanged", async () => {
  await withDir(async (path) => {
    const store = filePlanStore(path);
    await setPlan({ ...base }, store, { now: NOW });
    const before = [await readFile(path, "utf8"), (await stat(path)).mtimeMs];
    await getPlan(store, {}, NOW);
    assert.deepEqual([await readFile(path, "utf8"), (await stat(path)).mtimeMs], before);
  });
});

test("memory store: nothing reaches the disk", async () => {
  await withDir(async (path, dir) => {
    process.env.SUUNTO_PLAN_PATH = path;
    try {
      await setPlan({ ...base }, memoryPlanStore());
    } finally {
      delete process.env.SUUNTO_PLAN_PATH;
    }
    assert.deepEqual(await readdir(dir), []);
  });
});
