// The assembler, against a fake network serving a realistic A2A agent. What
// is worth testing is the honesty of the result:
//
//   - card only: every card member restated and cited, and everything the
//     card does not say named in not_stated, never filled with a default;
//   - with a signed Descriptor: the signature verified, the Descriptor cited
//     at the digest of its exact bytes and preferred over the card, and a
//     card that disagrees reported rather than merged;
//   - a Descriptor whose signature fails is listed and not used;
//   - signed terms, evaluation records and attestations used only as far as
//     their signatures and their subject allow;
//   - a package AgentDoc fixed to its package, with no time in it;
//   - every document passes check and validates against the JSON Schema.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "@common-agent/crypto";
import { AssembleError, assemble, assembleWithNotes } from "../assemble.js";
import { check } from "../check.js";
import { render } from "../render.js";
import type { AgentDoc } from "../types.js";
import { HERE, NOW, ORIGIN, SUBJECT_KEY, attestation, card, draftDescriptor, evalRecord, fakeFetch, schemaErrors, signedDescriptorText, signedTerms, termsExtension } from "./helpers.js";

const CARD_URL = `${ORIGIN}/.well-known/agent-card.json`;
const DESC_URL = `${ORIGIN}/.well-known/agent-descriptor.json`;

async function honest(doc: AgentDoc): Promise<void> {
  const report = await check(doc);
  expect(report.findings.filter((f) => f.level === "fail"), JSON.stringify(report.findings, null, 2)).toEqual([]);
  expect(report.ok).toBe(true);
  expect(schemaErrors(doc)).toEqual([]);
  const text = JSON.stringify(doc) + render(doc);
  expect(text).not.toMatch(/agentmesh/i);
}

describe("card only", () => {
  it("restates the card, cites it, and names everything it does not say", async () => {
    const f = fakeFetch({ [CARD_URL]: card() });
    const doc = await assemble({ address: ORIGIN, fetch: f, now: NOW });
    expect(f.calls).toEqual([CARD_URL, DESC_URL]);
    expect(doc.subject).toEqual({ id: `${ORIGIN}/a2a`, name: "Recipe Helper" });
    expect(doc.assembled_at).toBe("2026-11-03T12:00:00Z");
    expect(doc.sources).toHaveLength(1);
    expect(doc.sources[0]).toMatchObject({ id: "card", kind: "a2a-card", url: CARD_URL, fetched_at: "2026-11-03T12:00:00Z", signature: "unsigned" });
    expect(doc.sources[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.sections.identity).toEqual({
      from: ["card"],
      name: "Recipe Helper",
      description: "Suggests recipes from the ingredients you have.",
      operator: "Example Kitchen",
      url: "https://kitchen.example",
      version: "1.2.0",
      documentation: `${ORIGIN}/docs`,
    });
    expect(doc.sections.access).toMatchObject({ from: ["card"], address: `${ORIGIN}/a2a`, protocol: "a2a", transport: "JSONRPC", protocol_version: "0.3.0" });
    expect(doc.sections.access!.schemes).toEqual([{ id: "bearer", type: "http", scheme: "bearer", bearer_format: "JWT", description: "A token from the kitchen's sign-in page." }]);
    const offerings = doc.sections.sells!.offerings as Array<Record<string, unknown>>;
    expect(offerings.map((o) => [o.id, o.scope, o.state])).toEqual([["suggest-recipes", "task-specific", "declared"], ["shopping-list", "task-specific", "declared"]]);
    expect(offerings[1]!.output_modes).toEqual(["application/json"]);
    // Silence, printed: nothing here is filled with a flattering default.
    for (const p of ["shape", "role", "asked", "refuses", "reaches", "leaves", "configs", "handling", "standing", "identity.acts_for", "access.admission", "sells.offerings.inputs", "sells.offerings.outputs", "sells.offerings.price", "sells.samples"]) {
      expect(doc.not_stated, p).toContain(p);
    }
    expect(doc.not_stated).not.toContain("access.schemes");
    expect(doc.sections.shape).toBeUndefined();
    await honest(doc);
  });

  it("falls back to /.well-known/agent.json", async () => {
    const f = fakeFetch({ [`${ORIGIN}/.well-known/agent.json`]: card() });
    const doc = await assemble({ address: "recipes.example", fetch: f, now: NOW });
    expect(doc.sources[0]!.url).toBe(`${ORIGIN}/.well-known/agent.json`);
    await honest(doc);
  });

  it("reads a card the agent serves under a path, before the origin", async () => {
    const f = fakeFetch({ [`${ORIGIN}/agents/chef/.well-known/agent-card.json`]: card() });
    const doc = await assemble({ address: `${ORIGIN}/agents/chef/`, fetch: f, now: NOW });
    expect(f.calls[0]).toBe(`${ORIGIN}/agents/chef/.well-known/agent-card.json`);
    expect(doc.sources[0]!.url).toBe(`${ORIGIN}/agents/chef/.well-known/agent-card.json`);
  });

  it("names the schemes when the card says nothing about them, and prints an explicit empty list as nothing required", async () => {
    const silent = card();
    delete silent.securitySchemes;
    delete silent.security;
    const a = await assemble({ card: silent, now: NOW });
    expect(a.sections.access!.schemes).toBeUndefined();
    expect(a.not_stated).toContain("access.schemes");
    await honest(a);
    const open = card({ security: [] });
    delete open.securitySchemes;
    const b = await assemble({ card: open, now: NOW });
    expect(b.sections.access!.schemes).toEqual([]);
    expect(b.not_stated).not.toContain("access.schemes");
  });

  it("cites a card handed in as text by the digest of its bytes", async () => {
    const text = JSON.stringify(card(), null, 2);
    const doc = await assemble({ card: text, now: NOW });
    expect(doc.sources[0]!.digest).toBe(sha256Digest(text));
    expect(doc.sources[0]!.url).toBeUndefined();
  });

  it("marks a card that carries signatures as not checked, never as verified", async () => {
    const doc = await assemble({ card: card({ signatures: [{ protected: "e30", signature: "AAAA" }] }), now: NOW });
    expect(doc.sources[0]!.signature).toBe("not_checked");
  });

  it("refuses plainly when the address serves nothing", async () => {
    await expect(assemble({ address: ORIGIN, fetch: fakeFetch({}), now: NOW })).rejects.toThrow(AssembleError);
    await expect(assemble({ address: ORIGIN, fetch: fakeFetch({}), now: NOW })).rejects.toThrow(/serves no A2A Agent Card/);
  });
});

describe("card and signed Descriptor", () => {
  it("verifies the Descriptor, cites it at the digest of its exact bytes, and prefers it", async () => {
    const descText = signedDescriptorText();
    const f = fakeFetch({ [CARD_URL]: card(), [DESC_URL]: descText });
    const { doc, notes } = await assembleWithNotes({ address: ORIGIN, fetch: f, now: NOW });
    expect(notes).toEqual([]);
    const desc = doc.sources.find((s) => s.id === "descriptor")!;
    expect(desc).toMatchObject({ kind: "agent-descriptor", url: DESC_URL, signature: "verified", agent_version: "1.2.0", digest: sha256Digest(descText) });
    expect(doc.subject).toEqual({ id: SUBJECT_KEY, name: "Recipe Helper" });
    expect(doc.sections.identity).toMatchObject({
      from: ["card", "descriptor"],
      name: "Recipe Helper",
      name_from: "card",
      description: "Suggests recipes from the ingredients you have.",
      description_from: "descriptor",
      acts_for: "anyone",
      acts_for_from: "descriptor",
      operator_from: "card",
    });
    expect(doc.sections.shape).toEqual({ from: ["descriptor"], interaction: "service" });
    expect(doc.not_stated).toContain("shape.visibility");
    const sells = doc.sections.sells!;
    expect(sells.from).toEqual(["descriptor"]);
    expect(sells.scopes).toEqual(["task-specific"]);
    const [first] = sells.offerings as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ id: "suggest-recipes", inputs: [{ name: "ingredients", kind: "text", required: true }], trial: { offered: true, who: "anyone" } });
    expect((sells.offerings as Array<Record<string, unknown>>)[1]!.trial).toEqual({ offered: false });
    expect(doc.sections.refuses).toEqual({ from: ["descriptor"], statement: "medical or allergy advice.\nrecipes that need alcohol for anyone who says they are under 21.", kind: "prose", hands_over: ["a question about a severe allergy."] });
    expect(doc.sections.reaches).toEqual({ from: ["descriptor"], systems: [{ name: "recipe-index", access: "read", needs: "to look up recipes" }] });
    expect(doc.sections.leaves!.records).toEqual([{ name: "the ingredients as received", when: "per_task" }]);
    expect(doc.sections.configs).toEqual({ from: ["descriptor"], settings: [] });
    expect(doc.sections.handling).toEqual({ from: ["descriptor"], hosted_in: ["eu"] });
    for (const p of ["handling.processed_in", "handling.retention_max_days", "handling.memory", "sells.offerings.price", "standing", "access.admission"]) expect(doc.not_stated, p).toContain(p);
    for (const p of ["refuses", "reaches", "leaves", "configs", "shape", "identity.acts_for", "sells.offerings.inputs"]) expect(doc.not_stated, p).not.toContain(p);
    await honest(doc);
  });

  it("reports a card that disagrees with the Descriptor, and carries the Descriptor's value", async () => {
    const c = card({ description: "Cooks anything.", skills: [...(card().skills as unknown[]), { id: "wine-pairing", name: "Wine pairing" }] });
    const doc = await assemble({ card: c, descriptor: signedDescriptorText(), now: NOW });
    const dis = doc.sources.find((s) => s.id === "card")!.disagreements!;
    expect(dis.join(" | ")).toMatch(/description differs/);
    expect(dis.join(" | ")).toMatch(/wine-pairing/);
    expect(doc.sections.identity!.description).toBe("Suggests recipes from the ingredients you have.");
    expect((doc.sections.sells!.offerings as unknown[]).length).toBe(2);
    await honest(doc);
  });

  it("lists a Descriptor whose signature fails, and uses nothing in it", async () => {
    const tampered = JSON.parse(signedDescriptorText());
    tampered.does = "Does everything for free.";
    const { doc, notes } = await assembleWithNotes({ card: card(), descriptor: tampered, now: NOW });
    const desc = doc.sources.find((s) => s.id === "descriptor")!;
    expect(desc.signature).toBe("failed");
    expect(desc.not_used).toMatch(/does not verify/);
    expect(notes.join(" ")).toMatch(/does not verify/);
    expect(JSON.stringify(doc.sections)).not.toContain("for free");
    expect(doc.sections.identity!.from).toEqual(["card"]);
    expect(doc.subject!.id).toBe(`${ORIGIN}/a2a`);
    await honest(doc);
  });

  it("uses an unsigned Descriptor as unsigned, and says so", async () => {
    const { doc, notes } = await assembleWithNotes({ card: card(), descriptor: draftDescriptor(), now: NOW });
    expect(doc.sources.find((s) => s.id === "descriptor")!.signature).toBe("unsigned");
    expect(doc.sections.refuses).toBeDefined();
    expect(notes.join(" ")).toMatch(/not signed/);
    await honest(doc);
  });

  it("keeps an open-ended offering from saying what it can do, and lets an open-with-focus one keep its focus", async () => {
    const ceilings = { job_seconds: { most: 600, decided_by: "rule" }, cost_per_job: { most: { amount_micro: 1000000, currency: "USD" }, decided_by: "model" } };
    const desc = signedDescriptorText({
      offerings: [
        { id: "anything", name: "Anything", does: "Can do whatever you ask, brilliantly.", role: "role-generalist", scope: "open-ended", inputs: [{ name: "instruction", kind: "text", required: true }], outputs: [], authority: ["runs-commands"], ceilings },
        { id: "fix-code", name: "Fix code", does: "Changes code in one repository.", scope: "open-with-focus", focus: "software", inputs: [{ name: "instruction", kind: "text", required: true }], outputs: [{ name: "change", kind: "identifier", when: "per_task" }], workspace: [{ kind: "git", access: "read-write", for: "the repository" }], authority: ["reads-files", "writes-files"], authority_decided_by: "rule", ceilings },
        { id: "odd", name: "Odd", scope: "whatever-this-is", inputs: [], outputs: [] },
      ],
    });
    const doc = await assemble({ card: card({ skills: [] }), descriptor: desc, now: NOW });
    const [open, focus, odd] = doc.sections.sells!.offerings as Array<Record<string, unknown>>;
    expect(open!.scope).toBe("open-ended");
    for (const k of ["does", "role", "focus"]) expect(open![k], k).toBeUndefined();
    expect(focus).toMatchObject({ scope: "open-with-focus", focus: "software", does: "Changes code in one repository." });
    expect(odd!.scope).toBe("open-ended");
    expect(doc.sections.sells!.scopes).toEqual(["open-ended", "open-with-focus"]);
    const report = await check(doc);
    expect(report.findings.filter((f) => f.level === "fail").map((f) => f.rule)).toEqual(["open-offering-members", "open-offering-members"]);
    // The undeclared offering lacks authority and its ceilings; that is the agent's gap, shown honestly, not hidden.
    expect(report.findings.filter((f) => f.level === "fail").every((f) => f.path === "sections.sells.offerings[2]")).toBe(true);
    const html = render(doc);
    expect(html).not.toContain("brilliantly");
    expect(html).toContain("open-ended: takes any instruction");
    expect(html).toContain("the operator says a rule holds it to this");
    expect(html).toContain("a limit the model is asked to keep");
  });

  it("lists each declared interface with the exchanges its definition publishes, and names one it could not read", async () => {
    const def = { interface: "interface-worker", version: "v1", definition: "https://agentroles.ai/worker.html", exchanges: [{ id: "free", asks: "are you free?", answer_carries: ["free"] }, { id: "stop", asks: "stop", answer_carries: ["state"] }] };
    const f = fakeFetch({ [CARD_URL]: card(), [DESC_URL]: signedDescriptorText({ interfaces: ["interface-worker", "interface-unknown"] }), "https://agentroles.ai/interfaces/interface-worker.json": def });
    const doc = await assemble({ address: ORIGIN, fetch: f, now: NOW });
    const [worker, unknown] = doc.sections.asked!.interfaces as Array<Record<string, unknown>>;
    expect(worker).toMatchObject({ name: "interface-worker", version: "v1", definition_from: "iface-interface-worker" });
    expect((worker!.exchanges as Array<Record<string, unknown>>).map((e) => [e.id, e.state])).toEqual([["free", "declared"], ["stop", "declared"]]);
    expect(unknown!.exchanges).toBeUndefined();
    expect(doc.not_stated).toContain("asked.interface-unknown");
    expect(doc.sources.find((s) => s.id === "iface-interface-worker")).toMatchObject({ kind: "interface-definition", signature: "unsigned" });
    await honest(doc);
  });
});

describe("signed terms, evaluation records and attestations", () => {
  it("follows the card's terms extension to a verified proposal, and quotes its price and handling", async () => {
    const terms = signedTerms();
    const url = `${ORIGIN}/terms/recipes.json`;
    const c = card({ capabilities: { streaming: true, extensions: [termsExtension(url, terms)] } });
    const f = fakeFetch({ [CARD_URL]: c, [DESC_URL]: signedDescriptorText(), [url]: terms });
    const doc = await assemble({ address: ORIGIN, fetch: f, now: NOW });
    expect(doc.sources.find((s) => s.id === "terms")).toMatchObject({ kind: "sow-standing-proposal", url, signature: "verified", committed_by: "card" });
    const [first] = doc.sections.sells!.offerings as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ arrangement: "fixed_fee", price_from: "terms", arrangement_from: "terms" });
    expect(first!.price).toEqual({ arrangement: "fixed_fee", currency: "USD", rates: [{ offering: "suggest-recipes", amount_micro: 250000 }], enforcement: "enforced" });
    expect(doc.sections.sells!.from).toEqual(["descriptor", "terms"]);
    expect(doc.sections.handling).toMatchObject({ processed_in: ["eu"], retention_max_days: 30, processed_in_from: "terms", hosted_in_from: "descriptor" });
    expect(doc.not_stated).not.toContain("handling.retention_max_days");
    expect(doc.not_stated).toContain("handling.memory");
    await honest(doc);
  });

  it("uses no terms whose digest is not the one the card commits to, or whose signature fails", async () => {
    const terms = signedTerms();
    const url = `${ORIGIN}/terms/recipes.json`;
    const wrongDigest = card({ capabilities: { extensions: [termsExtension(url, terms, `sha256:${"0".repeat(64)}`)] } });
    const a = await assemble({ address: ORIGIN, fetch: fakeFetch({ [CARD_URL]: wrongDigest, [url]: terms }), now: NOW });
    expect(a.sources.find((s) => s.id === "terms")!.not_used).toMatch(/digest/);
    expect(JSON.stringify(a.sections)).not.toContain("fixed_fee");
    const forged = { ...terms, price: { arrangement: "no_charge" } };
    const b = await assemble({ card: card(), terms: [forged], now: NOW });
    expect(b.sources.find((s) => s.id === "terms")).toMatchObject({ signature: "failed" });
    expect(JSON.stringify(b.sections)).not.toContain("no_charge");
    await honest(b);
  });

  it("moves a member only by a verified record about this subject, case by case", async () => {
    const rec = evalRecord([{ id: "c1", kind: "offering", source: "suggest-recipes", verdict: "pass" }, { id: "c2", kind: "offering", source: "shopping-list", verdict: "fail" }]);
    const doc = await assemble({ card: card(), descriptor: signedDescriptorText(), evalRecords: [rec], now: NOW });
    const [a, b] = doc.sections.sells!.offerings as Array<Record<string, unknown>>;
    expect(a).toMatchObject({ state: "confirmed", confirmed_by: "eval", confirmed_at: "2026-11-02T10:00:00Z" });
    expect(b).toMatchObject({ state: "failed", failed_by: "eval" });
    expect(doc.sections.sells!.from).toEqual(["descriptor", "eval"]);
    expect(doc.sections.standing).toMatchObject({ from: ["eval"], entries: [{ kind: "eval-record", signature: "verified", conforms: true, record: "eval" }] });
    await honest(doc);

    const unsigned = await assemble({ card: card(), descriptor: signedDescriptorText(), evalRecords: [evalRecord([{ id: "c1", source: "suggest-recipes", verdict: "pass" }], {}, false)], now: NOW });
    expect((unsigned.sections.sells!.offerings as Array<Record<string, unknown>>)[0]!.state).toBe("declared");
    expect(unsigned.sources.find((s) => s.id === "eval")!.signature).toBe("unsigned");

    const other = await assemble({ card: card(), descriptor: signedDescriptorText(), evalRecords: [evalRecord([{ id: "c1", source: "suggest-recipes", verdict: "pass" }], { subject: { agent_key: "UAKQRYZBYFOC65OQZVJ3QPCIERDTRNNZPMOJUYXC3DGPRCDWSKD4HV5A" } })], now: NOW });
    expect((other.sections.sells!.offerings as Array<Record<string, unknown>>)[0]!.state).toBe("declared");
  });

  it("carries an attestation attributed and unaudited, and shows a failed one rather than dropping it", async () => {
    const good = attestation();
    const bad = { ...attestation(), payload: Buffer.from(JSON.stringify({ _type: "x", predicate: { attester: { name: "Mallory" } } })).toString("base64") };
    const doc = await assemble({ card: card(), attestations: [good, bad], now: NOW });
    const entries = doc.sections.standing!.entries as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({ kind: "attestation", by: "An Example Attester", signature: "verified", as_of: "2026-11-01T09:00:00Z", areas: { identity: "passed", spend: "not_attested" } });
    expect(entries[1]).toMatchObject({ kind: "attestation", by: "Mallory", signature: "failed" });
    expect(doc.not_stated).not.toContain("standing");
    await honest(doc);
  });
});

describe("the package AgentDoc (Section 13.4)", () => {
  const fixture = JSON.parse(readFileSync(join(HERE, "..", "..", "package", "test", "vectors", "package-checks.json"), "utf8"));
  const files = fixture.base.files as Record<string, string>;

  it("is fixed to the package: no subject, no time, and the same bytes every time", async () => {
    const a = await assemble({ package: files["plugin.json"]!, descriptor: files["agent-descriptor.json"]!, now: NOW });
    const b = await assemble({ package: files["plugin.json"]!, descriptor: files["agent-descriptor.json"]!, now: new Date("2030-01-01T00:00:00Z") });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.subject).toBeUndefined();
    expect(a.package).toEqual({ name: "brief-summarizer", version: "1.0.0" });
    expect(a.assembled_at).toBeUndefined();
    expect(a.sources.every((s) => s.fetched_at === undefined)).toBe(true);
    expect(a.sources.map((s) => [s.id, s.kind, s.signature])).toEqual([["descriptor", "agent-descriptor", "unsigned"], ["package", "plugin-package", "unsigned"]]);
    expect(a.sources[1]!.disagreements).toBeUndefined();
    for (const p of ["subject", "standing", "access", "handling", "shape", "sells.offerings.price"]) expect(a.not_stated, p).toContain(p);
    expect(a.sections.refuses!.hands_over).toEqual(["a document marked confidential."]);
    expect(a.sections.access).toBeUndefined();
    await honest(a);
    expect(render(a)).toContain("describes a package");
  });

  it("reports a manifest that points at another Descriptor, and refuses a bound one", async () => {
    const other = files["agent-descriptor.json"]!.replace("one-page brief", "two-page brief");
    const doc = await assemble({ package: files["plugin.json"]!, descriptor: other, now: NOW });
    expect(doc.sources[1]!.disagreements![0]).toMatch(/points at Descriptor/);
    const bound = JSON.stringify({ ...JSON.parse(files["agent-descriptor.json"]!), subject: { id: SUBJECT_KEY } });
    await expect(assemble({ package: files["plugin.json"]!, descriptor: bound, now: NOW })).rejects.toThrow(/describes an agent that exists/);
  });
});
