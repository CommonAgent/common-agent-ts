/**
 * The published Agent Reputations vectors against this core.
 *
 * fdbk-score-1: the pool of §7.1 drawn from each vector's ledger events, then
 * the score of §7.3 to §7.6 over it, with the vector's portfolio prior where
 * it has one (§7.5).
 *
 * fdbk-report-v1: report signing (§8.1). JCS byte for byte, the signed bytes
 * and the signature of a report and an organization report with the test key,
 * and every case a verifier must refuse, with the file's reason.
 */
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { describeVectors, type CaseCheck } from "../../vectors/vitest.js";
import { headsChecks } from "./heads-checks.js";
import { claimDigest, claimSignedBy, claimSignedBytes, filedCounts, jcs, kidOf, ndaRecord, poolFromEvents, scoreWeighted, seedSigner, signReport, signedBytes, verifyReport, type ClaimView, type ExpectedAnswer, type KeySet, type LedgerEvent, type NdaClaim, type Prior } from "../index.js";

interface ScoreVector {
  prior?: Prior;
  events: LedgerEvent[];
  expect: { a: number; b: number; mean: number; sd: number; lcb: number; n_eff: number; state: string; pool: Array<{ interaction_id: string; outcome: string; v: number; w: number }> };
}

/** §7.1 and §7.3 to §7.6 together: the pool drawn from the vector's ledger events, then the score over it with the vector's prior. */
const scoreCase: CaseCheck = (c, file) => {
  const v = c.value as unknown as ScoreVector;
  const tolerance = Number(file.tolerance);
  const constants = file.constants as { half_life_days: number; k_value: number; uniform_prior: Prior };
  const pool = poolFromEvents(v.events, { evaluatedAt: String(file.evaluated_at), halfLifeDays: constants.half_life_days, kValue: constants.k_value });
  expect(pool.map(({ interaction_id, outcome, v: value }) => ({ interaction_id, outcome, v: value }))).toEqual(
    v.expect.pool.map(({ interaction_id, outcome, v: value }) => ({ interaction_id, outcome, v: value })),
  );
  pool.forEach((p, i) => expect(Math.abs(p.w - v.expect.pool[i]!.w), `w of ${p.interaction_id}`).toBeLessThanOrEqual(tolerance));
  const got = scoreWeighted(pool, v.prior ?? constants.uniform_prior);
  for (const k of ["a", "b", "mean", "sd", "lcb", "n_eff"] as const) {
    expect(Math.abs(got[k] - v.expect[k]), `${k}: got ${got[k]}, expected ${v.expect[k]}`).toBeLessThanOrEqual(tolerance);
  }
  expect(got.unproven ? "UNPROVEN" : "SCORED").toBe(v.expect.state === "UNPROVEN" ? "UNPROVEN" : "SCORED");
};

interface SignedCase {
  name: string;
  tag: string;
  member: string;
  envelope: Record<string, unknown>;
  signed_bytes: string;
  signed_bytes_sha256: string;
}

interface MustFailCase {
  name: string;
  from: string;
  set?: Record<string, unknown>;
  tag?: string;
  verified_at?: string;
  reason: string;
}

const jcsCase: CaseCheck = (c) => {
  const v = c.value as { input: string; canonical: string };
  expect(jcs(JSON.parse(v.input))).toBe(v.canonical);
};

const testSigner = (file: Record<string, unknown>) => seedSigner(Buffer.from((file.test_key as { seed_hex: string }).seed_hex, "hex"));

const signedCase: CaseCheck = (c, file) => {
  const v = c.value as unknown as SignedCase;
  const object = v.envelope[v.member] as Record<string, unknown>;
  const bytes = signedBytes(v.tag, object);
  expect(new TextDecoder().decode(bytes)).toBe(v.signed_bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(v.signed_bytes_sha256);
  const signer = testSigner(file);
  const testKey = file.test_key as { public_key: string; kid: string };
  expect(signer.key).toBe(testKey.public_key);
  expect(kidOf(signer.key)).toBe(testKey.kid);
  // Ed25519 is deterministic: the test key signs these bytes to exactly the file's signature.
  expect(signReport(object, signer, { tag: v.tag, member: v.member })).toEqual(v.envelope);
  const verified = verifyReport(v.envelope, { keySet: file.key_set as KeySet, bureau: (file.key_set as KeySet).bureau, now: String(file.verified_at), tag: v.tag, member: v.member, expect: askedOf(v) });
  expect(verified).toEqual({ ok: true, format: "0.6.0", kid: testKey.kid });
};

/** What a consumer asked to get the case's report: its subject and capability, or its anchor. */
function askedOf(c: SignedCase): ExpectedAnswer {
  const o = c.envelope[c.member] as Record<string, string>;
  return c.member === "organization_report" ? { anchor: o.anchor } : { subject: o.subject, capability: o.capability };
}

/** Set a dotted path in a deep copy: "report.quality.lcb" or "bureau_sig". */
function withSet(envelope: Record<string, unknown>, set: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  for (const [path, value] of Object.entries(set)) {
    const parts = path.split(".");
    let at = copy;
    for (const p of parts.slice(0, -1)) at = at[p] as Record<string, unknown>;
    at[parts[parts.length - 1]] = value;
  }
  return copy;
}

const mustFailCase: CaseCheck = (c, file) => {
  const v = c.value as unknown as MustFailCase;
  const from = (file.signed as SignedCase[]).find((s) => s.name === v.from)!;
  const envelope = withSet(from.envelope, v.set ?? {});
  const keySet = file.key_set as KeySet;
  const got = verifyReport(envelope, {
    keySet,
    bureau: keySet.bureau,
    now: v.verified_at ?? String(file.verified_at),
    tag: v.tag ?? from.tag,
    member: from.member,
    expect: askedOf(from),
  });
  expect(got).toEqual({ ok: false, reason: v.reason });
};

/**
 * fdbk-nda-claim-v1 (§4.8): the claim's signed bytes, digest and signature
 * with the test claimant key, the rejection a bureau may keep of it, and each
 * changed claim, whose signature must not verify.
 */
const claimMustFailCase: CaseCheck = (c, file) => {
  const claim = file.claim as NdaClaim;
  expect(Buffer.from(claimSignedBytes(claim)).toString("utf8")).toBe(file.signed_bytes);
  expect(claimDigest(claim)).toBe(file.digest);
  expect((file.rejection as { claim: string }).claim).toBe(file.digest);
  expect(claimSignedBy(claim, String(file.sig))).toBe(true);
  const respondent = (file.test_respondent as { public_key: string }).public_key;
  const set = JSON.parse(JSON.stringify((c.value as { set: unknown }).set).replace('"<respondent>"', JSON.stringify(respondent))) as Partial<NdaClaim>;
  expect(claimSignedBy({ ...claim, ...set }, String(file.sig))).toBe(false);
};

/**
 * fdbk-nda-record-v1 (§4.9 rules 2, 4 and 6): the NDA records each reader is
 * served before and after one filing, rebuilt with this core from the claims
 * the vector describes: the claimant's earlier filings (two dismissed, one
 * withdrawn) and the new open claim against the respondent. A public report
 * carries no `filed`, and the case a bureau must not serve is one with it.
 */
const ndaRecordMustFailCase: CaseCheck = (c, file) => {
  const at = String(file.filed_at);
  const v = (over: Partial<ClaimView>): ClaimView => ({
    state: "open", filedAt: at, answers: 0, inRecord: true, categories: ["solicitation"], direction: "one_way",
    claimantAnchorHash: "sha256:claimant", agreement: "sha256:agreement", respondent: "respondent", ...over,
  });
  const earlier = [v({ state: "dismissed" }), v({ state: "dismissed" }), v({ state: "withdrawn" })];
  const filing = v({});
  const records = file.records as Record<string, Record<string, Record<string, unknown>>>;
  expect(ndaRecord([])).toEqual(records.claimant!.before!.public);
  expect(ndaRecord([], { filed: earlier })).toEqual(records.claimant!.before!.own_excerpt);
  expect(ndaRecord([])).toEqual(records.claimant!.after!.public);
  expect(ndaRecord([], { filed: [...earlier, filing] })).toEqual(records.claimant!.after!.own_excerpt);
  expect({ filed: filedCounts([...earlier, filing]) }).toEqual(records.claimant!.after!.respondent_excerpt_beside_claim);
  expect(ndaRecord([])).toEqual(records.respondent!.before!.public);
  expect(ndaRecord([filing])).toEqual(records.respondent!.after!.public);
  // The record a bureau must not serve: a public report carrying filed. This core's public record never does.
  const bad = c.value as { reader: string; record: Record<string, unknown> };
  expect(bad.reader).toBe("public");
  expect(bad.record).toHaveProperty("filed");
  expect(ndaRecord([])).not.toHaveProperty("filed");
};

describeVectors("reputations", {
  checks: {
    "fdbk-score-1.json": { vectors: scoreCase },
    "fdbk-report-v1.json": { jcs: jcsCase, signed: signedCase, must_fail: mustFailCase },
    "fdbk-nda-claim-v1.json": { must_fail: claimMustFailCase },
    "fdbk-nda-record-v1.json": { must_fail: ndaRecordMustFailCase },
    ...headsChecks,
  },

});
