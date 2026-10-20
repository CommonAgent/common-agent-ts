import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  ORG_REPORT_TAG,
  REPORT_KEY_USE,
  REPORT_TAG,
  inexactInteger,
  jcs,
  keyFromRaw,
  keySetFor,
  kidOf,
  rawKeyFromNkey,
  repeatedMember,
  seedSigner,
  signReport,
  signedBytes,
  verifyReport,
  verifyReportText,
  type VerifyOptions,
} from "../index.js";

const seed = (text: string) => createHash("sha256").update(text).digest();
const BUREAU = "https://bureau.example";
const NOW = "2026-10-19T12:00:00.000Z";
const SUBJECT = "U".padEnd(56, "A");

/** A 0.6.0 report: one subject, one capability. */
const report = (over: Record<string, unknown> = {}) => ({
  subject: SUBJECT,
  capability: "code-review",
  enrollment: "RATED",
  formula_version: "fdbk-score-1",
  bureau: BUREAU,
  issued_at: "2026-10-19T11:30:00.000Z",
  expires_at: "2026-10-19T12:30:00.000Z",
  ...over,
});

/** A report as this bureau signed them before 0.6.0: no top-level capability, a list of them instead. */
const oldReport = (capabilities: string[] = ["research"]) => ({
  subject: SUBJECT,
  enrollment: "ENROLLED",
  capabilities: capabilities.map((capability) => ({ capability, enrollment: "UNPROVEN", quality: { n_eff: 1 } })),
  formula_version: "fdbk-score-1",
  bureau: BUREAU,
  issued_at: "2026-10-19T11:30:00.000Z",
  expires_at: "2026-10-19T12:30:00.000Z",
});

const signer = seedSigner(seed("bureau"));
const pinned = keySetFor(BUREAU, [{ key: signer.key, status: "current" }]);
const asked = (over: Partial<VerifyOptions> = {}): VerifyOptions => ({
  keySet: pinned,
  bureau: BUREAU,
  now: NOW,
  expect: { subject: SUBJECT, capability: "code-review" },
  ...over,
});

/** The nkey public user key of a raw Ed25519 key: the form pre-0.6.0 reports carried. */
function nkeyOf(raw: Uint8Array): string {
  const body = Uint8Array.from([20 << 3, ...raw]);
  let crc = 0;
  for (const b of body) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  const bytes = Uint8Array.from([...body, crc & 0xff, crc >> 8]);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

const legacy = (r: Record<string, unknown>) => ({
  report: r,
  bureau_key: nkeyOf(Buffer.from(signer.key, "base64")),
  bureau_sig: Buffer.from(signer.sign(signedBytes(REPORT_TAG, r))).toString("base64url"),
});

describe("the key set (§8.1.2)", () => {
  it("names each key by the first 12 hex digits of the SHA-256 of its base64, the current key first", () => {
    const current = seedSigner(seed("current")).key;
    const retired = seedSigner(seed("retired")).key;
    const set = keySetFor(BUREAU, [{ key: retired, status: "retired" }, { key: current, status: "current" }]);
    expect(set.keys).toEqual([current, retired]);
    expect(set.key_set[0]).toEqual({ kid: createHash("sha256").update(current).digest("hex").slice(0, 12), key: current, status: "current", use: REPORT_KEY_USE });
    expect(set.key_set[1].status).toBe("retired");
  });
});

describe("JCS (§8.1.1)", () => {
  it("refuses a lone surrogate, in a value or a member name", () => {
    expect(() => jcs({ a: "\uD800" })).toThrow(/lone surrogate/);
    expect(() => jcs({ "\uDC00": 1 })).toThrow(/lone surrogate/);
    expect(jcs({ a: "😀" })).toBe('{"a":"😀"}');
  });
});

describe("signing (§8.1.1)", () => {
  it("signs and verifies a report, and a retired key still verifies", () => {
    const env = signReport(report(), signer);
    expect(env.bureau_kid).toBe(kidOf(signer.key));
    const rotated = keySetFor(BUREAU, [{ key: seedSigner(seed("newer")).key, status: "current" }, { key: signer.key, status: "retired" }]);
    expect(verifyReport(env, asked({ keySet: rotated }))).toEqual({ ok: true, format: "0.6.0", kid: env.bureau_kid });
  });

  it("refuses to sign an integer JCS cannot write exactly", () => {
    expect(inexactInteger({ a: [1, { b: 2 ** 53 + 2 }] })).toBe("$.a[1].b");
    expect(inexactInteger({ a: 2 ** 53, b: 0.5 })).toBeNull();
    expect(() => signReport(report({ huge: 2 ** 60 }), signer)).toThrow(/above 2\^53/);
  });
});

describe("verifying (§8.1.3)", () => {
  it("refuses a key whose use is not report signing, and a kid naming a different key", () => {
    const env = signReport(report(), signer);
    const wrongUse = keySetFor(BUREAU, [{ key: signer.key, status: "current" }]);
    wrongUse.key_set[0].use = "registrar-card-signing";
    expect(verifyReport(env, asked({ keySet: wrongUse }))).toEqual({ ok: false, reason: "the key is not in the pinned key set" });
    const other = seedSigner(seed("other")).key;
    const both = keySetFor(BUREAU, [{ key: signer.key, status: "current" }, { key: other, status: "retired" }]);
    expect(verifyReport({ ...env, bureau_key: other }, asked({ keySet: both }))).toEqual({ ok: false, reason: "the key is not in the pinned key set" });
  });

  it("refuses an envelope holding any member beside the object and the three bureau members", () => {
    const env = signReport(report(), signer);
    expect(verifyReport({ ...env, endorsed: true }, asked())).toEqual({ ok: false, reason: "the envelope holds a member it may not: endorsed" });
  });

  it("refuses a key set pinned for another bureau", () => {
    const env = signReport(report(), signer);
    const elsewhere = keySetFor("https://other.example", [{ key: signer.key, status: "current" }]);
    expect(verifyReport(env, asked({ keySet: elsewhere }))).toEqual({ ok: false, reason: "the key set is for another bureau" });
  });

  it("reads the signature only in its one encoding: padded base64 of 64 bytes", () => {
    const env = signReport(report(), signer);
    for (const sig of [env.bureau_sig.replace(/=+$/, ""), ` ${env.bureau_sig}`, env.bureau_sig.replace(/\+/g, "-").replace(/\//g, "_"), `${env.bureau_sig}==`]) {
      if (sig === env.bureau_sig) continue;
      expect(verifyReport({ ...env, bureau_sig: sig }, asked())).toEqual({ ok: false, reason: "the signature is not encoded as the envelope requires" });
    }
  });

  it("fails rather than skips the time check when the instant or the grace is not a number", () => {
    const env = signReport(report({ expires_at: "2026-10-19T11:40:00.000Z" }), signer);
    expect(verifyReport(env, asked({ now: "not a time" }))).toEqual({ ok: false, reason: "the verification instant is not a time" });
    expect(verifyReport(env, asked({ now: undefined as unknown as string }))).toEqual({ ok: false, reason: "the verification instant is not a time" });
    expect(verifyReport(env, asked({ graceSeconds: Number.NaN }))).toEqual({ ok: false, reason: "the clock grace is not a number of seconds" });
    expect(verifyReport(env, asked())).toEqual({ ok: false, reason: "the report has expired" });
    expect(verifyReport(signReport(report(), signer), asked({ now: "2026-10-19T11:28:59.000Z" }))).toEqual({ ok: false, reason: "the report was issued in the future" });
  });

  it("checks the answer: the subject and capability asked, or the anchor (step 6)", () => {
    const env = signReport(report(), signer);
    expect(verifyReport(env, asked({ expect: { subject: SUBJECT, capability: "research" } }))).toEqual({ ok: false, reason: "the report answers about another capability" });
    expect(verifyReport(env, asked({ expect: { subject: "someone-else", capability: "code-review" } }))).toEqual({ ok: false, reason: "the report answers about another subject" });
    // A 0.6.0 report always names its capability, so it never answers "all of them".
    expect(verifyReport(env, asked({ expect: { subject: SUBJECT, capability: null } }))).toEqual({ ok: false, reason: "the report answers about another capability" });
    const org = signReport({ anchor: "harbor.example", bureau: BUREAU, issued_at: "2026-10-19T11:30:00.000Z", expires_at: "2026-10-19T12:30:00.000Z" }, signer, { tag: ORG_REPORT_TAG, member: "organization_report" });
    const orgOpts = { tag: ORG_REPORT_TAG, member: "organization_report" };
    expect(verifyReport(org, asked({ ...orgOpts, expect: { anchor: "harbor.example" } }))).toMatchObject({ ok: true });
    expect(verifyReport(org, asked({ ...orgOpts, expect: { anchor: "other.example" } }))).toEqual({ ok: false, reason: "the report answers about another anchor" });
  });
});

describe("reports from before 0.6.0", () => {
  const raw = Buffer.from(signer.key, "base64");

  it("reads the key inside an nkey, checksum and all", () => {
    expect(keyFromRaw(rawKeyFromNkey(nkeyOf(raw)))).toBe(signer.key);
    const good = nkeyOf(raw);
    const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    expect(() => rawKeyFromNkey(tampered)).toThrow();
  });

  it("verifies the older envelope against the pinned key set, and only against it", () => {
    const all = { subject: SUBJECT, capability: null };
    expect(verifyReport(legacy(oldReport()), asked({ expect: all }))).toEqual({ ok: true, format: "pre-0.6.0", kid: kidOf(signer.key) });
    const notPinned = keySetFor(BUREAU, [{ key: seedSigner(seed("other")).key, status: "current" }]);
    expect(verifyReport(legacy(oldReport()), asked({ keySet: notPinned, expect: all }))).toEqual({ ok: false, reason: "the key is not in the pinned key set" });
    const changed = { ...legacy(oldReport()), report: { ...oldReport(), enrollment: "WITHDRAWN" } };
    expect(verifyReport(changed, asked({ expect: all }))).toEqual({ ok: false, reason: "the signature does not verify" });
  });

  it("answers about one capability only when every entry it lists is that one", () => {
    expect(verifyReport(legacy(oldReport(["research"])), asked({ expect: { subject: SUBJECT, capability: "research" } }))).toMatchObject({ ok: true });
    expect(verifyReport(legacy(oldReport(["research", "drafting"])), asked({ expect: { subject: SUBJECT, capability: "research" } }))).toEqual({ ok: false, reason: "the report answers about another capability" });
  });
});

describe("from the text received (§8.1.1, §8.1.3 step 1)", () => {
  it("refuses a repeated member, and text that is not JSON, before anything else", () => {
    const env = signReport(report(), signer);
    const text = JSON.stringify(env);
    expect(verifyReportText(text, asked())).toMatchObject({ ok: true });
    const repeated = text.replace('"enrollment":"RATED"', '"enrollment":"RATED","enrollment":"RATED"');
    expect(verifyReportText(repeated, asked())).toEqual({ ok: false, reason: "the envelope repeats the member enrollment" });
    expect(verifyReportText('{"report":{"a":"\\u12"}}', asked())).toEqual({ ok: false, reason: "the envelope is not JSON" });
  });

  it("finds a name repeated inside one object, at any depth, and only there, without throwing", () => {
    expect(repeatedMember('{"a":1,"b":{"c":1,"c":2}}')).toBe("c");
    expect(repeatedMember('{"report":{"x":1},"report":{"x":2}}')).toBe("report");
    expect(repeatedMember('{"a":{"x":1},"b":{"x":1},"c":["a","a"],"d":"\\"a\\""}')).toBeNull();
    expect(repeatedMember('{"\\u0061":1,"a":2}')).toBe("a");
    expect(() => repeatedMember('{"\\u12":1}')).not.toThrow();
  });
});
