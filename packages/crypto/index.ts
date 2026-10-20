/**
 * The crypto the contracting standards share: canonical JSON, SHA-256
 * digests, Crockford base32 identifiers, nkey public keys, and Ed25519
 * signatures in their canonical spellings.
 *
 * One copy for every core, so that a key, a signature or a canonical string
 * one standard accepts is read the same way by the others. Pure: node:crypto
 * and nothing else. Each function is strict and, where it checks, never
 * throws on hostile input; the README lists what each refuses.
 */
export { CanonicalJSONError, canonicalJSON, jcs, type CanonicalOptions } from "./canonical.js";
export {
  DIGEST_RE,
  base32Decode,
  base32Encode,
  crockford32,
  fromCanonicalBase64,
  fromLooseBase64,
  sha256,
  sha256Digest,
  toBase64,
  toBase64Url,
  utf8,
} from "./encoding.js";
export {
  NKEY_PREFIX,
  NKEY_PUBLIC_PREFIXES,
  NOT_PUBLIC_PREFIX,
  SIGNATURE_BASE64_RE,
  USER_KEY_RE,
  USER_ONLY,
  crc16,
  decodeSignature,
  encodeSignature,
  nkeyFromRaw,
  rawFromBase64Key,
  rawFromNkey,
  rawFromUserSeed,
  rawUserKey,
  signTagged,
  signerFromRawSeed,
  signerFromUserSeed,
  verifyNkey,
  verifyRaw,
  verifyTagged,
  type KeyedSigner,
  type Signer,
} from "./keys.js";
