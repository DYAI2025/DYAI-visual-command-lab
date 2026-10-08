// Minimal JSON Schema interpreter for the contract schemas in ./schemas.
// Before validating, it checks the whole schema: every keyword must be in SUPPORTED_KEYWORDS and
// carry a value of the expected shape. Anything else (unknown keywords, tuple `items`, boolean
// subschemas, `$ref` with sibling keywords or without a target, `$ref` cycles, a non-array
// `required`, ...) throws, so a schema can never appear to enforce a rule that this interpreter does
// not check. Issue paths are RFC 6901 JSON pointers ("" is the document root).

import type { IssueCode } from "./issue-codes.ts";

export type SchemaIssueCode = Extract<IssueCode, `SCHEMA_${string}`>;

export interface SchemaIssue {
  code: SchemaIssueCode;
  path: string;
  message: string;
}

type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
type Schema = { [keyword: string]: unknown };

const JSON_TYPES = new Set<string>(["object", "array", "string", "number", "integer", "boolean", "null"]);

export class UnsupportedSchemaKeywordError extends Error {
  constructor(keyword: string, path: string) {
    super(`Schema keyword "${keyword}" at ${path || "/"} is not supported by the contract validator`);
    this.name = "UnsupportedSchemaKeywordError";
  }
}

function isPlainObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isNonNegativeInteger = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const isStringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

// Shape each supported keyword's value must have. Subschema-bearing keywords are walked separately.
const KEYWORD_VALUE_CHECKS: Record<string, (value: unknown) => boolean> = {
  $id: (value) => typeof value === "string",
  $defs: isPlainObject,
  $ref: (value) => typeof value === "string" && value.startsWith("#/$defs/"),
  title: (value) => typeof value === "string",
  description: (value) => typeof value === "string",
  type: (value) =>
    (typeof value === "string" && JSON_TYPES.has(value)) ||
    (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && JSON_TYPES.has(item))),
  properties: isPlainObject,
  required: isStringArray,
  additionalProperties: (value) => value === false,
  items: isPlainObject,
  enum: (value) => Array.isArray(value) && value.length > 0,
  const: () => true,
  pattern: (value) => typeof value === "string",
  minLength: isNonNegativeInteger,
  minItems: isNonNegativeInteger,
  uniqueItems: (value) => typeof value === "boolean",
  minimum: (value) => typeof value === "number" && Number.isFinite(value),
  maximum: (value) => typeof value === "number" && Number.isFinite(value),
};

function assertSupported(schema: unknown, path: string, root: Schema): void {
  if (!isPlainObject(schema)) throw new UnsupportedSchemaKeywordError("non-object (boolean or array) subschema", path);
  if (Object.hasOwn(schema, "$ref") && Object.keys(schema).some((key) => key !== "$ref")) {
    throw new UnsupportedSchemaKeywordError("$ref with sibling keywords", path);
  }
  if (typeof schema.$ref === "string") resolveRef(root, schema.$ref, path);
  for (const [keyword, value] of Object.entries(schema)) {
    const check = Object.hasOwn(KEYWORD_VALUE_CHECKS, keyword) ? KEYWORD_VALUE_CHECKS[keyword] : undefined;
    if (!check) throw new UnsupportedSchemaKeywordError(keyword, path);
    if (!check(value)) throw new UnsupportedSchemaKeywordError(`${keyword} with value ${JSON.stringify(value)}`, path);
  }
  if (typeof schema.pattern === "string") {
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      throw new UnsupportedSchemaKeywordError(`pattern ${schema.pattern} (invalid regular expression)`, path);
    }
  }
  for (const key of ["properties", "$defs"] as const) {
    const children = schema[key];
    if (isPlainObject(children)) {
      for (const [name, child] of Object.entries(children)) {
        assertSupported(child, `${path}/${key}/${pointerToken(name)}`, root);
      }
    }
  }
  if (Object.hasOwn(schema, "items")) assertSupported(schema.items, `${path}/items`, root);
}

/** Follows a chain of $refs to a schema that is not itself a $ref; throws on a missing target or a cycle. */
function resolveRef(root: Schema, ref: string, path: string): Schema {
  const seen = new Set<string>();
  let current = ref;
  for (;;) {
    if (seen.has(current)) throw new UnsupportedSchemaKeywordError(`$ref ${ref} (cycle)`, path);
    seen.add(current);
    const name = current.slice("#/$defs/".length);
    const defs = root.$defs;
    const target = isPlainObject(defs) && Object.hasOwn(defs, name) ? defs[name] : undefined;
    if (!isPlainObject(target)) throw new UnsupportedSchemaKeywordError(`$ref ${current} (no such $defs entry)`, path);
    if (typeof target.$ref !== "string") return target;
    current = target.$ref;
  }
}

/** RFC 6901 reference token: "~" -> "~0", "/" -> "~1". */
export const pointerToken = (key: string | number) => String(key).replaceAll("~", "~0").replaceAll("/", "~1");

function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value as JsonType;
}

function matchesType(value: unknown, expected: JsonType): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

// JSON Schema equality: object key order does not matter.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateAgainstSchema(root: Schema, value: unknown): SchemaIssue[] {
  assertSupported(root, "", root);
  const issues: SchemaIssue[] = [];
  const report = (code: SchemaIssueCode, path: string, message: string) => issues.push({ code, path, message });
  const resolve = (schema: Schema): Schema =>
    typeof schema.$ref === "string" ? resolveRef(root, schema.$ref, "") : schema;

  const visit = (input: Schema, node: unknown, path: string): void => {
    const schema = resolve(input);

    if (schema.type !== undefined) {
      const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as JsonType[];
      if (!types.some((type) => matchesType(node, type))) {
        report("SCHEMA_TYPE", path, `expected ${types.join(" | ")}, got ${typeOf(node)}`);
        return;
      }
    }
    if (Object.hasOwn(schema, "const") && canonical(node) !== canonical(schema.const)) {
      report("SCHEMA_CONST", path, `expected ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((option) => canonical(option) === canonical(node))) {
      report("SCHEMA_ENUM", path, `expected one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
    }

    if (typeof node === "string") {
      if (typeof schema.minLength === "number" && [...node].length < schema.minLength) {
        report("SCHEMA_MIN_LENGTH", path, `shorter than ${schema.minLength}`);
      }
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(node)) {
        report("SCHEMA_PATTERN", path, `does not match ${schema.pattern}`);
      }
    }

    if (typeof node === "number") {
      if (typeof schema.minimum === "number" && node < schema.minimum) {
        report("SCHEMA_MINIMUM", path, `below ${schema.minimum}`);
      }
      if (typeof schema.maximum === "number" && node > schema.maximum) {
        report("SCHEMA_MAXIMUM", path, `above ${schema.maximum}`);
      }
    }

    if (Array.isArray(node)) {
      if (typeof schema.minItems === "number" && node.length < schema.minItems) {
        report("SCHEMA_MIN_ITEMS", path, `fewer than ${schema.minItems} items`);
      }
      if (schema.uniqueItems === true && new Set(node.map(canonical)).size !== node.length) {
        report("SCHEMA_UNIQUE_ITEMS", path, "items are not unique");
      }
      if (isPlainObject(schema.items)) {
        const items = schema.items;
        node.forEach((item, index) => visit(items, item, `${path}/${pointerToken(index)}`));
      }
    }

    if (isPlainObject(node)) {
      const properties = isPlainObject(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) {
        for (const key of schema.required as string[]) {
          if (!Object.hasOwn(node, key)) report("SCHEMA_REQUIRED", `${path}/${pointerToken(key)}`, "is required");
        }
      }
      for (const [key, child] of Object.entries(node)) {
        const childSchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (isPlainObject(childSchema)) {
          visit(childSchema, child, `${path}/${pointerToken(key)}`);
        } else if (schema.additionalProperties === false) {
          report("SCHEMA_ADDITIONAL_PROPERTY", `${path}/${pointerToken(key)}`, "is not allowed");
        }
      }
    }
  };

  visit(root, value, "");
  return issues;
}
