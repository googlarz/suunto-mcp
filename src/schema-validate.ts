// Minimal JSON-Schema-subset validator for MCP tool arguments. The tool
// definitions in index.ts already declare a full inputSchema (type,
// required, minimum/maximum, pattern, enum, minItems) — nothing in the MCP
// SDK enforces it server-side, so a call could pass limit: -1 straight
// through to the API layer. This validates incoming args against the exact
// schema already declared per tool, instead of hand-writing checks twice.
export function validateAgainstSchema(schema: any, value: any, path = "value"): string[] {
  if (schema === undefined || schema === null) return [];
  const errors: string[] = [];

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        break;
      }
      for (const req of schema.required ?? []) {
        if (!(req in value)) errors.push(`missing required property "${req}"`);
      }
      for (const [key, propSchema] of Object.entries<any>(schema.properties ?? {})) {
        if (value[key] !== undefined) {
          errors.push(...validateAgainstSchema(propSchema, value[key], key));
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`"${path}" must be an array`);
        break;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`"${path}" must have at least ${schema.minItems} item(s)`);
      }
      if (schema.items) {
        value.forEach((item: any, i: number) =>
          errors.push(...validateAgainstSchema(schema.items, item, `${path}[${i}]`)),
        );
      }
      break;
    }
    case "integer":
    case "number": {
      // Number.isNaN alone misses ±Infinity — JSON's 1e400 parses to
      // Infinity, which is typeof "number" and not NaN, so it sailed
      // through and corrupted digest state as null (JSON.stringify has no
      // Infinity representation).
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`"${path}" must be a finite number`);
        break;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`"${path}" must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`"${path}" must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`"${path}" must be <= ${schema.maximum}`);
      break;
    }
    case "string": {
      if (typeof value !== "string") {
        errors.push(`"${path}" must be a string`);
        break;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`"${path}" must be at least ${schema.minLength} character(s)`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`"${path}" must be at most ${schema.maxLength} character(s)`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(`"${path}" does not match required pattern ${schema.pattern}`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`"${path}" must be one of: ${schema.enum.join(", ")}`);
      }
      // A regex like ^\d{4}-\d{2}-\d{2}$ matches "2026-02-31" just fine —
      // it checks digit shape, not calendar validity. format: "date"/
      // "date-time" get an actual round-trip parse check on top.
      if (schema.format === "date" && !isValidCalendarDate(value)) {
        errors.push(`"${path}" is not a valid calendar date (YYYY-MM-DD)`);
      }
      if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
        errors.push(`"${path}" is not a valid date-time`);
      }
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") errors.push(`"${path}" must be a boolean`);
      break;
    }
    // No schema.type (or an unrecognized one): nothing declared to check.
  }
  return errors;
}

// new Date("2026-02-31") does NOT return Invalid Date — the ISO parser
// silently rolls it over to March 3rd (confirmed). Round-tripping back to
// an ISO date string and comparing catches what a pattern regex and a bare
// Date.parse both miss.
function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
