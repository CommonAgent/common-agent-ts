# Common Agent reference implementation in TypeScript

This repository is the reference implementation of the Common Agent
contracting standards and of the Agent Package. It has one package per
standard and a shared crypto package:

| Package | Standard | Version implemented |
|---|---|---|
| `@common-agent/sow` | [Agent SoW](https://agentsow.com) | 0.30.0-draft |
| `@common-agent/rfp` | [Agent RFP](https://agentrfp.net) | 0.10.0-draft |
| `@common-agent/mandate` | [Agent Mandate](https://agentmandate.net) | 0.8.0-draft |
| `@common-agent/nda` | [Agent NDA](https://agentnda.net) | 0.2.0-draft |
| `@common-agent/reputations` | [Agent Reputations](https://agentreputations.com) | 0.6.0-draft |
| `@common-agent/package` | [Agent Package](https://commonagent.net/package.html), Section 12 of the Common Agent Specification, with the `common-agent-pack` command line tool | 0.29.2-draft |
| `@common-agent/crypto` | Canonical JSON (RFC 8785), Ed25519 (RFC 8032), nkey keys and signature spellings, shared by all five | |

The standards themselves, and the conformance files that test them, are in
[CommonAgent/common-agent-standards](https://github.com/CommonAgent/common-agent-standards).

## What a package holds

Each package holds one standard's documents at the version it implements:
their types, how identifiers and digests are derived, signing and
verification under the standard's own tags, validation, and the lifecycle.
The packages are pure TypeScript on Node's built-in `node:crypto`. They hold
no storage, make no network calls and depend on no platform. Anything a
package needs from its host, such as a registry lookup, a clock reading or a
settlement service, is an interface in its `ports.ts`. The host supplies the
implementation.

A package uses another only where its standard refers to the other one. Agent
SoW, Agent RFP and Agent NDA use Agent Mandate's types for the authority
behind an act. Every package uses `@common-agent/crypto`.

`@common-agent/package` packs an agent's spec and folder into an Agent
Package and validates a package. Its library is pure in the same way, and it
also uses `node:zlib` for the archive's gzip layer. Its command line tool,
`common-agent-pack`, is the one place in this repository that reads and
writes a disk.

## Running the conformance vectors

You need Node.js 20.10 or later.

    npm ci
    npm test

`npm test` runs every package's tests. Each package's `test/vectors.test.ts`
runs its standard's conformance files. Those files are in `conformance/`,
copied byte for byte from the standards repository. `standards-pin.json`
names the tag and the SHA-256 of each copy. To check the copies:

    node tools/check-standards-pin.mjs            # each copy hashes to its pin
    node tools/check-standards-pin.mjs --remote   # each pin is the file at its tag

A case marked `todo` is one the package doesn't run yet, and its name gives
the reason.

To run one package's tests:

    npx vitest run packages/nda

To typecheck and build:

    npm run typecheck
    npm run build

## Using a package

    npm install @common-agent/sow

```ts
import { validateSowDocument, sowSignedBytes, SOW_SPEC } from "@common-agent/sow";
import { verifyTagged, canonicalJSON } from "@common-agent/crypto";
```

Each package's README lists its files and what each one holds.

## Versions

A package's version is the library's version, not the standard's. The table
above gives the version of each standard that the package implements, and
each package exports it as a constant (`SOW_SPEC`, `RFP_SPEC` and the rest).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

Apache-2.0 ([LICENSE](LICENSE)). The Unicode case-folding table in
`@common-agent/reputations` is Unicode data under the Unicode License V3; see
[NOTICE](NOTICE).
