/**
 * The document as a whole: its identifier (§4.1), its top-level shape (§4.2)
 * and contract-language descriptor (§4.3), and the validation that runs every
 * clause's validator over it. Two kinds of document pass through here: a
 * standing proposal (§12.1), the provider's template with the client seat
 * blank, and an instance, with both seats filled.
 */
import { canonicalJSON, crockford32 } from "./crypto.js";
import { sha256 } from "@common-agent/crypto";
import { invalidIn, isPosInt, isRecord, RFC3339 } from "./shared.js";
import { validateSowPrice, reservationWithinTerm, type SowPrice, type SowTimeAndMaterialsPrice } from "./price.js";
import {
  validateSowApproval,
  validateSowOfferedTo,
  validateSowParty,
  validateSowQualifications,
  validateSowSolicitation,
  isDirectedProposal,
  type SowOfferedTo,
  type SowParty,
} from "./parties.js";
import { validateSowDisputes } from "./disputes.js";
import { validateSowConfidentiality } from "./confidentiality.js";
import { validateSowReporting } from "./reporting.js";
import { validateSowLiability, validateSowServiceFloors } from "./terms.js";
import { validateSowSubcontracting } from "./subcontracting.js";
import { validateSowNda } from "./nda.js";
import { validateBuyerReference, validateProviderContact } from "./contact.js";
import {
  publishedInputBinding,
  validateSowChangeControl,
  validateSowDeliverables,
  validateSowInputs,
  validateSowRevisions,
  validateSowScope,
  validateSowTermination,
  validateSowVolume,
  type SowInput,
} from "./clauses.js";
import { isCanonicalSowSig, isOwnerKeyed, type SowSignature } from "./signing.js";

const invalid: (message: string) => never = invalidIn("4.2");

// ── §4.1 the identifier ─────────────────────────────────────────────────────

export const SOW_ID_RE = /^sow_[0-9a-hjkmnp-tv-z]{16}$/;

/**
 * Mint the identifier of a version-1 document (§4.1): `sow_` and the first 16
 * characters, lowercase Crockford base32, of the SHA-256 of the document's
 * canonical JSON with `id` and `signatures` removed. Those are the hashed
 * bytes, which differ from the signed bytes of §6 (they keep `id`).
 *
 * An identifier is minted once, by the implementation that creates the
 * version-1 document (§4.1.1). Nothing else calls this: storing, amending,
 * rendering, exporting or verifying a document never re-derives its id.
 */
export function mintSowId(doc: object): string {
  const { id: _id, signatures: _sigs, ...rest } = doc as { id?: unknown; signatures?: unknown };
  const digest = sha256(canonicalJSON(rest));
  return "sow_" + crockford32(new Uint8Array(digest), 16);
}

/**
 * The diagnostic §4.1.1 allows: does a version-1 document's identifier
 * re-derive? A minting implementation SHOULD ask it of its own output before
 * signing. It is never a conformance test a reader applies, because a
 * mismatch is just as likely to be a document minted under an earlier reading
 * of §4.1, and it is not a tamper check: the signature is.
 */
export function idRederives(doc: { id?: unknown; version?: unknown }): boolean {
  return doc.version === 1 && typeof doc.id === "string" && doc.id === mintSowId(doc);
}

// ── §4.2 the top-level shape, §4.3 the contract language ────────────────────

/** The contract language a document was written under (§4.3), inside the signed bytes. */
export interface SowLanguage {
  id: string;
  version: number;
  /** The SHA-256 of that version's template text, 64 lowercase hex characters. */
  sha256: string;
}

/** An Agent SoW document. Clause members are typed by their own modules; this is the frame. */
export interface SowDocument {
  sow: "v1";
  id: string;
  version: number;
  starts_at: string | null;
  ends_at: string | null;
  language: SowLanguage;
  parties: { provider: SowParty; client: SowParty | null; offered_to?: SowOfferedTo; grade: "evidence" };
  scope: Record<string, unknown>;
  price: SowPrice;
  signatures?: SowSignature[];
  [member: string]: unknown;
}

/** Whether a document is a standing proposal (§12.1): the provider's template, the client seat blank. */
export function isStandingProposal(doc: unknown): boolean {
  if (!isRecord(doc) || !isRecord(doc.parties)) return false;
  const client = doc.parties.client;
  return client === null || client === undefined;
}

function validateLanguage(v: unknown): void {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id.trim()) {
    invalid("language names the contract language the document was written under, by id, version and sha256, inside the signed bytes (§4.3)");
  }
  if (!isPosInt(v.version)) invalid("language.version is a positive integer: changing any sentence of a language is a new version (§4.3)");
  if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) invalid("language.sha256 is the SHA-256 of that version's template text, 64 lowercase hex characters (§4.3)");
}

function validateSignatures(v: unknown, keyed: boolean): void {
  if (!Array.isArray(v)) invalid("signatures is a list of signature records (§6)");
  const roles = new Set<string>();
  for (const s of v) {
    if (!isRecord(s)) invalid("each signature is an object carrying role, key, signed_at and sig (§6)");
    if (s.role !== "provider" && s.role !== "client") invalid("a signature's role is provider or client: owners sign, not agents (§6)");
    if (roles.has(s.role)) invalid(`the ${s.role} has signed twice; a document carries one signature per role (§6)`);
    roles.add(s.role);
    if (typeof s.key !== "string" || !/^U[A-Z2-7]{55}$/.test(s.key)) invalid("a signature's key is the owner's public key (§6)");
    if (typeof s.signed_at !== "string" || !RFC3339.test(s.signed_at)) invalid("a signature's signed_at is an RFC 3339 instant (§6)");
    if (typeof s.sig !== "string" || !s.sig) invalid("a signature carries sig (§6)");
    // A document written against 0.26.0-draft has one spelling for each
    // signature; an older one may carry another, which a verifier reads as written.
    if (keyed && !isCanonicalSowSig(s.sig)) {
      invalid("sig is the canonical padded base64 of the 64-byte signature: 88 characters, ending ==, the unused bits zero (§6)");
    }
  }
}

/**
 * The seats' owner keys (§5.1): a document whose seats name `owner_key` names
 * it on every filled seat, each a public key in the family's spelling. A
 * document where no seat names one was written against an earlier version.
 */
function validateOwnerKeys(parties: Record<string, unknown>, standing: boolean): void {
  const seats = (standing ? ["provider"] : ["provider", "client"]).map((r) => [r, parties[r] as Record<string, unknown>] as const);
  const named = seats.filter(([, s]) => s && s.owner_key !== undefined);
  if (named.length === 0) return;
  if (named.length !== seats.length) {
    invalid("a document that names owner_key on some seats and not on others is refused: every seat names the key that signs for it (§5.1)");
  }
  for (const [role, seat] of seats) {
    if (typeof seat.owner_key !== "string" || !/^U[A-Z2-7]{55}$/.test(seat.owner_key)) {
      invalid(`parties.${role}.owner_key is the public key of the owner that signs for the seat (§5.1)`);
    }
  }
}

/** Calendar months after an instant, for a template that states its term as `term_months`. */
export function addMonths(instant: string, months: number): string {
  const d = new Date(Date.parse(instant));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Validate a document: the frame of §4.2 and every clause it carries. A
 * standing proposal has its client seat blank and no start, carries no
 * `buyer_reference` (§5.17), and, unless it names its counterparty, publishes
 * requirements and never addresses in its inputs (§5.3.1). An instance has
 * both seats and both instants.
 *
 * Members this core does not know are carried, not refused, so a document a
 * later revision wrote stays readable.
 */
export function validateSowDocument(doc: unknown, opts: { proposal?: boolean } = {}): asserts doc is SowDocument {
  if (!isRecord(doc)) invalid("an Agent SoW document is a JSON object (§4.1)");
  if (doc.sow !== "v1") invalid("sow is 'v1' (§4.2)");
  if (typeof doc.id !== "string" || !doc.id.startsWith("sow_") || doc.id.length > 64) invalid("id is the document's identifier, sow_ and its derivation (§4.1)");
  if (!isPosInt(doc.version)) invalid("version is a positive integer, 1 for the first and one more for each amendment (§4.1, §5.8)");
  validateLanguage(doc.language);

  const standing = isStandingProposal(doc);
  if (!isRecord(doc.parties)) invalid("parties is an object carrying the provider and client seats and grade (§5.1)");
  validateSowParty(doc.parties.provider);
  if (!standing) validateSowParty(doc.parties.client);
  // A completed instance keeps the offered_to its template carried: it is
  // inside the provider's signed bytes, and formation tests the filled seat
  // against it (§12.1.1).
  if (doc.parties.offered_to !== undefined && doc.parties.offered_to !== null) {
    validateSowOfferedTo(doc.parties.offered_to, { occasion: doc.solicitation });
  }
  if (doc.solicitation !== undefined) validateSowSolicitation(doc.solicitation);
  if (doc.parties.grade !== "evidence") invalid("parties are graded 'evidence': the transport verifies identity, and the engagement records who was verified (§5.1)");
  if (!standing && (doc.parties.client as SowParty).agent === (doc.parties.provider as SowParty).agent) {
    invalid("the provider and the client are two different agents (§5.1)");
  }
  validateOwnerKeys(doc.parties, standing);

  // §5.7: the term. A template has no start; an instance has both instants.
  const startsAt = doc.starts_at;
  const endsAt = doc.ends_at;
  if (startsAt !== null && (typeof startsAt !== "string" || !RFC3339.test(startsAt))) invalid("starts_at is an RFC 3339 instant, or null in a standing proposal (§5.7)");
  if (endsAt !== null && endsAt !== undefined && (typeof endsAt !== "string" || !RFC3339.test(endsAt))) invalid("ends_at is an RFC 3339 instant (§5.7)");
  if (doc.term_months !== undefined && !isPosInt(doc.term_months)) invalid("term_months is a positive whole number of months (§5.7)");
  if (standing) {
    if (startsAt !== null) invalid("a standing proposal's starts_at is null: the client sets it when it countersigns (§12.1)");
    if (doc.buyer_reference !== undefined) invalid("a standing proposal carries no buyer_reference, because no client has given one (§5.17)");
    if ((endsAt === null || endsAt === undefined) && doc.term_months === undefined) {
      invalid("a standing proposal states its term: an ends_at, or a term_months the completed instance counts from its start (§5.7)");
    }
  } else {
    if (startsAt === null) invalid("an instance has a starts_at: a countersigned document has no force before it (§5.7)");
    if (typeof endsAt !== "string") invalid("an instance has an ends_at: engagements do not renew themselves, so every one ends (§5.7)");
    if (Date.parse(endsAt) <= Date.parse(startsAt as string)) invalid("ends_at is after starts_at (§5.7)");
    if (typeof doc.term_months === "number" && addMonths(startsAt as string, doc.term_months) !== endsAt) {
      invalid("an instance that keeps term_months ends term_months calendar months after it starts; its ends_at and term_months disagree (§5.7)");
    }
  }

  validateSowScope(doc.scope);
  validateSowPrice(doc.price);
  if (!standing && (doc.price as SowPrice).arrangement === "time_and_materials") {
    if (!reservationWithinTerm((doc.price as SowTimeAndMaterialsPrice).reservation, startsAt as string, endsAt as string)) {
      invalid("the reservation window extends beyond ends_at (§5.5.4)");
    }
  }

  if (doc.inputs !== undefined) {
    validateSowInputs(doc.inputs);
    if (standing && !isDirectedProposal(doc)) {
      const found = publishedInputBinding(doc.inputs as SowInput[]);
      if (found) {
        invalid(`input '${found.input}' carries '${found.member}', a binding: a standing proposal offered to the market publishes requirements, never addresses (§5.3.1)`);
      }
    }
  }
  if (doc.deliverables !== undefined) validateSowDeliverables(doc.deliverables);
  if (doc.revisions !== undefined) validateSowRevisions(doc.revisions);
  if (doc.volume !== undefined) validateSowVolume(doc.volume);
  if (doc.change_control !== undefined) {
    validateSowChangeControl(doc.change_control);
    const approvals = (doc.change_control as unknown as Record<string, unknown>).approvals;
    if (approvals !== undefined) {
      if (!Array.isArray(approvals)) invalid("change_control.approvals is a list of approval records (§6.1)");
      for (const a of approvals) validateSowApproval(a);
    }
  }
  if (opts.proposal) {
    const cc = (doc.change_control ?? {}) as Record<string, unknown>;
    if (typeof cc.proposed_at !== "string") {
      invalid("a proposed replacement carries change_control.proposed_at, the instant it was proposed, inside its signed bytes (§5.8)");
    }
  }
  if (doc.termination !== undefined) validateSowTermination(doc.termination);
  if (doc.disputes !== undefined) validateSowDisputes(doc.disputes);
  if (doc.confidentiality !== undefined) validateSowConfidentiality(doc.confidentiality);
  if (doc.reporting !== undefined) validateSowReporting(doc.reporting);
  if (doc.liability !== undefined) validateSowLiability(doc.liability);
  if (doc.service_floors !== undefined) validateSowServiceFloors(doc.service_floors);
  if (doc.subcontracting !== undefined) validateSowSubcontracting(doc.subcontracting);
  if (doc.qualifications !== undefined) validateSowQualifications(doc.qualifications);
  validateSowNda(doc.nda);
  validateBuyerReference(doc.buyer_reference);
  validateProviderContact(doc.provider_contact);
  if (doc.signatures !== undefined) validateSignatures(doc.signatures, isOwnerKeyed(doc));
  if (doc.derived_from !== undefined && !isRecord(doc.derived_from) && typeof doc.derived_from !== "string") {
    invalid("derived_from records the provenance of inherited clause values (§4.3)");
  }
}
