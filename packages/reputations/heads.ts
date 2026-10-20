/**
 * The commitment over every subject's log (Agent Reputations §4.1.1), for a
 * bureau that keeps one log per subject: the sparse Merkle tree of height 256
 * with one slot per subject, keyed by the subject's canonical caseless form;
 * the chained commitment over its root, signed under `fdbk-heads-v1`; the
 * witnesses' co-signatures under `fdbk-heads-cosign-v1` and their rules; the
 * changes to the witness list under `fdbk-witnesses-v1`; proofs of a slot;
 * and what a later commitment may change of an earlier one.
 *
 * Pure: the bureau supplies the heads, the tombstones and the signing key, and
 * this decides the bytes.
 * `casefolding-15.1.0.json` beside this file is Unicode data under the
 * Unicode License V3 (LICENSE-UNICODE beside it), a pinned copy of the
 * standard's conformance file.
 */
import { createHash } from "node:crypto";
import { USER_KEY_RE, decodeSignature, encodeSignature, rawFromBase64Key, rawUserKey, verifyRaw } from "@common-agent/crypto";
import CASEFOLDING from "./casefolding-15.1.0.json" with { type: "json" };
import { jcs, kidOf, signedBytes, type ReportSigner } from "./signing.js";

export const HEADS_TAG = "fdbk-heads-v1";
export const COSIGN_TAG = "fdbk-heads-cosign-v1";
export const WITNESSES_TAG = "fdbk-witnesses-v1";

// ── the slot key (§4.1.1, the tree) ─────────────────────────────────────────

const FOLD = (CASEFOLDING as { fold: Record<string, string> }).fold;

/**
 * A subject's canonical caseless form (Unicode D145, at 15.1.0): NFD, full
 * case folding (the C and F entries of CaseFolding.txt), NFD again, as
 * Personal Agent Naming §2 compares handles.
 */
export function foldSubject(subject: string): string {
  const table = FOLD;
  let out = "";
  for (const ch of subject.normalize("NFD")) {
    const hex = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    const to = table[hex];
    out += to ? String.fromCodePoint(...to.split(" ").map((h) => parseInt(h, 16))) : ch;
  }
  return out.normalize("NFD");
}

/** The slot key: the SHA-256 of the UTF-8 of the folded subject, in lowercase hex. */
export const subjectKey = (subject: string): string => createHash("sha256").update(foldSubject(subject), "utf8").digest("hex");

/** What a slot holds: a subject's head, or the tombstone of an erased subject. */
export type Slot =
  | { key: string; subject: string; seq: number; head_hash: string; after_erasure?: string }
  | { key: string; erased_at: string };

export interface Head {
  subject: string;
  seq: number;
  head_hash: string;
  after_erasure?: string;
}
export interface Tombstone {
  key: string;
  erased_at: string;
}

const isTombstone = (s: Slot): s is Extract<Slot, { erased_at: string }> => "erased_at" in s;

/** The object a slot's digest is taken over. */
export function slotBody(slot: Slot): Record<string, unknown> {
  if (isTombstone(slot)) return { erased_at: slot.erased_at, key: slot.key };
  return { ...(slot.after_erasure ? { after_erasure: slot.after_erasure } : {}), head_hash: slot.head_hash, key: slot.key, seq: slot.seq, subject: slot.subject };
}

const H = (...parts: Uint8Array[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const ONE = Buffer.from([1]);

/** A filled slot's digest: SHA-256 over 0x00 and the JCS of what it holds. */
export const slotDigest = (slot: Slot): Buffer => H(Buffer.from([0]), Buffer.from(jcs(slotBody(slot)), "utf8"));

/** EMPTY[h]: the digest of an empty subtree of height h. */
export const EMPTY: Buffer[] = [Buffer.alloc(32)];
for (let i = 1; i <= 256; i++) EMPTY.push(H(ONE, EMPTY[i - 1]!, EMPTY[i - 1]!));

const bitOf = (key: Buffer, i: number) => (key[i >> 3]! >> (7 - (i & 7))) & 1;

/** The slots of a tree, one per subject. Two entries for one slot are refused. */
export function slotsOf(heads: readonly Head[], tombstones: readonly Tombstone[] = []): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const put = (slot: Slot) => {
    if (slots.has(slot.key)) throw new Error(`two entries for the slot ${slot.key}`);
    slots.set(slot.key, slot);
  };
  for (const h of heads) put({ ...h, key: subjectKey(h.subject) });
  for (const t of tombstones) put({ key: t.key, erased_at: t.erased_at });
  return slots;
}

function subtree(entries: Slot[], depth: number): Buffer {
  if (!entries.length) return EMPTY[256 - depth]!;
  if (depth === 256) return slotDigest(entries[0]!);
  const side = (e: Slot) => bitOf(Buffer.from(e.key, "hex"), depth);
  return H(ONE, subtree(entries.filter((e) => side(e) === 0), depth + 1), subtree(entries.filter((e) => side(e) === 1), depth + 1));
}

/** The root of the tree, in lowercase hex. */
export const smtRoot = (slots: Map<string, Slot>): string => subtree([...slots.values()], 0).toString("hex");

/** The proof for one slot: each sibling's digest from the slot up to the root, null for an empty subtree. */
export function smtProof(slots: Map<string, Slot>, keyHex: string): Array<string | null> {
  const key = Buffer.from(keyHex, "hex");
  const topDown: Array<string | null> = [];
  let entries = [...slots.values()];
  for (let depth = 0; depth < 256; depth++) {
    const b = bitOf(key, depth);
    const same = entries.filter((e) => bitOf(Buffer.from(e.key, "hex"), depth) === b);
    const other = entries.filter((e) => bitOf(Buffer.from(e.key, "hex"), depth) !== b);
    topDown.push(other.length ? subtree(other, depth + 1).toString("hex") : null);
    entries = same;
  }
  return topDown.reverse();
}

/** Fold a proof from a slot (null for an empty one) up to a root. */
export function rootFromProof(keyHex: string, slot: Slot | null, siblings: ReadonlyArray<string | null>): string {
  const key = Buffer.from(keyHex, "hex");
  let cur = slot ? slotDigest(slot) : EMPTY[0]!;
  for (let h = 0; h < 256; h++) {
    const s = siblings[h];
    const sib = s === null || s === undefined ? EMPTY[h]! : Buffer.from(s, "hex");
    cur = bitOf(key, 255 - h) ? H(ONE, sib, cur) : H(ONE, cur, sib);
  }
  return cur.toString("hex");
}

// ── the commitment ──────────────────────────────────────────────────────────

export interface Commitment {
  bureau: string;
  seq: number;
  prev: string | null;
  issued_at: string;
  root: string;
  subjects: number;
  tombstones: number;
}

export interface CommitmentEnvelope {
  heads: Commitment;
  bureau_key: string;
  bureau_kid: string;
  bureau_sig: string;
}

/** SHA-256, in lowercase hex, of a commitment's signed bytes: the next one's `prev`, and what a witness co-signs. */
export const commitmentHash = (c: Commitment): string => createHash("sha256").update(signedBytes(HEADS_TAG, c)).digest("hex");

/** The commitment over these slots, after `prev` (null for the first). */
export function commitmentOf(x: { bureau: string; issuedAt: string; slots: Map<string, Slot>; prev: Commitment | null }): Commitment {
  const values = [...x.slots.values()];
  return {
    bureau: x.bureau,
    seq: x.prev ? x.prev.seq + 1 : 1,
    prev: x.prev ? commitmentHash(x.prev) : null,
    issued_at: x.issuedAt,
    root: smtRoot(x.slots),
    subjects: values.filter((s) => !isTombstone(s)).length,
    tombstones: values.filter(isTombstone).length,
  };
}

/** The commitment signed as a report is (§8.1.1), under `fdbk-heads-v1`. */
export function signCommitment(c: Commitment, signer: ReportSigner & { kid?: string }): CommitmentEnvelope {
  const sig = encodeSignature(signer.sign(signedBytes(HEADS_TAG, c)));
  const kid = kidOf(signer.key);
  return { heads: c, bureau_key: signer.key, bureau_kid: kid, bureau_sig: sig };
}

/** Whether `sig` (padded base64) is `key`'s Ed25519 signature over `bytes`; `key` padded base64 or an nkey. */
export function verifiesUnder(bytes: Uint8Array, key: string, sig: string): boolean {
  const raw = USER_KEY_RE.test(key) ? rawUserKey(key) : rawFromBase64Key(key);
  return verifyRaw(raw, bytes, decodeSignature(sig, "base64"));
}

/** Every tombstone in a commitment is dated no later than the commitment. */
export function erasuresDated(c: Pick<Commitment, "issued_at">, tombstones: readonly Tombstone[]): "ok" | string {
  for (const t of tombstones) if (Date.parse(t.erased_at) > Date.parse(c.issued_at)) return `the erasure of ${t.key.slice(0, 12)}… is dated after the commitment`;
  return "ok";
}

/** A commitment follows another: the next sequence number, and `prev` naming the previous one's signed bytes. */
export function followsFrom(prev: Commitment, next: Commitment): "ok" | string {
  if (next.seq !== prev.seq + 1) return `the sequence number is ${next.seq}, after ${prev.seq}`;
  if (next.prev !== commitmentHash(prev)) return "prev does not name the previous commitment";
  return "ok";
}

/**
 * Every slot of the earlier commitment carried forward: a head stays or
 * moves up its own log unless a tombstone replaces it; a tombstone stays, or
 * gives way to a head that names the erasure in `after_erasure`; no slot
 * simply empties.
 */
export function carriesForward(prevSlots: Map<string, Slot>, slots: Map<string, Slot>): "ok" | string {
  for (const [key, was] of prevSlots) {
    const now = slots.get(key);
    if (!now) return `the slot ${key.slice(0, 12)}… emptied without a tombstone`;
    if (isTombstone(was)) {
      if (isTombstone(now) ? now.erased_at !== was.erased_at : now.after_erasure !== was.erased_at) return `the erased slot ${key.slice(0, 12)}… came back without naming its erasure`;
      continue;
    }
    if (isTombstone(now)) continue;
    if ((now.after_erasure ?? null) !== (was.after_erasure ?? null)) return `the slot ${key.slice(0, 12)}… changed its erasure`;
    if (now.seq < was.seq) return `the head of ${was.subject} went back from ${was.seq} to ${now.seq}`;
    if (now.seq === was.seq && now.head_hash !== was.head_hash) return `the head of ${was.subject} at ${was.seq} changed its hash`;
  }
  return "ok";
}

// ── witnesses ───────────────────────────────────────────────────────────────

export interface Witness {
  id: string;
  key: string;
  kind: "cosigner" | "log";
}
export interface Cosignature {
  witness: string;
  kid?: string;
  sig: string;
}

/** What a co-signer signs: the bureau, the seq, and the commitment's hash. */
export const cosignedObject = (c: Commitment) => ({ bureau: c.bureau, commitment: commitmentHash(c), seq: c.seq });

/** A co-signature by one witness's signer. */
export function cosign(c: Commitment, witness: string, signer: ReportSigner): Cosignature {
  return { witness, sig: encodeSignature(signer.sign(signedBytes(COSIGN_TAG, cosignedObject(c)))) };
}

/**
 * Whether a co-signer may co-sign a commitment (rule 1): the bureau's first
 * with seq 1 and no prev, or the one that extends the last it co-signed for
 * that bureau. So it never co-signs two commitments with one seq.
 */
export function witnessCosigns(last: Commitment | null, c: Commitment): "ok" | string {
  if (!last) return c.seq === 1 && c.prev === null ? "ok" : "the witness co-signs a bureau's first commitment first";
  if (c.bureau !== last.bureau) return "another bureau";
  if (c.seq !== last.seq + 1 || c.prev !== commitmentHash(last)) return "it does not extend the last commitment the witness co-signed";
  return "ok";
}

/** Every co-signer the key set names has co-signed the commitment. */
export function cosignedByAll(c: Commitment, cosignatures: readonly Cosignature[], witnesses: readonly Witness[]): "ok" | string {
  const bytes = signedBytes(COSIGN_TAG, cosignedObject(c));
  for (const w of witnesses.filter((x) => x.kind === "cosigner")) {
    const s = cosignatures.find((x) => x.witness === w.id);
    if (!s || !verifiesUnder(bytes, w.key, s.sig)) return `${w.id} has not co-signed it`;
  }
  return "ok";
}

/** The SHA-256 in lowercase hex of the JCS of a witness list: what a change names as `previous`. */
export const witnessListHash = (list: readonly Witness[]): string => createHash("sha256").update(jcs(list), "utf8").digest("hex");

export interface WitnessChange {
  bureau: string;
  previous: string;
  witnesses: Witness[];
}

/** A change of the witness list holds when every co-signer on the list it changes signed it. */
export function witnessChangeSigned(pinned: readonly Witness[], change: WitnessChange, signatures: readonly Cosignature[]): "ok" | string {
  if (change.previous !== witnessListHash(pinned)) return "it does not change the list the consumer pinned";
  const bytes = signedBytes(WITNESSES_TAG, change);
  for (const w of pinned.filter((x) => x.kind === "cosigner")) {
    const s = signatures.find((x) => x.witness === w.id);
    if (!s || !verifiesUnder(bytes, w.key, s.sig)) return `${w.id}, on the list it changes, has not signed it`;
  }
  return "ok";
}
