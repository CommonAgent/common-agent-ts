/**
 * The bytes and keys Agent NDA signs with: JCS canonical JSON (RFC 8785),
 * SHA-256, Ed25519 over the family's public-key spelling (an nkey user key,
 * `U` and 55 base32 characters), and signatures in canonical padded base64.
 *
 * Each comes from the shared crypto core (../crypto/), under the names this
 * core has always exported.
 */
import {
  DIGEST_RE,
  SIGNATURE_BASE64_RE,
  USER_KEY_RE,
  canonicalJSON,
  crockford32,
  decodeSignature,
  encodeSignature,
  nkeyFromRaw,
  rawUserKey,
  sha256Digest,
  signerFromRawSeed,
  utf8,
  verifyRaw,
  type KeyedSigner,
} from "@common-agent/crypto";

/**
 * RFC 8785 for the values an agreement holds: objects with keys sorted by
 * UTF-16 code units, arrays in order, strings and numbers as JSON.stringify
 * writes them, and undefined members dropped. A value with no JSON spelling,
 * such as a non-finite number, is refused rather than written as null.
 */
export { canonicalJSON, crockford32, sha256Digest, utf8 };

/** `sha256:` and 64 lowercase hex digits, the spelling every digest in the family uses and compares exactly. */
export const DIGEST = DIGEST_RE;

/** An Ed25519 public key in the family's spelling. The pattern is all a validator asks of a seat; only a key that signs is decoded. */
export const PUBLIC_KEY = USER_KEY_RE;

/** The 32 raw bytes of a public key, or null when the spelling or the checksum is wrong. */
export function rawPublicKey(key: string): Uint8Array | null {
  return rawUserKey(key);
}

/** The family spelling of a raw 32-byte Ed25519 public key. */
export function publicKeyFromRaw(raw: Uint8Array): string {
  return nkeyFromRaw(raw);
}

/**
 * Signature bytes from their one canonical spelling (§6): base64 with
 * padding (RFC 4648 §4), 88 characters from the standard alphabet ending in
 * `==`, with the unused low bits of the last data character zero. Anything
 * else is no signature: base64url, a missing pad, or set unused bits, any of
 * which would let two strings stand for one signature.
 */
export const SIG_SPELLING = SIGNATURE_BASE64_RE;

export function decodeSig(sig: unknown): Uint8Array | null {
  return decodeSignature(sig, "base64");
}

/** Whether `sig` is the signature of `key` over `bytes`. Never throws. */
export function verifyBytes(key: string, bytes: Uint8Array, sig: unknown): boolean {
  return verifyRaw(rawUserKey(key), bytes, decodeSignature(sig, "base64"));
}

/**
 * What signs. An nkeys KeyPair fits it (`getPublicKey`, `sign`), and so does
 * any holder of a key that keeps the private half to itself, which is how a
 * platform that holds keys for its accounts and an owner who holds their own
 * key look the same to this code.
 */
export type Signer = KeyedSigner;

/** A Signer from a raw 32-byte Ed25519 seed. For tests and vectors; a running system signs with whatever holds the key. */
export function signerFromSeed(seed: Uint8Array): Signer {
  const s = signerFromRawSeed(seed);
  return { getPublicKey: s.getPublicKey, sign: s.sign };
}

/** Padded base64, the one spelling §6 allows. */
export function encodeSig(sig: Uint8Array): string {
  return encodeSignature(sig);
}
