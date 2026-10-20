/**
 * The document as a whole (document.ts) and the clauses the SDK stopped short
 * of (clauses.ts, the §5.11 additions in confidentiality.ts): the identifier,
 * the frame, standing proposals against instances, and each clause's rules.
 */
import { describe, expect, it } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import {
  SowRefusal,
  checkDeliverableForm,
  checkScopedRequest,
  deemedAccepted,
  idRederives,
  inputsForRendering,
  powerToWrite,
  isKnownVia,
  isStandingProposal,
  mintSowId,
  publishedInputBinding,
  quoteRevision,
  validateSowAcceptance,
  validateSowConfidentiality,
  validateSowDeliverables,
  validateSowDocument,
  validateSowInputs,
  validateSowRevisions,
  validateSowRights,
  validateSowScope,
  type SowDocument,
  type SowRevisions,
  type SowScope,
} from "../index.js";

const pricing = loadPinnedVectors("sow/conformance/sow-pricing.json").data as Record<string, any>;
const instance = (): SowDocument => structuredClone(pricing.signing.document);
const directed = (): SowDocument => structuredClone(pricing.directed.signing.document);
const qualified = (): SowDocument => structuredClone(pricing.qualifications.signing.document);
const DIGEST = "sha256:" + "ab".repeat(32);

function refusal(f: () => unknown): SowRefusal {
  try {
    f();
  } catch (e) {
    if (e instanceof SowRefusal) return e;
    throw e;
  }
  throw new Error("expected a SowRefusal");
}

describe("§4.1 the identifier", () => {
  it("is sow_ and 16 lowercase Crockford base32 characters, from the bytes less id and signatures", () => {
    const doc = { ...directed(), version: 1 };
    const id = mintSowId(doc);
    expect(id).toMatch(/^sow_[0-9a-hjkmnp-tv-z]{16}$/);
    expect(mintSowId({ ...doc, id: "sow_anything0000000", signatures: [{ role: "provider" }] })).toBe(id);
    expect(mintSowId({ ...doc, scope: { ...doc.scope, grade: "enforced", examples: {} } })).not.toBe(id);
  });

  it("re-derives only as a diagnostic, and never for a later version", () => {
    const doc = { ...directed(), version: 1 };
    const minted = { ...doc, id: mintSowId(doc) };
    expect(idRederives(minted)).toBe(true);
    expect(idRederives({ ...minted, version: 2 })).toBe(false);
    // A fixture document with a hand-written id is still a valid document: a reader never checks the derivation.
    expect(idRederives(instance())).toBe(false);
    expect(() => validateSowDocument(instance())).not.toThrow();
  });
});

describe("§4.2 the frame, standing proposals and instances", () => {
  it("accepts the conformance files' documents: an instance and two standing proposals", () => {
    expect(() => validateSowDocument(instance())).not.toThrow();
    expect(() => validateSowDocument(directed())).not.toThrow();
    expect(() => validateSowDocument(qualified())).not.toThrow();
    expect(() => validateSowDocument(pricing.no_charge.signed)).not.toThrow();
    expect(isStandingProposal(directed())).toBe(true);
    expect(isStandingProposal(instance())).toBe(false);
  });

  it("refuses a standing proposal that carries a buyer reference or a start", () => {
    expect(refusal(() => validateSowDocument({ ...directed(), buyer_reference: "PO-1" })).section).toBe("5.17");
    expect(refusal(() => validateSowDocument({ ...directed(), starts_at: "2026-09-01T00:00:00Z" })).section).toBe("12.1");
  });

  it("refuses a directed proposal bounded by neither an expires_at nor an occasion it names", () => {
    const doc = directed();
    const { expires_at: _e, ...unbounded } = doc.parties.offered_to!;
    expect(refusal(() => validateSowDocument({ ...doc, parties: { ...doc.parties, offered_to: unbounded } })).section).toBe("12.1.1");
    expect(() => validateSowDocument({ ...doc, parties: { ...doc.parties, offered_to: unbounded }, solicitation: { rfp: "rfp_freightaudit", version: 2 } })).not.toThrow();
    expect(refusal(() => validateSowDocument({ ...doc, solicitation: { rfp: "freight", version: 2 } })).section).toBe("12.1.1");
  });

  it("refuses a standing proposal with no term at all", () => {
    const { term_months: _t, ...noTerm } = directed();
    expect(refusal(() => validateSowDocument(noTerm)).section).toBe("5.7");
  });

  it("holds an instance to both instants, in order, and the reservation inside them", () => {
    expect(refusal(() => validateSowDocument({ ...instance(), ends_at: "2026-08-01T00:00:00Z" })).section).toBe("5.7");
    const short = { ...instance(), ends_at: "2026-08-20T00:00:00Z" };
    expect(refusal(() => validateSowDocument(short)).section).toBe("5.5.4");
  });

  it("refuses the same agent in both seats, and a third signature for a role", () => {
    const doc = instance();
    doc.parties.client = { ...doc.parties.client!, agent: doc.parties.provider.agent };
    expect(refusal(() => validateSowDocument(doc)).section).toBe("5.1");
    const signed = structuredClone(pricing.signing.signed);
    signed.signatures = [signed.signatures[0], signed.signatures[0]];
    expect(refusal(() => validateSowDocument(signed)).section).toBe("6");
  });

  it("carries a member it does not know instead of refusing it", () => {
    expect(() => validateSowDocument({ ...instance(), x_later_revision: { grade: "recorded" } })).not.toThrow();
  });

  it("validates the 0.25.0-draft members where present", () => {
    expect(() => validateSowDocument({ ...instance(), buyer_reference: "PO-2026-004417" })).not.toThrow();
    expect(refusal(() => validateSowDocument({ ...instance(), buyer_reference: "" })).section).toBe("5.17");
    const contact = { agents: ["ledger.harborandline@example.com"], grants: ["share"], per_day: 5, grade: "enforced" };
    expect(() => validateSowDocument({ ...instance(), provider_contact: contact })).not.toThrow();
    expect(refusal(() => validateSowDocument({ ...instance(), provider_contact: { ...contact, grants: ["errands"] } })).section).toBe("5.18");
  });
});

describe("§5.2 scope and §5.2.1 a process as the scope", () => {
  const process: SowScope = { process: { id: "acme/video-to-explainer", version: DIGEST }, grade: "enforced" };

  it("takes offerings or a process, never both and never neither", () => {
    expect(() => validateSowScope(process)).not.toThrow();
    expect(refusal(() => validateSowScope({ ...process, offerings: ["a"] })).section).toBe("5.2.1");
    expect(refusal(() => validateSowScope({ grade: "enforced" })).section).toBe("5.2");
  });

  it("pins a process by the digest of its text, never by a version label", () => {
    expect(refusal(() => validateSowScope({ process: { id: "acme/x", version: "v3" }, grade: "enforced" })).section).toBe("5.2.1");
  });

  it("refuses a request outside the scope, matched on the offering or the process and digest", () => {
    const listed: SowScope = { offerings: ["reconcile-statement"], grade: "enforced" };
    expect(() => checkScopedRequest(listed, { offering: "reconcile-statement" })).not.toThrow();
    expect(refusal(() => checkScopedRequest(listed, { offering: "file-taxes" })).kind).toBe("refused");
    expect(() => checkScopedRequest(process, { process: process.process! })).not.toThrow();
    expect(refusal(() => checkScopedRequest(process, { process: { ...process.process!, version: "sha256:" + "cd".repeat(32) } })).section).toBe("5.2.1");
  });
});

describe("§5.3 inputs and §5.3.1 granting access", () => {
  const inputs = [
    { name: "bank-statement", media_type: "text/csv", when: "per_task" },
    { name: "receipts", kind: "shared_resource", access: "read", via: "link", when: "standing" },
    { name: "ledger", kind: "shared_resource", access: "read-write", via: "mcp", when: "per_task" },
    { name: "crm", kind: "shared_resource", access: "read", via: "carrier_pigeon", when: "standing" },
  ];

  it("carries an unknown via verbatim, and refuses via on an input that is not a grant", () => {
    expect(() => validateSowInputs(inputs)).not.toThrow();
    expect(isKnownVia("carrier_pigeon")).toBe(false);
    expect(refusal(() => validateSowInputs([{ name: "file", via: "link" }])).section).toBe("5.3.1");
    expect(refusal(() => validateSowInputs([{ name: "a" }, { name: "a" }])).section).toBe("5.3");
  });

  it("finds a binding in what a standing proposal would publish", () => {
    expect(publishedInputBinding(inputs as never)).toBeNull();
    expect(publishedInputBinding([{ name: "ledger", kind: "shared_resource", via: "mcp", endpoint: "x" }])).toEqual({ input: "ledger", member: "endpoint" });
    expect(publishedInputBinding([{ name: "ledger", note: "https://mcp.example.com/ledger" }])).toEqual({ input: "ledger", member: "note" });
  });

  it("refuses a market standing proposal that publishes an address, and lets a directed one name it", () => {
    const bound = [{ name: "ledger", kind: "shared_resource", via: "mcp", when: "standing", url: "https://mcp.example.com" }];
    const { offered_to: _o, ...marketParties } = directed().parties;
    const market = { ...directed(), parties: marketParties, inputs: bound };
    expect(refusal(() => validateSowDocument(market)).section).toBe("5.3.1");
    expect(() => validateSowDocument({ ...directed(), inputs: bound })).not.toThrow();
  });

  it("takes writes only on a proxy grant, naming write or amend per resource, and reads write where it names none", () => {
    const proxy = { name: "ledger", kind: "shared_resource", access: "read-write", via: "proxy", when: "standing", writes: { journal: "amend", accounts: "write" } };
    expect(() => validateSowInputs([proxy])).not.toThrow();
    expect(powerToWrite(proxy as never, "journal")).toBe("amend");
    expect(powerToWrite(proxy as never, "vendors")).toBe("write");
    expect(refusal(() => validateSowInputs([{ ...proxy, via: "mcp" }])).section).toBe("5.3.1");
    for (const power of ["form", "award", "nda", "issue", "terminate"]) {
      expect(refusal(() => validateSowInputs([{ ...proxy, writes: { journal: power } }])).section).toBe("5.3.1");
    }
    expect(refusal(() => validateSowInputs([{ ...proxy, writes: {} }])).section).toBe("5.3.1");
  });

  it("orders grants for rendering: standing grants first, apart from what is simply sent", () => {
    const r = inputsForRendering(inputs as never);
    expect(r.standingGrants.map((i) => i.name)).toEqual(["receipts", "crm"]);
    expect(r.perTaskGrants.map((i) => i.name)).toEqual(["ledger"]);
    expect(r.sent.map((i) => i.name)).toEqual(["bank-statement"]);
  });
});

describe("§5.4 deliverables, rights and acceptance", () => {
  const deliverables = {
    per_task: [{ name: "reconciliation-report", media_type: "application/pdf" }],
    interim: [
      { name: "month-end-close-summary", media_type: "application/pdf", recurrence: { every: "month", due_by_day: 5 } },
      { name: "chart-of-accounts-review", media_type: "application/pdf", due: "2026-11-01T00:00:00Z" },
    ],
    grade: "enforced",
  };

  it("accepts the specification's example, and an interim deliverable needs exactly one of due and recurrence", () => {
    expect(() => validateSowDeliverables(deliverables)).not.toThrow();
    const both = structuredClone(deliverables);
    (both.interim[0] as Record<string, unknown>).due = "2026-11-01T00:00:00Z";
    expect(refusal(() => validateSowDeliverables(both)).section).toBe("5.4");
  });

  it("checks form and nothing else: a missing named artifact is a failed task", () => {
    expect(checkDeliverableForm(deliverables as never, [{ name: "reconciliation-report", media_type: "application/pdf" }])).toEqual({ ok: true });
    expect(checkDeliverableForm(deliverables as never, [{ name: "reconciliation-report", media_type: "text/plain" }])).toEqual({ ok: false, missing: ["reconciliation-report"] });
  });

  it("grades rights recorded, and refuses an exclusivity outside the three", () => {
    expect(() => validateSowRights({ exclusivity: "exclusive", modify: true, redistribute: false, self_operable: true, grade: "recorded" })).not.toThrow();
    expect(refusal(() => validateSowRights({ exclusivity: "exclusive", grade: "enforced" })).section).toBe("5.4.1");
    expect(refusal(() => validateSowRights({ exclusivity: "sole", grade: "recorded" })).section).toBe("5.4.1");
  });

  it("commits the test set by digest; a published set says where it is, a withheld one may not yet", () => {
    const acceptance = { test_set: { digest: DIGEST, withheld: true }, measure: "invoices correctly flagged", threshold: { min_fraction: 0.95 }, grade: "evidence" };
    expect(() => validateSowAcceptance(acceptance)).not.toThrow();
    expect(refusal(() => validateSowAcceptance({ ...acceptance, test_set: { digest: DIGEST } })).section).toBe("5.4.2");
    expect(refusal(() => validateSowAcceptance({ ...acceptance, grade: "enforced" })).section).toBe("5.4.2");
  });

  it("treats silence as acceptance only past a stated window", () => {
    const base = { test_set: { digest: DIGEST, withheld: true }, measure: "m", threshold: { min_fraction: 1 }, grade: "evidence" as const };
    expect(deemedAccepted(base, "2026-09-01T00:00:00Z", "2027-09-01T00:00:00Z")).toBe(false);
    expect(deemedAccepted({ ...base, deemed_accepted_after_days: 10 }, "2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z")).toBe(false);
    expect(deemedAccepted({ ...base, deemed_accepted_after_days: 10 }, "2026-09-01T00:00:00Z", "2026-09-12T00:00:00Z")).toBe(true);
  });
});

describe("§5.4.3 revisions", () => {
  const usd = (n: number) => ({ model: "flat" as const, amount_micro: n, currency: "USD" });
  const stepped: SowRevisions = { included: { count: 1, window_days: 14 }, steps: [{ id: "record-the-narration", price: usd(400000) }], grade: "enforced" };

  it("takes steps or flat, never both", () => {
    expect(() => validateSowRevisions(stepped)).not.toThrow();
    expect(refusal(() => validateSowRevisions({ ...stepped, flat: usd(1) })).section).toBe("5.4.3");
  });

  it("admits an included revision free inside the count and window, counted on the original task", () => {
    const original = { completed_at: "2026-09-01T00:00:00Z", revisions_used: 0 };
    expect(quoteRevision(stepped, { steps: ["record-the-narration"] }, original, "2026-09-10T00:00:00Z")).toEqual({ admitted: true, included: true, amount_micro: 0 });
    // The count is used: priced, and refused with the quote without a covering budget.
    const used = { ...original, revisions_used: 1 };
    expect(quoteRevision(stepped, { steps: ["record-the-narration"] }, used, "2026-09-10T00:00:00Z")).toMatchObject({ admitted: false, reason: "budget", amount_micro: 400000 });
    expect(quoteRevision(stepped, { steps: ["record-the-narration"], budget_micro: 400000 }, used, "2026-09-10T00:00:00Z")).toEqual({ admitted: true, included: false, amount_micro: 400000, currency: "USD" });
    // Past the window, also priced.
    expect(quoteRevision(stepped, { steps: ["record-the-narration"] }, original, "2026-10-01T00:00:00Z")).toMatchObject({ admitted: false, reason: "budget" });
  });

  it("has no price to quote when the included revisions are used and the clause prices none, and offers none without the clause", () => {
    const original = { completed_at: "2026-09-01T00:00:00Z", revisions_used: 1 };
    expect(quoteRevision({ included: { count: 1, window_days: 14 }, grade: "enforced" }, {}, original, "2026-09-02T00:00:00Z")).toMatchObject({ admitted: false, reason: "no_price" });
    expect(quoteRevision(undefined, {}, original, "2026-09-02T00:00:00Z")).toMatchObject({ admitted: false, reason: "not_offered" });
  });
});

describe("§5.11 the members the SDK did not read: dpa, and a processor's own jurisdictions", () => {
  it("requires the dpa digest, spelled exactly", () => {
    expect(() => validateSowConfidentiality({ dpa: { digest: DIGEST, ref: "mesh:artifacts:01J9A4C7Q2", title: "DPA rev 3" } })).not.toThrow();
    expect(refusal(() => validateSowConfidentiality({ dpa: { ref: "x" } })).section).toBe("5.11");
    expect(refusal(() => validateSowConfidentiality({ dpa: { digest: DIGEST.toUpperCase() } })).section).toBe("5.11");
  });

  it("holds a processor's processed_in inside the clause's, where both are stated", () => {
    const p = (j: string[]) => ({ processed_in: ["us", "ca"], processors: [{ service: "Anthropic API", domain: "anthropic.com", processed_in: j }] });
    expect(() => validateSowConfidentiality(p(["us"]))).not.toThrow();
    expect(refusal(() => validateSowConfidentiality(p(["eu"]))).section).toBe("5.11");
    // A clause that states no jurisdictions has nothing to hold a processor inside.
    expect(() => validateSowConfidentiality({ processors: [{ service: "Anthropic API", processed_in: ["eu"] }] })).not.toThrow();
  });
});
