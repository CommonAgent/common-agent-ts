# Agent Package

This package implements the Agent Package of the Common Agent Specification
0.41.0, Section 12 (https://commonagent.net/package.html, source in
https://github.com/CommonAgent/common-agent-standards `common-agent/`). It
turns an agent's folder into a package, and it checks a package against the
mechanical checks of Section 12.10.

A package is an Agent Plugin with two files beside its manifest. The draft
Descriptor, `agent-descriptor.json`, holds every fact a caller can rely on.
The runtime requirements, `agent-runtime-requirements.json`, hold every fact
a host must have or an installer must bind. The manifest points at both by
digest, under `descriptor` and `runtime_requirements`, and copies nothing.
`NOT.md`, `RECORDS.md` and `SYSTEMS.md` are generated from the two files,
under `net.agentdoc.package/`.

## The file names

Before Common Agent 0.30.0-draft the two authored files were
`descriptor.json` and `install.json`, the manifest pointed at the second
under `install`, and its format was `"agent-install-v1"`. As Section 12.2
says, this package writes only the current names. It reads each former name
where the current one is absent, and reads the current one where both are
present, in an agent's folder and in a package, so a package built before
the rename still validates. It warns each time it reads a former name, and
each time it finds both. The names are in `names.ts`.

The library holds no storage, makes no network calls and reads no clock. It
reads the agent's folder through the `SourceTree` port and returns the
package as files in memory. It imports `node:crypto`, `node:zlib` for the
gzip layer of the archive, and `@common-agent/crypto` for the build record's
signature. The command line tool in `cli.ts` is the only file that touches a
disk.

## The command line tool

    npx @common-agent/package --help

The tool is called `common-agent-pack`. To pack an agent's folder:

    common-agent-pack <agent-folder> [--out <dir>] [--json] [--seed-file <file>]

The folder holds `agent-descriptor.json`, `agent-runtime-requirements.json`
and `plugin.json` directly, and the skills under `skills/<id>/`. The
manifest carries the agent's name, version and description, and the members
only the build needs, such as `license`, `author` and `repository`. As Section 13.2
says, building adds no fact the source did not state. The packer takes the
two authored files as written and the skills they name, generates the three
views and writes the manifest's digests. It carries each file the Descriptor
names for a view (Section 6.13.6) or for an example's input (Section 6.13.8)
from the same path in the folder, and it warns about any other file it finds
and does not pack. A missing skill is refused, and so is a lockfile whose
digest is absent or wrong; the refusal gives the digest. A draft that does
not say what the agent refuses or what records it leaves is refused, and the
refusal names the part.

It writes `<out>/<name>/`, the archive `<out>/<name>-<version>.tar.gz` and
the build record `<out>/<name>-build.json`. The output folder defaults to
`<folder>/dist`. The record is signed when `--seed-file` names a file that
holds an nkey user seed. Without one, the record is unsigned and says so, as
Section 8.1 rule 3 requires. Every package is a draft, because nobody has run
the agent it describes.

To check a package folder or its archive:

    common-agent-pack validate <package-folder-or-archive> [--json]

It lists every problem it finds, each with the check that found it, and
exits 1 when there is one. It lists the warnings apart from the problems. A
warning never changes the exit code, and the packer gives the same warnings
when it packs.

## The archive

Packing is deterministic, as Section 12.6, rule 5 requires: the same files
pack to the same bytes on any machine at any time, so a record made before a
package is published names the digest the depot will serve. The entries,
folders included, are in the byte order of their paths. Every entry carries
the same modification time, which is zero, and no owner and no group. A
folder and a file under a skill's `scripts/` are marked executable, and no
other file is. The gzip layer is written at one fixed level, with no time
and no operating system in its header. The time of a build is in the build
record and nowhere in the package.

Version 0.1.0 of this package wrote the time its caller gave it into every
entry, so the same files pack to a different digest under this version than
they did under 0.1.0. `test/archive.test.ts` pins the digest of one small
package, which is the same on Windows and on Linux, on x64 and on arm64,
under Node 20, 22 and 24.

## What a package declares

The checker reads these parts of the two authored files, and the packer
refuses a folder whose files fail any of them.

**The model system (Section 12.4.1).** An agent whose scripts call a model
declares it as a system of kind `model`, and at most one. Its entry carries
`name`, `kind` and `protocols`, which is one or more of `anthropic-messages`,
`openai-chat` and `gemini`, and may say what it `spends`. It names no
credential, no variable and no setting, because its four settings have the
same names in every agent.

```json
{ "name": "text-reasoning", "kind": "model", "protocols": ["anthropic-messages", "openai-chat"], "spends": { "unit": "USD" } }
```

**Standing assets (Section 6.14.4).** The Descriptor's `can_use` lists the
kinds of standing asset the agent reads. Each entry names its kind in
`schema` by an absolute `https` URL that no other entry names, lists the
members it reads in `reads`, which is never empty, and says in `does` and in
`without` what the agent does with the asset and without it. An empty list
is a statement that the agent reads none. The `schema` of each entry is the
one address a Descriptor may carry (Section 12.6, rule 3). The checker finds
it by reading the Descriptor's own `can_use`, so a member spelled `schema`
anywhere else in the file is held to the rule.

**Named run configs (Section 12.7).** Each entry of `run_config.named` has a
name no other entry has, sets only settings that `run_config.settings`
declares, gives each a value inside the setting's `allowed` list and `range`
and at or under a numeric rule's ceiling, and carries the digest of its own
entry, computed as Section 5.8 says. A refusal for a digest gives the digest
the entry has.

**The files a Descriptor names (Section 6.13.10).** The file of each view and
of each example's input is in the package and hashes to the digest the
Descriptor gives. A view is one self-contained file that loads nothing from
anywhere, so the checker refuses a view whose file holds an address literal,
as the address check below defines one.

**Address literals in scripts (Section 12.10, the address check).** The
checker reads every file under a skill's `scripts/` folder and every package
file a job's `run` names in its `command`, and no lockfile. An address
literal is `http`, `https`, `ws` or `wss` in any case, then `://` and a
letter, a digit or `[`, or an IPv4 address in 169.254.0.0/16 with or without
a scheme. A literal that begins with one of the seven identifier prefixes the
specification lists is passed. Every other literal is a warning against
Section 12.6, rule 2, with its file, its line and the literal, and never a
refusal. An address a script builds while it runs is not a literal. The
specification says where a literal starts and not where it ends. This
package ends one at the first white space, quote, backtick, angle bracket,
backslash, brace, vertical bar or caret, or at `${`, and leaves off the
punctuation that closes a sentence or a call.

## The spec, which is deprecated

The packer still reads a spec, `agent.json` in the folder or a spec file
named directly, and says that it is deprecated each time. The spec names the agent, says in one sentence what it does, and lists its
jobs, the systems it needs by name, what it refuses, what records it must
leave, and what a host must have. Two parts are never invented. When the spec
does not say what the agent refuses or what records it leaves, the packer
refuses and names the missing part. A credential is a name the host resolves,
never a value.

```json
{
  "name": "explainer-maker",
  "version": "0.1.0",
  "description": "Turns a brief into a narrated interactive explainer.",
  "jobs": [
    { "slug": "check-the-fit", "title": "Check the fit",
      "when": "after every change to the page",
      "good": "nothing clipped at either window size",
      "empty": "report every finding by step",
      "inputs": [ { "name": "page", "kind": "text/html", "required": true } ],
      "outputs": [ { "name": "fit report", "kind": "text", "when": "per_task" } ],
      "scripts": [ "tools/sweep.mjs" ],
      "lockfile": "scripts/package-lock.json" }
  ],
  "systems": [
    { "name": "text-to-speech", "access": "trigger", "needs": "to record the narration",
      "kind": "service", "credential": "tts-key", "env": "TTS_TOKEN",
      "spends": { "unit": "characters" }, "leaves": true }
  ],
  "refuses": [ "stating how long a change takes" ],
  "escalates": [ "every draft goes to a person for review" ],
  "records": [ { "name": "the brief as received", "when": "per_task", "file": "*/brief.md" } ],
  "runtimes": [ { "name": "node", "version": ">=22" } ],
  "binaries": [ { "name": "chromium", "purpose": "renders the page for the fit check" } ]
}
```

A skill folder already under `<folder>/skills/<slug>/` is packed as written,
and its SKILL.md must carry `name` and `description` in its frontmatter. For
any other job the packer writes the SKILL.md from the job's `when`, `good` and
`empty` lines, and copies the `scripts`, `references` and `assets` the job
names. Until one job says `offered`, every job is offered. A job's `steps`
name the jobs it runs, one level deep. A system that spends needs a ceiling, and
the packer writes one per task when the spec gives none. Which side applies
each ceiling, `enforced_by`, is derived and never written in the spec: a
system the scripts reach with a named credential is `runtime`, the model
system is `runtime` because the scripts call it with the key the install
binds, a system reached through a server the host binds (kind `mcp`) is
`platform`, and a spending service with neither is refused. A spec declares
the model system as a system with `"kind": "model"` and its `protocols`.

## Using the library

```ts
import { buildFromFolder, buildRecord, validatePackage, validateArchive } from "@common-agent/package";

const built = buildFromFolder(source);
const record = buildRecord(built, { producedAt: new Date(), signer });
const check = validatePackage(built.files);
```

`buildFromFolder`, and the deprecated `buildPackage(spec, source)`, throw a
`PackRefusal`, whose `missing` names the part when one is missing. Every
package they return passes `validatePackage`, and its `warnings` list what
the packer read but would rather not have, such as an old file name or an
address literal in a script. `validatePackage` returns `warnings` in the
same way, and a warning is never a problem. Neither function takes a time.
The `mtime` option of 0.1.0 is still accepted, so a caller written for it
compiles, and it is no longer read.

| File | What it holds |
|---|---|
| `index.ts` | The public face: `PACKAGE_SPEC`, `validateArchive` and everything below |
| `names.ts` | The authored files' names, pointers and format, current and former |
| `ports.ts` | What the library asks its host for: the `SourceTree` of the agent's folder, and a signer |
| `types.ts` | The spec, the draft Descriptor, the runtime requirements, and a package as files |
| `build.ts` | The packer and its refusals: the draft Descriptor, the runtime requirements, skills, the manifest |
| `validate.ts` | The checker of Section 12.10, with the check each problem comes from |
| `addresses.ts` | The address check of Section 12.10: the address literals in a text, each with its line |
| `manifest.ts` | The pinned Agent Plugins 1.0.0 manifest schema and the namespace |
| `offering.ts` | The offering checks of Section 6.11 |
| `views.ts` | NOT.md, RECORDS.md and SYSTEMS.md, generated |
| `skill.ts` | A generated SKILL.md, and the frontmatter check |
| `archive.ts` | Writing the gzipped ustar archive, the same bytes for the same files, and reading one |
| `record.ts` | The build record of Section 8.2, signed or unsigned, and its check |
| `text.ts` | The one spelling of a JSON file, digests, and the hidden-character scan |
| `cli.ts`, `bin.ts` | The command line tool |

## What the checker does not check

Section 12.10 lists more than a program can decide from a package alone, and
this checker stops short of it in these places.

- It does not look for a credential value in any file. The packer refuses a
  spec whose credential is a value and not a name, and that is all.
- It reads an address in the manifest, the draft Descriptor and the runtime
  requirements as a string that holds `://`. A host name written without a
  scheme is not found.
- The address check is the floor of Section 12.6, rule 2 and not the whole
  of it, as Section 12.10 says. A script that assembles an address from
  pieces passes, and a reviewer reports it.
- It does not read a lockfile's addresses, which rule 3 exempts.
- It checks the draft Descriptor for the members a package carries, not
  against the whole of Section 6. Of a view it checks the file, its digest
  and its addresses, and of an example the file and its digest. It does not
  check a setting's `step`, an example's `good_result`, or a revisions
  policy.
- Section 6.14.4 says a checker should report an agent that writes for a
  person and declares no `can_use`. Whether an agent writes for a person is
  a judgment, and this checker does not make it.
- It does not refuse a member the specification does not define, in either
  authored file.
- An open-ended offering's data use is declared outside the draft, so the
  data-use part of the Section 6.11 check is left out here, as the packer
  leaves it out.

One passage is read strictly. Section 6.13.8 lets an example's input be a
file at a public `https` address, and Section 12.6, rule 3 gives the
Descriptor one excepted address and no other. This package holds a package
to rule 3, so it refuses a draft Descriptor whose example carries an
address.

## The conformance files

`test/vectors.test.ts` runs the declaration cases of the standards'
`offering-scope.json`, pinned in `standards-pin.json`, and this package's own
`test/vectors/package-checks.json`: a base package and cases that each change
it, which a checker must accept or must refuse by the check the case names.
The standards repository has no package fixture yet, and this one is written
in its style so that it can move there.

`test/fixtures/hn-digest/` is an agent's folder as an agent builder wrote it
to Common Agent 0.41.0, with a model system, two kinds of standing asset and
one script. `test/folder.test.ts` packs it and checks the package, and
expects no problem and the two warnings its script's address literals give.
