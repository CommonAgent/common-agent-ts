# Agent SoW core

The standard: https://agentsow.com, 0.29.0-draft.

- **Seats name their keys** (§5.1, §6): every seat carries `owner_key`, a
  signature counts for its seat only when made with that key and spelled in
  canonical padded base64, and the registry's attested owner confirms,
  contradicts or leaves unconfirmed each seat (`ownerConfirmation`, through
  the `OwnerResolver` port). Formation always rides on the binding: the
  template's provider seat and the instance's client seat name their keys,
  the template's provider signature counts, and the registry confirms the
  client's owner. A document where no seat names a key was written earlier:
  it stays agreed as a record, its signatures verify as written and are
  unbound, nothing new forms from it, and it can be amended to add each
  seat's key (the key that already signed for the seat).
- **The review window** (§5.8): a proposal carries its signed
  `change_control.proposed_at` and lapses that plus the governing version's
  `review_window_days` (7 by default) later; the proposal may shorten its own
  window and never lengthen it. The counterparty refuses one dated later than
  it was received.
- **Formation in three signed messages** (§5.8, `formation.ts`): the
  proposer's acknowledgement with its deadline, the counterparty's receipt,
  and the proposer's void when no receipt comes by the deadline. Since
  0.29.0-draft each is a JSON object with a closed set of members (`kind`,
  `engagement`, `version`, the approved replacement's `digest`, `formed`,
  `deadline`, `of`, `by`, `key`, `signed_at`, `sig`), signed by its seat's
  `owner_key` over `agent-sow-formation-v1`, one newline, and the JCS of the
  message less `sig` (`signFormationMessage`, `validateFormationMessage`,
  `checkFormationMessage`).
  While it holds no receipt the proposer is formed, unacknowledged: the
  current version for its own acts, the version a request names for the
  request. The counterparty keeps a proposal it approved until the latest
  deadline an acknowledgement can carry, applies only that proposal, byte for
  byte, with the proposer's signature and its own approval, and answers a
  re-sent copy of an acknowledgement it already applied with another receipt.
  It records the acknowledgement's version and deadline, and only the
  proposer's signed void, after that deadline, undoes it. Since 0.28.0-draft
  the counterparty receipts every copy of a void, and the proposer re-sends
  the void daily until it holds that receipt and answers any request that
  names the voided version with the void.
- **`writes`** on a proxy grant names `write` or `amend` per resource (§5.3.1).
- From 0.25.0-draft: `buyer_reference` (§5.17) and `provider_contact` (§5.18).

What it holds, and where:

| File | What |
|---|---|
| `document.ts` | The identifier (§4.1), the frame (§4.2), the contract language (§4.3), and `validateSowDocument`, which runs every clause's validator over a standing proposal or an instance |
| `signing.ts` | The signed bytes and signatures (§6) |
| `lifecycle.ts` | Formation from a standing proposal (§12.1, §12.1.1), the state at an instant and the admission gate (§7.1, §5.7), amendment and its four resolutions (§5.8), termination (§5.9), the cap (§5.5.5) |
| `price.ts` | The price clause: arrangements, rating, settlement lines, the operator fee (§5.5) |
| `clauses.ts` | Scope and the process scope, inputs and grants, deliverables with rights and acceptance, revisions and their arithmetic, volume, change control, termination (§5.2 to §5.9) |
| `disputes.ts`, `confidentiality.ts`, `reporting.ts`, `terms.ts`, `subcontracting.ts` | §5.10 to §5.15 |
| `nda.ts` | The Agent NDA an engagement runs under (§5.16) and its two tests |
| `contact.ts` | §5.17 and §5.18 |
| `parties.ts`, `states.ts` | Parties, the directed proposal, qualifications, approval authority; the document and task states |
| `crypto.ts`, `shared.ts` | JCS, Ed25519 over the family's key spelling, base64, over the shared crypto core; the refusal type and the small patterns |
| `ports.ts` | What this core asks its host for: `Settlement`, `MandateCheck`, `NdaReference`, `OwnerResolver` |

Every broken rule throws a `SowRefusal`: `kind` is `invalid` for a malformed
document and `refused` for an act the rules do not allow in the engagement's
state, and `section` is the clause the refusal cites.

The clause modules began as the TypeScript SDK's `sow.ts`
(agent-messaging-server), which the Rust SDK mirrors and the conformance files
pin. This core depends on the shared crypto core and nothing else but the
Agent Mandate core's types (the authority behind an act).

## Tests

- `test/vectors.test.ts` runs the pinned `sow-*.json` files through the
  conformance-file runner. Each section of a file runs the suites that read it:
  `test/sdk-*.ts`, the SDK's conformance tests carried over line for line and
  collected rather than registered (`test/collect.ts`), and `test/core-*.ts`
  for `sow-nda.json`, `sow-buyer-reference.json`, `sow-provider-contact.json`,
  `sow-signatures.json`, `sow-review-window.json`,
  `sow-amendment-formation.json` and `sow-formation-messages.json`, whose list
  cases each run a case check.
  The one section left pending is `sow-pricing.json`'s `not_covered`, the
  file's own list of what it leaves out, and a test fails if any collected
  suite reads no section its file has, so a suite cannot stop running unseen.
- `test/document.test.ts` and `test/lifecycle.test.ts` cover what no
  conformance file pins yet: the frame, the clauses the SDK stopped short of,
  formation, amendment, termination and the gate.

