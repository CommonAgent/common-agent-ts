/**
 * The conformance files as vitest suites. Each pinned file of a standard
 * becomes a `describe` named for the file and its tag, and each case an `it`
 * when the caller gives a check for its group, or a pending `it.todo` when it
 * does not. A known failure is also pending, with its reason in the name, so
 * the count of what does not pass yet stays in front of whoever runs the
 * tests.
 */
import { describe, it } from "vitest";
import { pinnedVectorFiles, vectorCases, type VectorCase } from "./index.js";

export type CaseCheck = (c: VectorCase, file: Record<string, unknown>) => void | Promise<void>;

export interface VectorPlan {
  /** By file name (`sow-pricing.json`), then by group (`vectors`, `valid`, ...): the check for each case of that group. */
  checks?: Record<string, Record<string, CaseCheck>>;
  /** By file name, then case name: why that case does not pass yet. It runs as pending. */
  known?: Record<string, Record<string, string>>;
}

export function describeVectors(standard: string, plan: VectorPlan = {}): void {
  const files = pinnedVectorFiles(standard);
  describe(`${standard} conformance files`, () => {
    it(`has pinned files for ${standard}`, () => {
      if (!files.length) throw new Error(`no conformance files for ${standard} are pinned in standards-pin.json`);
    });
    for (const file of files) {
      const name = file.path.split("/").pop()!;
      describe(`${name} at ${file.tag}`, () => {
        for (const c of vectorCases(file)) {
          const label = `${c.group}: ${c.name}`;
          const known = plan.known?.[name]?.[c.name];
          const check = plan.checks?.[name]?.[c.group];
          if (known) it.todo(`${label} (known: ${known})`);
          else if (check) it(label, () => check(c, file.data));
          else it.todo(label);
        }
      });
    }
  });
}
