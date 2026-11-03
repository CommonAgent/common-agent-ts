# AgentDoc

An AgentDoc is one document that says what an agent is, what it offers and
what it refuses. It is built only from what the agent itself publishes, every
line says where it came from, and anything the agent has not said is listed as
not stated.

This package makes, publishes and checks AgentDocs. It implements Chapter 9
of the Common Agent Specification. Read more at https://agentdoc.net.

## Make one for your agent

If your agent speaks A2A, it already serves an agent card. Point the tool at
your agent's address:

    npx @common-agent/agentdoc build https://your-agent.example

It reads the card at `/.well-known/agent-card.json` (or the older
`/.well-known/agent.json`) and writes two files:

    agentdoc-out/.well-known/agentdoc.json   the AgentDoc, for programs
    agentdoc-out/agentdoc.html               the same document as a page for people

You can also give it a card file instead of an address:

    npx @common-agent/agentdoc build ./agent-card.json

## Publish the two files

Put both files on your agent's own site, so these addresses serve them:

    https://your-agent.example/.well-known/agentdoc.json
    https://your-agent.example/agentdoc.html

The JSON sits beside your agent card, so anyone who has your agent's address
can find it. Build again whenever your card changes. An AgentDoc says when it
was built, and an old one is out of date, not wrong.

## Add a signed Descriptor

A card says where your agent is and what skills it lists. It does not say
whom the agent acts for, what it refuses, or what it needs. A Descriptor
does, and your signature on it lets anyone check that it is your agent's own
statement. Three commands:

    npx @common-agent/agentdoc init https://your-agent.example
    npx @common-agent/agentdoc keygen
    npx @common-agent/agentdoc sign agent-descriptor.json --key agent.key

`init` drafts `agent-descriptor.json` from your card. It marks every value it
had to guess, and every member you must fill in, under `_draft` at the top of
the file. Read each one, fix what is wrong, fill in what is missing (whom the
agent acts for, and what it refuses), then delete `_draft`.

`keygen` makes your agent's signing key. It writes the secret to `agent.key`,
readable only by you, and prints the public key. Keep that file secret and out
of version control.

`sign` binds the Descriptor to your key and signs it. It refuses while a guess
is unchecked or a required member is missing, and it says which.

Publish the signed file exactly as written at
`https://your-agent.example/.well-known/agent-descriptor.json`, then run
`build` again. The new AgentDoc cites your Descriptor by the digest of its
bytes, says its signature was verified, and fills the sections the card could
not.

## Check one

    npx @common-agent/agentdoc check https://your-agent.example/.well-known/agentdoc.json
    npx @common-agent/agentdoc check agentdoc.json --fetch-sources

`check` runs the checks of Section 9.10 and prints each problem it finds.
With `--fetch-sources` it also fetches every source the document lists,
checks each digest, and looks for each fact in the sources its section cites.
It exits 0 when the AgentDoc passes, 1 when it does not, and 2 when it cannot
read it.

## What it reads

| Source | Where it comes from | What it fills |
|---|---|---|
| The A2A agent card | `/.well-known/agent-card.json`, or a file | who it is, how to reach it, what it lists |
| The Descriptor | `/.well-known/agent-descriptor.json`, or `--descriptor` | whom it acts for, its offerings, what it refuses, what it reaches and keeps |
| Signed terms | the card's terms extension, or `--terms` | prices, where content is processed, how long it is kept |
| Evaluation records | `--eval-record` | which offerings and questions were confirmed or failed |
| Attestations | `--attestation` | what others published about it |

It verifies each signature it can and records the result per source:
`verified`, `unsigned`, `failed` or `not_checked`. A Descriptor or terms whose
signature fails are listed and not used. Nothing the sources do not say is
ever filled in. It goes in `not_stated` instead.

It never says how much of an agent can be checked from the inside
(`shape.visibility`), because that needs deployment records it does not read.
That member is always named as not stated.

## Use it from code

```ts
import { assemble, check, render } from "@common-agent/agentdoc";

const doc = await assemble({ address: "https://your-agent.example" });
const report = await check(doc);
const page = render(doc);
```

`assemble` also takes `card`, `descriptor`, `terms`, `attestations` and
`evalRecords` directly, and a `fetch` to use. With `package` (a package's
`plugin.json`) and its draft `descriptor`, it writes a package AgentDoc, which
describes what any agent installed from that package will declare.

The JSON Schema is in this package at `schema/agentdoc-v1.schema.json`, and
at https://agentdoc.net/schema/agentdoc-v1.json.

## The checks

`check` reports each finding with one of these rule ids, which every Common
Agent checker shares:

`sources-exist`, `section-has-source`, `source-digest`, `fact-in-source`,
`no-summary-grade`, `visibility-supports-claim`, `decided-by-rule`,
`sells-scope`, `open-offering-members`, `open-ended-no-claim`,
`assembled-at`, `fetched-at`, `not-stated-complete` and `no-default`.

The twelve that read the document alone agree with the Common Agent
Standards' conformance cases (`common-agent/conformance/agentdoc/`), which
this package's tests carry. A finding at level `warn` is something Chapter 9
asks for beyond those cases, and it never makes a document fail.

## Files

| File | What it holds |
|---|---|
| `index.ts` | The public face |
| `assemble.ts` | The assembler, card first |
| `check.ts` | The checks of Section 9.10 |
| `render.ts` | The page |
| `signatures.ts` | The signature checks, the key and signing |
| `descriptor.ts` | The draft Descriptor from a card, and what signing needs |
| `paths.ts` | How `not_stated` paths are read |
| `types.ts` | The AgentDoc and the other shapes |
| `cli.ts`, `bin.ts` | The command line tool, `common-agent-doc` |
