/**
 * The pieces of the family's signing convention this core needs (Agent RFP
 * §4.1, §6): the canonical JSON a signature covers, the SHA-256 and Crockford
 * base32 an identifier is minted from, and the check of one Ed25519 signature
 * by an nkey public key over a tagged body.
 *
 * All of them come from the shared crypto core (../crypto/). The keys this
 * core reads are the public kinds the NATS nkeys library accepts for signing
 * (server, operator, cluster, account and user); a curve key (`X`), a seed, a
 * private key and anything that is not a 56-character string are refused.
 */
import {
  DIGEST_RE,
  NKEY_PUBLIC_PREFIXES,
  canonicalJSON,
  crockford32,
  fromLooseBase64,
  sha256,
  verifyNkey,
  utf8,
  type Signer,
} from "@common-agent/crypto";

export { DIGEST_RE, canonicalJSON, crockford32, sha256, type Signer };

/**
 * Does `sig` verify by `publicKey` over `tagged`, the prefix and canonical JSON
 * already joined? False for a key that is not one of the public kinds above,
 * a signature that is not 64 bytes, and a signature that does not verify; it
 * never throws.
 */
export function verifyTagged(publicKey: string, tagged: string, sig: Uint8Array): boolean {
  if (typeof tagged !== "string") return false;
  return verifyNkey(publicKey, utf8(tagged), sig, NKEY_PUBLIC_PREFIXES);
}

/**
 * Signature bytes from the string a posting or act carries: base64 or
 * base64url, padded or not, as the board has always read them. A string with
 * characters outside the two alphabets reads as no bytes, which no signature
 * check accepts.
 */
export function sigBytes(sig: string): Uint8Array {
  return fromLooseBase64(sig) ?? new Uint8Array(0);
}
