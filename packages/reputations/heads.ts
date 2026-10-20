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

/**
 * The sparse Merkle tree over a set of slots, built once: the slots sorted by
 * key, each key converted to bytes once, and the digest of every subtree the
 * build visits kept, so the root and any slot's proof are read from the
 * cache. The build splits the sorted slots by one bit per level, so it costs
 * a hash per subtree that holds a slot, and a proof costs one walk of 256
 * levels plus, for an absent key beside a lone slot, one climb from that
 * slot.
 */
export class SparseTree {
  private readonly keys: Buffer[];
  private readonly slots: Slot[];
  private readonly cache = new Map<string, Buffer>();
  readonly root: string;

  constructor(slots: Map<string, Slot> | readonly Slot[]) {
    const list = [...(slots instanceof Map ? slots.values() : slots)].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    this.slots = list;
    this.keys = list.map((x) => Buffer.from(x.key, "hex"));
    this.root = this.node(0, 0, list.length).toString("hex");
  }

  /** The first index in [lo, hi) whose key has bit `depth` set. */
  private split(depth: number, lo: number, hi: number): number {
    let a = lo;
    let b = hi;
    while (a < b) {
      const m = (a + b) >> 1;
      if (bitOf(this.keys[m]!, depth)) b = m;
      else a = m + 1;
    }
    return a;
  }

  /** A lone slot's digest as the root of a subtree at `depth`: its leaf, climbed through empty siblings. */
  private lone(i: number, depth: number): Buffer {
    let cur = slotDigest(this.slots[i]!);
    for (let h = 0; h < 256 - depth; h++) cur = bitOf(this.keys[i]!, 255 - h) ? H(ONE, EMPTY[h]!, cur) : H(ONE, cur, EMPTY[h]!);
    return cur;
  }

  /** The digest of the subtree at `depth` holding the slots [lo, hi). */
  private node(depth: number, lo: number, hi: number): Buffer {
    if (lo === hi) return EMPTY[256 - depth]!;
    const k = `${depth}:${lo}:${hi}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    let d: Buffer;
    if (hi - lo === 1) d = this.lone(lo, depth);
    else {
      const m = this.split(depth, lo, hi);
      d = H(ONE, this.node(depth + 1, lo, m), this.node(depth + 1, m, hi));
    }
    this.cache.set(k, d);
    return d;
  }

  /** The slot at a key, or null. */
  get(keyHex: string): Slot | null {
    let a = 0;
    let b = this.slots.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.slots[m]!.key < keyHex) a = m + 1;
      else b = m;
    }
    return a < this.slots.length && this.slots[a]!.key === keyHex ? this.slots[a]! : null;
  }

  /** The proof for one slot: each sibling's digest from the slot up to the root, null for an empty subtree. */
  proof(keyHex: string): Array<string | null> {
    const key = Buffer.from(keyHex, "hex");
    const topDown: Array<string | null> = [];
    let lo = 0;
    let hi = this.slots.length;
    for (let depth = 0; depth < 256; depth++) {
      const m = this.split(depth, lo, hi);
      const [same, other] = bitOf(key, depth) ? [[m, hi], [lo, m]] : [[lo, m], [m, hi]];
      topDown.push(other[0] === other[1] ? null : this.node(depth + 1, other[0]!, other[1]!).toString("hex"));
      [lo, hi] = same as [number, number];
    }
    return topDown.reverse();
  }
}

/** The root of the tree, in lowercase hex. */
export const smtRoot = (slots: Map<string, Slot>): string => new SparseTree(slots).root;

/** The proof for one slot: each sibling's digest from the slot up to the root, null for an empty subtree. */
export const smtProof = (slots: Map<string, Slot>, keyHex: string): Array<string | null> => new SparseTree(slots).proof(keyHex);

/** Fold a proof from a slot (null for an empty one) up to a root. */
export function rootFromProof(keyHex: string, slot: Slot | null, siblings: ReadonlyArray<string | null>): string {
  const key = Buffer.from(keyHex, "hex");
  let cur = slot ? slotDigest(slot) : EMPTY[0]!;
  for (let h = 0; h < 256; h++) {
    const sb = siblings[h];
    const sib = sb === null || sb === undefined ? EMPTY[h]! : Buffer.from(sb, "hex");
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
export function commitmentOf(x: { bureau: string; issuedAt: string; slots: Map<string, Slot>; prev: Commitment | null; root?: string }): Commitment {
  const values = [...x.slots.values()];
  return {
    bureau: x.bureau,
    seq: x.prev ? x.prev.seq + 1 : 1,
    prev: x.prev ? commitmentHash(x.prev) : null,
    issued_at: x.issuedAt,
    // The root of a tree the caller already built over these slots, or this one's.
    root: x.root ?? smtRoot(x.slots),
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

/** The commitment a change of the witness list takes effect after: null before any commitment. */
export type ChangeAfter = { seq: number; commitment: string } | null;

/**
 * Whether a co-signer may co-sign a commitment (rule 1, Agent Reputations
 * 0.11.0-draft): the one that extends the last it co-signed for that bureau;
 * or, for its first, where its record starts. A witness named before the
 * first commitment (`start` null) starts with seq 1 and no prev; one that
 * joined through a change starts after the commitment the change names in
 * `after`, and never co-signs that one or any before it. So it never
 * co-signs two commitments with one seq.
 */
export function witnessCosigns(last: Commitment | null, c: Commitment, start: ChangeAfter = null): "ok" | string {
  if (!last && start === null) return c.seq === 1 && c.prev === null ? "ok" : "the witness co-signs a bureau's first commitment first";
  if (!last && start) {
    if (c.seq <= start.seq) return "a joining witness never co-signs the commitment its change names or one before it";
    if (c.seq !== start.seq + 1 || c.prev !== start.commitment) return "a joining witness first co-signs the commitment after the one its change names";
    return "ok";
  }
  if (!last) return "the witness has no record";
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
  /** The commitment current when the change takes effect (0.11.0-draft): the old list is named for it and every one before, the new list for every one after. */
  after: ChangeAfter;
  witnesses: Witness[];
}

/**
 * A change of the witness list holds when it is this bureau's, changes the
 * list the consumer pinned, adds or removes exactly one witness (§4.1.1: a
 * new witness joins in one change and an old one leaves in a later one),
 * names in `after` a commitment the bureau published and every witness on
 * the list it replaces co-signed, never before the `after` of the change
 * before it (`prior`), and every co-signer on the list it changes signed it.
 * `published` maps a seq to the commitment and its co-signatures.
 */
export function witnessChangeSigned(
  pinned: readonly Witness[],
  change: WitnessChange,
  signatures: readonly Cosignature[],
  opts: { bureau?: string; published?: ReadonlyMap<number, { commitment: Commitment; cosignatures: readonly Cosignature[] }>; prior?: ChangeAfter } = {},
): "ok" | string {
  if (opts.bureau !== undefined && change.bureau !== opts.bureau) return "it is another bureau's change";
  if (change.previous !== witnessListHash(pinned)) return "it does not change the list the consumer pinned";
  if (!("after" in change)) return "it does not name the commitment it takes effect after";
  const after = change.after;
  const prior = opts.prior ?? null;
  if (after !== null) {
    if (typeof after !== "object" || Object.keys(after).sort().join() !== "commitment,seq" || !Number.isInteger(after.seq) || after.seq < 1) return "its after is not a seq and a commitment hash";
    const c = opts.published?.get(after.seq);
    if (!c || commitmentHash(c.commitment) !== after.commitment) return "its after names a commitment the bureau did not publish";
    if (cosignedByAll(c.commitment, c.cosignatures, pinned) !== "ok") return "the witnesses it replaces have not all co-signed the commitment it names";
    if (prior !== null && after.seq < prior.seq) return "it takes effect before the change before it";
  } else if (prior !== null) return "it takes effect before the change before it";
  const id = (w: Witness) => `${w.id}|${w.key}|${w.kind}`;
  const before = new Set(pinned.map(id));
  const afterList = new Set(change.witnesses.map(id));
  const moved = [...before].filter((w) => !afterList.has(w)).length + [...afterList].filter((w) => !before.has(w)).length;
  if (moved !== 1) return "a change adds or removes exactly one witness";
  const bytes = signedBytes(WITNESSES_TAG, change);
  for (const w of pinned.filter((x) => x.kind === "cosigner")) {
    const sg = signatures.find((x) => x.witness === w.id);
    if (!sg || !verifiesUnder(bytes, w.key, sg.sig)) return `${w.id}, on the list it changes, has not signed it`;
  }
  return "ok";
}

/** The witnesses named for a commitment's seq: the pinned list moved along every change that takes effect before it. */
export function witnessesFor(pinned: readonly Witness[], changes: ReadonlyArray<{ change: WitnessChange }>, seq: number): readonly Witness[] {
  let list = pinned;
  for (const { change } of changes) {
    if (change.after !== null && change.after.seq >= seq) break;
    list = change.witnesses;
  }
  return list;
}

/** Where a witness's record starts: null for one named before the first commitment, the `after` of the change that added it otherwise, undefined for one never named. */
export function witnessStart(pinned: readonly Witness[], changes: ReadonlyArray<{ change: WitnessChange }>, id: string): ChangeAfter | undefined {
  let list = pinned;
  if (list.some((w) => w.id === id)) return null;
  for (const { change } of changes) {
    if (!list.some((w) => w.id === id) && change.witnesses.some((w) => w.id === id)) return change.after;
    list = change.witnesses;
  }
  return undefined;
}
