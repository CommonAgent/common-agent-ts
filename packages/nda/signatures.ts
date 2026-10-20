/**
 * Signing agreements (§6), open offers and their acceptance (§6.1), at
 * Agent NDA 0.2.0-draft. Each signature signs its own record, `digest`
 * included; records.ts says when one verifies and how its key is bound to
 * its seat.
 */
import { effectiveAt, withdrawalAt } from "./acts.js";
import { agreementDigest, offerDigest, signatureBytes } from "./bytes.js";
import { encodeSig, utf8, type Signer } from "./crypto.js";
import type { ActReceipts, HandleResolver } from "./ports.js";
import { bindingOf, verifySignatureRecord, type BindingContext } from "./records.js";
import type { Agreement, Declaration, Seat, SignatureRecord, SignedAct } from "./types.js";

// ── signing ──────────────────────────────────────────────────────

export interface SignOptions {
  role: SignatureRecord["role"];
  signedAt: string;
  /** REQUIRED when the seat names an organization (§6.2). */
  mandate?: string;
  /** REQUIRED for a `member` signature: the seat it signs for. */
  agent?: string;
}

/**
 * Sign an agreement as one seat and return the document with the record
 * added. The discloser's record on an open offer covers the offer bytes and
 * says so with `"over": "offer"` from the start, so the record never changes
 * at acceptance.
 */
export function signAgreement(doc: Agreement, signer: Signer, opts: SignOptions): Agreement {
  const overOffer = opts.role === "discloser" && !!doc.offer;
  const rec: Omit<SignatureRecord, "sig"> = {
    role: opts.role,
    key: signer.getPublicKey(),
    signed_at: opts.signedAt,
    digest: overOffer ? offerDigest(doc) : agreementDigest(doc),
  };
  if (overOffer) rec.over = "offer";
  if (opts.agent !== undefined) rec.agent = opts.agent;
  if (opts.mandate !== undefined) rec.mandate = opts.mandate;
  const sig = encodeSig(signer.sign(utf8(signatureBytes(rec))));
  return { ...doc, signatures: [...doc.signatures, { ...rec, sig } as SignatureRecord] };
}

/** Re-sign one record with a changed member, for fixtures that need a record
 *  whose signature is genuine but whose content is wrong. */
export function resignRecord(rec: SignatureRecord, signer: Signer, change: Partial<SignatureRecord> & Record<string, unknown>): SignatureRecord {
  const { sig: _sig, ...rest } = { ...rec, ...change } as SignatureRecord;
  return { ...rest, sig: encodeSig(signer.sign(utf8(signatureBytes(rest)))) } as SignatureRecord;
}

export interface AcceptOptions {
  seat: Seat;
  declaration?: Declaration;
  signedAt: string;
  mandate?: string;
}

/**
 * §6.1: write the completed document from an open offer. The recipient seat
 * and the recipient's declaration are filled, nothing else changes, the
 * discloser's record is kept as it is, and the recipient signs a record over
 * the completed document's digest.
 */
export function acceptOffer(offer: Agreement, signer: Signer, opts: AcceptOptions): Agreement {
  if (offer.parties.recipient !== null || !offer.offer) throw new Error("only an open offer can be accepted (6.1)");
  const completed: Agreement = { ...offer, parties: { ...offer.parties, recipient: opts.seat } };
  if (offer.disclosure) {
    if (!opts.declaration) throw new Error("the offer has a disclosure clause, so the recipient declares its processors and jurisdictions (5.5)");
    completed.disclosure = { ...offer.disclosure, recipient: opts.declaration };
  }
  return signAgreement(completed, signer, { role: "recipient", signedAt: opts.signedAt, mandate: opts.mandate });
}

// ── accepting ────────────────────────────────────────────────────

/**
 * `signedAtOnly` is true when a receipt the rules ask for was not supplied:
 * the instant the acceptance was received, or that of a withdrawal it was
 * checked against. The instants were then read from `signed_at` and `at`
 * alone, which only the signer wrote, and a renderer says so (§6).
 */
export type AcceptanceResult =
  | { ok: true; owner: "confirmed" | "unconfirmed"; signedAtOnly: boolean }
  | { ok: false; step: 1 | 2 | 3 | 4 | 5; reason: string; signedAtOnly: boolean };

export interface AcceptanceContext extends BindingContext {
  acts?: SignedAct[];
  /** When this verifier received each act, where it did. */
  actReceipts?: ActReceipts;
  resolveHandle?: HandleResolver;
}

/**
 * §6.1: the five checks on an acceptance. An acceptance that fails any of
 * them is not an agreement. The step that failed is named.
 */
export function verifyAcceptance(doc: Agreement, ctx: AcceptanceContext = {}): AcceptanceResult {
  const signedAtOnly =
    ctx.receivedAt === undefined || (ctx.acts ?? []).some((w) => w.act.action === "withdraw" && ctx.actReceipts?.(w) === undefined);
  const r = acceptanceSteps(doc, ctx);
  return { ...r, signedAtOnly } as AcceptanceResult;
}

type StepResult = { ok: true; owner: "confirmed" | "unconfirmed" } | { ok: false; step: 1 | 2 | 3 | 4 | 5; reason: string };

function acceptanceSteps(doc: Agreement, ctx: AcceptanceContext): StepResult {
  if (!doc.offer || !doc.parties.recipient || !doc.parties.discloser) return { ok: false, step: 1, reason: "not an acceptance: no offer member, or a seat is missing" };
  const discloser = doc.signatures.find((s) => s.role === "discloser");
  const recipient = doc.signatures.find((s) => s.role === "recipient");
  // 1. The discloser's record covers the re-derived offer digest, verifies,
  //    and is bound to the discloser seat.
  if (!discloser || discloser.over !== "offer" || !verifySignatureRecord(doc, discloser)) {
    return { ok: false, step: 1, reason: "the discloser's record does not cover the offer, or does not verify; the document differs from the offer beyond the recipient members" };
  }
  if (bindingOf(doc.parties.discloser, discloser.key, discloser.mandate, doc.covers.categories, discloser.signed_at, ctx) === "unbound") {
    return { ok: false, step: 1, reason: "the discloser's key is not bound to the discloser seat" };
  }
  // 2. The recipient's record covers the completed document, verifies, and
  //    is bound to the recipient seat.
  if (!recipient || recipient.over !== undefined || !verifySignatureRecord(doc, recipient)) {
    return { ok: false, step: 2, reason: "the recipient's record does not cover the completed document, or does not verify" };
  }
  const recipientBinding = bindingOf(doc.parties.recipient, recipient.key, recipient.mandate, doc.covers.categories, recipient.signed_at, ctx);
  if (recipientBinding === "unbound") return { ok: false, step: 2, reason: "the recipient's key is not bound to the recipient seat" };
  // 3. Before the offer expired, and before any withdrawal took effect, at
  //    signed_at and at the instant of receipt.
  const signed = Date.parse(recipient.signed_at);
  const expires = Date.parse(doc.offer.expires_at);
  if (!(signed < expires)) return { ok: false, step: 3, reason: "the recipient signed at or after the offer's expires_at" };
  const received = ctx.receivedAt === undefined ? null : Date.parse(ctx.receivedAt);
  if (received !== null && !(received < expires)) return { ok: false, step: 3, reason: "the acceptance was received at or after the offer's expires_at" };
  for (const w of ctx.acts ?? []) {
    if (!withdrawalAt(doc, w, ctx)) continue;
    const effective = Date.parse(effectiveAt(w, ctx.actReceipts));
    if (effective <= signed) return { ok: false, step: 3, reason: `the offer's withdrawal took effect at ${new Date(effective).toISOString()}, before the recipient signed` };
    if (received !== null && effective <= received) return { ok: false, step: 3, reason: "the offer's withdrawal took effect before the acceptance was received" };
  }
  // 4. An offer open to named handles only.
  const openTo = doc.offer.open_to;
  if (openTo !== "any") {
    const handle = doc.parties.recipient.handle;
    if (!handle || !openTo.includes(handle)) return { ok: false, step: 4, reason: "the recipient's handle is not one the offer is open to" };
    if (!ctx.resolveHandle) return { ok: false, step: 4, reason: "the offer names handles and no resolver was supplied" };
    if (ctx.resolveHandle(handle) !== doc.parties.recipient.agent) return { ok: false, step: 4, reason: "the recipient's handle does not resolve to its agent key" };
  }
  // 5. The discloser's jurisdiction requirement.
  const require = doc.disclosure?.require?.processed_in;
  if (require !== undefined) {
    const declared = doc.disclosure?.recipient?.processed_in;
    if (!Array.isArray(declared) || !declared.every((j) => typeof j === "string" && j && require.includes(j))) {
      return { ok: false, step: 5, reason: "the recipient's processed_in is unstated or outside the offer's require.processed_in" };
    }
  }
  return { ok: true, owner: recipientBinding === "bound" || doc.parties.recipient.organization !== undefined ? "confirmed" : "unconfirmed" };
}
