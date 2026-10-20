# Agent Mandate core

The standard: https://agentmandate.net, 0.8.0-draft. This code implements the `nda` power and `scope.nda_categories` (§6 rules 3, 4 and 8),
the holder key a mandate holding `nda` carries (§6 rule 2), the check for an
Agent NDA (§7.2), and identifiers that are never re-derived by a reader (§4).

- `index.ts`: the standard's identity, `MandateCheck` (the check at approval,
  §7, that Agent RFP and Agent SoW ask for), and the public face of the files
  below. Code outside this core imports from `index.ts` and `ports.ts` only.
- `mandate-doc.ts`: charters (§5), mandates (§6) and resolve acts (§13); their
  ids, canonical bytes and signatures; the narrowing rule; the chain to root
  authority.
- `mandate-check.ts`: the five checks at approval, and the check for an
  Agent NDA in their place, run over a `MandateRegistryView` the registry's
  store answers.
- `domain-proof.ts`: what counts as proof of domain control (§5.1). The probe
  that reaches DNS and HTTPS is an interface; the host supplies the one that
  goes to the network.
- `crypto.ts`: canonical JSON and the tagged Ed25519 check, over the shared
  crypto core. Keys are read as the NATS nkeys library reads public signing
  keys (server, operator, cluster, account and user); a curve key is not one.
- `ports.ts`: what this core asks its host for. Nothing yet.
- `test/vectors.test.ts` and `test/pinned.test.ts`: the conformance files the
  standards repository publishes at `mandate/conformance/`, at their pinned
  tag.

A registry's process, its store, its routes and the gate in front of SoW
approvals are the host's. This core uses no other standard's core.
