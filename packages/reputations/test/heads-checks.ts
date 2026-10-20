/**
 * The checks of fdbk-heads-v1 (Agent Reputations §4.1.1) against this core: slot keys by
 * the canonical caseless form, the two chained commitments signed with the
 * report test key and co-signed by both test witnesses, the witness change,
 * the proofs, and every case a conforming check refuses.
 */
import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { CaseCheck } from "../../vectors/vitest.js";
import { loadPinnedVectors } from "../../vectors/index.js";
import {
  EMPTY,
  carriesForward,
  commitmentHash,
  commitmentOf,
  cosignedByAll,
  erasuresDated,
  followsFrom,
  foldSubject,
  rootFromProof,
  seedSigner,
  signCommitment,
  slotDigest,
  slotsOf,
  smtProof,
  smtRoot,
  subjectKey,
  witnessChangeSigned,
  witnessCosigns,
  type Commitment,
  type Cosignature,
  type Head,
  type Slot,
  type Tombstone,
  type Witness,
  type WitnessChange,
} from "../index.js";

interface CommitmentVector {
  name: string;
  heads: Head[];
  tombstones: Tombstone[];
  slots: Array<{ key: string; digest: string }>;
  envelope: { heads: Commitment; bureau_key: string; bureau_kid: string; bureau_sig: string };
  signed_bytes: string;
  signed_bytes_sha256: string;
  cosignatures: Cosignature[];
}

const report = loadPinnedVectors("reputations/conformance/fdbk-report-v1.json").data as { test_key: { seed_hex: string } };
const signer = seedSigner(new Uint8Array(Buffer.from(report.test_key.seed_hex, "hex")));
const commitments = (file: Record<string, unknown>) => Object.fromEntries((file.commitments as CommitmentVector[]).map((c) => [c.name, c]));
const witnessesOf = (file: Record<string, unknown>) => (file.key_set as { witnesses: Witness[] }).witnesses;

const slotKeyCase: CaseCheck = (c) => {
  const v = c.value as { a: string; b: string; folded: string; key: string };
  expect(foldSubject(v.a)).toBe(v.folded);
  expect(subjectKey(v.a)).toBe(v.key);
  expect(subjectKey(v.b)).toBe(v.key);
};

const commitmentCase: CaseCheck = (c, file) => {
  const v = c.value as unknown as CommitmentVector;
  const all = file.commitments as CommitmentVector[];
  const i = all.findIndex((x) => x.name === v.name);
  const prev = i > 0 ? all[i - 1]! : null;
  const slots = slotsOf(v.heads, v.tombstones);
  expect([...slots.values()].map((s) => ({ key: s.key, digest: slotDigest(s).toString("hex") })).sort((a, b) => a.key.localeCompare(b.key))).toEqual(v.slots);
  const built = commitmentOf({ bureau: v.envelope.heads.bureau, issuedAt: v.envelope.heads.issued_at, slots, prev: prev ? prev.envelope.heads : null });
  expect(built).toEqual(v.envelope.heads);
  const env = signCommitment(built, signer);
  expect(env).toEqual(v.envelope);
  expect(createHash("sha256").update(v.signed_bytes, "utf8").digest("hex")).toBe(v.signed_bytes_sha256);
  expect(erasuresDated(built, v.tombstones)).toBe("ok");
  expect(cosignedByAll(built, v.cosignatures, witnessesOf(file))).toBe("ok");
  expect(witnessCosigns(prev ? prev.envelope.heads : null, built)).toBe("ok");
  if (prev) {
    expect(followsFrom(prev.envelope.heads, built)).toBe("ok");
    expect(carriesForward(slotsOf(prev.heads, prev.tombstones), slots)).toBe("ok");
  }
  expect(EMPTY[256]!.toString("hex")).toBe(file.empty_root);
};

const proofCase: CaseCheck = (c, file) => {
  const p = c.value as { commitment: string; kind: string; key: string; siblings: Array<string | null> };
  const cv = commitments(file)[p.commitment]!;
  const slots = slotsOf(cv.heads, cv.tombstones);
  expect(smtProof(slots, p.key)).toEqual(p.siblings);
  expect(rootFromProof(p.key, p.kind === "absent" ? null : slots.get(p.key)!, p.siblings)).toBe(cv.envelope.heads.root);
  expect(smtRoot(slots)).toBe(cv.envelope.heads.root);
};

/** The key set's witness list follows from the pinned one by changes every earlier witness signed. */
const witnessListCase: CaseCheck = (_c, file) => {
  const ks = file.key_set as { witnesses: Witness[]; witness_changes: Array<{ change: WitnessChange; signatures: Cosignature[] }> };
  let list = file.pinned_witnesses as Witness[];
  for (const ch of ks.witness_changes) {
    expect(witnessChangeSigned(list, ch.change, ch.signatures)).toBe("ok");
    list = ch.change.witnesses;
  }
  expect(list).toEqual(ks.witnesses);
};

const mustFailCase: CaseCheck = (c, file) => {
  const f = c.value as Record<string, unknown> & { check: string };
  const by = commitments(file);
  const witnesses = witnessesOf(file);
  let res = "ok";
  if (f.check === "proof") {
    const cv = by[f.commitment as string]!;
    const p = (file.proofs as Array<{ name: string; key: string; siblings: Array<string | null> }>).find((x) => x.name === f.proof)!;
    const slot = f.slot === null ? null : ({ ...(f.slot as object), key: p.key } as Slot);
    res = rootFromProof(p.key, slot, p.siblings) === cv.envelope.heads.root ? "ok" : "the proof does not reach the root";
  } else if (f.check === "build") {
    try {
      slotsOf(f.heads as Head[], (f.tombstones as Tombstone[]) ?? []);
    } catch (e) {
      res = (e as Error).message;
    }
  } else if (f.check === "chain") {
    res = followsFrom(by[f.after as string]!.envelope.heads, { ...by[f.commitment as string]!.envelope.heads, ...(f.set as object) });
  } else if (f.check === "extension") {
    const base = by[f.after as string]!;
    res = carriesForward(slotsOf(base.heads, base.tombstones), slotsOf(f.heads as Head[], (f.tombstones as Tombstone[]) ?? []));
  } else if (f.check === "erasure") {
    res = erasuresDated(by[f.commitment as string]!.envelope.heads, f.tombstones as Tombstone[]);
  } else if (f.check === "witness") {
    res = witnessCosigns(by[f.after as string]!.envelope.heads, { ...by[f.commitment as string]!.envelope.heads, ...(f.set as object) });
  } else if (f.check === "fork") {
    const branches = f.branches as Array<{ set: object; cosignatures: Cosignature[] }>;
    res = branches.some((b) => cosignedByAll({ ...by[f.commitment as string]!.envelope.heads, ...b.set }, b.cosignatures, witnesses) === "ok") ? "ok" : "no branch carries every named co-signer";
  } else if (f.check === "witness_change") {
    res = witnessChangeSigned(witnesses, f.change as WitnessChange, f.signatures as Cosignature[]);
  } else {
    throw new Error(`no check for ${f.check}`);
  }
  expect(res, String(f.reason)).not.toBe("ok");
};

/** The case folding is the pinned table the slot key reads. */
const foldingCase: CaseCheck = (c) => {
  expect(c.name).toBe("fold");
  expect(foldSubject("ẞ")).toBe("ss");
};

/** A test witness's seed gives the key the vector names. */
const testWitnessCase: CaseCheck = (c) => {
  const w = c.value as { seed_hex: string; public_key: string };
  expect(seedSigner(new Uint8Array(Buffer.from(w.seed_hex, "hex"))).key).toBe(w.public_key);
};

/** The checks for fdbk-heads-v1 and the case folding, which test/vectors.test.ts runs with the rest. */
export const headsChecks: Record<string, Record<string, CaseCheck>> = {
  "fdbk-heads-v1.json": {
    slot_keys: slotKeyCase,
    commitments: commitmentCase,
    proofs: proofCase,
    pinned_witnesses: witnessListCase,
    test_witnesses: testWitnessCase,
    must_fail: mustFailCase,
  },
  "casefolding-15.1.0.json": { document: foldingCase },
};
