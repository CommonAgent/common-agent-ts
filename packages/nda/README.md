# Agent NDA core

The pure core of Agent NDA 0.2.0-draft (https://agentnda.net, source in
https://github.com/CommonAgent/common-agent-standards `nda/`). It knows the
agreement and nothing else: no storage, no HTTP, no NATS, no email, no
clearing, and no clock but the instants a caller passes. It imports Node's
the shared crypto core and, for the `nda` power, the Agent Mandate core's
types, and nothing else.

| File | What it holds |
|---|---|
| `index.ts` | The public face: `NDA_SPEC` and everything below |
| `ports.ts` | What the core asks the platform for: mandate answers, the registry's owners, act receipts and handle resolution |
| `types.ts` | The document model, the closed lists, the fixed grades, the three signing tags |
| `crypto.ts` | JCS canonical JSON, SHA-256 digests, Crockford ids, Ed25519 over the family's `U…` key spelling, and the one canonical signature spelling, over the shared crypto core |
| `bytes.ts` | The byte strings (hashed for the id, signed, offer, a record's signature bytes, an act's bytes) and the digests over them (§4.1, §6, §6.1, §7.3, §8) |
| `validate.ts` | The refusals of §11, typed with the codes the conformance fixture uses |
| `records.ts` | The signature records: the closed member set, the digest each carries, whether it verifies, the seat it signs for, and how its key is bound to that seat (§6, §6.2) |
| `signatures.ts` | Signing, accepting an open offer, and the five acceptance checks of §6.1 |
| `acts.ts` | Terminations and withdrawals (§7.3): `{act, signature}` with `by`, `at` no earlier than `signed_at`, and effect at the later of `at` and receipt |
| `state.ts` | The lifecycle of §7.1, derived from signatures, acts and instants |
| `flowdown.ts` | The strictness test for flow-down agreements (§5.5) |
| `references.ts` | The reference shape (§8) and the questions other standards ask: whether a party is bound (§8.1), whether a board may release a gated RFP body (Agent RFP §5.11.3), whether an engagement fits the NDA it names (Agent SoW §5.16), and the agreement's side of a claim of breach (Agent Reputations §4.8) |

## How a signature counts

Each signature signs its own record, so its key, role, seat, instant,
mandate and `digest` are all covered. A record counts for its seat only when
it verifies and its key is bound to the seat (§6):

- a seat without `organization` names its `owner_key`. The receiving
  verifier resolves the registry's owner of the seat's agent at receipt, and
  the binding reads **bound** (an attested owner, the same key),
  **unbound** (an attested owner, another key), or **unconfirmed** (no
  attested owner could be resolved);
- a seat with `organization` signs with the `holder.key` of the mandate its
  record cites, checked at `signed_at` and, where the verifier received it,
  at receipt. Without a mandate lookup the binding reads **unchecked**.

`counts` says whether a signature stands for the agreement's state.
`decides` is stricter, and is what isBound, checkGateRelease and
checkBreachClaim use: an organization's seat decides only with its mandate
**bound** (checked, at signing and at receipt), and an unconfirmed owner
counts only as the recipient of an open offer that says `"owners": "any"`.

A board's release (`checkGateRelease`) is the strictest reader: it needs the
instant it received the acceptance (`receivedAt`), an owner resolver or an
explicit `owners: "none"`, and every organization's seat bound.

## What the host supplies

The core never fetches. What it cannot know arrives as an argument:

- **Mandate answers** (§6.2). `mandateQueries(doc)` lists the checks an
  agreement's signatures call for, and `mandateCheckRequest` turns each into
  the Agent Mandate core's `MandateCheckRequest`. The platform answers them
  through its MandateCheck port, at `signed_at` and at receipt, and passes
  the answers back as a `MandateLookup`.
- **The registry's owners** (`OwnerResolver`), as the receiving verifier
  resolved them at receipt and recorded them.
- **Receipt times**: `receivedAt` for an acceptance or a record,
  `DocReceipts` for the documents `isBound` walks, and `ActReceipts` for
  acts. A reader that holds no receipt has `signed_at` alone, and every
  result says so in `signedAtOnly`.
- **Handle resolution** for offers open to named handles (§6.1 step 4), as a
  `HandleResolver`. Without one, such an acceptance fails step 4.
- **The documents and acts** the host holds, and the reading instant.

The ports other standards define and an NDA host implements
(Agent RFP's `NdaGate`, Agent SoW's `NdaReference`) are answered from
`references.ts`.

## Signing keys

`Signer` is anything with `getPublicKey()` and `sign(bytes)`, which an nkeys
KeyPair already is. A platform that holds keys for its accounts and an owner
who holds their own key look the same here.

## Tests

- `test/vectors.test.ts` runs the pinned conformance files at
  `nda-v0.2.0-draft` (`nda-offer.json`, `nda-grading.json`,
  `nda-lifecycle.json`) through the shared runner, both with the core and
  with an independent verifier of its own, plus Agent SoW's `sow-nda.json`,
  whose cases this core answers.
- `test/core.test.ts` builds and signs documents here and checks the owner,
  mandate and receipt rules and the answers given to the other standards.
- `test/review.test.ts` and `test/review3.test.ts` reproduce each finding of
  the code reviews of this core, one case per finding.
