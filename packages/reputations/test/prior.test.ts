import { describe, it, expect } from "vitest";
import { MAX_PRIOR_WEIGHT, UNIFORM_PRIOR, checkPrior, portfolioPrior, scorePool, scoreWeighted } from "../index.js";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const ok = (n: number) => Array.from({ length: n }, () => ({ value: 1, at: "2026-10-18T12:00:00.000Z" }));

describe("priors from the portfolio (§7.5)", () => {
  it("moves the mean and the bound, never n_eff, so a head start is not an inheritance", () => {
    const plain = scorePool(ok(6), NOW);
    const warm = scorePool(ok(6), NOW, { a0: 9.5, b0: 2.5 });
    expect(warm.n_eff).toBe(plain.n_eff);
    expect(warm.n_eff).toBe(6);
    expect(warm.unproven).toBe(true);
    expect(warm.lcb).toBeGreaterThan(plain.lcb);
  });

  it("is the uniform prior unless one is given, with the arithmetic it always had", () => {
    expect(scorePool(ok(3), NOW)).toEqual(scorePool(ok(3), NOW, UNIFORM_PRIOR));
    expect(scoreWeighted([{ v: 1, w: 1 }, { v: 0, w: 0.5 }])).toMatchObject({ a: 2, b: 1.5, n_eff: 1.5 });
  });

  it("refuses a prior heavier than ten effective events, or one that is not a prior", () => {
    expect(() => checkPrior({ a0: 9.5, b0: 2.5 })).not.toThrow();
    expect(() => checkPrior({ a0: 10, b0: 3 })).toThrow(/from 0 to 10/);
    expect(() => checkPrior({ a0: 0, b0: 1 })).toThrow(/positive/);
    expect(() => checkPrior({ a0: Number.NaN, b0: 1 })).toThrow(/positive/);
    expect(() => scorePool(ok(1), NOW, { a0: 20, b0: 1 })).toThrow(/from 0 to 10/);
  });

  it("derives a prior from the anchor's other RATED agents' means, at most ten events heavy", () => {
    expect(portfolioPrior([])).toEqual(UNIFORM_PRIOR);
    const two = portfolioPrior([0.8, 0.9]);
    expect(two.a0).toBeCloseTo(9.5, 12);
    expect(two.b0).toBeCloseTo(2.5, 12);
    const p = portfolioPrior([0.85], 50);
    expect(p.a0 + p.b0 - 2).toBeCloseTo(MAX_PRIOR_WEIGHT);
    expect(portfolioPrior([0.5], 4)).toEqual({ a0: 3, b0: 3 });
  });
});
