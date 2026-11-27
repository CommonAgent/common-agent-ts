/**
 * A package's `mcp.json` (Common Agent 0.44.0, Sections 12.4 and 12.10): the
 * MCP servers whose address is fixed in the package, in the format of Agent
 * Plugins 1.0.0, Section 7.2. A public server is reached over HTTPS; a program
 * the package ships is started over stdio, with every path spelled from
 * `${PLUGIN_ROOT}` or `${PLUGIN_DATA}`. A server the organization binds at
 * install has no entry here: its address is not known when the package is
 * made, and the runtime requirements carry it.
 *
 * Every server is a declared system of kind `mcp` (12.6 rule 2). `mcp.json` is
 * visible package data and never a secret store (Agent Plugins 7.2.1 and 9.2),
 * so an `env` entry or a header that carries a credential is refused. The
 * client that connects to such a server manages its authorization, so its
 * system names no credential, and nothing in the path can hold a ceiling on
 * it, so the system does not spend.
 */
import { MCP_SCHEMA_URL } from "./manifest.js";

/** The members each kind of server may carry, and nothing else (Agent Plugins 1.0.0, 7.2.1). */
export const MCP_VARIANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  stdio: ["type", "command", "args", "env", "cwd"],
  "streamable-http": ["type", "url", "headers"],
  sse: ["type", "url", "headers"],
});

const RESERVED_ENV = ["PLUGIN_ROOT", "PLUGIN_DATA"];
const CWD_RE = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A name that says it carries a credential. */
const SECRET_NAME_RE = /auth|token|secret|passw|apikey|api[-_]key|cookie|session|credential|bearer|private[-_]?key/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A path in a stdio server's args or env that does not go through a plugin variable. */
const outsidePath = (v: string): boolean => /^(?:\/|~|\.\/|\.\.(?:\/|\\|$)|[A-Za-z]:[\\/]|\\\\)/.test(v) || v.includes("/../") || v.includes("\\..\\");

/** Whether a host is this machine, where plain HTTP is allowed (Agent Plugins 1.0.0, 7.2.1). */
const isLoopback = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "::1";
};

/** The problems with one stdio server, in words. */
function stdioProblems(at: string, s: Record<string, unknown>): string[] {
  const out: string[] = [];
  const cmd = s.command;
  if (typeof cmd !== "string" || !cmd || /\s|\$/.test(cmd)) out.push(`${at}: command is one executable token with no placeholder, not a shell command`);
  else if (/[\\/]/.test(cmd) && !(cmd.startsWith("./") && !cmd.includes("\\") && !cmd.split("/").includes(".."))) out.push(`${at}: command is a bare program name or a path inside the package that starts with ./`);
  const args = s.args ?? [];
  if (!(Array.isArray(args) && args.every((a) => typeof a === "string"))) out.push(`${at}: args is a list of strings`);
  const env = s.env ?? {};
  if (!(isObj(env) && Object.values(env).every((v) => typeof v === "string"))) out.push(`${at}: env maps each variable to a string`);
  for (const k of Object.keys(isObj(env) ? env : {})) {
    if (RESERVED_ENV.includes(k.toUpperCase())) out.push(`${at}: env names ${k}, which the client sets itself (Agent Plugins 1.0.0, 9.2)`);
    if (SECRET_NAME_RE.test(k)) out.push(`${at}: env ${k} is named for a credential; mcp.json is visible package data and carries none (Agent Plugins 1.0.0, 9.2)`);
  }
  const values = [...(Array.isArray(args) ? args : []), ...Object.values(isObj(env) ? env : {})];
  for (const v of values) {
    if (typeof v === "string" && outsidePath(v)) out.push(`${at}: ${JSON.stringify(v)} is a path that is not spelled from \${PLUGIN_ROOT} or \${PLUGIN_DATA}`);
  }
  const cwd = s.cwd;
  if (cwd !== undefined && !(typeof cwd === "string" && CWD_RE.test(cwd) && !cwd.split(/[\\/]/).includes(".."))) out.push(`${at}: cwd starts with ./, \${PLUGIN_ROOT} or \${PLUGIN_DATA} and stays inside it (Agent Plugins 1.0.0, 7.2.1)`);
  return out;
}

/** The problems with one remote server, in words. */
function remoteProblems(at: string, s: Record<string, unknown>): string[] {
  const out: string[] = [];
  let u: URL | null = null;
  if (typeof s.url === "string" && s.url && !s.url.includes("$") && !/\s/.test(s.url)) {
    try { u = new URL(s.url); } catch { u = null; }
  }
  if (!u || !["https:", "http:"].includes(u.protocol) || !u.hostname) out.push(`${at}: url is the server's absolute https address, with no placeholder`);
  else {
    if (u.username || u.password) out.push(`${at}: url carries user information, which is a credential in the address (Agent Plugins 1.0.0, 7.2.1)`);
    if ((s.url as string).includes("#")) out.push(`${at}: url carries a fragment (Agent Plugins 1.0.0, 7.2.1)`);
    if (u.protocol === "http:" && !isLoopback(u.hostname)) out.push(`${at}: a server that is not on this machine is reached over https (Agent Plugins 1.0.0, 7.2.1)`);
  }
  const headers = s.headers ?? {};
  if (!(isObj(headers) && Object.values(headers).every((v) => typeof v === "string"))) return [...out, `${at}: headers maps each header to a string`];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(k) || /[\r\n\0]/.test(String(v))) out.push(`${at}: header ${JSON.stringify(k)} is not a valid HTTP header`);
    if (seen.has(k.toLowerCase())) out.push(`${at}: header ${k} is given twice (Agent Plugins 1.0.0, 7.2.1)`);
    seen.add(k.toLowerCase());
    if (SECRET_NAME_RE.test(k) || /^(?:bearer|basic)\s/i.test(String(v))) out.push(`${at}: header ${k} carries a credential; headers are visible package data, and the client manages a server's authorization (Agent Plugins 1.0.0, 7.2.1)`);
  }
  return out;
}

/**
 * The problems with a package's `mcp.json`, in words, given the systems its
 * runtime requirements declare. Empty when it conforms.
 */
export function mcpProblems(doc: unknown, systems: readonly Record<string, unknown>[]): string[] {
  if (!isObj(doc)) return ["mcp.json is a JSON object"];
  const out: string[] = [];
  const keys = Object.keys(doc).sort();
  if (keys.join(",") !== "$schema,mcpServers") out.push("mcp.json is an object with $schema and mcpServers and nothing else (Agent Plugins 1.0.0, 7.2.1)");
  if (doc.$schema !== MCP_SCHEMA_URL) out.push(`mcp.json must declare ${MCP_SCHEMA_URL}, the version of Agent Plugins plugin.json declares (7.2.2)`);
  if (!isObj(doc.mcpServers)) return [...out, "mcp.json mcpServers maps each server's name to its configuration"];
  const byName = new Map(systems.map((s) => [String(s.name ?? s.role ?? ""), s]));
  for (const [name, s] of Object.entries(doc.mcpServers)) {
    const at = `mcp.json server ${name}`;
    const sys = byName.get(name);
    if (!sys || sys.kind !== "mcp") out.push(`${at}: every server is a system the agent declares, of kind mcp, under the same name (Common Agent 12.6 rule 2)`);
    else {
      if ((sys.credential !== undefined && sys.credential !== null) || (sys.env !== undefined && sys.env !== null)) out.push(`${at}: the client that connects to a server mcp.json names manages its authorization, so its system names no credential`);
      if (sys.spends !== undefined && sys.spends !== null) out.push(`${at}: the harness reaches a server mcp.json names directly, so nothing in the path can hold a ceiling on what it spends; a spending MCP system is bound at install`);
    }
    if (!isObj(s) || typeof s.type !== "string" || !(s.type in MCP_VARIANTS)) {
      out.push(`${at}: type is one of ${Object.keys(MCP_VARIANTS).join(", ")}`);
      continue;
    }
    const extra = Object.keys(s).filter((k) => !MCP_VARIANTS[s.type as string]!.includes(k));
    if (extra.length) out.push(`${at}: ${extra.join(", ")} is not a member of a ${s.type} server (Agent Plugins 1.0.0, 7.2.1)`);
    out.push(...(s.type === "stdio" ? stdioProblems(at, s) : remoteProblems(at, s)));
  }
  return out;
}
