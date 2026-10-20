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

Pinned today:

| Standard | Files | Tag |
|---|---|---|
| Agent SoW | `sow-acts`, `sow-amendment-formation`, `sow-buyer-reference`, `sow-data-use`, `sow-disputes`, `sow-formation-messages`, `sow-nda`, `sow-pricing`, `sow-provider-contact`, `sow-reporting`, `sow-review-window`, `sow-signatures`, `sow-subcontracting`, `sow-terms` | `sow-v0.30.0-draft` |
| Agent NDA | `nda-offer`, `nda-grading`, `nda-lifecycle` | `nda-v0.2.0-draft` |
| Agent Reputations | `fdbk-score-1`, `fdbk-report-v1`, `fdbk-nda-claim-v1`, `fdbk-nda-record-v1` | `reputations-v0.10.0-draft` |
| Agent Mandate | `mandate-documents`, `mandate-checks`, `mandate-ids`, `mandate-proxy`, `mandate-scope` | `mandate-v0.8.0-draft` |
| Agent RFP | `rfp-sealed-body`, `rfp-posting` | `rfp-v0.10.0-draft`, `rfp-v0.11.0-draft` |
