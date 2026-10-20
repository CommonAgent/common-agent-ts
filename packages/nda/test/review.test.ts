// Two reviews of this core: each finding reproduced, with the answer the
// specification gives, at Agent NDA 0.2.0-draft. Every seat carries its
// owner_key, the registry confirms each owner, and acts name their seat in
// `by` and sign their own record.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptOffer,
  agreementDigest,
  checkAct,
  decodeSig,
  deriveState,
  isBound,
  mintId,
  referenceTo,
  signAct,
  signAgreement,
  signerFromSeed,
  utf8,
  validateAgreement,
  verifyAcceptance,
  type ActBody,
  type Agreement,
  type OwnerResolver,
  type Seat,
} from "../index.js";

const S = (n: string) => signerFromSeed(new Uint8Array(createHash("sha256").update("review " + n).digest()));
const A = (n: string) => S("agent " + n).getPublicKey();
const seat = (n: string, keyOf = n): Seat => ({ agent: A(n), owner: n, owner_key: S(keyOf).getPublicKey() });
/** The registry confirms every party's own key as its agent's owner. */
const NAMES = ["D", "R", "A", "X", "S", "T", "M1", "M2", "M3", "M4", "M5", "X1", "X2", "X3", "E1", "E2"];
const REGISTRY = new Map(NAMES.map((n) => [A(n), { owner: S(n).getPublicKey(), attested: true }]));
const owners: OwnerResolver = (agent) => REGISTRY.get(agent);
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
    disclosure: { subcontractors: "bound", need_to_know: [], grade: "recorded" },
    signatures: [],
    ...extra,
  } as Agreement;
  d.id = mintId(d);
  return d;
};
const sign2 = (d: Agreement, a: string, b: string, at1 = "2029-01-01T00:00:00Z", at2 = "2029-01-02T00:00:00Z") =>
  signAgreement(signAgreement(d, S(a), { role: "discloser", signedAt: at1 }), S(b), { role: "recipient", signedAt: at2 });
const flowFrom = (up: Agreement, from: string, to: string) =>
  sign2(base({ discloser: seat(from), recipient: seat(to), grade: "evidence" }, { flows_from: { id: up.id, version: up.version, digest: agreementDigest(up) } }), from, to);
const act = (d: Agreement, who: string, body: Omit<ActBody, "nda" | "version" | "digest">, signedAt = body.at) =>
  signAct({ nda: d.id, version: d.version, digest: agreementDigest(d), ...body }, S(who), signedAt);
const multi = (names: string[], keys: Record<string, string> = {}) => {
  let m = base({ members: names.map((n) => seat(n, keys[n] ?? n)), grade: "evidence" }, { direction: "multilateral", disclosure: undefined });
  for (const n of names) m = signAgreement(m, S(keys[n] ?? n), { role: "member", agent: A(n), signedAt: "2029-01-01T00:00:00Z" });
  return m;
};
const now = "2029-06-01T00:00:00Z";

describe("the first review", () => {
  it("1. a flow-down binds only through an agreement that reaches the named one", () => {
    const N = sign2(base({ discloser: seat("D"), recipient: seat("A"), grade: "evidence" }), "D", "A");
    const U = sign2(base({ discloser: seat("X"), recipient: seat("A"), grade: "evidence" }, { purpose: { statement: "u", activities: ["negotiation"], grade: "recorded" } }), "X", "A");
    expect(isBound(referenceTo(N), { agent: A("S") }, { documents: [N, U, flowFrom(U, "A", "S")], now, owners }).bound).toBe(false);
    const fromN = flowFrom(N, "A", "S");
    expect(isBound(referenceTo(N), { agent: A("S") }, { documents: [N, fromN], now, owners })).toMatchObject({ bound: true, rule: 3 });
    // Two hops: S binds T under its own flow-down.
    expect(isBound(referenceTo(N), { agent: A("T") }, { documents: [N, fromN, flowFrom(fromN, "S", "T")], now, owners })).toMatchObject({ bound: true, rule: 3 });
  });

  it("2. a member who has left a multilateral agreement is not bound by it", () => {
    const d = multi(["M1", "M2", "M3"]);
    const leave = act(d, "M1", { action: "terminate", at: "2029-02-01T00:00:00Z", by: "member", agent: A("M1") });
    expect(isBound(referenceTo(d), { agent: A("M1") }, { documents: [d], acts: [leave], now, owners }).bound).toBe(false);
    expect(isBound(referenceTo(d), { agent: A("M2") }, { documents: [d], acts: [leave], now, owners }).bound).toBe(true);
  });

  it("3. a withdrawal made before the last signature leaves the agreement withdrawn", () => {
    const d = base({ discloser: seat("D"), recipient: seat("R"), grade: "evidence" });
    const full = sign2(d, "D", "R", "2029-01-01T00:00:00Z", "2029-01-10T00:00:00Z");
    const withdraw = (at: string) => act(d, "D", { action: "withdraw", at, by: "discloser" });
    expect(deriveState(full, { now, acts: [withdraw("2029-01-05T00:00:00Z")] }).state).toBe("withdrawn");
    expect(deriveState(full, { now, acts: [withdraw("2029-01-11T00:00:00Z")] }).state).toBe("in force");
  });

  it("4. an open offer sets disclosure.recipient to null, so it can be accepted", () => {
    const loose = base({ discloser: seat("D"), recipient: null, grade: "evidence" }, {
      offer: { open_to: "any", expires_at: "2030-01-01T00:00:00Z" },
      disclosure: { subcontractors: "none", grade: "recorded" },
    });
    const r = validateAgreement(signAgreement(loose, S("D"), { role: "discloser", signedAt: "2029-01-01T00:00:00Z" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual(expect.objectContaining({ code: "offer", path: "disclosure.recipient" }));
    const offer = signAgreement({ ...loose, disclosure: { ...loose.disclosure!, recipient: null } }, S("D"), { role: "discloser", signedAt: "2029-01-01T00:00:00Z" });
    expect(validateAgreement(offer).ok).toBe(true);
    const a = acceptOffer(offer, S("R"), { seat: seat("R"), declaration: { processed_in: ["us"] }, signedAt: "2029-02-01T00:00:00Z" });
    expect(verifyAcceptance(a, { owners })).toMatchObject({ ok: true, owner: "confirmed" });
  });

  it("5. an act counts only from the key bound to the seat it names", () => {
    const d = sign2(base({ discloser: seat("D"), recipient: seat("R"), grade: "evidence" }), "D", "R");
    const mallory = act(d, "Mallory", { action: "terminate", at: "2029-02-01T00:00:00Z", by: "recipient" });
    expect(checkAct(d, mallory, { owners }).ok).toBe(false);
    expect(deriveState(d, { now, acts: [mallory], owners }).state).toBe("in force");
    // The recipient's own key, naming the discloser's seat, is not that seat's either.
    expect(checkAct(d, act(d, "R", { action: "terminate", at: "2029-02-01T00:00:00Z", by: "discloser" }), { owners }).ok).toBe(false);
    expect(checkAct(d, act(d, "R", { action: "terminate", at: "2029-02-01T00:00:00Z", by: "recipient" }), { owners }).ok).toBe(true);
  });

  it("6. only a valid later version with the same parties and owner keys amends", () => {
    const d = sign2(base({ discloser: seat("D"), recipient: seat("R"), grade: "evidence" }), "D", "R");
    const v2 = (extra: Partial<Agreement>, a = "D", b = "R") => sign2({ ...d, version: 2, ...extra, signatures: [] }, a, b, "2029-03-01T00:00:00Z", "2029-03-02T00:00:00Z");
    const state = (v: Agreement) => deriveState(d, { now, laterVersions: [v], owners }).state;
    expect(state(v2({ parties: { discloser: seat("E1"), recipient: seat("E2"), grade: "evidence" } }, "E1", "E2"))).toBe("in force");
    expect(state(v2({ parties: { discloser: seat("D", "E1"), recipient: seat("R", "E2"), grade: "evidence" } }, "E1", "E2"))).toBe("in force");
    expect(state(v2({ covers: { categories: [], grade: "recorded" } }))).toBe("in force");
    expect(state(v2({ ends_at: "2032-01-01T00:00:00Z" }))).toBe("amended");
  });

  it("7. a broken acceptance reads as the offer, which may have lapsed", () => {
    const o = signAgreement(
      base({ discloser: seat("D"), recipient: null, grade: "evidence" }, {
        offer: { open_to: "any", expires_at: "2029-03-01T00:00:00Z" },
        disclosure: { recipient: null, subcontractors: "none", grade: "recorded" },
      }),
      S("D"),
      { role: "discloser", signedAt: "2029-01-01T00:00:00Z" },
    );
    const a = acceptOffer(o, S("R"), { seat: seat("R"), declaration: {}, signedAt: "2029-02-01T00:00:00Z" });
    const bad = { ...a, signatures: a.signatures.map((s) => (s.role === "recipient" ? { ...s, sig: a.signatures[0].sig } : s)) };
    expect(deriveState(bad, { now, owners }).state).toBe("lapsed");
    expect(deriveState(bad, { now: "2029-02-15T00:00:00Z", owners }).state).toBe("offered");
  });

  it("8. a signature has exactly one spelling: canonical padded base64 (6)", () => {
    const s = new Uint8Array(S("D").sign(utf8("m")));
    const b64 = Buffer.from(s).toString("base64");
    expect(decodeSig(b64)).toEqual(s);
    expect(decodeSig(b64.replace(/=+$/, ""))).toBeNull();
    expect(decodeSig(Buffer.from(s).toString("base64url"))).toBeNull();
    expect(decodeSig(Buffer.from(s).toString("base64url") + "==")).toBe(/[_-]/.test(Buffer.from(s).toString("base64url")) ? null : decodeSig(b64));
    // The last character carries two unused bits; setting one is another
    // spelling of the same bytes, and is refused.
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    expect(decodeSig(b64.slice(0, 85) + chars[chars.indexOf(b64[85]) ^ 1] + "==")).toBeNull();
    expect(decodeSig(b64.replace(/=+$/, "") + "=")).toBeNull();
    expect(decodeSig(b64.replace(/=+$/, "") + "AA")).toBeNull();
  });
});

describe("the first review, read again", () => {
  const d = sign2(base({ discloser: seat("D"), recipient: seat("R"), grade: "evidence" }), "D", "R", "2029-01-01T00:00:00Z", "2029-01-02T00:00:00Z");
  const withdraw = (who: "D" | "R", at: string, signedAt = at) => act(d, who, { action: "withdraw", at, by: who === "D" ? "discloser" : "recipient" }, signedAt);

  it("A. only the first signer can withdraw, and only before the other seat signed", () => {
    const state = (w: ReturnType<typeof withdraw>) => deriveState(d, { now, acts: [w], owners }).state;
    // The seat that signed last cannot void the agreement.
    expect(state(withdraw("R", "2029-01-02T00:00:00Z"))).toBe("in force");
    expect(state(withdraw("R", "2029-01-01T12:00:00Z"))).toBe("in force");
    // Nor can the first signer with a withdrawal dated before its own signature.
    expect(state(withdraw("D", "2028-12-01T00:00:00Z"))).toBe("in force");
    // Nor one dated at the moment of the countersignature.
    expect(state(withdraw("D", "2029-01-02T00:00:00Z"))).toBe("in force");
    // A withdrawal between the two signatures stands.
    expect(state(withdraw("D", "2029-01-01T12:00:00Z"))).toBe("withdrawn");
    // At 0.2.0-draft an act whose `at` is before its own signed_at is no act
    // at all (7.3), so one signed after the countersignature cannot reach back.
    expect(checkAct(d, withdraw("D", "2029-01-01T12:00:00Z", "2029-05-01T00:00:00Z"), { owners }).ok).toBe(false);
    // And a verifier that received it late reads it as taking effect then.
    const late = withdraw("D", "2029-01-01T12:00:00Z");
    expect(deriveState(d, { now, acts: [late], owners, actReceipts: () => "2029-05-01T00:00:00Z" }).state).toBe("in force");
  });

  it("B. a multilateral replacement keeps two original members with their keys", () => {
    const original = multi(["M1", "M2", "M3", "M4"]);
    const v2 = (names: string[], keys: Record<string, string> = {}) => {
      let v = { ...original, version: 2, parties: { members: names.map((n) => seat(n, keys[n] ?? n)), grade: "evidence" }, signatures: [] } as Agreement;
      for (const n of names) v = signAgreement(v, S(keys[n] ?? n), { role: "member", agent: A(n), signedAt: "2029-02-01T00:00:00Z" });
      return v;
    };
    const state = (v: Agreement) => deriveState(original, { now, laterVersions: [v], owners }).state;
    expect(state(v2(["X1", "X2", "X3"]))).toBe("in force");
    expect(state(v2(["M1", "X2", "X3"]))).toBe("in force");
    expect(state(v2(["M1", "M2", "X3"], { M2: "stranger" }))).toBe("in force");
    expect(state(v2(["M1", "M2", "M3", "M4", "M5"]))).toBe("amended");
    expect(state(v2(["M1", "M2", "M4"]))).toBe("amended");
  });
});
