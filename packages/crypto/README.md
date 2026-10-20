# The shared crypto core

The bytes and keys every contracting standard signs with, in one copy:

| What | Functions |
|---|---|
| Canonical JSON (RFC 8785) | `canonicalJSON`, the family's form, which leaves out `undefined` members; `jcs`, RFC 8785 over I-JSON, which refuses lone surrogates and `undefined` members |
| Digests | `sha256`, `sha256Digest` (`sha256:` and lowercase hex), `DIGEST_RE` |
| Identifiers | `crockford32`, lowercase Crockford base32 with no padding |
| Public keys | `rawFromNkey`, `rawUserKey`, `nkeyFromRaw`, `rawFromBase64Key`, `rawFromUserSeed` |
| Signatures | `verifyRaw`, `verifyNkey`, `verifyTagged`, `signTagged`, `signerFromRawSeed`, `signerFromUserSeed` |
| Spellings | `encodeSignature`, `decodeSignature`, `fromCanonicalBase64`, `fromLooseBase64`, `toBase64`, `toBase64Url`, `base32Encode`, `base32Decode` |

Pure: `node:crypto` and nothing else.

## What it refuses

Every reading is strict, and a check never throws on hostile input; it
answers `false` or `null`.

- **Keys.** An nkey is exactly 56 characters of uppercase RFC 4648 base32
  with a valid CRC-16 checksum and 32 key bytes. A caller names the prefixes
  it reads: user keys (`U`) by default, or the public kinds the NATS nkeys
  library signs with (`NKEY_PUBLIC_PREFIXES`: server, operator, cluster,
  account, user). A curve key (`X`, prefix byte 184), a seed (`S`) and a
  private key (`P`) are never a public signing key, whatever their bytes. A
  key that is not a string is refused, even one that stringifies to a key.
- **Signatures.** 64 bytes, verified by node:crypto's Ed25519, which refuses a
  malleated signature (S not below the group order). The canonical spelling
  is padded base64 with the unused bits of its last character zero; base64url
  is read only where a caller asks for it, and `fromLooseBase64` (either
  alphabet, padding optional, nothing else) only for documents from before a
  standard fixed one spelling.
- **Canonical JSON.** A value with no JSON spelling throws a
  `CanonicalJSONError` naming where it is: a non-finite number, `undefined`
  as an array element or the whole value, a function, a symbol, a BigInt, and
  any object that is not a plain object or an array (a Date, a Map, a typed
  array, a class instance).

## Tests

`test/crypto.test.ts` pins RFC 8032 and RFC 8785 test values and the hostile
inputs above. Each core that uses this code also runs its standard's
conformance vectors over it.
