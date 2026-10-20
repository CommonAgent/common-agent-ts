# Agent RFP core

The standard: https://agentrfp.net, 0.10.0-draft.

- `posting.ts`: the posting document, the refusals that keep it answerable,
  the identifier (§4.1), and the signed bytes of the posting and of the acts on
  it (§6), with the `gate` member of a gated posting.
- `lifecycle.ts`: the posting's state (§9), derived on read from the signed
  document, the acts on it and the board's grant count.
- `responses.ts`: the rules a response's own document must meet (§7): whose it
  is, which posting and version it answers, and who it is offered to.
- `gate.ts`: gated postings (§5.11): the split into a public document and a
  sealed body, the gate's refusals, and the release decision once the Agent
  NDA side has answered.
- `crypto.ts`: canonical JSON, the identifier's SHA-256 and Crockford base32,
  and the Ed25519 check, over the shared crypto core. Keys are read as the
  NATS nkeys library reads public signing keys; a curve key is not one.
- `ports.ts`: what this core asks its host for.
  - `NdaGate`: who may read a gated posting's sealed body (§5.11).
  - `ProposalLookup`: the SoW proposal a response names (§7), read as a
    `ProposalDoc`.
  - `MandateCheck`: the authority behind an award, from the Agent Mandate
    core.

Signing takes a `Signer`, whatever holds the key, so the core never sees a
seed. Of the other standards' cores it uses Agent Mandate's types (an award's
authority); a response's SoW proposal is read through its own `ProposalDoc`.

`test/vectors.test.ts` runs the standard's conformance files, `rfp-posting.json`
and `rfp-sealed-body.json`, at their pinned tags.
