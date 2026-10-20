/**
 * The encodings the contracting standards spell bytes in: SHA-256 digests,
 * lowercase Crockford base32 for document identifiers, RFC 4648 base32 inside
 * an nkey, and base64 for keys and signatures.
 *
 * Base64 is read strictly unless a caller asks otherwise. A strict reading
 * takes exactly one string for given bytes: the one alphabet, the padding the
 * encoder writes (or none, for base64url), and the unused low bits of the
 * last character zero. Anything looser would let two different strings stand
 * for one signature, so that one act could be recorded twice.
 */
import { createHash } from "node:crypto";

const enc = new TextEncoder();

/** The UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return enc.encode(text);
}

/** SHA-256 of bytes, or of a string's UTF-8 bytes. */
export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** `sha256:` and 64 lowercase hex digits, the spelling every digest in the family uses and compares exactly. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The family's digest of bytes, or of a string's UTF-8 bytes: `sha256:` and the lowercase hex SHA-256. */
export function sha256Digest(data: Uint8Array | string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

// ── base32 ───────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const RFC4648 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32With(alphabet: string, bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >> (bits - 5)) & 31];
      bits -= 5;
      if (out.length === chars) return out;
    }
  }
  if (bits > 0 && out.length < chars) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Lowercase Crockford base32 with no padding, hyphens or check symbol: five
 * bits per character, most significant first, a final partial group padded
 * with zero bits. With `chars`, the first that many characters only, which is
 * how an identifier takes its prefix of a digest.
 */
export function crockford32(bytes: Uint8Array, chars = Infinity): string {
  return base32With(CROCKFORD, bytes, chars);
}

/** RFC 4648 base32, uppercase, no padding: the alphabet inside an nkey. */
export function base32Encode(bytes: Uint8Array): string {
  return base32With(RFC4648, bytes, Infinity);
}

/**
 * RFC 4648 base32 with no padding, read strictly: uppercase alphabet only, a
 * length no encoder writes refused, and the unused low bits of the last
 * character zero. Null on anything else.
 */
export function base32Decode(text: string): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Z2-7]*$/.test(text)) return null;
  // 5 bits a character: lengths 1, 3 and 6 modulo 8 leave a partial byte no encoder writes.
  if ([1, 3, 6].includes(text.length % 8)) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    acc = ((acc << 5) | RFC4648.indexOf(ch)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

// ── base64 ───────────────────────────────────────────────────────────────────

const BASE64_PADDED = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_BARE = /^[A-Za-z0-9_-]*$/;

/** Padded base64 in the standard alphabet (RFC 4648 §4). */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Unpadded base64url (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/**
 * Bytes from their one canonical spelling, or null. `base64` is padded base64
 * in the standard alphabet; `base64url` is unpadded base64url. Either way the
 * unused low bits of the last character must be zero, and with `length` the
 * bytes must be exactly that many.
 */
export function fromCanonicalBase64(text: unknown, spelling: "base64" | "base64url" = "base64", length?: number): Uint8Array | null {
  if (typeof text !== "string") return null;
  if (spelling === "base64" ? !BASE64_PADDED.test(text) : !BASE64URL_BARE.test(text) || text.length % 4 === 1) return null;
  const buf = Buffer.from(text, spelling);
  if (buf.toString(spelling) !== text) return null;
  if (length !== undefined && buf.length !== length) return null;
  return new Uint8Array(buf);
}

/**
 * Bytes from base64 or base64url, padded or not: the reading for documents
 * from before a standard fixed one spelling, whose signatures were written
 * either way. The characters must all be from the two alphabets, with at most
 * two `=` and only at the end, and the length must be one an encoder writes.
 * Null on anything else.
 */
export function fromLooseBase64(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  const body = text.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  if (text.length > body.length && text.length % 4 !== 0) return null;
  return new Uint8Array(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}
