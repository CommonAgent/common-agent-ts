// A third review of this core: each finding reproduced, with the answer Agent NDA
// 0.2.0-draft gives.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptOffer,
  agreementDigest,
  checkBreachClaim,
  checkGateRelease,
  deriveState,
  isBound,
  mintId,
  referenceTo,
  signAct,
  signAgreement,
  signerFromSeed,
  type ActBody,
  type Agreement,
  type GateRequest,
  type MandateLookup,
  type OwnerResolver,
  type Seat,
} from "../index.js";

const S = (n: string) => signerFromSeed(new Uint8Array(createHash("sha256").update("review3 " + n).digest()));
const A = (n: string) => S("agent " + n).getPublicKey();
const seat = (n: string): Seat => ({ agent: A(n), owner: n, owner_key: S(n).getPublicKey() });
const orgSeat = (n: string): Seat => ({ agent: A(n), owner: n, organization: "org_" + n });
const REG = new Map(["D", "R", "Mallory"].map((n) => [A(n), { owner: S(n).getPublicKey(), attested: true }]));
const owners: OwnerResolver = (a) => REG.get(a);
const ok: MandateLookup = () => "ok";
const base = (parties: Agreement["parties"], extra: Partial<Agreement> = {}): Agreement => {
  const d = {
    nda: "v1",
    id: "",
    version: 1,
    language: { id: "l", version: 1, sha256: "0".repeat(64) },
    direction: "one_way",
    parties,
    effective_at: null,
    ends_at: "2031-01-01T00:00:00Z",
    purpose: { statement: "x", activities: ["negotiation"], grade: "recorded" },
    covers: { categories: ["inputs"], grade: "recorded" },
    disclosure: { subcontractors: "none", need_to_know: [], grade: "recorded" },
    signatures: [],
    ...extra,
  } as Agreement;
  d.id = mintId(d);
  return d;
};
const openOffer = (offer: Partial<NonNullable<Agreement["offer"]>> = {}, discloser: Seat = seat("D"), mandate?: string) =>
  signAgreement(
    base({ discloser, recipient: null, grade: "evidence" }, {
      offer: { open_to: "any", expires_at: "2029-03-01T00:00:00Z", ...offer },
      disclosure: { recipient: null, subcontractors: "none", grade: "recorded" },
    }),
    S("D"),
    { role: "discloser", signedAt: "2029-01-01T00:00:00Z", mandate },
  );
const accept = (o: Agreement, recipient: Seat = seat("R"), mandate?: string) =>
  acceptOffer(o, S("R"), { seat: recipient, declaration: {}, signedAt: "2029-02-01T00:00:00Z", mandate });
const now = "2029-06-01T00:00:00Z";

describe("the third review", () => {
  it("1. the gate releases nothing unless every organization's mandate checked at signing and at receipt", () => {
    const o = openOffer({}, orgSeat("D"), "mnd_poster");
    const a = accept(o);
    const req: GateRequest = { gate: referenceTo(o), presented: a, posterAgent: A("D"), requesterAgent: A("R"), now: "2029-02-02T00:00:00Z", receivedAt: "2029-02-01T00:00:00Z", owners };
    // The poster's own seat names an organization: no lookup, or an unknown answer, releases nothing.
    expect(checkGateRelease(req)).toMatchObject({ release: false, check: 1 });
    expect(checkGateRelease({ ...req, mandates: () => "unknown" })).toMatchObject({ release: false, check: 1 });
    // A mandate in force when the offer was signed and revoked before the board received the acceptance.
    const revokedAtReceipt: MandateLookup = (q) => (Date.parse(q.at) < Date.parse("2029-01-20T00:00:00Z") ? "ok" : "refused");
    expect(checkGateRelease({ ...req, mandates: revokedAtReceipt })).toMatchObject({ release: false, check: 1 });
    expect(checkGateRelease({ ...req, mandates: ok })).toMatchObject({ release: true, owner: "confirmed" });
  });

  it("2. the gate refuses without the instant it received the acceptance", () => {
    const o = openOffer();
    const a = accept(o);
    const req = { gate: referenceTo(o), presented: a, posterAgent: A("D"), requesterAgent: A("R"), now: "2029-02-02T00:00:00Z", owners } as unknown as GateRequest;
    expect(checkGateRelease(req)).toMatchObject({ release: false, check: 1 });
    // An acceptance that says it was signed in time but reached the board after expiry.
    expect(checkGateRelease({ ...req, receivedAt: "2029-03-02T00:00:00Z" })).toMatchObject({ release: false, check: 1 });
    expect(checkGateRelease({ ...req, receivedAt: "2029-02-01T00:00:05Z" })).toMatchObject({ release: true, signedAtOnly: false });
  });

  it("3a. a claim of breach reads a termination's effect from its receipt", () => {
    const d = signAgreement(
      signAgreement(base({ discloser: seat("D"), recipient: seat("R"), grade: "evidence" }, { termination: { notice_days: 30, grade: "evidence" } }), S("D"), {
        role: "discloser",
        signedAt: "2029-01-01T00:00:00Z",
      }),
      S("R"),
      { role: "recipient", signedAt: "2029-01-02T00:00:00Z" },
    );
    const body: ActBody = { nda: d.id, version: 1, digest: agreementDigest(d), action: "terminate", at: "2029-02-01T00:00:00Z", by: "recipient" };
    const t = signAct(body, S("R"), "2029-02-01T00:00:00Z");
    const claim = { claimant: A("D"), respondent: A("R"), categories: ["inputs" as const], disclosedAt: ["2029-03-15T00:00:00Z"] };
    // Read from `at`, the notice ran out on 2029-03-03, before the disclosure.
    expect(checkBreachClaim(referenceTo(d), d, claim, { now: "2029-12-01T00:00:00Z", acts: [t], owners })).toMatchObject({ ok: false, check: 7 });
    // The counterparty received the termination on 2029-04-01, so the notice ran from then.
    const withReceipt = checkBreachClaim(referenceTo(d), d, claim, {
      now: "2029-12-01T00:00:00Z",
      acts: [t],
      owners,
      actReceipts: () => "2029-04-01T00:00:00Z",
      receivedAt: "2029-01-02T00:00:01Z",
    });
    expect(withReceipt).toMatchObject({ ok: true, signedAtOnly: false });
  });

  it("3b. a later reader holding the acceptance's receipt applies it, and says when it held none", () => {
    const o = openOffer();
    const a = accept(o); // says 2029-02-01; reached its verifier after the offer expired
    const ref = referenceTo(o);
    const late = () => "2029-03-05T00:00:00Z";
    expect(isBound(ref, { agent: A("R") }, { documents: [a], now, owners })).toMatchObject({ bound: true, signedAtOnly: true });
    expect(isBound(ref, { agent: A("R") }, { documents: [a], now, owners, docReceipts: late })).toMatchObject({ bound: false });
    expect(isBound(ref, { agent: A("R") }, { documents: [a], now, owners, docReceipts: () => "2029-02-01T00:00:05Z" })).toMatchObject({ bound: true, signedAtOnly: false });
    expect(deriveState(a, { now, owners }).signedAtOnly).toBe(true);
    expect(deriveState(a, { now, owners, receivedAt: "2029-03-05T00:00:00Z" }).state).toBe("lapsed");
  });

  it("3c. the mandate is checked at the recorded receipt as well as at signing", () => {
    const o = openOffer({}, orgSeat("D"), "mnd_poster");
    const a = accept(o);
    const ref = referenceTo(o);
    const revokedBeforeReceipt: MandateLookup = (q) => (Date.parse(q.at) < Date.parse("2029-01-20T00:00:00Z") ? "ok" : "refused");
    expect(isBound(ref, { agent: A("R") }, { documents: [a], now, owners, mandates: revokedBeforeReceipt })).toMatchObject({ bound: true });
    expect(
      isBound(ref, { agent: A("R") }, { documents: [a], now, owners, mandates: revokedBeforeReceipt, docReceipts: () => "2029-02-01T00:00:05Z" }),
    ).toMatchObject({ bound: false });
  });

  it("4. a new mandate holder for an organization's seat can sign the amendment", () => {
    const mk = (version: number, holder: string, id?: string) => {
      let d = base({ discloser: orgSeat("D"), recipient: seat("R"), grade: "evidence" });
      if (id) d = { ...d, id, version };
      d = signAgreement(d, S(holder), { role: "discloser", signedAt: `2029-0${version}-01T00:00:00Z`, mandate: "mnd_" + holder });
      return signAgreement(d, S("R"), { role: "recipient", signedAt: `2029-0${version}-02T00:00:00Z` });
    };
    const v1 = mk(1, "alice");
    expect(deriveState(v1, { now, laterVersions: [mk(2, "alice", v1.id)], owners, mandates: ok }).state).toBe("amended");
    expect(deriveState(v1, { now, laterVersions: [mk(2, "bob", v1.id)], owners, mandates: ok }).state).toBe("amended");
    // A different organization in the seat is a different party.
    const other = (() => {
      let d = { ...base({ discloser: orgSeat("D2"), recipient: seat("R"), grade: "evidence" }), id: v1.id, version: 2 } as Agreement;
      d = { ...d, parties: { ...d.parties, discloser: { ...orgSeat("D"), organization: "org_other" } } };
      d = signAgreement(d, S("bob"), { role: "discloser", signedAt: "2029-02-01T00:00:00Z", mandate: "mnd_bob" });
      return signAgreement(d, S("R"), { role: "recipient", signedAt: "2029-02-02T00:00:00Z" });
    })();
    expect(deriveState(v1, { now, laterVersions: [other], owners, mandates: ok }).state).toBe("in force");
  });

  it("5. the gate needs an owner resolver, or an explicit statement that there is none", () => {
    const o = openOffer({ owners: "any" });
    const a = accept(o);
    const req = { gate: referenceTo(o), presented: a, posterAgent: A("D"), requesterAgent: A("R"), now: "2029-02-02T00:00:00Z", receivedAt: "2029-02-01T00:00:05Z" };
    expect(checkGateRelease(req as unknown as GateRequest)).toMatchObject({ release: false, check: 1 });
    expect(checkGateRelease({ ...req, owners: "none" })).toMatchObject({ release: true, owner: "unconfirmed" });
    const contradicted: OwnerResolver = (x) => (x === A("R") ? { owner: S("Mallory").getPublicKey(), attested: true } : REG.get(x));
    expect(checkGateRelease({ ...req, owners: contradicted })).toMatchObject({ release: false, check: 1 });
  });
});
