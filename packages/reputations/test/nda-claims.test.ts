// The pure parts of a claim of breach of an Agent NDA (§4.8): its signed
// bytes and digest, its shape, the claimant's signature, the default anchor,
// and the claim window.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claimDigest,
  claimProblems,
  claimSignedBy,
  claimSignedBytes,
  jcs,
  keyFromRaw,
  saltedAnchorHash,
  withinClaimWindow,
  nkeyOf,
  claimStanding,
  resolutionRefusal,
  ndaActBytes,
  type NdaClaim,
} from "../index.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const RAW = (publicKey.export({ format: "jwk" }) as { x: string }).x;
const KEY = keyFromRaw(Buffer.from(RAW, "base64url"));

const claim: NdaClaim = {
  nda: { id: "nda_dtzv6z8tans9k5s6", version: 1, digest: `sha256:${"98".repeat(32)}` },
  claimant: { agent: KEY, handle: "Petrel.mari@harborandline.example" },
  respondent: { agent: keyFromRaw(Buffer.alloc(32, 9)) },
  categories: ["solicitation"],
  disclosures: [{ kind: "rfp_release", digest: `sha256:${"12".repeat(32)}`, at: "2026-10-22T09:13:05Z" }],
  found: { at: "2027-04-09T00:00:00Z", material_digest: `sha256:${"19".repeat(32)}`, note: "Offered for sale." },
  breach_at: null,
  at: "2027-04-10T16:02:11Z",
};

describe("a claim's bytes", () => {
  it("are the tag, a line feed and the JCS of the claim, and its digest is sha256: over the JCS", () => {
    expect(Buffer.from(claimSignedBytes(claim)).toString("utf8")).toBe(`fdbk-nda-claim-v1\n${jcs(claim)}`);
    expect(claimDigest(claim)).toBe(`sha256:${createHash("sha256").update(jcs(claim)).digest("hex")}`);
    expect(claimDigest({ ...claim, categories: ["inputs"] })).not.toBe(claimDigest(claim));
  });
});

describe("a claim's shape", () => {
  it("passes the example's shape", () => expect(claimProblems(claim)).toEqual([]));
  it("names what is missing", () => {
    expect(claimProblems(null)).toEqual(["a claim is a JSON object"]);
    expect(claimProblems({ ...claim, disclosures: [] }).join()).toMatch(/at least one record/);
    expect(claimProblems({ ...claim, disclosures: [{ ...claim.disclosures[0], kind: "rumour" }] }).join()).toMatch(/kind/);
    expect(claimProblems({ ...claim, nda: { ...claim.nda, digest: "98" } }).join()).toMatch(/digest/);
    expect(claimProblems({ ...claim, breach_at: "soon" }).join()).toMatch(/breach_at/);
    expect(claimProblems({ ...claim, respondent: { agent: "anyone at all" } }).join()).toMatch(/respondent names an agent key/);
    expect(claimProblems({ ...claim, claimant: { agent: "U".padEnd(56, "1") } }).join()).toMatch(/claimant names an agent key/);
  });
});

describe("the claimant's signature", () => {
  const sig = sign(null, claimSignedBytes(claim), privateKey).toString("base64");
  it("verifies under the claimant's key, in padded base64", () => expect(claimSignedBy(claim, sig)).toBe(true));
  it("fails for another claim, another encoding, or a key that is no key", () => {
    expect(claimSignedBy({ ...claim, categories: ["inputs"] }, sig)).toBe(false);
    expect(claimSignedBy(claim, Buffer.from(sig, "base64").toString("base64url"))).toBe(false);
    expect(claimSignedBy({ ...claim, claimant: { agent: "not a key" } }, sig)).toBe(false);
  });
});

describe("the anchor", () => {
  it("is kept as a salted hash", () => {
    expect(saltedAnchorHash("Mari@x.example", "s")).toBe(saltedAnchorHash("mari@x.example", "s"));
    expect(saltedAnchorHash("mari@x.example", "s")).not.toBe(saltedAnchorHash("mari@x.example", "t"));
  });
});

describe("the claim window", () => {
  const w = { disclosedAt: ["2029-03-01T00:00:00Z"], dutiesEndAt: "2032-01-01T00:00:00Z", filingPeriodDays: 365 };
  it("opens at the first disclosure and closes the filing period after the duties end", () => {
    expect(withinClaimWindow({ ...w, filedAt: "2029-02-28T00:00:00Z" })).toBe(false);
    expect(withinClaimWindow({ ...w, filedAt: "2029-03-01T00:00:00Z" })).toBe(true);
    expect(withinClaimWindow({ ...w, filedAt: "2032-12-31T00:00:00Z" })).toBe(true);
    expect(withinClaimWindow({ ...w, filedAt: "2032-12-31T00:00:01Z" })).toBe(false);
  });
});

describe("one spelling of a key", () => {
  it("is the nkey, from an nkey whose checksum holds or from padded base64", () => {
    const raw = Buffer.from(RAW, "base64url");
    const nkey = nkeyOf(KEY)!;
    expect(nkey).toMatch(/^U[A-Z2-7]{55}$/);
    expect(nkeyOf(nkey)).toBe(nkey);
    expect(nkeyOf(raw.toString("base64"))).toBe(nkey);
    expect(nkeyOf(nkey.slice(0, -1) + (nkey.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(nkeyOf("not a key")).toBeNull();
  });
});

describe("answers, acknowledgments and withdrawals", () => {
  it("are signed over their tag, a line feed and the JCS of the body", () => {
    const body = { claim: `sha256:${"12".repeat(32)}`, text: "An exclusion applies." };
    expect(Buffer.from(ndaActBytes("fdbk-nda-answer-v1", body)).toString("utf8")).toBe(`fdbk-nda-answer-v1\n${jcs(body)}`);
  });
});

describe("how a claim moves", () => {
  it("leaves open or lapsed once, and only an upheld breach is set aside", () => {
    expect(resolutionRefusal("open", "upheld")).toBeNull();
    expect(resolutionRefusal("lapsed", "dismissed")).toBeNull();
    expect(resolutionRefusal("upheld", "set_aside")).toBeNull();
    expect(resolutionRefusal("withdrawn", "upheld")).toMatch(/already withdrawn/);
    expect(resolutionRefusal("open", "set_aside")).toMatch(/only an upheld breach/);
    expect(resolutionRefusal("set_aside", "set_aside")).toMatch(/only an upheld breach/);
  });
  it("stands by its latest resolution, lapses without one, and stays in the record for the period after its latest entry", () => {
    const filedAt = "2030-01-01T00:00:00Z";
    const day = 86_400_000;
    const t = (d: number) => Date.parse(filedAt) + d * day;
    expect(claimStanding({ filedAt, answeredAt: [], resolutions: [], nowMs: t(10) })).toMatchObject({ state: "open", answers: 0, inRecord: true });
    expect(claimStanding({ filedAt, answeredAt: [], resolutions: [], nowMs: t(366) }).state).toBe("lapsed");
    const answeredAt = ["2030-02-01T00:00:00Z"];
    const resolutions = [{ outcome: "upheld" as const, basis: "court", at: "2031-03-01T00:00:00Z" }];
    expect(claimStanding({ filedAt, answeredAt, resolutions, nowMs: t(500) })).toMatchObject({ state: "upheld", basis: "court", answers: 1, lastAnsweredAt: answeredAt[0], latestAt: resolutions[0]!.at });
    expect(claimStanding({ filedAt, answeredAt, resolutions, nowMs: Date.parse(resolutions[0]!.at) + 1826 * day }).inRecord).toBe(false);
  });
});
