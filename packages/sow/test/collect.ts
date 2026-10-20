/**
 * Collects suites written in vitest's describe/it shape without registering
 * them, so the conformance-file runner (vectors.test.ts) can run each one
 * under the section of the file it reads. The suites are the TypeScript SDK's
 * conformance tests for Agent SoW, carried over nearly line for line; a suite
 * reads the sections its source names as `fixture.<section>`. Because a suite
 * runs only under a section it reads, vectors.test.ts fails when a suite
 * reads no section its file has.
 */
export interface CollectedTest {
  name: string;
  fn: () => unknown;
}

export interface CollectedSuite {
  title: string;
  /** The file sections the suite reads, from `fixture.<section>` in its source. */
  sections: Set<string>;
  tests: CollectedTest[];
}

export function collector() {
  const suites: CollectedSuite[] = [];
  let current: CollectedSuite | null = null;
  const describe = (title: string, fn: () => void): void => {
    const outer = current;
    const suite = outer ?? { title, sections: new Set<string>(), tests: [] };
    for (const m of fn.toString().matchAll(/\bfixture\.([a-z_]+)/g)) suite.sections.add(m[1]!);
    if (!outer) {
      suites.push(suite);
      current = suite;
    }
    try {
      fn();
    } finally {
      if (!outer) current = null;
    }
  };
  const it = (name: string, fn: () => unknown): void => {
    if (!current) throw new Error(`it("${name}") outside a describe`);
    current.tests.push({ name: `${current.title} > ${name}`, fn });
  };
  return { describe, it, suites };
}

/** Run every test of the suites that read `section`, naming the test that failed. */
export async function runSection(suites: CollectedSuite[], section: string): Promise<void> {
  const mine = suites.filter((s) => s.sections.has(section));
  if (!mine.length) throw new Error(`no suite reads the section ${section}`);
  for (const s of mine) {
    for (const t of s.tests) {
      try {
        await t.fn();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        err.message = `${t.name}: ${err.message}`;
        throw err;
      }
    }
  }
}
