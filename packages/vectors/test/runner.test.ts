import { describe, it, expect } from "vitest";
import { loadPinnedVectors, pinnedVectorFiles, vectorCases } from "../index.js";

describe("the conformance-file runner", () => {
  it("finds every file pinned for each contracting standard", () => {
    const names = (s: string) => pinnedVectorFiles(s).map((f) => f.path.split("/").pop()).sort();
    expect(names("sow")).toEqual([
      "sow-acts.json",
      "sow-amendment-formation.json",
      "sow-buyer-reference.json",
      "sow-data-use.json",
      "sow-disputes.json",
      "sow-formation-messages.json",
      "sow-nda.json",
      "sow-pricing.json",
      "sow-provider-contact.json",
      "sow-reporting.json",
      "sow-review-window.json",
      "sow-signatures.json",
      "sow-subcontracting.json",
      "sow-terms.json",
    ]);
    expect(names("nda")).toEqual(["nda-grading.json", "nda-lifecycle.json", "nda-offer.json"]);
    expect(names("reputations")).toEqual(["casefolding-15.1.0.json", "fdbk-heads-v1.json", "fdbk-nda-claim-v1.json", "fdbk-nda-record-v1.json", "fdbk-report-v1.json", "fdbk-score-1.json"]);
    expect(names("rfp")).toEqual(["rfp-posting.json", "rfp-sealed-body.json"]);
    expect(names("mandate")).toEqual(["mandate-checks.json", "mandate-documents.json", "mandate-ids.json", "mandate-proxy.json", "mandate-scope.json"]);
  });

  it("lists every case of every file, whatever the file calls its lists", () => {
    for (const s of ["sow", "nda", "reputations", "rfp"]) {
      for (const f of pinnedVectorFiles(s)) expect(vectorCases(f).length, f.path).toBeGreaterThan(0);
    }
    const score = loadPinnedVectors("reputations/conformance/fdbk-score-1.json");
    expect(score.tag).toBe("reputations-v0.11.0-draft");
    const cases = vectorCases(score);
    expect(cases).toHaveLength(13);
    expect(cases[0]).toMatchObject({ group: "vectors", name: "empty-record" });
  });

  it("refuses a file that is not pinned", () => {
    expect(() => loadPinnedVectors("rfp/conformance/nothing.json")).toThrow(/is not pinned/);
  });
});
