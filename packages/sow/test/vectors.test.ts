/**
 * The Agent SoW conformance files, run by this core. A file's cases are what
 * packages/vectors finds in it: the items of its top-level lists where it
 * has them (sow-signatures.json and the others with a `cases` list), and otherwise one
 * case per top-level member. A member-shaped case runs the suites that read
 * it (sdk-*.ts, carried over from the TypeScript SDK, and core-*.ts for what
 * the core adds); a list item runs its file's case check. A suite that reads
 * no case of its file runs as an ordinary test, and every suite must read at
 * least one member its file has, so none can stop running unseen.
 */
import { describe, expect, it } from "vitest";
import { pinnedVectorFiles, vectorCases, type VectorCase } from "../../vectors/index.js";
import { describeVectors, type CaseCheck } from "../../vectors/vitest.js";
import { runSection, type CollectedSuite } from "./collect.js";
import { suites as pricing } from "./sdk-pricing.js";
import { suites as disputes } from "./sdk-disputes.js";
import { suites as dataUse } from "./sdk-data-use.js";
import { suites as reporting } from "./sdk-reporting.js";
import { suites as subcontracting } from "./sdk-subcontracting.js";
import { suites as terms } from "./sdk-terms.js";
import { suites as nda } from "./core-nda.js";
import { buyerReferenceSuites, providerContactSuites } from "./core-contact.js";
import { suites as signatures, signatureCase } from "./core-signatures.js";
import { suites as reviewWindow, windowCase } from "./core-review-window.js";
import { suites as formation, formationCase } from "./core-formation.js";
import { suites as formationMessages, messageCase } from "./core-formation-messages.js";

const byFile: Record<string, CollectedSuite[]> = {
  "sow-pricing.json": pricing,
  "sow-disputes.json": disputes,
  "sow-data-use.json": dataUse,
  "sow-reporting.json": reporting,
  "sow-subcontracting.json": subcontracting,
  "sow-terms.json": terms,
  "sow-nda.json": nda,
  "sow-buyer-reference.json": buyerReferenceSuites,
  "sow-provider-contact.json": providerContactSuites,
  "sow-signatures.json": signatures,
  "sow-review-window.json": reviewWindow,
  "sow-amendment-formation.json": formation,
  "sow-formation-messages.json": formationMessages,
};

/** Files whose cases are list items, each checked on its own. */
const caseChecks: Record<string, (c: VectorCase) => void> = {
  "sow-signatures.json": signatureCase,
  "sow-review-window.json": windowCase,
  "sow-amendment-formation.json": formationCase,
  "sow-formation-messages.json": messageCase,
};

const pinned = new Map(pinnedVectorFiles("sow").map((f) => [f.path.split("/").pop()!, f]));

describeVectors("sow", {
  checks: Object.fromEntries(
    Object.entries(byFile).map(([file, suites]) => {
      const checks: Record<string, CaseCheck> = { document: (c) => runSection(suites, c.name) };
      if (caseChecks[file]) checks.cases = (c) => caseChecks[file]!(c);
      return [file, checks];
    }),
  ),
  known: {
    "sow-pricing.json": {
      // The file's own list of what it leaves out; there is nothing in it to run.
      not_covered: "the file's list of what it does not pin",
    },
  },
});

// A suite that reads no case of its file runs here, as an ordinary test.
for (const [file, suites] of Object.entries(byFile)) {
  const f = pinned.get(file);
  const caseNames = new Set(f ? vectorCases(f).map((c) => c.name) : []);
  const loose = suites.filter((s) => ![...s.sections].some((x) => caseNames.has(x)));
  if (!loose.length) continue;
  describe(`${file}: suites that read no case of the file`, () => {
    for (const s of loose) for (const t of s.tests) it(t.name, () => t.fn() as Promise<void> | void);
  });
}

describe("every collected suite runs", () => {
  it("every pinned SoW file has its suites, and every suite file is pinned", () => {
    expect([...pinned.keys()].sort()).toEqual(Object.keys(byFile).sort());
  });
  for (const [file, suites] of Object.entries(byFile)) {
    it(`each suite for ${file} reads at least one member the file has, so none can stop running unseen`, () => {
      const f = pinned.get(file);
      expect(f, `${file} is not pinned`).toBeDefined();
      const members = new Set([...Object.keys(f!.data), ...vectorCases(f!).map((c) => c.name)]);
      const unrun = suites.filter((s) => s.sections.size > 0 && ![...s.sections].some((x) => members.has(x))).map((s) => s.title);
      expect(unrun).toEqual([]);
      expect(suites.reduce((n, s) => n + s.tests.length, 0)).toBeGreaterThan(0);
    });
  }
});
