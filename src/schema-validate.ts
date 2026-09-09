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
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`"${path}" must be a number`);
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
