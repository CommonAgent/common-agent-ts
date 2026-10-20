// Agent SoW 0.26.0-draft signatures bound to seats (§5.1, §6), asserted
// against conformance/sow-signatures.json. The file's `cases` are the vectors
// (signatureCase); the suites below read its other members: the published
// keys, the registry's owners, the documents, the signed bytes and the
// validation cases.
import { expect } from "vitest";
import { createHash } from "node:crypto";
import { loadPinnedVectors } from "../../vectors/index.js";
import { collector } from "./collect.js";
import type { VectorCase } from "../../vectors/index.js";
import {
  canonicalJSON,
  ownerConfirmation,
  signatureStatus,
  signerFromRawSeed,
  sowAgreed,
  sowSignedBytes,
  validateSowDocument,
  type SowDocument,
} from "../index.js";

const { describe, it, suites } = collector();
export { suites };

const fixture = loadPinnedVectors("sow/conformance/sow-signatures.json").data as unknown as {
  keys: { entries: Record<string, { label: string; seed_hex: string; public: string }> };
  registry: { owners: Record<string, { owner: string; attested: boolean }> };
  documents: Record<string, SowDocument>;
  signed_bytes: { document: string; bytes: string; digest: string };
  cases: Array<{ case: string; document: string; expected: { provider: string; client: string; agreed: boolean; signatures_verify?: boolean } }>;
  validation: { invalid: Array<{ case: string; document?: string; edit?: Record<string, string>; why: string }> };
};

/** One `cases` vector: each role's signature status, and whether the document is agreed. */
export function signatureCase(c: VectorCase): void {
  const v = c.value as (typeof fixture.cases)[number];
  const doc = fixture.documents[v.document]!;
  const status = (role: "provider" | "client") => signatureStatus(doc, doc.signatures!.find((s) => s.role === role)!);
  expect(status("provider")).toBe(v.expected.provider);
  expect(status("client")).toBe(v.expected.client);
  expect(sowAgreed(doc)).toBe(v.expected.agreed);
  if (v.expected.signatures_verify !== undefined) {
    expect(doc.signatures!.every((s) => signatureStatus(doc, s) !== "invalid")).toBe(v.expected.signatures_verify);
  }
}

describe("§6 the published keys derive from their labels, and each public key from its seed", () => {
  it("every seed is the SHA-256 of its label, and signs as its public key", () => {
    for (const k of Object.values(fixture.keys.entries)) {
      expect(createHash("sha256").update(k.label).digest("hex")).toBe(k.seed_hex);
      expect(signerFromRawSeed(new Uint8Array(Buffer.from(k.seed_hex, "hex"))).getPublicKey()).toBe(k.public);
    }
  });
});

describe("§6 the signed bytes, and a signature made again reproduces the pinned one", () => {
  it("are the tag and the JCS of the document less its signatures", () => {
    const doc = fixture.documents[fixture.signed_bytes.document]!;
    const bytes = new TextDecoder().decode(sowSignedBytes(doc));
    expect(bytes).toBe(fixture.signed_bytes.bytes);
    expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(fixture.signed_bytes.digest);
  });
  it("Ed25519 is deterministic, so the stonework owner's signature comes out byte for byte", async () => {
    const { signSow } = await import("../index.js");
    const doc = fixture.documents.agreed!;
    const seed = fixture.keys.entries["stonework-owner"]!.seed_hex;
    const { signatures: _s, ...unsigned } = doc;
    const ours = signSow(unsigned, signerFromRawSeed(new Uint8Array(Buffer.from(seed, "hex"))), "provider", "2026-08-04T14:02:11Z").signatures[0]!;
    expect(ours.sig).toBe(doc.signatures!.find((s) => s.role === "provider")!.sig);
  });
});

describe("§6 the registry confirms, contradicts, or leaves unconfirmed a seat's owner_key", () => {
  it("confirms both seats of the agreed document from the attested owners", () => {
    const doc = fixture.documents.agreed!;
    for (const role of ["provider", "client"] as const) {
      expect(ownerConfirmation(doc, role, fixture.registry.owners[doc.parties[role]!.agent])).toBe("confirmed");
    }
  });
  it("is contradicted by an attested owner that is another key, and unconfirmed without an attestation or an answer", () => {
    const doc = fixture.documents.agreed!;
    const outsider = fixture.keys.entries["outsider-owner"]!.public;
    expect(ownerConfirmation(doc, "client", { owner: outsider, attested: true })).toBe("contradicted");
    expect(ownerConfirmation(doc, "client", { owner: doc.parties.client!.owner_key!, attested: false })).toBe("unconfirmed");
    expect(ownerConfirmation(doc, "client", null)).toBe("unconfirmed");
    expect(ownerConfirmation(fixture.documents.legacy!, "client", fixture.registry.owners[doc.parties.client!.agent])).toBe("unconfirmed");
  });
});

/** Apply one validation edit: a dotted path set to a value, or removed. */
function edited(doc: SowDocument, edit: Record<string, string>): SowDocument {
  const out = JSON.parse(canonicalJSON(doc)) as Record<string, any>;
  for (const [path, value] of Object.entries(edit)) {
    const parts = path.split(".");
    let node = out;
    for (const p of parts.slice(0, -1)) node = node[p];
    const leaf = parts[parts.length - 1]!;
    if (value === "<removed>") delete node[leaf];
    else node[leaf] = value;
  }
  return out as SowDocument;
}

describe("§5.1 and §6 what a validator refuses", () => {
  it("accepts the agreed document and the legacy one", () => {
    expect(() => validateSowDocument(fixture.documents.agreed)).not.toThrow();
    expect(() => validateSowDocument(fixture.documents.legacy)).not.toThrow();
  });
  for (const row of fixture.validation.invalid) {
    it(`${row.case} is refused: ${row.why}`, () => {
      const base = fixture.documents[row.document ?? "agreed"]!;
      const doc = row.edit ? edited(base, row.edit) : base;
      expect(() => validateSowDocument(doc)).toThrow(/§(5\.1|6)\)/);
    });
  }
});

