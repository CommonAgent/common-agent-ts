// The Agent NDA conformance files pinned in standards-pin.json at
// nda-v0.2.0-draft, run two ways: an independent verifier (its own JCS, key
// decoding and digests over node:crypto's Ed25519) checks every signature and
// pinned byte string, and the core answers every expected case. Agent SoW's
// sow-nda.json is pinned under Agent SoW, and its cases are questions this
// core answers (Agent SoW §5.16), so they run here too. The fixtures are the
// authority (Agent NDA §11).
import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import { describeVectors, type CaseCheck } from "../../vectors/vitest.js";
import {
  ACTIVITIES,
  AT_END_ACTIONS,
  CATEGORIES,
  DIRECTIONS,
  EXCLUSIONS,
  FALSE_ENFORCEMENT_MESSAGE,
  FIXED_GRADES,
  NEED_TO_KNOW,
  SUBCONTRACTORS,
  actBytes,
  agreementDigest,
  checkAct,
  checkFlowDown,
  checkGateRelease,
  checkReference,
  decodeSig,
  deriveState,
  disclosureFits,
  hashedForId,
  isBound,
  mintId,
  offerBytes,
  offerDigest,
  partiesMatch,
  seatSignatures,
  signatureBytes,
  signedBytes,
  signerFromSeed,
  validateAgreement,
  verifyAcceptance,
  verifySignatureRecord,
  type Agreement,
  type MandateLookup,
  type OwnerResolver,
  type SignedAct,
} from "../index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fixture = Record<string, any>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Apply a fixture edit: dotted paths, array indices, "<removed>" deletes. */
function edit<T>(doc: T, changes: Record<string, unknown>): T {
  const out = clone(doc) as Record<string, unknown>;
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split(".");
    let at: Record<string, unknown> = out;
    for (const p of parts.slice(0, -1)) at = at[p] as Record<string, unknown>;
    const last = parts[parts.length - 1];
    if (value === "<removed>") delete at[last];
    else at[last] = clone(value);
  }
  return out as T;
}

const offerFx = loadPinnedVectors("nda/conformance/nda-offer.json").data as Fixture;
const grading = loadPinnedVectors("nda/conformance/nda-grading.json").data as Fixture;
const life = loadPinnedVectors("nda/conformance/nda-lifecycle.json").data as Fixture;
const sowNda = loadPinnedVectors("sow/conformance/sow-nda.json").data as Fixture;
const offer = offerFx.offer.document as Agreement;
const acceptance = offerFx.acceptance.document as Agreement;
const base = grading.base.document as Agreement;
const docs = life.documents as Record<string, Agreement>;
const acts = life.acts as Record<string, SignedAct>;
const pick = (names?: string[]) => (names ?? []).map((n) => acts[n]);

// ── what the fixture's lookups answer ────────────────────────────

const M = life.mandates.entries as Record<string, { organization: string; holder_key: string; powers: string[]; starts_at: string; expires_at: string; revoked_at?: string }>;
const mandates: MandateLookup = (q) => {
  const m = M[q.mandate];
  if (!m) return "refused";
  const t = Date.parse(q.at);
  const inForce = t >= Date.parse(m.starts_at) && t < Date.parse(m.expires_at) && (!m.revoked_at || t < Date.parse(m.revoked_at));
  return m.organization === q.organization && m.holder_key === q.signer && m.powers.includes("nda") && inForce ? "ok" : "refused";
};
const owners: OwnerResolver = (agent) => (life.registry.owners as Record<string, { owner: string; attested: boolean }>)[agent];
const receiptsFor = (group?: string) => {
  if (!group) return undefined;
  const map = life.act_receipts[group] as Record<string, string>;
  const byAct = new Map(Object.entries(map).map(([name, at]) => [JSON.stringify(acts[name]), at]));
  return (a: SignedAct) => byAct.get(JSON.stringify(a));
};

// ── an independent verifier ──────────────────────────────────────

function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
}
const sha = (s: string) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16Of(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
/** The 32 raw bytes of a user public key, with its length, `U` prefix byte
 *  and CRC-16 checksum all checked; null otherwise. */
function nkeyRaw(k: string): Buffer | null {
  if (!/^[A-Z2-7]{56}$/.test(k)) return null;
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of k) {
    acc = (acc << 5) | ALPHA.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  if (out.length !== 35 || out[0] !== 20 << 3) return null;
  if (crc16Of(out.slice(0, 33)) !== (out[33] | (out[34] << 8))) return null;
  return Buffer.from(out.slice(1, 33));
}
function edOk(key: string, msg: string, sig: string): boolean {
  const raw = nkeyRaw(key);
  if (!raw) return false;
  if (Buffer.from(sig, "base64").toString("base64") !== sig || Buffer.from(sig, "base64").length !== 64) return false;
  const pk = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  return verify(null, Buffer.from(msg, "utf8"), pk, Buffer.from(sig, "base64"));
}
const without = (o: Record<string, unknown>, ...k: string[]) => Object.fromEntries(Object.entries(o).filter(([x]) => !k.includes(x)));
const agreementBytesOf = (d: Record<string, unknown>) => `agent-nda-v1\n${jcs(without(d, "signatures"))}`;
function offerBytesOf(d: Record<string, unknown>) {
  const c = clone(d) as Fixture;
  c.parties.recipient = null;
  if (c.disclosure) c.disclosure.recipient = null;
  return agreementBytesOf(c);
}
const MEMBERS = ["role", "key", "signed_at", "digest", "sig", "over", "agent", "mandate"];
function independentRecord(d: Fixture, r: Fixture): boolean {
  if (Object.keys(r).some((k) => !MEMBERS.includes(k))) return false;
  if (r.over !== undefined && (r.over !== "offer" || r.role !== "discloser" || !d.offer)) return false;
  const want = r.over === "offer" ? sha(offerBytesOf(d)) : sha(agreementBytesOf(d));
  return r.digest === want && edOk(r.key, `agent-nda-sig-v1\n${jcs(without(r, "sig"))}`, r.sig);
}
const independentAct = (a: Fixture) => edOk(a.signature.key, `agent-nda-act-v1\n${jcs({ act: a.act, signature: without(a.signature, "sig") })}`, a.signature.sig);

// ── the runner's cases ───────────────────────────────────────────

const trap: CaseCheck = (c) => {
  switch (c.name) {
    case "hash_signed_bytes_for_id":
      expect(hashedForId(offer)).not.toBe(offerFx.offer.signed_bytes);
      break;
    case "digest_includes_signatures":
      expect(agreementDigest({ ...acceptance, signatures: [] })).toBe(agreementDigest(acceptance));
      break;
    case "offer_digest_for_agreement":
      expect(offerDigest(acceptance)).not.toBe(agreementDigest(acceptance));
      break;
    case "uppercase_hex":
      expect(checkReference({ ...offerFx.acceptance.reference, digest: "sha256:" + offerFx.acceptance.reference.digest.slice(7).toUpperCase() }).ok).toBe(false);
      break;
    case "changed_term_at_acceptance":
      expect(verifyAcceptance(edit(acceptance, { "survival.days": 365 }))).toMatchObject({ ok: false, step: 1 });
      break;
    case "record_outside_signature":
      for (const change of [{ signed_at: "2026-10-19T00:00:00Z" }, { mandate: "mnd_000000000000000a" }, { agent: acceptance.parties.recipient!.agent }]) {
        expect(verifySignatureRecord(acceptance, { ...acceptance.signatures[1], ...change })).toBe(false);
      }
      break;
    case "record_digest_mismatch":
      expect(verifySignatureRecord(acceptance, { ...acceptance.signatures[1], digest: offerDigest(acceptance) })).toBe(false);
      break;
    case "unbound_key": {
      const outsider = signerFromSeed(new Uint8Array(Buffer.from(life.keys.entries["outsider-owner"].seed_hex, "hex")));
      const doc = edit(acceptance, { "parties.recipient.owner_key": outsider.getPublicKey() });
      expect(seatSignatures(doc, { owners }).find((s) => s.role === "recipient")?.binding).toBe("unbound");
      break;
    }
    case "non_canonical_sig": {
      const sig = acceptance.signatures[1].sig;
      expect(decodeSig(sig)).not.toBeNull();
      expect(decodeSig(sig.replace(/=+$/, ""))).toBeNull();
      expect(decodeSig(Buffer.from(sig, "base64").toString("base64url"))).toBeNull();
      break;
    }
    default:
      throw new Error(`a trap this suite does not run: ${c.name}`);
  }
};

const lifecycle: CaseCheck = (c) => {
  const cases = (c.value as Fixture).cases as Fixture[] | undefined;
  switch (c.name) {
    case "keys":
      for (const k of Object.values<Fixture>(life.keys.entries)) {
        expect(signerFromSeed(new Uint8Array(Buffer.from(k.seed_hex, "hex"))).getPublicKey()).toBe(k.public);
        expect(createHash("sha256").update(k.label, "utf8").digest("hex")).toBe(k.seed_hex);
      }
      break;
    case "documents": {
      const broken = new Set(["outside_require", "over_on_recipient_record", "record_unknown_member"]);
      for (const [name, d] of Object.entries(docs)) {
        const r = validateAgreement(d);
        expect([name, broken.has(name) ? !r.ok : r.ok]).toEqual([name, true]);
      }
      break;
    }
    case "acts": {
      const broken = new Set(["terminate_tampered", "terminate_signed_at_altered"]);
      for (const [name, a] of Object.entries(acts)) expect([name, independentAct(a)]).toEqual([name, !broken.has(name)]);
      break;
    }
    case "signatures":
      expect(life.signatures.signature_bytes.bytes).toBe(signatureBytes(docs[life.signatures.signature_bytes.document].signatures[life.signatures.signature_bytes.index]));
      for (const s of cases!) {
        const d = docs[s.document];
        expect([s.case, verifySignatureRecord(d, d.signatures[s.index])]).toEqual([s.case, s.valid]);
        expect([s.case, independentRecord(d, d.signatures[s.index])]).toEqual([s.case, s.valid]);
        if (s.bound !== undefined) {
          const seat = seatSignatures(d, { mandates, owners }).find((x) => x.record === d.signatures[s.index]);
          expect([s.case, seat?.binding]).toEqual([s.case, s.bound === true ? "bound" : s.bound === false ? "unbound" : s.bound]);
        }
      }
      break;
    case "acceptance":
      for (const a of cases!) {
        const map: Record<string, string> = a.resolve ?? life.acceptance.resolve;
        const r = verifyAcceptance(docs[a.document], { acts: pick(a.acts), actReceipts: receiptsFor(a.act_receipts), resolveHandle: (h) => map[h], mandates, owners, receivedAt: a.received_at });
        if (a.expected.ok) expect([a.case, r.ok, r.ok ? r.owner : null]).toEqual([a.case, true, a.expected.owner]);
        else expect([a.case, r.ok ? null : r.step]).toEqual([a.case, a.expected.step]);
      }
      break;
    case "act_checks":
      expect(actBytes(acts[life.act_checks.act_bytes.act])).toBe(life.act_checks.act_bytes.bytes);
      for (const a of cases!) {
        const r = checkAct(docs[a.document], acts[a.act], { mandates, owners, actReceipts: receiptsFor(a.act_receipts) });
        expect([a.case, r.ok]).toEqual([a.case, a.valid]);
      }
      break;
    case "states":
      for (const s of cases!) {
        const doc = s.unsigned ? { ...docs[s.document], signatures: [] } : docs[s.document];
        const r = deriveState(doc, {
          now: s.now,
          acts: pick(s.acts),
          actReceipts: receiptsFor(s.act_receipts),
          laterVersions: (s.later_versions ?? []).map((n: string) => docs[n]),
          mandates,
          owners,
        });
        const w = s.expected;
        expect([s.case, r.state]).toEqual([s.case, w.state]);
        if (w.effective_at) expect([s.case, r.effectiveAt]).toEqual([s.case, w.effective_at]);
        if (w.ended_at) expect([s.case, r.endedAt]).toEqual([s.case, w.ended_at]);
        if (w.duties_end_at) expect([s.case, r.dutiesEndAt]).toEqual([s.case, w.duties_end_at]);
        if (w.termination_pending) expect([s.case, r.terminationPending]).toEqual([s.case, w.termination_pending]);
        if (w.departed) expect([s.case, r.departed]).toEqual([s.case, w.departed]);
      }
      break;
    case "bound":
      for (const b of cases!) {
        const a = isBound(b.reference, b.party, { documents: b.documents.map((n: string) => docs[n]), acts: pick(b.acts), now: b.now, mandates, owners });
        expect([b.case, a.bound, a.bound ? a.rule : undefined]).toEqual([b.case, b.expected.bound, b.expected.bound ? b.expected.rule : undefined]);
      }
      break;
    case "gate":
      for (const g of cases!) {
        const a = checkGateRelease({
          gate: g.gate,
          presented: docs[g.presented],
          posterAgent: g.poster,
          requesterAgent: g.requester,
          acts: pick(g.acts),
          actReceipts: receiptsFor(g.act_receipts),
          now: g.now,
          mandates,
          owners,
          receivedAt: g.received_at as string,
        });
        expect([g.case, a.release]).toEqual([g.case, g.expected.release]);
        if (a.release && g.expected.owner !== undefined) expect([g.case, a.owner]).toEqual([g.case, g.expected.owner]);
        if (!a.release) expect([g.case, a.check]).toEqual([g.case, g.expected.check]);
      }
      break;
    case "mandates":
    case "registry":
    case "act_receipts":
      // Lookups the other cases read through.
      expect(Object.keys(c.value).length).toBeGreaterThan(0);
      break;
    default:
      throw new Error(`a lifecycle section this suite does not run: ${c.name}`);
  }
};

describeVectors("nda", {
  checks: {
    "nda-offer.json": { traps: trap },
    "nda-grading.json": {
      valid: (c) => {
        const r = validateAgreement(edit(base, c.value.edit as Record<string, unknown>));
        expect(r.ok ? [] : r.errors).toEqual([]);
      },
      invalid: (c) => {
        const r = validateAgreement(edit(base, c.value.edit as Record<string, unknown>));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.map((e) => e.code)).toContain(c.value.error);
      },
    },
    "nda-lifecycle.json": { document: lifecycle },
  },
});

describe("nda-offer.json: identity, bytes, digests and records (4.1, 6, 6.1, 8)", () => {
  it("hashes the version-1 offer minus id and signatures for the identifier", () => {
    expect(hashedForId(offer)).toBe(offerFx.offer.hashed_for_id);
    expect(mintId(offer)).toBe(offerFx.offer.id);
  });
  it("pins the signed bytes and both digests", () => {
    expect(signedBytes(offer)).toBe(offerFx.offer.signed_bytes);
    expect(offerDigest(offer)).toBe(offerFx.offer.offer_digest);
    expect(signedBytes(acceptance)).toBe(offerFx.acceptance.signed_bytes);
    expect(agreementDigest(acceptance)).toBe(offerFx.acceptance.agreement_digest);
    expect(offerFx.acceptance.reference.digest).toBe(agreementDigest(acceptance));
  });
  it("re-derives the offer bytes from the completed document", () => {
    expect(offerBytes(acceptance) === offerFx.offer.signed_bytes).toBe(offerFx.acceptance.offer_bytes_rederived_equal);
  });
  it("the independent verifier checks a key's prefix and checksum", () => {
    const good = offer.signatures[0].key;
    expect(nkeyRaw(good)).not.toBeNull();
    expect(nkeyRaw(good.slice(0, -1) + (good.endsWith("A") ? "B" : "A"))).toBeNull();
    // The stand-in agent keys the specification prints have the spelling but not the checksum.
    expect(nkeyRaw(offer.parties.discloser!.agent)).toBeNull();
    // A seed spelling (S prefix) is not a public key.
    expect(nkeyRaw("S" + good.slice(1))).toBeNull();
  });
  it("pins each record's signature bytes, and every record verifies, by the core and independently", () => {
    expect(signatureBytes(offer.signatures[0])).toBe(offerFx.offer.signature.signature_bytes);
    expect(signatureBytes(acceptance.signatures[1])).toBe(offerFx.acceptance.signature.signature_bytes);
    for (const d of [offer, acceptance, base, grading.multilateral.document as Agreement]) {
      for (const r of d.signatures) {
        expect(verifySignatureRecord(d, r)).toBe(true);
        expect(independentRecord(d as Fixture, r as Fixture)).toBe(true);
      }
    }
  });
  it("accepts the acceptance, with the recipient's owner confirmed", () => {
    expect(verifyAcceptance(acceptance, { mandates, owners })).toMatchObject({ ok: true, owner: "confirmed" });
  });
});

describe("nda-grading.json: the parts the runner does not list", () => {
  it("fixes the grades of 11", () => {
    expect(FIXED_GRADES).toEqual(grading.grades.fixed);
    expect(FALSE_ENFORCEMENT_MESSAGE).toBe(grading.grades.false_enforcement_message);
  });
  it("holds the closed lists of 5", () => {
    const lists = grading.closed_lists;
    expect([...CATEGORIES]).toEqual(lists.categories);
    expect([...ACTIVITIES]).toEqual(lists.activities);
    expect([...EXCLUSIONS]).toEqual(lists.exclusions);
    expect([...NEED_TO_KNOW]).toEqual(lists.need_to_know);
    expect([...SUBCONTRACTORS]).toEqual(lists.subcontractors);
    expect([...AT_END_ACTIONS]).toEqual(lists.at_end_action);
    expect([...DIRECTIONS]).toEqual(lists.direction);
  });
  const md = grading.multilateral.document as Agreement;
  for (const c of grading.multilateral.valid) {
    it(`multilateral valid: ${c.case}`, () => {
      const r = validateAgreement(edit(md, c.edit));
      expect(r.ok ? [] : r.errors).toEqual([]);
    });
  }
  for (const c of grading.multilateral.invalid) {
    it(`multilateral invalid: ${c.case} (${c.error})`, () => {
      const r = validateAgreement(edit(md, c.edit));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain(c.error);
    });
  }
  for (const c of grading.multilateral.states) {
    it(`multilateral state: ${c.case}`, () => {
      const signed = { ...md, signatures: md.signatures.slice(0, c.signatures) };
      const now = c.acts?.length ? "2027-02-02T00:00:00Z" : "2026-12-01T00:00:00Z";
      expect(deriveState(signed, { now, acts: c.acts?.length ? [acts.northgate_leaves] : [], mandates, owners }).state).toBe(c.state);
    });
  }
  const fd = grading.flow_down.document as Agreement;
  it("the flow-down names the upstream agreement", () => {
    expect(fd.flows_from).toEqual(grading.flow_down.upstream);
    expect(fd.flows_from!.digest).toBe(offerFx.acceptance.agreement_digest);
  });
  for (const c of grading.flow_down.valid) {
    it(`flow-down binds: ${c.case}`, () => {
      expect(checkFlowDown(edit(fd, c.edit), acceptance)).toEqual({ ok: true });
    });
  }
  for (const c of grading.flow_down.not_binding) {
    it(`flow-down does not bind: ${c.case}`, () => {
      expect(checkFlowDown(edit(fd, c.edit), acceptance).ok).toBe(false);
    });
  }
});

describe("sow-nda.json: what Agent SoW 5.16 asks of the reference and the agreement", () => {
  sowNda.reference.valid.forEach((v: { nda?: unknown }, i: number) => {
    it(`reference valid #${i + 1}`, () => {
      // Absence states nothing: a document without nda is valid.
      if (v.nda !== undefined) expect(checkReference(v.nda, { gradeRequired: true }).ok).toBe(true);
    });
  });
  for (const c of sowNda.reference.invalid) {
    it(`reference invalid: ${c.case}`, () => {
      expect(checkReference(c.nda, { gradeRequired: true }).ok).toBe(false);
    });
  }
  for (const c of sowNda.parties.cases) {
    it(`parties: ${c.name}`, () => {
      expect(partiesMatch(c.engagement, c.nda)).toBe(c.expected);
    });
  }
  for (const c of sowNda.disclosure.cases) {
    it(`disclosure: ${c.name}`, () => {
      expect(disclosureFits(c.nda_permits, c.confidentiality)).toEqual(c.expected);
    });
  }
});
