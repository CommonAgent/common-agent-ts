/**
 * The engagement's lifecycle (lifecycle.ts): formation from a standing
 * proposal, the state at an instant and the admission gate, amendment and its
 * four resolutions, termination, and the cap. Signed with the conformance
 * files' published seed for the provider and a fresh key for the client.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import {
  SowRefusal,
  amendmentLapsesAt,
  checkAdmission,
  checkAmendmentProposal,
  checkFormation,
  checkUnderCap,
  completeFormation,
  completedInstance,
  documentState,
  engagementState,
  resolveAmendment,
  signSow,
  signerFromRawSeed,
  signerFromSeed,
  sowAgreed,
  terminationEffect,
  convenienceNoticeHours,
  type SowDocument,
  type SowEngagementRecord,
  type SowParty,
  type SowTimeAndMaterialsPrice,
  verifySowSignature,
  signatureStatus,
  amendmentState,
  versionForOwnActs,
  versionForRequest,
  receiptReceived,
  voidFormation,
  applyVoid,
  reviewWindowDays,
  proposalLapsesAt,
  addsOwnerKeys,
  seatOwners,
  applyAcknowledgement,
  approveProposal,
  approvalHeldUntil,
  acknowledgementFor,
  answerRequest,
  receiptFor,
  voidFor,
  signFormationMessage,
  formationDigest,
  type SowAcknowledgement,
  DEFAULT_REVIEW_WINDOW_DAYS,
} from "../index.js";

const pricing = loadPinnedVectors("sow/conformance/sow-pricing.json").data as Record<string, any>;
const provider = signerFromSeed(pricing.identities.sender_seed);
const client = signerFromRawSeed(new Uint8Array(randomBytes(32)));
const directed = (): SowDocument => structuredClone(pricing.directed.signing.document);

function refusal(f: () => unknown): SowRefusal {
  try {
    f();
  } catch (e) {
    if (e instanceof SowRefusal) return e;
    throw e;
  }
  throw new Error("expected a SowRefusal");
}

/** A directed standing proposal the provider has signed, and the party it names. */
function offer(mutate: (d: SowDocument) => void = () => {}) {
  const doc = directed();
  doc.parties.provider = { ...doc.parties.provider, owner_key: provider.getPublicKey() };
  mutate(doc);
  const named = doc.parties.offered_to!;
  const party: SowParty = { agent: named.agent, owner: named.owner, owner_key: client.getPublicKey(), ...(named.handle ? { handle: named.handle } : {}) };
  return { standing: signSow(doc, provider, "provider", "2026-09-01T00:00:00Z"), party };
}

/** A request to form: the completed instance, signed by the client. */
function request(standing: SowDocument, party: SowParty, extra: { buyer_reference?: string } = {}) {
  const instance = completedInstance(standing, { client: party, starts_at: "2026-09-10T00:00:00Z", ...extra });
  return signSow(instance, client, "client", "2026-09-05T00:00:00Z");
}

function formed(): SowDocument {
  const { standing, party } = offer();
  const req = request(standing, party, { buyer_reference: "PO-2026-004417" });
  expect(checkFormation(standing, req, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z" })).toEqual({ ready: true });
  return completeFormation(req, provider, "2026-09-05T00:01:00Z");
}

describe("§12.1 formation from a standing proposal", () => {
  it("fills the client seat, the start and the buyer's reference, and counts the end from term_months", () => {
    const { standing, party } = offer();
    const instance = completedInstance(standing, { client: party, starts_at: "2026-09-10T00:00:00Z", buyer_reference: "PO-1" });
    expect(instance.parties.client).toEqual(party);
    expect(instance.starts_at).toBe("2026-09-10T00:00:00Z");
    expect(instance.ends_at).toBe("2027-03-10T00:00:00Z");
    expect(instance.buyer_reference).toBe("PO-1");
    expect(instance.signatures).toBeUndefined();
  });

  it("completes with a fresh provider signature over the completed bytes, and only then is agreed", () => {
    const doc = formed();
    expect(sowAgreed(doc)).toBe(true);
    expect(doc.signatures!.map((s) => s.role).sort()).toEqual(["client", "provider"]);
  });

  it("holds a counted end to the start plus term_months, the same day and time or the month's last day", () => {
    const { standing, party } = offer();
    const instance = completedInstance(standing, { client: party, starts_at: "2026-08-31T09:30:00Z" });
    expect(instance.ends_at).toBe("2027-02-28T09:30:00Z");
    // The instance keeps the template's term_months, so a moved end disagrees with it (§5.7).
    const moved = signSow({ ...instance, ends_at: "2027-12-31T00:00:00Z" }, client, "client");
    expect(refusal(() => checkFormation(standing, moved, { clientOwner: "confirmed", now: "2026-08-30T00:00:00Z" })).section).toBe("5.7");
    // Without term_months on the instance, the end is still held to the template's count (§12.1).
    const { term_months: _t, ...bare } = instance;
    const unrecorded = signSow({ ...bare, ends_at: "2027-12-31T00:00:00Z" } as SowDocument, client, "client");
    expect(refusal(() => checkFormation(standing, unrecorded, { clientOwner: "confirmed", now: "2026-08-30T00:00:00Z" })).section).toBe("12.1");
    expect(checkFormation(standing, signSow(instance, client, "client"), { clientOwner: "confirmed", now: "2026-08-30T00:00:00Z" })).toEqual({ ready: true });
  });

  it("refuses an instance changed in anything but the seat, the start and the reference", () => {
    const { standing, party } = offer();
    const instance = completedInstance(standing, { client: party, starts_at: "2026-09-10T00:00:00Z" });
    instance.volume = { per_hour: 500, per_day: 5000, grade: "enforced" };
    const req = signSow(instance, client, "client");
    expect(refusal(() => checkFormation(standing, req, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z" })).section).toBe("12.1");
  });

  it("refuses a client signature that does not verify, and a request that already carries a provider signature", () => {
    const { standing, party } = offer();
    const req = request(standing, party);
    const forged = { ...req, signatures: [{ ...req.signatures![0]!, sig: req.signatures![0]!.sig.replace(/^./, (c) => (c === "A" ? "B" : "A")) }] };
    expect(refusal(() => checkFormation(standing, forged, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z" })).section).toBe("6");
    const presigned = signSow(req, provider, "provider");
    expect(refusal(() => checkFormation(standing, presigned, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z" })).message).toMatch(/fresh one/);
  });

  it("holds a directed offer to the party it names, until it lapses, and once", () => {
    const { standing, party } = offer();
    const stranger: SowParty = { agent: client.getPublicKey(), owner: "Someone Else", owner_key: client.getPublicKey() };
    expect(refusal(() => checkFormation(standing, request(standing, stranger), { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z" })).section).toBe("12.1.1");
    expect(refusal(() => checkFormation(standing, request(standing, party), { clientOwner: "confirmed", now: "2026-09-21T00:00:00Z" })).section).toBe("12.1.1");
    expect(refusal(() => checkFormation(standing, request(standing, party), { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z", directedAlreadyFormed: true })).section).toBe("12.1.1");
  });

  it("waits for the client account's human where formation needs a person", () => {
    const { standing, party } = offer((d) => {
      (d.change_control as { approval: { formation: string } }).approval.formation = "person";
    });
    const req = request(standing, party);
    expect(checkFormation(standing, req, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z" })).toEqual({ ready: false, waiting: "person" });
    expect(checkFormation(standing, req, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z", personConfirmed: true })).toEqual({ ready: true });
  });

  it("refuses a countersign that leaves out a stated qualification", () => {
    const doc = structuredClone(pricing.qualifications.signing.document) as SowDocument;
    doc.parties.provider = { ...doc.parties.provider, owner_key: provider.getPublicKey() };
    const standing = signSow(doc, provider, "provider");
    const named = doc.parties.offered_to;
    const party: SowParty = named
      ? { agent: named.agent, owner: named.owner, owner_key: client.getPublicKey() }
      : { agent: client.getPublicKey(), owner: "Harbor & Line Outfitters", owner_key: client.getPublicKey() };
    const req = signSow(completedInstance(standing, { client: party, starts_at: "2026-09-10T00:00:00Z" }), client, "client");
    expect(refusal(() => checkFormation(standing, req, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z" })).section).toBe("12.1");
  });

  it("runs the NDA tests where the runtime holds the agreement, naming the test that failed", () => {
    const { standing, party } = offer((d) => {
      d.nda = { id: "nda_dtzv6z8tans9k5s6", version: 1, digest: "sha256:" + "04".repeat(32), grade: "evidence" };
    });
    const req = request(standing, party);
    const seats = { discloser: party.agent, recipient: standing.parties.provider.agent };
    expect(checkFormation(standing, req, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z", nda: { seats, providerTerms: { processors: [] } } })).toEqual({ ready: true });
    const wrong = { discloser: party.agent, recipient: client.getPublicKey() };
    expect(refusal(() => checkFormation(standing, req, { clientOwner: "confirmed", now: "2026-09-05T00:00:00Z", nda: { seats: wrong, providerTerms: {} } })).message).toMatch(/parties test/);
  });
});

describe("§7.1 states and the admission gate", () => {
  it("is agreed before the start, active during the term, lapsed after it", () => {
    const record: SowEngagementRecord = { agreed: [formed()] };
    expect(engagementState(record, "2026-09-09T00:00:00Z")).toBe("agreed");
    expect(engagementState(record, "2026-09-10T00:00:00Z")).toBe("active");
    expect(engagementState(record, "2027-03-10T00:00:00Z")).toBe("active");
    expect(engagementState(record, "2027-03-10T00:00:01Z")).toBe("lapsed");
    expect(() => checkAdmission(record, "2026-10-01T00:00:00Z")).not.toThrow();
    expect(refusal(() => checkAdmission(record, "2026-09-09T00:00:00Z")).section).toBe("5.7");
    expect(refusal(() => checkAdmission(record, "2027-04-01T00:00:00Z")).section).toBe("7.1");
  });

  it("ends terminated or exhausted from the instant either took effect, whichever came first", () => {
    const record: SowEngagementRecord = { agreed: [formed()], terminated_at: "2026-12-01T00:00:00Z", exhausted_at: "2026-11-01T00:00:00Z" };
    expect(engagementState(record, "2026-10-31T23:59:59Z")).toBe("active");
    expect(engagementState(record, "2026-11-15T00:00:00Z")).toBe("exhausted");
    expect(engagementState({ ...record, exhausted_at: undefined }, "2026-12-01T00:00:00Z")).toBe("terminated");
    expect(refusal(() => checkAdmission(record, "2026-11-15T00:00:00Z")).section).toBe("5.5.5");
  });

  it("names each document's state: template, standing proposal, agreed, amended", () => {
    const { standing } = offer();
    expect(documentState(directed())).toBe("template");
    expect(documentState(standing)).toBe("standing_proposal");
    const doc = formed();
    expect(documentState(doc, undefined, "2026-09-01T00:00:00Z")).toBe("agreed");
    expect(documentState(doc, undefined, "2026-09-11T00:00:00Z")).toBe("active");
  });
});

describe("§5.8 change control", () => {
  const PROPOSED = "2026-10-01T00:00:00Z";
  const RECEIVED = "2026-10-01T00:00:05Z";

  /** A full replacement one version up, dated PROPOSED in its signed change_control, signed by the proposer. */
  function propose(record: SowEngagementRecord, by: "client" | "provider", change: (d: SowDocument) => void = () => {}, signer?: ReturnType<typeof signerFromRawSeed>) {
    const { signatures: _s, ...current } = record.agreed[record.agreed.length - 1]!;
    const next: SowDocument = { ...structuredClone(current), version: current.version + 1 };
    next.change_control = { ...(next.change_control as object), proposed_at: PROPOSED };
    change(next);
    return signSow(next, signer ?? (by === "client" ? client : provider), by, PROPOSED);
  }
  const open = (agreed: SowDocument, proposal: SowDocument): SowEngagementRecord => ({ agreed: [agreed], proposal: { document: proposal, by: "client", received_at: RECEIVED } });

  it("takes a full replacement one version higher with the proposer's one signature, and refuses what changes the fixed members", () => {
    const record: SowEngagementRecord = { agreed: [formed()] };
    const ok = propose(record, "client", (d) => { d.volume = { per_hour: 10, per_day: 50, grade: "enforced" }; });
    expect(() => checkAmendmentProposal(record, ok, "client", RECEIVED)).not.toThrow();
    expect(refusal(() => checkAmendmentProposal(record, propose(record, "client", (d) => { d.version = 3; }), "client", RECEIVED)).section).toBe("5.8");
    expect(refusal(() => checkAmendmentProposal(record, propose(record, "client", (d) => { d.starts_at = "2026-09-11T00:00:00Z"; delete d.term_months; }), "client", RECEIVED)).section).toBe("5.8");
    expect(refusal(() => checkAmendmentProposal(record, ok, "provider", RECEIVED)).section).toBe("5.8");
    expect(refusal(() => checkAmendmentProposal(open(record.agreed[0]!, ok), ok, "client", RECEIVED)).message).toMatch(/at most one/);
  });

  it("refuses a proposal without its signed proposed_at, and one dated later than it was received", () => {
    const record: SowEngagementRecord = { agreed: [formed()] };
    const undated = propose(record, "client", (d) => { delete (d.change_control as Record<string, unknown>).proposed_at; });
    expect(refusal(() => checkAmendmentProposal(record, undated, "client", RECEIVED)).section).toBe("5.8");
    const forward = propose(record, "client", (d) => { (d.change_control as Record<string, unknown>).proposed_at = "2026-10-05T00:00:00Z"; });
    expect(refusal(() => checkAmendmentProposal(record, forward, "client", RECEIVED)).message).toMatch(/forward-dated/);
  });

  it("ties a proposal's signature to the proposing role's key on the agreed engagement", () => {
    const record: SowEngagementRecord = { agreed: [formed()] };
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    const forged = propose(record, "client", (d) => { d.volume = { per_hour: 3, grade: "enforced" }; }, stranger);
    expect(refusal(() => checkAmendmentProposal(record, forged, "client", RECEIVED)).message).toMatch(/not the client's/);
  });

  it("forms the new version only when the proposer receives the approval before the lapse instant, or accepts a late one", () => {
    const agreed = formed();
    const proposal = propose({ agreed: [agreed] }, "client", (d) => { d.ends_at = "2027-09-10T00:00:00Z"; });
    const record = open(agreed, proposal);
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    const byStranger = signSow(proposal, stranger, "provider").signatures!.find((s) => s.role === "provider")!;
    expect(refusal(() => resolveAmendment(record, { kind: "approve", signature: byStranger, received_at: "2026-10-02T00:00:00Z", personConfirmed: true })).message).toMatch(/not the provider's/);
    const countersign = signSow(proposal, provider, "provider").signatures!.find((s) => s.role === "provider")!;
    // review_window_days is 7 and the proposal is dated 2026-10-01: it lapses at 2026-10-08.
    expect(amendmentLapsesAt({ proposed_at: PROPOSED, review_window_days: 7 })).toBe("2026-10-08T00:00:00Z");
    expect(refusal(() => resolveAmendment(record, { kind: "approve", signature: countersign, received_at: "2026-10-08T00:00:00Z", personConfirmed: true })).message).toMatch(/lapse instant/);
    expect(resolveAmendment(record, { kind: "approve", signature: countersign, received_at: "2026-10-08T00:00:00Z", accept_late: true, personConfirmed: true }).agreed).toHaveLength(2);
    expect(resolveAmendment(record, { kind: "approve", signature: countersign, received_at: "2026-10-07T23:59:59Z", personConfirmed: true }).agreed).toHaveLength(2);
  });

  it("lapses after 7 days where the clause states no window", () => {
    expect(amendmentLapsesAt({ proposed_at: PROPOSED })).toBe("2026-10-08T00:00:00Z");
    expect(DEFAULT_REVIEW_WINDOW_DAYS).toBe(7);
  });

  /** The proposer here is the client, and the counterparty the provider; the acknowledgement's deadline is the approval's receipt plus 7 days. */
  const DEADLINE = "2026-10-09T00:00:00Z";
  type Who = ReturnType<typeof signerFromRawSeed>;
  /** The messages about an approval name its engagement, its version and the digest of its signed bytes (0.29.0-draft). */
  const about = (approved: SowDocument, version: number) => ({ engagement: approved.id, version, digest: formationDigest(approved) });
  const ackOf = (approved: SowDocument, formed: boolean, version = 2, signer: Who = client) =>
    signFormationMessage({ kind: "acknowledgement", ...about(approved, version), formed, ...(formed ? { deadline: DEADLINE } : {}) }, signer, "client");
  const voidOf = (approved: SowDocument, version = 2, signer: Who = client) =>
    signFormationMessage({ kind: "void", ...about(approved, version), deadline: DEADLINE }, signer, "client");
  const receiptOf = (approved: SowDocument, of: "acknowledgement" | "void", version = 2, signer: Who = provider) =>
    signFormationMessage({ kind: "receipt", of, ...about(approved, version) }, signer, "provider");
  function amended() {
    const agreed = formed();
    const proposal = propose({ agreed: [agreed] }, "client", (d) => { d.ends_at = "2027-09-10T00:00:00Z"; delete d.term_months; });
    const approved = signSow(proposal, provider, "provider");
    return { agreed, proposal, approved, countersign: approved.signatures!.find((s) => s.role === "provider")! };
  }

  it("lets the counterparty apply only the proposal it holds open, one version up, with exactly the proposer's signature and one approval", () => {
    const { agreed, proposal, approved } = amended();
    const record = open(agreed, proposal);
    expect(applyAcknowledgement(record, approved, ackOf(approved, false))).toMatchObject({ outcome: "not_formed", receipt_due: false });
    expect(applyAcknowledgement(record, approved, ackOf(approved, false)).record.agreed).toHaveLength(1);
    const applied = applyAcknowledgement(record, approved, ackOf(approved, true));
    expect(applied).toMatchObject({ outcome: "applied", receipt_due: true });
    expect(applied.record.agreed.map((d) => d.version)).toEqual([1, 2]);
    // It records the acknowledgement's version and deadline, and whose void alone can undo it.
    expect(applied.record.applied_formation).toEqual({ version: 2, digest: formationDigest(approved), deadline: DEADLINE, by: "client", key: client.getPublicKey() });
    expect(receiptFor(applied.record, "acknowledgement")).toEqual({ kind: "receipt", of: "acknowledgement", ...about(approved, 2) });
    expect(refusal(() => applyAcknowledgement(record, approved, ackOf(approved, true, 3))).section).toBe("5.8");
    // Nothing open: nothing to settle.
    expect(refusal(() => applyAcknowledgement({ agreed: [agreed] }, approved, ackOf(approved, true))).message).toMatch(/no open proposal/);
    // Bytes that are not the open proposal's.
    const other = signSow({ ...proposal, ends_at: "2027-12-10T00:00:00Z" }, provider, "provider");
    expect(refusal(() => applyAcknowledgement(record, other, ackOf(other, true))).message).toMatch(/byte for byte/);
    // A third signature, or an approval by another key.
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    const padded = { ...approved, signatures: [...approved.signatures!, { ...approved.signatures![1]!, role: "provider" as const }] };
    expect(refusal(() => applyAcknowledgement(record, padded, ackOf(approved, true))).message).toMatch(/one approval/);
    const byStranger = signSow(proposal, stranger, "provider");
    expect(refusal(() => applyAcknowledgement(record, byStranger, ackOf(approved, true))).message).toMatch(/not the provider's/);
    // An acknowledgement the proposer did not sign, or one changed after it signed.
    expect(refusal(() => applyAcknowledgement(record, approved, ackOf(approved, true, 2, stranger))).section).toBe("6");
    const moved = { ...ackOf(approved, true), deadline: "2027-01-01T00:00:00Z" };
    expect(refusal(() => applyAcknowledgement(record, approved, moved)).section).toBe("6");
    // One about other bytes, or carrying a member §5.8 does not define.
    const elsewhere = signFormationMessage({ kind: "acknowledgement", ...about(approved, 2), digest: formationDigest(agreed), formed: true, deadline: DEADLINE }, client, "client");
    expect(refusal(() => applyAcknowledgement(record, approved, elsewhere)).message).toMatch(/digest/);
    const noted = { ...ackOf(approved, true), note: "thanks" } as unknown as SowAcknowledgement;
    expect(refusal(() => applyAcknowledgement(record, approved, noted)).kind).toBe("invalid");
  });

  it("answers a copy of the acknowledgement with another receipt once it already applied those bytes, so a lost receipt undoes nothing", () => {
    const { agreed, proposal, approved } = amended();
    const { record: applied } = applyAcknowledgement(open(agreed, proposal), approved, ackOf(approved, true));
    // The receipt was lost and the proposer re-sends the acknowledgement a day later.
    const again = applyAcknowledgement(applied, approved, ackOf(approved, true));
    expect(again).toEqual({ record: applied, outcome: "already_applied", receipt_due: true });
    // Only exactly the bytes that govern, and only from the proposer.
    const other = signSow({ ...proposal, ends_at: "2027-12-10T00:00:00Z" }, provider, "provider");
    expect(refusal(() => applyAcknowledgement(applied, other, ackOf(approved, true))).message).toMatch(/no open proposal/);
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    expect(refusal(() => applyAcknowledgement(applied, approved, ackOf(approved, true, 2, stranger))).section).toBe("6");
  });

  it("keeps a proposal it approved, approved and awaiting the acknowledgement, past the lapse instant until the latest deadline", () => {
    const { agreed, proposal, approved, countersign } = amended();
    // The counterparty's side: it approves just before the lapse instant, 2026-10-08.
    const mine = approveProposal(open(agreed, proposal), countersign, "2026-10-07T23:00:00Z");
    expect(amendmentState(mine)).toBe("approved_awaiting_acknowledgement");
    expect(versionForOwnActs(mine).version).toBe(1);
    expect(approvalHeldUntil(mine)).toBe("2026-10-15T00:00:00Z");
    expect(refusal(() => resolveAmendment(mine, { kind: "lapse", now: "2026-10-08T00:00:00Z" })).message).toMatch(/keeps it for the proposer's acknowledgement/);
    expect(refusal(() => resolveAmendment(mine, { kind: "deny", by: "provider", reason: "changed my mind" })).message).toMatch(/approved/);
    // The acknowledgement arrives after the lapse instant and still applies.
    expect(applyAcknowledgement(mine, approved, ackOf(approved, true)).outcome).toBe("applied");
    // An approved version carrying another approval than the one this side made is refused.
    const later = signSow(proposal, provider, "provider", "2026-10-08T00:00:00Z");
    expect(refusal(() => applyAcknowledgement(mine, later, ackOf(approved, true))).message).toMatch(/other than the one this side made/);
    // With no acknowledgement by then, the proposal lapses.
    expect(resolveAmendment(mine, { kind: "lapse", now: "2026-10-15T00:00:00Z" }).proposal).toBeUndefined();
    // Only the counterparty approves, once, with its key.
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    const byStranger = signSow(proposal, stranger, "provider").signatures!.find((s) => s.role === "provider")!;
    expect(refusal(() => approveProposal(open(agreed, proposal), byStranger, "2026-10-02T00:00:00Z")).section).toBe("6");
    expect(refusal(() => approveProposal(mine, countersign, "2026-10-07T23:00:01Z")).message).toMatch(/already approved/);
  });

  it("lets only the proposer's signed void undo the formation it applied, and only once the deadline passed", () => {
    const { agreed, proposal, approved } = amended();
    const { record: applied } = applyAcknowledgement(open(agreed, proposal), approved, ackOf(approved, true));
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    expect(refusal(() => applyVoid(applied, voidOf(approved), "2026-10-08T23:59:59Z")).message).toMatch(/before the acknowledgement's deadline/);
    expect(refusal(() => applyVoid(applied, voidOf(approved, 2, stranger), DEADLINE)).section).toBe("6");
    // A void comes from the proposer's seat only, and names the deadline this side applied.
    const fromCounterparty = signFormationMessage({ kind: "void", ...about(approved, 2), deadline: DEADLINE }, provider, "provider");
    expect(refusal(() => applyVoid(applied, fromCounterparty, DEADLINE)).message).toMatch(/proposer's seat/);
    const otherDeadline = signFormationMessage({ kind: "void", ...about(approved, 2), deadline: "2026-10-08T00:00:00Z" }, client, "client");
    expect(refusal(() => applyVoid(applied, otherDeadline, DEADLINE)).message).toMatch(/names the deadline/);
    expect(refusal(() => applyVoid(applied, voidOf(approved, 1), DEADLINE)).message).toMatch(/nothing to void/);
    // No acknowledgement applied here: a void undoes nothing, even of the governing version.
    expect(refusal(() => applyVoid({ agreed: [agreed] }, voidOf(approved, 1), DEADLINE)).message).toMatch(/nothing to void/);
    const done = applyVoid(applied, voidOf(approved), "2026-10-09T00:00:01Z");
    expect(done).toMatchObject({ outcome: "voided", receipt_due: true });
    expect(done.record.agreed.map((d) => d.version)).toEqual([1]);
    expect(done.record.applied_formation).toBeUndefined();
    expect(receiptFor(done.record, "void")).toEqual({ kind: "receipt", of: "void", ...about(approved, 2) });
    // Every copy of the void gets a receipt (0.28.0-draft), and undoes nothing more.
    expect(applyVoid(done.record, voidOf(approved), "2026-10-10T00:00:01Z")).toEqual({ record: done.record, outcome: "already_voided", receipt_due: true });
  });

  it("holds the proposer formed, unacknowledged until a signed receipt, then voids, re-sends the void until a receipt of it, and answers the voided version with it", () => {
    const { agreed, proposal, approved, countersign } = amended();
    const after = resolveAmendment(open(agreed, proposal), { kind: "approve", signature: countersign, received_at: "2026-10-02T00:00:00Z", personConfirmed: true });
    expect(amendmentState(after)).toBe("formed_unacknowledged");
    expect(after.acknowledgement_due).toEqual({ version: 2, formed: true, deadline: DEADLINE, to: "provider", digest: formationDigest(approved) });
    expect(acknowledgementFor(after)).toEqual({ kind: "acknowledgement", ...about(approved, 2), formed: true, deadline: DEADLINE });
    expect(versionForOwnActs(after).version).toBe(1);
    expect(versionForRequest(after, 2).version).toBe(2);
    expect(versionForRequest(after, 1).version).toBe(1);
    // The receipt: the new version for everything.
    const settled = receiptReceived(after, receiptOf(approved, "acknowledgement"), "2026-10-02T00:00:10Z");
    expect(amendmentState(settled)).toBe("none");
    expect(versionForOwnActs(settled).version).toBe(2);
    expect(refusal(() => receiptReceived(after, receiptOf(approved, "acknowledgement"), DEADLINE)).message).toMatch(/void/);
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    expect(refusal(() => receiptReceived(after, receiptOf(approved, "acknowledgement", 2, stranger), "2026-10-02T00:00:10Z")).section).toBe("6");
    // No receipt by the deadline: the proposer voids, and owes the void until it holds a receipt of it.
    expect(refusal(() => voidFormation(after, "2026-10-08T00:00:00Z")).section).toBe("5.8");
    const voided = voidFormation(after, DEADLINE);
    expect(voided.agreed.map((d) => d.version)).toEqual([1]);
    expect(amendmentState(voided)).toBe("voided_unreceipted");
    expect(voidFor(voided)).toEqual({ kind: "void", ...about(approved, 2), deadline: DEADLINE });
    // A request that names the voided version is answered with the void; one that names the current version is admitted.
    expect(answerRequest(voided, 2)).toEqual({ admitted: false, answered_with: "void", version: 2 });
    expect(answerRequest(voided, 1)).toMatchObject({ admitted: true, version: { version: 1 } });
    // A receipt of the void ends the re-sending, and the voided version is still answered with it.
    expect(refusal(() => receiptReceived(voided, receiptOf(approved, "void", 3), "2026-10-09T00:00:05Z")).section).toBe("5.8");
    const closed = receiptReceived(voided, receiptOf(approved, "void"), "2026-10-09T00:00:05Z");
    expect(amendmentState(closed)).toBe("none");
    expect(answerRequest(closed, 2).admitted).toBe(false);
  });

  it("runs a proposal under the governing version's window, which the proposal may shorten and not lengthen", () => {
    const agreed = formed();
    const long = propose({ agreed: [agreed] }, "client", (d) => { (d.change_control as Record<string, unknown>).review_window_days = 3650; });
    const short = propose({ agreed: [agreed] }, "client", (d) => { (d.change_control as Record<string, unknown>).review_window_days = 2; });
    expect(reviewWindowDays(agreed, long)).toBe(7);
    expect(reviewWindowDays(agreed, short)).toBe(2);
    expect(proposalLapsesAt(agreed, long)).toBe("2026-10-08T00:00:00Z");
    expect(proposalLapsesAt(agreed, short)).toBe("2026-10-03T00:00:00Z");
    const record = open(agreed, long);
    expect(refusal(() => resolveAmendment(record, { kind: "lapse", now: "2026-10-07T23:59:59Z" })).section).toBe("5.8");
    expect(resolveAmendment(record, { kind: "lapse", now: "2026-10-08T00:00:00Z" }).proposal).toBeUndefined();
  });

  it("lets a legacy engagement be amended to add each seat's owner_key, the key that signed for it, and nothing else, where the registry confirms both owners", async () => {
    // An engagement written before 0.26.0-draft: no seat names a key.
    const doc = directed();
    const named = doc.parties.offered_to!;
    const legacyInstance = completedInstance(signSow(doc, provider, "provider"), { client: { agent: named.agent, owner: named.owner }, starts_at: "2026-09-10T00:00:00Z" });
    const legacy = signSow(signSow(legacyInstance, client, "client"), provider, "provider");
    expect(sowAgreed(legacy)).toBe(true);
    const record: SowEngagementRecord = { agreed: [legacy] };
    const keyed = (clientKey: string) =>
      propose(record, "client", (d) => {
        d.parties = { ...d.parties, provider: { ...d.parties.provider, owner_key: provider.getPublicKey() }, client: { ...d.parties.client!, owner_key: clientKey } };
      });
    const upgrade = keyed(client.getPublicKey());
    // The registry's answer for both seats, at receipt.
    const attested = (owners: Record<string, string>) => ({ ownerOf: async (agent: string) => (owners[agent] ? { owner: owners[agent]!, attested: true } : null) });
    const both = { [legacy.parties.provider.agent]: provider.getPublicKey(), [legacy.parties.client!.agent]: client.getPublicKey() };
    const confirmed = await seatOwners(upgrade, attested(both));
    expect(confirmed).toEqual({ provider: "confirmed", client: "confirmed" });
    expect(() => checkAmendmentProposal(record, upgrade, "client", RECEIVED, confirmed)).not.toThrow();
    // Without the registry's word on both seats, the upgrade binds nothing.
    expect(refusal(() => checkAmendmentProposal(record, upgrade, "client", RECEIVED)).message).toMatch(/registry/);
    const clientUnlisted = await seatOwners(upgrade, attested({ [legacy.parties.provider.agent]: provider.getPublicKey() }));
    expect(refusal(() => checkAmendmentProposal(record, upgrade, "client", RECEIVED, clientUnlisted)).message).toMatch(/client seat .* unconfirmed/);
    const providerContradicted = await seatOwners(upgrade, attested({ ...both, [legacy.parties.provider.agent]: client.getPublicKey() }));
    expect(refusal(() => checkAmendmentProposal(record, upgrade, "client", RECEIVED, providerContradicted)).message).toMatch(/provider seat .* contradicted/);
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    expect(refusal(() => checkAmendmentProposal(record, keyed(stranger.getPublicKey()), "client", RECEIVED, confirmed)).section).toBe("6");
    // An engagement whose seats already name keys keeps them.
    const bound: SowEngagementRecord = { agreed: [formed()] };
    const rekey = propose(bound, "client", (d) => { d.parties = { ...d.parties, client: { ...d.parties.client!, owner_key: stranger.getPublicKey() } }; });
    expect(refusal(() => checkAmendmentProposal(bound, rekey, "client", RECEIVED)).section).toBe("6");
    expect(addsOwnerKeys(bound.agreed[0]!, rekey)).toBe(false);
  });

  it("forms nothing new from a document written before 0.26.0-draft, or from a template its provider did not sign", () => {
    const legacyDoc = signSow(directed(), provider, "provider");
    const named = legacyDoc.parties.offered_to!;
    const legacyParty: SowParty = { agent: named.agent, owner: named.owner };
    const req = signSow(completedInstance(legacyDoc, { client: legacyParty, starts_at: "2026-09-10T00:00:00Z" }), client, "client");
    expect(refusal(() => checkFormation(legacyDoc, req, { now: "2026-09-05T00:00:00Z", clientOwner: "confirmed" })).message).toMatch(/record/);
    const party: SowParty = { ...legacyParty, owner_key: client.getPublicKey() };
    const { standing } = offer();
    const { signatures: _s, ...unsigned } = standing;
    const req2 = request(standing, party);
    expect(refusal(() => checkFormation(unsigned as SowDocument, req2, { now: "2026-09-05T00:00:00Z", clientOwner: "confirmed" })).message).toMatch(/not authenticated/);
  });

  it("lets only the client change its buyer reference", () => {
    const record: SowEngagementRecord = { agreed: [formed()] };
    expect(() => checkAmendmentProposal(record, propose(record, "client", (d) => { d.buyer_reference = "PO-2027-000120"; }), "client", RECEIVED)).not.toThrow();
    expect(refusal(() => checkAmendmentProposal(record, propose(record, "provider", (d) => { delete d.buyer_reference; }), "provider", RECEIVED)).section).toBe("5.17");
  });

  it("becomes the agreed version on the counterparty's countersign, here with the person this engagement's amendments need", () => {
    const agreed = formed();
    const proposal = propose({ agreed: [agreed] }, "client", (d) => { d.ends_at = "2027-09-10T00:00:00Z"; });
    const record = open(agreed, proposal);
    const countersign = signSow(proposal, provider, "provider", "2026-10-02T00:00:00Z").signatures!.find((s) => s.role === "provider")!;
    expect(refusal(() => resolveAmendment(record, { kind: "approve", signature: countersign, received_at: "2026-10-02T00:00:00Z" })).section).toBe("6.1");
    const after = resolveAmendment(record, { kind: "approve", signature: countersign, received_at: "2026-10-02T00:00:00Z", personConfirmed: true });
    expect(after.proposal).toBeUndefined();
    expect(after.agreed.map((d) => d.version)).toEqual([1, 2]);
    expect(documentState(agreed, after, "2026-10-03T00:00:00Z")).toBe("amended");
    // The renewal is in force: the term now runs a year longer.
    expect(engagementState(after, "2027-06-01T00:00:00Z")).toBe("active");
  });

  it("refuses an unreasoned denial, a withdrawal by anyone but the proposer, and a lapse before the window closes", () => {
    const agreed = formed();
    const proposal = propose({ agreed: [agreed] }, "client", (d) => { d.volume = { per_hour: 1, grade: "enforced" }; });
    const record = open(agreed, proposal);
    expect(refusal(() => resolveAmendment(record, { kind: "deny", by: "provider", reason: "  " })).message).toMatch(/unreasoned/);
    expect(resolveAmendment(record, { kind: "deny", by: "provider", reason: "the volume is too low to staff" }).agreed).toHaveLength(1);
    expect(refusal(() => resolveAmendment(record, { kind: "withdraw", by: "provider" })).section).toBe("5.8");
    expect(resolveAmendment(record, { kind: "withdraw", by: "client" }).proposal).toBeUndefined();
    expect(refusal(() => resolveAmendment(record, { kind: "lapse", now: "2026-10-07T00:00:00Z" })).section).toBe("5.8");
    expect(resolveAmendment(record, { kind: "lapse", now: "2026-10-08T00:00:00Z" }).proposal).toBeUndefined();
  });
});

describe("§6 signatures: canonical padded base64, bound to owner_key where the seats name one", () => {
  it("writes 88 characters ending ==, and verifies an older document's base64url as written", () => {
    const doc = formed();
    for (const s of doc.signatures!) expect(s.sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    const legacy = structuredClone(pricing.signing.signed) as SowDocument;
    const asUrl = { ...legacy.signatures![0]!, sig: Buffer.from(legacy.signatures![0]!.sig, "base64").toString("base64url") };
    expect(asUrl.sig).not.toMatch(/=$/);
    expect(verifySowSignature(legacy, asUrl)).toBe(true);
    expect(signatureStatus(legacy, asUrl)).toBe("unbound");
  });

  it("on a document whose seats name owner_key, counts only canonical signatures made with the seat's key", () => {
    const { standing, party } = offer((d) => { d.parties.provider = { ...d.parties.provider, owner_key: provider.getPublicKey() }; });
    const instance = completedInstance(standing, { client: { ...party, owner_key: client.getPublicKey() }, starts_at: "2026-09-10T00:00:00Z" });
    const both = signSow(signSow(instance, client, "client"), provider, "provider");
    expect(sowAgreed(both)).toBe(true);
    // Another key's valid signature is not the seat's.
    const stranger = signerFromRawSeed(new Uint8Array(randomBytes(32)));
    expect(sowAgreed(signSow(both, stranger, "client"))).toBe(false);
    // The same bytes spelled base64url do not count on an owner-keyed document.
    const url = both.signatures!.map((s) => ({ ...s, sig: Buffer.from(s.sig, "base64").toString("base64url") }));
    expect(sowAgreed({ ...both, signatures: url })).toBe(false);
  });

  it("forms an owner-keyed engagement only for a client owner the registry confirms", async () => {
    const { standing, party } = offer((d) => { d.parties.provider = { ...d.parties.provider, owner_key: provider.getPublicKey() }; });
    const req = signSow(completedInstance(standing, { client: { ...party, owner_key: client.getPublicKey() }, starts_at: "2026-09-10T00:00:00Z" }), client, "client");
    const registry = (owner: string | null, attested = true) => ({ ownerOf: async () => (owner ? { owner, attested } : null) });
    const confirmed = (await seatOwners(req, registry(client.getPublicKey()))).client;
    expect(confirmed).toBe("confirmed");
    expect(checkFormation(standing, req, { now: "2026-09-05T00:00:00Z", clientOwner: confirmed })).toEqual({ ready: true });
    for (const [answer, state] of [[registry(provider.getPublicKey()), "contradicted"], [registry(client.getPublicKey(), false), "unconfirmed"], [registry(null), "unconfirmed"]] as const) {
      const got = (await seatOwners(req, answer)).client;
      expect(got).toBe(state);
      expect(refusal(() => checkFormation(standing, req, { now: "2026-09-05T00:00:00Z", clientOwner: got })).section).toBe("6");
    }
    // A client seat without its owner_key, beside a provider seat with one, does not validate.
    const { owner_key: _k, ...unkeyed } = party;
    const halfKeyed = signSow(completedInstance(standing, { client: unkeyed, starts_at: "2026-09-10T00:00:00Z" }), client, "client");
    expect(refusal(() => checkFormation(standing, halfKeyed, { now: "2026-09-05T00:00:00Z", clientOwner: "confirmed" })).section).toBe("5.1");
  });
});

describe("§5.9 termination and §5.5.5 the cap", () => {
  it("takes effect after the notice for convenience, at once for cause, and for cause records its reason", () => {
    const doc = formed();
    expect(terminationEffect(doc, { by: "client", for_cause: false, at: "2026-10-01T00:00:00Z" })).toEqual({ effective_at: "2026-10-02T00:00:00Z", in_flight: "complete_and_pay" });
    expect(refusal(() => terminationEffect(doc, { by: "client", for_cause: true, at: "2026-10-01T00:00:00Z" })).section).toBe("5.9");
    expect(terminationEffect(doc, { by: "client", for_cause: true, reason: "a missed deliverable", at: "2026-10-01T00:00:00Z" })).toEqual({ effective_at: "2026-10-01T00:00:00Z", in_flight: "cancel" });
  });

  it("gives no notice where the clause states none, and never runs notice past the engagement's end", () => {
    const doc = formed();
    const { termination: _t, ...noClause } = doc as unknown as Record<string, unknown>;
    expect(convenienceNoticeHours(noClause)).toBe(0);
    expect(terminationEffect(noClause as unknown as typeof doc, { by: "client", for_cause: false, at: "2026-10-01T00:00:00Z" }))
      .toEqual({ effective_at: "2026-10-01T00:00:00Z", in_flight: "complete_and_pay" });
    const endsSoon = { ...doc, ends_at: "2026-10-01T06:00:00.250Z" };
    expect(terminationEffect(endsSoon, { by: "client", for_cause: false, at: "2026-10-01T00:00:00Z" }))
      .toEqual({ effective_at: "2026-10-01T06:00:00.250Z", in_flight: "complete_and_pay" });
  });

  it("admits nothing once the cap is reached, naming the cap", () => {
    const price = pricing.signing.document.price as SowTimeAndMaterialsPrice;
    expect(() => checkUnderCap(price, price.cap.amount - 1)).not.toThrow();
    const r = refusal(() => checkUnderCap(price, price.cap.amount));
    expect(r.kind).toBe("refused");
    expect(r.message).toContain(String(price.cap.amount));
  });
});
