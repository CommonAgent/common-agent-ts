import { describe, it, expect } from "vitest";
import {
  assembleReport,
  assembleCapabilityReport,
  capabilityBlock,
  capabilityState,
  enrollmentFromActs,
  factsBlock,
  poolFromEntries,
  scorePool,
  type LedgerEntry,
} from "../index.js";

let seq = 0;
function row(action: LedgerEntry["action"], at: string, detail: Record<string, unknown> = {}): LedgerEntry {
  seq += 1;
  return { subject: "U".padEnd(56, "A"), seq, at, action, capability: "research", detail: JSON.stringify(detail), prev_hash: "x", entry_hash: "y" };
}

describe("the ledger's pure rules", () => {
  it("lets the highest-ranked evidence win an interaction (§6.3), keeping one event per interaction", () => {
    const pool = poolFromEntries([
      row("fact", "2026-10-01T00:00:00Z", { interaction_id: "i1", outcome: "OK", source: "task" }),
      row("attested", "2026-10-02T00:00:00Z", { interaction_id: "i1", outcome: "FAILED", source: "review", evaluator: "buyer" }),
      row("fact", "2026-10-03T00:00:00Z", { interaction_id: "i2", outcome: "DECLINED", source: "task" }),
      row("fact", "2026-10-04T00:00:00Z", { interaction_id: "i3", outcome: "NOT_FURNISHED", source: "task" }),
    ]);
    // The review's verdict scores, at the age of the interaction it judged (§7.2).
    expect(pool.events).toEqual([{ value: 0.15, at: "2026-10-01T00:00:00Z" }]);
    expect(pool.scoredInteractions).toBe(1);
    expect(pool.declined).toBe(1);
    expect(pool.notFurnished).toBe(1);
    expect([...pool.attesterAnchors]).toEqual([["buyer", 1]]);
  });

  it("marks a value judgment so it enters the pool at the reduced weight (§7.6)", () => {
    const pool = poolFromEntries([row("attested", "2026-10-05T00:00:00Z", { interaction_id: "v1", outcome: "VALUE_OK", source: "value", evaluator: "b" })]);
    expect(pool.events).toEqual([{ value: 1, at: "2026-10-05T00:00:00Z", value_judgment: true }]);
    expect(pool.valueJudgments).toBe(1);
  });

  it("reads enrollment from the acts, with the withdrawal's cooling-off (§3.3)", () => {
    const enrolled = row("enrolled", "2026-09-01T00:00:00Z");
    const withdrew = row("withdrew", "2026-09-10T00:00:00Z");
    expect(enrollmentFromActs([], Date.parse("2026-10-01T00:00:00Z"))).toEqual({ state: "UNENROLLED" });
    expect(enrollmentFromActs([enrolled, withdrew], Date.parse("2026-09-20T00:00:00Z")).state).toBe("ENROLLED");
    expect(enrollmentFromActs([enrolled, withdrew], Date.parse("2026-10-10T00:00:00Z"))).toEqual({
      state: "WITHDRAWN",
      enrolled_at: "2026-09-01T00:00:00Z",
      withdrew_at: "2026-09-10T00:00:00Z",
      withdrawal_effective_at: "2026-10-10T00:00:00.000Z",
    });
  });
});

describe("the report as data (§8)", () => {
  const nowMs = Date.parse("2026-10-19T00:00:00Z");
  const info = { state: "ENROLLED" as const, enrolled_at: "2026-09-01T00:00:00Z" };

  it("serves a sample size and no score while a capability is UNPROVEN (§7.4)", () => {
    const pool = poolFromEntries([row("fact", "2026-10-19T00:00:00Z", { interaction_id: "a", outcome: "OK", source: "task" })]);
    const q = scorePool(pool.events, nowMs);
    expect(capabilityState(info, q.n_eff)).toBe("UNPROVEN");
    const block = capabilityBlock("research", info, pool, q);
    expect(block.quality).toEqual({ n_eff: 1 });
    expect(block.evidence.scored_interactions).toBe(1);
  });

  it("shows an unenrolled subject only that interactions were observed (§8.3)", () => {
    const pool = poolFromEntries([row("fact", "2026-10-18T00:00:00Z", { interaction_id: "a", outcome: "OK", source: "task" })]);
    expect(factsBlock("research", pool)).toEqual({ capability: "research", enrollment: "UNENROLLED", facts: { interactions_recorded: 1 } });
  });

  it("assembles the report with the formula's published constants and an hour's validity", () => {
    const report = assembleReport({ subject: "S", info, capabilities: [], bureau: "https://bureau.example", nowMs });
    expect(report).toEqual({
      subject: "S",
      enrollment: "ENROLLED",
      enrolled_at: "2026-09-01T00:00:00Z",
      capabilities: [],
      half_life_days: 60,
      unproven_threshold: 20,
      k_value: 0.5,
      formula_version: "fdbk-score-1",
      bureau: "https://bureau.example",
      issued_at: "2026-10-19T00:00:00.000Z",
      expires_at: "2026-10-19T01:00:00.000Z",
    });
  });
});

describe("the report in the standard's shape (§8.1)", () => {
  const nowMs = Date.parse("2026-10-19T00:00:00Z");
  it("names the capability at the top, with the mandatory context of §8.2 and no portfolio prior", () => {
    const info = { state: "ENROLLED" as const, enrolled_at: "2026-09-01T00:00:00Z" };
    const pool = poolFromEntries([row("fact", "2026-10-19T00:00:00Z", { interaction_id: "a", outcome: "OK", source: "task" })]);
    const r = assembleCapabilityReport({ subject: "S", capability: "research", info, pool, score: scorePool(pool.events, nowMs), bureau: "https://b.example", nowMs });
    expect(r).toMatchObject({ subject: "S", capability: "research", enrollment: "UNPROVEN", quality: { n_eff: 1 }, evidence: { half_life_days: 60, attester_anchors: 0, top_anchor_share: 0, portfolio_prior: false } });
  });

  it("states facts only about an unenrolled subject (§8.3)", () => {
    const pool = poolFromEntries([]);
    const r = assembleCapabilityReport({ subject: "S", capability: "research", info: { state: "UNENROLLED" }, pool, score: scorePool([], nowMs), bureau: "https://b.example", nowMs });
    expect(r).toMatchObject({ enrollment: "UNENROLLED", facts: { interactions_recorded: 0 } });
    expect(r).not.toHaveProperty("quality");
    expect(r).not.toHaveProperty("candor");
  });
});
