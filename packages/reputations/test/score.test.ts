/**
 * Test vectors for fdbk-score-1 (SPEC-FEEDBACK.md §14: vectors MUST accompany
 * the first implementation). Every expected number below is computed BY HAND
 * from the published formula (§7.2, §7.3) — never by running the code under
 * test — so these vectors would catch the implementation drifting from the
 * spec, not merely drifting from itself.
 *
 * The formula, verbatim from §7.2/§7.3:
 *
 *     w_i   = 2 ^ ( -age_days_i / 60 )          (future-dated: w = 1)
 *     a     = 1 + Σ ( w_i · v_i )
 *     b     = 1 + Σ ( w_i · ( 1 − v_i ) )
 *     mean  = a / ( a + b )
 *     sd    = sqrt( a·b / ( (a+b)² · (a+b+1) ) )
 *     lcb   = max( 0, mean − 1.2816 · sd )
 *     n_eff = a + b − 2                          (UNPROVEN iff n_eff < 20)
 *
 * Outcome values (§5): OK 1.0, OK_CORRECTED 0.6, FAILED 0.15,
 * FAILED_SILENT 0.0, CONTRACT 0.0.
 */
import { describe, it, expect } from "vitest";
import {
  scorePool,
  decayWeight,
  OUTCOME_VALUES,
  UNSCORED_OUTCOMES,
  FORMULA_VERSION,
  HALF_LIFE_DAYS,
  UNPROVEN_THRESHOLD,
  type ScoredEvent,
} from "../score.js";

const DAY = 86_400_000;
/** A fixed clock: vectors are meaningless against a moving now. */
const NOW = Date.parse("2026-08-06T00:00:00.000Z");
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();
const ok = (msBeforeNow = 0): ScoredEvent => ({ value: 1.0, at: at(msBeforeNow) });

describe("the formula constants are the published ones (§5, §7)", () => {
  it("pins the outcome value table and the formula constants", () => {
    expect(FORMULA_VERSION).toBe("fdbk-score-1");
    expect(HALF_LIFE_DAYS).toBe(60);
    expect(UNPROVEN_THRESHOLD).toBe(20);
    expect(OUTCOME_VALUES).toEqual({
      OK: 1.0,
      OK_CORRECTED: 0.6,
      FAILED: 0.15,
      FAILED_SILENT: 0.0,
      CONTRACT: 0.0,
      // Added by SPEC-FEEDBACK.md 0.3-draft §5 alongside §6.6's value
      // judgments. They carry the same values as acceptance and rejection;
      // what separates them is the §7.6 weight, pinned in
      // bureau-value-judgment.test.ts. The formula version is unchanged
      // because §7.3's arithmetic did not move.
      VALUE_OK: 1.0,
      VALUE_POOR: 0.0,
    });
    // DECLINED and UNREACHABLE are excluded from quality, per the §5 table.
    expect(UNSCORED_OUTCOMES.has("DECLINED")).toBe(true);
    expect(UNSCORED_OUTCOMES.has("UNREACHABLE")).toBe(true);
  });
});

describe("fdbk-score-1 vectors (§7.3), expectations computed by hand", () => {
  it("vector 1 — empty pool: the uniform prior alone, UNPROVEN", () => {
    // a = 1 + 0 = 1;  b = 1 + 0 = 1
    // mean = 1/2 = 0.5
    // sd   = sqrt( 1·1 / (2² · 3) ) = sqrt(1/12) = 0.28867513
    // lcb  = 0.5 − 1.2816 · 0.28867513 = 0.5 − 0.36996605 = 0.13003395
    // n_eff = 1 + 1 − 2 = 0  →  UNPROVEN
    const q = scorePool([], NOW);
    expect(q.a).toBe(1);
    expect(q.b).toBe(1);
    expect(q.mean).toBe(0.5);
    expect(q.sd).toBeCloseTo(0.2886751, 5);
    expect(q.lcb).toBeCloseTo(0.1300340, 5);
    expect(q.n_eff).toBe(0);
    expect(q.unproven).toBe(true);
  });

  it("vector 2 — a single fresh OK: weight 1, a=2, b=1", () => {
    // w = 2^(0/60) = 1;  v = 1.0
    // a = 1 + 1·1 = 2;  b = 1 + 1·(1−1) = 1
    // mean = 2/3 = 0.66666667
    // sd   = sqrt( 2·1 / (3² · 4) ) = sqrt(2/36) = sqrt(0.05555556) = 0.23570226
    // lcb  = 0.66666667 − 1.2816 · 0.23570226 = 0.66666667 − 0.30207602 = 0.36459065
    // n_eff = 2 + 1 − 2 = 1
    const q = scorePool([ok()], NOW);
    expect(q.a).toBeCloseTo(2, 9);
    expect(q.b).toBeCloseTo(1, 9);
    expect(q.mean).toBeCloseTo(0.6666667, 6);
    expect(q.sd).toBeCloseTo(0.2357023, 5);
    expect(q.lcb).toBeCloseTo(0.3645907, 5);
    expect(q.n_eff).toBeCloseTo(1, 9);
    expect(q.unproven).toBe(true);
  });

  it("vector 3 — mixed pool at age 0: 10×OK + 2×OK_CORRECTED + 1×FAILED + 1×FAILED_SILENT", () => {
    // All weights 1 (age 0). Values: 10×1.0, 2×0.6, 1×0.15, 1×0.0.
    // Σ w·v = 10·1.0 + 2·0.6 + 0.15 + 0 = 10 + 1.2 + 0.15 = 11.35
    // Σ w   = 14
    // a = 1 + 11.35 = 12.35
    // b = 1 + (14 − 11.35) = 1 + 2.65 = 3.65
    // a + b = 16;  mean = 12.35/16 = 0.771875
    // sd  = sqrt( 12.35·3.65 / (16² · 17) ) = sqrt( 45.0775 / 4352 )
    //     = sqrt(0.01035788) = 0.1017737
    // lcb = 0.771875 − 1.2816 · 0.1017737 = 0.771875 − 0.1304333 = 0.6414417
    // n_eff = 12.35 + 3.65 − 2 = 14  →  UNPROVEN (14 < 20)
    const pool: ScoredEvent[] = [
      ...Array.from({ length: 10 }, () => ({ value: OUTCOME_VALUES.OK, at: at(0) })),
      { value: OUTCOME_VALUES.OK_CORRECTED, at: at(0) },
      { value: OUTCOME_VALUES.OK_CORRECTED, at: at(0) },
      { value: OUTCOME_VALUES.FAILED, at: at(0) },
      { value: OUTCOME_VALUES.FAILED_SILENT, at: at(0) },
    ];
    const q = scorePool(pool, NOW);
    expect(q.a).toBeCloseTo(12.35, 9);
    expect(q.b).toBeCloseTo(3.65, 9);
    expect(q.mean).toBeCloseTo(0.771875, 6);
    expect(q.sd).toBeCloseTo(0.1017737, 4);
    expect(q.lcb).toBeCloseTo(0.6414417, 4);
    expect(q.n_eff).toBeCloseTo(14, 9);
    expect(q.unproven).toBe(true);
  });

  it("vector 4 — decay: one OK aged exactly one half-life (60 days) weighs 0.5", () => {
    // w = 2^(−60/60) = 0.5  (exact in binary floating point)
    // a = 1 + 0.5·1 = 1.5;  b = 1 + (0.5 − 0.5) = 1
    // mean = 1.5/2.5 = 0.6
    // sd   = sqrt( 1.5·1 / (2.5² · 3.5) ) = sqrt(1.5/21.875)
    //      = sqrt(0.06857143) = 0.2618614
    // lcb  = 0.6 − 1.2816 · 0.2618614 = 0.6 − 0.3356016 = 0.2643984
    // n_eff = 1.5 + 1 − 2 = 0.5
    expect(decayWeight(at(60 * DAY), NOW)).toBe(0.5);
    const q = scorePool([ok(60 * DAY)], NOW);
    expect(q.a).toBeCloseTo(1.5, 9);
    expect(q.b).toBeCloseTo(1, 9);
    expect(q.mean).toBeCloseTo(0.6, 9);
    expect(q.sd).toBeCloseTo(0.2618614, 5);
    expect(q.lcb).toBeCloseTo(0.2643984, 5);
    expect(q.n_eff).toBeCloseTo(0.5, 9);
  });

  it("vector 5 — future-dated events clamp to weight 1: clock skew is not extra credit", () => {
    // An event dated 1 day in the FUTURE: raw age is negative, so w clamps to
    // 1 rather than 2^(1/60) ≈ 1.0116. Identical to vector 2: a=2, b=1.
    const future = at(-1 * DAY); // NOW + 1 day
    expect(decayWeight(future, NOW)).toBe(1);
    const q = scorePool([{ value: 1.0, at: future }], NOW);
    expect(q.a).toBeCloseTo(2, 9);
    expect(q.b).toBeCloseTo(1, 9);
    expect(q.n_eff).toBeCloseTo(1, 9);
  });

  it("vector 6 — the UNPROVEN boundary is strict: n_eff 19 is UNPROVEN, 20 is not (§7.4)", () => {
    // n fresh OK events, all weight 1: a = 1+n, b = 1, n_eff = n exactly.
    // §7.4: UNPROVEN iff n_eff < 20 — so 19 is below, 20 is at-and-over.
    const nineteen = scorePool(Array.from({ length: 19 }, () => ok()), NOW);
    expect(nineteen.n_eff).toBeCloseTo(19, 9);
    expect(nineteen.unproven).toBe(true);

    const twenty = scorePool(Array.from({ length: 20 }, () => ok()), NOW);
    expect(twenty.n_eff).toBeCloseTo(20, 9);
    expect(twenty.unproven).toBe(false);
  });

  it("vector 7 — lcb clamps at zero: three silent failures go negative before the max()", () => {
    // 3×FAILED_SILENT at weight 1 (v = 0):
    // a = 1 + 0 = 1;  b = 1 + 3 = 4
    // mean = 1/5 = 0.2
    // sd   = sqrt( 1·4 / (5² · 6) ) = sqrt(4/150) = sqrt(0.02666667) = 0.1632993
    // mean − 1.2816·sd = 0.2 − 0.2092844 = −0.0092844  →  lcb = max(0, ·) = 0
    const q = scorePool(
      Array.from({ length: 3 }, () => ({ value: 0.0, at: at(0) })),
      NOW,
    );
    expect(q.a).toBe(1);
    expect(q.b).toBeCloseTo(4, 9);
    expect(q.mean).toBeCloseTo(0.2, 9);
    expect(q.lcb).toBe(0);
  });
});
