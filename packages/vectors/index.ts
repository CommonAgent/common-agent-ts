/**
 * The runner for the Common Agent Standards' conformance files.
 *
 * The files are copies kept in this repository, each pinned in
 * standards-pin.json to the file and tag it copies in
 * https://github.com/CommonAgent/common-agent-standards, and
 * tools/check-standards-pin.mjs holds every copy to its pin in CI. This
 * module finds a standard's pinned files and lists their cases, so each core
 * can run them without knowing where they are kept or what each file calls
 * its lists of cases.
 *
 * Test tooling: it reads files, so cores use it only from their tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file is packages/vectors/index.ts. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** One pinned conformance file, read. */
export interface PinnedVectors {
  /** The file's path in the standards repository, such as `sow/conformance/sow-pricing.json`. */
  path: string;
  /** The tag it is pinned to, such as `sow-v0.24.1-draft`. */
  tag: string;
  /** Where the copy is kept here, repository-relative. */
  local: string;
  data: Record<string, unknown>;
}

/** One case: the list it came from in the file, its name, and its contents. */
export interface VectorCase {
  group: string;
  name: string;
  value: Record<string, unknown>;
}

interface PinEntry {
  local: string;
  path: string;
  tag: string;
}

function pins(root: string): PinEntry[] {
  return (JSON.parse(readFileSync(join(root, "standards-pin.json"), "utf8")) as { files: PinEntry[] }).files;
}

/** Every conformance file pinned for a standard (its folder in the standards repository: `sow`, `nda`, `reputations` and so on). */
export function pinnedVectorFiles(standard: string, root = REPO_ROOT): PinnedVectors[] {
  return pins(root)
    .filter((p) => p.path.startsWith(`${standard}/conformance/`) && p.path.endsWith(".json"))
    .map((p) => ({ ...p, data: JSON.parse(readFileSync(join(root, p.local), "utf8")) as Record<string, unknown> }));
}

/** One pinned conformance file by its path in the standards repository. Throws when it is not pinned. */
export function loadPinnedVectors(path: string, root = REPO_ROOT): PinnedVectors {
  const p = pins(root).find((x) => x.path === path);
  if (!p) throw new Error(`${path} is not pinned in standards-pin.json; copy it from its tag and pin it first`);
  return { ...p, data: JSON.parse(readFileSync(join(root, p.local), "utf8")) as Record<string, unknown> };
}

/**
 * The cases in a file. The standards' files name their lists differently
 * (`vectors`, `valid`, `invalid`, `traps`, `must_fail`, `cases` and others),
 * so a case is any object in any top-level list of objects, named by its
 * `name`, `case` or `id` member, or by its place in the list. A file whose
 * cases are top-level objects instead (a document and its acceptance, say)
 * gives one case per object member, in the group `document`.
 */
export function vectorCases(file: Pick<PinnedVectors, "data">): VectorCase[] {
  const cases: VectorCase[] = [];
  for (const [group, value] of Object.entries(file.data)) {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const o = item as Record<string, unknown>;
          const name = [o.name, o.case, o.id].find((x) => typeof x === "string" && x) as string | undefined;
          cases.push({ group, name: name ?? `#${i + 1}`, value: o });
        }
      });
    }
  }
  if (cases.length) return cases;
  for (const [group, value] of Object.entries(file.data)) {
    if (value && typeof value === "object" && !Array.isArray(value) && !/^(comment|about|spec|version|constants|tolerance)$/.test(group)) {
      cases.push({ group: "document", name: group, value: value as Record<string, unknown> });
    }
  }
  return cases;
}
