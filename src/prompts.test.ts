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
  assert.match(t, /get_baselines with date=2026-10-29:/, "the baseline is for the day itself, not yesterday");
  assert.match(t, /sleepDurationS, sleepScore\), HRV and waking recovery \(recoveryMorning\) against the user's own band/);
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
  assert.match(t, /get_baselines with date=2026-10-29\b/);
  assert.match(t, /cut the planned intensity by 20-30%/);
  assert.match(t, /metrics\.hrv\.latestVsBand or metrics\.sleepScore\.latestVsBand is 'below'/);
  assert.match(t, /p25 null means too little history/);
  assert.match(t, /latest null means last night has no value/);
  const jan = text("suunto-gym-today", { date: "2026-01-01" });
  assert.match(jan, /date=2025-12-31, days=14/);
  assert.match(jan, /get_baselines with date=2026-01-01\b/);
});

test("suunto-gym-review defaults to today, names both tools and the reliability check", () => {
  const t = text("suunto-gym-review");
  assert.match(t, /get_daily_snapshot with date=2026-10-29\./);
  assert.match(t, /hasLaps true\. If there are none, say so and stop/);
  assert.match(t, /compare_workout_to_plan and get_workout_rest_profile with its workoutKey/);
  assert.match(t, /Check `reliable` in both results first/);
  assert.match(t, /countdown.*not rest compliance/);
  for (const field of ["sets.length", "planned.sets", "t10S/t20S/t30S", "peakHr to endHr", "basis"]) assert.ok(t.includes(field), field);
  assert.match(text("suunto-gym-review", { date: "2028-02-29" }), /date=2028-02-29\./);
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
    ["suunto-gym-review", { date: "2026-02-30" }],
  ];
  for (const [name, args] of cases) {
    assert.throws(() => getPrompt(name, args, "2026-10-29"), (e: unknown) => e instanceof McpError && e.code === ErrorCode.InvalidParams, `${name} ${JSON.stringify(args)}`);
  }
  assert.throws(() => getPrompt("nope", {}, "2026-10-29"), (e: unknown) => e instanceof McpError && e.code === ErrorCode.InvalidParams);
});
