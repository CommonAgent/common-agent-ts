// Agent SoW §5.16, the Agent NDA the engagement runs under, asserted against
// conformance/sow-nda.json: the member's shape, the parties test and the
// disclosure test. Collected like the SDK's suites (collect.ts), so
// vectors.test.ts runs each under the section of the file it reads.
import { expect } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import { collector } from "./collect.js";
import { ndaDisclosureFits, ndaPartiesMatch, validateSowNda, type NdaPermits } from "../index.js";

const { describe, it, suites } = collector();
export { suites };

const fixture = loadPinnedVectors("sow/conformance/sow-nda.json").data as unknown as {
  reference: { valid: Array<{ nda?: unknown }>; invalid: Array<{ case: string; nda: unknown; why: string }> };
  parties: {
    cases: Array<{ name: string; engagement: { provider: string; client: string }; nda: { discloser: string | null; recipient: string | null }; expected: boolean }>;
  };
  disclosure: {
    cases: Array<{ name: string; nda_permits: NdaPermits; confidentiality: Record<string, unknown>; expected: { ok: boolean; test?: string; entry?: number } }>;
  };
};

describe("§5.16 the reference: id, version, a required digest, and the grade evidence", () => {
  it("accepts every valid member, and a document without one", () => {
    for (const row of fixture.reference.valid) expect(() => validateSowNda(row.nda)).not.toThrow();
  });
  for (const row of fixture.reference.invalid) {
    it(`${row.case} is refused: ${row.why}`, () => {
      expect(() => validateSowNda(row.nda)).toThrow(/§5\.16/);
    });
  }
});

describe("§5.16 the parties test: the NDA's seats hold the engagement's two agent keys", () => {
  for (const c of fixture.parties.cases) {
    it(c.name, () => {
      expect(ndaPartiesMatch(c.engagement, c.nda)).toBe(c.expected);
    });
  }
});

describe("§5.16 the disclosure test: the engagement's §5.11 declarations fit inside the NDA's terms", () => {
  for (const c of fixture.disclosure.cases) {
    it(c.name, () => {
      const got = ndaDisclosureFits(c.nda_permits, c.confidentiality);
      expect(got).toEqual(c.expected);
    });
  }
});
