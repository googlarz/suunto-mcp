import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataOverview } from "./data-overview.js";

const VARS = ["SUUNTO_JOURNAL_PATH", "SUUNTO_PLAN_PATH", "SUUNTO_SEEN_PATH", "SUUNTO_PREDICTIONS_PATH", "SUUNTO_EXPERIMENTS_PATH", "SUUNTO_APPROVALS_PATH", "SUUNTO_CACHE_DIR", "SUUNTO_ARCHIVE_DIR", "SUUNTO_REPORTS_DIR"];
const NAMES: Record<string, string> = { SUUNTO_JOURNAL_PATH: "journal.json", SUUNTO_PLAN_PATH: "plan.json", SUUNTO_SEEN_PATH: "seen.json", SUUNTO_PREDICTIONS_PATH: "predictions.json", SUUNTO_EXPERIMENTS_PATH: "experiments.json", SUUNTO_APPROVALS_PATH: "approvals.json", SUUNTO_CACHE_DIR: "cache", SUUNTO_ARCHIVE_DIR: "archive", SUUNTO_REPORTS_DIR: "reports" };

async function withHome<T>(fn: (dir: string, at: (name: string) => string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-overview-"));
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) process.env[v] = join(dir, NAMES[v]);
  try {
    return await fn(dir, (name) => join(dir, name));
  } finally {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    await rm(dir, { recursive: true, force: true });
  }
}
const put = async (path: string, doc: unknown, mode = 0o600) => {
  await writeFile(path, typeof doc === "string" ? doc : JSON.stringify(doc));
  await chmod(path, mode);
};
const file = (o: Awaited<ReturnType<typeof dataOverview>>, name: string) => o.files.find((f) => f.name === name)!;
const dir = (o: Awaited<ReturnType<typeof dataOverview>>, name: string) => o.directories.find((f) => f.name === name)!;

test("dataOverview: nothing there yet is 'missing' everywhere, creates nothing and warns about nothing", async () => {
  await withHome(async (home) => {
    const o = await dataOverview();
    assert.deepEqual(o.files.map((f) => [f.name, f.status, f.exists]), ["journal", "plan", "seen", "predictions", "experiments", "approvals"].map((n) => [n, "missing", false]));
    assert.deepEqual(o.directories.map((d) => [d.name, d.status]), [["cache", "missing"], ["archive", "missing"], ["reports", "missing"]]);
    assert.deepEqual([o.warnings, o.inMemory], [[], false]);
    assert.deepEqual(await readdir(home), [], "nothing created");
    assert.equal(file(o, "journal").path, join(home, "journal.json"), "the path the server would use (the environment override)");
  });
});

test("dataOverview: version, size, mode and counts of each file", async () => {
  await withHome(async (_home, at) => {
    await put(at("journal.json"), { version: 1, entries: { a: {}, b: {} }, sources: { a: "draft" } });
    await put(at("plan.json"), { version: 1, updatedAt: "x", plan: { goal: "g", phases: [{}], sessions: [{}, {}, {}] } });
    await put(at("seen.json"), { version: 1, workouts: [{}, {}], updatedAt: "" });
    await put(at("predictions.json"), { version: 1, predictions: [{ outcome: { result: "hit" } }, { outcome: { result: "miss" } }, { outcome: { result: "unresolvable" } }, { voided: { at: "x", reason: "y" } }, {}] });
    await put(at("experiments.json"), { version: 1, experiments: [{}] });
    await put(at("approvals.json"), { version: 1, approvals: [{ resolution: {} }, {}, {}] });
    const o = await dataOverview();
    assert.deepEqual(o.files.map((f) => [f.name, f.status, f.version, f.mode, f.modeWarning]), ["journal", "plan", "seen", "predictions", "experiments", "approvals"].map((n) => [n, "ok", 1, "0600", null]));
    assert.deepEqual(file(o, "journal").counts, { entries: 2, draftMarks: 1 });
    assert.deepEqual(file(o, "plan").counts, { sessions: 3, phases: 1 });
    assert.deepEqual(file(o, "seen").counts, { workouts: 2 });
    assert.deepEqual(file(o, "predictions").counts, { predictions: 5, scored: 2, voided: 1 }, "unresolvable and unscored are not scored");
    assert.deepEqual(file(o, "experiments").counts, { experiments: 1 });
    assert.deepEqual(file(o, "approvals").counts, { approvals: 3, unresolved: 2 });
    assert.equal(file(o, "seen").sizeBytes, (await stat(at("seen.json"))).size);
    assert.deepEqual(o.warnings, []);
  });
});

test("dataOverview: a file that is not 0600 and a folder that is not 0700 are warned about, exactly 0600 / 0700 are not", async () => {
  if (process.platform === "win32") return;
  await withHome(async (_home, at) => {
    await put(at("plan.json"), { version: 1, plan: { sessions: [], phases: [] } }, 0o644);
    await put(at("journal.json"), { version: 1, entries: {} }, 0o600);
    await put(at("approvals.json"), { version: 1, approvals: [] }, 0o640);
    await mkdir(at("cache"), { mode: 0o755 });
    await chmod(at("cache"), 0o755);
    await mkdir(at("reports"));
    await chmod(at("reports"), 0o700);
    const o = await dataOverview();
    assert.match(file(o, "plan").modeWarning!, /plan has mode 0644, the server creates it as 0600: other users may be able to read it \(chmod 600 ".*plan.json"/);
    assert.match(file(o, "approvals").modeWarning!, /mode 0640/);
    assert.equal(file(o, "journal").modeWarning, null);
    assert.match(dir(o, "cache").modeWarning!, /cache has mode 0755, the server creates it as 0700/);
    assert.equal(dir(o, "reports").modeWarning, null);
    assert.equal(o.warnings.length, 3);
    await chmod(at("journal.json"), 0o400);
    assert.match(file(await dataOverview(), "journal").modeWarning!, /mode 0400/, "the rule is the server's own mode, 0600: anything else is shown");
    assert.equal(file(o, "plan").status, "ok", "a warning does not change the status");
  });
});

test("dataOverview: unreadable, damaged, foreign and newer-version files are flagged, with no counts, and left untouched", async () => {
  await withHome(async (_home, at) => {
    await put(at("journal.json"), "{ not json");
    await put(at("plan.json"), [1, 2]);
    await put(at("seen.json"), { version: 2, workouts: [] });
    await put(at("predictions.json"), { predictions: [] }); // no version
    await put(at("experiments.json"), { version: 1, somethingElse: 1 });
    await mkdir(at("approvals.json")); // a folder where the file should be
    const before = await Promise.all(["journal.json", "plan.json", "seen.json", "predictions.json", "experiments.json"].map((n) => readFile(at(n), "utf8")));
    const o = await dataOverview();
    assert.deepEqual(o.files.map((f) => [f.name, f.status]), [["journal", "damaged"], ["plan", "foreign"], ["seen", "newer-version"], ["predictions", "foreign"], ["experiments", "foreign"], ["approvals", "foreign"]]);
    assert.ok(o.files.every((f) => f.counts === null), "no counts from a file the server would refuse");
    assert.equal(file(o, "seen").version, 2);
    assert.match(file(o, "seen").error!, /version 2: this server reads and writes version 1 only/);
    assert.match(file(o, "journal").error!, /not valid JSON/);
    assert.match(file(o, "experiments").error!, /no "experiments"/);
    assert.match(file(o, "predictions").error!, /no version number/);
    assert.match(file(o, "approvals").error!, /is not a file/);
    assert.ok(o.warnings.some((w) => /^seen: newer-version/.test(w)) && o.warnings.some((w) => /^journal: damaged/.test(w)));
    const after = await Promise.all(["journal.json", "plan.json", "seen.json", "predictions.json", "experiments.json"].map((n) => readFile(at(n), "utf8")));
    assert.deepEqual(after, before, "nothing modified");
  });
});

test("dataOverview: the cache, archive and reports folders are counted (records, workouts and FIT files, week reports) with their size", async () => {
  await withHome(async (_home, at) => {
    await mkdir(at("cache"), { mode: 0o700 });
    await mkdir(at("archive"), { mode: 0o700 });
    await mkdir(at("reports"), { mode: 0o700 });
    for (const n of ["a.json", "b.json", "c.tmp"]) await writeFile(join(at("cache"), n), "12345");
    for (const n of ["k1.json", "k1.fit", "k2.json", "k2.fit", "k3.json"]) await writeFile(join(at("archive"), n), "ab");
    for (const n of ["week-2026-11-02.md", "week-2026-11-09.md", "notes.md", "week-bad.md"]) await writeFile(join(at("reports"), n), "x");
    const o = await dataOverview();
    assert.deepEqual([dir(o, "cache").counts, dir(o, "cache").sizeBytes], [{ records: 2 }, 15]);
    assert.deepEqual([dir(o, "archive").counts, dir(o, "archive").sizeBytes], [{ workouts: 3, fitFiles: 2 }, 10]);
    assert.deepEqual([dir(o, "reports").counts, dir(o, "reports").sizeBytes], [{ reports: 2 }, 4]);
    assert.deepEqual(o.directories.map((d) => d.status), ["ok", "ok", "ok"]);
  });
});

test("dataOverview: demo mode counts the in-memory stores and shows no path, nothing from the disk", async () => {
  await withHome(async (home, at) => {
    await put(at("plan.json"), { version: 1, plan: { sessions: [{}] } }); // must not be read
    const o = await dataOverview({ journal: { entries: { a: {} } }, plan: undefined, predictions: { predictions: [{ outcome: { result: "hit" } }] }, approvals: { approvals: [{}] } });
    assert.equal(o.inMemory, true);
    assert.deepEqual(o.files.map((f) => [f.name, f.status, f.path]), [["journal", "in-memory", null], ["plan", "missing", null], ["seen", "missing", null], ["predictions", "in-memory", null], ["experiments", "missing", null], ["approvals", "in-memory", null]]);
    assert.deepEqual(file(o, "journal").counts, { entries: 1, draftMarks: 0 });
    assert.deepEqual(file(o, "predictions").counts, { predictions: 1, scored: 1, voided: 0 });
    assert.ok(o.directories.every((d) => d.status === "in-memory" && d.path === null));
    assert.deepEqual(await readdir(home), ["plan.json"]);
  });
});
