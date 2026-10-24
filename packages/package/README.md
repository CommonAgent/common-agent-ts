# Agent Package

This package implements the Agent Package of the Common Agent Specification
0.30.0-draft, Section 12 (https://commonagent.net/package.html, source in
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
views and writes the manifest's digests. A missing skill is refused, and so
is a lockfile whose digest is absent or wrong; the refusal gives the digest.
A draft that does not say what the agent refuses or what records it leaves is
refused, and the refusal names the part.

It writes `<out>/<name>/`, the archive `<out>/<name>-<version>.tar.gz` and
the build record `<out>/<name>-build.json`. The output folder defaults to
`<folder>/dist`. The record is signed when `--seed-file` names a file that
holds an nkey user seed. Without one, the record is unsigned and says so, as
Section 8.1 rule 3 requires. Every package is a draft, because nobody has run
the agent it describes.

To check a package folder or its archive:

    common-agent-pack validate <package-folder-or-archive> [--json]

It lists every problem it finds, each with the check that found it, and
exits 1 when there is one.

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
system the scripts reach with a named credential is `runtime`, a system
reached through a server the host binds (kind `mcp`) is `platform`, and a
spending service with neither is refused.

## Using the library

```ts
import { buildFromFolder, buildRecord, validatePackage, validateArchive } from "@common-agent/package";

const built = buildFromFolder(source, { mtime: Math.floor(Date.now() / 1000) });
const record = buildRecord(built, { producedAt: new Date(), signer });
const check = validatePackage(built.files);
```

`buildFromFolder`, and the deprecated `buildPackage(spec, source)`, throw a
`PackRefusal`, whose `missing` names the part when one is missing. Every
package they return passes `validatePackage`, and its `warnings` list what
the packer read but would rather not have, such as an old file name.
`validatePackage` returns `warnings` in the same way, and a warning is never
a problem.

| File | What it holds |
|---|---|
| `index.ts` | The public face: `PACKAGE_SPEC`, `validateArchive` and everything below |
| `names.ts` | The authored files' names, pointers and format, current and former |
| `ports.ts` | What the library asks its host for: the `SourceTree` of the agent's folder, and a signer |
| `types.ts` | The spec, the draft Descriptor, the runtime requirements, and a package as files |
| `build.ts` | The packer and its refusals: the draft Descriptor, the runtime requirements, skills, the manifest |
| `validate.ts` | The checker of Section 12.10, with the check each problem comes from |
| `manifest.ts` | The pinned Agent Plugins 1.0.0 manifest schema and the namespace |
| `offering.ts` | The offering checks of Section 6.11 |
| `views.ts` | NOT.md, RECORDS.md and SYSTEMS.md, generated |
| `skill.ts` | A generated SKILL.md, and the frontmatter check |
| `archive.ts` | Writing and reading the gzipped ustar archive |
| `record.ts` | The build record of Section 8.2, signed or unsigned, and its check |
| `text.ts` | The one spelling of a JSON file, digests, and the hidden-character scan |
| `cli.ts`, `bin.ts` | The command line tool |

## What the checker does not check

Section 12.10 lists more than a program can decide from a package alone. The
checker here does not look for a credential value inside scripts or
references, does not report an address a script calls (rule 2), does not
read a lockfile's addresses, does not check named run configs or a revisions
policy, and checks the draft Descriptor only for the members a package
carries, not against the whole of Section 6. An open-ended offering's data use
is declared outside the draft, so the data-use part of the Section 6.11 check
is left out here, as the packer leaves it out.

## The conformance files

`test/vectors.test.ts` runs the declaration cases of the standards'
`offering-scope.json`, pinned in `standards-pin.json`, and this package's own
`test/vectors/package-checks.json`: a base package and cases that each change
it, which a checker must accept or must refuse by the check the case names.
The standards repository has no package fixture yet, and this one is written
in its style so that it can move there.
