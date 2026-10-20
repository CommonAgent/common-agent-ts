# The conformance-file runner

The Common Agent Standards publish conformance files beside each
specification. This repository keeps copies, each pinned in
`standards-pin.json` to the file and tag it copies, and
`tools/check-standards-pin.mjs` holds every copy to its tag in CI.

- `index.ts` finds a standard's pinned files (`pinnedVectorFiles("sow")`) and
  lists their cases (`vectorCases(file)`), whatever each file calls its lists.
- `vitest.ts` turns them into suites: `describeVectors("sow", { checks, known })`
  runs a case when a check is given for its group, and marks it pending when
  none is, or when it is a known failure with its reason.

Each core's `test/vectors.test.ts` calls `describeVectors` for its standard.
Moving a copy to a newer tag follows `tools/check-standards-pin.mjs`, which
also says how the copies are checked.

`standards-pin.json` lists what is pinned today: each file, its tag and its
SHA-256.
