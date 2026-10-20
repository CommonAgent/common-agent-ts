/**
 * The pure rules of the bureau's ledger (Agent Reputations §3, §4, §6.3).
 *
 * The ledger itself, the bureau's store,
 * stores the entries and keeps each subject's hash chain. What does not need
 * a database lives here: the entry and result shapes, which evidence wins an
 * interaction when evidence disagrees, how the scoring pool is drawn from the
 * evidence, and what a subject's enrollment acts add up to. Each takes rows
 * and returns a value, so anyone holding the rows computes the same answer.
 *
 * The shapes are an earlier bureau's own, from before 0.6.0; pool.ts holds
 * the standard's.
 */
import { createHash } from "node:crypto";
import { OUTCOME_VALUES, UNSCORED_OUTCOMES, type ScoredEvent } from "./score.js";
import { jcs } from "./signing.js";

/** The prev_hash of a chain's first entry. */
export const GENESIS = "genesis";

/**
 * The ledger's actions (§4.1). This bureau writes enrolled, withdrew, fact and
 * attested today; the rest are the standard's, named so a reader of any
 * chain knows them: amended (an enrollment's capabilities changed), probed
 * (§4.3), stopped (§4.6), nda_claimed, nda_answered and nda_resolved (§4.8),
 * excluded (§6.4) and corrected (§10, a data-error repair appended, never a
 * rewrite).
 */
export type LedgerAction =
  | "enrolled" | "amended" | "withdrew" | "fact" | "attested" | "probed" | "stopped"
  | "nda_claimed" | "nda_answered" | "nda_resolved" | "excluded" | "corrected";

export const LEDGER_ACTIONS: readonly LedgerAction[] = [
  "enrolled", "amended", "withdrew", "fact", "attested", "probed", "stopped",
  "nda_claimed", "nda_answered", "nda_resolved", "excluded", "corrected",
];

/** Evidence source, ranked. Higher rank wins the interaction (§6.3).
 *  `value` is the §6.6 value judgment: an attestation like a review, so it
 *  outranks the mechanical layers the same way — but it never competes with
 *  one, because the two cannot both exist for the same engagement (a
 *  document either names deliverables or it does not). `floor_miss` (Agent
 *  SoW §5.14) sits with `form_check`: both are mechanical verdicts derived
 *  from the engagement record, and either outranks the bare task fact.
 *  `interview` (SPEC.md §3.3.1) ranks with `task` — moot in practice, since
 *  interview outcomes sit outside the scoring table and its interaction ids
 *  collide with nothing, but a rank above 1 could let a non-scoring entry
 *  suppress a scoring one if an id ever did collide. `dispute` (§4.4: a fact,
 *  recorded and never scored) ranks 0, below everything, so even a dispute
 *  fact whose interaction id collided with a task's could never take that
 *  task's place; its ids are the dispute's own besides. */
export const SOURCE_RANK: Record<string, number> = { task: 1, form_check: 2, floor_miss: 2, interview: 1, dispute: 0, review: 3, value: 3 };

export interface LedgerEntry {
  subject: string;
  seq: number;
  at: string;
  action: LedgerAction;
  capability: string;
  detail: string; // JSON
  prev_hash: string;
  entry_hash: string;
  /**
   * How entry_hash was made. 1, or absent: this bureau's first construction,
   * lowercase hex SHA-256 over the canonical JSON of the entry with prev_hash
   * inside it. 2: the standard's (§4.1), base64 SHA-256 over the canonical
   * JSON of the entry without the two hash fields, its detail as an object,
   * followed by prev_hash. A chain may hold both; each entry says which.
   */
  hash_v?: 1 | 2;
}

/** The hash an entry should carry, by its hash_v. `canonical` is the platform's canonical JSON, which made the first construction's bytes. */
export function entryHashOf(entry: Omit<LedgerEntry, "entry_hash">, canonical: (v: unknown) => string = jcs): string {
  if ((entry.hash_v ?? 1) === 2) {
    const { prev_hash, ...rest } = entry;
    const body = jcs({ ...rest, detail: JSON.parse(entry.detail) as unknown });
    return createHash("sha256").update(body + prev_hash, "utf8").digest("base64");
  }
  // The first construction hashed the row as it was stored, which held no hash_v.
  const { hash_v: _v, ...v1 } = entry;
  return createHash("sha256").update(canonical(v1)).digest("hex");
}

/** Walk one subject's chain start to end, recomputing every link, whichever construction each entry used. */
export function verifyChainEntries(rows: readonly LedgerEntry[], canonical?: (v: unknown) => string): { ok: boolean; count: number; brokenAt?: number } {
  let prev = GENESIS;
  for (const row of rows) {
    const { entry_hash, ...rest } = row;
    if (row.prev_hash !== prev || entryHashOf(rest, canonical) !== entry_hash) return { ok: false, count: rows.length, brokenAt: row.seq };
    prev = entry_hash;
  }
  return { ok: true, count: rows.length };
}

export interface EnrollmentInfo {
  state: "UNENROLLED" | "ENROLLED" | "WITHDRAWN";
  enrolled_at?: string;
  withdrew_at?: string;
  /** Withdrawal takes effect after cooling-off (§3.3); until then evidence
   *  continues to land and the subject still reads as enrolled. */
  withdrawal_effective_at?: string;
}

export interface PoolResult {
  events: ScoredEvent[];
  declined: number;
  scoredInteractions: number;
  silentFailures: number;
  attesterAnchors: Map<string, number>;
  /** How many scored events are §6.6 value judgments. The report's
   *  `value_judgment_share` is a WEIGHT share and comes from scorePool; this
   *  count is what decides whether the field is required at all. */
  valueJudgments: number;
  /** SPEC §10.8a: failures the platform attributed to the CLIENT — the caller
   *  did not furnish something the offering declared it needed. Recorded and
   *  never scored, and counted here so that "not scored" does not become
   *  "invisible": a reader can see that the ending happened without it costing
   *  the provider anything. */
  notFurnished: number;
  oldest?: string;
  newest?: string;
}

/** Enrollment state from a subject's enrollment acts, in chain order (§3).
 *  Cooling-off: a withdrawal only takes effect `coolingOffDays` after it was
 *  filed. */
export function enrollmentFromActs(acts: readonly LedgerEntry[], nowMs: number, coolingOffDays = 30): EnrollmentInfo {
  if (!acts.length) return { state: "UNENROLLED" };
  let enrolledAt: string | undefined;
  let withdrewAt: string | undefined;
  for (const act of acts) {
    if (act.action === "enrolled") {
      enrolledAt = act.at;
      withdrewAt = undefined;
    } else {
      withdrewAt = act.at;
    }
  }
  if (withdrewAt) {
    const effective = new Date(Date.parse(withdrewAt) + coolingOffDays * 86_400_000).toISOString();
    if (nowMs >= Date.parse(effective)) {
      return { state: "WITHDRAWN", enrolled_at: enrolledAt, withdrew_at: withdrewAt, withdrawal_effective_at: effective };
    }
    return { state: "ENROLLED", enrolled_at: enrolledAt, withdrew_at: withdrewAt, withdrawal_effective_at: effective };
  }
  return { state: "ENROLLED", enrolled_at: enrolledAt };
}

/**
 * The quality pool drawn from evidence rows (§7.1). Per interaction, the
 * highest-ranked evidence class scores (§6.3); everything stays in the
 * ledger regardless. De-duplication is per interaction across all the rows
 * given, so the same rule serves one subject and an organisation's agents.
 */
export function poolFromEntries(rows: readonly LedgerEntry[]): PoolResult {
  interface Best { outcome: string; at: string; rank: number; evaluator?: string; source?: string }
  const byInteraction = new Map<string, Best>();
  // When each interaction ended (§7.2): its fact's ended_at, or the fact's own
  // time for a fact recorded without one. Every event about the interaction,
  // an attestation signed weeks later included, takes that age.
  const endedAt = new Map<string, string>();
  let anonSeq = 0;
  const parsed = rows.map((row) => ({
    row,
    d: JSON.parse(row.detail) as { interaction_id?: string; outcome?: string; derived_outcome?: string; source?: string; evaluator?: string; ended_at?: string },
  }));
  for (const { row, d } of parsed) {
    if (row.action === "fact" && d.interaction_id && !endedAt.has(d.interaction_id)) endedAt.set(d.interaction_id, d.ended_at ?? row.at);
  }
  for (const { row, d } of parsed) {
    const id = d.interaction_id ?? `anon_${anonSeq++}`;
    const rank = SOURCE_RANK[d.source ?? "task"] ?? 1;
    const prev = byInteraction.get(id);
    if (!prev || rank >= prev.rank) {
      byInteraction.set(id, { outcome: d.outcome ?? d.derived_outcome ?? "", at: endedAt.get(id) ?? d.ended_at ?? row.at, rank, evaluator: d.evaluator, source: d.source });
    }
  }
  const result: PoolResult = {
    events: [],
    declined: 0,
    scoredInteractions: 0,
    silentFailures: 0,
    attesterAnchors: new Map(),
    valueJudgments: 0,
    notFurnished: 0,
  };
  for (const best of byInteraction.values()) {
    if (best.evaluator) {
      result.attesterAnchors.set(best.evaluator, (result.attesterAnchors.get(best.evaluator) ?? 0) + 1);
    }
    if (best.outcome === "DECLINED") {
      result.declined += 1;
      continue;
    }
    if (best.outcome === "NOT_FURNISHED") result.notFurnished += 1;
    if (UNSCORED_OUTCOMES.has(best.outcome)) continue;
    const value = OUTCOME_VALUES[best.outcome];
    // An outcome with no quality value — EXHAUSTED, TERMINATED,
    // NOT_FURNISHED — is recorded and not scored (§4.4, SPEC §10.8a).
    // Skipping it here is the whole mechanism: it never becomes an event, so
    // it can never read as a failure however it got into the chain. This is
    // what keeps a customer's lapsed licence off the provider's record.
    if (value === undefined) continue;
    const isValue = best.source === "value";
    result.events.push({ value, at: best.at, ...(isValue ? { value_judgment: true } : {}) });
    if (isValue) result.valueJudgments += 1;
    result.scoredInteractions += 1;
    if (best.outcome === "FAILED_SILENT") result.silentFailures += 1;
    if (!result.oldest || best.at < result.oldest) result.oldest = best.at;
    if (!result.newest || best.at > result.newest) result.newest = best.at;
  }
  return result;
}
