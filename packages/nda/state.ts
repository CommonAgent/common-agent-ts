/**
 * The lifecycle of §7.1, derived, never stored: a reader MUST derive the
 * state from the signatures, the acts and the instants, and a renderer MUST
 * NOT show an agreement as in force while any seat is unsigned.
 *
 *   draft          unsigned
 *   offered        some but not all seats signed, or an open offer before
 *                  expires_at
 *   countersigned  every seat signed, before effective_at
 *   in force       countersigned and effective_at reached
 *   amended        replaced by a higher version every seat signed
 *   expired        ends_at passed
 *   terminated     ended by a termination act
 *   withdrawn      an offer retracted by the party that signed it
 *   lapsed         an open offer whose expires_at passed
 *
 * Alongside the state the derivation returns the instants other questions
 * need: when the agreement took effect, when it stopped covering new
 * disclosures, and when its duties end, which is the survival period after
 * that (§5.2) and what a bureau's claim window counts from (Agent
 * Reputations §4.8).
 */
import { checkAct, effectiveAt, terminationEffectiveAt } from "./acts.js";
import type { ActReceipts, HandleResolver, MandateLookup, OwnerResolver } from "./ports.js";
import { counts, seatSignatures, type BindingContext } from "./records.js";
import { verifyAcceptance } from "./signatures.js";
import type { Agreement, Seat, SignedAct } from "./types.js";
import { validateAgreement } from "./validate.js";

export type AgreementState =
  | "draft"
  | "offered"
  | "countersigned"
  | "in force"
  | "amended"
  | "expired"
  | "terminated"
  | "withdrawn"
  | "lapsed";

export interface StateContext {
  /** The reading instant. */
  now: string;
  /** Terminations and withdrawals the caller holds. Only acts that check
   *  against this agreement count. */
  acts?: SignedAct[];
  /** Later versions of the same agreement the caller holds (§7.2). */
  laterVersions?: Agreement[];
  mandates?: MandateLookup;
  /** The registry's owners as the receiving verifier resolved them (§6). */
  owners?: OwnerResolver;
  /** When the receiving verifier received each act (§7.3). */
  actReceipts?: ActReceipts;
  /** When the receiving verifier received this document: the acceptance, or
   *  the signature that countersigned it (§6, §6.1). It bounds the
   *  acceptance's expiry and withdrawal checks and the mandate checks. */
  receivedAt?: string;
  resolveHandle?: HandleResolver;
}

export interface StateReading {
  state: AgreementState;
  /** When the duties began: effective_at, or the last required signature. */
  effectiveAt?: string;
  /** When it stopped covering new disclosures: ends_at, or a termination
   *  that took effect earlier. */
  endedAt?: string;
  /** When the duties for material disclosed while in force end. */
  dutiesEndAt?: string;
  /** A termination signed but not yet in effect, with its effective instant. */
  terminationPending?: string;
  /** Multilateral only: members whose own termination has taken effect. */
  departed?: string[];
  /** True when a receipt record the reading needed was absent, the
   *  document's or an act's, so its instants came from `signed_at` and `at`
   *  alone (§6). */
  signedAtOnly: boolean;
  why?: string;
}

const t = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export function deriveState(doc: Agreement, ctx: StateContext): StateReading {
  const reading = readState(doc, ctx);
  const acts = (ctx.acts ?? []).filter((a) => checkAct(doc, a, { mandates: ctx.mandates, owners: ctx.owners, actReceipts: ctx.actReceipts }).ok);
  const signedAtOnly = (doc.signatures.length > 0 && ctx.receivedAt === undefined) || acts.some((a) => ctx.actReceipts?.(a) === undefined);
  return { ...reading, signedAtOnly };
}

function readState(doc: Agreement, ctx: StateContext): Omit<StateReading, "signedAtOnly"> {
  const now = t(ctx.now);
  const bctx = { mandates: ctx.mandates, owners: ctx.owners, actReceipts: ctx.actReceipts, receivedAt: ctx.receivedAt };
  const acts = (ctx.acts ?? []).filter((a) => checkAct(doc, a, bctx).ok);
  // An act takes effect at the later of its `at` and its receipt (§7.3).
  const when = (a: SignedAct) => t(effectiveAt(a, ctx.actReceipts));
  const withdrawals = acts.filter((a) => a.act.action === "withdraw").sort((a, b) => when(a) - when(b));
  const terminations = acts.filter((a) => a.act.action === "terminate");

  // An open offer, or an acceptance whose recipient signature does not hold.
  if (doc.offer) {
    const offerState = (): Omit<StateReading, "signedAtOnly"> => {
      const w = withdrawals.find((a) => when(a) <= now);
      if (w) return { state: "withdrawn", why: `withdrawn at ${effectiveAt(w, ctx.actReceipts)}` };
      if (now >= t(doc.offer!.expires_at)) return { state: "lapsed" };
      return { state: "offered" };
    };
    const discloserSigned = seatSignatures(doc, bctx).find((s) => s.role === "discloser");
    if (!doc.signatures.length) return { state: "draft" };
    if (doc.parties.recipient === null) return discloserSigned && counts(discloserSigned) ? offerState() : { state: "draft", why: "the offer's signature does not hold" };
    const hasRecipientSig = doc.signatures.some((s) => s.role === "recipient");
    if (!hasRecipientSig) return offerState();
    const acceptance = verifyAcceptance(doc, { ...bctx, acts, resolveHandle: ctx.resolveHandle });
    if (!acceptance.ok) {
      // §6.1 step 3: an acceptance after expiry or withdrawal is no agreement,
      // and what stands is the offer, read at this instant.
      if (acceptance.step === 3) {
        const o = offerState();
        return { ...o, state: o.state === "offered" ? "lapsed" : o.state, why: acceptance.reason };
      }
      // Any other failure is no acceptance either, and what stands is still
      // the offer, which may itself have lapsed or been withdrawn.
      return { ...offerState(), why: acceptance.reason };
    }
  }

  const sigs = seatSignatures(doc, bctx);
  const valid = sigs.filter(counts);
  if (!valid.length) return { state: "draft" };
  if (valid.length < sigs.length) {
    const w = withdrawals.find((a) => when(a) <= now);
    if (w) return { state: "withdrawn", why: `withdrawn at ${effectiveAt(w, ctx.actReceipts)}` };
    return { state: "offered", why: "a renderer MUST NOT show an agreement as in force while any seat is unsigned" };
  }

  // Every seat signed. A party that signed first may have withdrawn its offer
  // before the others signed (§7.3), and then the later signature completed
  // nothing. The withdrawal counts only when it comes from a seat that had
  // already signed, never from the seat that signed last, and when both the
  // act's instant and its own signed_at fall at or after that seat's
  // signature and strictly before the last one. Otherwise any party could
  // void a countersigned agreement, and escape its notice and survival, by
  // dating a withdrawal early. The act's instant is when it took effect for
  // this verifier: the later of its `at` and its receipt (§7.3).
  //
  // The signer writes `signed_at` and `at`. Its signature now covers both
  // (§6, §7.3), so nobody else can move them, and a verifier that received
  // the act bounds it by the receipt; a reader holding neither the receipt
  // nor the receiving verifier's record still has only the signer's word.
  const lastSigned = Math.max(...valid.map((s) => t(s.record!.signed_at)));
  const early = withdrawals.find((a) => {
    const c = checkAct(doc, a, bctx);
    if (!c.ok) return false;
    const record = sigs.find((x) => x.seat === c.seat)?.record;
    if (!record) return false;
    const own = t(record.signed_at);
    const at = when(a);
    const signedAt = t(a.signature.signed_at);
    return own < lastSigned && own <= at && at < lastSigned && own <= signedAt && signedAt < lastSigned;
  });
  if (early) return { state: "withdrawn", why: `withdrawn at ${early.act.at}, before the last signature` };

  // Countersigned. When does it take effect?
  const effective = doc.effective_at ? t(doc.effective_at) : lastSigned;
  const reading: Omit<StateReading, "signedAtOnly"> = { state: "in force", effectiveAt: iso(effective) };

  // Replaced by a later version every seat signed (§7.2): a valid document
  // with the same identifier and a higher version. In a one-way or mutual
  // agreement the parties stay the same, so the later version has the same
  // two seats, signed by the same owner keys.
  const later = (ctx.laterVersions ?? []).find((v) => isReplacement(doc, v, { mandates: ctx.mandates, owners: ctx.owners }));

  // Terminations: for a multilateral agreement a member's ends its own
  // participation, and the agreement ends when fewer than two remain.
  let endedBy: number | null = null;
  let pending: number | null = null;
  const departed: string[] = [];
  if (doc.direction === "multilateral") {
    const members = doc.parties.members ?? [];
    const leaves = new Map<string, number>();
    for (const a of terminations) {
      const by = checkAct(doc, a, bctx);
      if (!by.ok || a.act.by !== "member") continue;
      const at = t(terminationEffectiveAt(doc, a, ctx.actReceipts));
      const prev = leaves.get(by.seat.agent);
      if (prev === undefined || at < prev) leaves.set(by.seat.agent, at);
    }
    const effectiveLeaves = [...leaves.entries()].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]);
    for (const [agent] of effectiveLeaves) departed.push(agent);
    // It ends at the leave that brings it under two members: of n members,
    // the (n-1)th to leave.
    endedBy = effectiveLeaves[members.length - 2]?.[1] ?? null;
    const future = [...leaves.values()].filter((at) => at > now);
    if (future.length) pending = Math.min(...future);
  } else {
    const effectiveTimes = terminations.map((a) => t(terminationEffectiveAt(doc, a, ctx.actReceipts)));
    const done = effectiveTimes.filter((at) => at <= now);
    if (done.length) endedBy = Math.min(...done);
    const future = effectiveTimes.filter((at) => at > now);
    if (future.length) pending = Math.min(...future);
  }
  if (departed.length) reading.departed = departed;

  const endsAt = t(doc.ends_at);
  const end = endedBy !== null && endedBy < endsAt ? endedBy : endsAt;
  reading.endedAt = iso(end);
  reading.dutiesEndAt = iso(end + (doc.survival?.days ?? 0) * 86_400_000);
  if (pending !== null && pending < endsAt) reading.terminationPending = iso(pending);

  if (later) return { ...reading, state: "amended", why: `replaced by version ${later.version}` };
  if (endedBy !== null && endedBy < endsAt && now >= endedBy) return { ...reading, state: "terminated" };
  if (now >= endsAt) return { ...reading, state: "expired" };
  if (now < effective) return { ...reading, state: "countersigned" };
  return reading;
}

/** Whether a seat carries over to a later version: the same agent and, for a
 *  seat that names no organization, the same owner_key; for one that names an
 *  organization, the same organization. Who signed for it is the binding
 *  check's question, so a new mandate holder for the organization still
 *  signs the same seat (§5.1, §6.2). */
function sameSeat(a: Seat | null | undefined, b: Seat | null | undefined): boolean {
  if (!a || !b || a.agent !== b.agent) return false;
  if (a.organization === undefined) return b.organization === undefined && a.owner_key === b.owner_key;
  return b.organization === a.organization;
}

function isReplacement(doc: Agreement, v: Agreement, ctx: BindingContext): boolean {
  if (v.id !== doc.id || !(v.version > doc.version) || !validateAgreement(v).ok) return false;
  const vs = seatSignatures(v, ctx);
  if (!vs.length || !vs.every(counts)) return false;
  if (doc.direction === "multilateral") {
    // Members may join or leave by a replacement (§5.1, §7.2), but it is the
    // same agreement only if at least two of its members carry over: the
    // same seat, whose signature on the original counted. A version signed
    // only by strangers replaces nothing.
    if (v.direction !== "multilateral") return false;
    const before = seatSignatures(doc, ctx).filter(counts);
    const kept = vs.filter((s) => before.some((o) => sameSeat(o.seat, s.seat))).length;
    return kept >= 2;
  }
  if (v.direction === "multilateral") return false;
  return sameSeat(v.parties.discloser, doc.parties.discloser) && sameSeat(v.parties.recipient, doc.parties.recipient);
}

/** Whether the agreement covers material disclosed at `at`: it was in force
 *  then, from taking effect until it ended (§5.2, §7.1). */
export function coversDisclosureAt(reading: StateReading, at: string): boolean {
  if (!reading.effectiveAt || !reading.endedAt) return false;
  const x = t(at);
  return x >= t(reading.effectiveAt) && x < t(reading.endedAt);
}
