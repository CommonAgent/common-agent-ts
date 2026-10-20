/**
 * Signing and verifying a report (Agent Reputations §8.1.1 to §8.1.3).
 *
 * The signed bytes are the tag (`fdbk-report-v1`, or `fdbk-org-report-v1`
 * for an organization report), one line feed, and the JCS (RFC 8785)
 * canonical JSON of the signed object. The signature is Ed25519 over those
 * bytes, and it travels beside the object in an envelope with the key and the
 * key's id, all in padded base64. A consumer checks the key against the key
 * set it pinned for the bureau it asked, never against the envelope's word.
 *
 * Reports this bureau signed before 0.6.0 carry the same signed bytes (the
 * same tag and line feed, over canonical JSON that matches JCS for every value
 * a report holds) in an older envelope: the key as an nkey (`U…`), no key id,
 * and the signature in base64url. verifyReport reads both, and both are held
 * to the pinned key set, so the older envelope never brings its own trust.
 *
 * Pure: the shared crypto core (../crypto/), over node:crypto, and nothing else.
 */
import { decodeSignature, encodeSignature, jcs, rawFromBase64Key, rawUserKey, sha256Digest, signerFromRawSeed, toBase64, verifyRaw } from "@common-agent/crypto";

export const REPORT_TAG = "fdbk-report-v1";
export const ORG_REPORT_TAG = "fdbk-org-report-v1";
/** The `use` every report signing key carries in a key set (§8.1.2 rule 4). */
export const REPORT_KEY_USE = "fdbk-report-signing";
/** The clock-skew grace §8.1.3 step 5 recommends at most. */
export const CLOCK_GRACE_SECONDS = 60;

/** One entry of a bureau's key set (§8.1.2). */
export interface KeySetEntry {
  kid: string;
  key: string;
  status: "current" | "retired" | (string & {});
  use: string;
}

/** A bureau's key set, as `GET <bureau>/api/bureau-key` serves it (§8.1.2). */
export interface KeySet {
  bureau: string;
  keys: string[];
  key_set: KeySetEntry[];
}

/** What signs a report: the key it signs with, in padded base64, and Ed25519 over bytes. */
export interface ReportSigner {
  key: string;
  sign(bytes: Uint8Array): Uint8Array;
}

// ── JCS (RFC 8785) ───────────────────────────────────────────────────────────

const MAX_EXACT_INTEGER = 2 ** 53;

/**
 * The JCS canonical JSON of a value, from the shared crypto core: members
 * sorted by the UTF-16 code units of their names, and a value JCS has no form
 * for refused with a CanonicalJSONError: a number that is not finite, a
 * string or member name with a lone surrogate (JCS requires I-JSON), an
 * undefined member, and anything that is not plain JSON.
 */
export { jcs };

/** The bytes a report's signature covers: the tag, one line feed, and the JCS of the signed object (§8.1.1). */
export function signedBytes(tag: string, object: unknown): Uint8Array {
  return new TextEncoder().encode(`${tag}\n${jcs(object)}`);
}

// ── keys ─────────────────────────────────────────────────────────────────────

/** A key's id: the first 12 lowercase hex digits of the SHA-256 of its base64 text (§8.1.2 rule 1). */
export function kidOf(key: string): string {
  return sha256Digest(key).slice("sha256:".length, "sha256:".length + 12);
}

/** A key set for a bureau, in the order given within each status, current keys first (§8.1.2 rule 2). */
export function keySetFor(bureau: string, keys: ReadonlyArray<{ key: string; status: "current" | "retired" }>): KeySet {
  const ordered = [...keys.filter((k) => k.status === "current"), ...keys.filter((k) => k.status !== "current")];
  return {
    bureau,
    keys: ordered.map((k) => k.key),
    key_set: ordered.map((k) => ({ kid: kidOf(k.key), key: k.key, status: k.status, use: REPORT_KEY_USE })),
  };
}

/**
 * The 32-byte Ed25519 public key inside an nkey public user key (`U…`), the
 * form the bureau's reports carried before 0.6.0. Throws on anything else,
 * including a checksum that does not match.
 */
export function rawKeyFromNkey(nkey: string): Uint8Array {
  const raw = rawUserKey(nkey);
  if (!raw) throw new Error("not an nkey public user key, or its checksum does not match");
  return raw;
}

/** A raw 32-byte Ed25519 public key in the padded base64 a key set and an envelope carry. */
export function keyFromRaw(raw: Uint8Array): string {
  return toBase64(raw);
}

/** A signer from a 32-byte Ed25519 seed (RFC 8032 §5.1.5). The test vectors use one; a bureau may use its own. */
export function seedSigner(seed: Uint8Array): ReportSigner {
  const s = signerFromRawSeed(new Uint8Array(seed));
  return { key: keyFromRaw(s.raw), sign: s.sign };
}

// ── the envelope ─────────────────────────────────────────────────────────────

/** A signed report, or a signed organization report, in the envelope of §8.1. */
export type ReportEnvelope<M extends string = "report"> = { [K in M]: Record<string, unknown> } & {
  bureau_key: string;
  bureau_kid: string;
  bureau_sig: string;
};

/**
 * The first number in a value that a signed object may not hold (§8.1.1): an
 * integer whose magnitude is above 2^53, which JCS writes but not exactly. A
 * count that large is written as a string. Null when there is none.
 */
export function inexactInteger(value: unknown, path = "$"): string | null {
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) > MAX_EXACT_INTEGER ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = inexactInteger(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const found = inexactInteger(v, `${path}.${k}`);
      if (found) return found;
    }
  }
  return null;
}

/** Sign a report object and put it in its envelope (§8.1.1). Refuses an object holding an integer above 2^53. */
export function signReport<M extends string = "report">(object: Record<string, unknown>, signer: ReportSigner, opts: { tag?: string; member?: M } = {}): ReportEnvelope<M> {
  const tag = opts.tag ?? REPORT_TAG;
  const member = (opts.member ?? "report") as M;
  const inexact = inexactInteger(object);
  if (inexact) throw new Error(`the integer at ${inexact} is above 2^53; a signed object writes it as a string (§8.1.1)`);
  const sig = signer.sign(signedBytes(tag, object));
  return {
    [member]: object,
    bureau_key: signer.key,
    bureau_kid: kidOf(signer.key),
    bureau_sig: encodeSignature(sig),
  } as ReportEnvelope<M>;
}

export type VerifyResult =
  | { ok: true; format: "0.6.0" | "pre-0.6.0"; kid: string }
  | { ok: false; reason: string };

/**
 * What the consumer asked about, which the report must answer (§8.1.3 step 6).
 * A report answers about a subject and a capability; `capability: null` means
 * the consumer asked about none in particular, which only a report from before
 * 0.6.0 can answer, because those carry every capability in one list. An
 * organization report answers about an anchor.
 */
export type ExpectedAnswer = { subject: string; capability: string | null } | { anchor: string };

export interface VerifyOptions {
  /** The pinned key set for the bureau the consumer asked (§8.1.2). */
  keySet: KeySet;
  /** The URL of the bureau the consumer asked (§8.1.3 step 2). */
  bureau: string;
  /** The verification instant. Anything that is not a time fails verification. */
  now: number | string | Date;
  /** What the consumer asked about (§8.1.3 step 6). */
  expect: ExpectedAnswer;
  tag?: string;
  member?: string;
  graceSeconds?: number;
}

const fail = (reason: string): VerifyResult => ({ ok: false, reason });
const trimUrl = (u: string) => u.replace(/\/+$/, "");

/**
 * The steps of §8.1.3 that need no network, in order, stopping at the first
 * that fails: the envelope, the bureau, the key against the pinned set, the
 * signature, the time window, and the answer. The reasons are the conformance
 * file's words where it has them.
 *
 * An envelope from before 0.6.0 (an nkey `bureau_key`, no `bureau_kid`, a
 * base64url signature) is read too. Its key must still be in the pinned set,
 * as the same 32 bytes, so it is trusted no further than a 0.6.0 envelope.
 *
 * This takes a parsed envelope, so it cannot see a member name repeated in
 * the text; a consumer holding the text calls verifyReportText instead.
 */
export function verifyReport(envelope: unknown, opts: VerifyOptions): VerifyResult {
  const tag = opts.tag ?? REPORT_TAG;
  const member = opts.member ?? "report";

  // 1. The envelope.
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return fail("the envelope is not an object");
  const env = envelope as Record<string, unknown>;
  const obj = env[member];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return fail(`the envelope has no ${member}`);
  for (const k of ["bureau_key", "bureau_sig"]) if (typeof env[k] !== "string" || !env[k]) return fail(`the envelope has no ${k}`);
  const legacy = !("bureau_kid" in env) && /^U[A-Z2-7]{55}$/.test(env.bureau_key as string);
  if (!legacy && (typeof env.bureau_kid !== "string" || !env.bureau_kid)) return fail("the envelope has no bureau_kid");
  const allowed = new Set([member, "bureau_key", "bureau_sig", ...(legacy ? [] : ["bureau_kid"])]);
  const extra = Object.keys(env).find((k) => !allowed.has(k));
  if (extra !== undefined) return fail(`the envelope holds a member it may not: ${extra}`);
  const report = obj as Record<string, unknown>;

  // 2. The bureau, and a key set pinned for that same bureau.
  if (report.bureau !== opts.bureau) return fail("the report names another bureau");
  if (typeof opts.keySet?.bureau !== "string" || trimUrl(opts.keySet.bureau) !== trimUrl(opts.bureau)) {
    return fail("the key set is for another bureau");
  }

  // 3. The key.
  let entry: KeySetEntry | undefined;
  if (legacy) {
    let key: string;
    try {
      key = keyFromRaw(rawKeyFromNkey(env.bureau_key as string));
    } catch {
      return fail("the key is not in the pinned key set");
    }
    entry = opts.keySet.key_set.find((k) => k.key === key);
  } else {
    entry = opts.keySet.key_set.find((k) => k.kid === env.bureau_kid);
    if (entry && entry.key !== env.bureau_key) entry = undefined;
  }
  if (!entry || entry.use !== REPORT_KEY_USE || (entry.status !== "current" && entry.status !== "retired")) {
    return fail("the key is not in the pinned key set");
  }

  // 4. The signature, over the JCS of the object as parsed.
  let bytes: Uint8Array;
  try {
    bytes = signedBytes(tag, report);
  } catch {
    return fail("the report holds a value JCS cannot write");
  }
  const sig = decodeSignature(env.bureau_sig, legacy ? "base64url" : "base64");
  if (!sig) return fail("the signature is not encoded as the envelope requires");
  if (!verifyRaw(rawFromBase64Key(entry.key), bytes, sig)) return fail("the signature does not verify");

  // 5. The time.
  const now = opts.now instanceof Date ? opts.now.getTime() : typeof opts.now === "number" ? opts.now : Date.parse(String(opts.now));
  if (!Number.isFinite(now)) return fail("the verification instant is not a time");
  const graceSeconds = opts.graceSeconds ?? CLOCK_GRACE_SECONDS;
  if (typeof graceSeconds !== "number" || !Number.isFinite(graceSeconds) || graceSeconds < 0) return fail("the clock grace is not a number of seconds");
  const grace = graceSeconds * 1000;
  const expires = Date.parse(String(report.expires_at));
  const issued = Date.parse(String(report.issued_at));
  if (!Number.isFinite(expires) || expires + grace < now) return fail("the report has expired");
  if (!Number.isFinite(issued) || issued - grace > now) return fail("the report was issued in the future");

  // 6. The answer.
  const asked = opts.expect;
  if (!asked || typeof asked !== "object") return fail("the consumer did not say what it asked about");
  if ("anchor" in asked) {
    if (typeof asked.anchor !== "string" || report.anchor !== asked.anchor) return fail("the report answers about another anchor");
  } else {
    if (typeof asked.subject !== "string" || report.subject !== asked.subject) return fail("the report answers about another subject");
    if (!answersCapability(report, asked.capability)) return fail("the report answers about another capability");
  }

  return { ok: true, format: legacy ? "pre-0.6.0" : "0.6.0", kid: entry.kid };
}

/**
 * Whether a report answers about the capability asked. A 0.6.0 report names
 * one, at the top. A report from before 0.6.0 names none at the top and lists
 * its capabilities instead: asked about one, every entry must be that one;
 * asked about none, it answers for all of them, which only that kind can.
 */
function answersCapability(report: Record<string, unknown>, asked: string | null | undefined): boolean {
  if (asked === undefined) return false;
  if ("capability" in report) return asked !== null && report.capability === asked;
  if (!Array.isArray(report.capabilities)) return false;
  if (asked === null) return true;
  return report.capabilities.every((c) => (c as { capability?: unknown } | null)?.capability === asked);
}

/**
 * §8.1.3 from the text a consumer received: the text must be one JSON value
 * with no member name repeated in any object (§8.1.1), and then the envelope
 * it holds must verify.
 */
export function verifyReportText(text: string, opts: VerifyOptions): VerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("the envelope is not JSON");
  }
  const repeated = repeatedMember(text);
  if (repeated !== null) return fail(`the envelope repeats the member ${repeated}`);
  return verifyReport(parsed, opts);
}

/**
 * The first member name that repeats inside one object of a JSON text, or
 * null. JSON.parse keeps the last of two members with one name, so a consumer
 * that must reject a report with a repeated member (§8.1.1, §8.1.3 step 1)
 * checks the text it received before parsing it.
 */
export function repeatedMember(text: string): string | null {
  const stack: Array<{ keys: Set<string> | null; expectKey: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null, expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," || c === ":") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = c === ",";
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        // A name that is not valid JSON is compared as written; the caller's
        // parse refuses the text anyway, and this never throws.
        let name: string;
        try {
          name = JSON.parse(text.slice(i, j + 1)) as string;
        } catch {
          name = text.slice(i, j + 1);
        }
        if (top.keys.has(name)) return name;
        top.keys.add(name);
        top.expectKey = false;
      }
      i = j;
    }
  }
  return null;
}
