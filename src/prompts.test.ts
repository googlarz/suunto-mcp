import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PROMPTS, getPrompt } from "./prompts.js";

const text = (name: string, args?: Record<string, string>, today = "2026-10-29") =>
  getPrompt(name, args, today).messages[0].content.text;

test("suunto-morning defaults to today and names yesterday explicitly", () => {
  const t = text("suunto-morning");
  assert.match(t, /get_daily_snapshot ONCE with date=2026-10-28, to=2026-10-29/);
  assert.match(t, /get_training_load with date=2026-10-28, days=14/);
});

test("suunto-morning crosses month, year and leap-day boundaries", () => {
  assert.match(text("suunto-morning", { date: "2026-03-01" }), /date=2026-02-28, to=2026-03-01/);
  assert.match(text("suunto-morning", { date: "2028-03-01" }), /date=2028-02-29, to=2028-03-01/);
  assert.match(text("suunto-morning", { date: "2027-01-01" }), /date=2026-12-31, to=2027-01-01/);
});

test("suunto-weekly defaults endDate to yesterday and spans 14 days", () => {
  const t = text("suunto-weekly");
  assert.match(t, /date=2026-10-15, to=2026-10-28/);
  assert.match(t, /get_training_load with date=2026-10-28, days=28/);
  assert.match(t, /2026-10-22 to 2026-10-28/);
});

test("suunto-weekly explicit endDate across a leap day and year end", () => {
  assert.match(text("suunto-weekly", { endDate: "2028-03-05" }), /date=2028-02-21, to=2028-03-05/);
  assert.match(text("suunto-weekly", { endDate: "2027-01-03" }), /date=2026-12-21, to=2027-01-03/);
});

test("suunto-gym-today reads today's snapshot and yesterday's load", () => {
  const t = text("suunto-gym-today");
  assert.match(t, /get_daily_snapshot with date=2026-10-29/);
  assert.match(t, /get_training_load with date=2026-10-28, days=14/);
  assert.match(t, /20-30%/);
  assert.match(text("suunto-gym-today", { date: "2026-01-01" }), /date=2025-12-31, days=14/);
});

test("every prompt carries the accuracy notes and stays compact", () => {
  for (const p of PROMPTS) {
    const t = text(p.name);
    for (const s of ["led INTO", "`errors`", "Resources %", "1 point off", "active energy", "user's language"]) {
      assert.ok(t.includes(s), `${p.name} lacks "${s}"`);
    }
    assert.ok(t.length < 2048, `${p.name} is ${t.length} B`);
  }
});

test("invalid or malformed dates and unknown names are InvalidParams", () => {
  const cases: [string, Record<string, string>][] = [
    ["suunto-morning", { date: "2026-02-30" }],
    ["suunto-morning", { date: "yesterday" }],
    ["suunto-weekly", { endDate: "2026-13-01" }],
    ["suunto-gym-today", { date: "29-10-2026" }],
  ];
  for (const [name, args] of cases) {
    assert.throws(() => getPrompt(name, args, "2026-10-29"), (e: unknown) => e instanceof McpError && e.code === ErrorCode.InvalidParams, `${name} ${JSON.stringify(args)}`);
  }
  assert.throws(() => getPrompt("nope", {}, "2026-10-29"), (e: unknown) => e instanceof McpError && e.code === ErrorCode.InvalidParams);
});
