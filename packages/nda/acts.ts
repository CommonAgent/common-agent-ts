/**
 * Terminations and withdrawals (§7.3), at Agent NDA 0.2.0-draft.
 *
 * An act is `{ act, signature }`: the body names the agreement by id,
 * version and digest, the action, the instant, and the acting seat in `by`
 * (with `agent` for a member); the signature record carries the key,
 * `signed_at` and, for an organization's seat, `mandate`. The signed bytes
 * are `agent-nda-act-v1`, one newline, and the canonical JSON of the whole
 * act with `signature.sig` removed. Both member sets are closed.
 *
 * `at` and `signed_at` are written by the signer. An act takes effect no
 * earlier than its `at`, never before its `signed_at`, and, for a verifier
 * that received it, no earlier than the instant it received it.
 */
import { actBytes, agreementDigest, offerDigest } from "./bytes.js";
import { encodeSig, utf8, verifyBytes, type Signer } from "./crypto.js";
import type { ActReceipts } from "./ports.js";
import { bindingOf, seatOf, type BindingContext } from "./records.js";
import type { ActBody, Agreement, Seat, SignedAct } from "./types.js";

export const ACT_MEMBERS = ["nda", "version", "digest", "action", "at", "reason", "by", "agent"] as const;
export const ACT_SIGNATURE_MEMBERS = ["key", "signed_at", "sig", "mandate"] as const;

export function signAct(act: ActBody, signer: Signer, signedAt: string, mandate?: string): SignedAct {
  const signature: Omit<SignedAct["signature"], "sig"> = { key: signer.getPublicKey(), signed_at: signedAt };
  if (mandate !== undefined) signature.mandate = mandate;
  const sig = encodeSig(signer.sign(utf8(actBytes({ act, signature }))));
  return { act, signature: { ...signature, sig } };
}

/** The instant an act takes effect for this verifier: its `at`, or the
 *  instant the verifier received it where that is later. */
export function effectiveAt(signed: SignedAct, receipts?: ActReceipts): string {
  const received = receipts?.(signed);
  if (received && Date.parse(received) > Date.parse(signed.act.at)) return received;
  return signed.act.at;
}

export type ActCheck =
  | { ok: true; seat: Seat }
  | { ok: false; reason: string };

export interface ActContext extends BindingContext {
  actReceipts?: ActReceipts;
}

/**
 * Whether an act is a valid act on this agreement: its member sets are the
 * closed ones, its signature verifies over the act and its record, it names
 * this agreement (or this offer) by id, version and digest, `at` is not
 * before `signed_at`, `by` names a seat of the agreement, the key is bound to
 * that seat (§6), and only the discloser withdraws an open offer.
 */
export function checkAct(doc: Agreement, signed: SignedAct, ctx: ActContext = {}): ActCheck {
  const { act, signature } = signed;
  if (Object.keys(signed).some((k) => k !== "act" && k !== "signature")) return { ok: false, reason: "an act has two members, act and signature (7.3)" };
  if (Object.keys(act).some((k) => !(ACT_MEMBERS as readonly string[]).includes(k))) return { ok: false, reason: "the act body carries a member 7.3 does not define" };
  if (Object.keys(signature).some((k) => !(ACT_SIGNATURE_MEMBERS as readonly string[]).includes(k))) return { ok: false, reason: "the act's signature carries a member 7.3 does not define" };
  if (!verifyBytes(signature.key, utf8(actBytes(signed)), signature.sig)) return { ok: false, reason: "the act's signature does not verify" };
  if (act.nda !== doc.id || act.version !== doc.version) return { ok: false, reason: "the act names another agreement or version" };
  if (act.action !== "terminate" && act.action !== "withdraw") return { ok: false, reason: "action is terminate or withdraw (7.3)" };
  if (Number.isNaN(Date.parse(act.at)) || Number.isNaN(Date.parse(signature.signed_at))) return { ok: false, reason: "at and signed_at are instants" };
  if (Date.parse(act.at) < Date.parse(signature.signed_at)) return { ok: false, reason: "at is before signed_at: an act cannot take effect before it was signed (7.3)" };
  const expected = act.action === "withdraw" && doc.offer ? offerDigest(doc) : agreementDigest(doc);
  if (act.digest !== expected) {
    return { ok: false, reason: act.action === "withdraw" && doc.offer ? "a withdrawal names the offer digest" : "the act names a different agreement's digest" };
  }
  if (act.by === "member" && typeof act.agent !== "string") return { ok: false, reason: "a member's act names its seat in agent (7.3)" };
  const seat = seatOf(doc, { role: act.by, agent: act.agent });
  if (!seat) return { ok: false, reason: "by names no seat of the agreement" };
  if (act.action === "withdraw") {
    const signedTheOffer = doc.offer
      ? act.by === "discloser"
      : doc.signatures.some((s) => s.role === act.by && (act.by !== "member" || s.agent === act.agent));
    if (!signedTheOffer) return { ok: false, reason: "only the seat that signed the offer withdraws it (7.3)" };
  }
  if (seat.organization !== undefined && !signature.mandate) return { ok: false, reason: "an act for a seat that names an organization carries its mandate (6.2, 7.3)" };
  const receivedAt = ctx.actReceipts?.(signed);
  if (bindingOf(seat, signature.key, signature.mandate, doc.covers.categories, signature.signed_at, { ...ctx, receivedAt }) === "unbound") {
    return { ok: false, reason: "the key that signed is not bound to the seat named in by (6)" };
  }
  return { ok: true, seat };
}

/** The instant a valid withdrawal of this agreement's offer takes effect,
 *  or null when the act is not one. */
export function withdrawalAt(doc: Agreement, signed: SignedAct, ctx: ActContext = {}): string | null {
  if (signed.act.action !== "withdraw") return null;
  return checkAct(doc, signed, ctx).ok ? effectiveAt(signed, ctx.actReceipts) : null;
}

/**
 * When a termination takes effect: `termination.notice_days` after the act
 * takes effect for this verifier (§7.3), or at once when the agreement
 * states no notice.
 */
export function terminationEffectiveAt(doc: Agreement, signed: SignedAct, receipts?: ActReceipts): string {
  const days = doc.termination?.notice_days ?? 0;
  return new Date(Date.parse(effectiveAt(signed, receipts)) + days * 86_400_000).toISOString().replace(".000Z", "Z");
}
