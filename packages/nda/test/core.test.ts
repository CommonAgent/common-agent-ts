// Unit tests of the core beyond the fixtures: building and signing from
// scratch, the mandate and owner lookups, receipt times, and the answers the
// other specifications ask for (Agent SoW §5.16, Agent Reputations §4.8,
// Agent RFP §5.11.3).
import { describe, expect, it } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import {
  acceptOffer,
  agreementDigest,
  bindingConfirmed,
  canonicalJSON,
  checkBreachClaim,
  checkEngagement,
  checkGateRelease,
  decodeSig,
  deriveState,
  isCountersigned,
  mandateQueries,
  mintId,
  offerDigest,
  rawPublicKey,
  referenceTo,
  seatSignatures,
  signAgreement,
  signerFromSeed,
  validateAgreement,
  verifyAcceptance,
  verifyBytes,
  utf8,
  type Agreement,
  type MandateLookup,
  type OwnerResolver,
} from "../index.js";

const life = loadPinnedVectors("nda/conformance/nda-lifecycle.json").data as {
  keys: { entries: Record<string, { seed_hex: string; public: string }>; stand_ins: Record<string, string> };
};
const seed = (name: string) => signerFromSeed(new Uint8Array(Buffer.from(life.keys.entries[name].seed_hex, "hex")));
const harbor = seed("harbor-owner");
const caldera = seed("caldera-owner");
const HARBOR_AGENT = life.keys.stand_ins.harbor_agent as string;
const CALDERA_AGENT = life.keys.stand_ins.caldera_agent as string;
const GRANITE_AGENT = life.keys.entries["granite-agent"].public as string;
/** The registry holds Caldera's attested owner: its owner_key. */
const owners: OwnerResolver = (agent) => (agent === CALDERA_AGENT ? { owner: caldera.getPublicKey(), attested: true } : undefined);

/** A small open offer, minted and signed here rather than read. */
function freshOffer(): Agreement {
  const doc: Agreement = {
    nda: "v1",
    id: "",
    version: 1,
    language: { id: "agent-nda-standard-language", version: 1, sha256: "0".repeat(64) },
    direction: "one_way",
    parties: {
      discloser: { agent: HARBOR_AGENT, owner: "Harbor & Line Outfitters", organization: "org_7k2m9q4w1x8e5r3t" },
      recipient: null,
      grade: "evidence",
    },
    offer: { open_to: "any", expires_at: "2030-01-01T00:00:00Z" },
    effective_at: null,
    ends_at: "2031-01-01T00:00:00Z",
    purpose: { statement: "Evaluating a posting.", activities: ["evaluate_solicitation", "perform_engagements"], grade: "recorded" },
    covers: { categories: ["solicitation", "inputs"], grade: "recorded" },
    disclosure: { recipient: null, subcontractors: "none", need_to_know: ["personnel"], grade: "recorded" },
    survival: { days: 365, grade: "recorded" },
    signatures: [],
  };
  doc.id = mintId(doc);
  return signAgreement(doc, harbor, { role: "discloser", signedAt: "2029-01-01T00:00:00Z", mandate: "mnd_3f8c1n6z9v4b7q2m" });
}

function freshAcceptance(offer = freshOffer(), signedAt = "2029-02-01T00:00:00Z"): Agreement {
  return acceptOffer(offer, caldera, {
    seat: { agent: CALDERA_AGENT, owner: "Caldera Freight Systems", handle: "Sable.audit@calderafreight.example", owner_key: caldera.getPublicKey() },
    declaration: { processors: [{ service: "Anthropic API", domain: "anthropic.com" }], processed_in: ["us"] },
    signedAt,
  });
}

describe("canonical JSON and keys", () => {
  it("sorts keys, drops undefined members, keeps array order", () => {
    expect(canonicalJSON({ b: 1, a: [3, { d: undefined, c: "x" }], e: null })).toBe('{"a":[3,{"c":"x"}],"b":1,"e":null}');
  });
  it("refuses a number JSON cannot spell", () => {
    expect(() => canonicalJSON({ n: Number.NaN })).toThrow();
  });
  it("decodes a key only with its checksum", () => {
    const key = harbor.getPublicKey();
    expect(rawPublicKey(key)).toHaveLength(32);
    const bad = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(rawPublicKey(bad)).toBeNull();
    // The specification's stand-in agent keys have the spelling, not the checksum.
    expect(rawPublicKey(HARBOR_AGENT)).toBeNull();
  });
  it("reads a signature only in its canonical padded base64 (6)", () => {
    const sig = harbor.sign(utf8("x"));
    const b64 = Buffer.from(sig).toString("base64");
    expect(decodeSig(b64)).toEqual(new Uint8Array(sig));
    expect(verifyBytes(harbor.getPublicKey(), utf8("x"), b64)).toBe(true);
    expect(verifyBytes(harbor.getPublicKey(), utf8("y"), b64)).toBe(false);
    expect(decodeSig(Buffer.from(sig).toString("base64url"))).toBeNull();
    expect(decodeSig(b64.replace(/=+$/, ""))).toBeNull();
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    expect(decodeSig(b64.slice(0, 85) + chars[chars.indexOf(b64[85]) ^ 1] + "==")).toBeNull();
    expect(decodeSig("not base64!")).toBeNull();
  });
});

describe("an offer and its acceptance, built here", () => {
  it("validates, verifies and comes into force", () => {
    const a = freshAcceptance();
    expect(validateAgreement(freshOffer()).ok).toBe(true);
    expect(validateAgreement(a).ok).toBe(true);
    expect(verifyAcceptance(a)).toMatchObject({ ok: true, owner: "unconfirmed", signedAtOnly: true });
    expect(verifyAcceptance(a, { owners })).toMatchObject({ ok: true, owner: "confirmed" });
    expect(verifyAcceptance(a, { owners, receivedAt: "2029-02-01T00:00:01Z" })).toMatchObject({ ok: true, owner: "confirmed", signedAtOnly: false });
    expect(deriveState(a, { now: "2029-03-01T00:00:00Z" }).state).toBe("in force");
    expect(offerDigest(a)).toBe(offerDigest(freshOffer()));
    expect(referenceTo(freshOffer()).digest).toBe(offerDigest(freshOffer()));
    expect(referenceTo(a).digest).toBe(agreementDigest(a));
  });

  it("refuses to accept a document that is not an open offer, or without the declaration it needs", () => {
    const a = freshAcceptance();
    expect(() => acceptOffer(a, caldera, { seat: a.parties.recipient!, declaration: {}, signedAt: "2029-02-01T00:00:00Z" })).toThrow();
    expect(() => acceptOffer(freshOffer(), caldera, { seat: a.parties.recipient!, signedAt: "2029-02-01T00:00:00Z" })).toThrow();
  });

  it("keeps an open offer's recipient declaration empty until acceptance", () => {
    const o = freshOffer();
    const r = validateAgreement({ ...o, disclosure: { ...o.disclosure!, recipient: { processed_in: ["us"] } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("offer");
  });
});

describe("the mandate rule (6.2)", () => {
  const a = freshAcceptance();
  it("lists one check per signature for a seat that names an organization", () => {
    const q = mandateQueries(a);
    expect(q).toHaveLength(1);
    expect(q[0].query).toMatchObject({ mandate: "mnd_3f8c1n6z9v4b7q2m", organization: "org_7k2m9q4w1x8e5r3t", categories: ["solicitation", "inputs"] });
  });
  it("says unchecked when no lookup ran, and never confirmed", () => {
    expect(seatSignatures(a).find((s) => s.role === "discloser")?.binding).toBe("unchecked");
    expect(bindingConfirmed(a)).toBe(false);
    expect(isCountersigned(a)).toBe(true);
  });
  it("confirms a mandate that checks and an attested owner, and refuses a mandate check that fails", () => {
    const ok: MandateLookup = () => "ok";
    const refused: MandateLookup = () => "refused";
    expect(bindingConfirmed(a, { mandates: ok, owners })).toBe(true);
    expect(bindingConfirmed(a, { mandates: ok })).toBe(false);
    expect(isCountersigned(a, { mandates: refused })).toBe(false);
    expect(deriveState(a, { now: "2029-03-01T00:00:00Z", mandates: refused }).state).not.toBe("in force");
  });
  it("checks the mandate at receipt as well as at signing", () => {
    const lapsesBeforeReceipt: MandateLookup = (q) => (Date.parse(q.at) < Date.parse("2029-01-15T00:00:00Z") ? "ok" : "refused");
    expect(seatSignatures(a, { mandates: lapsesBeforeReceipt }).find((s) => s.role === "discloser")?.binding).toBe("bound");
    expect(seatSignatures(a, { mandates: lapsesBeforeReceipt, receivedAt: "2029-02-01T00:00:00Z" }).find((s) => s.role === "discloser")?.binding).toBe("unbound");
  });
});

describe("owners and receipt (6, 6.1)", () => {
  it("refuses a recipient whose owner_key the registry contradicts", () => {
    const contradicted: OwnerResolver = () => ({ owner: harbor.getPublicKey(), attested: true });
    expect(verifyAcceptance(freshAcceptance(), { owners: contradicted })).toMatchObject({ ok: false, step: 2 });
  });
  it("reads a default, unattested owner as unconfirmed", () => {
    const defaultOwner: OwnerResolver = () => ({ owner: caldera.getPublicKey(), attested: false });
    expect(verifyAcceptance(freshAcceptance(), { owners: defaultOwner })).toMatchObject({ ok: true, owner: "unconfirmed" });
  });
  it("refuses an acceptance received after the offer expired, whatever signed_at says", () => {
    const a = freshAcceptance();
    expect(verifyAcceptance(a, { owners, receivedAt: "2029-12-31T00:00:00Z" })).toMatchObject({ ok: true });
    expect(verifyAcceptance(a, { owners, receivedAt: "2030-01-02T00:00:00Z" })).toMatchObject({ ok: false, step: 3 });
  });
});

describe("Agent SoW 5.16: an engagement against the NDA it names", () => {
  const a = freshAcceptance();
  const ref = referenceTo(a);
  const confidentiality = { processors: [{ service: "Anthropic API", domain: "anthropic.com" }], processed_in: ["us"] };
  it("fits when the parties match and the declarations sit inside the provider's", () => {
    expect(checkEngagement(ref, a, { provider: CALDERA_AGENT, client: HARBOR_AGENT, confidentiality })).toEqual({ ok: true, tests: "ran" });
  });
  it("runs neither test when the provider is the one-way discloser", () => {
    expect(checkEngagement(ref, a, { provider: HARBOR_AGENT, client: CALDERA_AGENT })).toEqual({ ok: true, tests: "not_applicable" });
  });
  it("names the test that failed", () => {
    expect(checkEngagement({ ...ref, digest: offerDigest(a) }, a, { provider: CALDERA_AGENT, client: HARBOR_AGENT })).toMatchObject({ ok: false, test: "digest" });
    expect(checkEngagement(referenceTo(freshOffer()), freshOffer(), { provider: CALDERA_AGENT, client: HARBOR_AGENT })).toMatchObject({ ok: false, test: "open_offer" });
    expect(checkEngagement(ref, a, { provider: GRANITE_AGENT, client: HARBOR_AGENT })).toMatchObject({ ok: false, test: "parties" });
    expect(
      checkEngagement(ref, a, { provider: CALDERA_AGENT, client: HARBOR_AGENT, confidentiality: { ...confidentiality, processors: [{ service: "Whisper" }] } }),
    ).toMatchObject({ ok: false, test: "processors", entry: 0 });
    expect(checkEngagement(ref, a, { provider: CALDERA_AGENT, client: HARBOR_AGENT, confidentiality: { processors: [], processed_in: ["eu"] } })).toMatchObject({
      ok: false,
      test: "processed_in",
    });
  });
});

describe("Agent Reputations 4.8: the agreement's side of a claim of breach", () => {
  const a = freshAcceptance();
  const ref = referenceTo(a);
  const claim = { claimant: HARBOR_AGENT, respondent: CALDERA_AGENT, categories: ["solicitation" as const], disclosedAt: ["2029-02-02T00:00:00Z"] };
  const now = "2031-06-01T00:00:00Z";
  it("passes, and hands back the facts a report may show", () => {
    const r = checkBreachClaim(ref, a, claim, { now, owners, mandates: () => "ok" });
    expect(r).toEqual({ ok: true, facts: { direction: "one_way", categories: ["solicitation"], dutiesEndAt: "2032-01-01T00:00:00Z" }, signedAtOnly: true });
  });
  it("names the check that failed", () => {
    const ctx = { now, owners, mandates: (() => "ok") as MandateLookup };
    expect(checkBreachClaim(referenceTo(freshOffer()), freshOffer(), claim, ctx)).toMatchObject({ ok: false, check: 2 });
    // Without the registry's answer the recipient's owner is unconfirmed,
    // which a claim treats as not bound (6, binding rule 1).
    expect(checkBreachClaim(ref, a, claim, { now, mandates: () => "ok" })).toMatchObject({ ok: false, check: 2 });
    // Without a mandate lookup the discloser's organization seat decides nothing.
    expect(checkBreachClaim(ref, a, claim, { now, owners })).toMatchObject({ ok: false, check: 2 });
    expect(checkBreachClaim(ref, a, { ...claim, claimant: CALDERA_AGENT, respondent: HARBOR_AGENT }, ctx)).toMatchObject({ ok: false, check: 3 });
    expect(checkBreachClaim(ref, a, { ...claim, respondent: GRANITE_AGENT }, ctx)).toMatchObject({ ok: false, check: 4 });
    expect(checkBreachClaim(ref, a, { ...claim, categories: ["own_material"] }, ctx)).toMatchObject({ ok: false, check: 6 });
    expect(checkBreachClaim(ref, a, { ...claim, disclosedAt: ["2028-01-01T00:00:00Z"] }, ctx)).toMatchObject({ ok: false, check: 7 });
    expect(checkBreachClaim(ref, a, { ...claim, breachAt: "2033-01-01T00:00:00Z" }, ctx)).toMatchObject({ ok: false, check: 8 });
  });
});

describe("Agent RFP 5.11.3 with the mandate check", () => {
  it("withholds the body when the recipient's organization seat fails its mandate", () => {
    const o = freshOffer();
    const a = acceptOffer(o, caldera, {
      seat: { agent: CALDERA_AGENT, owner: "Caldera Freight Systems", organization: "org_c4ldera0freight0" },
      declaration: { processors: [], processed_in: ["us"] },
      signedAt: "2029-02-01T00:00:00Z",
      mandate: "mnd_c4ldera0mandate0",
    });
    const req = { gate: referenceTo(o), presented: a, posterAgent: HARBOR_AGENT, requesterAgent: CALDERA_AGENT, now: "2029-03-01T00:00:00Z", receivedAt: "2029-02-01T00:00:01Z", owners: "none" as const };
    // Both seats name organizations, so the gate releases only with every mandate checked.
    expect(checkGateRelease(req)).toMatchObject({ release: false, check: 1 });
    expect(checkGateRelease({ ...req, mandates: () => "unknown" })).toMatchObject({ release: false, check: 1 });
    expect(checkGateRelease({ ...req, mandates: () => "ok" })).toMatchObject({ release: true, owner: "confirmed", signedAtOnly: false });
    expect(checkGateRelease({ ...req, mandates: () => "refused" })).toMatchObject({ release: false, check: 1 });
  });
});

describe("Agent RFP 5.11.3 with the owner check", () => {
  it("releases to a confirmed owner, and to an unconfirmed one only when the offer accepts any owner", () => {
    const o = freshOffer();
    const a = freshAcceptance(o);
    const req = {
      gate: referenceTo(o),
      presented: a,
      posterAgent: HARBOR_AGENT,
      requesterAgent: CALDERA_AGENT,
      now: "2029-03-01T00:00:00Z",
      receivedAt: "2029-02-01T00:00:01Z",
      mandates: (() => "ok") as MandateLookup,
      owners: "none" as OwnerResolver | "none",
    };
    expect(checkGateRelease({ ...req, owners })).toMatchObject({ release: true, owner: "confirmed" });
    expect(checkGateRelease(req)).toMatchObject({ release: false, check: 1 });
    const anyOffer = signAgreement({ ...o, offer: { ...o.offer!, owners: "any" }, signatures: [] }, harbor, {
      role: "discloser",
      signedAt: "2029-01-01T00:00:00Z",
      mandate: "mnd_3f8c1n6z9v4b7q2m",
    });
    const anyAcceptance = freshAcceptance(anyOffer);
    expect(checkGateRelease({ ...req, gate: referenceTo(anyOffer), presented: anyAcceptance })).toMatchObject({ release: true, owner: "unconfirmed" });
    const contradicted: OwnerResolver = () => ({ owner: harbor.getPublicKey(), attested: true });
    expect(checkGateRelease({ ...req, gate: referenceTo(anyOffer), presented: anyAcceptance, owners: contradicted })).toMatchObject({ release: false, check: 1 });
  });
});
