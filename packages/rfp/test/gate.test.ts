/**
 * Gated postings in the core (Agent RFP §5.11): the split into a public
 * document and a sealed body, the gate's refusals, and the release decision.
 */
import { describe, expect, it } from "vitest";
import {
  assemblePosting,
  bodyDigest,
  canonicalJSON,
  isGated,
  nonceRefusal,
  sealedBodyRefusal,
  openPosting,
  publicSummaryOf,
  refuseGate,
  releaseRefusal,
  sealedMemberInPublic,
  sealPosting,
  type GateAnswer,
  type RfpGateInput,
} from "../index.js";

const GATE: RfpGateInput = {
  summary: { text: "An audit of twelve months of inbound carrier invoices against contracted rates." },
  nda: { id: "nda_dtzv6z8tans9k5s6", version: 1, digest: "sha256:" + "3d".repeat(32) },
};

const assembled = assemblePosting({
  posted_at: "2026-10-20T15:05:00Z",
  expires_at: "2026-11-13T00:00:00Z",
  poster: { agent: "UPOSTER", owner: "Harbor & Line Outfitters" },
  need: {
    summary: "Audit our invoices from Meridian Freight, Kestrel Line and Bayside Haulage.",
    procurement: "rent",
    performer: "agent",
  },
  budget: { currency: "XCR", per_task_max: 1_500_000 },
  award: { award_by: "2026-11-10T00:00:00Z" },
  handling: { processed_in: ["us", "ca"], promises: ["no_training"] },
});

describe("sealing a posting", () => {
  const sealed = sealPosting(assembled, GATE);

  it("keeps every sealed member out of the public document", () => {
    expect(sealed.posting.need).toBeUndefined();
    expect(sealed.posting.budget).toBeUndefined();
    expect(sealed.posting.award).toBeUndefined();
    expect(sealed.posting.handling).toBeUndefined();
    expect(sealedMemberInPublic(sealed.posting as unknown as Record<string, unknown>)).toBeNull();
    expect(isGated(sealed.posting)).toBe(true);
  });

  it("states each classification once, in public", () => {
    expect(sealed.posting.gate?.summary).toMatchObject({ procurement: "rent", performer: "agent" });
    expect(sealed.body.need.procurement).toBeUndefined();
    expect(sealed.body.need.performer).toBeUndefined();
  });

  it("commits to the body by the digest of its canonical bytes", () => {
    expect(sealed.bytes).toBe(canonicalJSON(sealed.body));
    expect(sealed.digest).toBe(bodyDigest(sealed.bytes));
    expect(sealed.posting.gate?.body.digest).toBe(sealed.digest);
    expect(sealed.body).toMatchObject({ rfp_body: "v1", language: "en" });
  });

  it("opens back into the posting its poster wrote", () => {
    const opened = openPosting(sealed.posting, sealed.body);
    expect(opened.need).toMatchObject({ procurement: "rent", performer: "agent" });
    expect(opened.need?.summary).toContain("Kestrel Line");
    expect(opened.handling?.processed_in).toEqual(["us", "ca"]);
  });

  it("shows the summary to a reader the body was not released to", () => {
    expect(publicSummaryOf(sealed.posting)).toBe(GATE.summary.text);
    expect(publicSummaryOf(assembled)).toContain("Kestrel Line");
  });

  it("refuses a public member that belongs to the body", () => {
    expect(sealedMemberInPublic({ ...sealed.posting, budget: { currency: "XCR" } })).toBe("budget");
  });
});

describe("the body's nonce (§5.11.2)", () => {
  it("is fresh for every sealing, and at least 16 bytes of padded base64", () => {
    const a = sealPosting(assembled, GATE).body.nonce;
    const b = sealPosting(assembled, GATE).body.nonce;
    expect(a).not.toBe(b);
    expect(nonceRefusal(a)).toBeNull();
    expect(Buffer.from(a, "base64").length).toBe(16);
  });

  it("is refused when missing, short, unpadded, url-safe or not base64", () => {
    expect(nonceRefusal(undefined)).toMatch(/carries a nonce/);
    expect(nonceRefusal("+bAHi131ltLqGQEMABu9")).toMatch(/at least 16 bytes/);
    expect(nonceRefusal("i9dt-oYl76qbDI7Sitnp1Q")).toMatch(/base64 with padding/);
    expect(nonceRefusal("i9dt+oYl76qbDI7Sitnp1Q")).toMatch(/base64 with padding/);
    expect(nonceRefusal("not a nonce!!")).toMatch(/base64 with padding/);
    expect(sealedBodyRefusal({ rfp_body: "v1", nonce: "i9dt+oYl76qbDI7Sitnp1Q==", language: "en" }, "en")).toBeNull();
    expect(sealedBodyRefusal({ rfp_body: "v1", nonce: "i9dt+oYl76qbDI7Sitnp1Q==", language: "de" }, "en")).toMatch(/language/);
  });
});

describe("the gate's refusals", () => {
  it("takes a well-formed gate", () => {
    expect(refuseGate(GATE)).toBeNull();
    expect(refuseGate(undefined)).toBeNull();
  });

  it("names what is missing", () => {
    expect(refuseGate({ ...GATE, summary: { text: " " } })).toMatch(/gate.summary.text/);
    expect(refuseGate({ ...GATE, summary: { text: "x".repeat(601) } })).toMatch(/at most 600/);
    expect(refuseGate({ ...GATE, nda: { ...GATE.nda, id: "not-an-nda" } })).toMatch(/gate.nda.id/);
    expect(refuseGate({ ...GATE, nda: { ...GATE.nda, version: 0 } })).toMatch(/gate.nda.version/);
    expect(refuseGate({ ...GATE, nda: { ...GATE.nda, digest: "sha256:XYZ" } })).toMatch(/gate.nda.digest/);
    expect(refuseGate({ ...GATE, nda: { ...GATE.nda, ref: "http://plain.example" } })).toMatch(/https URL/);
  });
});

describe("the release decision", () => {
  const doc = sealPosting(assembled, GATE).posting;
  const ok: GateAnswer = {
    ok: true,
    agreement: { id: GATE.nda.id, version: 1, digest: "sha256:" + "b".repeat(64) },
    recipient: { agent: "UREADER" },
    owner: "confirmed",
  };

  it("releases to the recipient, asking for itself, on an open posting", () => {
    expect(releaseRefusal({ doc, state: "open", answer: ok, readerAgents: ["UREADER"] })).toBeNull();
  });

  it("names the check that refused", () => {
    expect(releaseRefusal({ doc, state: "open", answer: { ok: false, check: 3, reason: "another offer" }, readerAgents: ["UREADER"] })).toMatchObject({ check: 3 });
    expect(releaseRefusal({ doc, state: "open", answer: { ok: false, unavailable: true, reason: "no module" }, readerAgents: ["UREADER"] })).toMatchObject({ check: "unavailable" });
    expect(releaseRefusal({ doc, state: "open", answer: ok, readerAgents: ["USOMEONE"] })).toMatchObject({ check: 4 });
    expect(releaseRefusal({ doc, state: "awarded", answer: ok, readerAgents: ["UREADER"] })).toMatchObject({ check: 6 });
    expect(releaseRefusal({ doc: assembled, state: "open", answer: ok, readerAgents: ["UREADER"] })).toMatchObject({ check: "not_gated" });
  });

  it("never releases to a contradicted owner, and to an unconfirmed one only under any", () => {
    expect(releaseRefusal({ doc, state: "open", answer: { ...ok, owner: "contradicted", owners_accepted: "any" } as GateAnswer, readerAgents: ["UREADER"] })).toMatchObject({ check: 1 });
    expect(releaseRefusal({ doc, state: "open", answer: { ...ok, owner: "unconfirmed" } as GateAnswer, readerAgents: ["UREADER"] })).toMatchObject({ check: 1 });
    expect(releaseRefusal({ doc, state: "open", answer: { ...ok, owner: "unconfirmed", owners_accepted: "any" } as GateAnswer, readerAgents: ["UREADER"] })).toBeNull();
    expect(releaseRefusal({ doc, state: "open", answer: { ...ok, owner: "mnd_3f8c1n6z9v4b7q2m" } as GateAnswer, readerAgents: ["UREADER"] })).toBeNull();
  });

  it("keeps a provider's entitlement after close, and makes no first release", () => {
    expect(releaseRefusal({ doc, state: "closed", answer: ok, readerAgents: ["UREADER"], releasedThisVersion: (a) => a === "UREADER" })).toBeNull();
    expect(releaseRefusal({ doc, state: "closed", answer: ok, readerAgents: ["UREADER"], releasedThisVersion: () => false })).toMatchObject({ check: 6 });
  });
});
