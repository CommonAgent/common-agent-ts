// Agent SoW 0.26.0-draft, the amendment review window (§5.8), asserted
// against conformance/sow-review-window.json. The file's `cases` are the
// vectors (windowCase); the suites below read its other members: the default
// window and the validation case.
import { expect } from "vitest";
import { loadPinnedVectors, type VectorCase } from "../../vectors/index.js";
import { collector } from "./collect.js";
import { DEFAULT_REVIEW_WINDOW_DAYS, amendmentOutcome, validateSowDocument, type SowDocument } from "../index.js";

const { describe, it, suites } = collector();
export { suites };

const fixture = loadPinnedVectors("sow/conformance/sow-review-window.json").data as unknown as {
  default_review_window_days: number;
  validation: { invalid: Array<{ case: string; change_control: Record<string, unknown>; proposed: boolean }> };
};
const pricing = loadPinnedVectors("sow/conformance/sow-pricing.json").data as Record<string, any>;

/** One `cases` vector: the lapse instant and the outcome. */
export function windowCase(c: VectorCase): void {
  const v = c.value as {
    change_control: { proposed_at: string; review_window_days?: number };
    received_by_counterparty: string;
    approval_received_by_proposer: string | null;
    proposer_accepts_late?: boolean;
    expected: { lapses_at: string; outcome: string };
  };
  expect(amendmentOutcome(v)).toEqual(v.expected);
}

describe("§5.8 the window is 7 days where the clause states none", () => {
  it("matches the file's default", () => {
    expect(DEFAULT_REVIEW_WINDOW_DAYS).toBe(fixture.default_review_window_days);
  });
});

describe("§5.8 a proposed replacement carries proposed_at", () => {
  for (const row of fixture.validation.invalid) {
    it(`${row.case} is refused`, () => {
      const doc = { ...structuredClone(pricing.signing.document), version: 2, change_control: row.change_control } as SowDocument;
      expect(() => validateSowDocument(doc, { proposal: row.proposed })).toThrow(/§5\.8/);
      expect(() => validateSowDocument({ ...doc, change_control: { ...row.change_control, proposed_at: "2026-09-14T10:02:00Z" } }, { proposal: true })).not.toThrow();
    });
  }
});
