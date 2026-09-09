import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgainstSchema } from "./schema-validate.js";

const listWorkoutsSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 1000, default: 25 },
    since: { type: "string" },
  },
};

test("validateAgainstSchema: rejects a below-minimum integer (limit: -1)", () => {
  const errors = validateAgainstSchema(listWorkoutsSchema, { limit: -1 });
  assert.ok(errors.some((e) => e.includes("limit") && e.includes(">=")));
});

test("validateAgainstSchema: rejects an above-maximum integer", () => {
  const errors = validateAgainstSchema(listWorkoutsSchema, { limit: 5000 });
  assert.ok(errors.some((e) => e.includes("limit") && e.includes("<=")));
});

test("validateAgainstSchema: accepts a value within range", () => {
  assert.deepEqual(validateAgainstSchema(listWorkoutsSchema, { limit: 10 }), []);
});

test("validateAgainstSchema: flags missing required properties", () => {
  const schema = { type: "object", properties: { workoutKey: { type: "string" } }, required: ["workoutKey"] };
  const errors = validateAgainstSchema(schema, {});
  assert.ok(errors.some((e) => e.includes("workoutKey")));
});

test("validateAgainstSchema: enforces string pattern", () => {
  const schema = { type: "object", properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } } };
  assert.equal(validateAgainstSchema(schema, { date: "not-a-date" }).length, 1);
  assert.deepEqual(validateAgainstSchema(schema, { date: "2026-01-01" }), []);
});

test("validateAgainstSchema: enforces array minItems", () => {
  const schema = { type: "object", properties: { exercises: { type: "array", minItems: 1 } } };
  assert.equal(validateAgainstSchema(schema, { exercises: [] }).length, 1);
});
