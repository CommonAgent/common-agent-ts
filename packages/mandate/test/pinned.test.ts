/**
 * The Agent Mandate conformance files for holding an identifier
 * (mandate-ids.json, §4), the check at a resource proxy (mandate-proxy.json,
 * §7.1) and the resources a write may reach (mandate-scope.json, §5 rule 6,
 * §6 rules 3 and 9), pinned at mandate-v0.8.0-draft, run by this core; and
 * the bypasses a review found in the proxy check, each held shut.
 * Each fixture case runs against the state its file gives, on its own.
 */
import { describe, expect, it } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import {
  charterAmendmentFailure,
  checkAtProxy,
  identifierHeld,
  isResourcePattern,
  narrowingFailure,
  patternCovers,
  patternMatches,
  validateMandate,
  validateProxyWrites,
  WRITES_POWERS,
  type IdentifierView,
  type ProxyAct,
  type ProxyGrant,
  type ProxyMandate,
  type MandateDoc,
} from "../index.js";

type Reg = {
  reservations: Array<{ id: string; domain: string; lapses_at: string }>;
  charters: Array<{ id: string; domain: string }>;
  mandates: Array<{ id: string; organization: string }>;
};

/** The pure rule over the fixture's registry. The platform's test runs the same cases through the registry's own store. */
function viewOf(reg: Reg): IdentifierView {
  return {
    reservedFor: (id, at) => reg.reservations.find((r) => r.id === id && at < Date.parse(r.lapses_at))?.domain ?? null,
    charterDomain: (id) => reg.charters.find((c) => c.id === id)?.domain ?? null,
    mandateOrganization: (id) => reg.mandates.find((m) => m.id === id)?.organization ?? null,
  };
}

const ids = loadPinnedVectors("mandate/conformance/mandate-ids.json").data as {
  registry: Reg;
  cases: Array<{ case: string; filing: { kind: "charter" | "mandate"; id: string; domain?: string; organization?: string; at: string }; expected: { accept: boolean; reason?: string } }>;
};

describe("mandate-ids.json", () => {
  for (const c of ids.cases) {
    it(c.case, () => {
      const f = c.filing;
      const filing = f.kind === "charter"
        ? { kind: "charter" as const, id: f.id, domain: f.domain!, at: Date.parse(f.at) }
        : { kind: "mandate" as const, id: f.id, organization: f.organization!, at: Date.parse(f.at) };
      const verdict = identifierHeld(filing, viewOf(ids.registry));
      expect({ accept: !verdict.held, ...(verdict.held ? { reason: "held" } : {}) }).toEqual(c.expected);
    });
  }
});

const proxy = loadPinnedVectors("mandate/conformance/mandate-proxy.json").data as {
  grant: ProxyGrant;
  writes_powers: string[];
  cases: Array<{ case: string; grant?: ProxyGrant; act: ProxyAct; mandate: ProxyMandate | null; at: string; expected: { allow: boolean; check?: string } }>;
  validation: { invalid: Array<{ case: string; grant: ProxyGrant }> };
};

/** The fixture's mandates name the caller's key by a stand-in and one organization; the proxy is told both. */
const CALLER = "<the caller's key>";
const ORG = "org_stonework";

describe("mandate-proxy.json", () => {
  for (const c of proxy.cases) {
    it(c.case, () => {
      const verdict = checkAtProxy({ grant: c.grant ?? proxy.grant, act: c.act, mandate: c.mandate, at: Date.parse(c.at), callerKey: CALLER, expectedOrganization: ORG });
      expect(verdict.allow).toBe(c.expected.allow);
      if (!verdict.allow) expect(verdict.check).toBe(c.expected.check);
    });
  }
  it("names the same powers a grant may lend", () => {
    expect([...WRITES_POWERS]).toEqual(proxy.writes_powers);
  });
  it("accepts the file's own grant", () => {
    expect(validateProxyWrites(proxy.grant).ok).toBe(true);
  });
  for (const c of proxy.validation.invalid) {
    it(`refuses the grant ${c.case}`, () => {
      expect(validateProxyWrites(c.grant).ok).toBe(false);
    });
  }
});

describe("the proxy check holds shut where the review found it open", () => {
  const grant: ProxyGrant = { via: "proxy", writes: { ledger: "amend" } };
  const write: ProxyAct = { resource: "receipts", operation: "post", read_only: false };
  const AT = Date.parse("2026-10-01T00:00:00Z");
  const good: ProxyMandate = { organization: ORG, holder_key: "UCALLER", starts_at: "2026-08-01T00:00:00Z", expires_at: "2027-08-01T00:00:00Z", powers: ["write"] };
  const run = (over: Partial<Parameters<typeof checkAtProxy>[0]>) =>
    checkAtProxy({ grant, act: write, mandate: good, at: AT, callerKey: "UCALLER", expectedOrganization: ORG, ...over });

  it("allows the good case, so each refusal below is about its one change", () => {
    expect(run({})).toEqual({ allow: true, power: "write" });
  });
  it("refuses a mandate of another organization: anyone can charter a domain of their own", () => {
    expect(run({ mandate: { ...good, organization: "org_mallory" } })).toMatchObject({ allow: false, check: "organization" });
    expect(run({ expectedOrganization: "" })).toMatchObject({ allow: false, check: "organization" });
  });
  it("refuses a mandate presented by a key that is not its holder's, and one that names no holder key", () => {
    expect(run({ callerKey: "UMALLORY" })).toMatchObject({ allow: false, check: "holder" });
    expect(run({ callerKey: "" })).toMatchObject({ allow: false, check: "holder" });
    const { holder_key: _h, ...keyless } = good;
    expect(run({ mandate: keyless })).toMatchObject({ allow: false, check: "holder" });
  });
  it("treats dates that do not parse, and an instant that is not a number, as not in force", () => {
    expect(run({ mandate: { ...good, expires_at: "someday" } })).toMatchObject({ allow: false, check: "in_force" });
    expect(run({ mandate: { ...good, starts_at: "" } })).toMatchObject({ allow: false, check: "in_force" });
    expect(run({ at: Number.NaN })).toMatchObject({ allow: false, check: "in_force" });
    expect(run({ mandate: { ...good, revoked: true } })).toMatchObject({ allow: false, check: "in_force" });
  });
  it("refuses a grant whose writes does not validate before reading anything else, reads included", () => {
    const lends = { via: "proxy", writes: { receipts: "nda" } } as ProxyGrant;
    expect(run({ grant: lends })).toMatchObject({ allow: false, check: "grant" });
    expect(run({ grant: lends, act: { ...write, read_only: true } })).toMatchObject({ allow: false, check: "grant" });
    expect(run({ grant: { via: "mcp", writes: { receipts: "write" } } })).toMatchObject({ allow: false, check: "grant" });
  });
  it("refuses a write under a mandate scoped to offerings that names no resources: it was meant to be limited", () => {
    expect(run({ mandate: { ...good, scope: { offerings: ["audit-*"] } } })).toMatchObject({ allow: false, check: "scope" });
    expect(run({ mandate: { ...good, scope: { offerings: ["audit-*"], resources: ["receipts"] } } })).toEqual({ allow: true, power: "write" });
    expect(run({ mandate: { ...good, scope: { offerings: ["audit-*"] } }, act: { ...write, read_only: true } })).toEqual({ allow: true });
  });
  it("reads scope.resources for write and amend alike, never for a read (§6 rule 9)", () => {
    expect(run({ mandate: { ...good, scope: { resources: ["receipts"] } } })).toEqual({ allow: true, power: "write" });
    expect(run({ mandate: { ...good, scope: { resources: ["rec*"] } } })).toEqual({ allow: true, power: "write" });
    expect(run({ mandate: { ...good, scope: { resources: ["ledger"] } } })).toMatchObject({ allow: false, check: "scope" });
    const amend = { resource: "ledger", operation: "post", read_only: false };
    expect(run({ act: amend, mandate: { ...good, powers: ["amend"], scope: { resources: ["receipts"] } } })).toMatchObject({ allow: false, check: "scope" });
    expect(run({ act: { ...write, read_only: true }, mandate: null })).toEqual({ allow: true });
  });
});

const scope = loadPinnedVectors("mandate/conformance/mandate-scope.json").data as {
  matching: Array<{ pattern: string; name: string; matches: boolean }>;
  covering: Array<{ wide: string; narrow: string; covers: boolean }>;
  narrowing: Array<{ case: string; issuer: string[] | null; sub: string[] | null; valid: boolean }>;
  invalid_lists: Array<{ case: string; resources: unknown[] }>;
  charter_amendments: Array<{ case: string; v1: { domain: string }; v2: { domain: string }; valid: boolean }>;
};

describe("mandate-scope.json", () => {
  for (const c of scope.matching) {
    it(`matching ${c.pattern} against ${c.name}`, () => expect(patternMatches(c.pattern, c.name)).toBe(c.matches));
  }
  for (const c of scope.covering) {
    it(`${c.wide} covering ${c.narrow}`, () => expect(patternCovers(c.wide, c.narrow)).toBe(c.covers));
  }
  // A sub-mandate and its issuer that differ only in scope.resources.
  const mandateWith = (id: string, resources: string[] | null, issuer: MandateDoc["issuer"]): MandateDoc => ({
    mandate: "v1", id, version: 1, organization: "org_7k2m9q4w1x8e5r3t", issuer,
    holder: { account: "acct_a", person: "A", key: `U${"A".repeat(55)}` }, powers: ["write", "amend"],
    ...(resources ? { scope: { resources } } : {}),
    sub_delegation: { allowed: issuer.kind === "root", ...(issuer.kind === "root" ? { max_depth: 1 } : {}) },
    starts_at: "2026-08-01T00:00:00Z", expires_at: "2027-08-01T00:00:00Z",
    // Shape only: narrowing and validation read no signature.
    signatures: [{ role: "root", key: `U${"B".repeat(55)}`, signed_at: "2026-08-01T00:00:00Z", sig: "shape-only" }],
  });
  for (const c of scope.narrowing) {
    it(`narrowing: ${c.case}`, () => {
      const issuer = mandateWith("mnd_0000000000000001", c.issuer, { kind: "root" });
      const sub = mandateWith("mnd_0000000000000002", c.sub, { kind: "mandate", mandate: issuer.id });
      expect(narrowingFailure(sub, issuer) === null).toBe(c.valid);
    });
  }
  it("accepts a well-formed list, so each refusal below is about its list", () => {
    expect(validateMandate(mandateWith("mnd_0000000000000003", ["ledger*", "receipts", "*"], { kind: "root" })).ok).toBe(true);
    expect(isResourcePattern("receipts/2026*")).toBe(true);
  });
  for (const c of scope.invalid_lists) {
    it(`refuses the list ${c.case}`, () => {
      const doc = { ...mandateWith("mnd_0000000000000003", null, { kind: "root" }), scope: { resources: c.resources } };
      expect(validateMandate(doc).ok).toBe(false);
    });
  }
  for (const c of scope.charter_amendments) {
    it(`charter amendment: ${c.case}`, () => expect(charterAmendmentFailure(c.v1, c.v2) === null).toBe(c.valid));
  }
});
