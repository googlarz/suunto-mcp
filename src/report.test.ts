import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuuntoClient } from "./api.js";
import { DemoClient } from "./demo.js";
import { memoryPlanStore } from "./plan.js";
import { MIN_WEEK_DAYS, buildWeeklyReport, fileReportStore, mdText, memoryReportStore, positionOf, renderMarkdown, reportsDir, weekMedian, weekRange } from "./report.js";

const NOW = new Date(2026, 10, 13, 20, 0, 0); // Friday 2026-11-13, machine-local
const WEEK = "2026-11-02"; // the Monday of the last full week before NOW
const noJournal = async () => ({});

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "suunto-report-"));
  try {
    return await fn(join(dir, "reports"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// every list is empty: a watch that has not synced anything
const emptyClient = {
  listWorkouts: async () => ({ payload: [] }),
  listSleep: async () => [],
  listRecovery: async () => [],
  getDailyStats: async () => [],
  getWorkoutWithExtensions: async () => {
    throw new Error("not expected");
  },
  getWorkoutFit: async () => {
    throw new Error("not expected");
  },
} as unknown as SuuntoClient;

const deps = (extra: object = {}) => ({ planStore: memoryPlanStore(), reportStore: memoryReportStore(), now: NOW, loadJournal: noJournal, ...extra });

// ---------- the week ----------

test("weekRange: the default is the last full Monday-to-Sunday week, whatever day today is", () => {
  assert.deepEqual(weekRange(undefined, "2026-11-13"), { from: "2026-11-02", to: "2026-11-08" }); // Friday
  assert.deepEqual(weekRange(undefined, "2026-11-09"), { from: "2026-11-02", to: "2026-11-08" }); // Monday: the week ended yesterday
  assert.deepEqual(weekRange(undefined, "2026-11-15"), { from: "2026-11-02", to: "2026-11-08" }); // Sunday: this week is not over
  assert.deepEqual(weekRange(undefined, "2026-11-16"), { from: "2026-11-09", to: "2026-11-15" });
});

test("weekRange: boundaries of a given week", () => {
  assert.deepEqual(weekRange("2026-11-02", "2026-11-09"), { from: "2026-11-02", to: "2026-11-08" }); // ended yesterday: allowed
  assert.throws(() => weekRange("2026-11-02", "2026-11-08"), /has not ended yet/); // its Sunday is today
  assert.throws(() => weekRange("2026-11-09", "2026-11-13"), /has not ended yet/);
  assert.throws(() => weekRange("2026-11-03", "2026-11-13"), /must be a Monday.*2026-11-02/);
  assert.throws(() => weekRange("2026-11-01", "2026-11-13"), /must be a Monday/); // a Sunday
  assert.throws(() => weekRange("2026-02-30", "2026-11-13"), /not a valid calendar date/);
});

// ---------- the pure comparisons ----------

test("weekMedian: needs at least 4 days with a value, never counts a missing day as 0", () => {
  assert.equal(MIN_WEEK_DAYS, 4);
  assert.deepEqual(weekMedian([1, 2, 3, null, null, null, null]), { n: 3, median: null });
  assert.deepEqual(weekMedian([1, 2, 3, 10, null, null, null]), { n: 4, median: 2.5 });
  assert.deepEqual(weekMedian([null, null, null, null, null, null, null]), { n: 0, median: null });
});

test("positionOf: the edges of the band count as within; no band or no median gives null", () => {
  const band = { p25: 10, p75: 20 };
  assert.equal(positionOf(9.99, band), "below");
  assert.equal(positionOf(10, band), "within");
  assert.equal(positionOf(20, band), "within");
  assert.equal(positionOf(20.01, band), "above");
  assert.equal(positionOf(null, band), null);
  assert.equal(positionOf(15, { p25: null, p75: null }), null);
});

// ---------- the report ----------

test("report: the demo week is assembled from every section, without ids, keys or paths", async () => {
  const saved = process.env.SUUNTO_CACHE;
  process.env.SUUNTO_CACHE = "off";
  try {
    const r = await buildWeeklyReport(new DemoClient(NOW), { week: WEEK }, deps());
    assert.deepEqual(r.week, { from: WEEK, to: "2026-11-08" });
    assert.deepEqual(r.errors, []);
    assert.ok(r.workouts && r.workouts.count > 0 && r.workouts.totalTimeS > 0);
    assert.equal(r.workouts.days.length, 7);
    assert.equal(r.workouts.restDays + r.workouts.days.filter((d: any) => d.sessions.length > 0).length, 7);
    assert.ok(r.load && typeof r.load.ctl === "number" && r.load.asOf === "2026-11-08");
    assert.deepEqual(Object.keys(r.recovery!.metrics).sort(), ["hrv", "recoveryMorning", "sleepDurationS", "sleepScore", "steps"]);
    assert.ok(r.recovery!.metrics.sleepDurationS.n >= 4);
    assert.ok(["below", "within", "above"].includes(r.recovery!.metrics.sleepDurationS.vsBaseline!));
    assert.ok(r.strength && r.strength.exercises.length > 0);
    assert.equal(r.plan, null); // no plan was set
    // demo data have no 15-vs-15 nights around this week: the section is stated as insufficient, not omitted
    assert.match(r.markdown, /^# Weekly training report: 2026-11-02 to 2026-11-08/);
    for (const heading of ["## Summary", "## Workouts", "## Sleep and recovery against your usual", "## Training load", "## Strength", "## Plan", "## Tag effects", "## Data notes"]) assert.ok(r.markdown.includes(heading), heading);
    assert.match(r.markdown, /Tag effects[\s\S]*insufficient data/i);
    assert.match(r.markdown, /No plan was set/);
    assert.doesNotMatch(r.markdown, /[0-9a-f]{24}/, "no workout key");
    assert.doesNotMatch(r.markdown, /token|secret|subscription|\/Users\/|\.suunto-mcp/i);
    assert.doesNotMatch(JSON.stringify({ ...r, markdown: "" }), /[0-9a-f]{24}/, "no workout key in the structured result either");
    assert.equal(r.saved, null);
  } finally {
    if (saved === undefined) delete process.env.SUUNTO_CACHE;
    else process.env.SUUNTO_CACHE = saved;
  }
});

test("report: demo: true puts the synthetic-data notice first in the markdown", async () => {
  const r = await buildWeeklyReport(emptyClient, { week: WEEK }, deps({ demo: true }));
  assert.match(r.markdown, /^# Weekly training report[^\n]*\n\n> DEMO DATA \(synthetic\)/);
});

test("report: a watch with nothing synced says insufficient data section by section and does not fail", async () => {
  const r = await buildWeeklyReport(emptyClient, { week: WEEK }, deps());
  assert.deepEqual(r.errors, []);
  assert.equal(r.workouts!.count, 0);
  assert.equal(r.workouts!.restDays, 7);
  for (const m of Object.values(r.recovery!.metrics)) assert.deepEqual([m.n, m.median, m.vsBaseline], [0, null, null]);
  assert.match(r.markdown, /No workouts this week/);
  assert.match(r.markdown, /insufficient data/);
  assert.equal(r.strength!.exercises.length, 0);
});

test("report: a section that fails is listed in errors and marked unavailable; the others are still there", async () => {
  const broken = { ...emptyClient, listSleep: async () => { throw new Error("sleep is down"); }, listRecovery: async () => { throw new Error("recovery is down"); } } as unknown as SuuntoClient;
  const r = await buildWeeklyReport(broken, { week: WEEK }, deps());
  assert.ok(r.errors.some((e) => e.section === "sleep" && /sleep is down/.test(e.error)));
  assert.ok(r.workouts);
  assert.match(r.markdown, /\| Sleep duration \| unavailable/);
  assert.match(r.markdown, /Sleep: unavailable/);
  assert.match(r.markdown, /Unavailable or incomplete: sleep, recovery/);
});

test("report: plan adherence counts a planned day as done when any workout is on that date, else missed", async () => {
  const planStore = memoryPlanStore();
  const first = await buildWeeklyReport(new DemoClient(NOW), { week: WEEK }, deps({ planStore }));
  const trained: string[] = first.workouts!.days.filter((d: any) => d.sessions.length > 0).map((d: any) => d.date);
  const rest: string[] = first.workouts!.days.filter((d: any) => d.sessions.length === 0).map((d: any) => d.date);
  assert.ok(trained.length > 0 && rest.length > 0);
  await planStore.save({
    updatedAt: "2026-11-01T00:00:00.000Z",
    plan: {
      goal: "Sub-50 10k",
      phases: [],
      sessions: [
        { date: trained[0], title: "Planned A" },
        { date: rest[0], title: "Planned B" },
        { date: "2026-11-09", title: "Outside the week" },
      ],
    },
  });
  const r = await buildWeeklyReport(new DemoClient(NOW), { week: WEEK }, deps({ planStore }));
  assert.deepEqual(r.plan!.items.map((i: any) => [i.date, i.status]).sort(), [[rest[0], "missed"], [trained[0], "done"]].sort());
  assert.deepEqual([r.plan!.planned, r.plan!.done, r.plan!.missed, r.plan!.adherencePct], [2, 1, 1, 50]);
  assert.match(r.markdown, /1 of 2 planned sessions/);
  // a plan with no session in the week is not 0 % adherence
  await planStore.save({ updatedAt: "x", plan: { goal: "g", phases: [], sessions: [{ date: "2026-11-09", title: "later" }] } });
  const none = await buildWeeklyReport(new DemoClient(NOW), { week: WEEK }, deps({ planStore }));
  assert.deepEqual([none.plan!.planned, none.plan!.adherencePct], [0, null]);
});

test("report: tag effects are included only for a tag whose verdict is not insufficient", async () => {
  // 40 training days, every second one tagged: both groups have more than 15 nights
  const sleepRows: any[] = [];
  const recoveryRows: any[] = [];
  const workouts: any[] = [];
  for (let k = 0; k < 40; k++) {
    const d = new Date(Date.UTC(2026, 9, 1 + k));
    const date = d.toISOString().slice(0, 10);
    const next = new Date(Date.UTC(2026, 9, 2 + k)).toISOString().slice(0, 10);
    workouts.push({ workoutKey: k.toString(16).padStart(24, "0"), startTime: Date.parse(`${date}T08:00:00Z`), timeOffsetInMinutes: 0, totalTime: 3600, activityId: 3 });
    sleepRows.push({ timestamp: `${next}T05:00:00.000+00:00`, entryData: { SleepId: 100 + k, IsNap: false, Duration: 25000 + (k % 2 === 0 ? 4000 : 0) + (k % 5) * 100, BedtimeStart: `${date}T22:00:00.000+00:00`, BedtimeEnd: `${next}T05:00:00.000+00:00`, SleepQualityScore: 70, AvgHRV: 50 } });
    recoveryRows.push({ timestamp: `${next}T05:00:00.000+00:00`, entryData: { Balance: 0.6, StressState: 1 } });
  }
  const client = { ...emptyClient, listWorkouts: async () => ({ payload: workouts }), listSleep: async () => sleepRows, listRecovery: async () => recoveryRows } as unknown as SuuntoClient;
  const journal = async () => Object.fromEntries(workouts.filter((_, k) => k % 2 === 0).map((w) => [w.workoutKey, { workoutKey: w.workoutKey, loggedAt: "2026-11-01T00:00:00.000Z", tags: ["Heavy"] }]));
  const r = await buildWeeklyReport(client, { week: WEEK }, deps({ loadJournal: journal, now: new Date(2026, 10, 13, 20) }));
  assert.ok(r.tagEffects, JSON.stringify(r.errors));
  const heavy = r.tagEffects!.tags.find((t: any) => t.tag === "Heavy");
  assert.ok(heavy, "the tag with enough nights is reported");
  assert.notEqual(heavy.verdict, "insufficient");
  assert.match(r.markdown, /Heavy/);
  assert.match(r.markdown, /association, not a cause/);
});

// ---------- saving ----------

test("save: a report is written 0600 into a 0700 folder, named by the week's Monday, and an identical one is 'unchanged'", async () => {
  await withDir(async (dir) => {
    const store = fileReportStore(dir);
    const first = await store.save("week-2026-11-02.md", "# one\n", false);
    assert.deepEqual([first.status, first.path], ["written", join(dir, "week-2026-11-02.md")]);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(first.path!)).mode & 0o777, 0o600);
    assert.equal((await store.save("week-2026-11-02.md", "# one\n", false)).status, "unchanged");
    assert.deepEqual(await readdir(dir), ["week-2026-11-02.md"], "no temporary file is left behind");
  });
});

test("save: a different existing file is never overwritten without overwrite: true", async () => {
  await withDir(async (dir) => {
    const store = fileReportStore(dir);
    await store.save("week-2026-11-02.md", "# mine\n", false);
    await assert.rejects(store.save("week-2026-11-02.md", "# other\n", false), /already exists with different content.*overwrite: true/);
    assert.equal(await readFile(join(dir, "week-2026-11-02.md"), "utf8"), "# mine\n");
    const replaced = await store.save("week-2026-11-02.md", "# other\n", true);
    assert.equal(replaced.status, "overwritten");
    assert.equal(await readFile(join(dir, "week-2026-11-02.md"), "utf8"), "# other\n");
    assert.equal((await stat(join(dir, "week-2026-11-02.md"))).mode & 0o777, 0o600);
  });
});

test("save: an existing folder keeps its mode, a file that is not a regular file is left alone", async () => {
  await withDir(async (dir) => {
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    const store = fileReportStore(dir);
    await store.save("week-2026-11-02.md", "x", false);
    assert.equal((await stat(dir)).mode & 0o777, 0o755);
    await mkdir(join(dir, "week-2026-11-09.md"));
    await assert.rejects(store.save("week-2026-11-09.md", "x", true), /not a regular file/);
  });
});

test("save: buildWeeklyReport saves only when asked, and a refused save is reported without losing the report", async () => {
  await withDir(async (dir) => {
    const reportStore = fileReportStore(dir);
    const none = await buildWeeklyReport(emptyClient, { week: WEEK }, deps({ reportStore }));
    assert.equal(none.saved, null);
    await assert.rejects(readdir(dir), /ENOENT/);
    const saved = await buildWeeklyReport(emptyClient, { week: WEEK, save: true }, deps({ reportStore }));
    assert.equal(saved.saved!.status, "written");
    assert.equal(await readFile(join(dir, `week-${WEEK}.md`), "utf8"), saved.markdown);
    await writeFile(join(dir, `week-${WEEK}.md`), "my own notes");
    const refused = await buildWeeklyReport(emptyClient, { week: WEEK, save: true }, deps({ reportStore }));
    assert.equal(refused.saved!.status, "refused");
    assert.match(refused.saved!.reason!, /overwrite: true/);
    assert.ok(refused.errors.some((e) => e.section === "save"));
    assert.ok(refused.markdown.length > 0);
    assert.equal(await readFile(join(dir, `week-${WEEK}.md`), "utf8"), "my own notes");
    assert.equal((await buildWeeklyReport(emptyClient, { week: WEEK, save: true, overwrite: true }, deps({ reportStore }))).saved!.status, "overwritten");
    await assert.rejects(buildWeeklyReport(emptyClient, { week: WEEK, overwrite: true }, deps({ reportStore })), /overwrite only applies together with save/);
  });
});

test("save: the in-memory store behaves the same and writes nothing to the folder SUUNTO_REPORTS_DIR names", async () => {
  await withDir(async (dir) => {
    const saved = process.env.SUUNTO_REPORTS_DIR;
    process.env.SUUNTO_REPORTS_DIR = dir;
    try {
      assert.equal(reportsDir(), dir);
      const store = memoryReportStore();
      assert.deepEqual(await store.save("week-2026-11-02.md", "a", false), { status: "written", path: null });
      assert.equal((await store.save("week-2026-11-02.md", "a", false)).status, "unchanged");
      await assert.rejects(store.save("week-2026-11-02.md", "b", false), /overwrite: true/);
      assert.equal((await store.save("week-2026-11-02.md", "b", true)).status, "overwritten");
      await buildWeeklyReport(emptyClient, { week: WEEK, save: true }, deps({ demo: true }));
      await assert.rejects(readdir(dir), /ENOENT/);
    } finally {
      if (saved === undefined) delete process.env.SUUNTO_REPORTS_DIR;
      else process.env.SUUNTO_REPORTS_DIR = saved;
    }
  });
});

// ---------- text from the user is data, not markup ----------

test("mdText: pipes, angle brackets, backticks, brackets and leading markers are escaped, whitespace is collapsed", () => {
  assert.equal(mdText("Intervals | 5x1k"), "Intervals \\| 5x1k");
  assert.equal(mdText("<img src=x onerror=x>"), "&lt;img src=x onerror=x&gt;");
  assert.equal(mdText("a\nb\r\n  c\t d"), "a b c d");
  assert.equal(mdText("# x"), "\\# x");
  assert.equal(mdText("### x"), "\\### x");
  assert.equal(mdText("- item"), "\\- item");
  assert.equal(mdText("* item"), "\\* item");
  assert.equal(mdText("+ item"), "\\+ item");
  assert.equal(mdText("1. one"), "1\\. one");
  assert.equal(mdText("2) two"), "2\\) two");
  assert.equal(mdText("`code`"), "\\`code\\`");
  assert.equal(mdText("[a](javascript:x)"), "\\[a\\](javascript:x)");
  assert.equal(mdText("a \\ b & c"), "a \\\\ b &amp; c");
  assert.equal(mdText("a # b - c 1. d"), "a # b - c 1. d", "a marker in the middle of a line is harmless");
  assert.equal(mdText("#nospace"), "#nospace", "a # without a space is not a heading");
  assert.equal(mdText("  \n  "), "");
});

test("report: every user-written text (guide, exercise, tag, plan goal and titles) is escaped in the markdown", async () => {
  const base = await buildWeeklyReport(emptyClient, { week: WEEK }, deps());
  const evil = "<img src=x onerror=x>";
  const md = renderMarkdown(
    {
      ...base,
      workouts: { count: 1, totalTimeS: 3000, kcal: 300, tss: 50, noTss: 0, restDays: 6, days: [{ date: "2026-11-03", sessions: [{ startLocal: "08:00", totalTimeS: 3000, tss: 50, guide: "Intervals | 5x1k\n# hacked" }] }] },
      strength: { sessions: 1, exercises: [{ name: "Row | `x`", sessions: 1, lastDetail: "3x8 [a](b) " + evil }], pending: 0 },
      plan: { goal: "Sub-50\n# x\n- y", planned: 1, done: 1, missed: 0, adherencePct: 100, items: [{ date: "2026-11-03", title: evil, status: "done" }] },
      tagEffects: { window: { from: "a", to: "b" }, tags: [{ tag: "a|b", verdict: "differs", taggedNights: 20, untaggedNights: 20, statement: `${evil}: differs | an association` }], insufficientTags: 0, minNightsPerGroup: 15 },
    } as any,
    [],
    false,
  );
  assert.doesNotMatch(md, /[<>]/, "no raw angle bracket anywhere");
  assert.doesNotMatch(md, /^# x|^- y|^# hacked/m, "newlines in a name cannot start a heading or list item");
  const headings = md.split("\n").filter((l) => /^#/.test(l));
  assert.deepEqual(headings.slice(1), ["## Summary", "## Workouts", "## Sleep and recovery against your usual", "## Training load", "## Strength", "## Plan", "## Tag effects", "## Data notes"]);
  const row = md.split("\n").find((l) => l.startsWith("| 2026-11-03"))!;
  assert.equal(row.split(/(?<!\\)\|/).length, 7, `five cells in: ${row}`);
  assert.ok(row.includes("Intervals \\| 5x1k # hacked"), row);
  assert.ok(md.includes("- Row \\| \\`x\\`: 1 session, last 3x8 \\[a\\](b) &lt;img src=x onerror=x&gt;"), md);
  assert.ok(md.includes('Plan "Sub-50 # x - y"'), md);
  assert.ok(md.includes("- 2026-11-03 &lt;img src=x onerror=x&gt;: done"), md);
  assert.ok(md.includes("- &lt;img src=x onerror=x&gt;: differs \\| an association"), md);
});

// ---------- other findings ----------

const dayOf = (day: string) => ({ startTime: Date.parse(`${day}T08:00:00Z`), timeOffsetInMinutes: 0, totalTime: 3000, energyConsumption: 300, activityId: 3 });
const clientWith = (over: object) => ({ ...emptyClient, ...over }) as unknown as SuuntoClient;

test("report: a plan that cannot be read is 'unavailable', not 'No plan was set'", async () => {
  const planStore = { load: async () => { throw new Error("plan.json is damaged"); }, save: async () => undefined };
  const r = await buildWeeklyReport(emptyClient, { week: WEEK }, deps({ planStore }));
  assert.ok(r.errors.some((e) => e.section === "plan"));
  assert.match(r.markdown, /## Plan\n\nUnavailable/);
  assert.doesNotMatch(r.markdown, /No plan was set/);
  assert.doesNotMatch(r.markdown, /damaged/, "the error text stays out of the shared markdown");
});

test("report: the workouts table and the week's training stress come from one source and add up; a differing load-model figure is explained", async () => {
  const workouts = [
    { ...dayOf("2026-11-03"), workoutKey: "a".repeat(24), tssList: [{ calculationMethod: "HR", trainingStressScore: 50 }], tss: { trainingStressScore: 30 } },
    { ...dayOf("2026-11-05"), workoutKey: "b".repeat(24), tssList: [{ calculationMethod: "HR", trainingStressScore: 20.5 }], tss: { trainingStressScore: 10 } },
    { ...dayOf("2026-11-06"), workoutKey: "c".repeat(24) }, // no TSS at all
  ];
  const r = await buildWeeklyReport(clientWith({ listWorkouts: async () => ({ payload: workouts }) }), { week: WEEK }, deps());
  assert.deepEqual([r.workouts!.count, r.workouts!.tss, r.workouts!.noTss], [3, 70.5, 1]);
  const rows = r.markdown.split("\n").filter((l) => /^\| 2026-11-0\d /.test(l));
  assert.equal(rows.length, 3);
  const tssOf = (l: string) => Number(l.split("|")[4].trim().replace(/[^\d.]/g, "") || 0);
  assert.equal(rows.reduce((n, l) => n + tssOf(l), 0), 70.5);
  assert.match(r.markdown, /\| Total \| \| [^|]+ \| 70\.5 \|/);
  assert.match(r.markdown, /Training stress this week: 70\.5 \(the sum of the workouts above; 1 without TSS counted as 0\)/);
  assert.match(r.markdown, /load model[^\n]*counted 40/, "the model's own figure (Suunto's other TSS field) is stated when it differs");
  // the same figure from both: no explanation needed
  const same = await buildWeeklyReport(clientWith({ listWorkouts: async () => ({ payload: [{ ...workouts[0], tss: { trainingStressScore: 50 } }] }) }), { week: WEEK }, deps());
  assert.doesNotMatch(same.markdown, /load model[^\n]*counted/);
  assert.match(same.markdown, /Training stress this week: 50 \(the sum of the workouts above\)/);
});

test("report: the demo week's table rows add up to the printed total", async () => {
  const r = await buildWeeklyReport(new DemoClient(NOW), { week: WEEK }, deps());
  const rows = r.markdown.split("\n").filter((l) => /^\| 2026-11-0\d /.test(l));
  const total = r.markdown.split("\n").find((l) => l.startsWith("| Total"))!;
  const sum = rows.reduce((n, l) => n + Number(l.split("|")[4].trim()), 0);
  assert.ok(rows.length > 0 && Math.abs(sum - Number(total.split("|")[4].trim())) < 0.11, `${sum} against ${total}`);
});

test("report: steps from partial data say how many days they cover", async () => {
  const sample = (day: string, v: number) => ({ TimeISO8601: `${day}T12:00:00+00:00`, Value: v });
  const stats = [{ Name: "stepcount", Aggregation: "sum", Sources: [{ Samples: [sample("2026-11-03", 1000), sample("2026-11-04", 2000), sample("2026-11-05", 3000)] }] }];
  const r = await buildWeeklyReport(clientWith({ getDailyStats: async () => stats }), { week: WEEK }, deps());
  assert.equal(r.recovery!.stepsDays, 3);
  assert.match(r.markdown, /Steps: 6,000 over 3 of 7 days/);
  assert.doesNotMatch(r.markdown, /Steps: 6,000 in total/);
  const none = await buildWeeklyReport(emptyClient, { week: WEEK }, deps());
  assert.match(none.markdown, /Steps: insufficient data/);
});

test("report: developer-facing load notes stay out of the shared markdown; a plain sentence replaces what matters", async () => {
  const r = await buildWeeklyReport(new DemoClient(NOW), { week: WEEK }, deps());
  assert.ok(r.load!.notes.some((n) => /Little history/.test(n)), "the structured result keeps the raw note");
  assert.doesNotMatch(r.markdown, /seedCtl|seedAtl|Little history|Reached the|-workout limit|searched back/);
  assert.match(r.markdown, /Fitness \(CTL\) needs about 4 to 6 weeks of history to settle, so it may read low/);
});

test("reportsDir: defaults to ~/.suunto-mcp/reports", () => {
  const saved = process.env.SUUNTO_REPORTS_DIR;
  delete process.env.SUUNTO_REPORTS_DIR;
  try {
    assert.match(reportsDir(), /\.suunto-mcp[\\/]reports$/);
  } finally {
    if (saved !== undefined) process.env.SUUNTO_REPORTS_DIR = saved;
  }
});
