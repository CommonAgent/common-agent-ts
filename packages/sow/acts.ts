/**
 * The signed acts on an agreed engagement (§6.3, 0.30.0-draft): a
 * termination (§5.9), a usage report (§5.5.2), the opening of a dispute
 * (§5.10), and the resolution of one. Each is a JSON object with a closed set
 * of members, signed by its seat's owner_key over its kind's tag, one
 * newline, and the JCS of the act less `sig`. Every tag differs from the
 * document's `agent-sow-v1` and from `agent-sow-formation-v1`, so a
 * signature over one kind can never be read as one over another.
 *
 * These are pure checks of an act against the agreed version it names and
 * what the runtime already holds (earlier usage, the dispute a resolution
 * closes, an arbiter's verdict). The platform holds the acts and calls them.
 */
import { canonicalJSON, fromB64Url, PUBLIC_KEY_RE, sha256Digest, signTagged, verifyTagged, type Signer } from "./crypto.js";
import { encodeSowSig, isCanonicalSowSig, seatOwnerKey, sowSignedBytes } from "./signing.js";
import { arbiterVerdictSignedBytes, verifyArbiterVerdictSignature, type SowArbiterVerdict } from "./disputes.js";
import { invalid, isRecord, refused, RFC3339 } from "./shared.js";
import type { SowDocument } from "./document.js";

type Role = "provider" | "client";

export type SowActKind = "terminate" | "usage" | "dispute" | "resolve";

/** Each kind's tag (§6.3). */
export const SOW_ACT_TAGS: Readonly<Record<SowActKind, string>> = {
  terminate: "agent-sow-terminate-v1",
  usage: "agent-sow-usage-v1",
  dispute: "agent-sow-dispute-v1",
  resolve: "agent-sow-resolve-v1",
};

/** What every act carries (§6.3). */
interface SowActBase {
  engagement: string;
  /** The agreed version the act is made under. */
  version: number;
  /** `sha256:` and the hex SHA-256 of that version's signed bytes (§6). */
  digest: string;
  by: Role;
  /** The signing seat's owner_key (§5.1). */
  key: string;
  signed_at: string;
  sig: string;
}

export interface SowTerminateAct extends SowActBase {
  basis: "convenience" | "cause";
  reason?: string;
  effective_at: string;
}

export interface SowUsageAct extends SowActBase {
  window: { from: string; to: string };
  readings: Array<{ meter: string; count: number }>;
}

export interface SowDisputeAct extends SowActBase {
  posture: "refund_on_failed_task" | "escalate_to_owners" | "arbiter";
  amount: number;
  cites: Array<{ kind: "acceptance" | "settlement"; digest: string }>;
  evidence: string[];
  reason: string;
}

export interface SowResolveAct extends SowActBase {
  dispute: string;
  outcome: "refunded" | "settled" | "verdict" | "released";
  split: { to_provider: number; to_client: number };
  verdict?: string;
}

export type SowAct = SowTerminateAct | SowUsageAct | SowDisputeAct | SowResolveAct;

const COMMON = ["engagement", "version", "digest", "by", "key", "signed_at", "sig"];

/** The members each kind carries; any other is refused (§6.3). */
export const SOW_ACT_MEMBERS: Readonly<Record<SowActKind, ReadonlySet<string>>> = {
  terminate: new Set([...COMMON, "basis", "reason", "effective_at"]),
  usage: new Set([...COMMON, "window", "readings"]),
  dispute: new Set([...COMMON, "posture", "amount", "cites", "evidence", "reason"]),
  resolve: new Set([...COMMON, "dispute", "outcome", "split", "verdict"]),
};

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function body(act: object): string {
  const { sig: _s, ...rest } = act as { sig?: unknown };
  return canonicalJSON(rest);
}

/** An act's signed bytes: its kind's tag, one newline, and the JCS of the act less `sig` (§6.3). */
export function actSignedBytes(kind: SowActKind, act: object): string {
  return `${SOW_ACT_TAGS[kind]}\n${body(act)}`;
}

/** `sha256:` and the hex SHA-256 of an act's signed bytes: the name of a dispute from its opening on (§6.3). */
export function actDigest(kind: SowActKind, act: object): string {
  return sha256Digest(actSignedBytes(kind, act));
}

/** The digest an act names for the version it is made under: of that version's signed bytes (§6). */
export function versionDigest(doc: SowDocument): string {
  return sha256Digest(sowSignedBytes(doc));
}

/** Sign an act as `role`'s seat: `by` is the seat, `key` the signer's public key, and `sig` covers the rest. */
export function signAct<T extends SowAct>(
  kind: SowActKind,
  act: Omit<T, "by" | "key" | "signed_at" | "sig">,
  signer: Signer,
  role: Role,
  signedAt?: string,
): T {
  const unsigned = { ...act, by: role, key: signer.getPublicKey(), signed_at: signedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  return { ...unsigned, sig: encodeSowSig(signTagged(signer, `${SOW_ACT_TAGS[kind]}\n`, body(unsigned))) } as T;
}

const isWhole = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;
const textOf = (v: unknown) => typeof v === "string" && [...v].length >= 1 && [...v].length <= 1000;
const ms = (iso: string) => Date.parse(iso);

/** The shape of an act of `kind` (§6.3): only its members, each well formed. Throws an invalid SowRefusal naming the rule. */
export function validateAct(kind: SowActKind, act: unknown): asserts act is SowAct {
  if (!isRecord(act)) invalid("an act is a JSON object (§6.3)");
  const members = SOW_ACT_MEMBERS[kind];
  for (const m of Object.keys(act)) if (!members.has(m)) invalid(`a ${kind} act carries only the members §6.3 defines, and ${m} is not one (§6.3)`);
  const a = act as Record<string, unknown>;
  if (typeof a.engagement !== "string" || !a.engagement) invalid("engagement names the engagement (§6.3)");
  if (!isWhole(a.version, 1)) invalid("version is the agreed version the act is made under (§6.3)");
  if (typeof a.digest !== "string" || !DIGEST_RE.test(a.digest)) invalid("digest is sha256: and 64 lowercase hex digits (§6.3)");
  if (a.by !== "provider" && a.by !== "client") invalid("by is the signing seat, provider or client (§6.3)");
  if (typeof a.key !== "string" || !PUBLIC_KEY_RE.test(a.key)) invalid("key is the signing seat's owner_key (§6.3, §5.1)");
  if (typeof a.signed_at !== "string" || !RFC3339.test(a.signed_at)) invalid("signed_at is an RFC 3339 instant (§6.3)");
  if (typeof a.sig !== "string" || !isCanonicalSowSig(a.sig)) invalid("sig is the canonical padded base64 of the 64-byte signature (§6.3, §6)");
  if (kind === "terminate") {
    if (a.basis !== "convenience" && a.basis !== "cause") invalid("basis is convenience or cause (§6.3, §5.9)");
    if (a.reason !== undefined && !textOf(a.reason)) invalid("a reason is a string of 1 to 1,000 code points (§6.3)");
    if (a.basis === "cause" && a.reason === undefined) invalid("a termination for cause carries its reason (§6.3, §5.9)");
    if (typeof a.effective_at !== "string" || !RFC3339.test(a.effective_at)) invalid("effective_at is an RFC 3339 instant (§6.3)");
  } else if (kind === "usage") {
    const w = a.window;
    if (!isRecord(w) || typeof w.from !== "string" || !RFC3339.test(w.from) || typeof w.to !== "string" || !RFC3339.test(w.to)) {
      invalid("window has from and to, each an RFC 3339 instant (§6.3)");
    }
    if (!(ms(w.from as string) < ms(w.to as string))) invalid("a usage window's from is before its to (§6.3)");
    if (!Array.isArray(a.readings) || a.readings.length === 0) invalid("readings lists one or more entries (§6.3)");
    const seen = new Set<string>();
    for (const r of a.readings as unknown[]) {
      if (!isRecord(r) || typeof r.meter !== "string" || !r.meter) invalid("a reading names its meter (§6.3)");
      for (const k of Object.keys(r)) if (k !== "meter" && k !== "count") invalid(`a reading carries meter and count, and ${k} is neither (§6.3)`);
      if (!isWhole(r.count, 0)) invalid("a reading's count is a whole number from 0 (§6.3)");
      if (seen.has(r.meter as string)) invalid(`no meter appears twice in a usage act, and ${r.meter} does (§6.3)`);
      seen.add(r.meter as string);
    }
  } else if (kind === "dispute") {
    if (a.posture !== "refund_on_failed_task" && a.posture !== "escalate_to_owners" && a.posture !== "arbiter") {
      invalid("a dispute's posture is refund_on_failed_task, escalate_to_owners or arbiter; under none no dispute opens (§6.3, §5.10)");
    }
    if (!isWhole(a.amount, 1)) invalid("the disputed amount is a whole number above 0 (§6.3)");
    if (!Array.isArray(a.cites) || a.cites.length === 0) invalid("a dispute cites one or more records it contests (§6.3)");
    for (const c of a.cites as unknown[]) {
      if (!isRecord(c) || (c.kind !== "acceptance" && c.kind !== "settlement")) invalid("a cite is an acceptance or a settlement (§6.3)");
      if (typeof c.digest !== "string" || !DIGEST_RE.test(c.digest)) invalid("a cite names its record by digest (§6.3)");
      for (const k of Object.keys(c)) if (k !== "kind" && k !== "digest") invalid(`a cite carries kind and digest, and ${k} is neither (§6.3)`);
    }
    if (!Array.isArray(a.evidence) || !(a.evidence as unknown[]).every((e) => typeof e === "string" && DIGEST_RE.test(e))) {
      invalid("evidence lists the digests of the exhibits, and may be empty (§6.3)");
    }
    if (!textOf(a.reason)) invalid("a dispute carries its reason, a string of 1 to 1,000 code points (§6.3)");
  } else {
    if (typeof a.dispute !== "string" || !DIGEST_RE.test(a.dispute)) invalid("dispute is the digest of the dispute act's signed bytes (§6.3)");
    if (a.outcome !== "refunded" && a.outcome !== "settled" && a.outcome !== "verdict" && a.outcome !== "released") {
      invalid("outcome is refunded, settled, verdict or released (§6.3)");
    }
    const s = a.split;
    if (!isRecord(s) || !isWhole(s.to_provider, 0) || !isWhole(s.to_client, 0) || Object.keys(s).some((k) => k !== "to_provider" && k !== "to_client")) {
      invalid("split is to_provider and to_client, whole numbers from 0 (§6.3)");
    }
    if (a.outcome === "verdict" ? typeof a.verdict !== "string" || !DIGEST_RE.test(a.verdict) : a.verdict !== undefined) {
      invalid("verdict appears with the verdict outcome, as the digest of the verdict's signed bytes, and with no other (§6.3)");
    }
  }
}

/** What an act is checked against: the agreed versions, and what the runtime already holds for it. */
export interface SowActContext {
  /** The agreed version of this engagement with that number, or null where it was never agreed. */
  agreed(version: number): SowDocument | null;
  /** Usage acts this runtime already holds under the engagement (usage). */
  heldUsage?: readonly SowUsageAct[];
  /** What remains unsettled under the engagement when a dispute opens (dispute; §5.10.2). Unchecked where absent. */
  unsettled?: number;
  /** The dispute act a resolution closes (resolve). */
  dispute?: SowDisputeAct;
  /** The arbiter's verdict a `verdict` outcome rests on, and that keeps the arbiter in force past the deadline (resolve). */
  verdict?: SowArbiterVerdict;
  /**
   * This runtime's clock, as an RFC 3339 instant (resolve). Whether
   * deadline_days has run is judged on it, never on the act's own signed_at,
   * which its signer chose. Without it no fallback can be found to govern.
   */
  now?: string;
  /** When this runtime received the dispute act (resolve). deadline_days runs from the later of this and the act's signed_at (§6.3). */
  disputeReceivedAt?: string;
  /**
   * The arbiter both seats countersigned when the dispute opened, where the
   * version binds none at formation (§5.10.1). The runtime that holds it has
   * checked both countersignatures; a verdict is then checked against `agent`.
   */
  appointment?: { agent: string };
}

const DAY = 86_400_000;

/** The instant deadline_days runs from: the dispute's signed_at, or the later instant this runtime received it (§6.3). */
function opening(dispute: SowDisputeAct, ctx: SowActContext): number {
  const signed = ms(dispute.signed_at);
  const received = ctx.disputeReceivedAt === undefined ? Number.NaN : ms(ctx.disputeReceivedAt);
  return Number.isFinite(received) && received > signed ? received : signed;
}

type ArbiterClause = { agent?: string; deadline_days?: number; fallback?: string };
const arbiterClause = (doc: SowDocument): ArbiterClause | undefined =>
  (doc as { disputes?: { arbiter?: ArbiterClause } }).disputes?.arbiter;

/** The arbiter whose signature a verdict needs: the one bound at formation, or else the one appointed when the dispute opened (§5.10.1). */
function arbiterOf(doc: SowDocument, ctx: SowActContext): string | undefined {
  return arbiterClause(doc)?.agent ?? ctx.appointment?.agent;
}

/** Whether `v` is a verdict on this dispute, signed by its arbiter and produced before deadline_days ran (§5.10.1). */
function timelyVerdict(doc: SowDocument, dispute: SowDisputeAct, v: SowArbiterVerdict | undefined, ctx: SowActContext): boolean {
  if (!v) return false;
  const arbiter = arbiterOf(doc, ctx);
  if (!arbiter || !(v.signatures ?? []).some((s) => s.key === arbiter && verifyArbiterVerdictSignature(v, s))) return false;
  if (v.engagement !== dispute.engagement || v.dispute !== actDigest("dispute", dispute)) return false;
  return ms(v.produced_at) <= opening(dispute, ctx) + (arbiterClause(doc)?.deadline_days ?? 0) * DAY;
}

/**
 * The posture that governs a dispute now (§5.10.1): its own, except that
 * under arbiter, once deadline_days have run on this runtime's clock with no
 * timely verdict, the clause's fallback. A timely verdict keeps the arbiter
 * in force however late the act that rests on it comes.
 */
function governingPosture(doc: SowDocument, dispute: SowDisputeAct, ctx: SowActContext): string {
  if (dispute.posture !== "arbiter") return dispute.posture;
  if (timelyVerdict(doc, dispute, ctx.verdict, ctx)) return "arbiter";
  const deadline = opening(dispute, ctx) + (arbiterClause(doc)?.deadline_days ?? 0) * DAY;
  const now = ctx.now === undefined ? Number.NaN : ms(ctx.now);
  if (Number.isFinite(now) && now >= deadline) return arbiterClause(doc)?.fallback ?? "none";
  return "arbiter";
}

/**
 * Check an act of `kind` (§6.3): well formed, made under an agreed version
 * whose signed bytes it names, signed by the seat it says with that seat's
 * owner_key, and keeping its kind's rules against that version and what the
 * runtime holds. Throws a SowRefusal naming the rule that failed.
 */
export function checkAct(kind: SowActKind, act: unknown, ctx: SowActContext): asserts act is SowAct {
  validateAct(kind, act);
  const doc = ctx.agreed(act.version);
  if (!doc) refused(`version ${act.version} of the engagement was never agreed (§6.3)`);
  if (doc.id !== act.engagement) refused(`the act is about engagement ${act.engagement}, and this one is ${doc.id} (§6.3)`);
  if (act.digest !== versionDigest(doc)) refused(`the act's digest is not the digest of version ${act.version}'s signed bytes (§6.3)`);
  const seatKey = seatOwnerKey(doc, act.by);
  if (!seatKey || act.key !== seatKey) refused(`the act is signed with a key that is not the ${act.by} seat's owner_key (§6.3)`);
  let good = false;
  try {
    good = verifyTagged(act.key, `${SOW_ACT_TAGS[kind]}\n`, body(act), fromB64Url(act.sig));
  } catch {
    good = false;
  }
  if (!good) refused(`the signature does not verify over the act's signed bytes under ${SOW_ACT_TAGS[kind]} (§6.3)`);

  if (kind === "terminate") {
    const t = act as SowTerminateAct;
    if (t.basis === "cause") {
      if (ms(t.effective_at) !== ms(t.signed_at)) refused("a termination for cause takes effect at once: effective_at equals signed_at (§6.3, §5.9)");
    } else {
      const hours = (doc as { termination?: { convenience_notice_hours?: number } }).termination?.convenience_notice_hours ?? 0;
      if (ms(t.effective_at) < ms(t.signed_at) + hours * 3_600_000) {
        refused(`a termination for convenience takes effect no earlier than ${hours} hours after it is signed (§6.3, §5.9)`);
      }
    }
  } else if (kind === "usage") {
    const u = act as SowUsageAct;
    if (u.by !== "provider") refused("the provider's seat signs usage (§6.3)");
    const price = (doc as { price?: { arrangement?: string; schedule?: Array<{ meter?: string }> } }).price;
    if (price?.arrangement !== "time_and_materials") refused("usage is reported only under a time_and_materials price (§6.3, §5.5.2)");
    const priced = new Set((price.schedule ?? []).map((l) => l.meter));
    for (const r of u.readings) if (!priced.has(r.meter)) refused(`the schedule does not price ${r.meter} (§6.3, §5.5.2)`);
    for (const h of ctx.heldUsage ?? []) {
      if (h.engagement !== u.engagement) continue;
      if (ms(u.window.from) < ms(h.window.to) && ms(h.window.from) < ms(u.window.to)) {
        refused(`this usage window overlaps one already held, from ${h.window.from} to ${h.window.to}, so it would be billed twice (§6.3)`);
      }
    }
  } else if (kind === "dispute") {
    const d = act as SowDisputeAct;
    const posture = (doc as { disputes?: { posture?: string } }).disputes?.posture;
    if (posture === "none") refused("the engagement's posture is none, under which no dispute opens (§6.3, §5.10)");
    if (d.posture !== posture) refused(`the dispute names posture ${d.posture}, and the engagement's is ${posture} (§6.3)`);
    if (ctx.unsettled !== undefined && d.amount > ctx.unsettled) {
      refused(`the disputed amount ${d.amount} is more than the ${ctx.unsettled} that remains unsettled (§6.3, §5.10.2)`);
    }
  } else {
    const r = act as SowResolveAct;
    const dispute = ctx.dispute;
    if (!dispute) refused("a resolution closes a dispute this runtime holds (§6.3)");
    if (r.dispute !== actDigest("dispute", dispute)) refused("dispute is not the digest of the dispute act's signed bytes (§6.3)");
    if (r.split.to_provider + r.split.to_client !== dispute.amount) {
      refused(`the split sums to ${r.split.to_provider + r.split.to_client}, and the disputed amount is ${dispute.amount} (§6.3)`);
    }
    const governs = governingPosture(doc, dispute, ctx);
    const expected = ({ refund_on_failed_task: "refunded", escalate_to_owners: "settled", arbiter: "verdict", none: "released" } as Record<string, string>)[governs];
    if (r.outcome !== expected) refused(`${governs} governs this dispute, so the outcome is ${expected ?? "not one this act can name"} (§6.3, §5.10.1)`);
    if (r.outcome === "refunded") {
      if (r.by !== "provider") refused("the provider's seat signs a refund (§6.3)");
      if (r.split.to_client !== dispute.amount) refused("a refund returns the whole disputed amount to the client (§6.3)");
    } else if (r.outcome === "released") {
      if (r.split.to_provider !== dispute.amount) refused("a release pays the provider the whole disputed amount (§6.3, §5.10.2)");
    } else if (r.outcome === "verdict") {
      const v = ctx.verdict;
      if (!v) refused("a verdict outcome rests on the arbiter's verdict, which this runtime does not hold (§6.3)");
      if (r.verdict !== sha256Digest(arbiterVerdictSignedBytes(v))) refused("verdict is not the digest of the verdict's signed bytes (§6.3)");
      const arbiter = arbiterOf(doc, ctx);
      const signedByArbiter = !!arbiter && (v.signatures ?? []).some((s) => s.key === arbiter && verifyArbiterVerdictSignature(v, s));
      if (!signedByArbiter) refused("the verdict is not signed by the arbiter the engagement binds or the parties appointed (§6.3, §5.10.1)");
      if (v.engagement !== r.engagement) refused("the verdict is about another engagement (§6.3)");
      if (v.dispute !== r.dispute) refused("the verdict is about another dispute (§6.3)");
      if (v.disputed?.amount !== dispute.amount) refused("the verdict's disputed amount is not the dispute's (§6.3)");
      if (v.split?.provider !== r.split.to_provider || v.split?.client !== r.split.to_client) refused("the act's split is the verdict's (§6.3)");
      const deadline = opening(dispute, ctx) + (arbiterClause(doc)?.deadline_days ?? 0) * DAY;
      if (ms(v.produced_at) > deadline) refused("the verdict was produced after deadline_days had run, so it is void (§6.3, §5.10.1)");
    }
  }
}

/** Whether a dispute under escalate_to_owners closes on these resolve acts (§6.3): both seats have signed acts naming the same dispute, outcome and split. */
export function disputeSettled(acts: readonly SowResolveAct[], dispute: string): boolean {
  const named = acts.filter((a) => a.dispute === dispute && a.outcome === "settled");
  for (const p of named.filter((a) => a.by === "provider")) {
    for (const c of named.filter((a) => a.by === "client")) {
      if (p.split.to_provider === c.split.to_provider && p.split.to_client === c.split.to_client) return true;
    }
  }
  return false;
}

/** When a termination takes effect for the party that received it at `receivedAt` (§6.3, §5.9): the receiving party counts the notice from receipt where that is later, so a termination dated back gives no less notice. */
export function terminationTakesEffect(act: SowTerminateAct, doc: SowDocument, receivedAt: string): string {
  if (act.basis === "cause") return new Date(Math.max(ms(act.effective_at), ms(receivedAt))).toISOString().replace(/\.\d{3}Z$/, "Z");
  const hours = (doc as { termination?: { convenience_notice_hours?: number } }).termination?.convenience_notice_hours ?? 0;
  const fromReceipt = ms(receivedAt) + hours * 3_600_000;
  return new Date(Math.max(ms(act.effective_at), fromReceipt)).toISOString().replace(/\.\d{3}Z$/, "Z");
}
