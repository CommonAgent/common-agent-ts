/**
 * The signature records on an agreement at Agent NDA 0.2.0-draft (§6,
 * §6.2): which bytes each covers, whether it verifies, which seat it signs
 * for, and how its key is bound to that seat. Signing, acceptance and acts
 * all read these, so they live apart from all three.
 *
 * Each signature signs its own record with `sig` removed, and the record
 * carries `digest`, the digest of the bytes it covers: the agreement digest,
 * or the offer digest on the discloser's record of an open offer (`"over":
 * "offer"`). So the signature binds the document and every member of the
 * record, and a record's members are a closed set.
 *
 * A signature counts for its seat only when its key is bound to the seat:
 * the seat's `owner_key`, confirmed against the registry's owner of the
 * seat's agent where that can be resolved, or, for a seat that names an
 * organization, the `holder.key` of the mandate the record cites, in force
 * when it was signed and when the verifier received it.
 */
import { agreementDigest, offerDigest, signatureBytes } from "./bytes.js";
import { utf8, verifyBytes } from "./crypto.js";
import type { MandateLookup, MandateQuery, OwnerResolver } from "./ports.js";
import type { Agreement, Category, Seat, SignatureRecord } from "./types.js";

/** §6: the members a signature record may carry. Anything else is refused. */
export const RECORD_MEMBERS = ["role", "key", "signed_at", "digest", "sig", "over", "agent", "mandate"] as const;

/** The digest a record must carry: the offer digest for a record over the
 *  offer, the agreement digest otherwise. */
export function expectedDigest(doc: Agreement, rec: Pick<SignatureRecord, "over">): string {
  return rec.over === "offer" ? offerDigest(doc) : agreementDigest(doc);
}

/**
 * Whether one signature record verifies: its members are the closed set,
 * `over` sits only on the discloser's record of a document with an `offer`,
 * it carries the right digest, and its signature is good over its own
 * record. Binding is separate.
 */
export function verifySignatureRecord(doc: Agreement, rec: SignatureRecord): boolean {
  if (Object.keys(rec).some((k) => !(RECORD_MEMBERS as readonly string[]).includes(k))) return false;
  if (rec.over !== undefined && (rec.over !== "offer" || rec.role !== "discloser" || !doc.offer)) return false;
  return rec.digest === expectedDigest(doc, rec) && verifyBytes(rec.key, utf8(signatureBytes(rec)), rec.sig);
}

/** The seat a signature record signs for, or undefined when it names none. */
export function seatOf(doc: Agreement, rec: { role: SignatureRecord["role"]; agent?: string }): Seat | undefined {
  if (rec.role === "member") return doc.parties.members?.find((m) => m.agent === rec.agent);
  if (rec.role === "discloser") return doc.parties.discloser;
  if (rec.role === "recipient") return doc.parties.recipient ?? undefined;
  return undefined;
}

/** Every seat of the agreement, by the role a signature record names it with. */
export function seatsOf(doc: Agreement): { role: SignatureRecord["role"]; seat: Seat | null }[] {
  if (doc.direction === "multilateral") return (doc.parties.members ?? []).map((seat) => ({ role: "member" as const, seat }));
  return [
    { role: "discloser" as const, seat: doc.parties.discloser ?? null },
    { role: "recipient" as const, seat: doc.parties.recipient ?? null },
  ];
}

/**
 * How a key stands to a seat (§6, binding):
 *   bound        bound and confirmed: the seat's owner_key, which the
 *                registry names as the agent's owner; or the holder key of a
 *                mandate that checked at signing and at receipt
 *   unconfirmed  the seat's owner_key, but the registry's owner of the
 *                agent could not be resolved, so the binding is evidence
 *   unchecked    an organization's seat whose mandate check was not run
 *   unbound      any other key, an owner_key the registry contradicts, or a
 *                mandate that was refused
 */
export type BindingStatus = "bound" | "unconfirmed" | "unchecked" | "unbound";

export interface BindingContext {
  mandates?: MandateLookup;
  owners?: OwnerResolver;
  /** When this verifier received the record or act, where it did. */
  receivedAt?: string;
}

export function bindingOf(seat: Seat, key: string, mandate: string | undefined, categories: Category[], signedAt: string, ctx: BindingContext = {}): BindingStatus {
  if (seat.organization === undefined) {
    if (seat.owner_key !== key) return "unbound";
    const found = ctx.owners?.(seat.agent);
    // Only an owner the registry verified through an owner_attestation
    // confirms or contradicts; a default node-key owner, an unlisted agent
    // or an unreachable registry leaves the owner unconfirmed.
    if (found === undefined || !found.attested) return "unconfirmed";
    return found.owner === seat.owner_key ? "bound" : "unbound";
  }
  if (!mandate) return "unbound";
  if (!ctx.mandates) return "unchecked";
  const q = (at: string) => ctx.mandates!({ mandate, signer: key, organization: seat.organization!, categories, at });
  const answers = [q(signedAt), ...(ctx.receivedAt ? [q(ctx.receivedAt)] : [])];
  if (answers.includes("refused")) return "unbound";
  return answers.every((a) => a === "ok") ? "bound" : "unchecked";
}

/** The mandate checks an agreement's signatures call for (§6.2). */
export function mandateQueries(doc: Agreement): { record: SignatureRecord; query: MandateQuery | null }[] {
  const out: { record: SignatureRecord; query: MandateQuery | null }[] = [];
  for (const rec of doc.signatures) {
    const seat = seatOf(doc, rec);
    if (!seat?.organization) continue;
    out.push({
      record: rec,
      query: rec.mandate
        ? { mandate: rec.mandate, signer: rec.key, organization: seat.organization, categories: doc.covers.categories, at: rec.signed_at }
        : null,
    });
  }
  return out;
}

export interface SeatSignature {
  role: SignatureRecord["role"];
  seat: Seat | null;
  record?: SignatureRecord;
  valid: boolean;
  binding: BindingStatus;
}

export function seatSignatures(doc: Agreement, ctx: BindingContext = {}): SeatSignature[] {
  return seatsOf(doc).map(({ role, seat }) => {
    const record = doc.signatures.find((s) => s.role === role && (role !== "member" || s.agent === seat?.agent));
    if (!record || !seat) return { role, seat, record, valid: false, binding: "unbound" as BindingStatus };
    const valid = verifySignatureRecord(doc, record);
    const binding = bindingOf(seat, record.key, record.mandate, doc.covers.categories, record.signed_at, ctx);
    return { role, seat, record, valid, binding };
  });
}

/** A seat's signature counts when it verifies and its key is not unbound. */
export function counts(s: SeatSignature): boolean {
  return s.valid && s.binding !== "unbound";
}

/** Whether a seat's signature carries a decision that rides on the binding
 *  (§8.1; Agent RFP §5.11.3; Agent Reputations §4.8): a seat without an
 *  organization needs its owner confirmed, because an unconfirmed owner must
 *  never do better than one the registry contradicts. */
export function decides(s: SeatSignature, doc?: Agreement): boolean {
  if (!s.valid || !s.seat) return false;
  // An organization's seat decides only when its mandate checked, at signing
  // and, where there was a receipt, at receipt (§6.2, §8.1). A check that was
  // not run, or answered unknown, decides nothing.
  if (s.seat.organization !== undefined) return s.binding === "bound";
  // The recipient of an open offer whose discloser chose owners: any counts
  // with an unconfirmed owner; a contradicted one never counts (§6.1).
  if (s.role === "recipient" && doc?.offer?.owners === "any") return s.binding === "bound" || s.binding === "unconfirmed";
  return s.binding === "bound";
}

export function isCountersigned(doc: Agreement, ctx: BindingContext = {}): boolean {
  if (doc.parties.recipient === null) return false;
  const all = seatSignatures(doc, ctx);
  return all.length > 0 && all.every(counts);
}

/** Whether every seat's binding was confirmed: no organization's mandate left
 *  unchecked and no owner left unconfirmed (§6, §6.2). */
export function bindingConfirmed(doc: Agreement, ctx: BindingContext = {}): boolean {
  return seatSignatures(doc, ctx).every((s) => s.binding === "bound");
}
