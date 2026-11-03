// A small JSON Schema (draft 2020-12) validator for the tests, covering the
// keywords schema/agentdoc-v1.schema.json uses and refusing any other, so a
// keyword added to the schema without support here fails loudly rather than
// passing silently. The package takes no runtime dependency, and this keeps
// the tests free of one too.
type Json = unknown;
type Schema = Record<string, unknown> | boolean;

const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type", "required", "properties", "additionalProperties",
  "items", "enum", "const", "minItems", "minLength", "pattern", "oneOf", "anyOf", "allOf", "not",
]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function typeOk(t: string, v: Json): boolean {
  switch (t) {
    case "object": return isObj(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "number": return typeof v === "number";
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: throw new Error(`unknown type ${t}`);
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The places a value breaks the schema; empty when it validates. */
export function validate(root: Record<string, unknown>, value: Json): string[] {
  const errors: string[] = [];
  const resolveRef = (ref: string): Schema => {
    if (!ref.startsWith("#/")) throw new Error(`only local $ref is supported: ${ref}`);
    let cur: unknown = root;
    for (const part of ref.slice(2).split("/")) cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) throw new Error(`unresolved $ref ${ref}`);
    return cur as Schema;
  };
  const run = (s: Schema, v: Json, at: string, out: string[]): void => {
    if (s === true) return;
    if (s === false) return void out.push(`${at}: nothing is allowed here`);
    for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) throw new Error(`the test validator does not support ${k}`);
    if (typeof s.$ref === "string") run(resolveRef(s.$ref), v, at, out);
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeOk(t, v))) return void out.push(`${at}: expected ${types.join(" or ")}`);
    }
    if (s.const !== undefined && !same(s.const, v)) out.push(`${at}: expected ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) out.push(`${at}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
    if (typeof v === "string") {
      if (typeof s.minLength === "number" && [...v].length < s.minLength) out.push(`${at}: shorter than ${s.minLength}`);
      if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) out.push(`${at}: does not match ${s.pattern}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`);
      if (s.items !== undefined) v.forEach((x, i) => run(s.items as Schema, x, `${at}[${i}]`, out));
    }
    if (isObj(v)) {
      for (const r of (s.required as string[] | undefined) ?? []) if (!(r in v)) out.push(`${at}: ${r} is required`);
      const props = (s.properties as Record<string, Schema> | undefined) ?? {};
      for (const [k, x] of Object.entries(v)) {
        if (k in props) run(props[k]!, x, `${at}.${k}`, out);
        else if (s.additionalProperties !== undefined) run(s.additionalProperties as Schema, x, `${at}.${k}`, out);
      }
    }
    if (Array.isArray(s.allOf)) for (const sub of s.allOf) run(sub as Schema, v, at, out);
    if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => { const e: string[] = []; run(sub as Schema, v, at, e); return !e.length; })) out.push(`${at}: matches none of anyOf`);
    if (Array.isArray(s.oneOf)) {
      const n = s.oneOf.filter((sub) => { const e: string[] = []; run(sub as Schema, v, at, e); return !e.length; }).length;
      if (n !== 1) out.push(`${at}: matches ${n} of oneOf, not exactly one`);
    }
    if (s.not !== undefined) {
      const e: string[] = [];
      run(s.not as Schema, v, at, e);
      if (!e.length) out.push(`${at}: matches what not forbids`);
    }
  };
  run(root, value, "$", errors);
  return errors;
}
