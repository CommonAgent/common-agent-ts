/**
 * Ed25519 keys and signatures as the contracting standards spell them.
 *
 * A public key travels as an nkey: a prefix byte, the 32 key bytes and a
 * CRC-16/XMODEM checksum, in RFC 4648 base32 with no padding, 56 characters.
 * The family's spelling is a user key, prefix `U`. Some standards also read
 * the other public prefixes the NATS nkeys library accepts (server `N`,
 * operator `O`, cluster `C`, account `A`); a caller names which it reads.
 * A curve key (`X`, prefix byte 184), a seed (`S`) and a private key (`P`)
 * are never a public signing key, whatever their bytes. A key may also travel
 * as padded base64 of its 32 bytes, where a standard says so.
 *
 * Every check here is strict about length, alphabet and checksum, and never
 * throws on hostile input: it answers false or null. Verification is
 * node:crypto's Ed25519, which refuses a signature whose S is not below the
 * group order (the malleated form).
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { base32Decode, base32Encode, fromCanonicalBase64, toBase64, utf8 } from "./encoding.js";

/** The prefix byte of each nkey public key kind: its letter's base32 value, shifted left 3. */
export const NKEY_PREFIX = {
  server: 13 << 3, // N, 104
  operator: 14 << 3, // O, 112
  cluster: 2 << 3, // C, 16
  account: 0 << 3, // A, 0
  user: 20 << 3, // U, 160
} as const;

/** The prefix bytes that never name a public signing key: curve (X), seed (S) and private (P). */
export const NOT_PUBLIC_PREFIX = { curve: 23 << 3, seed: 18 << 3, private: 15 << 3 } as const;

/** A user public key's spelling: `U` and 55 base32 characters. */
export const USER_KEY_RE = /^U[A-Z2-7]{55}$/;

/** User keys only: the family's spelling. */
export const USER_ONLY: ReadonlySet<number> = new Set([NKEY_PREFIX.user]);

/** The public prefixes the NATS nkeys library accepts for a signing key: server, operator, cluster, account and user. */
export const NKEY_PUBLIC_PREFIXES: ReadonlySet<number> = new Set(Object.values(NKEY_PREFIX));

/** CRC-16/XMODEM, the checksum an nkey carries in its last two bytes, little-endian. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function withChecksum(body: Uint8Array): Uint8Array {
  const crc = crc16(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body);
  full[body.length] = crc & 0xff;
  full[body.length + 1] = crc >> 8;
  return full;
}

function checked(text: string, bodyLength: number): Uint8Array | null {
  const bytes = base32Decode(text);
  if (!bytes || bytes.length !== bodyLength + 2) return null;
  const body = bytes.subarray(0, bodyLength);
  return crc16(body) === (bytes[bodyLength]! | (bytes[bodyLength + 1]! << 8)) ? body : null;
}

/**
 * The 32 raw bytes of an nkey public key, or null. The key must be exactly
 * 56 base32 characters, its checksum must hold, and its prefix must be one of
 * `prefixes` (user keys only, unless the caller names more).
 */
export function rawFromNkey(key: unknown, prefixes: ReadonlySet<number> = USER_ONLY): Uint8Array | null {
  if (typeof key !== "string" || key.length !== 56) return null;
  const body = checked(key, 33);
  if (!body || !prefixes.has(body[0]!)) return null;
  return body.slice(1);
}

/** The 32 raw bytes of a user public key (`U…`), or null. */
export function rawUserKey(key: unknown): Uint8Array | null {
  return rawFromNkey(key, USER_ONLY);
}

/** The nkey spelling of a raw 32-byte Ed25519 public key; a user key unless another prefix is named. */
export function nkeyFromRaw(raw: Uint8Array, prefix: number = NKEY_PREFIX.user): string {
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  const body = new Uint8Array(33);
  body[0] = prefix;
  body.set(raw, 1);
  return base32Encode(withChecksum(body));
}

/** The 32 raw bytes of a key in padded base64, or null. */
export function rawFromBase64Key(key: unknown): Uint8Array | null {
  return fromCanonicalBase64(key, "base64", 32);
}

/**
 * The 32 raw bytes of a user nkey seed (`SU…`, 58 characters), the spelling
 * the conformance files publish their test identities in, or null.
 */
export function rawFromUserSeed(seed: unknown): Uint8Array | null {
  if (typeof seed !== "string" || seed.length !== 58) return null;
  const body = checked(seed, 34);
  if (!body) return null;
  const isSeed = (body[0]! & 0xf8) === NOT_PUBLIC_PREFIX.seed;
  const kind = ((body[0]! & 7) << 5) | (body[1]! >> 3);
  return isSeed && kind === NKEY_PREFIX.user ? body.slice(2) : null;
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

function publicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
}

/**
 * Whether `sig` is the Ed25519 signature of the 32-byte key `raw` over
 * `message`. False for a key that is not 32 bytes, a signature that is not 64
 * bytes, and a signature that does not verify. Never throws.
 */
export function verifyRaw(raw: Uint8Array | null, message: Uint8Array, sig: unknown): boolean {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) return false;
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
  try {
    return edVerify(null, message, publicKeyObject(raw), sig);
  } catch {
    return false;
  }
}

/** Whether `sig` is the signature of the nkey `key` over `message`; user keys only unless `prefixes` names more. Never throws. */
export function verifyNkey(key: unknown, message: Uint8Array, sig: unknown, prefixes: ReadonlySet<number> = USER_ONLY): boolean {
  return verifyRaw(rawFromNkey(key, prefixes), message, sig);
}

/**
 * The family's tagged signature check: whether `sig` is the signature of the
 * nkey `key` over the UTF-8 of `prefix + canonical`. User keys only unless
 * `prefixes` names more. Never throws.
 */
export function verifyTagged(key: unknown, prefix: string, canonical: string, sig: unknown, prefixes: ReadonlySet<number> = USER_ONLY): boolean {
  if (typeof prefix !== "string" || typeof canonical !== "string") return false;
  return verifyNkey(key, utf8(prefix + canonical), sig, prefixes);
}

/** What signs: Ed25519 over bytes. An nkeys KeyPair fits it, and so does any holder of a key that keeps the private half to itself. */
export interface Signer {
  sign(data: Uint8Array): Uint8Array;
}

/** A Signer that also names its public key, as a user nkey. */
export interface KeyedSigner extends Signer {
  getPublicKey(): string;
}

/** A signer from a raw 32-byte Ed25519 seed (RFC 8032 §5.1.5), with its public key both raw and as a user nkey. For tests and vectors; a running system signs with whatever holds its key. */
export function signerFromRawSeed(seed: Uint8Array): KeyedSigner & { raw: Uint8Array } {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const raw = new Uint8Array(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  const publicKey = nkeyFromRaw(raw);
  return {
    raw,
    getPublicKey: () => publicKey,
    sign: (data) => new Uint8Array(edSign(null, data, priv)),
  };
}

/** A signer from a user nkey seed (`SU…`). Throws when it is not one. */
export function signerFromUserSeed(seed: string): KeyedSigner & { raw: Uint8Array } {
  const raw = rawFromUserSeed(seed);
  if (!raw) throw new Error("not an nkey user seed");
  return signerFromRawSeed(raw);
}

/** Sign the UTF-8 of `prefix + canonical`, the family's tagged form. */
export function signTagged(signer: Signer, prefix: string, canonical: string): Uint8Array {
  return signer.sign(utf8(prefix + canonical));
}

/** The canonical spelling of a signature: padded base64. */
export function encodeSignature(sig: Uint8Array): string {
  return toBase64(sig);
}

/** A 64-byte signature from its canonical spelling, padded base64 (or unpadded base64url where a standard says so), or null. */
export function decodeSignature(text: unknown, spelling: "base64" | "base64url" = "base64"): Uint8Array | null {
  return fromCanonicalBase64(text, spelling, 64);
}

/** The canonical padded base64 of a 64-byte signature: 85 characters, one of `AQgw`, then `==`. The regular-expression form of decodeSignature's test. */
export const SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/]{85}[AQgw]==$/;
