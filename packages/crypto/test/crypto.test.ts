/**
 * The shared crypto core against fixed answers: RFC 8032 and RFC 8785 test
 * values, and hostile inputs of every kind a verifier can be handed. The
 * cores that use this code run their standards' conformance vectors over it
 * too; these cases pin the edges the vectors do not reach.
 */
import { describe, expect, it } from "vitest";
import {
  CanonicalJSONError,
  NKEY_PREFIX,
  NKEY_PUBLIC_PREFIXES,
  NOT_PUBLIC_PREFIX,
  SIGNATURE_BASE64_RE,
  USER_ONLY,
  base32Decode,
  base32Encode,
  canonicalJSON,
  crc16,
  crockford32,
  decodeSignature,
  encodeSignature,
  fromCanonicalBase64,
  fromLooseBase64,
  jcs,
  nkeyFromRaw,
  rawFromBase64Key,
  rawFromNkey,
  rawFromUserSeed,
  rawUserKey,
  sha256Digest,
  signTagged,
  signerFromRawSeed,
  signerFromUserSeed,
  toBase64,
  verifyNkey,
  verifyRaw,
  verifyTagged,
} from "../index.js";

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);

// RFC 8032 §7.1, TEST 1 and TEST 2.
const RFC8032 = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    msg: "",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    msg: "72",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
];

/** The 32-byte key, a prefix byte and a valid checksum, at any length, in base32: what a hostile key looks like. */
function encodeWith(prefix: number, key: Uint8Array): string {
  const body = Uint8Array.from([prefix, ...key]);
  const crc = crc16(body);
  return base32Encode(Uint8Array.from([...body, crc & 0xff, crc >> 8]));
}

/** L, the order of the Ed25519 group, little-endian: S + L names the same point, and a strict verifier refuses it. */
const L = [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, ...new Array(15).fill(0), 0x10];
function malleate(sig: Uint8Array): Uint8Array {
  const out = Uint8Array.from(sig);
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const v = out[32 + i]! + L[i]! + carry;
    out[32 + i] = v & 0xff;
    carry = v >> 8;
  }
  return out;
}

describe("Ed25519 (RFC 8032 §7.1)", () => {
  for (const [i, t] of RFC8032.entries()) {
    it(`test ${i + 1}: the seed gives the key, signs to the signature, and the signature verifies`, () => {
      const s = signerFromRawSeed(hex(t.seed));
      expect(Buffer.from(s.raw).toString("hex")).toBe(t.pub);
      expect(Buffer.from(s.sign(hex(t.msg))).toString("hex")).toBe(t.sig);
      expect(verifyRaw(hex(t.pub), hex(t.msg), hex(t.sig))).toBe(true);
      expect(verifyNkey(s.getPublicKey(), hex(t.msg), hex(t.sig))).toBe(true);
    });
  }

  it("refuses the malleated signature (S + L) though it names the same point", () => {
    const t = RFC8032[1]!;
    expect(verifyRaw(hex(t.pub), hex(t.msg), malleate(hex(t.sig)))).toBe(false);
  });

  it("refuses a flipped bit, another message, and signatures and keys of the wrong length", () => {
    const t = RFC8032[1]!;
    const sig = hex(t.sig);
    expect(verifyRaw(hex(t.pub), hex(t.msg), Uint8Array.from(sig, (b, i) => (i === 3 ? b ^ 1 : b)))).toBe(false);
    expect(verifyRaw(hex(t.pub), hex("73"), sig)).toBe(false);
    expect(verifyRaw(hex(t.pub), hex(t.msg), sig.subarray(0, 63))).toBe(false);
    expect(verifyRaw(hex(t.pub), hex(t.msg), Uint8Array.from([...sig, 0]))).toBe(false);
    expect(verifyRaw(hex(t.pub), hex(t.msg), new Uint8Array(0))).toBe(false);
    expect(verifyRaw(hex(t.pub).subarray(0, 31), hex(t.msg), sig)).toBe(false);
    expect(verifyRaw(null, hex(t.msg), sig)).toBe(false);
  });

  it("never throws on values that are not bytes", () => {
    const t = RFC8032[0]!;
    for (const bad of [undefined, null, "sig", 64, {}, [1, 2, 3], Buffer.from(t.sig, "hex").toString("base64")]) {
      expect(verifyRaw(hex(t.pub), hex(t.msg), bad)).toBe(false);
    }
    expect(verifyRaw("key" as unknown as Uint8Array, hex(t.msg), hex(t.sig))).toBe(false);
  });

  it("refuses the identity point and an all-zero key", () => {
    const t = RFC8032[0]!;
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(verifyRaw(identity, hex(t.msg), hex(t.sig))).toBe(false);
    expect(verifyRaw(new Uint8Array(32), hex(t.msg), new Uint8Array(64))).toBe(false);
  });
});

describe("nkey public keys", () => {
  const signer = signerFromRawSeed(hex(RFC8032[0]!.seed));
  const pub = signer.getPublicKey();
  const raw = signer.raw;
  const prefix = "agent-test-v1\n";
  const body = canonicalJSON({ b: 2, a: 1 });
  const sig = signTagged(signer, prefix, body);

  it("a user key round-trips and its signature verifies", () => {
    expect(pub).toMatch(/^U[A-Z2-7]{55}$/);
    expect(rawUserKey(pub)).toEqual(raw);
    expect(nkeyFromRaw(raw)).toBe(pub);
    expect(verifyTagged(pub, prefix, body, sig)).toBe(true);
  });

  it("refuses the signer's own bytes under every prefix but the ones asked for", () => {
    const kinds: Array<[string, number, boolean]> = [
      ["curve (X, 184)", NOT_PUBLIC_PREFIX.curve, false],
      ["seed (S, 144)", NOT_PUBLIC_PREFIX.seed, false],
      ["private (P, 120)", NOT_PUBLIC_PREFIX.private, false],
      ["account (A, 0)", NKEY_PREFIX.account, true],
      ["server (N, 104)", NKEY_PREFIX.server, true],
      ["operator (O, 112)", NKEY_PREFIX.operator, true],
      ["cluster (C, 16)", NKEY_PREFIX.cluster, true],
    ];
    for (const [name, p, publicKind] of kinds) {
      const key = encodeWith(p, raw);
      expect(key.length, name).toBe(56);
      expect(rawFromNkey(key), `${name} as a user key`).toBeNull();
      expect(verifyTagged(key, prefix, body, sig), `${name} as a user key`).toBe(false);
      expect(verifyTagged(key, prefix, body, sig, NKEY_PUBLIC_PREFIXES), `${name} among the nkeys public kinds`).toBe(publicKind);
    }
    expect(NKEY_PUBLIC_PREFIXES.has(184)).toBe(false);
    expect(USER_ONLY.has(NKEY_PREFIX.user)).toBe(true);
  });

  it("refuses wrong lengths: 31 or 33 key bytes with a valid checksum, a character short or long, or a whole block long", () => {
    for (const key of [
      encodeWith(NKEY_PREFIX.user, raw.subarray(0, 31)),
      encodeWith(NKEY_PREFIX.user, Uint8Array.from([...raw, 0])),
      pub.slice(0, -1),
      pub + "A",
      pub + "AA",
      pub + "AAAAAAAA",
    ]) {
      expect(rawFromNkey(key, NKEY_PUBLIC_PREFIXES), key).toBeNull();
      expect(verifyTagged(key, prefix, body, sig, NKEY_PUBLIC_PREFIXES), key).toBe(false);
    }
  });

  it("refuses a broken checksum, the wrong case, padding, whitespace and characters outside base32", () => {
    const last = pub[pub.length - 1];
    for (const key of [
      pub.slice(0, -1) + (last === "A" ? "B" : "A"),
      pub.toLowerCase(),
      pub + "=",
      ` ${pub}`,
      `${pub}\n`,
      pub.slice(0, 5) + "1" + pub.slice(6),
      pub.slice(0, 5) + "0" + pub.slice(6),
      "",
    ]) {
      expect(rawFromNkey(key, NKEY_PUBLIC_PREFIXES), JSON.stringify(key)).toBeNull();
      expect(verifyTagged(key, prefix, body, sig), JSON.stringify(key)).toBe(false);
    }
  });

  it("refuses a key that is not a string, even one that stringifies to the key", () => {
    for (const key of [[pub], { toString: () => pub }, new String(pub), null, undefined, 42]) {
      expect(rawFromNkey(key)).toBeNull();
      expect(verifyTagged(key, prefix, body, sig)).toBe(false);
    }
  });

  it("reads a user seed, and never takes a seed as a public key", () => {
    const seed = encodeSeed(hex(RFC8032[0]!.seed));
    expect(seed).toMatch(/^SU[A-Z2-7]{56}$/);
    expect(rawFromUserSeed(seed)).toEqual(hex(RFC8032[0]!.seed));
    expect(signerFromUserSeed(seed).getPublicKey()).toBe(pub);
    expect(rawFromNkey(seed, NKEY_PUBLIC_PREFIXES)).toBeNull();
    expect(rawFromUserSeed(pub)).toBeNull();
    expect(rawFromUserSeed(seed.slice(0, -1) + (seed.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(() => signerFromUserSeed(pub)).toThrow(/not an nkey user seed/);
  });

  it("checks the tag: another tag, no tag, or another body does not verify", () => {
    expect(verifyTagged(pub, "agent-other-v1\n", body, sig)).toBe(false);
    expect(verifyTagged(pub, "", body, sig)).toBe(false);
    expect(verifyTagged(pub, prefix, body + " ", sig)).toBe(false);
    expect(verifyTagged(pub, prefix, body, malleate(sig))).toBe(false);
  });

  it("random strings shaped like user keys almost never decode, and never throw", () => {
    let decoded = 0;
    for (let n = 0; n < 500; n++) {
      const key = "U" + Array.from(crypto.getRandomValues(new Uint8Array(55)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[b & 31]).join("");
      if (rawUserKey(key)) decoded++;
      expect(verifyTagged(key, prefix, body, sig)).toBe(false);
    }
    expect(decoded).toBeLessThan(5);
  });
});

/** A user seed in nkey spelling: the seed prefix and the user kind across two bytes, the 32 seed bytes, the checksum. */
function encodeSeed(seed: Uint8Array): string {
  const b0 = NOT_PUBLIC_PREFIX.seed | (NKEY_PREFIX.user >> 5);
  const b1 = (NKEY_PREFIX.user & 31) << 3;
  const body = Uint8Array.from([b0, b1, ...seed]);
  const crc = crc16(body);
  return base32Encode(Uint8Array.from([...body, crc & 0xff, crc >> 8]));
}

describe("base32 (RFC 4648, inside an nkey)", () => {
  it("round-trips and refuses what no encoder writes", () => {
    const bytes = utf8("foobar");
    expect(base32Encode(bytes)).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI")).toEqual(bytes);
    expect(base32Decode("MZXW6YTBOJ")).toBeNull(); // unused bits set
    expect(base32Decode("mzxw6ytboi")).toBeNull();
    expect(base32Decode("MZXW6YTBOI======")).toBeNull();
    expect(base32Decode("M")).toBeNull();
    expect(base32Decode("MZX")).toBeNull();
  });
});

describe("Crockford base32 identifiers", () => {
  it("is lowercase, has no padding, and takes a prefix of the digest", () => {
    const digest = hex(sha256Digest("").slice(7));
    const full = crockford32(digest);
    expect(full).toMatch(/^[0-9a-hjkmnp-tv-z]{52}$/);
    expect(crockford32(digest, 16)).toBe(full.slice(0, 16));
    expect(crockford32(new Uint8Array([0xff]))).toBe("zw");
    expect(crockford32(new Uint8Array(0))).toBe("");
  });
});

describe("signatures in base64", () => {
  const sig = hex(RFC8032[0]!.sig);
  const canonical = encodeSignature(sig);
  const url = Buffer.from(sig).toString("base64url");

  it("has one canonical spelling, padded base64, and reads it back", () => {
    expect(canonical).toMatch(SIGNATURE_BASE64_RE);
    expect(canonical).toHaveLength(88);
    expect(decodeSignature(canonical)).toEqual(sig);
    expect(decodeSignature(url, "base64url")).toEqual(sig);
  });

  it("refuses every other spelling of the same bytes", () => {
    const spareBits = canonical.slice(0, 85) + String.fromCharCode(canonical.charCodeAt(85) + 1) + "==";
    expect(Buffer.from(spareBits, "base64")).toEqual(Buffer.from(sig));
    for (const text of [
      url,
      canonical.slice(0, -2),
      canonical.slice(0, -1),
      canonical + "=",
      spareBits,
      ` ${canonical}`,
      `${canonical}\n`,
      canonical.slice(0, 40) + "\n" + canonical.slice(40),
      canonical.slice(0, 40) + "=" + canonical.slice(40),
      canonical.replace(/\+/g, "-").replace(/\//g, "_"),
    ]) {
      expect(decodeSignature(text), JSON.stringify(text)).toBeNull();
    }
    expect(decodeSignature(canonical, "base64url")).toBeNull();
    expect(decodeSignature(url + "==", "base64url")).toBeNull();
  });

  it("refuses 63 or 65 bytes, an empty string and values that are not strings", () => {
    expect(decodeSignature(toBase64(sig.subarray(0, 63)))).toBeNull();
    expect(decodeSignature(toBase64(Uint8Array.from([...sig, 0])))).toBeNull();
    for (const v of ["", null, undefined, 88, [canonical], sig]) expect(decodeSignature(v)).toBeNull();
  });

  it("canonical base64 of any length: alphabet, padding, unused bits", () => {
    expect(fromCanonicalBase64("Zm9vYg==")).toEqual(utf8("foob"));
    expect(fromCanonicalBase64("Zm9vYh==")).toBeNull();
    expect(fromCanonicalBase64("Zm9vYg")).toBeNull();
    expect(fromCanonicalBase64("Zm9vYg", "base64url")).toEqual(utf8("foob"));
    expect(fromCanonicalBase64("Zm9vYmE=")).toEqual(utf8("fooba"));
    expect(fromCanonicalBase64("Zm9vYmF=")).toBeNull();
    expect(fromCanonicalBase64("Z", "base64url")).toBeNull();
    expect(fromCanonicalBase64("")).toEqual(new Uint8Array(0));
  });

  it("the loose reading for older documents takes both alphabets and either padding, and nothing else", () => {
    for (const text of [canonical, url, canonical.slice(0, -2), url + "=="]) expect(fromLooseBase64(text), text).toEqual(sig);
    for (const text of [` ${canonical}`, canonical.slice(0, 40) + "!" + canonical.slice(40), canonical.slice(0, 40) + "=" + canonical.slice(40), "A", "AAAAA=", "AAAAAA=", "===", null, 7]) {
      expect(fromLooseBase64(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("keys in padded base64 are exactly 32 bytes in the canonical spelling", () => {
    const raw = hex(RFC8032[0]!.pub);
    const b64 = toBase64(raw);
    expect(rawFromBase64Key(b64)).toEqual(raw);
    expect(rawFromBase64Key(b64.slice(0, -1))).toBeNull();
    expect(rawFromBase64Key(Buffer.from(raw).toString("base64url"))).toBeNull();
    expect(rawFromBase64Key(toBase64(raw.subarray(0, 31)))).toBeNull();
    expect(rawFromBase64Key(b64.slice(0, 42) + String.fromCharCode(b64.charCodeAt(42) + 1) + "=")).toBeNull();
  });
});

describe("canonical JSON (RFC 8785)", () => {
  it("sorts members by UTF-16 code units (RFC 8785 §3.2.3)", () => {
    const input = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"];
    const want = "{" + order.map((k) => `${JSON.stringify(k)}:${JSON.stringify((input as Record<string, string>)[k])}`).join(",") + "}";
    expect(canonicalJSON(input)).toBe(want);
    expect(jcs(input)).toBe(want);
  });

  it("writes numbers as ECMAScript does (RFC 8785 §3.2.2.3)", () => {
    const cases: Array<[number, string]> = [
      [0, "0"], [-0, "0"], [1e21, "1e+21"], [1e-7, "1e-7"], [5e-324, "5e-324"], [1.7976931348623157e308, "1.7976931348623157e+308"],
      [9007199254740992, "9007199254740992"], [0.000001, "0.000001"], [333333333.33333329, "333333333.3333333"], [-1.5, "-1.5"], [100, "100"],
    ];
    for (const [n, s] of cases) expect(jcs(n), String(n)).toBe(s);
  });

  it("escapes strings as RFC 8785 §3.2.2.2 does", () => {
    const s = "\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"/";
    expect(jcs(s)).toBe('"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"');
    expect(jcs({ s: "\u007f\u0080 " })).toBe('{"s":"\u007f\u0080 "}');
  });

  it("nested containers, empty containers and the scalars", () => {
    expect(canonicalJSON({ b: { z: 1, a: [3, { y: true, x: null }] }, a: "first", o: {}, e: [] })).toBe('{"a":"first","b":{"a":[3,{"x":null,"y":true}],"z":1},"e":[],"o":{}}');
    expect(canonicalJSON(null)).toBe("null");
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON("x")).toBe('"x"');
    expect(canonicalJSON(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
    expect(canonicalJSON(JSON.parse('{"__proto__": {"x": 1}, "a": 2}'))).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it("leaves out undefined members, or refuses them when asked, and jcs refuses them", () => {
    expect(canonicalJSON({ a: undefined, b: 1, c: { d: undefined } })).toBe('{"b":1,"c":{}}');
    expect(() => canonicalJSON({ a: undefined }, { undefinedMembers: "refuse" })).toThrow(/undefined member \$\.a/);
    expect(() => canonicalJSON({ a: undefined }, { undefinedMembers: "refuse", path: "event" })).toThrow(/undefined member event\.a/);
    expect(() => jcs({ a: undefined })).toThrow(CanonicalJSONError);
  });

  it("writes a lone surrogate as its escape, which jcs refuses (I-JSON)", () => {
    expect(canonicalJSON({ s: "\uD800" })).toBe('{"s":"\\ud800"}');
    expect(canonicalJSON({ "\uDC00": 1 })).toBe('{"\\udc00":1}');
    expect(() => jcs({ s: "\uD800 and" })).toThrow(/lone surrogate/);
    expect(() => jcs({ "\uDC00": 1 })).toThrow(/lone surrogate/);
    expect(jcs({ s: "😀" })).toBe('{"s":"😀"}');
  });

  it("refuses every value that has no JSON spelling, naming where it is", () => {
    class Point {
      x = 1;
    }
    const cases: Array<[string, unknown, RegExp]> = [
      ["NaN", { n: NaN }, /non-finite number NaN at \$\.n/],
      ["Infinity", { a: [Infinity] }, /non-finite number Infinity at \$\.a\[0\]/],
      ["-Infinity", -Infinity, /non-finite/],
      ["an undefined array element", [1, undefined, 2], /undefined element at \$\[1\]/],
      ["a hole", [1, , 2], /undefined element at \$\[1\]/],
      ["undefined", undefined, /undefined at \$/],
      ["a function member", { f: () => 1 }, /a function at \$\.f/],
      ["a function in an array", [() => 1], /a function at \$\[0\]/],
      ["a symbol", { s: Symbol("s") }, /a symbol at \$\.s/],
      ["a BigInt", { b: 10n }, /a bigint at \$\.b/],
      ["a Date", { at: new Date(0) }, /a Date at \$\.at/],
      ["a Map", new Map([["a", 1]]), /a Map at \$/],
      ["a typed array", { b: new Uint8Array([5, 6]) }, /a Uint8Array at \$\.b/],
      ["a class instance", { p: new Point() }, /a Point at \$\.p/],
      ["an object with toJSON", { v: { toJSON: () => "x", k: 1 } }, /a function at \$\.v\.toJSON/],
    ];
    for (const [name, value, want] of cases) {
      expect(() => canonicalJSON(value), name).toThrow(want);
      expect(() => jcs(value), name).toThrow(CanonicalJSONError);
    }
  });
});
