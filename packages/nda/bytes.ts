/**
 * The byte strings of Agent NDA and the digests over them (§4.1, §6, §6.1,
 * §7.3, §8). Three strings over the document, which the specification forbids
 * using one for another:
 *
 *   - the **hashed bytes** for the identifier: the version-1 document minus
 *     `id` and `signatures`, canonical, with no prefix (§4.1);
 *   - the **signed bytes**: `agent-nda-v1`, one newline, then the document
 *     minus `signatures`, canonical, `id` included (§6);
 *   - the **offer bytes**: the signed bytes of the document with
 *     `parties.recipient` and `disclosure.recipient` set to `null` (§6.1).
 *
 * A digest is `sha256:` and the lowercase hex SHA-256 of signed bytes or of
 * offer bytes. Signatures never enter any of them, so signing never changes
 * a digest.
 *
 * Two more strings are signed rather than hashed: a record's **signature
 * bytes** (`agent-nda-sig-v1`, the record minus `sig`, §6), which carry the
 * digest of what the record covers, and an act's bytes (`agent-nda-act-v1`,
 * the act and its record minus `sig`, §7.3).
 */
import { sha256 } from "@common-agent/crypto";
import { canonicalJSON, crockford32, sha256Digest, utf8 } from "./crypto.js";
import { ACT_TAG, AGREEMENT_TAG, SIG_TAG, type Agreement, type SignatureRecord, type SignedAct } from "./types.js";

type Doc = Agreement | Record<string, unknown>;

function without(doc: Doc, ...drop: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) if (!drop.includes(k)) out[k] = v;
  return out;
}

/** §4.1: the bytes hashed for the identifier. */
export function hashedForId(doc: Doc): string {
  return canonicalJSON(without(doc, "id", "signatures"));
}

/**
 * §4.1: `nda_` and the first 16 characters of the lowercase Crockford base32
 * of the SHA-256 of the hashed bytes. Minted once, from version 1. A verifier
 * MUST NOT reject an agreement because its identifier does not re-derive
 * (§4.1.1), so nothing in this core compares the two; this is for minting.
 */
export function mintId(versionOneDoc: Doc): string {
  const digest = sha256(hashedForId(versionOneDoc));
  return `nda_${crockford32(digest, 16)}`;
}

/** §6: the signed bytes, as a string (the prefix and the canonical body). */
export function signedBytes(doc: Doc): string {
  return `${AGREEMENT_TAG}\n${canonicalJSON(without(doc, "signatures"))}`;
}

/**
 * §6.1: the offer bytes. The recipient seat and the recipient's declaration
 * are set back to `null`, and nothing else changes, which is what makes any
 * other change at acceptance break the discloser's signature.
 */
export function offerBytes(doc: Doc): string {
  const d = doc as Record<string, unknown>;
  const parties = { ...((d.parties as Record<string, unknown>) ?? {}), recipient: null };
  const out: Record<string, unknown> = { ...d, parties };
  if (d.disclosure && typeof d.disclosure === "object") {
    out.disclosure = { ...(d.disclosure as Record<string, unknown>), recipient: null };
  }
  return signedBytes(out);
}

/** §8: the digest of an agreement, over its signed bytes. */
export function agreementDigest(doc: Doc): string {
  return sha256Digest(utf8(signedBytes(doc)));
}

/** §6.1: the digest of an open offer, over its offer bytes. A gated posting
 *  names this one (Agent RFP §5.11); an engagement never does (Agent SoW
 *  §5.16). */
export function offerDigest(doc: Doc): string {
  return sha256Digest(utf8(offerBytes(doc)));
}

/** §6: the bytes one signature signs: the record itself, `sig` removed. The
 *  record carries the digest of the bytes it covers, so the signature binds
 *  the document and every member of its own record. */
export function signatureBytes(rec: Omit<SignatureRecord, "sig"> | SignatureRecord): string {
  const { sig: _sig, ...rest } = rec as SignatureRecord;
  return `${SIG_TAG}\n${canonicalJSON(rest)}`;
}

/** §7.3: the signed bytes of an act: the body and the signature record,
 *  `sig` removed. */
export function actBytes(signed: { act: SignedAct["act"]; signature: Omit<SignedAct["signature"], "sig"> | SignedAct["signature"] }): string {
  const { sig: _sig, ...signature } = signed.signature as SignedAct["signature"];
  return `${ACT_TAG}\n${canonicalJSON({ act: signed.act, signature })}`;
}
