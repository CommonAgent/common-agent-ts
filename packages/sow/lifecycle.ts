/**
 * The engagement's lifecycle as pure functions: formation from a standing
 * proposal (§12.1, §12.1.1), the state an engagement is in at an instant
 * (§7.1, §5.7), amendment and its four resolutions (§5.8), termination
 * (§5.9), and reaching the cap (§5.5.5). Nothing here stores, sends or moves
 * money; a platform module holds the record and calls these to decide.
 *
 * A broken rule is a SowRefusal: `invalid` for a document that is malformed,
 * `refused` for an act the rules do not allow in the engagement's state.
 */
import { canonicalJSON, type Signer } from "./crypto.js";
import { isRecord, refused, SowRefusal } from "./shared.js";
import { addMonths, isStandingProposal, validateSowDocument, type SowDocument } from "./document.js";
import {
  bindingHolds,
  canonicalSowJSON,
  isOwnerKeyed,
  ownerConfirmation,
  seatOwnerKey,
  signSow,
  sowAgreed,
  verifySowSignature,
  type OwnerConfirmation,
  type SowSignature,
} from "./signing.js";
import type { OwnerResolver } from "./ports.js";
import {
  checkFormationMessage,
  formationDigest,
  type SowAcknowledgement,
  type SowFormationReceipt,
  type SowFormationSubject,
  type SowFormationVoid,
  type SowUnsignedFormationMessage,
} from "./formation.js";
import {
  DEFAULT_AMENDMENT_AUTHORITY,
  DEFAULT_FORMATION_AUTHORITY,
  directedOfferRefusal,
  qualificationRefusal,
  type ApprovalAuthority,
  type SowParty,
  type SowQualificationFacts,
} from "./parties.js";
import { validateBuyerReference } from "./contact.js";
import { ndaDisclosureFits, ndaPartiesMatch, type NdaPermits, type NdaSeats } from "./nda.js";
import type { SowTimeAndMaterialsPrice } from "./price.js";

type Role = "provider" | "client";
const other = (r: Role): Role => (r === "provider" ? "client" : "provider");

function signaturesOf(doc: { signatures?: SowSignature[] }): SowSignature[] {
  return doc.signatures ?? [];
}

function approvalAuthority(doc: SowDocument, act: "formation" | "amendment"): ApprovalAuthority {
  const cc = isRecord(doc.change_control) ? doc.change_control : {};
  const a = isRecord(cc.approval) ? cc.approval[act] : undefined;
  return (typeof a === "string" ? a : act === "formation" ? DEFAULT_FORMATION_AUTHORITY : DEFAULT_AMENDMENT_AUTHORITY) as ApprovalAuthority;
}

// ── §12.1 formation ─────────────────────────────────────────────────────────

/**
 * The completed instance a client countersigns (§12.1): the standing
 * proposal's bytes with the client seat filled, `starts_at` set, the end
 * counted from the start where the template states its term in months, and
 * the client's `buyer_reference` where it gives one (§5.17). Every other
 * member is the template's, unchanged, and the template's signature is not
 * carried: it covered the template, not this.
 */
export function completedInstance(
  standing: SowDocument,
  fill: { client: SowParty; starts_at: string; buyer_reference?: string },
): SowDocument {
  validateBuyerReference(fill.buyer_reference);
  const { signatures: _template, ...rest } = structuredClone(standing);
  const endsAt = rest.ends_at ?? (typeof rest.term_months === "number" ? addMonths(fill.starts_at, rest.term_months) : null);
  return {
    ...rest,
    parties: { ...rest.parties, client: fill.client },
    starts_at: fill.starts_at,
    ends_at: endsAt,
    ...(fill.buyer_reference !== undefined ? { buyer_reference: fill.buyer_reference } : {}),
  };
}

/** The members an instance may differ from its template in (§12.1). */
function asTemplate(doc: SowDocument): unknown {
  const { signatures: _s, buyer_reference: _b, starts_at: _st, ends_at: _e, ...rest } = doc;
  return { ...rest, parties: { ...rest.parties, client: null } };
}

/**
 * Whether an instance was made from a standing proposal: the same bytes, but
 * for the client seat, the start, the buyer's reference, and the signatures.
 * The end is the template's where it states one; where it leaves the end to
 * be counted, it is the start plus `term_months` calendar months, the same
 * day and time in UTC or the month's last day (§5.7), and nothing else.
 */
export function instanceOf(standing: SowDocument, instance: SowDocument): boolean {
  if (standing.ends_at !== null && standing.ends_at !== undefined) {
    if (standing.ends_at !== instance.ends_at) return false;
  } else {
    if (typeof standing.term_months !== "number" || typeof instance.starts_at !== "string") return false;
    if (instance.ends_at !== addMonths(instance.starts_at, standing.term_months)) return false;
  }
  return canonicalJSON(asTemplate(standing)) === canonicalJSON(asTemplate(instance));
}

/** What a runtime holding the referenced NDA's bytes knows of it (§5.16): its seats, and the provider's disclosure terms (null where the provider is a one-way discloser). */
export interface HeldNda {
  seats: NdaSeats;
  providerTerms: NdaPermits | null;
}

export interface FormationContext {
  now: string;
  /** The qualification ids the client asserted with its countersign (§12.1). */
  asserted?: readonly string[];
  facts?: SowQualificationFacts;
  /** A directed proposal is spent by the formation it completes (§12.1.1): true when one already formed under it. */
  directedAlreadyFormed?: boolean;
  /** The referenced NDA, where this runtime holds bytes that hash to the member's digest. */
  nda?: HeldNda;
  /** The client account's human confirmed, where formation needs a person (§6.1). */
  personConfirmed?: boolean;
  /**
   * What the registry said of the client seat's `owner_key` at receipt (§6,
   * binding; seatOwners resolves it). Formation rides on the binding, so on a
   * document whose seats name their keys it completes only for `confirmed`.
   */
  clientOwner?: OwnerConfirmation;
}

/** Formation's answer: complete it now, or wait for the client account's human (§6.1). A refusal is thrown. */
export type FormationReadiness = { ready: true } | { ready: false; waiting: "person" };

/**
 * The provider runtime's formation gate (§12.1): run on a client's request
 * to form. Formation always rides on the binding (§5.1, §6): the template's
 * provider seat and the instance's client seat both name their `owner_key`,
 * the template carries the provider's signature made with its key, and the
 * registry confirms the client's owner. A document written before
 * 0.26.0-draft names no keys; it can be held and read as a record that is
 * already agreed, and nothing new forms from it. The gate also refuses, with
 * a typed refusal naming what failed, an instance that was not made from the
 * proposal, a client signature that does not count, a counterparty a
 * directed offer does not name or an offer past its lapse, a counterparty
 * that does not meet a stated qualification, and an engagement that fails
 * the NDA tests where the NDA is held. Where formation needs a person, it
 * waits for the confirmation.
 */
export function checkFormation(standing: SowDocument, instance: SowDocument, ctx: FormationContext): FormationReadiness {
  if (!isStandingProposal(standing)) refused("formation completes a standing proposal, whose client seat is blank (§12.1)");
  validateSowDocument(standing);
  validateSowDocument(instance);
  if (isStandingProposal(instance)) refused("the request to form fills the client seat (§12.1)");
  if (seatOwnerKey(standing, "provider") === null) {
    refused("the standing proposal's provider seat names no owner_key; a document written before 0.26.0-draft is a record, and nothing new forms from it (§5.1, §6)");
  }
  if (seatOwnerKey(instance, "client") === null) {
    refused("the request to form names no owner_key on the client seat; the client writes its own key into the seat it fills (§5.1, §12.1)");
  }
  const templateSig = signaturesOf(standing).find((s) => s.role === "provider");
  if (!templateSig || !verifySowSignature(standing, templateSig)) {
    refused("the standing proposal carries no provider signature made with the provider seat's owner_key; the offer is not authenticated (§6, §12.1)");
  }
  if (!instanceOf(standing, instance)) {
    refused("the instance differs from the standing proposal in more than the client seat, the start and the buyer's reference (§12.1)");
  }
  const clientSig = signaturesOf(instance).find((s) => s.role === "client");
  if (!clientSig) refused("a request to form carries the client's signature over the completed instance (§12.1)");
  if (!verifySowSignature(instance, clientSig)) refused("the client's signature does not verify over the completed instance (§6)");
  if (signaturesOf(instance).some((s) => s.role === "provider")) {
    refused("the request carries a provider signature; formation ends with a fresh one, made over these bytes by the provider's runtime (§6, §12.1)");
  }
  if (!bindingHolds(ctx.clientOwner ?? "unconfirmed")) {
    refused(
      `the client seat's owner_key is ${ctx.clientOwner ?? "unconfirmed"} by the registry; formation rides on the binding, so it completes only for an owner the registry confirms (§6)`,
    );
  }
  const clientAgent = (instance.parties.client as SowParty).agent;
  const now = Date.parse(ctx.now);
  const directed = directedOfferRefusal(standing, clientAgent, now);
  if (directed !== null) refused(`${directed} (§12.1.1)`);
  if (instance.parties.offered_to && ctx.directedAlreadyFormed) refused("this directed proposal was spent by the formation it already completed (§12.1.1)");
  const unmet = qualificationRefusal(standing, clientAgent, ctx.asserted, ctx.facts);
  if (unmet !== null) refused(`${unmet} (§12.1)`);
  if (ctx.nda && instance.nda !== undefined) checkHeldNda(instance, ctx.nda);
  const authority = approvalAuthority(standing, "formation");
  if (authority !== "agent" && !ctx.personConfirmed) return { ready: false, waiting: "person" };
  return { ready: true };
}

/**
 * Resolve each filled seat's owner through the registry and say whether it
 * confirms the seat's `owner_key` (§6, binding). The party that receives a
 * document runs this at receipt and records the answer.
 */
export async function seatOwners(doc: SowDocument, registry: OwnerResolver): Promise<Partial<Record<Role, OwnerConfirmation>>> {
  const out: Partial<Record<Role, OwnerConfirmation>> = {};
  for (const role of ["provider", "client"] as const) {
    const seat = doc.parties[role];
    if (!seat) continue;
    let resolved: { owner: string; attested: boolean } | null = null;
    try {
      resolved = await registry.ownerOf(seat.agent);
    } catch {
      resolved = null;
    }
    out[role] = ownerConfirmation(doc, role, resolved);
  }
  return out;
}

/** The §5.16 tests against an NDA whose bytes the runtime holds. The refusal names the test that failed. */
export function checkHeldNda(doc: SowDocument, nda: HeldNda): void {
  const agents = { provider: doc.parties.provider.agent, client: (doc.parties.client as SowParty).agent };
  if (!ndaPartiesMatch(agents, nda.seats)) refused("the parties test fails: the NDA's seats do not hold the engagement's two agent keys (§5.16)");
  if (nda.providerTerms === null) return;
  const fit = ndaDisclosureFits(nda.providerTerms, isRecord(doc.confidentiality) ? doc.confidentiality : undefined);
  if (!fit.ok) {
    refused(
      `the disclosure test fails on ${fit.test}${fit.entry !== undefined ? ` at entry ${fit.entry}` : ""}: the engagement declares more than the NDA permits the provider (§5.16)`,
    );
  }
}

/**
 * The provider completes formation with a fresh signature over the completed
 * instance (§6, §12.1). Only the fully signed instance is agreed.
 */
export function completeFormation(instance: SowDocument, provider: Signer, signedAt?: string): SowDocument {
  const signed = signSow(instance, provider, "provider", signedAt);
  if (!sowAgreed(signed)) refused("the completed instance is not agreed: both signatures must verify over the same bytes (§6)");
  return signed;
}

// ── §7.1 states, §5.7 the term ──────────────────────────────────────────────

/** What a runtime holds about an engagement: its agreed versions, any open proposal, and how it ended. */
export interface SowEngagementRecord {
  /** The agreed versions, oldest first. The last governs. */
  agreed: SowDocument[];
  proposal?: SowOpenProposal;
  /** When a termination took effect (§5.9). */
  terminated_at?: string;
  /** When the cap was reached (§5.5.5). */
  exhausted_at?: string;
  /**
   * On the proposer's side, after it received an approval (§5.8): the
   * acknowledgement it owes the counterparty (`to`), which applies the new
   * version only once it holds one. While set, the version formed here and
   * is not yet applied there: "formed, unacknowledged".
   */
  acknowledgement_due?: SowApprovalAcknowledgement & { to: Role; digest: string };
  /**
   * On the proposer's side, after it voided a formation (§5.8,
   * 0.28.0-draft): the voided version, the digest and deadline the void
   * names, the counterparty the void goes to, and whether it holds the
   * counterparty's receipt of the void. It re-sends the void daily until it
   * does, and answers any request that names the voided version with the void.
   */
  voided?: { version: number; digest: string; deadline: string; to: Role; receipted: boolean };
  /**
   * On the counterparty's side, after it applied an acknowledgement that the
   * version formed (§5.8): the version, the approved replacement's digest,
   * the acknowledgement's deadline, and the proposer whose void alone can
   * undo it, with the key it signs with.
   */
  applied_formation?: { version: number; digest: string; deadline: string; by: Role; key: string };
  /** On the counterparty's side, after it applied a void: what it voided, so it answers every later copy with a receipt. */
  voided_formation?: { version: number; digest: string; deadline: string; by: Role; key: string };
}

/**
 * Where an amendment stands on this side (§5.8): none; a proposal open; on
 * the counterparty's side, a proposal it approved whose acknowledgement it
 * does not hold yet; on the proposer's side, a version formed here whose
 * acknowledgement the counterparty does not hold yet, or a void it holds no
 * receipt of.
 */
export type SowAmendmentState = "none" | "proposed" | "approved_awaiting_acknowledgement" | "formed_unacknowledged" | "voided_unreceipted";

export function amendmentState(record: SowEngagementRecord): SowAmendmentState {
  if (record.proposal?.approval) return "approved_awaiting_acknowledgement";
  if (record.proposal) return "proposed";
  if (record.acknowledgement_due?.formed) return "formed_unacknowledged";
  if (record.voided && !record.voided.receipted) return "voided_unreceipted";
  return "none";
}

/**
 * The version this side applies to its own new acts (§5.8): while it is
 * formed, unacknowledged, the version before the one that formed; otherwise
 * the governing one.
 */
export function versionForOwnActs(record: SowEngagementRecord): SowDocument {
  if (amendmentState(record) === "formed_unacknowledged" && record.agreed.length > 1) return record.agreed[record.agreed.length - 2]!;
  return governingVersion(record);
}

/**
 * The version a request is admitted and priced under (§5.8): the one it
 * names, while this side is formed, unacknowledged and it names the current
 * or the new version; otherwise the governing one.
 */
export function versionForRequest(record: SowEngagementRecord, namesVersion: number): SowDocument {
  if (amendmentState(record) === "formed_unacknowledged") {
    const named = record.agreed.slice(-2).find((d) => d.version === namesVersion);
    if (named) return named;
    return versionForOwnActs(record);
  }
  return governingVersion(record);
}

/** The proposer's answer to a request: admit it under a version, or answer it with a copy of the void. */
export type SowRequestDecision = { admitted: true; version: SowDocument } | { admitted: false; answered_with: "void"; version: number };

/**
 * How the proposer answers a request that names `namesVersion` (§5.8,
 * 0.28.0-draft): a request that names a version it voided is answered with a
 * copy of the void and admitted under nothing, so the counterparty learns of
 * the void at the latest when it next sends work under it. Any other request
 * is admitted under `versionForRequest`.
 */
export function answerRequest(record: SowEngagementRecord, namesVersion: number): SowRequestDecision {
  if (record.voided && record.voided.version === namesVersion) return { admitted: false, answered_with: "void", version: namesVersion };
  return { admitted: true, version: versionForRequest(record, namesVersion) };
}

/** What a message about one approval must name, and the one seat and key that may send it. */
function subjectOf(engagement: string, held: { version: number; digest: string }, proposer: Role, sender: Role, key: string): SowFormationSubject {
  return { engagement, version: held.version, digest: held.digest, proposer, keys: { [sender]: key } };
}

/** The acknowledgement the proposer owes, unsigned: sign it with signFormationMessage as the proposer, and send it at least daily until a receipt. */
export function acknowledgementFor(record: SowEngagementRecord): SowUnsignedFormationMessage<SowAcknowledgement> {
  const due = record.acknowledgement_due;
  if (!due) refused("this side owes no acknowledgement (§5.8)");
  const { version, digest, formed, deadline } = due;
  return { kind: "acknowledgement", engagement: governingVersion(record).id, version, digest, formed, ...(formed && deadline !== null ? { deadline } : {}) };
}

/** The void the proposer sends, unsigned: sign it as the proposer, and re-send it at least daily until a receipt of it (0.28.0-draft). */
export function voidFor(record: SowEngagementRecord): SowUnsignedFormationMessage<SowFormationVoid> {
  const voided = record.voided;
  if (!voided) refused("this side voided no formation (§5.8)");
  return { kind: "void", engagement: governingVersion(record).id, version: voided.version, digest: voided.digest, deadline: voided.deadline };
}

/** The receipt the counterparty sends of an acknowledgement or a void it holds, unsigned: sign it as this side's role. */
export function receiptFor(record: SowEngagementRecord, of: "acknowledgement" | "void"): SowUnsignedFormationMessage<SowFormationReceipt> {
  const held = of === "acknowledgement" ? record.applied_formation : record.voided_formation;
  if (!held) refused(`this side holds no ${of} to receipt (§5.8)`);
  return { kind: "receipt", of, engagement: governingVersion(record).id, version: held.version, digest: held.digest };
}

/**
 * The proposer receives the counterparty's signed receipt (§5.8). Of an
 * acknowledgement: the new version is in force on both sides, if it came
 * before the deadline. Of a void (0.28.0-draft): the proposer stops
 * re-sending the void, and still answers requests that name the voided
 * version with it. The receipt names the approval's version and digest and
 * comes from the counterparty's seat, signed with its key.
 */
export function receiptReceived(record: SowEngagementRecord, receipt: SowFormationReceipt, at: string): SowEngagementRecord {
  const current = governingVersion(record);
  const ofVoid = (receipt as { of?: unknown } | null)?.of === "void";
  const held = ofVoid ? record.voided : record.acknowledgement_due;
  if (!held) refused(`there is no ${ofVoid ? "void" : "acknowledgement"} awaiting a receipt (§5.8)`);
  checkFormationMessage(receipt, subjectOf(current.id, held, other(held.to), held.to, roleKey(record, held.to)));
  if (receipt.kind !== "receipt") refused(`a ${receipt.kind} is not a receipt (§5.8)`);
  if (ofVoid) return { ...record, voided: { ...record.voided!, receipted: true } };
  const due = record.acknowledgement_due!;
  if (!due.formed) refused(`the acknowledgement of version ${due.version} said nothing formed, so there is nothing to receipt (§5.8)`);
  if (due.deadline !== null && Date.parse(at) >= Date.parse(due.deadline)) {
    refused(`the receipt came at ${at}, at or after the acknowledgement's deadline ${due.deadline}; the formation is void (§5.8)`);
  }
  const { acknowledgement_due: _settled, ...rest } = record;
  return rest;
}

/**
 * The proposer voids a formation it holds no receipt for when the deadline
 * passes (§5.8): the version that formed is undone here, and the void goes
 * to the counterparty (`voidFor`), again daily until it holds a receipt of
 * it. Work admitted under it before then stays priced under it, which is the
 * work's own record, not this one's.
 */
export function voidFormation(record: SowEngagementRecord, now: string): SowEngagementRecord {
  const due = record.acknowledgement_due;
  if (!due?.formed || due.deadline === null) refused("there is no formation awaiting a receipt to void (§5.8)");
  if (Date.parse(now) < Date.parse(due.deadline)) refused(`the acknowledgement's deadline is ${due.deadline}; a receipt may still come (§5.8)`);
  const { acknowledgement_due: _voided, ...rest } = record;
  const voided = { version: due.version, digest: due.digest, deadline: due.deadline, to: due.to, receipted: false };
  return { ...rest, agreed: record.agreed.filter((d) => d.version !== due.version), voided };
}

/** What the counterparty does with a void: it undid the version, or it had already; either way it sends a receipt of the void. */
export interface SowVoidResult {
  record: SowEngagementRecord;
  outcome: "voided" | "already_voided";
  receipt_due: true;
}

/**
 * The counterparty receives the proposer's signed void, or a copy of it
 * answering a request (§5.8): from that instant it applies the current
 * version again, and it sends a receipt of every copy (0.28.0-draft). Only
 * the formation it applied can be voided, only by the proposer's key, and
 * only once that acknowledgement's deadline has passed.
 */
export function applyVoid(record: SowEngagementRecord, notice: SowFormationVoid, receivedAt: string): SowVoidResult {
  const current = governingVersion(record);
  const named = (notice as { version?: unknown } | null)?.version;
  const done = record.voided_formation;
  if (done && named === done.version) {
    checkFormationMessage(notice, subjectOf(current.id, done, done.by, done.by, done.key));
    if (notice.kind !== "void") refused(`a ${notice.kind} is not a void (§5.8)`);
    return { record, outcome: "already_voided", receipt_due: true };
  }
  const applied = record.applied_formation;
  if (!applied || named !== applied.version) refused(`version ${String(named)} is not a formation this side applied, so there is nothing to void (§5.8)`);
  if (current.version !== applied.version) refused(`version ${applied.version} no longer governs here, so a void of it undoes nothing (§5.8)`);
  checkFormationMessage(notice, subjectOf(current.id, applied, applied.by, applied.by, applied.key));
  if (notice.kind !== "void") refused(`a ${notice.kind} is not a void (§5.8)`);
  if (notice.deadline !== applied.deadline) {
    refused(`the void names the deadline ${notice.deadline}, and the acknowledgement this side applied names ${applied.deadline} (§5.8)`);
  }
  if (Date.parse(receivedAt) < Date.parse(applied.deadline)) {
    refused(`the void came at ${receivedAt}, before the acknowledgement's deadline ${applied.deadline}; a proposer voids only a formation it holds no receipt for at the deadline (§5.8)`);
  }
  const { applied_formation: _undone, ...rest } = record;
  return {
    record: { ...rest, agreed: record.agreed.slice(0, -1), voided_formation: { ...applied } },
    outcome: "voided",
    receipt_due: true,
  };
}

/** The engagement's state at an instant (§7.1). An open amendment proposal does not change it: the agreed version governs while it is open (§5.8). */
export type SowEngagementState = "agreed" | "active" | "exhausted" | "lapsed" | "terminated";

/**
 * The key a role signs with on the engagement, which a proposal's and an
 * approval's signatures must be made with: the seat's `owner_key` where the
 * governing version names one (0.26.0-draft), and otherwise the key that
 * signed for that role on the governing version.
 */
export function roleKey(record: SowEngagementRecord, role: Role): string {
  const gov = governingVersion(record);
  const owner = seatOwnerKey(gov, role);
  if (owner !== null) return owner;
  const signed = signaturesOf(gov).find((s) => s.role === role);
  if (!signed) refused(`the governing version carries no ${role} signature to bind the ${role}'s key to (§6)`);
  return signed.key;
}

export function governingVersion(record: SowEngagementRecord): SowDocument {
  const doc = record.agreed[record.agreed.length - 1];
  if (!doc) refused("an engagement has at least one agreed version (§7.1)");
  return doc;
}

/**
 * The state at `now`. Termination and exhaustion end it from the instant they
 * took effect; past `ends_at` it has lapsed; before `starts_at` it is agreed
 * and has no force.
 */
export function engagementState(record: SowEngagementRecord, now: string): SowEngagementState {
  const doc = governingVersion(record);
  const t = Date.parse(now);
  const ends: Array<[number, SowEngagementState]> = [];
  if (record.terminated_at !== undefined) ends.push([Date.parse(record.terminated_at), "terminated"]);
  if (record.exhausted_at !== undefined) ends.push([Date.parse(record.exhausted_at), "exhausted"]);
  ends.push([Date.parse(doc.ends_at as string), "lapsed"]);
  const ended = ends.filter(([at, s]) => (s === "lapsed" ? t > at : t >= at)).sort((a, b) => a[0] - b[0])[0];
  if (ended) return ended[1];
  if (t < Date.parse(doc.starts_at as string)) return "agreed";
  return "active";
}

/**
 * The admission gate (§7.1, §5.5.5, §5.7): only an active engagement admits
 * work, and lapse, exhaustion and termination give the same answer, so the
 * counterparty falls back to general admission policy.
 */
export function checkAdmission(record: SowEngagementRecord, now: string): void {
  const state = engagementState(record, now);
  if (state === "active") return;
  if (state === "agreed") refused("the engagement has not started: a countersigned document has no force before starts_at (§5.7)");
  if (state === "exhausted") refused("the engagement reached its not-to-exceed cap; no further work is admitted under it (§5.5.5)");
  refused(`the engagement has ${state === "lapsed" ? "lapsed" : "been terminated"}; the counterparty reverts to general admission policy (§7.1)`);
}

/**
 * The document state of one document in an engagement's history (§7.1):
 * an unsigned template, a standing proposal, the governing agreed version
 * (agreed or active, or how the engagement ended), an amendment proposal, or
 * a version an amendment replaced.
 */
export function documentState(
  doc: SowDocument,
  record?: SowEngagementRecord,
  now?: string,
): "template" | "standing_proposal" | "amendment_proposed" | "amended" | SowEngagementState {
  const sigs = signaturesOf(doc);
  if (!sigs.length) return "template";
  if (isStandingProposal(doc)) return sigs.some((s) => s.role === "provider") ? "standing_proposal" : "template";
  if (record?.proposal && record.proposal.document.version === doc.version) return "amendment_proposed";
  if (!sowAgreed(doc)) return "template";
  if (record) {
    const gov = governingVersion(record);
    if (doc.version < gov.version) return "amended";
    return engagementState(record, now ?? new Date().toISOString());
  }
  return now !== undefined && Date.parse(now) >= Date.parse(doc.starts_at as string) ? "active" : "agreed";
}

// ── §5.8 change control ─────────────────────────────────────────────────────

/**
 * An open amendment proposal: the full replacement, one signature, who
 * proposed it, and when the counterparty received it. When it was proposed
 * is `change_control.proposed_at`, inside the replacement's signed bytes.
 */
export interface SowOpenProposal {
  document: SowDocument;
  by: Role;
  received_at: string;
  /** On the counterparty's side, once it approved: its approval, kept until the acknowledgement (approveProposal). */
  approval?: { signature: SowSignature; sent_at: string };
}

/** The review window where the clause states none (§5.8). */
export const DEFAULT_REVIEW_WINDOW_DAYS = 7;

/** `change_control.proposed_at` of a proposed replacement, or null where it carries none. */
export function proposedAt(doc: SowDocument): string | null {
  const cc = isRecord(doc.change_control) ? doc.change_control : {};
  return typeof cc.proposed_at === "string" ? cc.proposed_at : null;
}

/**
 * Check a proposed amendment (§5.8) against the agreed version it would
 * replace, as the counterparty does on receiving it: a full replacement one
 * version higher, the same identifier, parties and start, dated by its signed
 * `change_control.proposed_at` no later than the instant it was received,
 * carrying exactly one signature, the proposer's, made with that role's key
 * over its bytes. At most one proposal is open at a time. A provider may not
 * add, change or remove the client's buyer reference (§5.17). A proposal that
 * adds `owner_key` to the seats of an engagement written before 0.26.0-draft
 * binds them only where the registry confirms both seats' owners at receipt
 * (`owners`, from seatOwners on the proposed document).
 */
export function checkAmendmentProposal(
  record: SowEngagementRecord,
  proposed: SowDocument,
  by: Role,
  receivedAt: string,
  owners: Partial<Record<Role, OwnerConfirmation>> = {},
): void {
  if (record.proposal) refused("an amendment proposal is already open on this engagement; at most one may be (§5.8)");
  const current = governingVersion(record);
  validateSowDocument(proposed, { proposal: true });
  const dated = proposedAt(proposed) as string;
  if (Date.parse(dated) > Date.parse(receivedAt)) {
    refused(`the proposal is dated ${dated}, later than it was received at ${receivedAt}; a forward-dated proposal would hold the one open slot past its window (§5.8)`);
  }
  if (proposed.id !== current.id) refused("an amendment keeps the engagement's identifier (§4.1)");
  if (proposed.version !== current.version + 1) refused(`an amendment is version ${current.version + 1}, one over the highest agreed version (§5.8)`);
  if (canonicalJSON(proposed.parties) !== canonicalJSON(current.parties)) {
    if (!addsOwnerKeys(current, proposed)) {
      refused("the parties are fixed; an amendment changes everything else, except that it may add owner_key to every seat of an engagement written before 0.26.0-draft (§5.8, §6)");
    }
    for (const role of ["provider", "client"] as const) {
      const said = owners[role] ?? "unconfirmed";
      if (!bindingHolds(said)) {
        refused(`the amendment binds the ${role} seat to its owner_key, and the registry has it ${said}; an upgrade binds the seats only where the registry confirms both owners at receipt (§6)`);
      }
    }
  }
  if (proposed.starts_at !== current.starts_at) refused("the original starts_at is fixed (§5.8)");
  if (by === "provider" && (proposed.buyer_reference ?? null) !== (current.buyer_reference ?? null)) {
    refused("a provider does not propose an amendment that adds, changes or removes the client's buyer_reference (§5.17)");
  }
  const sigs = signaturesOf(proposed);
  if (sigs.length !== 1 || sigs[0]!.role !== by) refused("a proposed amendment carries one signature, the proposing seat's (§5.8)");
  if (sigs[0]!.key !== roleKey(record, by)) {
    refused(`the proposal is signed with a key that is not the ${by}'s on the agreed engagement; a signature counts for a seat only when made with that seat's key (§6)`);
  }
  if (!verifySowSignature(proposed, sigs[0]!)) refused("the proposer's signature does not verify over the replacement's bytes (§6)");
}

/**
 * Whether a proposal only adds `owner_key` to every seat of an engagement
 * written before 0.26.0-draft (§6, "documents written before this rule"):
 * the governing version names no key, the proposal names one on each seat,
 * each the key that signed for that role on the governing version, and the
 * seats are otherwise unchanged. That amendment binds the seats.
 */
export function addsOwnerKeys(current: SowDocument, proposed: SowDocument): boolean {
  if (isOwnerKeyed(current)) return false;
  for (const role of ["provider", "client"] as const) {
    const key = seatOwnerKey(proposed, role);
    const signedWith = signaturesOf(current).find((s) => s.role === role)?.key;
    if (key === null || key !== signedWith) return false;
  }
  const strip = (doc: SowDocument) => {
    const p = structuredClone(doc.parties) as unknown as Record<string, Record<string, unknown> | null | string>;
    for (const role of ["provider", "client"]) delete (p[role] as Record<string, unknown>).owner_key;
    return canonicalJSON(p);
  };
  return strip(current) === strip(proposed);
}

/**
 * When a proposal lapses (§5.8): its signed `proposed_at` plus the review
 * window, in days of 86,400 seconds, 7 where the clause states none. Both
 * parties read it from the same bytes.
 */
export function amendmentLapsesAt(changeControl: { proposed_at: string; review_window_days?: number }): string {
  const days = changeControl.review_window_days ?? DEFAULT_REVIEW_WINDOW_DAYS;
  return new Date(Date.parse(changeControl.proposed_at) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function statedWindow(doc: SowDocument): number | undefined {
  const cc = (isRecord(doc.change_control) ? doc.change_control : {}) as { review_window_days?: unknown };
  return typeof cc.review_window_days === "number" ? cc.review_window_days : undefined;
}

/**
 * The review window an open proposal runs under (§5.8): the governing
 * version's, 7 days where it states none. The proposal may shorten it for
 * itself, and never lengthen it: a window the proposal states for the next
 * version governs from that version on, not while this one is open.
 */
export function reviewWindowDays(governing: SowDocument, proposal: SowDocument): number {
  const governs = statedWindow(governing) ?? DEFAULT_REVIEW_WINDOW_DAYS;
  const asked = statedWindow(proposal);
  return asked !== undefined ? Math.min(asked, governs) : governs;
}

/** The lapse instant of an open proposal under the governing version's window. */
export function proposalLapsesAt(governing: SowDocument, proposal: SowDocument): string {
  return amendmentLapsesAt({ proposed_at: proposedAt(proposal) as string, review_window_days: reviewWindowDays(governing, proposal) });
}

/** What becomes of a proposal (§5.8): a new version forms, it lapses, or the counterparty refused it on receipt. */
export type SowAmendmentOutcome = "forms" | "lapsed" | "refused";

/**
 * The outcome of a proposal from its instants (§5.8). The counterparty
 * refuses one dated later than it received it. Otherwise a new version forms
 * when the proposer receives the approval before the lapse instant, or
 * accepts one it receives at or after it; an approval that never comes, or
 * comes late and is not accepted, leaves the proposal lapsed.
 */
export function amendmentOutcome(c: {
  change_control: { proposed_at: string; review_window_days?: number };
  /** The governing version's review_window_days; 7 where it states none. */
  governing_window_days?: number;
  received_by_counterparty: string;
  approval_received_by_proposer: string | null;
  proposer_accepts_late?: boolean;
}): { lapses_at: string; outcome: SowAmendmentOutcome } {
  const governs = c.governing_window_days ?? DEFAULT_REVIEW_WINDOW_DAYS;
  const asked = c.change_control.review_window_days;
  const lapses_at = amendmentLapsesAt({ proposed_at: c.change_control.proposed_at, review_window_days: asked !== undefined ? Math.min(asked, governs) : governs });
  if (Date.parse(c.change_control.proposed_at) > Date.parse(c.received_by_counterparty)) return { lapses_at, outcome: "refused" };
  if (c.approval_received_by_proposer === null) return { lapses_at, outcome: "lapsed" };
  if (Date.parse(c.approval_received_by_proposer) < Date.parse(lapses_at) || c.proposer_accepts_late) return { lapses_at, outcome: "forms" };
  return { lapses_at, outcome: "lapsed" };
}

/**
 * How an open proposal resolves (§5.8). An approval is resolved on the
 * proposer's side, where the new version forms: `received_at` is when the
 * proposer received it, and `accept_late` is the proposer accepting one that
 * came at or after the lapse instant. The proposer acknowledges every
 * approval, and the counterparty applies the new version only once it holds
 * an acknowledgement that it formed (`applyAcknowledgement`).
 */
export type SowAmendmentResolution =
  | { kind: "approve"; signature: SowSignature; received_at: string; accept_late?: boolean; personConfirmed?: boolean }
  | { kind: "deny"; by: Role; reason: string }
  | { kind: "withdraw"; by: Role }
  | { kind: "lapse"; now: string };

/**
 * The counterparty approves the proposal it holds open (§5.8): its
 * countersign of the proposed bytes, made with its role's key. It keeps the
 * approved proposal, approved and awaiting the acknowledgement, so that an
 * acknowledgement arriving after the lapse instant still finds it
 * (`approvalHeldUntil`). Until the acknowledgement comes the current version
 * governs here.
 */
export function approveProposal(record: SowEngagementRecord, signature: SowSignature, sentAt: string): SowEngagementRecord {
  const open = record.proposal;
  if (!open) refused("there is no open amendment proposal to approve (§5.8)");
  if (open.approval) refused("this side already approved the open proposal (§5.8)");
  const approver = other(open.by);
  if (signature.role !== approver) refused("approval is the counterparty's countersign; the proposer cannot approve its own proposal (§5.8)");
  if (signature.key !== roleKey(record, approver)) refused(`the approval is signed with a key that is not the ${approver}'s on the agreed engagement (§6)`);
  const signed: SowDocument = { ...open.document, signatures: [...signaturesOf(open.document), signature] };
  if (!verifySowSignature(signed, signature) || !sowAgreed(signed)) refused("the approval does not verify over the proposed bytes (§5.8, §6)");
  return { ...record, proposal: { ...open, approval: { signature, sent_at: sentAt } } };
}

/**
 * Until when the counterparty keeps a proposal it approved (§5.8): the latest
 * deadline an acknowledgement of a timely approval can carry, the lapse
 * instant plus the governing window. An acknowledgement names its own
 * deadline; this side learns it only when one arrives, and it applies one at
 * once, so the bound matters only while none has.
 */
export function approvalHeldUntil(record: SowEngagementRecord): string {
  const open = record.proposal;
  if (!open?.approval) refused("this side holds no approved proposal (§5.8)");
  const current = governingVersion(record);
  const lapse = Date.parse(proposalLapsesAt(current, open.document));
  return new Date(lapse + reviewWindowDays(current, open.document) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve the open proposal (§5.8), returning the record afterwards. Approval
 * is the counterparty's countersign of the proposed bytes exactly, under the
 * amendment approval authority the document states; it becomes the agreed
 * version. A denial carries a reason, and an unreasoned one is refused. The
 * proposer may withdraw it. Silence lapses it after the review window; on the
 * counterparty's side, once it approved, the proposal is kept for the
 * acknowledgement until `approvalHeldUntil`. In every outcome but approval
 * the current version stays in force.
 */
export function resolveAmendment(record: SowEngagementRecord, resolution: SowAmendmentResolution): SowEngagementRecord {
  const open = record.proposal;
  if (!open) refused("there is no open amendment proposal to resolve (§5.8)");
  const current = governingVersion(record);
  const { proposal: _closed, ...rest } = record;
  switch (resolution.kind) {
    case "approve": {
      if (resolution.signature.role !== other(open.by)) refused("approval is the counterparty's countersign; the proposer cannot approve its own proposal (§5.8)");
      const lapsesAt = proposalLapsesAt(current, open.document);
      if (Date.parse(resolution.received_at) >= Date.parse(lapsesAt) && !resolution.accept_late) {
        refused(`the approval was received at ${resolution.received_at}, at or after the lapse instant ${lapsesAt}; it forms nothing unless the proposer accepts it, and the current version continues in force (§5.8)`);
      }
      if (resolution.signature.key !== roleKey(record, resolution.signature.role)) {
        refused(`the approval is signed with a key that is not the ${resolution.signature.role}'s on the agreed engagement (§6)`);
      }
      const signed: SowDocument = { ...open.document, signatures: [...signaturesOf(open.document), resolution.signature] };
      if (!verifySowSignature(signed, resolution.signature)) refused("the approval does not verify over the proposed bytes; a partial approval is a different amendment (§5.8)");
      if (!sowAgreed(signed)) refused("the amendment is not agreed: both signatures must verify over the same bytes (§6)");
      if (approvalAuthority(current, "amendment") !== "agent" && !resolution.personConfirmed) {
        refused("this engagement's amendments need the account's human to confirm, and the approval is pending until they do (§6.1)");
      }
      const deadline = new Date(Date.parse(resolution.received_at) + reviewWindowDays(current, open.document) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      // A version formed again under the number of one voided earlier is admitted under from now on.
      const { voided, ...kept } = rest;
      return {
        ...kept,
        ...(voided && voided.version !== signed.version ? { voided } : {}),
        agreed: [...record.agreed, signed],
        acknowledgement_due: { version: signed.version, formed: true, deadline, to: resolution.signature.role, digest: formationDigest(signed) },
      };
    }
    case "deny":
      if (resolution.by !== other(open.by)) refused("the counterparty denies a proposal; the proposer withdraws it (§5.8)");
      if (open.approval) refused("this side approved the proposal; it awaits the proposer's acknowledgement and cannot deny it now (§5.8)");
      if (!resolution.reason.trim()) refused("a denial carries a reason; an unreasoned denial is not a denial, and is not recorded (§5.8)");
      return rest;
    case "withdraw":
      if (resolution.by !== open.by) refused("only the proposer withdraws a proposal (§5.8)");
      return rest;
    case "lapse": {
      const lapsesAt = proposalLapsesAt(current, open.document);
      if (Date.parse(resolution.now) < Date.parse(lapsesAt)) refused(`the proposal is open until ${lapsesAt} (§5.8)`);
      if (open.approval) {
        const held = approvalHeldUntil(record);
        if (Date.parse(resolution.now) < Date.parse(held)) {
          refused(`this side approved the proposal and keeps it for the proposer's acknowledgement until ${held}; a lapse would throw away an approval that may have formed the version (§5.8)`);
        }
      }
      return rest;
    }
  }
}

/** The proposer's acknowledgement of an approval it received (§5.8): whether the new version formed. */
export interface SowApprovalAcknowledgement {
  version: number;
  formed: boolean;
  /** The instant the proposer received the approval plus the governing review window; null where nothing formed. */
  deadline: string | null;
}

/**
 * What the counterparty does with an acknowledgement: it applied the new
 * version, it had already applied exactly these bytes (a copy re-sent after
 * a lost receipt), or nothing formed. A receipt is due for every copy of an
 * acknowledgement that the version formed.
 */
export interface SowAcknowledgementResult {
  record: SowEngagementRecord;
  outcome: "applied" | "already_applied" | "not_formed";
  receipt_due: boolean;
}

/**
 * The counterparty's side of an approval (§5.8): it applies the new version
 * only once it holds the proposer's signed acknowledgement that the version
 * formed. What it applies is exactly the proposal it holds open, one version
 * above the governing one, with the proposer's signature and its own
 * approval made with its role's key, and nothing else. It records the
 * acknowledgement's version and deadline, which a void must match. A copy of
 * the acknowledgement that arrives once the governing version already is
 * those bytes is answered with another receipt, so a lost receipt does not
 * undo the formation. Until the acknowledgement, and on one that it did not
 * form, the current version governs on both sides.
 */
export function applyAcknowledgement(record: SowEngagementRecord, approved: SowDocument, ack: SowAcknowledgement): SowAcknowledgementResult {
  const current = governingVersion(record);
  const open = record.proposal;
  if (!open) {
    const applied = record.applied_formation;
    if (applied && current.version === applied.version && canonicalJSON(current) === canonicalJSON(approved)) {
      checkFormationMessage(ack, subjectOf(current.id, applied, applied.by, applied.by, applied.key));
      if (ack.kind !== "acknowledgement" || !ack.formed) refused("only an acknowledgement that the version formed is answered with a receipt (§5.8)");
      return { record, outcome: "already_applied", receipt_due: true };
    }
    refused("there is no open proposal for this acknowledgement to settle, and the governing version is not the approved one (§5.8)");
  }
  const proposerKey = roleKey(record, open.by);
  checkFormationMessage(ack, subjectOf(current.id, { version: approved.version, digest: formationDigest(approved) }, open.by, open.by, proposerKey));
  if (ack.kind !== "acknowledgement") refused(`a ${ack.kind} is not an acknowledgement (§5.8)`);
  if (approved.version !== current.version + 1) refused(`the approval is of version ${approved.version}, and the next version is ${current.version + 1} (§5.8)`);
  if (canonicalSowJSON(approved) !== canonicalSowJSON(open.document)) {
    refused("the approved version is not the proposal this side holds open, byte for byte (§5.8)");
  }
  const { proposal: _closed, ...rest } = record;
  if (!ack.formed) return { record: rest, outcome: "not_formed", receipt_due: false };
  const proposerSigs = signaturesOf(open.document);
  const approver = other(open.by);
  const approval = signaturesOf(approved).filter((s) => s.role === approver);
  const carried = signaturesOf(approved).filter((s) => s.role === open.by);
  if (approval.length !== 1 || signaturesOf(approved).length !== proposerSigs.length + 1 || canonicalJSON(carried) !== canonicalJSON(proposerSigs)) {
    refused("the approved version carries the proposer's signature and one approval, and nothing else (§5.8)");
  }
  if (approval[0]!.key !== roleKey(record, approver)) refused(`the approval is signed with a key that is not the ${approver}'s on the agreed engagement (§6)`);
  if (open.approval && canonicalJSON(approval[0]) !== canonicalJSON(open.approval.signature)) {
    refused("the approved version carries an approval other than the one this side made (§5.8)");
  }
  if (!sowAgreed(approved)) refused("the approved version is not agreed: both signatures must be good over the same bytes (§6)");
  const { voided_formation: _past, ...kept } = rest;
  const applied_formation = { version: approved.version, digest: formationDigest(approved), deadline: ack.deadline as string, by: open.by, key: proposerKey };
  return { record: { ...kept, agreed: [...record.agreed, approved], applied_formation }, outcome: "applied", receipt_due: true };
}

// ── §5.9 termination ────────────────────────────────────────────────────────

/** A termination: for convenience, with the stated notice, or for cause, immediately and with a reason. */
export interface SowTerminationAct {
  by: Role;
  for_cause: boolean;
  reason?: string;
  at: string;
}

/**
 * The notice a termination for convenience gives (§5.9): the clause's
 * `convenience_notice_hours`, and zero where the clause states none, so the
 * termination takes effect at once. The platform's store, its rendering of
 * the clause and the adapter all read the notice here.
 */
export function convenienceNoticeHours(doc: { termination?: unknown }): number {
  const t = isRecord(doc.termination) ? doc.termination : {};
  const h = t.convenience_notice_hours;
  return typeof h === "number" && Number.isFinite(h) && h >= 0 ? h : 0;
}

/**
 * When a termination takes effect (§5.9), and what becomes of tasks in flight:
 * for convenience, after the stated notice, and in-flight tasks complete and
 * are paid; for cause, at once, and in-flight tasks are canceled with the
 * recorded reason, which a for-cause termination therefore carries. Notice
 * never runs past the engagement's own end: an engagement that lapses before
 * the notice is out simply lapses (§5.7).
 */
export function terminationEffect(doc: { termination?: unknown; ends_at?: string | null }, act: SowTerminationAct): { effective_at: string; in_flight: "complete_and_pay" | "cancel" } {
  if (act.for_cause) {
    if (!act.reason?.trim()) refused("a termination for cause records its reason: the tasks it cancels carry it (§5.9)");
    return { effective_at: act.at, in_flight: "cancel" };
  }
  const at = Date.parse(act.at) + convenienceNoticeHours(doc) * 3_600_000;
  const end = typeof doc.ends_at === "string" ? Date.parse(doc.ends_at) : NaN;
  // Past the end, the engagement's own end instant, exactly as it is written.
  if (Number.isFinite(end) && end < at) return { effective_at: doc.ends_at as string, in_flight: "complete_and_pay" };
  return {
    effective_at: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"),
    in_flight: "complete_and_pay",
  };
}

// ── §5.5.5 reaching the cap ─────────────────────────────────────────────────

/**
 * The cap gate (§5.5.5): once what the client has been billed reaches the
 * not-to-exceed cap, no further request is admitted, and the refusal names
 * the cap. Exhaustion ends the engagement; it is not a failure.
 */
export function checkUnderCap(price: SowTimeAndMaterialsPrice, billed: number): void {
  if (billed >= price.cap.amount) {
    throw new SowRefusal("refused", `sow: the engagement reached its not-to-exceed cap of ${price.cap.amount} ${price.currency}; it is exhausted and admits no further work (§5.5.5)`, "5.5.5");
  }
}
