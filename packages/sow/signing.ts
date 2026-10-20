/**
 * Canonical bytes and signatures (§6).
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { decodeSignature, encodeSignature } from "@common-agent/crypto";
import { canonicalJSON, fromB64Url, signTagged, verifyTagged, type Signer } from "./crypto.js";

// ── §6: canonicalization and signing ────────────────────────────────────────

/** The domain tag inside an Agent SoW document's signed bytes (§6): each `sig`
 *  covers this prefix + the JCS canonical JSON of the document with the
 *  `signatures` array removed. The prefix exists only inside the signed bytes:
 *  it never appears in the document itself. */
export const SOW_SIG_PREFIX = "agent-sow-v1\n";

/**
 * The one spelling a signature has (§6): base64 with padding, 88 characters from the standard alphabet ending in two
 * padding characters, the unused low bits of the last data character zero.
 * Each signature then has exactly one valid string.
 */
export function encodeSowSig(sig: Uint8Array): string {
  return encodeSignature(sig);
}

/** Whether a `sig` is in the canonical spelling. */
export function isCanonicalSowSig(sig: string): boolean {
  return decodeSignature(sig, "base64") !== null;
}

/**
 * Whether a document is written against 0.26.0-draft or later: any of its
 * seats names the key that signs for it in `owner_key` (§5.1, §6). Such a
 * document's signatures are bound to those keys and spelled canonically. A
 * document where no seat names one was written earlier: its signatures may
 * be spelled another way (base64url, unpadded), which a verifier decodes as
 * written, and they are not bound to any seat.
 */
export function isOwnerKeyed(doc: object): boolean {
  const parties = (doc as { parties?: Record<string, unknown> }).parties;
  if (!parties) return false;
  return ["provider", "client"].some((r) => {
    const seat = parties[r] as { owner_key?: unknown } | null | undefined;
    return typeof seat?.owner_key === "string";
  });
}

/** The key a seat signs with: its `owner_key`, or null where the seat names none (an older document, or a blank seat). */
export function seatOwnerKey(doc: object, role: "provider" | "client"): string | null {
  const seat = (doc as { parties?: Record<string, { owner_key?: unknown } | null> }).parties?.[role];
  return typeof seat?.owner_key === "string" ? seat.owner_key : null;
}

/** One owner's signature over the document (§6). Owners sign, not agents. */
export interface SowSignature {
  role: "provider" | "client";
  key: string;
  signed_at: string;
  sig: string;
}

/**
 * The canonical JSON an Agent SoW signature covers (§6): the JCS canonical
 * JSON of the document with the `signatures` array removed.
 *
 * The Rust SDK produces the same string for the same document; that byte
 * equality is what `conformance/sow-pricing.json` pins.
 */
export function canonicalSowJSON(doc: object): string {
  const { signatures: _omit, ...rest } = doc as { signatures?: unknown };
  return canonicalJSON(rest);
}

/** The exact bytes a signer signs: `SOW_SIG_PREFIX` + the canonical JSON. */
export function sowSignedBytes(doc: object): Uint8Array {
  return new TextEncoder().encode(SOW_SIG_PREFIX + canonicalSowJSON(doc));
}

/**
 * Sign a document as one role, appending to `signatures` (§6).
 *
 * Formation always ends with a fresh provider signature over the COMPLETED
 * document: a standing proposal's provider signature covers the template bytes,
 * and the moment a client countersigns, the client seat and start instant fill
 * in and the bytes change. A pre-signature authenticates the offer; it does not
 * pre-authorize every formation (§6, §12.1). This function therefore always
 * signs the document as it stands now.
 */
export function signSow<T extends object>(
  doc: T,
  kp: Signer,
  role: "provider" | "client",
  signedAt?: string,
): T & { signatures: SowSignature[] } {
  const existing = ((doc as { signatures?: SowSignature[] }).signatures ?? []).filter(
    (s) => s.role !== role,
  );
  const sig = encodeSowSig(signTagged(kp, SOW_SIG_PREFIX, canonicalSowJSON(doc)));
  return {
    ...doc,
    signatures: [
      ...existing,
      {
        role,
        key: kp.getPublicKey(),
        signed_at: signedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        sig,
      },
    ],
  };
}

/**
 * What one signature record is worth (§6):
 * - `counts`: it verifies over the document's bytes, and it is bound to its
 *   seat: made with the seat's `owner_key`, and spelled canonically;
 * - `unbound`: it verifies, but it is not the seat's signature. On a document
 *   written against 0.26.0-draft, that is a signature by another key, which a
 *   runtime MUST NOT present as the seat's. On an older document every
 *   signature that verifies is unbound: it stays good for agreement, and is
 *   shown as unbound until an amendment adds `owner_key` to every seat;
 * - `invalid`: it does not verify, or on a 0.26.0-draft document it is not
 *   spelled canonically.
 */
export type SowSignatureStatus = "counts" | "unbound" | "invalid";

export function signatureStatus(doc: object, signature: SowSignature): SowSignatureStatus {
  if (typeof signature?.sig !== "string" || typeof signature.key !== "string") return "invalid";
  const keyed = isOwnerKeyed(doc);
  if (keyed && !isCanonicalSowSig(signature.sig)) return "invalid";
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(signature.sig);
  } catch {
    return "invalid";
  }
  if (!verifyTagged(signature.key, SOW_SIG_PREFIX, canonicalSowJSON(doc), sigBytes)) return "invalid";
  return keyed && signature.key === seatOwnerKey(doc, signature.role) ? "counts" : "unbound";
}

/**
 * Whether a signature is good for agreement (§6): on a 0.26.0-draft document
 * it counts for its seat; on an older one it verifies as written.
 */
export function verifySowSignature(doc: object, signature: SowSignature): boolean {
  const status = signatureStatus(doc, signature);
  return status === "counts" || (status === "unbound" && !isOwnerKeyed(doc));
}

/**
 * A document is **agreed** when both roles have good signatures over the same
 * canonical bytes, each bound to its seat where the document is written
 * against 0.26.0-draft (§6). Not "both roles signed something": every
 * signature must be good against the bytes the document has right now.
 */
export function sowAgreed(doc: object): boolean {
  const signatures = (doc as { signatures?: SowSignature[] }).signatures ?? [];
  const roles = new Set<string>();
  for (const s of signatures) {
    if (!verifySowSignature(doc, s)) return false;
    roles.add(s.role);
  }
  return roles.has("provider") && roles.has("client");
}

// ── §6 binding: the seat's owner, confirmed by the registry ────────────────

/** What the registry holds for an agent's owner (Agent Messaging §8.6): the owner's key, and whether it verified it through an owner_attestation. */
export interface ResolvedOwner {
  owner: string;
  attested: boolean;
}

/**
 * Whether the registry confirms a seat's `owner_key` (§6): `confirmed` where
 * an attested owner of the seat's agent is that key, `contradicted` where an
 * attested owner is another key, and `unconfirmed` where the registry could
 * not be reached, does not list the agent, or holds an owner it never
 * attested. A document that names no `owner_key` for the seat is unconfirmed:
 * there is nothing to confirm.
 */
export type OwnerConfirmation = "confirmed" | "contradicted" | "unconfirmed";

export function ownerConfirmation(doc: object, role: "provider" | "client", resolved: ResolvedOwner | null | undefined): OwnerConfirmation {
  const key = seatOwnerKey(doc, role);
  if (key === null || !resolved || !resolved.attested) return "unconfirmed";
  return resolved.owner === key ? "confirmed" : "contradicted";
}

/**
 * Whether a decision may rely on a seat's binding (§6): only a confirmed
 * owner. A decision that rides on the binding treats an unconfirmed owner as
 * it treats a contradicted one.
 */
export function bindingHolds(confirmation: OwnerConfirmation): boolean {
  return confirmation === "confirmed";
}
