// Agent SoW 0.29.0-draft, the bytes of the formation messages (§5.8),
// asserted against conformance/sow-formation-messages.json. The file's
// `cases` are the vectors (messageCase): each names a message and whether a
// runtime takes it. The suites below read its other members: the published
// keys, the approved replacement's digest, the signed bytes, and the
// messages made again from the published seeds.
import { expect } from "vitest";
import { createHash } from "node:crypto";
import { loadPinnedVectors, type VectorCase } from "../../vectors/index.js";
import { collector } from "./collect.js";
import {
  SOW_FORMATION_SIG_PREFIX,
  SowRefusal,
  canonicalJSON,
  checkFormationMessage,
  formationDigest,
  formationSubject,
  signFormationMessage,
  signerFromRawSeed,
  type SowDocument,
  type SowFormationMessage,
  type SowUnsignedFormationMessage,
} from "../index.js";

const { describe, it, suites } = collector();
export { suites };

const fixture = loadPinnedVectors("sow/conformance/sow-formation-messages.json").data as unknown as {
  keys: { entries: Record<string, { label: string; seed_hex: string; public: string }> };
  proposer: "provider" | "client";
  approved: { document: SowDocument; signed_bytes_digest: string };
  messages: Record<string, SowFormationMessage & Record<string, unknown>>;
  signed_bytes: { message: string; bytes: string };
  cases: Array<{ message: string; valid: boolean; why?: string }>;
};

/** One `cases` vector: the named message is taken, or refused, against the approval it is about. */
export function messageCase(c: VectorCase): void {
  const v = c.value as unknown as (typeof fixture.cases)[number];
  const message = fixture.messages[v.message];
  expect(message, `${v.message} is in the file`).toBeDefined();
  const subject = formationSubject(fixture.approved.document, fixture.proposer);
  let taken = true;
  try {
    checkFormationMessage(message, subject);
  } catch (e) {
    if (!(e instanceof SowRefusal)) throw e;
    taken = false;
  }
  expect(taken, `${v.message}: ${v.why ?? "a valid message"}`).toBe(v.valid);
}

const seedFor = (publicKey: string) => {
  const entry = Object.values(fixture.keys.entries).find((k) => k.public === publicKey)!;
  return signerFromRawSeed(new Uint8Array(Buffer.from(entry.seed_hex, "hex")));
};

describe("§5.8 the published keys derive from their labels", () => {
  it("every seed is the SHA-256 of its label, and signs as its public key", () => {
    for (const k of Object.values(fixture.keys.entries)) {
      expect(createHash("sha256").update(k.label).digest("hex")).toBe(k.seed_hex);
      expect(signerFromRawSeed(new Uint8Array(Buffer.from(k.seed_hex, "hex"))).getPublicKey()).toBe(k.public);
    }
  });
});

describe("§5.8 every message names the digest of the approved replacement's signed bytes", () => {
  it("is sha256: and the hex SHA-256 of the replacement's §6 signed bytes", () => {
    expect(formationDigest(fixture.approved.document)).toBe(fixture.approved.signed_bytes_digest);
  });
});

describe("§5.8 a message's signed bytes, and the messages made again", () => {
  it("are the formation tag, one newline, and the JCS of the message less sig", () => {
    const { sig: _s, ...body } = fixture.messages[fixture.signed_bytes.message]!;
    expect(SOW_FORMATION_SIG_PREFIX + canonicalJSON(body)).toBe(fixture.signed_bytes.bytes);
  });
  it("signing each valid message's members again with its seat's published seed reproduces it member for member", () => {
    for (const name of ["acknowledgement", "receipt_of_acknowledgement", "void", "receipt_of_void", "acknowledgement_not_formed"]) {
      const { by, key, signed_at, sig: _s, ...unsigned } = fixture.messages[name]!;
      const ours = signFormationMessage(unsigned as SowUnsignedFormationMessage, seedFor(key), by, signed_at);
      expect(ours, name).toEqual(fixture.messages[name]);
    }
  });
});
