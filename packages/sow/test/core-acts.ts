// Agent SoW 0.30.0-draft, the signed acts (§6.3), asserted against
// conformance/sow-acts.json. Its `cases` are the vectors (actCase): each
// names an act, its kind, the agreed document it is made under, what the
// runtime already holds, and whether a runtime takes it. Its `pairs`
// (pairCase) pin when a dispute under escalate_to_owners closes. The suites
// below read its other members: the published keys, the tags, the documents'
// digests, the signed bytes, and the acts signed again from the seeds.
import { expect } from "vitest";
import { createHash } from "node:crypto";
import { loadPinnedVectors, type VectorCase } from "../../vectors/index.js";
import { collector } from "./collect.js";
import { sha256Digest } from "../crypto.js";
import {
  SOW_ACT_TAGS,
  SowRefusal,
  actDigest,
  actSignedBytes,
  arbiterVerdictSignedBytes,
  checkAct,
  disputeSettled,
  signAct,
  signArbiterVerdict,
  signerFromRawSeed,
  terminationTakesEffect,
  versionDigest,
  type SowAct,
  type SowActKind,
  type SowArbiterVerdict,
  type SowDisputeAct,
  type SowDocument,
  type SowResolveAct,
  type SowTerminateAct,
  type SowUsageAct,
} from "../index.js";

const { describe, it, suites } = collector();
export { suites };

const fixture = loadPinnedVectors("sow/conformance/sow-acts.json").data as unknown as {
  keys: { entries: Record<string, { label: string; seed_hex: string; public: string }> };
  tags: Record<SowActKind, string>;
  documents: Record<string, { document: SowDocument; signed_bytes_digest: string }>;
  unsettled: number;
  verdicts: Record<string, { verdict: SowArbiterVerdict; digest: string }>;
  acts: Record<string, SowAct & Record<string, unknown>>;
  signed_bytes: { act: string; bytes: string; dispute: string; dispute_digest: string };
  cases: Array<{ act: string; kind: SowActKind; document: string; valid: boolean; why?: string; prior?: string[]; dispute?: string; verdict?: string }>;
  pairs: Array<{ acts: string[]; dispute: string; closes: boolean; why?: string }>;
};

/** One `cases` vector: the named act is taken, or refused, under its document with what the runtime holds. */
export function actCase(c: VectorCase): void {
  const v = c.value as unknown as (typeof fixture.cases)[number];
  const act = fixture.acts[v.act];
  expect(act, `${v.act} is in the file`).toBeDefined();
  const doc = fixture.documents[v.document]!.document;
  let taken = true;
  try {
    checkAct(v.kind, act, {
      agreed: (n) => (n === doc.version ? doc : null),
      heldUsage: (v.prior ?? []).map((p) => fixture.acts[p] as unknown as SowUsageAct),
      unsettled: fixture.unsettled,
      ...(v.dispute ? { dispute: fixture.acts[v.dispute] as unknown as SowDisputeAct } : {}),
      ...(v.verdict ? { verdict: fixture.verdicts[v.verdict]!.verdict } : {}),
      // The fixture's acts reach the runtime the instant they are signed.
      now: (act as { signed_at: string }).signed_at,
    });
  } catch (e) {
    if (!(e instanceof SowRefusal)) throw e;
    taken = false;
  }
  expect(taken, `${v.act}: ${v.why ?? "a valid act"}`).toBe(v.valid);
}

/** One `pairs` vector: whether these resolve acts close the dispute. */
export function pairCase(c: VectorCase): void {
  const v = c.value as unknown as (typeof fixture.pairs)[number];
  const dispute = actDigest("dispute", fixture.acts[v.dispute]!);
  const acts = v.acts.map((a) => fixture.acts[a] as unknown as SowResolveAct);
  expect(disputeSettled(acts, dispute), `${v.acts.join(" + ")}: ${v.why ?? ""}`).toBe(v.closes);
}

const seedFor = (publicKey: string) => {
  const entry = Object.values(fixture.keys.entries).find((k) => k.public === publicKey);
  return entry ? signerFromRawSeed(new Uint8Array(Buffer.from(entry.seed_hex, "hex"))) : null;
};

describe("§6.3 the published keys and tags", () => {
  it("every seed is the SHA-256 of its label, and signs as its public key", () => {
    for (const k of Object.values(fixture.keys.entries)) {
      expect(createHash("sha256").update(k.label).digest("hex")).toBe(k.seed_hex);
      expect(signerFromRawSeed(new Uint8Array(Buffer.from(k.seed_hex, "hex"))).getPublicKey()).toBe(k.public);
    }
  });
  it("each kind's tag is the core's", () => {
    expect(fixture.tags).toEqual(SOW_ACT_TAGS);
  });
});

describe("§6.3 what an act names", () => {
  it("each document's digest is of its signed bytes (§6)", () => {
    for (const d of Object.values(fixture.documents)) expect(versionDigest(d.document)).toBe(d.signed_bytes_digest);
  });
  it("an act's signed bytes are its tag, one newline, and the JCS of the act less sig", () => {
    const act = fixture.acts[fixture.signed_bytes.act]!;
    expect(actSignedBytes("terminate", act)).toBe(fixture.signed_bytes.bytes);
  });
  it("a dispute is named by the digest of its signed bytes", () => {
    expect(actDigest("dispute", fixture.acts[fixture.signed_bytes.dispute]!)).toBe(fixture.signed_bytes.dispute_digest);
  });
  it("each verdict's digest is of its own signed bytes", () => {
    for (const [name, v] of Object.entries(fixture.verdicts)) {
      expect(sha256Digest(arbiterVerdictSignedBytes(v.verdict)), name).toBe(v.digest);
    }
  });
});

describe("§6.3 the acts signed again from the published seeds", () => {
  it("each valid act made again by its seat's seed is byte-identical to the fixture's", () => {
    const valid = fixture.cases.filter((c) => c.valid);
    for (const c of valid) {
      const act = fixture.acts[c.act]!;
      const signer = seedFor(act.key);
      expect(signer, `${c.act}'s key is a published seed`).not.toBeNull();
      const { by, key: _k, signed_at, sig: _s, ...rest } = act as Record<string, unknown> & { by: "provider" | "client"; signed_at: string };
      const again = signAct(c.kind, rest as never, signer!, by, signed_at);
      expect(again, c.act).toEqual(act);
    }
  });
});

describe("§6.3 when a termination takes effect for the party that received it", () => {
  const doc = fixture.documents.agreed!.document;
  const act = fixture.acts.terminate_convenience as unknown as SowTerminateAct;
  it("received on time, it takes effect at its effective_at", () => {
    expect(terminationTakesEffect(act, doc, act.signed_at)).toBe(act.effective_at);
  });
  it("received late, the notice counts from receipt, so a termination dated back gives no less notice", () => {
    expect(terminationTakesEffect(act, doc, "2026-10-02T09:00:00Z")).toBe("2026-10-04T09:00:00Z");
  });
});

describe("§6.3 when deadline_days has run, on this runtime's clock", () => {
  const doc = fixture.documents.arbiter!.document;
  const dispute = fixture.acts.dispute_arbiter as unknown as SowDisputeAct;
  const released = fixture.acts.released_after_deadline!;
  const takes = (kind: SowActKind, act: unknown, ctx: Partial<Parameters<typeof checkAct>[2]>) => {
    try {
      checkAct(kind, act, { agreed: (n) => (n === doc.version ? doc : null), dispute, ...ctx });
      return true;
    } catch (e) {
      if (e instanceof SowRefusal) return false;
      throw e;
    }
  };
  it("refuses a release dated past the deadline that arrives before it has run", () => {
    expect(takes("resolve", released, { now: "2026-10-10T00:00:00Z" })).toBe(false);
    expect(takes("resolve", released, { now: "2026-10-19T10:00:00Z" })).toBe(true);
  });
  it("refuses a release where the runtime has no clock to judge the deadline on", () => {
    expect(takes("resolve", released, {})).toBe(false);
  });
  it("counts from when the dispute was received, where that was later than it was signed", () => {
    expect(takes("resolve", released, { now: "2026-10-19T10:00:00Z", disputeReceivedAt: "2026-10-06T10:00:00Z" })).toBe(false);
    expect(takes("resolve", released, { now: "2026-10-20T10:00:00Z", disputeReceivedAt: "2026-10-06T10:00:00Z" })).toBe(true);
    // A receipt stamped before the signature moves nothing earlier.
    expect(takes("resolve", released, { now: "2026-10-19T10:00:00Z", disputeReceivedAt: "2026-10-01T00:00:00Z" })).toBe(true);
  });
  it("refuses a release once the bound arbiter has produced a timely verdict, and takes the verdict past the deadline", () => {
    const timely = fixture.verdicts.timely!.verdict;
    expect(takes("resolve", released, { now: "2026-10-25T00:00:00Z", verdict: timely })).toBe(false);
    expect(takes("resolve", fixture.acts.verdict, { now: "2026-10-25T00:00:00Z", verdict: timely })).toBe(true);
  });
  it("a late verdict keeps no arbiter in force: the fallback governs", () => {
    expect(takes("resolve", released, { now: "2026-10-25T00:00:00Z", verdict: fixture.verdicts.late!.verdict })).toBe(true);
  });
});

describe("§5.10.1 an arbiter the parties appoint when the dispute opens", () => {
  // The fixture's arbiter document with no judge bound at formation, and the
  // dispute, verdict and resolution made again under it from the seeds.
  const bound = fixture.documents.arbiter!.document as SowDocument & { disputes: { arbiter: Record<string, unknown> } };
  const { agent, ...clause } = bound.disputes.arbiter;
  const doc = { ...bound, disputes: { ...bound.disputes, arbiter: clause } } as unknown as SowDocument;
  const digest = versionDigest(doc);
  const sign = <T extends SowAct>(kind: SowActKind, act: T) => {
    const { by, key, signed_at, sig: _s, ...rest } = act as unknown as Record<string, unknown> & { by: "provider" | "client"; key: string; signed_at: string };
    return signAct(kind, { ...rest, digest } as never, seedFor(key)!, by, signed_at) as unknown as T;
  };
  const dispute = sign("dispute", fixture.acts.dispute_arbiter as unknown as SowDisputeAct);
  const { signatures: _sigs, ...unsigned } = fixture.verdicts.timely!.verdict;
  const arbiter = seedFor(agent as string)!;
  const verdict = signArbiterVerdict({ ...unsigned, dispute: actDigest("dispute", dispute) }, arbiter, "2026-10-12T15:01:00Z") as SowArbiterVerdict;
  const resolve = sign("resolve", {
    ...(fixture.acts.verdict as unknown as SowResolveAct),
    dispute: actDigest("dispute", dispute),
    verdict: sha256Digest(arbiterVerdictSignedBytes(verdict)),
  });
  const takes = (appointment?: { agent: string }) => {
    try {
      checkAct("resolve", resolve, { agreed: (n) => (n === doc.version ? doc : null), dispute, verdict, now: resolve.signed_at, ...(appointment ? { appointment } : {}) });
      return true;
    } catch (e) {
      if (e instanceof SowRefusal) return false;
      throw e;
    }
  };
  it("takes a verdict signed by the appointed arbiter", () => {
    expect(takes({ agent: agent as string })).toBe(true);
  });
  it("refuses a verdict where no arbiter was appointed, or another was", () => {
    expect(takes()).toBe(false);
    expect(takes({ agent: (fixture.acts.dispute_arbiter as { key: string }).key })).toBe(false);
  });
});
