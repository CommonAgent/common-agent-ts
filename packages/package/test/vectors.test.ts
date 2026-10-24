// The conformance files this package answers to.
//
// offering-scope.json is the Common Agent Standards' own fixture, pinned in
// standards-pin.json: its declaration cases are the offering checks the
// packer and the validator make (Section 6.11).
//
// test/vectors/package-checks.json is this package's fixture for the checker
// of Section 12.10: a base package and cases that each change it, valid ones
// that must pass and invalid ones that must be refused by the check they
// name, and by no other. The standards repository has no package fixture
// yet; this one is written in its style so it can move there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedVectorFiles, REPO_ROOT } from "../../vectors/index.js";
import { PACKAGE_NS } from "../manifest.js";
import { resolveName, resolvePointer } from "../names.js";
import { offeringScopeProblems } from "../offering.js";
import { dumps, sha256Hex, utf8Bytes, utf8Text } from "../text.js";
import type { DraftDescriptor, InstallFile, PackageFiles } from "../types.js";
import { validatePackage } from "../validate.js";
import { generatedViews } from "../views.js";

describe("offering-scope.json: the declaration cases (Section 6.11)", () => {
  const [file] = pinnedVectorFiles("common-agent").filter((f) => f.path.endsWith("/offering-scope.json"));
  it("is pinned", () => expect(file, "offering-scope.json is pinned in standards-pin.json").toBeTruthy());
  if (!file) return;
  const decl = file.data.declarations as {
    systems: { name: string; access: string }[];
    data_use: { retention_max_days: number; processors: string[]; memory: string };
    valid: { case: string; offering: unknown }[];
    invalid: { case: string; offering: unknown; why: string }[];
  };
  // The fixture states data use in the registry's flat form; the check reads the Descriptor's.
  const dataUse = { retention: { max_days: decl.data_use.retention_max_days }, processors: decl.data_use.processors.map((service) => ({ service })), memory: decl.data_use.memory };
  for (const c of decl.valid) it(`accepts ${c.case}`, () => expect(offeringScopeProblems(c.offering, { systems: decl.systems, dataUse })).toEqual([]));
  for (const c of decl.invalid) it(`refuses ${c.case}`, () => expect(offeringScopeProblems(c.offering, { systems: decl.systems, dataUse }).length, c.why).toBeGreaterThan(0));
});

type Edit =
  | { op: "set"; path: string; text: string }
  | { op: "delete"; path: string }
  | { op: "move"; path: string; to: string }
  | { op: "json"; path: string; pointer: string; value?: unknown; remove?: boolean };
interface Case {
  case: string;
  edits: Edit[];
  rehash?: boolean;
  regenerate?: boolean;
  check?: string;
  warnings?: number;
  why: string;
}
interface Fixture {
  checks: Record<string, string>;
  base: { files: Record<string, string> };
  valid: Case[];
  invalid: Case[];
}

const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "package", "test", "vectors", "package-checks.json"), "utf8")) as Fixture;

/** RFC 6901: the parent of the member a pointer names, and the member's key. */
function at(doc: unknown, pointer: string): [Record<string, unknown> | unknown[], string] {
  const parts = pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = doc as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) node = (Array.isArray(node) ? node[Number(p)] : node[p]) as Record<string, unknown>;
  return [node, parts[parts.length - 1]];
}

/** The base package with a case's edits applied, as the fixture's comment says. */
function packageFor(c: Case): PackageFiles {
  const files: PackageFiles = new Map(Object.entries(fixture.base.files).map(([k, v]) => [k, utf8Bytes(v)]));
  const readJson = (p: string) => JSON.parse(utf8Text(files.get(p) as Uint8Array));
  for (const e of c.edits) {
    if (e.op === "set") files.set(e.path, utf8Bytes(e.text));
    else if (e.op === "delete") files.delete(e.path);
    else if (e.op === "move") {
      files.set(e.to, files.get(e.path) as Uint8Array);
      files.delete(e.path);
    }
    else {
      const doc = readJson(e.path);
      const [parent, key] = at(doc, e.pointer);
      if (Array.isArray(parent)) {
        if (e.remove) parent.splice(Number(key), 1);
        else parent[Number(key)] = e.value;
      } else if (e.remove) delete parent[key];
      else parent[key] = e.value;
      files.set(e.path, utf8Bytes(dumps(doc)));
    }
  }
  const has = (p: string) => files.has(p);
  const descPath = resolveName(has, "descriptor").path as string;
  const instPath = resolveName(has, "runtime").path as string;
  if (c.rehash) {
    const m = readJson("plugin.json");
    const ns = m.extensions[PACKAGE_NS];
    ns[resolvePointer(ns, "descriptor").path as string].sha256 = sha256Hex(files.get(descPath) as Uint8Array);
    ns[resolvePointer(ns, "runtime").path as string].sha256 = sha256Hex(files.get(instPath) as Uint8Array);
    files.set("plugin.json", utf8Bytes(dumps(m)));
  }
  if (c.regenerate) {
    const views = generatedViews(readJson(descPath) as DraftDescriptor, readJson(instPath) as InstallFile, PACKAGE_NS);
    for (const [p, text] of Object.entries(views)) files.set(p, utf8Bytes(text));
  }
  return files;
}

describe("package-checks.json: the checker of Section 12.10", () => {
  for (const c of fixture.valid) {
    it(`accepts ${c.case}`, () => {
      const v = validatePackage(packageFor(c));
      expect(v.problems, c.why).toEqual([]);
      expect(v.warnings, c.why).toHaveLength(c.warnings ?? 0);
    });
  }
  for (const c of fixture.invalid) {
    it(`refuses ${c.case} by its ${c.check} check`, () => {
      const v = validatePackage(packageFor(c));
      expect(v.ok, c.why).toBe(false);
      expect([...new Set(v.issues.map((i) => i.check))], `${c.why}: ${v.problems.join("; ")}`).toEqual([c.check]);
    });
  }
  it("names only checks it defines, and refuses by every one of them", () => {
    const named = new Set(fixture.invalid.map((c) => c.check as string));
    for (const n of named) expect(Object.keys(fixture.checks)).toContain(n);
    expect([...named].sort()).toEqual(Object.keys(fixture.checks).sort());
  });
});
