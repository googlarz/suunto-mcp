import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
// Fields that demo data never fills (always null, always an empty list) cannot be checked, so the outputs fixture lists
// them in its `unobserved` section instead of treating them as covered.
//
// Hermetic: demo mode needs no credentials and no network (a fetch that throws is preloaded), and the clock is frozen,
// so nothing in the fixtures depends on the day the test runs. Only keys and value TYPES of results are recorded,
// never values.

const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const fixtureDir = fileURLToPath(new URL("../test-fixtures/contract/", import.meta.url));
const toolsFixture = join(fixtureDir, "tools.json");
const outputsFixture = join(fixtureDir, "outputs.json");
const surfaceFixture = join(fixtureDir, "surface.json");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
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

// Description and example text is documentation, not contract. `description` is dropped where it is a schema keyword, but
// kept inside a `properties` map, where it can be the name of an input (upload_workout has one).
function stripDescriptions(schema: Json, inPropertiesMap = false): Json {
  if (Array.isArray(schema)) return schema.map((s) => stripDescriptions(s));
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!inPropertiesMap && k === "description" && typeof v === "string") continue;
    if (!inPropertiesMap && (k === "examples" || k === "example")) continue;
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
const CAUTION = "additive with notice (a more cautious annotation is allowed in 1.x: update the fixture on purpose and say so in the CHANGELOG)";
const WIDEN = "additive (an input that accepts more is allowed in 1.x, but update the fixture on purpose)";
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
    else diffSchema(tool, `${path.replace(/\.$/, "")}[].`, exp.items, act.items, out);
  }
  for (const k of new Set([...Object.keys(exp), ...Object.keys(act)])) {
    if (["properties", "required", "items"].includes(k)) continue;
    if (same(exp[k], act[k])) continue;
    const change = `input schema ${path}${k} changed from ${JSON.stringify(exp[k])} to ${JSON.stringify(act[k])}`;
    out.push(`${widens(k, exp[k], act[k]) ? WIDEN : BREAK}: ${tool}: ${change}`);
  }
}

// Does this change of one schema keyword accept more than before (new enum value, higher maximum, lower minimum, a limit
// removed)? Anything else, including every narrowing and every keyword not listed here, is treated as breaking.
const UPPER_LIMITS = ["maximum", "maxLength", "maxItems", "maxProperties"];
const LOWER_LIMITS = ["minimum", "minLength", "minItems", "minProperties"];
function widens(keyword: string, before: Json | undefined, after: Json | undefined): boolean {
  if (keyword === "enum") return Array.isArray(before) && Array.isArray(after) && before.every((v) => after.some((w) => same(v, w)));
  const limit = UPPER_LIMITS.includes(keyword) ? 1 : LOWER_LIMITS.includes(keyword) ? -1 : 0;
  if (limit === 0) return false;
  if (after === undefined) return before !== undefined; // the limit was lifted
  if (typeof before !== "number" || typeof after !== "number") return false; // a limit that is new, or not a number
  return limit === 1 ? after > before : after < before;
}

// Annotations may change in 1.x only toward more caution. All four hints' defaults are their cautious values (a tool is
// not read-only, may be destructive, is not idempotent and reaches outside unless it says otherwise), so a change TOWARD
// the default is more cautious and a change away from it is less. destructiveHint and idempotentHint mean something only
// for a tool that is not read-only, before and after.
const ANNOTATION_DEFAULTS: Record<string, boolean> = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
function diffAnnotations(tool: string, exp: Json, act: Json, out: string[]): void {
  if (same(exp, act)) return;
  const e: Record<string, Json> = { ...ANNOTATION_DEFAULTS, ...(isObj(exp) ? exp : {}) };
  const a: Record<string, Json> = { ...ANNOTATION_DEFAULTS, ...(isObj(act) ? act : {}) };
  const bothWrite = e.readOnlyHint === false && a.readOnlyHint === false;
  for (const key of Object.keys(ANNOTATION_DEFAULTS)) {
    if ((key === "destructiveHint" || key === "idempotentHint") && !bothWrite) continue;
    if (e[key] === a[key]) continue;
    out.push(
      a[key] === ANNOTATION_DEFAULTS[key]
        ? `${CAUTION}: ${tool}: ${key} changed from ${e[key]} to ${a[key]}`
        : `${BREAK}: ${tool}: ${key} changed from ${e[key]} to ${a[key]} (less cautious: clients may now run it without asking)`,
    );
  }
  const other = (o: Json) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([k]) => !(k in ANNOTATION_DEFAULTS)));
  if (!same(other(exp), other(act))) out.push(`${BREAK}: ${tool}: annotations changed from ${JSON.stringify(canonical(exp))} to ${JSON.stringify(canonical(act))}`);
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
    diffAnnotations(name, expected[name].annotations, actual[name].annotations, out);
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
  const at = path.replace(/\.$/, "") || "(top level)";
  if (Array.isArray(exp) && Array.isArray(act)) {
    if (exp.length && act.length) diffShape(tool, `${path.replace(/\.$/, "")}[].`, exp[0], act[0], out);
    else if (!exp.length) out.push(`${ADD}: ${tool}: output ${at} was always an empty list in demo (unobserved) and now has items`);
    else out.push(`${BREAK}: ${tool}: output ${at} was a list with items, now empty (demo data is fixed, so this is a change)`);
    return;
  }
  if (exp === "null") {
    out.push(`${ADD}: ${tool}: output ${at} was always null in demo (unobserved) and now has a value: ${JSON.stringify(act)}`);
    return;
  }
  out.push(`${BREAK}: ${tool}: output ${at} changed type from ${JSON.stringify(exp)} to ${JSON.stringify(act)}`);
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

// The documented list of unobserved fields must match what the demo data shows now. A field that left the list is
// "now observed" (its shape was compared above); one that joined it is a field the demo no longer fills.
function diffUnobserved(expected: Record<string, string[]>, actual: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const tool of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const e = expected[tool] ?? [];
    const a = actual[tool] ?? [];
    for (const u of a) if (!e.includes(u)) out.push(`${BREAK}: ${tool}: ${u} (demo data no longer fills it)`);
    for (const u of e) if (!a.includes(u)) out.push(`${ADD}: ${tool}: ${u} is now observed`);
  }
  return out;
}

// Names that must stay: a removed command, variable, prompt, argument or resource is breaking; a new one is additive. A new
// REQUIRED prompt argument breaks existing callers.
function diffSurface(expected: Surface, actual: Surface): string[] {
  const out: string[] = [];
  const sets = (what: string, e: string[], a: string[]) => {
    for (const n of e) if (!a.includes(n)) out.push(`${BREAK}: ${what} ${n} was removed or renamed`);
    for (const n of a) if (!e.includes(n)) out.push(`${ADD}: new ${what} ${n}`);
  };
  sets("bin command", expected.bin, actual.bin);
  sets("environment variable", expected.envVars, actual.envVars);
  sets("MCP resource", expected.resources, actual.resources);
  sets("MCP resource template", expected.resourceTemplates, actual.resourceTemplates);
  sets("MCP prompt", Object.keys(expected.prompts), Object.keys(actual.prompts));
  for (const [name, args] of Object.entries(expected.prompts)) {
    const now = actual.prompts[name];
    if (!now) continue;
    const bare = (l: string[]) => l.map((x) => x.replace("*", ""));
    for (const arg of args) if (!bare(now).includes(arg.replace("*", ""))) out.push(`${BREAK}: MCP prompt ${name}: argument ${arg.replace("*", "")} was removed or renamed`);
    for (const arg of now) {
      const before = args.find((x) => x.replace("*", "") === arg.replace("*", ""));
      if (before === undefined) out.push(arg.endsWith("*") ? `${BREAK}: MCP prompt ${name}: new argument ${arg.replace("*", "")} is required` : `${ADD}: MCP prompt ${name}: new argument ${arg}`);
      else if (arg.endsWith("*") && !before.endsWith("*")) out.push(`${BREAK}: MCP prompt ${name}: argument ${arg.replace("*", "")} became required`);
    }
  }
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

// A plan covering the report week (Monday 2026-11-02 to Sunday 2026-11-08, so some days are done and some missed) and
// today, set in the demo server's in-memory plan store before any call, so get_plan, get_catchup, get_weekly_report show
// their plan shape.
const PLAN_DATES = Array.from({ length: 13 }, (_, i) => `2026-11-${String(i + 2).padStart(2, "0")}`);
const PLAN = {
  goal: "Contract check plan",
  start: "2026-11-02",
  end: "2026-11-29",
  phases: [{ name: "Base", from: "2026-11-02", to: "2026-11-29", focus: "shape of the plan output" }],
  sessions: PLAN_DATES.map((date) => ({ date, title: "Session", ...(date === "2026-11-13" ? { guide: { ...GUIDE, date } } : {}) })),
};

type Ctx = { gymKey: string; runKey: string; routeId: string; gymDate: string };
// "tool#variant" records a second call of the same tool whose result has another shape.
const OUTPUT_CALLS: Record<string, (c: Ctx) => Record<string, unknown>> = {
  list_workouts: () => ({ limit: 5 }),
  get_workout: (c) => ({ workoutKey: c.gymKey }),
  get_workout_fit: (c) => ({ workoutKey: c.gymKey }),
  get_daily_snapshot: (c) => ({ date: c.gymDate }), // a day with a workout, so `workouts` has items
  "get_daily_snapshot#range": () => ({ date: FROM, to: DAY }),
  get_baselines: () => ({ date: DAY }),
  get_training_load: () => ({ date: DAY }),
  forecast_training_load: () => ({ days: [{ date: "2026-11-14", tss: 80 }, { date: "2026-11-16", tss: 60 }] }),
  get_workout_laps: (c) => ({ workoutKey: c.gymKey }),
  compare_workout_to_plan: (c) => ({ workoutKey: c.gymKey }),
  "compare_workout_to_plan#with-plan": (c) => ({ workoutKey: c.gymKey, plan: [{ name: "Bench Press", sets: 3, restSec: 90 }, { name: "Back Squat", sets: 3, restSec: 90 }] }),
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
  "get_plan#date": () => ({ date: "2026-11-13" }),
  get_catchup: () => ({}), // markSeen defaults to false: a pure read
  get_tag_effects: () => ({}),
  get_archive_status: () => ({}),
  get_benchmark: () => ({ guide: "push a", weeks: 8 }),
  "get_benchmark#exercise": () => ({ exercise: "Bench Press", weeks: 8 }),
  get_weekly_report: () => ({}), // save defaults to false: a pure read
  estimate_route_time: (c) => ({ routeId: c.routeId }),
  adjust_guide: () => ({ guide: GUIDE }),
  push_week_plan: () => ({ guides: [GUIDE] }), // not read-only; dryRun (the default) validates and sends nothing, in demo mode too
};
// Read-only tools with nothing to record in demo mode.
const SKIPPED: Record<string, string> = {
  get_upload_status: "needs the id of a real upload; demo mode only answers not found",
};

// Names the 1.x contract keeps stable besides the tools: the `bin` commands, the environment variables the code reads, MCP
// prompts (with their arguments) and MCP resources.
interface Surface {
  bin: string[];
  envVars: string[];
  prompts: Record<string, string[]>; // name -> its arguments, "*" marking a required one
  resources: string[];
  resourceTemplates: string[];
}

// Variables that are read but are no setting of the user's: the .mcpb manifest's own checkbox, translated before the server starts.
const INTERNAL_ENV = new Set(["SUUNTO_MCPB_DEMO"]);

function envVarsInSource(): string[] {
  const dir = join(repoRoot, "src");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/\bSUUNTO_[A-Z0-9_]+\b(?!\.md)/g)) names.add(m[0]);
    if (/process\.env\.PORT\b/.test(text)) names.add("PORT");
  }
  return [...names].sort();
}

interface Snapshot {
  tools: Record<string, ToolSnap>;
  outputs: Record<string, Shape>;
  surface: Surface;
}

// Where in a result the demo data never shows a value: a field that is always null, a list that is always empty, an object
// with no keys. Their inner shape is not in the fixture, so they are listed instead of looking covered.
function unobservedIn(shape: Shape, path = ""): string[] {
  const at = path || "(top level)";
  if (shape === "null") return [`${at}: always null`];
  if (typeof shape === "string") return [];
  if (Array.isArray(shape)) return shape.length === 0 ? [`${at}: always an empty list`] : unobservedIn(shape[0], `${path}[]`);
  const keys = Object.keys(shape);
  if (keys.length === 0) return [`${at}: always an empty object`];
  // a position that is null in some results and a value in others is observed: only the value's own inside can be unobserved
  if (keys.length === 1 && keys[0] === "$oneOf") return (shape.$oneOf as unknown as Shape[]).filter((part) => part !== "null").flatMap((part) => unobservedIn(part, path));
  return keys.flatMap((k) => unobservedIn(shape[k], path ? `${path}.${k}` : k));
}
const unobservedOf = (outputs: Record<string, Shape>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(outputs).map(([tool, shape]) => [tool, [...new Set(unobservedIn(shape))]] as [string, string[]]).filter(([, list]) => list.length > 0));

const OUTPUTS_ABOUT =
  "Key shape of what each tool returns in demo mode (frozen clock, fixed seed): keys and value type names, never values. A list is the union of its items' shapes. " +
  "`unobserved` lists the places where demo data is always null or empty, so the shape inside them is NOT checked. Regenerate with UPDATE_CONTRACT=1 npm test.";

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
    const gymDate = new Date(gym.startTime + gym.timeOffsetInMinutes * 60_000).toISOString().slice(0, 10);
    const ctx: Ctx = { gymKey: gym.workoutKey, runKey: run.workoutKey, routeId: routes[0].id, gymDate };
    await call("set_plan", PLAN);

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

    const prompts: Record<string, string[]> = {};
    for (const pr of (await rpc("prompts/list")).result.prompts as any[]) {
      prompts[pr.name] = ((pr.arguments ?? []) as any[]).map((arg) => `${arg.name}${arg.required ? "*" : ""}`).sort();
    }
    const resources = ((await rpc("resources/list")).result.resources as any[]).map((r) => r.uri as string).sort();
    const resourceTemplates = (((await rpc("resources/templates/list")).result?.resourceTemplates ?? []) as any[]).map((r) => r.uriTemplate as string).sort();
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const surface: Surface = { bin: Object.keys(pkg.bin).sort(), envVars: envVarsInSource(), prompts, resources, resourceTemplates };
    return { tools, outputs, surface };
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
    await writeFixture(outputsFixture, { about: OUTPUTS_ABOUT, unobserved: unobservedOf(outputs), shapes: outputs });
    return;
  }
  const expected = await readFixture(outputsFixture).catch(() => assert.fail("test-fixtures/contract/outputs.json is missing: run `UPDATE_CONTRACT=1 npm test`"));
  expectNoDiff("a read-only tool's output", diffShapes(expected.shapes, outputs));
  expectNoDiff("the list of unobserved fields in outputs.json", diffUnobserved(expected.unobserved, unobservedOf(outputs)));
});

test("contract: the fixture lists every field that demo data never fills, and the plan and a workout day are covered", async () => {
  const { outputs } = await snap();
  const unobserved = unobservedOf(outputs);
  // set_plan seeded the plan, and the snapshot day has a workout: these must show their inner shape, not sit in `unobserved`
  const shown = (tool: string, key: string) => assert.ok(!(unobserved[tool] ?? []).some((u) => u.startsWith(`${key}:`)), `${tool}: ${key} is unobserved: the seed in contract.test.ts no longer reaches it`);
  shown("get_plan", "plan");
  shown("get_plan", "plan.sessions");
  shown("get_daily_snapshot", "workouts");
  shown("get_weekly_report", "plan");
  shown("get_catchup", "plan");
  assert.ok(Object.keys((outputs.push_week_plan as { [k: string]: Shape }) ?? {}).includes("dryRun"), "push_week_plan is recorded as its dry run");
});

test("contract: bin commands, environment variables, MCP prompts and resources match test-fixtures/contract/surface.json", async () => {
  const { surface } = await snap();
  if (UPDATE) {
    await writeFixture(surfaceFixture, surface);
    return;
  }
  const expected = await readFixture(surfaceFixture).catch(() => assert.fail("test-fixtures/contract/surface.json is missing: run `UPDATE_CONTRACT=1 npm test`"));
  expectNoDiff("the names of bin commands, environment variables, prompts and resources", diffSurface(expected, surface));
});

test("contract: every bin command has a source file, and every environment variable the code reads is in the README's table", async () => {
  const { surface } = await snap();
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  for (const [cmd, target] of Object.entries<string>(pkg.bin)) {
    assert.match(target, /^dist\/[\w-]+\.js$/, `${cmd}: ${target}`);
    assert.ok(existsSync(join(repoRoot, "src", target.replace(/^dist\//, "").replace(/\.js$/, ".ts"))), `bin ${cmd} points at ${target}, which has no source file`);
  }
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");
  const table = readme.slice(readme.indexOf("## Environment variables"), readme.indexOf("## Local files"));
  assert.ok(table.length > 100, "README has no environment variables section");
  const missing = surface.envVars.filter((v) => !INTERNAL_ENV.has(v) && !table.includes(v));
  assert.deepEqual(missing, [], `the code reads these variables but the README's environment table does not name them: ${missing.join(", ")}`);
});

test("contract: the fixtures hold no values that depend on the day (shapes only: keys and type names)", async () => {
  const { outputs } = await snap();
  const text = JSON.stringify([outputs, unobservedOf(outputs)]);
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
  assert.match(mutate((t) => { t.inputSchema.properties.days.default = 7; }).join("\n"), /BREAKING: a: input schema days\.default changed/);
  assert.match(mutate((t) => { t.annotations.readOnlyHint = undefined; t.annotations.foo = true; }).join("\n"), /BREAKING: a: annotations changed/);
});

test("contract diff annotations: more cautious is additive with notice, less cautious is BREAKING, in each of the four hints", () => {
  const run = (before: object, after: object) => diffTools({ a: { inputSchema: {}, annotations: before as Json } }, { a: { inputSchema: {}, annotations: after as Json } });
  const w = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const cases: [string, object, object][] = [
    ["readOnlyHint", { readOnlyHint: true, openWorldHint: false }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
    ["destructiveHint", w, { ...w, destructiveHint: true }],
    ["idempotentHint", w, { ...w, idempotentHint: false }],
    ["openWorldHint", w, { ...w, openWorldHint: true }],
  ];
  for (const [key, before, after] of cases) {
    const more = run(before, after);
    assert.equal(more.length, 1, `${key}: ${more}`);
    assert.match(more[0], new RegExp(`^additive with notice.*: a: ${key} changed from`), key);
    const less = run(after, before);
    assert.equal(less.length, 1, `${key}: ${less}`);
    assert.match(less[0], new RegExp(`^BREAKING: a: ${key} changed from .*less cautious`), key);
  }
  // an explicit value equal to the default is no change at all
  assert.deepEqual(run({ readOnlyHint: false }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }), []);
  // destructive and idempotent say nothing about a read-only tool
  assert.deepEqual(run({ readOnlyHint: true, openWorldHint: true, destructiveHint: false }, { readOnlyHint: true, openWorldHint: true, destructiveHint: true }), []);
});

test("contract diff schema: an input that accepts more is additive, one that accepts less is BREAKING", () => {
  const prop = (p: object) => ({ inputSchema: { type: "object", properties: { x: { type: "number", ...p } } } as Json, annotations: {} });
  const run = (before: object, after: object) => diffTools({ a: prop(before) }, { a: prop(after) });
  const additive = (before: object, after: object) => {
    const d = run(before, after);
    assert.equal(d.length, 1, JSON.stringify([before, after, d]));
    assert.match(d[0], /^additive \(an input that accepts more/, JSON.stringify([before, after]));
  };
  const breaking = (before: object, after: object) => {
    const d = run(before, after);
    assert.equal(d.length, 1, JSON.stringify([before, after, d]));
    assert.match(d[0], /^BREAKING/, JSON.stringify([before, after]));
  };
  additive({ enum: [1, 2] }, { enum: [1, 2, 3] });
  breaking({ enum: [1, 2, 3] }, { enum: [1, 2] });
  breaking({ enum: [1, 2] }, { enum: [1, 3] });
  additive({ maximum: 10 }, { maximum: 20 });
  breaking({ maximum: 20 }, { maximum: 10 });
  additive({ minimum: 5 }, { minimum: 1 });
  breaking({ minimum: 1 }, { minimum: 5 });
  additive({ maxItems: 5 }, { maxItems: 14 });
  breaking({ maxItems: 14 }, { maxItems: 5 });
  additive({ minLength: 3 }, { minLength: 1 });
  breaking({ minLength: 1 }, { minLength: 3 });
  additive({ maximum: 10 }, {}); // a limit lifted
  breaking({}, { maximum: 10 }); // a limit added
  additive({ minimum: 1 }, {});
  breaking({}, { minimum: 1 });
  breaking({ type: "number" }, { type: "string" });
  breaking({ pattern: "^a" }, { pattern: "^b" });
  breaking({ default: 1 }, { default: 2 });
  // a widening inside an array item or a nested property is found too
  const nested = (n: number): ToolSnap => ({ inputSchema: { type: "object", properties: { l: { type: "array", items: { type: "object", properties: { v: { type: "integer", maximum: n } } } } } } as Json, annotations: {} });
  assert.match(diffTools({ a: nested(10) }, { a: nested(20) })[0], /^additive.*l\[\]\.v\.maximum changed from 10 to 20/);
  assert.match(diffTools({ a: nested(20) }, { a: nested(10) })[0], /^BREAKING.*l\[\]\.v\.maximum/);
});

test("contract diff schema: description and example text is not part of the contract", () => {
  const schema = { type: "object", description: "a", properties: { x: { type: "string", description: "b", examples: ["p"], example: "p" } } } as Json;
  const changed = { type: "object", description: "other words", properties: { x: { type: "string", description: "c", examples: ["q", "r"], example: "q" } } } as Json;
  assert.deepEqual(stripDescriptions(schema), stripDescriptions(changed));
  assert.deepEqual(stripDescriptions(schema), { type: "object", properties: { x: { type: "string" } } });
  assert.deepEqual(diffTools({ a: { inputSchema: stripDescriptions(schema), annotations: {} } }, { a: { inputSchema: stripDescriptions(changed), annotations: {} } }), []);
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

test("contract shape: a field the demo never filled (always null, an empty list) is listed as unobserved, and filling it later is additive", () => {
  const before = { t: shapeOf({ id: "k", last: null, sets: [], meta: {}, deep: { note: null, rows: [{ a: 1, b: null }] } }) };
  assert.deepEqual(unobservedOf(before), { t: ["deep.note: always null", "deep.rows[].b: always null", "last: always null", "meta: always an empty object", "sets: always an empty list"] });
  assert.deepEqual(unobservedOf({ t: shapeOf({ id: "k", rows: [{ a: 1 }] }) }), {}, "nothing unobserved, nothing listed");
  assert.deepEqual(unobservedOf({ t: shapeOf(null) }), { t: ["(top level): always null"] });
  assert.deepEqual(unobservedOf({ t: shapeOf({ x: [{ y: null }, { y: { d: 1 } }] }) }), {}, "null in one item and a value in another is observed");
  const now = shapeOf({ id: "k", last: "2026", sets: [{ reps: 8 }], meta: { m: 1 }, deep: { note: "n", rows: [{ a: 1, b: 2 }] } });
  const d = diffShapes(before, { t: now });
  assert.ok(d.length >= 4 && d.every((m) => m.startsWith("additive")), d.join("\n"));
  assert.match(d.join("\n"), /t: output last was always null in demo \(unobserved\) and now has a value/);
  assert.match(d.join("\n"), /t: output sets was always an empty list in demo \(unobserved\) and now has items/);
  // the reverse (a value that is now null, a list that is now empty) is BREAKING
  assert.ok(diffShapes({ t: now }, before).every((m) => m.startsWith("BREAKING")), diffShapes({ t: now }, before).join("\n"));
  // the list in the fixture must match what the demo shows now
  assert.deepEqual(diffUnobserved({ t: ["a: always null"] }, { t: ["a: always null"] }), []);
  assert.match(diffUnobserved({ t: ["a: always null"] }, {}).join("\n"), /^additive.*a: always null is now observed/);
  assert.match(diffUnobserved({}, { t: ["a: always null"] }).join("\n"), /^BREAKING: t: a: always null \(demo data no longer fills it\)/);
});

test("contract diff surface: a removed command, variable, prompt, argument or resource is BREAKING, a new one is additive", () => {
  const base = (): Surface => ({ bin: ["suunto-mcp", "suunto-mcp-auth"], envVars: ["SUUNTO_DEMO", "SUUNTO_CLIENT_ID"], prompts: { "suunto-morning": ["date"], "suunto-weekly": ["week", "x*"] }, resources: ["suunto://today/sleep"], resourceTemplates: [] });
  const change = (f: (x: Surface) => void) => {
    const x = base();
    f(x);
    return diffSurface(base(), x).join("\n");
  };
  assert.deepEqual(diffSurface(base(), base()), []);
  assert.match(change((x) => { x.bin.pop(); }), /BREAKING: bin command suunto-mcp-auth was removed/);
  assert.match(change((x) => { x.envVars = ["SUUNTO_DEMO"]; }), /BREAKING: environment variable SUUNTO_CLIENT_ID was removed/);
  assert.match(change((x) => { delete x.prompts["suunto-morning"]; }), /BREAKING: MCP prompt suunto-morning was removed/);
  assert.match(change((x) => { x.prompts["suunto-morning"] = []; }), /BREAKING: MCP prompt suunto-morning: argument date was removed/);
  assert.match(change((x) => { x.prompts["suunto-morning"] = ["date", "extra*"]; }), /BREAKING: MCP prompt suunto-morning: new argument extra is required/);
  assert.match(change((x) => { x.prompts["suunto-morning"] = ["date*"]; }), /BREAKING: MCP prompt suunto-morning: argument date became required/);
  assert.match(change((x) => { x.resources = []; }), /BREAKING: MCP resource suunto:\/\/today\/sleep was removed/);
  assert.match(change((x) => { x.prompts["suunto-morning"] = ["date", "extra"]; }), /^additive.*new argument extra/);
  assert.match(change((x) => { x.envVars.push("SUUNTO_NEW"); }), /^additive.*new environment variable SUUNTO_NEW/);
  assert.match(change((x) => { x.resources.push("suunto://x"); }), /^additive.*new MCP resource/);
});
