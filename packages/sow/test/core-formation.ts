// Agent SoW 0.28.0-draft, forming an amended version in three signed
// messages (§5.8), asserted against conformance/sow-amendment-formation.json.
// The file's `cases` are the vectors (formationCase); the suite below reads
// the file's own parameters.
import { expect } from "vitest";
import { loadPinnedVectors, type VectorCase } from "../../vectors/index.js";
import { collector } from "./collect.js";
import {
  acknowledgementResendDue,
  counterpartyVersionAt,
  formationDeadline,
  proposerFormationAt,
  requestAnswerAt,
  requestVersion,
  resendingVoid,
  voidResendDue,
  type SowFormationTimeline,
} from "../index.js";

const { describe, it, suites } = collector();
export { suites };

const fixture = loadPinnedVectors("sow/conformance/sow-amendment-formation.json").data as unknown as {
  current_version: number;
  new_version: number;
  governing_window_days: number;
  cases: Array<SowFormationTimeline & { case: string }>;
};
const versions = { current: fixture.current_version, next: fixture.new_version, windowDays: fixture.governing_window_days };

type Request = { name: string; names_version: number; admitted_at?: string; sent_at?: string; answered_with_void_at?: string };

/**
 * One `cases` vector: the deadline, each side's version at each instant,
 * whether the proposer is re-sending the void (0.28.0-draft), and how each
 * request is answered: priced under a version, or answered with the void.
 */
export function formationCase(c: VectorCase): void {
  const v = c.value as unknown as Omit<SowFormationTimeline, "requests"> & {
    requests?: Request[];
    expected: {
      deadline: string | null;
      at: Array<{ t: string; proposer: { state: string; own_acts: number; resending_void?: boolean }; counterparty: number }>;
      requests?: Array<{ name: string; priced_under?: number; admitted?: boolean; answered_with?: string }>;
    };
  };
  expect(formationDeadline(v, versions.windowDays)).toBe(v.expected.deadline);
  for (const step of v.expected.at) {
    const { resending_void, ...proposer } = step.proposer;
    expect(proposerFormationAt(v, step.t, versions), `the proposer at ${step.t}`).toEqual(proposer);
    if (resending_void !== undefined) expect(resendingVoid(v, step.t, versions), `re-sending the void at ${step.t}`).toBe(resending_void);
    expect(counterpartyVersionAt(v, step.t, versions), `the counterparty at ${step.t}`).toBe(step.counterparty);
  }
  for (const want of v.expected.requests ?? []) {
    const request = v.requests!.find((r) => r.name === want.name)!;
    const received_at = (request.admitted_at ?? request.sent_at)!;
    const answer = requestAnswerAt(v, { received_at, names_version: request.names_version }, versions);
    if (want.priced_under !== undefined) {
      expect(requestVersion(v, { admitted_at: received_at, names_version: request.names_version }, versions), want.name).toBe(want.priced_under);
      expect(answer, want.name).toEqual({ admitted: true, priced_under: want.priced_under });
    } else {
      expect(answer, want.name).toEqual({ admitted: want.admitted, answered_with: want.answered_with });
    }
  }
}

describe("§5.8 the proposer re-sends its acknowledgement at least daily until a receipt or the deadline", () => {
  it("owes a copy a day after the last one, none once a receipt is in, and none past the deadline", () => {
    const lost = fixture.cases.find((c) => c.case === "first_acknowledgement_lost")!;
    const first = { ...lost, acknowledgements: lost.acknowledgements.slice(0, 1), receipts: [] };
    expect(acknowledgementResendDue(first, "2026-09-16T23:00:00Z", fixture.governing_window_days)).toBe(false);
    expect(acknowledgementResendDue(first, "2026-09-17T12:00:05Z", fixture.governing_window_days)).toBe(true);
    expect(acknowledgementResendDue(lost, "2026-09-18T12:00:08Z", fixture.governing_window_days)).toBe(false);
    expect(acknowledgementResendDue(first, "2026-09-23T12:00:00Z", fixture.governing_window_days)).toBe(false);
  });
});

describe("§5.8 the proposer re-sends its void at least daily until it holds a receipt of it (0.28.0-draft)", () => {
  it("owes a copy a day after the last one went, counting a copy that answered a request, and none once a receipt is in", () => {
    const resent = fixture.cases.find((c) => c.case === "lost_void_recovered_by_resend")!;
    const firstOnly = { ...resent, voids: resent.voids!.slice(0, 1), void_receipts: [] };
    expect(voidResendDue(firstOnly, "2026-09-24T11:59:59Z", versions)).toBe(false);
    expect(voidResendDue(firstOnly, "2026-09-24T12:00:00Z", versions)).toBe(true);
    expect(voidResendDue(resent, "2026-09-24T12:00:03Z", versions)).toBe(false);
    const answered = fixture.cases.find((c) => c.case === "lost_void_recovered_by_answering_a_request")!;
    const noReceipt = { ...answered, void_receipts: [] };
    // The answer at 15:00:01 is a copy: the next one is due a day after it.
    expect(voidResendDue(noReceipt, "2026-09-24T12:00:00Z", versions)).toBe(false);
    expect(voidResendDue(noReceipt, "2026-09-24T15:00:01Z", versions)).toBe(true);
  });
});
