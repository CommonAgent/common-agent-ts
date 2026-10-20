// The NDA record (§4.9): upheld breaches listed with their dates, open
// claims as counts, closed claims in the states they ended in, the claims a
// party filed, and nothing that names the agreement or the claimant.
import { describe, expect, it } from "vitest";
import { assembleCapabilityReport, assembleReport, ndaRecord, type ClaimView } from "../index.js";

const view = (over: Partial<ClaimView> = {}): ClaimView => ({
  state: "open",
  filedAt: "2030-01-01T00:00:00Z",
  answers: 0,
  inRecord: true,
  categories: ["solicitation"],
  direction: "one_way",
  claimantAnchorHash: "sha256:aaaa",
  agreement: "sha256:agreement-one",
  respondent: "U-respondent-one",
  ...over,
});

describe("the NDA record", () => {
  it("is empty, with every count at zero, when no claim was accepted", () => {
    expect(ndaRecord([])).toEqual({
      record_days: 1825,
      upheld: [],
      open: { count: 0, claimants: 0, earliest: null, answered: 0 },
      closed: { dismissed: 0, withdrawn: 0, set_aside: 0, lapsed: 0 },
    });
  });

  it("lists upheld breaches with their dates, one entry per agreement with the latest", () => {
    const r = ndaRecord([
      view({ state: "upheld", basis: "acknowledged", resolvedAt: "2030-03-01T00:00:00Z", answers: 1, lastAnsweredAt: "2030-02-01T00:00:00Z" }),
      view({ state: "upheld", basis: "court", resolvedAt: "2030-05-01T00:00:00Z", categories: ["inputs"], claimantAnchorHash: "sha256:bbbb" }),
      view({ state: "upheld", basis: "arbiter", resolvedAt: "2030-04-01T00:00:00Z", agreement: "sha256:agreement-two" }),
    ]);
    expect(r.upheld).toEqual([
      { upheld_at: "2030-05-01T00:00:00Z", basis: "court", categories: ["inputs", "solicitation"], direction: "one_way", claimant_anchor_hash: "sha256:bbbb", answered: true, answered_at: "2030-02-01T00:00:00Z" },
      { upheld_at: "2030-04-01T00:00:00Z", basis: "arbiter", categories: ["solicitation"], direction: "one_way", claimant_anchor_hash: "sha256:aaaa", answered: false },
    ]);
  });

  it("groups upheld claims by agreement and respondent, so an organization's members keep their own entries", () => {
    const r = ndaRecord([
      view({ state: "upheld", basis: "court", resolvedAt: "2030-03-01T00:00:00Z" }),
      view({ state: "upheld", basis: "court", resolvedAt: "2030-04-01T00:00:00Z", respondent: "U-respondent-two" }),
      view({ state: "upheld", basis: "court", resolvedAt: "2030-05-01T00:00:00Z" }),
    ]);
    expect(r.upheld.map((u) => u.upheld_at)).toEqual(["2030-05-01T00:00:00Z", "2030-04-01T00:00:00Z"]);
  });

  it("shows open claims only as counts, claimants sharing an anchor or an operator counted once", () => {
    const r = ndaRecord([
      view({ filedAt: "2030-02-01T00:00:00Z", claimantAnchorHash: "sha256:a1", claimantOperatorHash: "sha256:op1" }),
      view({ filedAt: "2030-01-15T00:00:00Z", claimantAnchorHash: "sha256:a2", claimantOperatorHash: "sha256:op1", answers: 2 }),
      view({ filedAt: "2030-03-01T00:00:00Z", claimantAnchorHash: "sha256:a2" }),
      view({ filedAt: "2030-03-02T00:00:00Z", claimantAnchorHash: "sha256:a3" }),
    ]);
    expect(r.open).toEqual({ count: 4, claimants: 2, earliest: "2030-01-15T00:00:00Z", answered: 1 });
    expect(r.upheld).toEqual([]);
  });

  it("counts closed claims in their own states, and leaves out claims past the record period", () => {
    const r = ndaRecord([
      view({ state: "dismissed" }), view({ state: "withdrawn" }), view({ state: "set_aside" }), view({ state: "lapsed" }), view({ state: "lapsed" }),
      view({ state: "upheld", basis: "court", resolvedAt: "2020-01-01T00:00:00Z", inRecord: false }),
      view({ state: "open", inRecord: false }),
    ]);
    expect(r.closed).toEqual({ dismissed: 1, withdrawn: 1, set_aside: 1, lapsed: 2 });
    expect(r.upheld).toEqual([]);
    expect(r.open.count).toBe(0);
  });

  it("gives a claimant a record of what it filed, only when asked for a reader rule 6 serves it to", () => {
    const filed = [view({ state: "dismissed" }), view({ state: "dismissed" }), view({ state: "withdrawn" }), view({ state: "upheld" }), view({ state: "open", inRecord: false })];
    expect(ndaRecord([], { filed }).filed).toEqual({ open: 0, upheld: 1, dismissed: 2, withdrawn: 1, set_aside: 0, lapsed: 0 });
    expect(ndaRecord([])).not.toHaveProperty("filed");
  });

  it("never names the agreement", () => {
    const r = ndaRecord([view({ state: "upheld", basis: "court", resolvedAt: "2030-01-02T00:00:00Z" }), view()], { filed: [view()] });
    expect(JSON.stringify(r)).not.toContain("agreement-one");
  });

  it("rides in a report beside the scores, for a subject that never enrolled", () => {
    const nda = ndaRecord([view()]);
    const report = assembleReport({ subject: "U".padEnd(56, "A"), info: { state: "UNENROLLED" } as never, capabilities: [], bureau: "https://bureau.example", nowMs: Date.parse("2030-06-01T00:00:00Z"), nda });
    expect(report.enrollment).toBe("UNENROLLED");
    expect(report.nda).toEqual(nda);
  });

  it("rides in each capability's report too, enrolled or not", () => {
    const nda = ndaRecord([view({ state: "upheld", basis: "court", resolvedAt: "2030-02-01T00:00:00Z" })]);
    const pool = { events: [], declined: 0, scoredInteractions: 0, silentFailures: 0, attesterAnchors: new Map(), valueJudgments: 0 } as never;
    const r = assembleCapabilityReport({ subject: "U".padEnd(56, "A"), capability: "research", info: { state: "UNENROLLED" } as never, pool, score: {} as never, bureau: "https://bureau.example", nowMs: Date.parse("2030-06-01T00:00:00Z"), nda });
    expect(r.enrollment).toBe("UNENROLLED");
    expect(r.nda).toEqual(nda);
  });
});
