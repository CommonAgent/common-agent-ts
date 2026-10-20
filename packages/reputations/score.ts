/**
 * fdbk-score-1 — the published scoring formula of the Agent Reputations
 * specification (§5, §7), the arithmetic of the Agent Reputations core. Pure arithmetic over an event pool: no I/O, no
 * randomness, no iteration. Anyone holding the events computes the same
 * numbers, which is the whole point — a score that cannot be recomputed is
 * an opinion with a haircut.
 *
 * The constants are formula constants, not tunables: changing any of them is
 * a new formula version (fdbk-score-2), never a quiet edit to this one.
 */

/** Quality value per outcome code (spec §5). DECLINED and UNREACHABLE carry
 *  no quality value: declining feeds candor, unreachability feeds facts.
 *
 *  VALUE_OK and VALUE_POOR answer a DIFFERENT question — was the spend worth
 *  it, on engagements where nothing was named that either party could accept
 *  (§6.6) — and enter the pool at the reduced weight of §7.6. They carry the
 *  same 1.0/0.0 values as acceptance and rejection; what separates them is
 *  the weight, not the value. */
export const OUTCOME_VALUES: Record<string, number> = {
  OK: 1.0,
  OK_CORRECTED: 0.6,
  FAILED: 0.15,
  FAILED_SILENT: 0.0,
  CONTRACT: 0.0,
  VALUE_OK: 1.0,
  VALUE_POOR: 0.0,
};

/** The two value-judgment codes (§6.6), by name. A value judgment MUST NOT be
 *  recorded through the acceptance path, and an acceptance MUST NOT be
 *  recorded through this one; the doors check against this set. */
export const VALUE_OUTCOMES = new Set(["VALUE_OK", "VALUE_POOR"]);

/** Outcomes excluded from the quality pool but still counted elsewhere. */
export const UNSCORED_OUTCOMES = new Set(["DECLINED", "UNREACHABLE"]);

export const FORMULA_VERSION = "fdbk-score-1";
export const HALF_LIFE_DAYS = 60;
/** Below this effective sample size a capability is UNPROVEN (§7.4). */
export const UNPROVEN_THRESHOLD = 20;
/**
 * §7.6: a value judgment's decay weight is multiplied by this.
 *
 * A formula constant of fdbk-score-1, alongside H and the UNPROVEN threshold,
 * not a tunable. With no artifact to point at, a judgment about whether money
 * was well spent is more subjective and more disputable than a judgment about
 * work that was named and delivered, and the honest way to price that is one
 * number a reader can see and argue with. The spec forbids setting it above
 * 1.0 and advises against above 0.5; 0.5 is the published default and what
 * this bureau uses.
 */
export const K_VALUE = 0.5;
/** z for the ~10th percentile lower confidence bound (§7.3). */
const Z = 1.2816;

export interface ScoredEvent {
  /** Quality value from OUTCOME_VALUES. */
  value: number;
  /** ISO timestamp of the interaction's end (decay reference). */
  at: string;
  /** True for a §6.6 value judgment: the decay weight is multiplied by
   *  K_VALUE (§7.6). Absent means an ordinary event at full weight. */
  value_judgment?: boolean;
}

export interface QualityScore {
  a: number;
  b: number;
  mean: number;
  sd: number;
  lcb: number;
  n_eff: number;
  unproven: boolean;
  /**
   * §8.2: the share of the pool's weight, AFTER §7.6, that came from value
   * judgments. Required in every report whose pool contains one — a reader
   * who cannot separate acceptances of named work from judgments about
   * whether a spend was worth it is reading two measurements as one number.
   */
  value_judgment_share: number;
}

/** Exponential decay weight (§7.2): w = 2^(-age_days / H). Future-dated
 *  events get weight 1 rather than >1 — clock skew is not extra credit. */
export function decayWeight(atIso: string, nowMs: number, halfLifeDays = HALF_LIFE_DAYS): number {
  const ageMs = nowMs - Date.parse(atIso);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return Math.pow(2, -(ageMs / 86_400_000) / halfLifeDays);
}

/** The weight one event contributes: the §7.2 decay, times §7.6's K_value
 *  when the event is a value judgment. Because the multiplier lands on w_i it
 *  reduces the event's effect on mean, sd, lcb and n_eff together — which is
 *  the correct reading of thinner evidence, and why §7.6 needs no other
 *  change to §7.3. */
export function eventWeight(e: ScoredEvent, nowMs: number, halfLifeDays = HALF_LIFE_DAYS): number {
  const w = decayWeight(e.at, nowMs, halfLifeDays);
  return e.value_judgment ? K_VALUE * w : w;
}

/**
 * The prior of §7.3 and §7.5: the pair that takes the place of the two 1s in
 * a and b. The uniform prior is { a0: 1, b0: 1 }. A portfolio prior may be
 * stronger, but never by more than the equivalent of 10 effective events.
 */
export interface Prior {
  a0: number;
  b0: number;
}

export const UNIFORM_PRIOR: Prior = { a0: 1, b0: 1 };

/** §7.5: a portfolio prior's weight, a0 + b0 − 2, MUST NOT exceed this. A formula constant. */
export const MAX_PRIOR_WEIGHT = 10;

/** Throws when a prior is not one §7.5 allows: both terms positive and finite, its weight from 0 to 10. */
export function checkPrior(prior: Prior): void {
  const { a0, b0 } = prior;
  if (!Number.isFinite(a0) || !Number.isFinite(b0) || a0 <= 0 || b0 <= 0) throw new Error("a prior's a0 and b0 are positive numbers");
  const weight = a0 + b0 - 2;
  if (weight < 0 || weight > MAX_PRIOR_WEIGHT + 1e-12) {
    throw new Error(`a prior's weight, a0 + b0 - 2, is from 0 to ${MAX_PRIOR_WEIGHT} (§7.5); this one is ${weight}`);
  }
}

/**
 * A portfolio prior from the anchor's other agents RATED for the same
 * capability (§7.5), as their mean quality spread over `weight` effective
 * events: a0 = 1 + weight · m, b0 = 1 + weight · (1 − m). The uniform prior
 * when there are none. The caller chooses which agents count; §7.5 says only
 * the anchor's own members RATED for this capability may.
 */
export function portfolioPrior(ratedMeans: readonly number[], weight = MAX_PRIOR_WEIGHT): Prior {
  const means = ratedMeans.filter((m) => Number.isFinite(m) && m >= 0 && m <= 1);
  if (!means.length) return UNIFORM_PRIOR;
  const w = Math.min(Math.max(weight, 0), MAX_PRIOR_WEIGHT);
  const m = means.reduce((x, y) => x + y, 0) / means.length;
  return { a0: 1 + w * m, b0: 1 + w * (1 - m) };
}

/**
 * The Beta posterior summary of §7.3 over weighted values, with the prior of
 * §7.5. n_eff counts direct evidence only: a + b less the two prior terms, so
 * a portfolio prior moves the mean and the bound and never makes a capability
 * RATED (§7.4).
 */
export function scoreWeighted(entries: ReadonlyArray<{ v: number; w: number; value_judgment?: boolean }>, prior: Prior = UNIFORM_PRIOR): QualityScore {
  checkPrior(prior);
  let sumWV = 0;
  let sumW = 0;
  let valueW = 0;
  for (const e of entries) {
    sumWV += e.w * e.v;
    sumW += e.w;
    if (e.value_judgment) valueW += e.w;
  }
  const a = prior.a0 + sumWV;
  const b = prior.b0 + (sumW - sumWV);
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) * (a + b) * (a + b + 1)));
  const lcb = Math.max(0, mean - Z * sd);
  const n_eff = a + b - (prior.a0 + prior.b0);
  return {
    a, b, mean, sd, lcb, n_eff,
    unproven: n_eff < UNPROVEN_THRESHOLD,
    value_judgment_share: sumW > 0 ? valueW / sumW : 0,
  };
}

/** The Beta posterior summary of §7.3, exactly as published, over scored events, with an optional prior (§7.5). */
export function scorePool(events: ScoredEvent[], nowMs: number, prior: Prior = UNIFORM_PRIOR): QualityScore {
  return scoreWeighted(events.map((e) => ({ v: e.value, w: eventWeight(e, nowMs), value_judgment: e.value_judgment })), prior);
}
