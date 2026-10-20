/**
 * The bytes and keys Agent SoW signs with: JCS canonical JSON (RFC 8785),
 * SHA-256, Ed25519 over the family's public-key spelling (an nkey user key,
 * `U` and 55 base32 characters), signatures in canonical padded base64 (and,
 * in documents from before 0.26.0-draft, base64url), and the Crockford
 * base32 of a document identifier (§4.1).
 *
 * Each comes from the shared crypto core (../crypto/), under the names this
 * core has always exported.
 */
import {
  USER_KEY_RE,
  canonicalJSON,
  crockford32,
  fromLooseBase64,
  nkeyFromRaw,
  rawUserKey,
  sha256Digest,
  signTagged,
  signerFromRawSeed as rawSeedSigner,
  signerFromUserSeed,
  toBase64Url,
  verifyTagged as verifyUserTagged,
  type KeyedSigner,
} from "@common-agent/crypto";

/**
 * RFC 8785 for the values a document holds: object keys sorted by UTF-16 code
 * units, arrays in order, strings and numbers as JSON.stringify writes them,
 * and undefined members dropped. A value with no JSON spelling, such as a
 * non-finite number, is refused rather than written as null.
 */
export { canonicalJSON, crockford32, sha256Digest, signTagged };

// ── base64url ────────────────────────────────────────────────────

export function toB64Url(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

/** Bytes from base64url or base64, padded or not. Throws on anything else. */
export function fromB64Url(s: string): Uint8Array {
  const bytes = fromLooseBase64(s);
  if (!bytes) throw new Error("not base64");
  return bytes;
}

// ── keys ─────────────────────────────────────────────────────────

/** An Ed25519 public key in the family's spelling. */
export const PUBLIC_KEY_RE = USER_KEY_RE;

/** The 32 raw bytes of a public key, or null when the spelling or the checksum is wrong. */
export function rawPublicKey(key: string): Uint8Array | null {
  return rawUserKey(key);
}

/** The family spelling of a raw 32-byte Ed25519 public key. */
export function publicKeyFromRaw(raw: Uint8Array): string {
  return nkeyFromRaw(raw);
}

/**
 * What signs. An nkeys KeyPair fits it (`getPublicKey`, `sign`), and so does
 * any holder of a key that keeps the private half to itself: a platform that
 * holds keys for its accounts and an owner who holds their own key look the
 * same to this code.
 */
export type Signer = KeyedSigner;

/** A Signer from a raw 32-byte Ed25519 seed. For tests and vectors; a running system signs with whatever holds the key. */
export function signerFromRawSeed(seed: Uint8Array): Signer {
  const s = rawSeedSigner(seed);
  return { getPublicKey: s.getPublicKey, sign: s.sign };
}

/** A Signer from an nkey user seed (`SU` and 56 more characters), the spelling the conformance files publish their test identities in. */
export function signerFromSeed(seed: string): Signer {
  const s = signerFromUserSeed(seed);
  return { getPublicKey: s.getPublicKey, sign: s.sign };
}

/** Whether `sig` is `publicKey`'s signature over `prefix + canonical`. Never throws. */
export function verifyTagged(publicKey: string, prefix: string, canonical: string, sig: Uint8Array): boolean {
  return verifyUserTagged(publicKey, prefix, canonical, sig);
}
