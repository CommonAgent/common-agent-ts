/**
 * Disputes (§5.10): the posture, the arbiter binding (§5.10.1) and the
 * arbiter's signed verdict.
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { CURRENCY_RE, RFC3339, invalidIn, isNonNegInt, isPosInt } from "./shared.js";
import { fromB64Url, signTagged, toB64Url, verifyTagged, type Signer } from "./crypto.js";
import { canonicalSowJSON } from "./signing.js";

const invalid: (message: string) => never = invalidIn("5.10");

// ── §5.10: disputes ─────────────────────────────────────────────────────────

/**
 * The closed posture vocabulary (§5.10). Exactly one per clause:
 *
 *  - `none`: settlements are final; disagreement ends the engagement at most.
 *  - `refund_on_failed_task`: a task that fails, including failure by the
 *    deliverable-form rule of §5.4, is refunded in full through clearing. The
 *    machine's completion check decides; no quality argument is required.
 *  - `escalate_to_owners`: the owners read the signed record together and
 *    settle it as people.
 *  - `arbiter`: both parties bind, in this document, an independent agent
 *    holding the published arbiter role contract whose verdict on the
 *    disputed amount both commit in advance to accept (§5.10.1).
 */
export type SowDisputesPosture =
  | "none"
  | "refund_on_failed_task"
  | "escalate_to_owners"
  | "arbiter";

export const SOW_DISPUTES_POSTURES: readonly SowDisputesPosture[] = [
  "none",
  "refund_on_failed_task",
  "escalate_to_owners",
  "arbiter",
];

/** Who bears the arbiter's price (§5.10.1): `split` — the parties bear it
 *  equally — or `follows_finding` — each party bears it in proportion to the
 *  split found against them. The arbiter's price is its own business,
 *  declared like any offering's. */
export type SowArbiterFee = "split" | "follows_finding";

export const SOW_ARBITER_FEES: readonly SowArbiterFee[] = ["split", "follows_finding"];

/**
 * The standard role name for the published arbiter contract
 * (https://agentroles.ai/arbiter.html). The clause's `role` member is
 * validated as a non-empty string, NOT pinned to this constant: the role is
 * referenced abstractly because it is a published contract any conforming
 * agent can hold, and a deployment may publish its own role registry. This
 * constant is the name the standard registry publishes, offered so callers
 * spell it once.
 */
export const ROLE_ARBITER = "role-arbiter";

/**
 * What the parties choose about the arbiter forum (§5.10.1), bound in the
 * signed document.
 *
 * `agent` is OPTIONAL: bound at formation, both parties signed over the
 * specific judge; absent, the parties appoint one when a dispute opens, both
 * countersigning the appointment, and failing to appoint within
 * `deadline_days` the `fallback` governs. `independence_days` is the window
 * for the role's independence rule — no shared owner, no engagement with
 * either party inside it — both facts a runtime checks, at binding and again
 * at verdict. A verdict not produced inside `deadline_days` is a refusal by
 * silence, and a late verdict is void: the role's own contract says a late
 * verdict is not a verdict.
 *
 * `fallback` is one of the OTHER three postures, never `arbiter`: an arbiter
 * can decline, conflict out, or fall silent, and a dispute with no working
 * forum must land somewhere the parties already agreed to — which cannot be
 * the forum that just died.
 */
export interface SowArbiterBinding {
  role: string;
  agent?: string;
  independence_days: number;
  deadline_days: number;
  fee: SowArbiterFee;
  fallback: Exclude<SowDisputesPosture, "arbiter">;
}

/**
 * The disputes clause (§5.10). Shapes pinned by `conformance/sow-disputes.json`.
 *
 * Graded `evidence`, flatly: the enforced parts of §5.10 are ACTIONS clearing
 * takes — the refund where reversal is supported (§8.2), the freeze on the
 * disputed amount, the split moving on a verdict's signature — never the
 * clause's own grade. Quality judgment is out of scope for the runtime and
 * always will be: no machine here judges whether work was good. The `arbiter`
 * posture does not change that; it names who judges, and what the machinery
 * enforces is only what is mechanical about the naming and the outcome.
 */
export interface SowDisputes {
  posture: SowDisputesPosture;
  /** REQUIRED when `posture` is `"arbiter"` — an arbiter posture naming no
   *  arbiter terms names no forum — and REFUSED on every other posture. */
  arbiter?: SowArbiterBinding;
  grade: "evidence";
}

/** Backstops, not policy — the same ceiling every name-shaped string in this
 *  file gets. */
const ARBITER_ROLE_MAX = 64;
const ARBITER_AGENT_MAX = 64;

const SOW_DISPUTES_POSTURE_SET: ReadonlySet<string> = new Set(SOW_DISPUTES_POSTURES);
const SOW_ARBITER_FEE_SET: ReadonlySet<string> = new Set(SOW_ARBITER_FEES);

export function validateSowDisputes(v: unknown): asserts v is SowDisputes {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a disputes clause is an object carrying posture and grade (§5.10)");
  }
  const d = v as Record<string, unknown>;
  if (typeof d.posture !== "string" || !SOW_DISPUTES_POSTURE_SET.has(d.posture)) {
    invalid(
      "a disputes clause's posture is 'none', 'refund_on_failed_task', 'escalate_to_owners' or 'arbiter' — exactly one, from a closed set (§5.10)",
    );
  }
  if (d.grade !== "evidence") {
    invalid(
      "a disputes clause is graded 'evidence', flatly: the signed record a dispute is read against is exportable, and what is enforced under §5.10 is the actions clearing takes — the refund, the freeze, the split — never the clause's own grade. " +
        "Not 'enforced' — no machine here judges whether work was good — and not 'recorded', because the record a dispute rests on is more than a record of the clause (§5.10, §4.2)",
    );
  }
  if (d.posture === "arbiter") {
    if (d.arbiter === undefined) {
      invalid(
        "an arbiter posture naming no arbiter terms names no forum: the arbiter member — role, independence_days, deadline_days, fee, fallback — is required when the posture is 'arbiter' (§5.10.1)",
      );
    }
  } else if (d.arbiter !== undefined) {
    invalid(
      "only the arbiter posture carries the arbiter member: a clause naming a judge under a posture that never convenes one is two clauses disagreeing about which it is (§5.10, §5.10.1)",
    );
  }
  if (d.arbiter === undefined) return;
  if (typeof d.arbiter !== "object" || d.arbiter === null || Array.isArray(d.arbiter)) {
    invalid(
      "the arbiter member is an object carrying role, independence_days, deadline_days, fee and fallback (§5.10.1)",
    );
  }
  const a = d.arbiter as Record<string, unknown>;
  if (typeof a.role !== "string" || !a.role.trim() || a.role.length > ARBITER_ROLE_MAX) {
    invalid(
      `the arbiter's role names the published role contract the serving agent must hold — '${ROLE_ARBITER}' is the standard registry's — up to ${ARBITER_ROLE_MAX} characters, and not blank (§5.10.1)`,
    );
  }
  if (
    a.agent !== undefined &&
    (typeof a.agent !== "string" || !a.agent.trim() || a.agent.length > ARBITER_AGENT_MAX)
  ) {
    invalid(
      `the arbiter's agent, when bound at formation, is the judge's public key as a non-empty string up to ${ARBITER_AGENT_MAX} characters — shape only: whether the key is real is the platform's problem (§5.10.1)`,
    );
  }
  if (!isPosInt(a.independence_days)) {
    invalid(
      "independence_days is a positive whole number of days: the window inside which the arbiter must share no owner with either party and have held no engagement with either (§5.10.1)",
    );
  }
  if (!isPosInt(a.deadline_days)) {
    invalid(
      "deadline_days is a positive whole number of days, running from the dispute's opening; a verdict not produced inside it is a refusal by silence, and a late verdict is void (§5.10.1)",
    );
  }
  if (typeof a.fee !== "string" || !SOW_ARBITER_FEE_SET.has(a.fee)) {
    invalid(
      "the arbiter's fee is 'split' — the parties bear it equally — or 'follows_finding' — each bears it in proportion to the split found against them (§5.10.1)",
    );
  }
  if (typeof a.fallback !== "string" || !SOW_DISPUTES_POSTURE_SET.has(a.fallback) || a.fallback === "arbiter") {
    invalid(
      "every arbiter clause states where a dead forum lands, and it cannot land on itself: fallback is one of the OTHER three postures — 'none', 'refund_on_failed_task' or 'escalate_to_owners', never 'arbiter' (§5.10.1)",
    );
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link reportingOf}.
 *
 * There is deliberately NO default posture for an absent clause: absent means
 * the document has not said, and a reader MUST NOT invent a posture on its
 * behalf — unlike reporting, where an absent clause honestly offers the
 * mechanical record, an unstated dispute posture is not any particular one of
 * the four.
 */
export function disputesOf(doc: unknown): SowDisputes | null {
  if (typeof doc !== "object" || doc === null) return null;
  const d = (doc as { disputes?: unknown }).disputes;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as SowDisputes) : null;
}

// ── §5.10.1: the arbiter's verdict ──────────────────────────────────────────

/** The domain tag inside an arbiter verdict's signed bytes
 *  (agentroles.ai/arbiter.html §4): the ASCII tag, one newline, then the JCS
 *  canonical JSON of the verdict with `signatures` removed — the family
 *  convention, under the verdict's own tag. The prefix exists only inside the
 *  signed bytes; it never appears in the document itself. */
export const ARBITER_VERDICT_SIG_PREFIX = "agent-arbiter-verdict-v1\n";

/** One record a verdict excluded from its basis, with the reason — anything
 *  that failed verification is excluded and NAMED as excluded, because a
 *  verdict resting on unverified evidence does not conform
 *  (arbiter.html §3.1). */
export interface SowArbiterExclusion {
  id: string;
  why: string;
}

/** The signature on a verdict. One signer — the arbiter, whose key the
 *  verdict's `by` names — so unlike {@link SowSignature} there is no role
 *  member to carry. */
export interface SowArbiterVerdictSignature {
  key: string;
  signed_at: string;
  sig: string;
}

/**
 * The document an arbiter produces (agentroles.ai/arbiter.html §4) — the
 * answer to the role's one question: given this signed engagement and this
 * evidence, how does the disputed amount divide between the parties?
 *
 * The operative parts are `split` and `attribution`. Machines read those;
 * people read `reasons`, and a runtime that settles from the reasons instead
 * of the split does not conform. `basis` commits the verdict to the exact
 * record set it ruled from, by hash, so either party can recompute what was
 * before the judge; the verdict carries record ids and reasons, never record
 * contents. `heard` says whether each party's submission was received —
 * silence from a party is recorded, never punished by inference.
 */
export interface SowArbiterVerdict {
  verdict: "v1";
  role: "arbiter";
  engagement: string;
  dispute: string;
  disputed: { currency: string; amount: number };
  split: { provider: number; client: number };
  /** From the Agent SoW failure vocabulary, so a dispute that ends in a
   *  finding becomes the same kind of evidence as a failure recorded honestly
   *  in the first place. Validated as a non-empty name, NOT as a closed set
   *  here: the vocabulary lives with the failure clauses, and pinning a copy
   *  of it in the verdict validator is how two lists drift. */
  attribution: string;
  basis: {
    count: number;
    /** sha256 over the JCS array of the record ids, sorted — the same
     *  convention as the bookkeeper's statement. 64 lowercase hex. */
    ids_sha256: string;
    excluded?: SowArbiterExclusion[];
  };
  heard: { provider: boolean; client: boolean };
  reasons: string;
  produced_at: string;
  /** The arbiter agent's public key. */
  by: string;
  signatures: SowArbiterVerdictSignature[];
}

/** What the CLAUSE side already knows when it receives a verdict: the amount
 *  the dispute was opened against, in the engagement's currency. Handing it
 *  to {@link validateArbiterVerdict} makes the verdict-vs-dispute match part
 *  of the shape check. */
export interface ArbiterVerdictExpectation {
  disputed_amount?: number;
  currency?: string;
}

const ARBITER_NAME_MAX = 64;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Shape rules for a verdict (arbiter.html §4), plus — when `expected` is
 * given — the clause side of the check: the verdict must be about the amount
 * and currency the dispute was opened against.
 *
 * The load-bearing rule is rule 1: `split.provider + split.client` MUST equal
 * `disputed.amount` exactly, in whole units. Money divides one way in this
 * family: by integers, with nothing left over and nothing invented — the same
 * safe-integer discipline as the price validators, so two SDKs cannot
 * disagree by one at the boundary.
 */
export function validateArbiterVerdict(
  v: unknown,
  expected?: ArbiterVerdictExpectation,
): asserts v is SowArbiterVerdict {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("an arbiter verdict is an object — the role's signed document (arbiter.html §4)");
  }
  const w = v as Record<string, unknown>;
  if (w.verdict !== "v1") invalid("verdict is 'v1' (arbiter.html §4)");
  if (w.role !== "arbiter") invalid("a verdict's role is 'arbiter' (arbiter.html §4)");
  if (typeof w.engagement !== "string" || !w.engagement.trim() || w.engagement.length > ARBITER_NAME_MAX) {
    invalid("a verdict names the engagement it was handed, and nothing outside it is in the grant (arbiter.html §4)");
  }
  if (typeof w.dispute !== "string" || !w.dispute.trim() || w.dispute.length > ARBITER_NAME_MAX) {
    invalid("a verdict names the dispute it concludes (arbiter.html §4)");
  }
  if (typeof w.disputed !== "object" || w.disputed === null || Array.isArray(w.disputed)) {
    invalid("disputed is an object carrying currency and amount — the money the parties' signatures granted authority over (arbiter.html §4)");
  }
  const disputed = w.disputed as Record<string, unknown>;
  if (typeof disputed.currency !== "string" || !CURRENCY_RE.test(disputed.currency)) {
    invalid("disputed.currency is a three-letter uppercase code");
  }
  if (!isNonNegInt(disputed.amount)) {
    invalid("disputed.amount is a non-negative integer in the smallest unit of the currency — never a float");
  }
  if (typeof w.split !== "object" || w.split === null || Array.isArray(w.split)) {
    invalid("split is an object carrying provider and client — the one operative division of the disputed amount (arbiter.html §4)");
  }
  const split = w.split as Record<string, unknown>;
  if (!isNonNegInt(split.provider) || !isNonNegInt(split.client)) {
    invalid(
      "split.provider and split.client are non-negative integers: the answer runs from full release to full refund, in whole units, and a negative share is authority nobody granted (arbiter.html §4)",
    );
  }
  if ((split.provider as number) + (split.client as number) !== disputed.amount) {
    invalid(
      "split.provider + split.client must equal disputed.amount exactly, in whole units: money divides one way in this family — by integers, with nothing left over and nothing invented (arbiter.html §4 rule 1)",
    );
  }
  if (expected !== undefined) {
    if (expected.disputed_amount !== undefined && disputed.amount !== expected.disputed_amount) {
      invalid(
        "the verdict's disputed.amount is not the amount this dispute was opened against; the parties' signatures granted authority over that amount and nothing else (§5.10.2, arbiter.html §4)",
      );
    }
    if (expected.currency !== undefined && disputed.currency !== expected.currency) {
      invalid(
        "the verdict's currency is not the engagement's; a split in some other money divides nothing this clause froze (§5.10.2, arbiter.html §4)",
      );
    }
  }
  if (typeof w.attribution !== "string" || !w.attribution.trim() || w.attribution.length > ARBITER_NAME_MAX) {
    invalid(
      "attribution names a failure from the Agent SoW failure vocabulary, so the finding becomes the same kind of evidence as a failure recorded honestly in the first place — a non-empty name (arbiter.html §4 rule 2)",
    );
  }
  if (typeof w.basis !== "object" || w.basis === null || Array.isArray(w.basis)) {
    invalid("basis is an object carrying count and ids_sha256 — no cited basis, no conforming verdict (arbiter.html §3.5)");
  }
  const basis = w.basis as Record<string, unknown>;
  if (!isNonNegInt(basis.count)) {
    invalid("basis.count is a non-negative integer: how many records were before the judge");
  }
  if (typeof basis.ids_sha256 !== "string" || !SHA256_HEX_RE.test(basis.ids_sha256)) {
    invalid(
      "basis.ids_sha256 is exactly 64 lowercase hex characters — sha256 over the JCS array of the record ids, sorted, so a verifier holding the records recomputes and compares (arbiter.html §4 rule 3)",
    );
  }
  if (basis.excluded !== undefined) {
    if (!Array.isArray(basis.excluded)) {
      invalid("excluded is a list of the records that failed verification, each named with the reason (arbiter.html §3.1)");
    }
    if (basis.excluded.length === 0) {
      invalid(
        "an empty excluded list declares nothing, which OMITTING the member already means; two spellings of one state is how implementations come to disagree about which is which",
      );
    }
    for (const e of basis.excluded) {
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        invalid("each exclusion is an object carrying id and why");
      }
      const x = e as Record<string, unknown>;
      if (typeof x.id !== "string" || !x.id.trim() || x.id.length > ARBITER_NAME_MAX) {
        invalid("an exclusion names the record it excludes");
      }
      if (typeof x.why !== "string" || !x.why.trim()) {
        invalid(
          "an exclusion carries the reason the record fell out of the basis; excluded and unexplained is indistinguishable from suppressed (arbiter.html §3.1)",
        );
      }
    }
  }
  if (typeof w.heard !== "object" || w.heard === null || Array.isArray(w.heard)) {
    invalid("heard is an object saying whether each party's submission was received (arbiter.html §3.6)");
  }
  const heard = w.heard as Record<string, unknown>;
  if (typeof heard.provider !== "boolean" || typeof heard.client !== "boolean") {
    invalid(
      "heard carries BOTH booleans, provider and client: the verdict must say whether each was received, and silence from a party is recorded, never punished by inference (arbiter.html §3.6)",
    );
  }
  if (typeof w.reasons !== "string" || !w.reasons.trim()) {
    invalid("reasons is the prose a person reads; machines read the split and the attribution (arbiter.html §4 rule 5)");
  }
  if (typeof w.produced_at !== "string" || !RFC3339.test(w.produced_at)) {
    invalid("produced_at must be an RFC-3339 instant — a late verdict is not a verdict, so when it was produced is load-bearing (arbiter.html §3.8)");
  }
  if (typeof w.by !== "string" || !w.by.trim() || w.by.length > ARBITER_NAME_MAX) {
    invalid("by is the arbiter agent's public key (arbiter.html §4)");
  }
  if (w.signatures !== undefined && !Array.isArray(w.signatures)) {
    invalid("signatures is the list the arbiter's signature is appended to (arbiter.html §4)");
  }
}

/** The exact bytes an arbiter signs: {@link ARBITER_VERDICT_SIG_PREFIX} + the
 *  JCS canonical JSON of the verdict with `signatures` removed. The
 *  canonicalization is {@link canonicalSowJSON}'s — document minus
 *  `signatures`, canonicalized — deliberately reused rather than re-implemented,
 *  under the verdict's own tag. */
export function arbiterVerdictSignedBytes(verdict: object): Uint8Array {
  return new TextEncoder().encode(ARBITER_VERDICT_SIG_PREFIX + canonicalSowJSON(verdict));
}

/**
 * Sign a verdict as the arbiter, appending to `signatures` — the borrowed
 * authority the parties' signatures granted is spent the moment this record
 * is appended (arbiter.html §3.3).
 */
export function signArbiterVerdict<T extends object>(
  verdict: T,
  kp: Signer,
  signedAt?: string,
): T & { signatures: SowArbiterVerdictSignature[] } {
  const existing = ((verdict as { signatures?: SowArbiterVerdictSignature[] }).signatures ?? []).filter(
    (s) => s.key !== kp.getPublicKey(),
  );
  const sig = toB64Url(signTagged(kp, ARBITER_VERDICT_SIG_PREFIX, canonicalSowJSON(verdict)));
  return {
    ...verdict,
    signatures: [
      ...existing,
      {
        key: kp.getPublicKey(),
        signed_at: signedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        sig,
      },
    ],
  };
}

/** Verify one signature record against the verdict's canonical bytes. Where
 *  clearing honors the clause, this verification is what money moves on:
 *  verifying the arbiter's signature is arithmetic even though its judgment
 *  is not. */
export function verifyArbiterVerdictSignature(
  verdict: object,
  signature: SowArbiterVerdictSignature,
): boolean {
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(signature.sig);
  } catch {
    return false;
  }
  return verifyTagged(signature.key, ARBITER_VERDICT_SIG_PREFIX, canonicalSowJSON(verdict), sigBytes);
}
