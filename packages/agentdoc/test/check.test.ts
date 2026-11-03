// The checker, rule by rule: each of the fourteen fails at least once here,
// on an honest assembled AgentDoc changed in one place, and the honest one
// passes. The conformance cases in vectors.test.ts pin the shared reading;
// these show the two checks that fetch the sources, and that each finding
// names its rule and where.
import { describe, expect, it } from "vitest";
import { assemble } from "../assemble.js";
import { check } from "../check.js";
import { RULE_IDS, type AgentDoc, type RuleId } from "../types.js";
import { NOW, ORIGIN, card, fakeFetch, signedDescriptorText } from "./helpers.js";

const CARD_URL = `${ORIGIN}/.well-known/agent-card.json`;
const DESC_URL = `${ORIGIN}/.well-known/agent-descriptor.json`;
const served = { [CARD_URL]: card(), [DESC_URL]: signedDescriptorText() };

async function base(): Promise<AgentDoc> {
  return assemble({ address: ORIGIN, fetch: fakeFetch(served), now: NOW });
}

const fails = async (doc: unknown, opts = {}): Promise<RuleId[]> => {
  const r = await check(doc, opts);
  return [...new Set(r.findings.filter((f) => f.level === "fail").map((f) => f.rule))].sort();
};

const seen = new Set<RuleId>();
async function expectOnly(doc: unknown, rule: RuleId, opts = {}): Promise<void> {
  expect(await fails(doc, opts)).toEqual([rule]);
  seen.add(rule);
}

describe("check", () => {
  it("passes the honest document, with its sources fetched too", async () => {
    const doc = await base();
    expect(await fails(doc)).toEqual([]);
    const r = await check(doc, { fetchSources: true, fetch: fakeFetch(served) });
    expect(r.findings.filter((f) => f.level === "fail")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("sources-exist: a section cites a source the document does not list", async () => {
    const doc = await base();
    doc.sections.refuses!.from = ["descriptor", "terms"];
    await expectOnly(doc, "sources-exist");
    const narrowed = await base();
    narrowed.sections.identity!.name_from = "registry";
    await expectOnly(narrowed, "sources-exist");
  });

  it("section-has-source: a section with no from, or an empty one", async () => {
    const doc = await base();
    delete (doc.sections.refuses as Record<string, unknown>).from;
    await expectOnly(doc, "section-has-source");
    const empty = await base();
    empty.sections.reaches!.from = [];
    await expectOnly(empty, "section-has-source");
  });

  it("source-digest: a source that changed since it was fetched, or cannot be fetched", async () => {
    const doc = await base();
    await expectOnly(doc, "source-digest", { fetchSources: true, fetch: fakeFetch({ ...served, [CARD_URL]: card({ version: "2.0.0" }) }) });
    await expectOnly(doc, "source-digest", { fetchSources: true, fetch: fakeFetch({ [CARD_URL]: card(), [DESC_URL]: { status: 500 } }) });
  });

  it("fact-in-source: a fact no cited source holds", async () => {
    const doc = await base();
    doc.sections.identity!.operator = "Somebody Else Ltd";
    await expectOnly(doc, "fact-in-source", { fetchSources: true, fetch: fakeFetch(served) });
    const r = await check(doc, { fetchSources: true, fetch: fakeFetch(served) });
    expect(r.findings.find((f) => f.rule === "fact-in-source")!.path).toBe("sections.identity.operator");
  });

  it("warns, and does not fail, on a source with no address to fetch", async () => {
    const doc = await assemble({ card: card(), descriptor: signedDescriptorText(), now: NOW });
    const r = await check(doc, { fetchSources: true, fetch: fakeFetch({}) });
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.rule === "source-digest" && f.level === "warn")).toBe(true);
  });

  it("no-summary-grade: a score, badge, tier or trust label anywhere", async () => {
    const doc = await base();
    (doc as Record<string, unknown>).trust_level = "high";
    await expectOnly(doc, "no-summary-grade");
    const deep = await base();
    (deep.sections.sells!.offerings as Array<Record<string, unknown>>)[0]!.quality_score = 4.8;
    await expectOnly(deep, "no-summary-grade");
  });

  it("visibility-supports-claim and decided-by-rule: a ceiling shown as enforced", async () => {
    const doc = await base();
    doc.sections.access!.limits = { requests_per_hour: { most: 60, decided_by: "rule", enforced: true } };
    await expectOnly(doc, "visibility-supports-claim");
    const model = await base();
    model.sections.shape!.visibility = "verifiable";
    model.not_stated = model.not_stated.filter((p) => p !== "shape.visibility");
    model.sections.access!.limits = { requests_per_hour: { most: 60, decided_by: "model", enforced: true } };
    await expectOnly(model, "decided-by-rule");
  });

  it("sells-scope: an offering with no scope", async () => {
    const doc = await base();
    delete (doc.sections.sells!.offerings as Array<Record<string, unknown>>)[0]!.scope;
    await expectOnly(doc, "sells-scope");
  });

  it("open-offering-members and open-ended-no-claim", async () => {
    const doc = await base();
    const o = (doc.sections.sells!.offerings as Array<Record<string, unknown>>)[0]!;
    o.scope = "open-with-focus";
    o.focus = "documents";
    o.workspace = [];
    o.authority = ["sends-messages"];
    o.ceilings = { job_seconds: { most: 60 }, cost_per_job: { most: 1 } };
    await expectOnly(doc, "open-offering-members");
    const ended = await base();
    const e = (ended.sections.sells!.offerings as Array<Record<string, unknown>>)[0]!;
    Object.assign(e, { scope: "open-ended", authority: [], ceilings: { job_seconds: { most: 60 }, cost_per_job: { most: 1 } } });
    await expectOnly(ended, "open-ended-no-claim");
  });

  it("assembled-at and fetched-at", async () => {
    const doc = await base();
    delete doc.assembled_at;
    await expectOnly(doc, "assembled-at");
    const src = await base();
    delete src.sources[0]!.fetched_at;
    await expectOnly(src, "fetched-at");
  });

  it("not-stated-complete and no-default", async () => {
    const doc = await base();
    doc.not_stated = doc.not_stated.filter((p) => p !== "standing");
    await expectOnly(doc, "not-stated-complete");
    const filled = await base();
    filled.sections.handling!.retention_max_days = 0;
    await expectOnly(filled, "no-default");
  });

  it("every rule id has failed at least once above", () => {
    expect([...seen].sort()).toEqual([...RULE_IDS].sort());
  });

  it("refuses to call something that is not an object an AgentDoc", async () => {
    expect((await check("nope")).ok).toBe(false);
  });
});
