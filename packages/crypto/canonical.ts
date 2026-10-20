/**
 * Canonical JSON, the bytes every signature and digest in the contracting
 * standards covers.
 *
 * Two forms, which agree on every value a parsed JSON document can hold
 * except a string with a lone surrogate:
 *
 * - `canonicalJSON` is the family's canonical JSON as the SDKs write it:
 *   object members sorted by the UTF-16 code units of their names
 *   (JavaScript's default sort), members whose value is `undefined` left out,
 *   no whitespace, and strings and numbers as `JSON.stringify` writes them,
 *   which for these values is RFC 8785 (JCS). A lone surrogate is written as
 *   its `\u` escape, as `JSON.stringify` does.
 * - `jcs` is RFC 8785 over I-JSON (RFC 7493): the same bytes, but a lone
 *   surrogate and a member whose value is `undefined` are refused. Agent
 *   Reputations signs with it (§8.1.1).
 *
 * Both refuse what has no JSON spelling, where the SDKs would write text that
 * is not JSON or does not read back as the value signed: a number that is not
 * finite, `undefined` (or a function or a symbol) as an array element or as
 * the whole value, a function or a symbol as a member, a BigInt, and any
 * object that is not a plain object or an array (a Date, a Map, a typed
 * array, a class instance). A refusal throws a `CanonicalJSONError` naming
 * the place in the value.
 */

export class CanonicalJSONError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJSONError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface Mode {
  /** Refuse a string or member name holding a lone surrogate (I-JSON, RFC 7493). */
  iJson: boolean;
  /** Refuse a member whose value is `undefined`, rather than leave it out. */
  refuseUndefined: boolean;
}

/** How canonicalJSON treats a member whose value is `undefined`. */
export interface CanonicalOptions {
  /** `drop` (the default) leaves the member out, as the SDKs do; `refuse` throws. */
  undefinedMembers?: "drop" | "refuse";
  /** The name of the value in error messages, `$` by default. */
  path?: string;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function kindOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  return (value as object).constructor?.name ?? "object";
}

function str(text: string, path: string, mode: Mode, what: string): string {
  if (mode.iJson && LONE_SURROGATE.test(text)) {
    throw new CanonicalJSONError(`the ${what} at ${path} holds a lone surrogate, which I-JSON (RFC 7493) forbids`);
  }
  return JSON.stringify(text);
}

function write(value: unknown, path: string, mode: Mode): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return str(value, path, mode, "string");
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJSONError(`canonical JSON has no spelling for the non-finite number ${value} at ${path}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJSONError(`canonical JSON has no spelling for a ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (v === undefined) throw new CanonicalJSONError(`canonical JSON has no spelling for an empty or undefined element at ${path}[${i}]`);
      out.push(write(v, `${path}[${i}]`, mode));
    }
    return `[${out.join(",")}]`;
  }
  if (!isPlainObject(value as object)) {
    throw new CanonicalJSONError(`canonical JSON has no spelling for a ${kindOf(value)} at ${path}: only plain JSON (null, booleans, finite numbers, strings, arrays and plain objects) has one`);
  }
  const obj = value as Record<string, unknown>;
  const members: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined) {
      if (mode.refuseUndefined) throw new CanonicalJSONError(`canonical JSON has no spelling for the undefined member ${path}.${k}`);
      continue;
    }
    members.push(`${str(k, path, mode, "member name in the object")}:${write(v, `${path}.${k}`, mode)}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * The canonical JSON of a value, as the family's SDKs write it: sorted
 * members, `undefined` members left out (or refused, with
 * `undefinedMembers: "refuse"`), no whitespace. Throws a
 * `CanonicalJSONError` on a value that has no JSON spelling.
 */
export function canonicalJSON(value: unknown, options: CanonicalOptions = {}): string {
  return write(value, options.path ?? "$", { iJson: false, refuseUndefined: options.undefinedMembers === "refuse" });
}

/**
 * RFC 8785 (JCS) over I-JSON: `canonicalJSON`, refusing also a string or a
 * member name with a lone surrogate and a member whose value is `undefined`.
 */
export function jcs(value: unknown, path = "$"): string {
  return write(value, path, { iJson: true, refuseUndefined: true });
}
