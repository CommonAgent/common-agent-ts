import { describe, it, expect } from "vitest";
import { ENROLL_TAG, VALUE_TAG, WITHDRAW_TAG, enrollmentActText, valueJudgmentText } from "../index.js";

// The signed forms the bureau verifies and the adapter signs, both through
// these two functions (§3.2, §6.6).
describe("the signed forms of the agent's own acts", () => {
  it("joins an enrollment or a withdrawal with colons, in the standard's order", () => {
    expect(enrollmentActText(ENROLL_TAG, "UABC", "https://bureau.example", "2026-10-19T12:00:00.000Z"))
      .toBe("fdbk-enroll-v1:UABC:https://bureau.example:2026-10-19T12:00:00.000Z");
    expect(enrollmentActText(WITHDRAW_TAG, "UABC", "https://bureau.example", "2026-10-19T12:00:00.000Z"))
      .toBe("fdbk-withdraw-v1:UABC:https://bureau.example:2026-10-19T12:00:00.000Z");
  });

  it("signs an absent number as an empty position, never as zero", () => {
    const base = { interactionId: "engagement:UC:US:audit", seller: "US", offering: "audit", outcome: "VALUE_OK", currency: "", at: "2026-10-19T12:00:00.000Z" };
    expect(valueJudgmentText({ ...base, amount: null, units: null }))
      .toBe(`${VALUE_TAG}:engagement:UC:US:audit:US:audit:VALUE_OK::::2026-10-19T12:00:00.000Z`);
    expect(valueJudgmentText({ ...base, amount: 250, currency: "XCR", units: 0 }))
      .toBe(`${VALUE_TAG}:engagement:UC:US:audit:US:audit:VALUE_OK:250:XCR:0:2026-10-19T12:00:00.000Z`);
  });
});
