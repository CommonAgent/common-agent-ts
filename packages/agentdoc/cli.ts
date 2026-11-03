/**
 * The command line tool, common-agent-doc: the host around the library. It
 * is the only file in the package that touches a disk.
 *
 *   common-agent-doc build <agent address | card file> [--descriptor <file|url>] [--out <dir>]
 *   common-agent-doc check <agentdoc file | url> [--fetch-sources]
 *   common-agent-doc init <agent address | card file> [--out agent-descriptor.json]
 *   common-agent-doc keygen [--out agent.key]
 *   common-agent-doc sign <descriptor file> --key <file> [--out <file>]
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { signerFromUserSeed } from "@common-agent/crypto";
import { AGENTDOC_PATH, AssembleError, assembleWithNotes, cardCandidates } from "./assemble.js";
import { check } from "./check.js";
import { draftFromCard, signingProblems } from "./descriptor.js";
import { render } from "./render.js";
import { encodeUserSeed, signDescriptor } from "./signatures.js";
import type { AssembleInput, Finding } from "./types.js";
import { ReadError, fetchJson, isObj, isUrl, isoSecond, parseBytes, type Rec } from "./util.js";
import { VERSION } from "./version.js";

export const USAGE = `common-agent-doc ${VERSION}: make, publish and check an AgentDoc.

An AgentDoc is one document that says what an agent is, what it offers and
what it refuses, built only from what the agent itself publishes. Every line
says where it came from, and anything the agent has not said is listed as
not stated. See https://agentdoc.net

Commands:
  build <address | card file>   write the AgentDoc and its page
  check <file | url>            check an AgentDoc against Section 9.10
  init <address | card file>    draft a Descriptor from the agent's card
  keygen                        make the agent's signing key
  sign <descriptor file>        sign the Descriptor with that key

Run common-agent-doc <command> --help for the details of one command.`;

const HELP: Record<string, string> = {
  build: `common-agent-doc build <agent address | card file> [options]

Reads the agent's A2A card (at /.well-known/agent-card.json, or the older
/.well-known/agent.json) and its signed Descriptor if it serves one (at
/.well-known/agent-descriptor.json), and writes:

  <out>/.well-known/agentdoc.json   the AgentDoc, for programs
  <out>/agentdoc.html               the same document as a page for people

Publish both on the agent's own site, so that
https://your-agent.example/.well-known/agentdoc.json and
https://your-agent.example/agentdoc.html serve them.

Options:
  --descriptor <file|url>   use this Descriptor instead of looking for one
  --terms <file|url>        signed terms (an Agent SoW standing proposal); repeatable
  --attestation <file>      an attestation someone published about the agent; repeatable
  --eval-record <file>      a signed evaluation record about the agent; repeatable
  --out <dir>               where to write (default ./agentdoc-out)
  --json                    print the result as JSON

Exits 0 when the AgentDoc is written and passes every check, 1 when it is
written and a check fails or the Descriptor's signature does not verify, and
2 when nothing could be read.`,
  check: `common-agent-doc check <agentdoc file | url> [--fetch-sources] [--json]

Checks an AgentDoc against the checks of Section 9.10 and prints each
problem it finds. With --fetch-sources it also fetches every source the
document lists, checks each digest, and looks for each fact in the sources
its section cites.

Exits 0 when the AgentDoc passes, 1 when it does not, and 2 when it cannot
be read.`,
  init: `common-agent-doc init <agent address | card file> [--out agent-descriptor.json]

Drafts a Descriptor for your agent from its A2A card. The draft is not bound
to a key and not signed. Every value it had to guess, and every member you
must fill in, is listed under "_draft" at the top of the file. Check each one,
fill in what is missing, delete "_draft", then run keygen and sign.

It never overwrites a file that already exists.`,
  keygen: `common-agent-doc keygen [--out agent.key]

Makes an Ed25519 key for your agent on this machine. It writes the secret
seed to the file, readable only by you, and prints the public key. Keep the
file secret: anyone who has it can sign as your agent. Do not commit it.

It never overwrites a file that already exists.`,
  sign: `common-agent-doc sign <descriptor file> --key <file> [--out <file>]

Binds the Descriptor to your agent's key and signs it, so anyone can check
that it is your agent's own statement (Common Agent Specification, Section
6.6). It writes the signed Descriptor back to the same file unless --out names
another. Publish it at https://your-agent.example/.well-known/agent-descriptor.json
exactly as written: readers cite it by the digest of its bytes.

It refuses a Descriptor that still has guesses to check, or that lacks a
member a signed Descriptor must hold, and says which.`,
};

/** Where the tool writes, what time it is, and how it fetches: the process's own, unless a test passes others. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  now(): Date;
  fetch?: typeof fetch;
  cwd?: string;
}

const processIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
};

interface Flags {
  positional: string[];
  out?: string;
  key?: string;
  descriptor?: string;
  terms: string[];
  attestations: string[];
  evalRecords: string[];
  json: boolean;
  fetchSources: boolean;
  help: boolean;
}

const VALUED = ["--out", "--key", "--descriptor", "--terms", "--attestation", "--eval-record"];

function parse(argv: string[]): Flags | string {
  const f: Flags = { positional: [], terms: [], attestations: [], evalRecords: [], json: false, fetchSources: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") f.json = true;
    else if (a === "--fetch-sources") f.fetchSources = true;
    else if (a === "--help" || a === "-h") f.help = true;
    else if (VALUED.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return `${a} needs a value`;
      if (a === "--out") f.out = v;
      else if (a === "--key") f.key = v;
      else if (a === "--descriptor") f.descriptor = v;
      else if (a === "--terms") f.terms.push(v);
      else if (a === "--attestation") f.attestations.push(v);
      else f.evalRecords.push(v);
    } else if (a.startsWith("--")) return `${a} is not an option this tool knows`;
    else f.positional.push(a);
  }
  return f;
}

class UsageError extends Error {}

/** A file's bytes, or a URL left for the library to fetch. */
function fileOrUrl(io: Io, v: string, what: string): Uint8Array | string {
  if (isUrl(v)) return v;
  const p = resolve(io.cwd ?? process.cwd(), v);
  if (!existsSync(p) || !statSync(p).isFile()) throw new UsageError(`The ${what} ${v} is not a file or an address.`);
  return new Uint8Array(readFileSync(p));
}

function jsonFile(io: Io, v: string, what: string): Rec {
  const p = resolve(io.cwd ?? process.cwd(), v);
  if (!existsSync(p)) throw new UsageError(`The ${what} ${v} does not exist.`);
  const value = parseBytes(new Uint8Array(readFileSync(p)), v);
  if (!isObj(value)) throw new UsageError(`The ${what} ${v} is not a JSON object.`);
  return value;
}

/** The target of build and init: a card file on disk, or an agent's address. */
function target(io: Io, t: string): Pick<AssembleInput, "address" | "card"> {
  const p = resolve(io.cwd ?? process.cwd(), t);
  if (!isUrl(t) && existsSync(p) && statSync(p).isFile()) return { card: new Uint8Array(readFileSync(p)) };
  return { address: t };
}

function printFindings(io: Io, findings: Finding[]): void {
  for (const x of findings) io.err(`  ${x.level === "fail" ? "problem" : "note"}: ${x.message} (${x.rule}, at ${x.path || "the top"})`);
}

const writeJson = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
};

async function cmdBuild(f: Flags, io: Io): Promise<number> {
  const t = f.positional[1];
  if (!t) throw new UsageError("build needs the agent's address or its card file.");
  const input: AssembleInput = {
    ...target(io, t),
    ...(f.descriptor ? { descriptor: fileOrUrl(io, f.descriptor, "Descriptor") } : {}),
    ...(f.terms.length ? { terms: f.terms.map((x) => fileOrUrl(io, x, "terms")) } : {}),
    ...(f.attestations.length ? { attestations: f.attestations.map((x) => jsonFile(io, x, "attestation")) } : {}),
    ...(f.evalRecords.length ? { evalRecords: f.evalRecords.map((x) => jsonFile(io, x, "evaluation record")) } : {}),
    now: io.now(),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };
  const { doc, notes } = await assembleWithNotes(input);
  const outDir = resolve(io.cwd ?? process.cwd(), f.out ?? "agentdoc-out");
  const jsonPath = join(outDir, ...AGENTDOC_PATH.split("/").filter(Boolean));
  const htmlPath = join(outDir, "agentdoc.html");
  writeJson(jsonPath, doc);
  writeFileSync(htmlPath, render(doc));
  const report = await check(doc);
  const descriptorFailed = doc.sources.some((s) => s.kind === "agent-descriptor" && s.signature === "failed");
  const code = report.ok && !descriptorFailed ? 0 : 1;
  if (f.json) {
    io.out(JSON.stringify({ ok: code === 0, agentdoc: jsonPath, page: htmlPath, sources: doc.sources.map((s) => ({ id: s.id, kind: s.kind, signature: s.signature })), not_stated: doc.not_stated, notes, findings: report.findings }, null, 2));
    return code;
  }
  for (const n of notes) io.err(`  ${n}`);
  io.out(`Wrote the AgentDoc for ${doc.subject?.name ?? doc.subject?.id ?? "the agent"}.`);
  io.out(`  ${jsonPath}`);
  io.out(`  ${htmlPath}`);
  for (const s of doc.sources) io.out(`  source ${s.id}: ${s.kind}, ${s.signature === "verified" ? "signature verified" : s.signature === "failed" ? "signature does NOT verify" : s.signature === "not_checked" ? "signature not checked" : "not signed"}${s.not_used ? `, not used: ${String(s.not_used)}` : ""}`);
  io.out(`  ${doc.not_stated.length} thing${doc.not_stated.length === 1 ? " is" : "s are"} listed as not stated.`);
  if (!doc.sources.some((s) => s.kind === "agent-descriptor")) {
    io.out("  It has no Descriptor yet. To add a signed one: common-agent-doc init, then keygen, then sign.");
  }
  printFindings(io, report.findings);
  io.out("Publish both files on the agent's site: the JSON at /.well-known/agentdoc.json and the page at /agentdoc.html.");
  return code;
}

async function cmdCheck(f: Flags, io: Io): Promise<number> {
  const t = f.positional[1];
  if (!t) throw new UsageError("check needs an AgentDoc file or address.");
  let value: unknown;
  if (isUrl(t)) value = (await fetchJson(io.fetch ?? globalThis.fetch, t, isoSecond(io.now()))).value;
  else {
    const p = resolve(io.cwd ?? process.cwd(), t);
    if (!existsSync(p)) throw new UsageError(`${t} does not exist.`);
    value = parseBytes(new Uint8Array(readFileSync(p)), t);
  }
  if (!isObj(value) || value.agentdoc !== "v1") throw new UsageError(`${t} is not an AgentDoc: it has no "agentdoc": "v1".`);
  const report = await check(value, { fetchSources: f.fetchSources, ...(io.fetch ? { fetch: io.fetch } : {}) });
  if (f.json) {
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  const fails = report.findings.filter((x) => x.level === "fail").length;
  printFindings(io, report.findings);
  io.out(report.ok ? `The AgentDoc passes every check${f.fetchSources ? "" : " that reads the document alone. Add --fetch-sources to check its sources too"}.` : `The AgentDoc has ${fails} problem${fails === 1 ? "" : "s"}.`);
  return report.ok ? 0 : 1;
}

async function cmdInit(f: Flags, io: Io): Promise<number> {
  const t = f.positional[1];
  if (!t) throw new UsageError("init needs the agent's address or its card file.");
  const outPath = resolve(io.cwd ?? process.cwd(), f.out ?? "agent-descriptor.json");
  if (existsSync(outPath)) throw new UsageError(`${outPath} already exists. Choose another --out, or move it first.`);
  const tg = target(io, t);
  let card: unknown;
  if (tg.card) card = parseBytes(tg.card as Uint8Array, t);
  else {
    const fx = io.fetch ?? globalThis.fetch;
    for (const url of cardCandidates(t)) {
      try {
        card = (await fetchJson(fx, url, isoSecond(io.now()))).value;
        break;
      } catch (e) {
        if (!(e instanceof ReadError && e.status === 404)) throw e;
      }
    }
    if (card === undefined) throw new ReadError(`No A2A Agent Card was found at ${t}.`);
  }
  if (!isObj(card)) throw new UsageError("The agent card is not a JSON object.");
  const draft = draftFromCard(card);
  writeJson(outPath, draft);
  const d = draft._draft as { guesses: string[]; fill_in: string[] };
  io.out(`Wrote a draft Descriptor to ${outPath}.`);
  io.out(`  ${d.guesses.length} guess${d.guesses.length === 1 ? "" : "es"} to check and ${d.fill_in.length} member${d.fill_in.length === 1 ? "" : "s"} to fill in, listed under "_draft" in the file.`);
  io.out("  When it is right, delete \"_draft\", then run: common-agent-doc keygen, and common-agent-doc sign " + (f.out ?? "agent-descriptor.json") + " --key agent.key");
  return 0;
}

async function cmdKeygen(f: Flags, io: Io): Promise<number> {
  const outPath = resolve(io.cwd ?? process.cwd(), f.out ?? "agent.key");
  if (existsSync(outPath)) throw new UsageError(`${outPath} already exists. This tool never overwrites a key. Choose another --out.`);
  const seed = encodeUserSeed(new Uint8Array(randomBytes(32)));
  const key = signerFromUserSeed(seed).getPublicKey();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${seed}\n`, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(outPath, 0o600);
  } catch {
    /* a filesystem without modes keeps what it can */
  }
  if (f.json) {
    io.out(JSON.stringify({ public_key: key, key_file: outPath }, null, 2));
    return 0;
  }
  io.out(`Made a signing key for your agent.`);
  io.out(`  public key  ${key}`);
  io.out(`  secret      ${outPath} (readable only by you)`);
  io.out("  Keep the secret file safe and out of version control. Anyone who has it can sign as your agent.");
  return 0;
}

async function cmdSign(f: Flags, io: Io): Promise<number> {
  const t = f.positional[1];
  if (!t) throw new UsageError("sign needs the Descriptor file.");
  if (!f.key) throw new UsageError("sign needs --key <file>, the file keygen wrote.");
  const d = jsonFile(io, t, "Descriptor");
  const problems = signingProblems(d);
  if (problems.length) {
    io.err(`The Descriptor is not ready to sign:`);
    for (const p of problems) io.err(`  - ${p}`);
    return 1;
  }
  const keyPath = resolve(io.cwd ?? process.cwd(), f.key);
  if (!existsSync(keyPath)) throw new UsageError(`The key file ${f.key} does not exist. Make one with common-agent-doc keygen.`);
  let signed: Rec;
  try {
    signed = signDescriptor(d, readFileSync(keyPath, "utf8").trim());
  } catch (e) {
    const m = (e as Error).message;
    io.err(/not an nkey user seed/.test(m) ? `${f.key} does not hold a key this tool made (an nkey user seed, SU...).` : m);
    return 1;
  }
  const outPath = resolve(io.cwd ?? process.cwd(), f.out ?? t);
  writeJson(outPath, signed);
  io.out(`Signed the Descriptor as ${(signed.subject as Rec).id}.`);
  io.out(`  ${outPath}`);
  io.out("  Publish this file exactly as written at https://your-agent.example/.well-known/agent-descriptor.json, then run common-agent-doc build again.");
  return 0;
}

/** Run the tool on its arguments (without the program name), and answer the exit code. */
export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const f = parse(argv);
  if (typeof f === "string") {
    io.err(`${f}\n\n${USAGE}`);
    return 2;
  }
  const cmd = f.positional[0];
  if (!cmd || (cmd === "help" && !f.positional[1])) {
    (f.help || cmd === "help" ? io.out : io.err)(USAGE);
    return f.help || cmd === "help" ? 0 : 2;
  }
  const name = cmd === "help" ? f.positional[1]! : cmd;
  if (!HELP[name]) {
    io.err(`${name} is not a command this tool knows.\n\n${USAGE}`);
    return 2;
  }
  if (f.help || cmd === "help") {
    io.out(HELP[name]!);
    return 0;
  }
  try {
    switch (name) {
      case "build": return await cmdBuild(f, io);
      case "check": return await cmdCheck(f, io);
      case "init": return await cmdInit(f, io);
      case "keygen": return await cmdKeygen(f, io);
      default: return await cmdSign(f, io);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof AssembleError || e instanceof ReadError) {
      io.err(e.message);
      return 2;
    }
    throw e;
  }
}
