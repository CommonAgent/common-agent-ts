/**
 * The bureau's report (Agent Reputations §8), as data: the signing tags, the
 * report's shape, and how a capability's block and the whole report are put
 * together from a pool and a score. Signing the report is the bureau's
 * (signing.ts holds the bytes), because the key lives with it.
 *
 * The shape is the earlier bureau's own `fdbk-report-v1`, from before 0.6.0.
 */
import type { NdaRecord } from "./nda-record.js";
import { FORMULA_VERSION, HALF_LIFE_DAYS, K_VALUE, UNPROVEN_THRESHOLD, type QualityScore } from "./score.js";
import type { EnrollmentInfo, PoolResult } from "./ledger.js";

/** The prefix a report is signed under, over its canonical JSON. */
export const REPORT_SIG_PREFIX = "fdbk-report-v1\n";
/** The colon-joined signed forms of the enrollment acts (§3). */
export const ENROLL_TAG = "fdbk-enroll-v1";
export const WITHDRAW_TAG = "fdbk-withdraw-v1";
/** §6.6's signed form, colon-joined like the enrollment acts:
 *  fdbk-value-v1:<interaction_id>:<subject>:<capability>:<outcome>:<amount>:<currency>:<units>:<at> */
export const VALUE_TAG = "fdbk-value-v1";

/** What an agent signs to enroll at a bureau or to withdraw from it (§3.2):
 *  the tag, the subject's key, the bureau's URL and the instant, joined by
 *  colons. The bureau verifies these bytes and the adapter signs them, both
 *  from here. */
export function enrollmentActText(tag: typeof ENROLL_TAG | typeof WITHDRAW_TAG, subject: string, bureauUrl: string, at: string): string {
  return `${tag}:${subject}:${bureauUrl}:${at}`;
}

/** A value judgment's signed form (§6.6), the bytes the client signs and the
 *  bureau verifies. A judgment MAY carry no amount or no units, and an
 *  absent number signs as an empty position, never as zero. */
export function valueJudgmentText(j: {
  interactionId: string;
  seller: string;
  offering: string;
  outcome: string;
  amount: number | null;
  currency: string;
  units: number | null;
  at: string;
}): string {
  return [
    VALUE_TAG, j.interactionId, j.seller, j.offering, j.outcome,
    j.amount === null ? "" : String(j.amount),
    j.currency,
    j.units === null ? "" : String(j.units),
    j.at,
  ].join(":");
}

/** How long a report stays good after it is issued. */
export const REPORT_TTL_MS = 60 * 60 * 1000;

export type CapabilityState = "UNENROLLED" | "WITHDRAWN" | "UNPROVEN" | "RATED";

export interface CapabilityBlock {
  capability: string;
  enrollment: string;
  quality: { lcb?: number; mean?: number; n_eff: number };
  candor: { decline_rate: number; silent_failure_rate: number };
  evidence: {
    scored_interactions: number;
    declined: number;
    attester_anchors: number;
    top_anchor_share: number;
    value_judgments?: number;
    value_judgment_share?: number;
    client_not_furnished?: number;
    oldest?: string;
    newest?: string;
  };
}

/** What an UNENROLLED subject's capability shows: only that interactions were observed (§8.3). */
export interface FactsBlock {
  capability: string;
  enrollment: "UNENROLLED";
  facts: { interactions_recorded: number };
}

export interface Report {
  subject: string;
  enrollment: string;
  enrolled_at?: string;
  withdrew_at?: string;
  withdrawal_effective_at?: string;
  capabilities: Array<CapabilityBlock | FactsBlock>;
  half_life_days: number;
  unproven_threshold: number;
  k_value: number;
  formula_version: string;
  bureau: string;
  issued_at: string;
  expires_at: string;
  nda?: NdaRecord;
}

/** A report in its envelope (§8.1): the bureau's key and signature beside it, and the key's id
 *  in the 0.6.0 envelope; the envelope from before 0.6.0 carries no id. */
export interface SignedReport {
  report: Report;
  bureau_key: string;
  bureau_kid?: string;
  bureau_sig: string;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Per-capability enrollment state (§3.1): UNPROVEN vs RATED is a property
 *  of the evidence for the capability queried, not of the subject. */
export function capabilityState(info: EnrollmentInfo, nEff: number): CapabilityState {
  if (info.state === "UNENROLLED") return "UNENROLLED";
  if (info.state === "WITHDRAWN") return "WITHDRAWN";
  return nEff < UNPROVEN_THRESHOLD ? "UNPROVEN" : "RATED";
}

/** One capability's block of an enrolled subject's report, from its pool and its score. */
export function capabilityBlock(capability: string, info: EnrollmentInfo, pool: PoolResult, q: QualityScore): CapabilityBlock {
  const state = capabilityState(info, q.n_eff);
  const anchors = pool.attesterAnchors;
  const totalAttested = [...anchors.values()].reduce((a, b) => a + b, 0);
  const top = anchors.size ? Math.max(...anchors.values()) : 0;
  return {
    capability,
    enrollment: state,
    // The score, only where the evidence has earned the right to be one
    // (§7.4): an UNPROVEN capability serves its sample size, not a number
    // dressed as seasoned.
    ...(state === "RATED" || state === "WITHDRAWN"
      ? { quality: { lcb: round(q.lcb), mean: round(q.mean), n_eff: round(q.n_eff) } }
      : { quality: { n_eff: round(q.n_eff) } }),
    candor: {
      decline_rate: round(pool.declined / Math.max(1, pool.declined + pool.scoredInteractions)),
      silent_failure_rate: round(pool.silentFailures / Math.max(1, pool.scoredInteractions)),
    },
    evidence: {
      scored_interactions: pool.scoredInteractions,
      declined: pool.declined,
      attester_anchors: anchors.size,
      top_anchor_share: round(totalAttested ? top / totalAttested : 0),
      // §8.2: REQUIRED whenever the pool contains a value judgment, and
      // absent otherwise so its presence means something. It is a share of
      // the pool's WEIGHT after §7.6, not a count of events.
      ...(pool.valueJudgments
        ? { value_judgments: pool.valueJudgments, value_judgment_share: round(q.value_judgment_share) }
        : {}),
      // SPEC §10.8a: stops the platform attributed to the caller, because it
      // checked the named need against what this agent declared. Reported so
      // that "not scored" does not quietly become "never happened" — a
      // reader can see the ending and see that it cost the provider nothing.
      ...(pool.notFurnished ? { client_not_furnished: pool.notFurnished } : {}),
      ...(pool.oldest ? { oldest: pool.oldest } : {}),
      ...(pool.newest ? { newest: pool.newest } : {}),
    },
  };
}

/** One capability of an UNENROLLED subject: quality is opt-in (§3.1), so only
 *  the fact that interactions were observed is served, clearly labeled (§8.3). */
export function factsBlock(capability: string, pool: PoolResult): FactsBlock {
  return { capability, enrollment: "UNENROLLED", facts: { interactions_recorded: pool.scoredInteractions + pool.declined } };
}

/** The answer to a resolution query (§8), unsigned. */
export function assembleReport(x: {
  subject: string;
  info: EnrollmentInfo;
  capabilities: Array<CapabilityBlock | FactsBlock>;
  bureau: string;
  nowMs: number;
  /** The NDA record (§4.9), served for any subject, enrolled or not, beside the scores and never in them. */
  nda?: NdaRecord;
}): Report {
  const { info } = x;
  return {
    subject: x.subject,
    enrollment: info.state === "ENROLLED" ? "ENROLLED" : info.state,
    ...(info.enrolled_at ? { enrolled_at: info.enrolled_at } : {}),
    ...(info.withdrew_at ? { withdrew_at: info.withdrew_at, withdrawal_effective_at: info.withdrawal_effective_at } : {}),
    capabilities: x.capabilities,
    half_life_days: HALF_LIFE_DAYS,
    unproven_threshold: UNPROVEN_THRESHOLD,
    // §7.6/§10.3: a bureau MAY choose K_value but MUST publish the value it
    // uses. Published here, inside the signed bytes, so a consumer
    // recomputing §7 knows the multiplier that produced the number.
    k_value: K_VALUE,
    formula_version: FORMULA_VERSION,
    ...(x.nda ? { nda: x.nda } : {}),
    bureau: x.bureau,
    issued_at: new Date(x.nowMs).toISOString(),
    expires_at: new Date(x.nowMs + REPORT_TTL_MS).toISOString(),
  };
}

// ── The report in the standard's shape (§8.1) ────────────────────────────────

/**
 * A report as 0.6.0 writes it (§8.1): one subject and one capability, the
 * enrollment state for that capability at the top, and the score, candor and
 * evidence blocks beside it. A facts-only report about an UNENROLLED subject
 * (§8.3) carries no quality or candor block.
 */
export interface CapabilityReport {
  subject: string;
  capability: string;
  enrollment: CapabilityState;
  enrolled_at?: string;
  withdrew_at?: string;
  withdrawal_effective_at?: string;
  quality?: { lcb?: number; mean?: number; n_eff: number };
  candor?: { decline_rate: number; silent_failure_rate: number };
  /** This bureau's one fact for a facts-only report: how many interactions it recorded. */
  facts?: { interactions_recorded: number };
  evidence?: {
    half_life_days: number;
    oldest?: string;
    newest?: string;
    attester_anchors: number;
    top_anchor_share: number;
    value_judgments?: number;
    value_judgment_share?: number;
    client_not_furnished?: number;
    /** §7.5: whether a portfolio prior is in effect. This bureau applies none yet. */
    portfolio_prior: boolean;
  };
  formula_version: string;
  k_value: number;
  unproven_threshold: number;
  /** The subject's NDA record (§4.9), the same in every capability's report, and never in its figures. */
  nda?: NdaRecord;
  bureau: string;
  issued_at: string;
  expires_at: string;
}

/**
 * The answer to a resolution query about one capability (§8.1), unsigned:
 * the same figures `capabilityBlock` gives, laid out as the standard lays a
 * report out, with the mandatory context of §8.2 beside every score.
 */
export function assembleCapabilityReport(x: {
  subject: string;
  capability: string;
  info: EnrollmentInfo;
  pool: PoolResult;
  score: QualityScore;
  bureau: string;
  nowMs: number;
  nda?: NdaRecord;
}): CapabilityReport {
  const { info, pool } = x;
  const head = {
    subject: x.subject,
    capability: x.capability,
    ...(info.enrolled_at ? { enrolled_at: info.enrolled_at } : {}),
    ...(info.withdrew_at ? { withdrew_at: info.withdrew_at, withdrawal_effective_at: info.withdrawal_effective_at } : {}),
  };
  const tail = {
    formula_version: FORMULA_VERSION,
    k_value: K_VALUE,
    unproven_threshold: UNPROVEN_THRESHOLD,
    ...(x.nda ? { nda: x.nda } : {}),
    bureau: x.bureau,
    issued_at: new Date(x.nowMs).toISOString(),
    expires_at: new Date(x.nowMs + REPORT_TTL_MS).toISOString(),
  };
  if (info.state === "UNENROLLED") {
    // §8.3: quality is opt-in; an unenrolled subject's report states facts only.
    return { ...head, enrollment: "UNENROLLED", facts: factsBlock(x.capability, pool).facts, ...tail };
  }
  const block = capabilityBlock(x.capability, info, pool, x.score);
  return {
    ...head,
    enrollment: block.enrollment as CapabilityState,
    quality: block.quality,
    candor: block.candor,
    evidence: {
      half_life_days: HALF_LIFE_DAYS,
      ...block.evidence,
      portfolio_prior: false,
    },
    ...tail,
  };
}
