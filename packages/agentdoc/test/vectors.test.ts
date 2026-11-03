// The conformance cases this package answers to.
//
// test/vectors/agentdoc/ holds the Common Agent Standards' AgentDoc cases
// (common-agent/conformance/agentdoc/ in CommonAgent/common-agent-standards),
// copied byte for byte. Each case names the checks its AgentDoc fails, and
// `check` must fail exactly those, no more and no fewer. Warnings are not
// failures and do not count.
//
// test/vectors/descriptor-floor.json is the standards' Descriptor floor
// fixture: its valid Descriptors carry real descriptor-statement-v1
// signatures, which the assembler must verify, and its invalid ones must not
// be read as verified when their signature is the thing that is wrong.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "../check.js";
import { checkDescriptorSignature } from "../signatures.js";
import { RULE_IDS } from "../types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CASES = join(HERE, "vectors", "agentdoc");

interface Case {
  name: string;
  note: string;
  agentdoc: unknown;
  expect: { ok: boolean; fail: string[] };
}

describe("the standards' AgentDoc cases (Section 9.10)", () => {
  const files = readdirSync(CASES).filter((f) => f.endsWith(".json")).sort();
  it("are all here: four that pass, and a failing case for each static rule", () => {
    expect(files.length).toBeGreaterThanOrEqual(24);
    const cases = files.map((f) => JSON.parse(readFileSync(join(CASES, f), "utf8")) as Case);
    expect(cases.filter((c) => c.expect.ok).length).toBeGreaterThanOrEqual(4);
    const failed = new Set(cases.flatMap((c) => c.expect.fail));
    for (const r of RULE_IDS.filter((r) => r !== "source-digest" && r !== "fact-in-source")) expect(failed.has(r), r).toBe(true);
  });
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(CASES, f), "utf8")) as Case;
    it(`${f}: ${c.expect.ok ? "passes" : `fails ${c.expect.fail.join(", ")}`}`, async () => {
      const report = await check(c.agentdoc);
      const failed = [...new Set(report.findings.filter((x) => x.level === "fail").map((x) => x.rule))].sort();
      expect(failed, JSON.stringify(report.findings, null, 2)).toEqual([...new Set(c.expect.fail)].sort());
      expect(report.ok).toBe(c.expect.ok);
    });
  }
});

describe("descriptor-floor.json: the statement signatures (Section 6.6)", () => {
  const fixture = JSON.parse(readFileSync(join(HERE, "vectors", "descriptor-floor.json"), "utf8"));
  for (const c of fixture.descriptors.valid as Array<{ case: string; descriptor: unknown }>) {
    it(`verifies ${c.case}`, () => expect(checkDescriptorSignature(c.descriptor).state).toBe("verified"));
  }
  it("fails a signature over changed bytes", () => {
    const d = structuredClone(fixture.descriptors.valid[0].descriptor);
    d.does = "Something else.";
    expect(checkDescriptorSignature(d).state).toBe("failed");
  });
  it("fails a signature by a key that is not the subject's", () => {
    const d = structuredClone(fixture.descriptors.valid[0].descriptor);
    d.subject.id = fixture.identities.other;
    expect(checkDescriptorSignature(d).state).toBe("failed");
  });
  it("reads a Descriptor with no statement signature as unsigned, not failed", () => {
    const d = structuredClone(fixture.descriptors.valid[0].descriptor);
    d.signatures = [];
    expect(checkDescriptorSignature(d).state).toBe("unsigned");
  });
});

describe("the JSON Schema", () => {
  it("accepts every passing case", async () => {
    const { schemaErrors } = await import("./helpers.js");
    for (const f of readdirSync(CASES).filter((x) => x.startsWith("pass-"))) {
      const c = JSON.parse(readFileSync(join(CASES, f), "utf8")) as Case;
      expect(schemaErrors(c.agentdoc), f).toEqual([]);
    }
  });
});

describe("the version", () => {
  it("is the one package.json names", async () => {
    const { VERSION } = await import("../version.js");
    expect(VERSION).toBe(JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version);
  });
});
