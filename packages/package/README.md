# Agent Package

This package implements the Agent Package of the Common Agent Specification
0.29.2-draft, Section 12 (https://commonagent.net/package.html, source in
https://github.com/CommonAgent/common-agent-standards `common-agent/`). It
turns an agent's folder into a package, and it checks a package against the
mechanical checks of Section 12.10.

A package is an Agent Plugin with two files beside its manifest. The draft
Descriptor, `agent-descriptor.json`, holds every fact a caller can rely on.
The install file, `agent-runtime-requirements.json`, holds every fact a host
must act on. The manifest points at both by digest and copies nothing.
`NOT.md`, `RECORDS.md` and `SYSTEMS.md` are generated from the two files,
under `net.agentdoc.package/`.

## The file names

The two authored files were called `descriptor.json` and `install.json`
until they were renamed. This package writes only the new names. It reads
the old names as aliases, with a warning, in an agent's folder and in a
package, so a package built under them still validates. A package or folder
that holds both names for one file is refused. The names are in `names.ts`.
The specification, at 0.29.2-draft, still gives the old names in Section
12.2; the change to the standard is to follow.

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
only the build needs, such as `license`, `author` and `repository`. The
packer takes the two authored files as written, fills the digest of each
lockfile the runtime requirements name without one, points the manifest at
both files by digest, and generates the three views and any SKILL.md an
offering or a step lacks. A draft that does not say what the agent refuses or
what records it leaves is refused, and the refusal names the part.

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
| `names.ts` | The two authored files' names, and their names before the rename |
| `ports.ts` | What the library asks its host for: the `SourceTree` of the agent's folder, and a signer |
| `types.ts` | The spec, the draft Descriptor, the install file, and a package as files |
| `build.ts` | The packer and its refusals: the draft Descriptor, the install file, skills, the manifest |
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
