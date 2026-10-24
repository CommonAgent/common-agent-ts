# Contributing

Thank you for helping with the reference implementation of the Common Agent
contracting standards.

## Where changes land

The code here is written in a source repository and exported to this one.
The export copies each package's files and checks them before they are
published. This repository is the export, not a fork: the next export
replaces any file here that the source repository writes.

Outside pull requests are welcome all the same. When one is accepted, a
maintainer ports the change to the source repository, and it comes back here
with the next export, with you credited as co-author. The pull request itself
is closed with a link to the export that carries it. Issues can be filed here
as usual.

`tools/monorepo-export.json` lists every file the export writes, and the
source commit the current files came from.

One package is the exception. `packages/package/`, the Agent Package and its
command line tool, is written here, in this repository. The export never
writes or removes a file under it, and a pull request that changes it is
reviewed and merged here as usual.

## What a change must keep

- **The conformance files are the authority.** When a package disagrees with
  a file in `conformance/`, the package is wrong, or the standard has a gap
  that needs raising in
  [CommonAgent/common-agent-standards](https://github.com/CommonAgent/common-agent-standards).
  The copies here are never edited. A newer version arrives as a new tag
  there, and `standards-pin.json` moves to it.
- **The packages stay pure.** `node:crypto` and the other packages here are
  the only imports. No storage, no network, no clock but the one a caller
  passes in. Whatever a package needs from its host goes in its `ports.ts`.
  The Agent Package also uses `node:zlib` for its archive, and its command
  line tool, `packages/package/cli.ts`, is the one file that reads and writes
  a disk.
- **One crypto.** Canonical JSON, keys, signatures and their spellings live in
  `@common-agent/crypto`, so every standard reads them the same way.

## Making a change

1. Fork the repository and create a branch.
2. Make the change, with a test. A change to what a standard requires belongs
   in the standards repository first.
3. Run the checks:

       npm ci
       npm run typecheck
       npm test
       node tools/check-standards-pin.mjs

4. Open a pull request. CI runs the same checks on Node.js 20 and 22.

## Security

Report a vulnerability privately through GitHub's security advisories for
this repository, not in a public issue.

## License

By contributing you agree that your contribution is licensed under
Apache-2.0, the license of this repository.
