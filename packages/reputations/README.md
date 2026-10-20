# Agent Reputations core

The standard: https://agentreputations.com, 0.6.0-draft.

- `index.ts`: the standard's identity, and everything the core offers.
- `score.ts`: the published scoring formula, `fdbk-score-1` (§5, §7), with the uniform prior or a portfolio prior of at most ten effective events (§7.5).
- `pool.ts`: the pool of §7.1 drawn from ledger events in the standard's shape: which events score, with what value and weight.
- `ledger.ts`: the pure rules of the bureau's ledger: the entry and pool
  shapes, which evidence wins an interaction (§6.3), how the scoring pool is
  drawn (§7.1), and what a subject's enrollment acts add up to (§3).
- `report.ts`: the report as data: its signing tags, its shape, and how a
  capability's block and the whole report are built (§8).
- `signing.ts`: signing and verifying a report as 0.6.0 defines it (§8.1.1 to
  §8.1.3): JCS, the signed bytes under the tag, the key set and key ids, the
  envelope, and a verifier that holds every report to a pinned key set. It
  also reads the bureau's older envelope (an nkey and a base64url signature
  over the same bytes), against the same pinned set.
- `heads.ts`: the commitment over every subject's log (§4.1.1, 0.8.0-draft
  and later): the slot key by the canonical caseless form (Unicode D145,
  with the pinned `casefolding-15.1.0.json` beside it, Unicode data under
  `LICENSE-UNICODE`), the sparse Merkle tree, its proofs, the chained
  commitment signed under `fdbk-heads-v1`, the witnesses' co-signatures and
  witness-list changes, and what a later commitment may change.
- `nda-claims.ts` and `nda-record.ts`: claims of breach of an Agent NDA
  (§4.8) and the NDA record (§4.9).
- `ports.ts`: none. A bureau learns about engagements only from the evidence
  it records.

A bureau itself, its ledger database, its signing key and its HTTP doors, is
the host's. `ledger.ts` and `report.ts` also keep an earlier bureau's own
shapes from before 0.6.0, beside the standard's. This core uses no other
standard's core.

The vectors are `fdbk-score-1.json`, `fdbk-report-v1.json`,
`fdbk-heads-v1.json`, `fdbk-nda-claim-v1.json` and `fdbk-nda-record-v1.json`,
pinned at `reputations-v0.10.0-draft`, and
`test/vectors.test.ts` runs them (the heads checks are in
`test/heads-checks.ts`), all of them passing: each score vector's pool drawn from its ledger events (§7.1) and
scored with its prior (§7.5), and every report signing case.
