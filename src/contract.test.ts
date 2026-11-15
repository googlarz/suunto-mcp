import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The 1.x contract (docs/CONTRACT.md) as a test: the tool list (names, input schemas, annotations) and the key shape of
// what every read-only tool returns, taken from a real stdio server in demo mode and compared with committed fixtures.
// Any difference fails, with a message saying whether it breaks the contract or only adds to it. An addition is allowed,
// but only on purpose: regenerate the fixtures with `UPDATE_CONTRACT=1 npm test` and commit them.
//
// Hermetic: demo mode needs no credentials and no network (a fetch that throws is preloaded), and the clock is frozen,
// so nothing in the fixtures depends on the day the test runs. Only keys and value TYPES of results are recorded,
// never values.

const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const fixtureDir = fileURLToPath(new URL("../test-fixtures/contract/", import.meta.url));
const toolsFixture = join(fixtureDir, "tools.json");
const outputsFixture = join(fixtureDir, "outputs.json");
const fixedClock = new URL("../test-fixtures/fixed-clock.mjs", import.meta.url).href;
const throwingFetch = new URL("../test-fixtures/throwing-fetch.mjs", import.meta.url).href;
const UPDATE = process.env.UPDATE_CONTRACT === "1";

// ---------- snapshot shapes ----------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function canonical(v: Json): Json {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

// Description text is documentation, not contract. `description` is dropped where it is a schema keyword, but kept
// inside a `properties` map, where it can be the name of an input (upload_workout has one).
function stripDescriptions(schema: Json, inPropertiesMap = false): Json {
  if (Array.isArray(schema)) return schema.map((s) => stripDescriptions(s));
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!inPropertiesMap && k === "description" && typeof v === "string") continue;
    out[k] = stripDescriptions(v, !inPropertiesMap && k === "properties");
  }
  return out;
}

// A value's shape: objects keep their keys, primitives become their type name, an array becomes the union of its
// elements' shapes in a one-element list (an empty array is []), so a result may hold more or fewer items without
// changing the shape.
type Shape = string | Shape[] | { [k: string]: Shape };

function shapeOf(v: unknown): Shape {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length === 0 ? [] : [v.map(shapeOf).reduce(mergeShapes)];
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]));
  return typeof v;
}

// Several shapes at one position: primitives become "a|b", objects merge key by key, arrays merge their element shape.
// Anything else mixed is { $oneOf: [...] }.
function mergeShapes(a: Shape, b: Shape): Shape {
  const variants = [a, b].flatMap((s): Shape[] => (typeof s === "string" ? s.split("|") : [s]));
  const prims = [...new Set(variants.filter((s): s is string => typeof s === "string"))].sort();
  const objs = variants.filter((s): s is { [k: string]: Shape } => isObj(s as Json));
  const arrs = variants.filter((s): s is Shape[] => Array.isArray(s));
  const parts: Shape[] = [];
  if (prims.length) parts.push(prims.join("|"));
  if (objs.length) {
    const merged: { [k: string]: Shape } = {};
    for (const o of objs) for (const k of Object.keys(o).sort()) merged[k] = k in merged ? mergeShapes(merged[k], o[k]) : o[k];
    parts.push(Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]])));
  }
  if (arrs.length) {
    const inner = arrs.flat();
    parts.push(inner.length ? [inner.reduce(mergeShapes)] : []);
  }
  return parts.length === 1 ? parts[0] : { $oneOf: parts as unknown as Shape };
}

// ---------- diffs, worded for the person who just broke the contract ----------

const BREAK = "BREAKING";
const ADD = "additive (allowed in 1.x, but update the fixture on purpose)";
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a as Json)) === JSON.stringify(canonical(b as Json));

function diffSchema(tool: string, path: string, exp: Json, act: Json, out: string[]): void {
  if (same(exp, act)) return;
  if (!isObj(exp) || !isObj(act)) {
    out.push(`${BREAK}: ${tool}: input schema ${path} changed from ${JSON.stringify(exp)} to ${JSON.stringify(act)}`);
    return;
  }
  const expProps = (exp.properties ?? {}) as Obj;
  const actProps = (act.properties ?? {}) as Obj;
  const expReq = (exp.required ?? []) as string[];
  const actReq = (act.required ?? []) as string[];
  for (const p of Object.keys(expProps)) {
    if (!(p in actProps)) out.push(`${BREAK}: ${tool}: input property ${path}${p} was removed or renamed`);
    else diffSchema(tool, `${path}${p}.`, expProps[p], actProps[p], out);
  }
  for (const p of Object.keys(actProps)) {
    if (!(p in expProps)) out.push(actReq.includes(p) ? `${BREAK}: ${tool}: new input property ${path}${p} is required` : `${ADD}: ${tool}: new optional input property ${path}${p}`);
  }
  for (const p of actReq) if (expProps[p] !== undefined && !expReq.includes(p)) out.push(`${BREAK}: ${tool}: input property ${path}${p} became required`);
  for (const p of expReq) if (!actReq.includes(p)) out.push(`${ADD}: ${tool}: input property ${path}${p} is no longer required`);
  if (exp.items !== undefined || act.items !== undefined) {
    if (exp.items === undefined || act.items === undefined) out.push(`${BREAK}: ${tool}: input schema ${path}items changed`);
    else diffSchema(tool, `${path}[].`, exp.items, act.items, out);
  }
  for (const k of new Set([...Object.keys(exp), ...Object.keys(act)])) {
    if (["properties", "required", "items"].includes(k)) continue;
    if (!same(exp[k], act[k])) out.push(`${BREAK}: ${tool}: input schema ${path}${k} changed from ${JSON.stringify(exp[k])} to ${JSON.stringify(act[k])}`);
  }
}

interface ToolSnap {
  inputSchema: Json;
  annotations: Json;
}

function diffTools(expected: Record<string, ToolSnap>, actual: Record<string, ToolSnap>): string[] {
  const out: string[] = [];
  for (const name of Object.keys(expected)) {
    if (!(name in actual)) {
      out.push(`${BREAK}: tool ${name} was removed or renamed`);
      continue;
    }
    if (!same(expected[name].annotations, actual[name].annotations)) {
      out.push(`${BREAK}: ${name}: annotations changed from ${JSON.stringify(canonical(expected[name].annotations))} to ${JSON.stringify(canonical(actual[name].annotations))}`);
    }
    diffSchema(name, "", expected[name].inputSchema, actual[name].inputSchema, out);
  }
  for (const name of Object.keys(actual)) if (!(name in expected)) out.push(`${ADD}: new tool ${name}`);
  return out;
}

function diffShape(tool: string, path: string, exp: Shape, act: Shape, out: string[]): void {
  if (same(exp as Json, act as Json)) return;
  if (isObj(exp as Json) && isObj(act as Json)) {
    const e = exp as { [k: string]: Shape };
    const a = act as { [k: string]: Shape };
    for (const k of Object.keys(e)) {
      if (!(k in a)) out.push(`${BREAK}: ${tool}: output key ${path}${k} was removed or renamed`);
      else diffShape(tool, `${path}${k}.`, e[k], a[k], out);
    }
    for (const k of Object.keys(a)) if (!(k in e)) out.push(`${ADD}: ${tool}: new output key ${path}${k}`);
    return;
  }
  if (Array.isArray(exp) && Array.isArray(act)) {
    if (exp.length && act.length) diffShape(tool, `${path.replace(/\.$/, "")}[].`, exp[0], act[0], out);
    else out.push(`${BREAK}: ${tool}: output ${path.replace(/\.$/, "") || "(top level)"} was ${exp.length ? "a list with items, now empty" : "empty, now has items"} (demo data is fixed, so this is a change)`);
    return;
  }
  out.push(`${BREAK}: ${tool}: output ${path.replace(/\.$/, "") || "(top level)"} changed type from ${JSON.stringify(exp)} to ${JSON.stringify(act)}`);
}

function diffShapes(expected: Record<string, Shape>, actual: Record<string, Shape>): string[] {
  const out: string[] = [];
  for (const name of Object.keys(expected)) {
    if (!(name in actual)) out.push(`${BREAK}: ${name}: no output was recorded any more`);
    else diffShape(name, "", expected[name], actual[name], out);
  }
  for (const name of Object.keys(actual)) if (!(name in expected)) out.push(`${ADD}: ${name}: new recorded output`);
  return out;
}

const HOW_TO_FIX =
  "\nIf the change is deliberate and not breaking (see docs/CONTRACT.md), regenerate the fixtures with `UPDATE_CONTRACT=1 npm test` and commit test-fixtures/contract/. " +
  "A change marked BREAKING needs a major version, or must be undone.";

function expectNoDiff(what: string, diffs: string[]) {
  assert.deepEqual(diffs, [], `${what} no longer matches test-fixtures/contract/:\n  ${diffs.join("\n  ")}${HOW_TO_FIX}`);
}

// ---------- the real server, in demo mode ----------

async function withDemoServer<T>(fn: (rpc: (method: string, params?: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "suunto-contract-"));
  const env: Record<string, string> = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SUUNTO_") && k !== "PORT")) as Record<string, string>),
    SUUNTO_DEMO: "1",
    TZ: "Europe/Berlin",
    FIXED_NOW: "2026-11-13T19:00:00Z", // a Friday, 20:00 in Berlin
    SUUNTO_CACHE_DIR: join(cwd, "cache"),
    SUUNTO_JOURNAL_PATH: join(cwd, "journal.json"),
    SUUNTO_PLAN_PATH: join(cwd, "plan.json"),
    SUUNTO_SEEN_PATH: join(cwd, "seen.json"),
    SUUNTO_ARCHIVE_DIR: join(cwd, "archive"),
    SUUNTO_REPORTS_DIR: join(cwd, "reports"),
  };
  const child = spawn(process.execPath, ["--import", fixedClock, "--import", throwingFetch, serverPath], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    } catch {
      /* stdout purity is asserted by the stdio smoke test */
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no response to ${method} within 30s`)), 30_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "contract", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn(rpc);
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}

// What each read-only tool is called with. The clock is frozen at Friday 2026-11-13, so these dates are fixed.
// A read-only tool that is not here (or in SKIPPED) fails the test: a new tool must be added on purpose.
const DAY = "2026-11-12";
const FROM = "2026-11-06";
const GUIDE = { title: "Contract check", date: "2026-11-13", exercises: [{ name: "Bench press", detail: "70kg 4x8", sets: 4, restSec: 90 }] };

type Ctx = { gymKey: string; runKey: string; routeId: string };
// "tool#variant" records a second call of the same tool whose result has another shape.
const OUTPUT_CALLS: Record<string, (c: Ctx) => Record<string, unknown>> = {
  list_workouts: () => ({ limit: 5 }),
  get_workout: (c) => ({ workoutKey: c.gymKey }),
  get_workout_fit: (c) => ({ workoutKey: c.gymKey }),
  get_daily_snapshot: () => ({ date: DAY }),
  get_baselines: () => ({ date: DAY }),
  get_training_load: () => ({ date: DAY }),
  forecast_training_load: () => ({ days: [{ date: "2026-11-14", tss: 80 }, { date: "2026-11-16", tss: 60 }] }),
  get_workout_laps: (c) => ({ workoutKey: c.gymKey }),
  compare_workout_to_plan: (c) => ({ workoutKey: c.gymKey }),
  get_workout_rest_profile: (c) => ({ workoutKey: c.gymKey }),
  get_exercise_history: () => ({ weeks: 8 }),
  "get_exercise_history#one-exercise": () => ({ weeks: 8, name: "Bench Press" }),
  get_daily_activity: () => ({ date: DAY }),
  list_daily_activity: () => ({ from: FROM, to: DAY }),
  get_sleep: () => ({ date: DAY }),
  list_sleep: () => ({ from: FROM, to: DAY }),
  get_recovery: () => ({ date: DAY }),
  list_recovery: () => ({ from: FROM, to: DAY }),
  get_daily_activity_statistics: () => ({ startdate: FROM, enddate: DAY }),
  list_routes: () => ({}),
  get_route: (c) => ({ routeId: c.routeId }),
  export_route: (c) => ({ routeId: c.routeId }),
  list_guides: () => ({}),
  get_plan: () => ({}),
  get_catchup: () => ({}), // markSeen defaults to false: a pure read
  get_tag_effects: () => ({}),
  get_archive_status: () => ({}),
  get_benchmark: () => ({ guide: "push a", weeks: 8 }),
  "get_benchmark#exercise": () => ({ exercise: "Bench Press", weeks: 8 }),
  get_weekly_report: () => ({}), // save defaults to false: a pure read
  estimate_route_time: (c) => ({ routeId: c.routeId }),
  adjust_guide: () => ({ guide: GUIDE }),
};
// Read-only tools with nothing to record in demo mode.
const SKIPPED: Record<string, string> = {
  get_upload_status: "needs the id of a real upload; demo mode only answers not found",
};

interface Snapshot {
  tools: Record<string, ToolSnap>;
  outputs: Record<string, Shape>;
}

async function takeSnapshot(): Promise<Snapshot> {
  return withDemoServer(async (rpc) => {
    const list: any[] = (await rpc("tools/list")).result.tools;
    const tools: Record<string, ToolSnap> = {};
    for (const t of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
      tools[t.name] = { inputSchema: canonical(stripDescriptions(t.inputSchema)), annotations: canonical(t.annotations) };
    }

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await rpc("tools/call", { name, arguments: args })).result;
      const text: string = r.content[0].text;
      assert.notEqual(r.isError, true, `${name} failed in demo mode: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    };
    const workouts = (await call("list_workouts", { limit: 100 })).payload as any[];
    const gym = workouts.find((w) => w.activityId === 23);
    const run = workouts.find((w) => w.activityId !== 23);
    assert.ok(gym && run, "demo data has a gym session and another workout");
    const routes = (await call("list_routes", {})).data as any[];
    const ctx: Ctx = { gymKey: gym.workoutKey, runKey: run.workoutKey, routeId: routes[0].id };

    const readOnly = list.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name as string);
    const recorded = new Set(Object.keys(OUTPUT_CALLS).map((k) => k.split("#")[0]));
    const unknown = readOnly.filter((n) => !recorded.has(n) && !(n in SKIPPED));
    assert.deepEqual(unknown, [], `read-only tool(s) with no recorded output: add a call to OUTPUT_CALLS (or a reason to SKIPPED) in src/contract.test.ts`);
    const stale = [...recorded, ...Object.keys(SKIPPED)].filter((n) => !(n in tools));
    assert.deepEqual(stale, [], "OUTPUT_CALLS / SKIPPED name a tool that no longer exists");

    const outputs: Record<string, Shape> = {};
    for (const key of Object.keys(OUTPUT_CALLS).sort()) {
      // the history, benchmark and report tools read at most a few uncached sessions per call and say how many are left
      let result = await call(key.split("#")[0], OUTPUT_CALLS[key](ctx));
      for (let i = 0; i < 8 && (result.pending ?? result.strength?.pending ?? 0) > 0; i++) result = await call(key.split("#")[0], OUTPUT_CALLS[key](ctx));
      assert.equal(result.pending ?? result.strength?.pending ?? 0, 0, `${key}: demo sessions did not all load after 9 calls`);
      outputs[key] = shapeOf(result);
    }
    return { tools, outputs };
  });
}

// One real server run serves every test below.
let snapshot: Promise<Snapshot> | undefined;
const snap = () => (snapshot ??= takeSnapshot());

const readFixture = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const writeFixture = async (path: string, data: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
};

// ---------- the contract tests ----------

test("contract: tools/list (names, input schemas, annotations) matches test-fixtures/contract/tools.json", async () => {
  const { tools } = await snap();
  if (UPDATE) {
    await writeFixture(toolsFixture, tools);
    return;
  }
  const expected = await readFixture(toolsFixture).catch(() => assert.fail("test-fixtures/contract/tools.json is missing: run `UPDATE_CONTRACT=1 npm test`"));
  expectNoDiff("tools/list", diffTools(expected, tools));
});

test("contract: the key shape of every read-only tool's demo result matches test-fixtures/contract/outputs.json", async () => {
  const { outputs } = await snap();
  if (UPDATE) {
    await writeFixture(outputsFixture, outputs);
    return;
  }
  const expected = await readFixture(outputsFixture).catch(() => assert.fail("test-fixtures/contract/outputs.json is missing: run `UPDATE_CONTRACT=1 npm test`"));
  expectNoDiff("a read-only tool's output", diffShapes(expected, outputs));
});

test("contract: the fixtures hold no values that depend on the day (shapes only: keys and type names)", async () => {
  const { outputs } = await snap();
  const text = JSON.stringify(outputs);
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(text), false, "a date leaked into outputs.json");
  const allowed = new Set(["string", "number", "boolean", "null"]);
  const leaves = (s: Shape): string[] => (typeof s === "string" ? s.split("|") : Array.isArray(s) ? s.flatMap(leaves) : Object.values(s).flatMap(leaves));
  for (const [tool, shape] of Object.entries(outputs)) for (const l of leaves(shape)) assert.ok(allowed.has(l), `${tool}: leaf "${l}" is a value, not a type`);
});

// ---------- the diff helpers themselves: each kind of change is caught and worded ----------

const baseTool = (): ToolSnap => ({
  inputSchema: { type: "object", properties: { date: { type: "string" }, days: { type: "number", minimum: 1 } }, required: ["date"] },
  annotations: { readOnlyHint: true, openWorldHint: true },
});

test("contract diff: removed tool, renamed or retyped property, new required field, changed annotations are BREAKING", () => {
  const before = { a: baseTool(), b: baseTool() };
  const mutate = (f: (t: ToolSnap & { inputSchema: any; annotations: any }) => void) => {
    const t: any = JSON.parse(JSON.stringify(baseTool()));
    f(t);
    return diffTools(before, { a: t, b: baseTool() });
  };
  assert.match(diffTools(before, { a: baseTool() }).join("\n"), /BREAKING: tool b was removed or renamed/);
  assert.match(mutate((t) => { t.inputSchema.properties.dayz = t.inputSchema.properties.days; delete t.inputSchema.properties.days; }).join("\n"), /BREAKING: a: input property days was removed or renamed/);
  assert.match(mutate((t) => { t.inputSchema.properties.date.type = "number"; }).join("\n"), /BREAKING: a: input schema date\.type changed from "string" to "number"/);
  assert.match(mutate((t) => { t.inputSchema.required.push("days"); }).join("\n"), /BREAKING: a: input property days became required/);
  assert.match(mutate((t) => { t.inputSchema.properties.extra = { type: "string" }; t.inputSchema.required.push("extra"); }).join("\n"), /BREAKING: a: new input property extra is required/);
  assert.match(mutate((t) => { t.inputSchema.properties.days.minimum = 5; }).join("\n"), /BREAKING: a: input schema days\.minimum changed/);
  assert.match(mutate((t) => { t.annotations.readOnlyHint = false; }).join("\n"), /BREAKING: a: annotations changed/);
});

test("contract diff: a new optional property or a new tool is additive, and still a difference", () => {
  const before = { a: baseTool() };
  const grown: any = JSON.parse(JSON.stringify(baseTool()));
  grown.inputSchema.properties.extra = { type: "string" };
  const d = diffTools(before, { a: grown, b: baseTool() });
  assert.equal(d.length, 2);
  assert.match(d[0], /^additive.*a: new optional input property extra/);
  assert.match(d[1], /^additive.*new tool b/);
  assert.deepEqual(diffTools(before, { a: JSON.parse(JSON.stringify(baseTool())) }), []);
});

test("contract diff: property order and descriptions are not part of the contract", async () => {
  const withDescriptions = { type: "object", description: "x", properties: { b: { type: "string", description: "y" }, description: { type: "string", description: "an input that is named description" } } };
  assert.deepEqual(stripDescriptions(withDescriptions as Json), { type: "object", properties: { b: { type: "string" }, description: { type: "string" } } });
  assert.deepEqual(diffTools({ a: { inputSchema: { b: 1, a: 2 }, annotations: {} } }, { a: { inputSchema: { a: 2, b: 1 }, annotations: {} } }), []);
});

test("contract shape: values are replaced by type names, arrays by the union of their items, and changes are worded", () => {
  const shape = shapeOf({ n: 1, s: "x", z: null, items: [{ a: 1, b: null }, { a: 2, c: "x" }, { b: { d: true } }], none: [] });
  assert.deepEqual(shape, { items: [{ a: "number", b: { $oneOf: ["null", { d: "boolean" }] }, c: "string" }], n: "number", none: [], s: "string", z: "null" });
  // the same shape whatever the values and the number of items
  assert.deepEqual(shapeOf({ n: 99, items: [{ a: 5 }] }), { items: [{ a: "number" }], n: "number" });

  const base = shapeOf({ id: "k", sets: [{ reps: 8, kg: 70 }] });
  assert.deepEqual(diffShapes({ t: base }, { t: shapeOf({ id: "k", sets: [{ reps: 8, kg: 70 }, { reps: 6, kg: 75 }] }) }), []);
  assert.match(diffShapes({ t: base }, { t: shapeOf({ sets: [{ reps: 8, kg: 70 }] }) }).join("\n"), /BREAKING: t: output key id was removed or renamed/);
  assert.match(diffShapes({ t: base }, { t: shapeOf({ id: 5, sets: [{ reps: 8, kg: 70 }] }) }).join("\n"), /BREAKING: t: output id changed type from "string" to "number"/);
  assert.match(diffShapes({ t: base }, { t: shapeOf({ id: "k", sets: [{ reps: 8 }] }) }).join("\n"), /BREAKING: t: output key sets\[\]\.kg was removed or renamed/);
  assert.match(diffShapes({ t: base }, { t: shapeOf({ id: "k", sets: [{ reps: 8, kg: 70, rpe: 7 }] }) }).join("\n"), /^additive.*t: new output key sets\[\]\.rpe/);
  assert.match(diffShapes({ t: base }, { t: shapeOf({ id: "k", sets: [] }) }).join("\n"), /BREAKING: t: output sets was a list with items, now empty/);
});
