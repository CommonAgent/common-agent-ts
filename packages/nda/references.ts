/**
 * What other documents ask of an Agent NDA (§8): the reference shape they
 * name it by, and the read-only questions the other specifications put to
 * it. Each of them reaches this code through a port its own module defines
 * (NdaGate for Agent RFP, Agent SoW's NdaReference, the bound check for
 * Agent Processes), so the answers here take documents and instants and
 * never fetch anything.
 *
 *   - §8 and Agent SoW §5.16: is this a well-formed reference?
 *   - §8.1: is this party bound by the named agreement?
 *   - Agent RFP §5.11.3: may a board release a gated body to this provider?
 *   - Agent SoW §5.16: do an engagement's parties and declarations fit the
 *     agreement it names?
 *   - Agent Reputations §4.8: the facts about the agreement a bureau checks
 *     before it records a claim of breach as open.
 */
import { agreementDigest, offerDigest } from "./bytes.js";
import { DIGEST } from "./crypto.js";
import { checkFlowDown, declarationOf, sameProcessor, seatFor } from "./flowdown.js";
import type { ActReceipts, DocReceipts, HandleResolver, MandateLookup, OwnerResolver } from "./ports.js";
import { counts, decides, seatSignatures, verifySignatureRecord } from "./records.js";
import { verifyAcceptance } from "./signatures.js";
import { coversDisclosureAt, deriveState, type StateReading } from "./state.js";
import { NDA_ID, type Agreement, type AgreementReference, type Category, type Declaration, type Direction, type Processor, type SignedAct } from "./types.js";
import { FALSE_ENFORCEMENT_MESSAGE, statedJurisdictions } from "./validate.js";

// ── §8: the reference ────────────────────────────────────────────

export type ReferenceCheck = { ok: true; reference: AgreementReference } | { ok: false; reason: string };

/**
 * A reference as a referring document carries it (§8): an object with `id`,
 * `version`, a `digest` in the `sha256:` spelling, and an optional `ref`.
 * Where it carries a grade the grade is `evidence`, because what is
 * mechanical is which bytes were agreed, and `enforced` is the false
 * enforcement claim. Agent SoW §5.16 makes the grade REQUIRED, as it does on
 * every clause of an engagement; a claim of breach (Agent Reputations §4.8)
 * carries none. `gradeRequired` says which reader is asking.
 */
export function checkReference(v: unknown, opts: { gradeRequired?: boolean } = {}): ReferenceCheck {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, reason: "a reference is an object carrying the digest; an id alone names no bytes" };
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !NDA_ID.test(r.id)) return { ok: false, reason: "an Agent NDA id begins nda_ and has 16 lowercase Crockford base32 characters" };
  if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1) return { ok: false, reason: "versions start at 1" };
  if (typeof r.digest !== "string" || !DIGEST.test(r.digest)) return { ok: false, reason: "digest is REQUIRED: sha256: and 64 lowercase hex characters, compared exactly" };
  if (r.ref !== undefined && typeof r.ref !== "string") return { ok: false, reason: "ref is a locator" };
  if (r.grade === "enforced") return { ok: false, reason: FALSE_ENFORCEMENT_MESSAGE };
  if (r.grade === undefined ? opts.gradeRequired : r.grade !== "evidence") return { ok: false, reason: "the reference is graded evidence" };
  return { ok: true, reference: r as unknown as AgreementReference };
}

/** The reference shape for an agreement: the completed agreement's digest,
 *  or for an open offer the offer digest (§8). */
export function referenceTo(doc: Agreement, ref?: string): AgreementReference {
  const digest = doc.parties.recipient === null ? offerDigest(doc) : agreementDigest(doc);
  return { id: doc.id, version: doc.version, digest, ...(ref ? { ref } : {}), grade: "evidence" };
}

// ── §8.1: whether a party is bound ───────────────────────────────

/** A party is named by its agent key, by the owner key that signed for it,
 *  or both. */
export interface PartyRef {
  agent?: string;
  ownerKey?: string;
}

export interface BoundContext {
  /** The agreements the caller holds: the named one, acceptances of a named
   *  offer, and flow-down agreements. */
  documents: Agreement[];
  acts?: SignedAct[];
  now: string;
  mandates?: MandateLookup;
  owners?: OwnerResolver;
  actReceipts?: ActReceipts;
  /** When the receiving verifier received each document it holds (§6). */
  docReceipts?: DocReceipts;
  resolveHandle?: HandleResolver;
}

/** `signedAtOnly` is true when a receipt record the answer needed was absent
 *  along the way, so instants were read from `signed_at` and `at` alone (§6). */
export type BoundAnswer =
  | { bound: true; rule: 1 | 2 | 3; agreement: AgreementReference; reading: StateReading; signedAtOnly: boolean }
  | { bound: false; reason: string; signedAtOnly: boolean };

/**
 * §8.1: is this party's owner bound by the named agreement? Yes when, with
 * the agreement in force,
 *   1. the party signed a seat of it, and has not left it (a multilateral
 *      member's own termination ends its participation, §7.3);
 *   2. the reference is an open offer and the party is the recipient of an
 *      acceptance of it that passes §6.1;
 *   3. the party is the subcontractor in a flow-down agreement that passes
 *      the strictness test, whose `flows_from` names the agreement that binds
 *      the party above it: the named agreement itself, an acceptance of the
 *      named offer, or another flow-down whose recipient is that party, hop
 *      by hop until the chain reaches the named agreement.
 * A seat that names an organization counts only when its mandate check was
 * not refused (§6.2); one that names no organization counts only when its
 * owner is confirmed against the registry, or, as the recipient of an open
 * offer that accepts any owner, is not contradicted (§6, §8.1).
 */
export function isBound(reference: AgreementReference, party: PartyRef, ctx: BoundContext): BoundAnswer {
  // The documents that are not flow-downs first, so a party bound directly
  // is reported under rule 1 or 2.
  const order = [...ctx.documents.filter((d) => !d.flows_from), ...ctx.documents.filter((d) => d.flows_from)];
  let signedAtOnly = false;
  for (const doc of order) {
    const answer = boundThrough(doc, reference, party, ctx, 0);
    if (answer.bound) return answer;
    signedAtOnly ||= answer.signedAtOnly;
  }
  return { bound: false, reason: "no agreement in force binds the party to the named terms", signedAtOnly };
}

/** How many flow-down hops `isBound` follows before it stops (see rule 3). */
export const MAX_FLOW_DOWN_HOPS = 8;

/** Whether `party` is bound by the named agreement through this one document. */
function boundThrough(doc: Agreement, reference: AgreementReference, party: PartyRef, ctx: BoundContext, depth: number): BoundAnswer {
  const receivedAt = ctx.docReceipts?.(doc);
  const reading = deriveState(doc, { now: ctx.now, acts: ctx.acts, mandates: ctx.mandates, owners: ctx.owners, actReceipts: ctx.actReceipts, receivedAt, resolveHandle: ctx.resolveHandle });
  const no = (reason: string): BoundAnswer => ({ bound: false, reason, signedAtOnly: reading.signedAtOnly });
  // The party's own seat, by agent key or by the owner key that signed it,
  // where its signature verifies and its key is bound to the seat with the
  // owner confirmed (§6, §8.1): an unconfirmed owner is not bound, except as
  // the recipient of an open offer that accepts any owner.
  const seat = seatSignatures(doc, { mandates: ctx.mandates, owners: ctx.owners, receivedAt }).find(
    (s) => decides(s, doc) && s.seat && ((party.agent && s.seat.agent === party.agent) || (party.ownerKey && s.record?.key === party.ownerKey)),
  );
  if (!seat?.seat) return no("the party holds no signed seat in this agreement");
  if (reading.state !== "in force") return no(`the agreement is ${reading.state}`);
  if (reading.departed?.includes(seat.seat.agent)) return no("the party has left this agreement");
  const sameNumber = doc.id === reference.id && doc.version === reference.version;

  // Rule 1: the named agreement itself.
  if (sameNumber && doc.parties.recipient !== null && agreementDigest(doc) === reference.digest) {
    return { bound: true, rule: 1, agreement: referenceTo(doc), reading, signedAtOnly: reading.signedAtOnly };
  }
  // Rule 2: an acceptance of the named open offer, with the party as its recipient.
  if (sameNumber && doc.offer && doc.parties.recipient && offerDigest(doc) === reference.digest) {
    if (seat.role !== "recipient") return no("only the recipient of an acceptance is bound by it under rule 2");
    if (!verifyAcceptance(doc, { acts: ctx.acts, actReceipts: ctx.actReceipts, resolveHandle: ctx.resolveHandle, mandates: ctx.mandates, owners: ctx.owners, receivedAt }).ok) {
      return no("the acceptance does not pass 6.1");
    }
    return { bound: true, rule: 2, agreement: referenceTo(doc), reading, signedAtOnly: reading.signedAtOnly };
  }
  // Rule 3: a flow-down whose recipient is the party, hop by hop. §8.1 sets
  // no limit on the length of a chain; this walk stops after eight hops, a
  // deliberate bound so that a cycle or a pathological chain of documents
  // cannot make the check run without end. A chain longer than that reads
  // as not bound.
  if (doc.flows_from && seat.role === "recipient" && depth < MAX_FLOW_DOWN_HOPS) {
    const f = doc.flows_from;
    const upstream = ctx.documents.find((d) => d.id === f.id && d.version === f.version && agreementDigest(d) === f.digest);
    if (!upstream) return no("the agreement the flow-down names is not held");
    if (!checkFlowDown(doc, upstream).ok) return no("the flow-down is less strict than the agreement it flows from");
    const above = doc.parties.discloser?.agent;
    if (!above) return no("the flow-down names no party above the subcontractor");
    const hop = boundThrough(upstream, reference, { agent: above }, ctx, depth + 1);
    const signedAtOnly = reading.signedAtOnly || hop.signedAtOnly;
    if (hop.bound) return { bound: true, rule: 3, agreement: hop.agreement, reading: hop.reading, signedAtOnly };
    return { bound: false, reason: `the party above is not bound through the agreement the flow-down names: ${hop.reason}`, signedAtOnly };
  }
  return no("this agreement is not the named one, an acceptance of it, or a flow-down from it");
}

// ── Agent RFP §5.11.3: releasing a gated body ────────────────────

export interface GateRequest {
  /** `gate.nda` from the posting. */
  gate: AgreementReference;
  /** The completed agreement the provider presents. */
  presented: Agreement;
  /** The posting's `poster.agent`. */
  posterAgent: string;
  /** The agent key the board verified on the request's transport identity. */
  requesterAgent: string;
  acts?: SignedAct[];
  now: string;
  resolveHandle?: HandleResolver;
  /** The board runs §6.2 on every seat that names an organization, at
   *  signing and at receipt (Agent RFP §5.11.3). A gate with an
   *  organization's seat and no lookup, or a lookup that answers unknown,
   *  releases nothing. */
  mandates?: MandateLookup;
  /** The registry's owners as the board resolved them at receipt (§6).
   *  REQUIRED: a board that has no registry says so with `"none"`, which
   *  reads every owner as unconfirmed. A forgotten resolver is never taken
   *  for that, because under `"owners": "any"` it would release to a party
   *  the registry contradicts. */
  owners: OwnerResolver | "none";
  actReceipts?: ActReceipts;
  /** When the board received the completed agreement. REQUIRED: the board is
   *  the receiving verifier, and checks expiry, withdrawals and mandates at
   *  receipt as well as at `signed_at` (Agent NDA §6.1 step 3; Agent RFP
   *  §5.11.3). */
  receivedAt: string;
}

/** A release says whether the recipient's owner was confirmed against the
 *  registry, because a renderer must say so when it was not (§6.1 step 2). */
export type GateAnswer =
  | { release: true; agreement: AgreementReference; owner: "confirmed" | "unconfirmed"; signedAtOnly: boolean }
  | { release: false; check: 1 | 2 | 3 | 4 | 5; reason: string; signedAtOnly?: boolean };

/**
 * Checks 1 to 5 of Agent RFP §5.11.3, the ones an agreement answers. Check 6
 * (the posting is open and, if directed, addressed to the provider) is the
 * board's own state and stays in the RFP module.
 */
export function checkGateRelease(req: GateRequest): GateAnswer {
  const doc = req.presented;
  if (typeof req.receivedAt !== "string" || Number.isNaN(Date.parse(req.receivedAt))) {
    return { release: false, check: 1, reason: "the board records when it received the acceptance and checks against it; no instant of receipt was given (Agent NDA 6.1 step 3)" };
  }
  if (req.owners === undefined) {
    return { release: false, check: 1, reason: "no owner resolver was given; a board without a registry says so with owners: none (Agent NDA 6)" };
  }
  const owners = req.owners === "none" ? undefined : req.owners;
  const gateIsOffer = !!doc.offer && offerDigest(doc) === req.gate.digest;
  if (gateIsOffer) {
    const a = verifyAcceptance(doc, { acts: req.acts, actReceipts: req.actReceipts, resolveHandle: req.resolveHandle, mandates: req.mandates, owners, receivedAt: req.receivedAt });
    if (!a.ok) return { release: false, check: 1, reason: `the acceptance fails Agent NDA 6.1 step ${a.step}: ${a.reason}` };
  } else {
    const sigs = seatSignatures(doc);
    if (!sigs.length || !sigs.every((s) => s.valid)) return { release: false, check: 1, reason: "a signature on the agreement does not verify" };
  }
  // The release rides on every seat's binding (§6): the recipient's owner
  // confirmed (or, under owners: any, not contradicted), and every seat that
  // names an organization signed under a mandate that checked at signing and
  // at receipt.
  const seats = seatSignatures(doc, { mandates: req.mandates, owners, receivedAt: req.receivedAt });
  const recipientSig = seats.find((s) => s.role === "recipient");
  if (!recipientSig || !decides(recipientSig, doc)) {
    return { release: false, check: 1, reason: "the recipient's owner is not confirmed against the registry, or the registry contradicts it (Agent NDA 6, 6.1)" };
  }
  for (const s of seats) {
    if (s.seat?.organization !== undefined && s.binding !== "bound") {
      return { release: false, check: 1, reason: `the ${s.role}'s seat names an organization and its signer's mandate did not check at signing and at receipt (Agent NDA 6.2)` };
    }
  }
  if (doc.parties.discloser?.agent !== req.posterAgent) return { release: false, check: 2, reason: "the discloser seat does not name the posting's poster" };
  const digest = gateIsOffer ? offerDigest(doc) : agreementDigest(doc);
  if (digest !== req.gate.digest || doc.id !== req.gate.id || doc.version !== req.gate.version) {
    return { release: false, check: 3, reason: "the agreement is not the one the posting names" };
  }
  if (doc.parties.recipient?.agent !== req.requesterAgent) return { release: false, check: 4, reason: "the recipient seat names another agent than the one asking" };
  const reading = deriveState(doc, { now: req.now, acts: req.acts, actReceipts: req.actReceipts, mandates: req.mandates, owners, receivedAt: req.receivedAt, resolveHandle: req.resolveHandle });
  if (reading.state === "terminated") return { release: false, check: 5, reason: "the agreement has been terminated" };
  if (reading.state !== "in force") return { release: false, check: 5, reason: `the agreement is ${reading.state}` };
  return {
    release: true,
    agreement: referenceTo(doc),
    owner: recipientSig.binding === "bound" || doc.parties.recipient?.organization !== undefined ? "confirmed" : "unconfirmed",
    signedAtOnly: reading.signedAtOnly,
  };
}

// ── Agent SoW §5.16: an engagement against the NDA it names ──────

/** Agent SoW §5.16: the NDA's seats hold the engagement's two agent keys, in
 *  either order. An open offer, a third party, or one party in both seats
 *  does not match. */
export function partiesMatch(engagement: { provider: string; client: string }, nda: { discloser?: string | null; recipient?: string | null; members?: string[] }): boolean {
  if (engagement.provider === engagement.client) return false;
  if (nda.members) return nda.members.includes(engagement.provider) && nda.members.includes(engagement.client);
  if (!nda.discloser || !nda.recipient || nda.discloser === nda.recipient) return false;
  const pair = [nda.discloser, nda.recipient];
  return pair.includes(engagement.provider) && pair.includes(engagement.client);
}

export type DisclosureFit = { ok: true } | { ok: false; test: "processors" | "processed_in"; entry?: number };

/**
 * Agent SoW §5.16's two tests of an engagement's §5.11 declarations against
 * what the NDA permits for the provider's seat. Processors are tested first,
 * and the first failing entry is reported by its index in the engagement's
 * order.
 */
export function disclosureFits(ndaPermits: Declaration, confidentiality: { processors?: Processor[]; processed_in?: unknown }): DisclosureFit {
  const permitted = Array.isArray(ndaPermits.processors) ? ndaPermits.processors : [];
  const declared = confidentiality.processors ?? [];
  for (let i = 0; i < declared.length; i++) {
    if (!permitted.some((p) => sameProcessor(declared[i], p))) return { ok: false, test: "processors", entry: i };
  }
  const allowed = statedJurisdictions(ndaPermits.processed_in);
  if (allowed) {
    const raw = confidentiality.processed_in;
    const places = statedJurisdictions(raw);
    if (!places) return { ok: false, test: "processed_in" };
    const i = places.findIndex((p) => !allowed.includes(p));
    if (i >= 0) return { ok: false, test: "processed_in", entry: i };
  }
  return { ok: true };
}

export type EngagementCheck =
  | { ok: true; tests: "ran" | "not_applicable" }
  | { ok: false; test: "digest" | "open_offer" | "parties" | "processors" | "processed_in"; entry?: number; reason: string };

/**
 * Agent SoW §5.16 for a runtime that holds the NDA's bytes: the bytes hash
 * to the reference's digest, the reference names a completed agreement, the
 * parties match, and the provider's declarations fit. Where the NDA is
 * one-way and the provider is its discloser, neither disclosure test
 * applies, and the answer says so.
 */
export function checkEngagement(
  reference: AgreementReference,
  nda: Agreement,
  engagement: { provider: string; client: string; confidentiality?: { processors?: Processor[]; processed_in?: unknown } },
): EngagementCheck {
  if (nda.parties.recipient === null) return { ok: false, test: "open_offer", reason: "the digest names an open offer, which names no agreement with the counterparty" };
  if (agreementDigest(nda) !== reference.digest) return { ok: false, test: "digest", reason: "these bytes do not hash to the reference's digest, so they are a different document" };
  const seats =
    nda.direction === "multilateral"
      ? { members: (nda.parties.members ?? []).map((m) => m.agent) }
      : { discloser: nda.parties.discloser?.agent, recipient: nda.parties.recipient?.agent };
  if (!partiesMatch(engagement, seats)) return { ok: false, test: "parties", reason: "the NDA's seats do not hold the engagement's two agent keys" };
  if (nda.direction === "one_way" && nda.parties.discloser?.agent === engagement.provider) return { ok: true, tests: "not_applicable" };
  const permits = declarationOf(nda, engagement.provider) ?? {};
  const fit = disclosureFits(permits, engagement.confidentiality ?? {});
  if (!fit.ok) return { ok: false, test: fit.test, entry: fit.entry, reason: `the engagement's declarations fail the ${fit.test} test` };
  return { ok: true, tests: "ran" };
}

// ── Agent Reputations §4.8: what a bureau checks about the agreement ──

export interface BreachClaim {
  claimant: string;
  respondent: string;
  categories: Category[];
  /** The instants the claim's disclosure records state. */
  disclosedAt: string[];
  /** The claimant's `breach_at`, where stated. */
  breachAt?: string | null;
}

/** The facts about an agreement a bureau records with a claim, and what its
 *  NDA record shows (Agent Reputations §4.9): never the identifier, the
 *  digest or the claimant. */
export interface NdaBreachFacts {
  direction: Direction;
  categories: Category[];
  /** When the duties ended, which the claim window counts from. */
  dutiesEndAt: string;
}

/** `signedAtOnly` is true when the agreement's or a termination's receipt was
 *  absent, so the window the claim is read against came from `signed_at` and
 *  `at` alone (§6). */
export type BreachCheck =
  | { ok: true; facts: NdaBreachFacts; signedAtOnly: boolean }
  | { ok: false; check: 2 | 3 | 4 | 6 | 7 | 8; reason: string };

/**
 * Checks 2, 3, 4, 6 and 7 of Agent Reputations §4.8, and the part of check 8
 * the agreement answers: a stated `breach_at` falls before the duties ended.
 * Checks 1, 5 and 9 and the claim window itself are the bureau's own.
 */
export function checkBreachClaim(reference: AgreementReference, nda: Agreement, claim: BreachClaim, ctx: {
    acts?: SignedAct[];
    now: string;
    mandates?: MandateLookup;
    owners?: OwnerResolver;
    /** When the receiving verifier received each act: a termination takes
     *  effect at the later of its `at` and its receipt (§7.3). */
    actReceipts?: ActReceipts;
    /** When the receiving verifier received the agreement (§6). */
    receivedAt?: string;
  },
): BreachCheck {
  // 2. The completed agreement both parties signed.
  if (nda.parties.recipient === null) return { ok: false, check: 2, reason: "the digest names an open offer, never the agreement a claim cites" };
  if (agreementDigest(nda) !== reference.digest) return { ok: false, check: 2, reason: "the agreement's bytes do not hash to the cited digest" };
  if (!nda.signatures.every((s) => verifySignatureRecord(nda, s))) return { ok: false, check: 2, reason: "a signature on the agreement does not verify" };
  // Each seat's signature is bound, with its owner confirmed where the seat
  // names no organization (Agent NDA 6, 8.1): an unconfirmed owner does no
  // better here than one the registry contradicts.
  if (!seatSignatures(nda, { mandates: ctx.mandates, owners: ctx.owners, receivedAt: ctx.receivedAt }).every((x) => decides(x, nda))) {
    return { ok: false, check: 2, reason: "a signature on the agreement is not bound to its seat with a confirmed owner" };
  }
  const reading = deriveState(nda, { now: ctx.now, acts: ctx.acts, mandates: ctx.mandates, owners: ctx.owners, actReceipts: ctx.actReceipts, receivedAt: ctx.receivedAt });
  if (!reading.effectiveAt || !reading.endedAt || !reading.dutiesEndAt) return { ok: false, check: 2, reason: `the agreement never took effect (${reading.state})` };
  // 3. The claimant is a party whose material it protects.
  const claimantSeat = seatFor(nda, claim.claimant);
  if (!claimantSeat) return { ok: false, check: 3, reason: "the claimant holds no seat in the agreement" };
  if (nda.direction === "one_way" && nda.parties.discloser?.agent !== claim.claimant) return { ok: false, check: 3, reason: "in a one-way agreement only the discloser's material is protected" };
  // 4. The respondent is bound by it, in another seat.
  if (claim.respondent === claim.claimant || !seatFor(nda, claim.respondent)) return { ok: false, check: 4, reason: "the respondent holds no other seat in the agreement" };
  // 6. The material is covered.
  if (!claim.categories.length || !claim.categories.every((c) => nda.covers.categories.includes(c))) return { ok: false, check: 6, reason: "a category of the claim is not one the agreement covers" };
  // 7. The material reached the respondent while the agreement covered it.
  if (!claim.disclosedAt.some((at) => coversDisclosureAt(reading, at))) return { ok: false, check: 7, reason: "no cited disclosure falls between the agreement taking effect and its end" };
  // 8, in part. A stated breach before the duties ended.
  if (claim.breachAt && !(Date.parse(claim.breachAt) < Date.parse(reading.dutiesEndAt))) return { ok: false, check: 8, reason: "the stated breach falls after the duties ended" };
  return { ok: true, facts: { direction: nda.direction, categories: claim.categories, dutiesEndAt: reading.dutiesEndAt }, signedAtOnly: reading.signedAtOnly };
}
