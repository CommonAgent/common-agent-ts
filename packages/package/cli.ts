/**
 * The command line tool, common-agent-pack: the host around the library. It
 * reads the agent's folder, writes the package, its archive and the build
 * record, and validates a package on disk. This file is the only one in the
 * package that touches a disk or reads the clock.
 *
 *   common-agent-pack <folder-or-spec.json> [--out <dir>] [--json] [--seed-file <file>]
 *   common-agent-pack validate <package-folder-or-archive> [--json]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { signerFromUserSeed } from "@common-agent/crypto";
import { PackRefusal, buildPackage } from "./build.js";
import { validateArchive, withIssue } from "./index.js";
import type { SourceTree } from "./ports.js";
import { buildRecord } from "./record.js";
import { dumps } from "./text.js";
import type { PackageFiles } from "./types.js";
import { validatePackage, type Validation } from "./validate.js";

export const USAGE = `usage: common-agent-pack <folder-or-spec.json> [--out <dir>] [--json] [--seed-file <file>]
       common-agent-pack validate <package-folder-or-archive> [--json]

Turn a working agent into an Agent Package (Common Agent Specification,
Section 12, https://commonagent.net/package.html). The folder holds
agent.json, the spec (or name the spec file directly): the agent's name, one
sentence on what it does, its jobs, the systems it needs by name, what it
REFUSES, what it must RECORD, and what a host must have. A skill folder
already under <folder>/skills/<slug>/ is packed as written; anything else is
generated from the spec. Two parts are never invented: if the spec does not
say what the agent refuses or what it records, pack refuses and names the
part. Credentials are named, never carried: a value in the spec is refused.
Writes <out>/<name>/, <out>/<name>-<version>.tar.gz and the build record
<out>/<name>-build.json; --out defaults to <folder>/dist. The record is
signed when --seed-file names a file holding an nkey user seed, and is
unsigned, and says so, otherwise. Nobody has run the result: every package
is a draft.

validate checks a package folder or its .tar.gz against the mechanical
checks of Section 12.10 and lists every problem it finds.`;

/** Where the tool writes and what time it is: the process's own, unless a test passes others. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  now(): Date;
}

const processIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
};

/** Every file under a directory, relative posix paths, in walk order. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/** The spec's folder on disk, as the library's SourceTree. */
export function diskSource(base: string): SourceTree {
  const at = (p: string) => resolve(base, p);
  return {
    kind(p) {
      const f = at(p);
      if (!existsSync(f)) return null;
      const s = statSync(f);
      return s.isDirectory() ? "directory" : s.isFile() ? "file" : null;
    },
    read: (p) => new Uint8Array(readFileSync(at(p))),
    list: (p) => walk(at(p)),
    baseName: (p) => basename(at(p)),
  };
}

/** A package folder on disk, as files. */
export function readPackageDir(dir: string): PackageFiles {
  const files: PackageFiles = new Map();
  for (const rel of walk(dir)) files.set(rel, new Uint8Array(readFileSync(join(dir, rel))));
  return files;
}

interface Flags {
  positional: string[];
  out?: string;
  json: boolean;
  seedFile?: string;
  help: boolean;
}

function parse(argv: string[]): Flags | string {
  const f: Flags = { positional: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") f.json = true;
    else if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--out" || a === "--seed-file") {
      const v = argv[++i];
      if (v === undefined) return `${a} needs a value`;
      if (a === "--out") f.out = v;
      else f.seedFile = v;
    } else if (a.startsWith("--")) return `unknown option ${a}`;
    else f.positional.push(a);
  }
  return f;
}

function cmdPack(target: string, f: Flags, io: Io): number {
  const t = resolve(target);
  if (!existsSync(t)) {
    io.err(`${target} does not exist\n\n${USAGE}`);
    return 1;
  }
  const specPath = statSync(t).isDirectory() ? join(t, "agent.json") : t;
  const srcBase = dirname(specPath);
  if (!existsSync(specPath)) {
    io.err(`${srcBase} has no agent.json; write the spec first (common-agent-pack --help)`);
    return 1;
  }
  let spec: unknown;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (e) {
    io.err(`${specPath} is not valid JSON: ${(e as Error).message}`);
    return 1;
  }
  let signer;
  if (f.seedFile) {
    try {
      signer = signerFromUserSeed(readFileSync(resolve(f.seedFile), "utf8").trim());
    } catch (e) {
      io.err(`${f.seedFile} does not hold an nkey user seed: ${(e as Error).message}`);
      return 1;
    }
  }
  const outDir = resolve(f.out ?? join(srcBase, "dist"));
  const now = io.now();

  let built;
  try {
    built = buildPackage(spec, diskSource(srcBase), { mtime: Math.floor(now.getTime() / 1000) });
  } catch (e) {
    if (!(e instanceof PackRefusal)) throw e;
    if (f.json) {
      io.out(JSON.stringify({ ok: false, act: "refuse", refused: e.message, missing: e.missing }, null, 2));
      return 1;
    }
    io.err(`✗ not packed: ${e.message}${e.missing ? `\n  Add "${e.missing}" to ${specPath} and pack again.` : ""}`);
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  const pkgDir = join(outDir, built.name);
  rmSync(pkgDir, { recursive: true, force: true });
  for (const [rel, bytes] of built.files) {
    const p = join(pkgDir, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
  }
  const tarball = join(outDir, `${built.name}-${built.version}.tar.gz`);
  writeFileSync(tarball, built.archive);
  const requestedBy = (spec as { requested_by?: unknown }).requested_by;
  const record = buildRecord(built, { producedAt: now, requestedBy: typeof requestedBy === "string" ? requestedBy : "self", signer });
  const recordPath = join(outDir, `${built.name}-build.json`);
  writeFileSync(recordPath, dumps(record));

  const { files: _files, archive: _archive, ...summary } = built;
  if (f.json) {
    io.out(JSON.stringify({ ok: true, act: "build", ...summary, package_dir: pkgDir, tarball, record: recordPath, signed: !!signer, draft: true }, null, 2));
    return 0;
  }
  io.out(`⊙ packed ${built.name} ${built.version} as a draft Agent Package`);
  io.out(`  ${built.shape.skills} skill(s)${built.skills_kept ? ` (${built.skills_kept} kept as written)` : ""}, ${built.shape.systems} system(s), ${built.shape.refuses} refusal(s), ${built.shape.records} record(s)`);
  io.out(`  package   ${pkgDir}`);
  io.out(`  archive   ${tarball}`);
  io.out(`  sha256    ${built.sha256}`);
  io.out(`  record    ${recordPath}${signer ? "" : "  (unsigned: no signing key was given)"}`);
  io.out("  Nobody has run this agent. Review the package, then publish it to a depot or hand it to a deployment manager.");
  return 0;
}

function cmdValidate(target: string, f: Flags, io: Io): number {
  const t = resolve(target);
  if (!existsSync(t)) {
    io.err(`${target} does not exist\n\n${USAGE}`);
    return 1;
  }
  let v: Validation;
  if (statSync(t).isDirectory()) {
    v = validatePackage(readPackageDir(t));
    if (v.name !== null && basename(t) !== v.name) v = withIssue(v, `the package's folder is ${basename(t)}, and the package is named ${v.name}`);
  } else {
    const { files: _f, ...rest } = validateArchive(new Uint8Array(readFileSync(t)));
    v = rest;
  }
  if (f.json) {
    io.out(JSON.stringify({ ok: v.ok, act: "validate", target: t, name: v.name, version: v.version, issues: v.issues }, null, 2));
    return v.ok ? 0 : 1;
  }
  if (v.ok) {
    io.out(`✓ ${v.name} ${v.version ?? ""} passes every check of Section 12.10 this tool makes`.replace("  ", " "));
    return 0;
  }
  io.err(`✗ ${t} does not conform (${v.problems.length} problem${v.problems.length === 1 ? "" : "s"}):`);
  for (const p of v.problems) io.err(`  - ${p}`);
  return 1;
}

/** Run the tool on its arguments (without the program name), and answer the exit code. */
export function main(argv: string[], io: Io = processIo): number {
  const f = parse(argv);
  if (typeof f === "string") {
    io.err(`${f}\n\n${USAGE}`);
    return 1;
  }
  if (f.help) {
    io.out(USAGE);
    return 0;
  }
  if (f.positional[0] === "validate") {
    if (f.positional.length !== 2 || f.out || f.seedFile) {
      io.err(USAGE);
      return 1;
    }
    return cmdValidate(f.positional[1], f, io);
  }
  if (f.positional.length !== 1) {
    io.err(USAGE);
    return 1;
  }
  return cmdPack(f.positional[0], f, io);
}
