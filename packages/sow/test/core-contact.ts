// Agent SoW 0.25.0-draft: the buyer's reference (§5.17) and contracted
// contact by the provider (§5.18), asserted against
// conformance/sow-buyer-reference.json and conformance/sow-provider-contact.json.
// Collected like the SDK's suites (collect.ts), so vectors.test.ts runs each
// under the section of the file it reads.
import { expect } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import { collector, type CollectedSuite } from "./collect.js";
import {
  buyerReferenceDiscrepancy,
  buyerReferenceFor,
  interimDeliverableAtDoor,
  providerContactAt,
  providerContactDoor,
  validateBuyerReference,
  validateProviderContact,
  validateSowDocument,
  type SowDocument,
  type SowMessageCarries,
  type SowProviderContact,
} from "../index.js";

const reference = loadPinnedVectors("sow/conformance/sow-buyer-reference.json").data as Record<string, any>;
const contact = loadPinnedVectors("sow/conformance/sow-provider-contact.json").data as Record<string, any>;
const pricing = loadPinnedVectors("sow/conformance/sow-pricing.json").data as Record<string, any>;

/** The fixture's abstract document rows, made concrete from the pricing file's documents. */
function documentFor(row: { document: string; starts_at: string | null; buyer_reference?: string }): SowDocument {
  if (row.document === "standing_proposal") {
    const doc = structuredClone(pricing.directed.signing.document) as SowDocument;
    return { ...doc, ...(row.buyer_reference !== undefined ? { buyer_reference: row.buyer_reference } : {}) };
  }
  const doc = structuredClone(pricing.signing.document) as SowDocument;
  return { ...doc, ...(row.buyer_reference !== undefined ? { buyer_reference: row.buyer_reference } : {}) };
}

const buyer = collector();
{
  // `fixture` is the name collect.ts reads a suite's sections from.
  const fixture = reference;
  const { describe, it } = buyer;
  describe("§5.17 the buyer's reference: its form", () => {
    it("accepts every valid form, and a document without the member", () => {
      for (const row of fixture.form.valid) expect(() => validateBuyerReference(row.buyer_reference)).not.toThrow();
    });
    for (const row of fixture.form.invalid) {
      it(`refuses ${row.case}: ${row.why}`, () => {
        expect(() => validateBuyerReference(row.buyer_reference)).toThrow(/§5\.17/);
      });
    }
  });
  describe("§5.17 a standing proposal carries none; a completed instance may", () => {
    for (const row of fixture.template.valid) {
      it(`${row.document}${row.buyer_reference ? " with a reference" : ""} validates`, () => {
        expect(() => validateSowDocument(documentFor(row))).not.toThrow();
      });
    }
    for (const row of fixture.template.invalid) {
      it(`${row.case} is refused: ${row.why}`, () => {
        expect(() => validateSowDocument(documentFor(row))).toThrow(/§5\.17/);
      });
    }
  });
  describe("§5.17 it travels unchanged, and a discrepancy is recorded without disputing the settlement", () => {
    for (const c of fixture.carriage.cases) {
      it(`carriage: ${c.name}`, () => {
        expect(buyerReferenceFor(c.engagement, c.admitted_under)).toBe(c.expected);
      });
    }
    for (const c of fixture.carriage.discrepancy.cases) {
      it(`discrepancy: ${c.name}`, () => {
        expect(buyerReferenceDiscrepancy(c.expected, c.record)).toEqual({ discrepancy: c.discrepancy, disputed_settlement: c.disputed_settlement });
      });
    }
  });
}

const provider = collector();
{
  const fixture = contact;
  const { describe, it } = provider;
  describe("§5.18 what it names", () => {
    it("accepts every valid member, and a document without one", () => {
      for (const row of fixture.form.valid) expect(() => validateProviderContact(row.provider_contact)).not.toThrow();
    });
    for (const row of fixture.form.invalid) {
      it(`refuses ${row.case}: ${row.why}`, () => {
        expect(() => validateProviderContact(row.provider_contact)).toThrow(/§5\.18/);
      });
    }
  });
  describe("§5.18 its term is the engagement's", () => {
    const member = fixture.form.valid[0].provider_contact as SowProviderContact;
    for (const c of fixture.term.cases) {
      it(c.name, () => {
        const at = providerContactAt(
          member,
          {
            starts_at: fixture.term.starts_at,
            ends_at: fixture.term.ends_at,
            ...(c.terminated_at ? { terminated_at: c.terminated_at } : {}),
            ...(c.cap_reached_at ? { cap_reached_at: c.cap_reached_at } : {}),
            ...(c.amendment_agreed_at ? { amendment: { agreed_at: c.amendment_agreed_at, member: c.amended_member } } : {}),
          },
          c.at,
        );
        expect(at !== null).toBe(c.admitted);
        if (c.grants) expect(at?.grants).toEqual(c.grants);
      });
    }
  });
  describe("§5.18 how the client's door enforces it", () => {
    const door = (m: SowProviderContact, cases: Array<Record<string, any>>, label: string) => {
      for (const c of cases) {
        it(`${label}${c.name}`, () => {
          const got = providerContactDoor(m, {
            from: c.from,
            to: c.to,
            carries: c.carries as SowMessageCarries,
            ...(c.sent_this_hour !== undefined ? { sent_this_hour: c.sent_this_hour } : {}),
            ...(c.client_roster ? { client_roster: c.client_roster } : {}),
            ...(c.stop_control ? { stop_control: c.stop_control } : {}),
          });
          expect(got.outcome).toBe(c.expected);
          if (c.missing_grant) expect(got).toMatchObject({ missing_grant: c.missing_grant });
        });
      }
    };
    door(fixture.door.member, fixture.door.cases, "");
    door(fixture.door.only_share.member, fixture.door.only_share.cases, "share only: ");
  });
  describe("§5.18 an interim deliverable held at the client's door is not a miss", () => {
    for (const c of fixture.interim_deliverables.cases) {
      it(c.name, () => {
        const got = interimDeliverableAtDoor({ sent_at: c.sent_at, due: c.due, door: c.door });
        expect(got.missed_due_instant).toBe(c.missed_due_instant);
        if (c.recorded_as) expect(got.recorded_as).toBe(c.recorded_as);
      });
    }
  });
}

export const buyerReferenceSuites: CollectedSuite[] = buyer.suites;
export const providerContactSuites: CollectedSuite[] = provider.suites;
