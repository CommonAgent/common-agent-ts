/**
 * The signatures an assembler checks, each as its own standard defines it,
 * and the Ed25519 key a subject signs its Descriptor with.
 *
 * - `descriptor-statement-v1` (Section 6.6): by the subject's own key, over
 *   the tag, one newline, and the canonical JSON of the Descriptor without
 *   `signatures`.
 * - `agent-eval-record-v1` (Section 8.4) and every record of Section 8.1: by
 *   the issuer's key, the same way, with the by-equality rule.
 * - Agent SoW's provider signature on a standing proposal: `agent-sow-v1`,
 *   by the key the provider seat names.
 * - An attestation in a DSSE envelope: over DSSE's pre-authentication
 *   encoding of its payload.
 *
 * Each answers `verified`, `unsigned`, `failed` or `not_checked`, and never
 * throws on what it is given. Keys are nkey user keys (`U…`).
 */
import {
  NKEY_PREFIX,
  NOT_PUBLIC_PREFIX,
  base32Encode,
  canonicalJSON,
  crc16,
  decodeSignature,
  encodeSignature,
  fromLooseBase64,
  rawUserKey,
  signTagged,
  signerFromUserSeed,
  utf8,
  verifyRaw,
  verifyTagged,
} from "@common-agent/crypto";
import type { SignatureState } from "./types.js";
import { arr, isObj, str, type Rec } from "./util.js";

export const DESCRIPTOR_TAG = "descriptor-statement-v1";
export const EVAL_TAG = "agent-eval-record-v1";
export const SOW_TAG = "agent-sow-v1";

export interface SignatureCheck {
  state: SignatureState;
  /** The key that signed, where one verified or was named. */
  by?: string;
  /** Why it is not verified, in words. */
  note?: string;
}

/** A 64-byte signature from padded base64, or from any base64 spelling a writer before the strict rule used. */
function sigBytes(s: unknown): Uint8Array | null {
  const strict = decodeSignature(s);
  if (strict) return strict;
  const loose = fromLooseBase64(s);
  return loose && loose.length === 64 ? loose : null;
}

/** The canonical JSON of a document without its `signatures`, or null where it has no spelling. */
function bodyCanonical(doc: Rec): string | null {
  const { signatures: _s, ...body } = doc;
  try {
    return canonicalJSON(body);
  } catch {
    return null;
  }
}

/** A family record's tagged signature (Section 8.1), by `by`. */
function taggedCheck(doc: Rec, tag: string, by: unknown, sig: unknown): SignatureCheck {
  if (typeof by !== "string" || !by) return { state: "failed", note: "the signature names no key" };
  if (!rawUserKey(by)) return { state: "not_checked", by, note: "the key is not spelled as a user key (U…) this tool reads" };
  const canonical = bodyCanonical(doc);
  if (canonical === null) return { state: "failed", by, note: "the document has no canonical JSON spelling" };
  return verifyTagged(by, `${tag}\n`, canonical, sigBytes(sig))
    ? { state: "verified", by }
    : { state: "failed", by, note: "the signature does not verify" };
}

/** The `descriptor-statement-v1` check of Section 6.6: by the subject's own key. */
export function checkDescriptorSignature(doc: unknown): SignatureCheck {
  if (!isObj(doc)) return { state: "failed", note: "not a document" };
  const entry = arr(doc.signatures).find((s) => isObj(s) && s.tag === DESCRIPTOR_TAG);
  if (!entry) return { state: "unsigned" };
  const subjectId = isObj(doc.subject) ? doc.subject.id : undefined;
  if (entry.by !== subjectId) return { state: "failed", by: str(entry.by) || undefined, note: "the signature is not by the subject's own key" };
  return taggedCheck(doc, DESCRIPTOR_TAG, entry.by, entry.sig);
}

/** The `agent-eval-record-v1` check of Section 8.4: by the evaluator key inside the record, which must be the record's own `by`. */
export function checkEvalSignature(rec: unknown): SignatureCheck {
  if (!isObj(rec)) return { state: "failed", note: "not a document" };
  const entry = arr(rec.signatures).find((s) => isObj(s) && s.tag === EVAL_TAG);
  if (!entry) return { state: "unsigned" };
  if (rec.by !== undefined && rec.by !== entry.by) return { state: "failed", by: str(entry.by) || undefined, note: "the record's by and the signature's by are different keys" };
  return taggedCheck(rec, EVAL_TAG, entry.by, entry.sig);
}

/** Agent SoW's provider signature on a standing proposal: by the key the provider seat names, over `agent-sow-v1`. */
export function checkTermsSignature(doc: unknown): SignatureCheck {
  if (!isObj(doc)) return { state: "failed", note: "not a document" };
  const entry = arr(doc.signatures).find((s) => isObj(s) && s.role === "provider");
  if (!entry) return { state: "unsigned" };
  const parties = isObj(doc.parties) ? doc.parties : {};
  const seat = isObj(parties.provider) ? parties.provider : {};
  if (seat.owner_key !== undefined && seat.owner_key !== entry.key) return { state: "failed", by: str(entry.key) || undefined, note: "the provider's signature is not by the key its seat names" };
  return taggedCheck(doc, SOW_TAG, entry.key, entry.sig);
}

/** DSSE's pre-authentication encoding: what an envelope's signature is over. */
export function pae(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = utf8(payloadType);
  const head = utf8(`DSSEv1 ${type.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

/** An attestation as read: what it says, and whether a signature on it verifies. */
export interface OpenedAttestation {
  statement: Rec;
  check: SignatureCheck;
}

/**
 * Read an attestation: a DSSE envelope (`payloadType`, base64 `payload`,
 * `signatures[{keyid, sig}]`) or a family record (`signatures[{tag, by,
 * sig}]`). Null when it is neither.
 */
export function openAttestation(doc: unknown): OpenedAttestation | null {
  if (!isObj(doc)) return null;
  if (typeof doc.payloadType === "string" && typeof doc.payload === "string") {
    const payload = fromLooseBase64(doc.payload);
    if (!payload) return null;
    let statement: unknown;
    try {
      statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
      return null;
    }
    if (!isObj(statement)) return null;
    const sigs = arr(doc.signatures).filter(isObj);
    if (!sigs.length) return { statement, check: { state: "unsigned" } };
    const message = pae(doc.payloadType, payload);
    let named: string | undefined;
    for (const s of sigs) {
      const key = str(s.keyid);
      named ??= key || undefined;
      const raw = rawUserKey(key);
      if (raw && verifyRaw(raw, message, sigBytes(s.sig))) return { statement, check: { state: "verified", by: key } };
    }
    return { statement, check: named && !rawUserKey(named) ? { state: "not_checked", by: named, note: "the key is not spelled as a user key (U…) this tool reads" } : { state: "failed", by: named, note: "no signature on it verifies" } };
  }
  const entry = arr(doc.signatures).find((s) => isObj(s) && typeof s.tag === "string");
  if (!entry) return { statement: doc, check: { state: "unsigned" } };
  if (doc.by !== undefined && doc.by !== entry.by) return { statement: doc, check: { state: "failed", by: str(entry.by) || undefined, note: "the record's by and the signature's by are different keys" } };
  return { statement: doc, check: taggedCheck(doc, str(entry.tag), entry.by, entry.sig) };
}

// ── the subject's key ──────────────────────────────────────────────────────

/** The nkey spelling of a raw 32-byte Ed25519 seed: `SU…`, 58 characters. */
export function encodeUserSeed(raw: Uint8Array): string {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const body = new Uint8Array(34);
  body[0] = NOT_PUBLIC_PREFIX.seed | (NKEY_PREFIX.user >> 5);
  body[1] = (NKEY_PREFIX.user & 31) << 3;
  body.set(raw, 2);
  const crc = crc16(body);
  const full = new Uint8Array(36);
  full.set(body);
  full[34] = crc & 0xff;
  full[35] = crc >> 8;
  return base32Encode(full);
}

/**
 * Bind a draft Descriptor to the key whose seed this is and sign it with
 * `descriptor-statement-v1` (Section 6.6). The subject's `id` becomes the
 * key; a handle already there is kept. Any earlier statement signature is
 * replaced. Throws when the Descriptor is already bound to another key,
 * because a bound Descriptor's subject never changes (Section 6.2).
 */
export function signDescriptor(descriptor: Rec, seed: string): Rec {
  const signer = signerFromUserSeed(seed);
  const key = signer.getPublicKey();
  const subject = isObj(descriptor.subject) ? descriptor.subject : {};
  if (subject.id !== undefined && subject.id !== key) {
    throw new Error(`this Descriptor is bound to ${String(subject.id)}, not to this key. A bound Descriptor's subject never changes; a new agent gets a new Descriptor.`);
  }
  const { signatures: _old, ...rest } = descriptor;
  const others = arr(descriptor.signatures).filter((s) => !(isObj(s) && s.tag === DESCRIPTOR_TAG));
  const body: Rec = { ...rest, subject: { ...subject, id: key } };
  const sig = encodeSignature(signTagged(signer, `${DESCRIPTOR_TAG}\n`, canonicalJSON(body)));
  return { ...body, signatures: [...others, { tag: DESCRIPTOR_TAG, by: key, sig, alg: "ed25519" }] };
}
