/**
 * The quality pool of Agent Reputations §7.1, drawn from ledger events in the
 * standard's shape (§4): which events score, with what value and weight.
 *
 * A ledger that still keeps the earlier shape draws its pool with ledger.ts,
 * and moves to this one when it takes the standard's actions. The published vectors
 * (fdbk-score-1) are written in this shape, and run against it.
 */
import { HALF_LIFE_DAYS, K_VALUE, OUTCOME_VALUES, VALUE_OUTCOMES } from "./score.js";

/** One ledger event, as §4 writes it. Only the members the pool reads are named. */
export type LedgerEvent =
  | { seq: number; action: "fact"; interaction_id: string; ended_at: string; derived_outcome: string }
  | { seq: number; action: "attested"; interaction_id: string; outcome: string; excluded?: boolean }
  | { seq: number; action: "probed"; interaction_id: string; ended_at: string; result: "PASS" | "FAIL" }
  | { seq: number; action: string; interaction_id?: string; [k: string]: unknown };

/** One scored event of the pool: its outcome, where it came from, its value and its weight. */
export interface PoolEntry {
  interaction_id: string;
  outcome: string;
  from: "fact" | "attested" | "probed";
  v: number;
  w: number;
  value_judgment?: boolean;
}

/** The codes on which there was no work to judge (§6.2 rule 5): an attestation about one is rejected. */
export const NO_WORK = new Set(["DECLINED", "REFUSED", "REFUSED_UNSTATED", "UNAVAILABLE", "STOPPED"]);

const DAY_MS = 86_400_000;

/**
 * The pool of §7.1 for one (subject, capability), from that pair's events.
 *
 * - A fact scores its derived outcome, unless an attestation overrides it.
 * - An attestation is rejected without a fact for its interaction (§6.2
 *   rule 1), on an interaction with no work (rule 5), or when it names
 *   NDA_BREACH (rule 6). A later attestation for one interaction is an
 *   amendment, and only the last one scores (rule 3). An excluded
 *   attestation (§6.4) does not score, and the derived outcome stands.
 * - A probe scores PASS as 1 and FAIL as 0.
 * - Every other action (stops, claims of breach and their resolution, and the
 *   rest) never enters a pool, and neither does an outcome §5 gives no value.
 *
 * Every event's age runs from the `ended_at` of the interaction it scores to
 * the evaluation instant (§7.2): an attestation takes its interaction's age,
 * however late it was signed. A value judgment's weight is multiplied by
 * K_value (§7.6).
 */
export function poolFromEvents(
  events: readonly LedgerEvent[],
  opts: { evaluatedAt: string | number; halfLifeDays?: number; kValue?: number },
): PoolEntry[] {
  const now = typeof opts.evaluatedAt === "number" ? opts.evaluatedAt : Date.parse(opts.evaluatedAt);
  const halfLife = opts.halfLifeDays ?? HALF_LIFE_DAYS;
  const kValue = opts.kValue ?? K_VALUE;
  const sorted = [...events].sort((x, y) => x.seq - y.seq);
  const facts = new Map<string, Extract<LedgerEvent, { action: "fact" }>>();
  for (const e of sorted) if (e.action === "fact") facts.set(e.interaction_id as string, e as Extract<LedgerEvent, { action: "fact" }>);
  const attestations = new Map<string, Extract<LedgerEvent, { action: "attested" }>>();
  for (const e of sorted) {
    if (e.action !== "attested") continue;
    const a = e as Extract<LedgerEvent, { action: "attested" }>;
    const f = facts.get(a.interaction_id);
    if (!f || NO_WORK.has(f.derived_outcome) || a.outcome === "NDA_BREACH" || a.excluded) continue;
    attestations.set(a.interaction_id, a);
  }
  const weight = (endedAt: string, code: string) => {
    const age = (now - Date.parse(endedAt)) / DAY_MS;
    return (VALUE_OUTCOMES.has(code) ? kValue : 1) * 2 ** (-age / halfLife);
  };
  const out: PoolEntry[] = [];
  for (const e of sorted) {
    if (e.action === "fact") {
      const f = e as Extract<LedgerEvent, { action: "fact" }>;
      const a = attestations.get(f.interaction_id);
      const outcome = a ? a.outcome : f.derived_outcome;
      if (!(outcome in OUTCOME_VALUES)) continue;
      out.push({
        interaction_id: f.interaction_id,
        outcome,
        from: a ? "attested" : "fact",
        v: OUTCOME_VALUES[outcome],
        w: weight(f.ended_at, outcome),
        ...(VALUE_OUTCOMES.has(outcome) ? { value_judgment: true } : {}),
      });
    } else if (e.action === "probed") {
      const p = e as Extract<LedgerEvent, { action: "probed" }>;
      out.push({ interaction_id: p.interaction_id, outcome: p.result, from: "probed", v: p.result === "PASS" ? 1 : 0, w: weight(p.ended_at, p.result) });
    }
  }
  return out;
}
