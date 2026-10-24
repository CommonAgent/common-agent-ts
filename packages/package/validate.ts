/**
 * The checker of Common Agent 12.10, over a package's files: what can be
 * verified mechanically, without a network, a clock or a host. It answers a
 * list of problems in words; an empty list is a package that passes every
 * check here. The README lists what it does not check.
 */
import { PACKAGE_NS, manifestProblem } from "./manifest.js";
import { AUTHORED_FILES, DESCRIPTOR_FILE, RUNTIME_REQUIREMENTS_FILE, legacyWarning, resolveName, type AuthoredKind } from "./names.js";
import { isDataUseProblem, offeringScopeProblems, type SystemRef } from "./offering.js";
import { hasSkillFrontmatter } from "./skill.js";
import { codepointName, hiddenInFile, sha256Hex, utf8Text } from "./text.js";
import type { DraftDescriptor, InstallFile, PackageFiles } from "./types.js";
import { generatedViews, systemName } from "./views.js";

/** The fixed words of `how` (Common Agent 12.3), member by member. */
export const HOW_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  control: ["script", "model", "person"],
  intelligence: ["none", "called", "open"],
  cost: ["none", "metered", "unbounded"],
  contract: ["full", "ends", "goal"],
});

/** The placeholders a `run` command may carry (Common Agent 12.3); `per_file` adds two of its own. */
export const RUN_PLACEHOLDERS = Object.freeze(["home", "package", "records", "work", "job_dir", "message_id", "sender", "handle", "in_reply_to"]);
export const PER_FILE_PLACEHOLDERS = Object.freeze(["file_path", "file_media_type"]);

/** One problem, and the check of 12.10 that found it. */
export interface Issue {
  check: string;
  message: string;
}

/** What the validator found. */
export interface Validation {
  ok: boolean;
  /** Each problem with the check that found it: layout, manifest, descriptor, offering, how-run, install, systems, ceilings, dependencies, skills, mcp, views or hidden. */
  issues: Issue[];
  /** The manifest's name and version, when it has them. */
  name: string | null;
  version: string | null;
  problems: string[];
  /** What the validator read but would rather not have, such as an authored file under its old name. A warning is not a problem. */
  warnings: string[];
}

const parseJson = (files: PackageFiles, path: string, add: (check: string, message: string) => void): unknown => {
  const b = files.get(path);
  if (!b) {
    add("layout", `${path} is missing`);
    return undefined;
  }
  try {
    return JSON.parse(utf8Text(b));
  } catch (e) {
    add("layout", `${path} is not valid JSON: ${(e as Error).message}`);
    return undefined;
  }
};

/** Every string in a JSON value that holds an address, with its path (`a.b[2].c`). */
function addresses(v: unknown, path = ""): { path: string; value: string }[] {
  if (typeof v === "string") return v.includes("://") ? [{ path, value: v }] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => addresses(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => addresses(x, path ? `${path}.${k}` : k));
  return [];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The problems with one job's or step's `how` and `run`. */
function howRunProblems(o: Record<string, unknown>, where: string): string[] {
  const out: string[] = [];
  const how = o.how;
  if (how !== undefined) {
    if (!isObj(how)) out.push(`${where}: how is an object`);
    else {
      for (const [k, v] of Object.entries(how)) {
        if (!(k in HOW_VALUES)) out.push(`${where}: how.${k} is not one of ${Object.keys(HOW_VALUES).join(", ")}`);
        else if (!HOW_VALUES[k].includes(v as string)) out.push(`${where}: how.${k} "${String(v)}" is not one of ${HOW_VALUES[k].join(", ")}`);
      }
      if (how.control === "model" && how.contract === "full") out.push(`${where}: how says control model with contract full, which 12.3 refuses (a written method left to a model to improvise)`);
      if (how.control === "script" && how.intelligence === "open") out.push(`${where}: how says control script with intelligence open, which 12.3 refuses (a program that hands the work to a model)`);
    }
  }
  const run = o.run;
  if (run !== undefined) {
    const h = isObj(how) ? how : {};
    if (h.control !== "script" || h.intelligence === "open") out.push(`${where}: run needs how.control script and an intelligence that is not open`);
    if (!isObj(run)) out.push(`${where}: run is an object`);
    else {
      const cmd = run.command;
      if (!Array.isArray(cmd) || !cmd.length || !cmd.every((c) => typeof c === "string" && c)) out.push(`${where}: run.command is the argument vector, a non-empty list of strings`);
      const check = (vals: unknown, member: string, allowed: readonly string[]) => {
        const list = Array.isArray(vals) ? vals : [vals];
        for (const s of list) {
          if (typeof s !== "string") continue;
          for (const m of s.matchAll(/\{([a-z_]+)\}/g)) if (!allowed.includes(m[1])) out.push(`${where}: run.${member} uses {${m[1]}}, which is not a placeholder 12.3 lists`);
        }
      };
      check(cmd, "command", RUN_PLACEHOLDERS);
      if (run.per_file !== undefined) check(run.per_file, "per_file", [...RUN_PLACEHOLDERS, ...PER_FILE_PLACEHOLDERS]);
      if (run.message_file !== undefined) check(run.message_file, "message_file", RUN_PLACEHOLDERS);
      if (run.reply !== undefined && !(run.reply === "stdout" || (typeof run.reply === "string" && /^json:.+/.test(run.reply)))) out.push(`${where}: run.reply is stdout or json:<member>`);
      if (run.escalate_when !== undefined && !(typeof run.escalate_when === "string" && /^json:.+/.test(run.escalate_when))) out.push(`${where}: run.escalate_when is json:<member>`);
    }
  }
  return out;
}

/**
 * Check a package's files (paths relative to its folder) against the
 * mechanical checks of Common Agent 12.10.
 */
export function validatePackage(files: PackageFiles): Validation {
  const issues: Issue[] = [];
  let section = "manifest";
  const add = (check: string, message: string) => issues.push({ check, message });
  const problem = (message: string) => add(section, message);
  // The two authored files, under their names or, with a warning, their old ones.
  const warnings: string[] = [];
  const located: Record<AuthoredKind, string> = { descriptor: DESCRIPTOR_FILE, runtime: RUNTIME_REQUIREMENTS_FILE };
  for (const kind of ["descriptor", "runtime"] as const) {
    const r = resolveName((p) => files.has(p), kind);
    const f = AUTHORED_FILES[kind];
    if (r.both) add("layout", `${f.name} and ${f.legacy} are both present; a package carries one of them`);
    if (r.legacy) warnings.push(legacyWarning(kind));
    if (r.path) located[kind] = r.path;
  }
  const descPath = located.descriptor;
  const instPath = located.runtime;

  // The manifest, against the pinned schema, with its pointers and digests (12.2).
  const manifest = parseJson(files, "plugin.json", add) as Record<string, unknown> | undefined;
  let name: string | null = null;
  let version: string | null = null;
  if (manifest !== undefined) {
    const bad = manifestProblem(manifest);
    if (bad) problem(bad);
    if (isObj(manifest)) {
      name = typeof manifest.name === "string" ? manifest.name : null;
      version = typeof manifest.version === "string" ? manifest.version : null;
      const ext = isObj(manifest.extensions) ? manifest.extensions[PACKAGE_NS] : undefined;
      if (!isObj(ext)) problem(`plugin.json has no extensions entry for ${PACKAGE_NS}`);
      else {
        for (const [member, path] of [["descriptor", descPath], ["install", instPath]] as const) {
          const p = ext[member];
          if (!isObj(p) || p.path !== path || typeof p.sha256 !== "string") problem(`plugin.json ${PACKAGE_NS}.${member} is { "path": "${path}", "sha256": "<digest>" }, pointing at the file the package carries`);
          else {
            const b = files.get(path);
            if (b && sha256Hex(b) !== p.sha256) problem(`plugin.json names ${path} by a digest the file does not have`);
          }
        }
        if (ext.draft !== true) problem(`plugin.json ${PACKAGE_NS}.draft is true: every package is a draft`);
      }
      // Addresses only in the four members 12.6 rule 3 excepts.
      const excepted = (p: string) => p === "$schema" || p === "homepage" || p === "repository" || new RegExp(`^extensions\\.${PACKAGE_NS.replace(/\./g, "\\.")}\\.from\\[\\d+\\]\\.repository$`).test(p);
      for (const a of addresses(manifest)) if (!excepted(a.path)) problem(`plugin.json carries an address in ${a.path}; only $schema, homepage, repository and each from entry's repository may`);
    }
  }

  section = "descriptor";
  // The draft Descriptor (12.3 and Section 6, as far as a package checks it).
  const desc = parseJson(files, descPath, add) as DraftDescriptor | undefined;
  const inst = parseJson(files, instPath, add) as InstallFile | undefined;
  const skillIds = new Set<string>();
  let descSystems: SystemRef[] = [];
  if (desc !== undefined) {
    if (!isObj(desc)) problem(`${descPath} is a JSON object`);
    else {
      if (desc.format !== "agent-descriptor-v1") problem(`${descPath} format is "agent-descriptor-v1"`);
      for (const k of ["subject", "acts_for", "shape"]) if (k in desc) problem(`${descPath} carries ${k}; a draft carries no ${k}`);
      if (typeof desc.refusals !== "string" || !desc.refusals.trim()) problem(`${descPath} says what the agent refuses, in refusals`);
      if (!Array.isArray(desc.records) || !desc.records.length) problem(`${descPath} says what records the agent must leave, in records`);
      else for (const r of desc.records) if (!isObj(r) || typeof r.name !== "string" || !["per_task", "standing"].includes(r.when as string)) problem("each record is { name, when: per_task or standing, file? }");
      descSystems = Array.isArray(desc.systems) ? desc.systems : [];
      for (const a of addresses(desc)) if (!/\.can_use\[\d+\]\.schema$/.test(a.path)) problem(`${descPath} carries an address in ${a.path}`);
      if (!Array.isArray(desc.offerings) || !desc.offerings.length) problem(`${descPath} has at least one offering`);
      else
        for (const o of desc.offerings) {
          if (!isObj(o) || typeof o.id !== "string") {
            problem("each offering is an object with an id");
            continue;
          }
          if (skillIds.has(o.id)) problem(`offering ${o.id} is declared twice; each offering has exactly one skill`);
          skillIds.add(o.id);
          for (const p of offeringScopeProblems(o, { systems: descSystems })) if (!isDataUseProblem(p)) add("offering", `${descPath} offering ${p}`);
          for (const p of howRunProblems(o, `offering ${o.id}`)) add("how-run", p);
          if (o.steps !== undefined) {
            if (!Array.isArray(o.steps)) problem(`offering ${o.id}: steps is a list`);
            else
              for (const s of o.steps) {
                if (!isObj(s) || typeof s.id !== "string") {
                  problem(`offering ${o.id}: each step is an object with an id`);
                  continue;
                }
                if (s.steps !== undefined) problem(`offering ${o.id}: step ${s.id} has steps of its own; steps are one level deep`);
                skillIds.add(s.id);
                for (const p of offeringScopeProblems(s, { systems: descSystems })) if (!isDataUseProblem(p)) add("offering", `${descPath} step ${p}`);
                for (const p of howRunProblems(s, `step ${s.id}`)) add("how-run", p);
              }
          }
        }
    }
  }

  section = "install";
  // The install file (12.4): names, never values; the same systems as the Descriptor.
  const credentialed = new Set<string>();
  if (inst !== undefined) {
    if (!isObj(inst)) problem(`${instPath} is a JSON object`);
    else {
      if (inst.format !== "agent-install-v1") problem(`${instPath} format is "agent-install-v1"`);
      for (const k of ["runtimes", "binaries", "dependencies", "systems", "ceilings", "directories"]) if (!Array.isArray(inst[k])) problem(`${instPath} ${k} is a list`);
      if (addresses(inst).length) problem(`${instPath} carries an address; it names things and the host resolves the names`);
      const systems = Array.isArray(inst.systems) ? inst.systems : [];
      const spending = new Set<string>();
      for (const s of systems) {
        const n = systemName(s);
        if (!["directory", "mcp", "service"].includes(s?.kind)) problem(`${instPath} system ${n}: kind is directory, mcp or service`);
        if (s?.credential) credentialed.add(n);
        if (s?.spends) spending.add(n);
      }
      if (isObj(desc)) {
        const a = new Set(descSystems.map(systemName));
        const b = new Set(systems.map(systemName));
        if (a.size !== b.size || [...a].some((x) => !b.has(x)) || a.size !== descSystems.length || b.size !== systems.length) add("systems", "the descriptor and the runtime requirements name different systems");
      }
      const ceilings = Array.isArray(inst.ceilings) ? inst.ceilings : [];
      for (const c of ceilings) {
        if (!isObj(c) || !spending.has(c.system as string) || !["task", "day"].includes(c.per as string)) {
          add("ceilings", "each ceiling names a spending system and per task or day");
          continue;
        }
        if (!["runtime", "platform"].includes(c.enforced_by as string)) add("ceilings", `${instPath} ceiling on ${String(c.system)} says who enforces it, enforced_by runtime or platform (12.4 section 4)`);
        else if (c.enforced_by === "platform" && credentialed.has(c.system as string)) add("ceilings", `${instPath} ceiling on ${String(c.system)}: the scripts reach it with a credential the install file names, so enforced_by is runtime`);
      }
      for (const s of spending) if (!ceilings.some((c) => isObj(c) && c.system === s)) add("ceilings", `system ${s} spends and has no ceiling`);
      const deps = Array.isArray(inst.dependencies) ? inst.dependencies : [];
      for (const d of deps) {
        if (!isObj(d) || typeof d.lockfile !== "string") {
          add("dependencies", "each dependency names its lockfile");
          continue;
        }
        const b = files.get(d.lockfile);
        if (!b) add("dependencies", `${instPath} names the lockfile ${d.lockfile}, which the package does not carry`);
        else if (sha256Hex(b) !== d.sha256) add("dependencies", `${instPath} names ${d.lockfile} by a digest the file does not have`);
      }
      if (inst.job_seconds !== undefined && !(Number.isSafeInteger(inst.job_seconds) && (inst.job_seconds as number) > 0)) problem(`${instPath} job_seconds is a whole number of seconds above zero`);
      if (inst.answer !== undefined && !(isObj(inst.answer) && typeof inst.answer.piece === "string" && inst.answer.piece)) problem(`${instPath} answer is { "piece": "<name>" }`);
    }
  }

  section = "skills";
  // One skill per offering and per step, and no skill without one (12.5, 12.6 rule 2).
  const skillDirs = new Set<string>();
  for (const p of files.keys()) {
    const m = /^skills\/([^/]+)\//.exec(p);
    if (m) skillDirs.add(m[1]);
  }
  if (isObj(desc)) {
    for (const id of skillIds) if (!skillDirs.has(id)) problem(`offering or step ${id} has no skill folder skills/${id}/`);
    for (const d of skillDirs) if (!skillIds.has(d)) problem(`skills/${d}/ is no offering's or step's skill`);
  }
  for (const d of skillDirs) {
    const md = files.get(`skills/${d}/SKILL.md`);
    if (!md) problem(`skills/${d}/ has no SKILL.md`);
    else if (!hasSkillFrontmatter(utf8Text(md))) problem(`skills/${d}/SKILL.md needs frontmatter with name and description (the Agent Skills format)`);
  }

  section = "mcp";
  // mcp.json: every server is a declared system, with no address (12.6 rule 2).
  if (files.has("mcp.json")) {
    const mcp = parseJson(files, "mcp.json", add);
    if (isObj(mcp)) {
      const servers = isObj(mcp.mcpServers) ? mcp.mcpServers : mcp;
      const declared = new Set(descSystems.map(systemName));
      for (const k of Object.keys(servers)) if (!declared.has(k)) problem(`mcp.json names the server "${k}", which is no declared system`);
      if (addresses(mcp).length) problem("mcp.json carries an address; the install binds each server");
    } else if (mcp !== undefined) problem("mcp.json is a JSON object");
  }

  section = "views";
  // The generated views match a fresh generation, byte for byte (12.5).
  if (isObj(desc) && isObj(inst)) {
    for (const [path, text] of Object.entries(generatedViews(desc, inst, PACKAGE_NS))) {
      const b = files.get(path);
      if (!b) problem(`${path} is missing`);
      else if (utf8Text(b) !== text) problem(`${path} is not what the descriptor and the runtime requirements generate; it is never edited by hand`);
    }
  }

  section = "hidden";
  // No hidden character in any text file (12.6 rule 8).
  for (const [rel, bytes] of files) {
    const hit = hiddenInFile(bytes);
    if (hit) problem(`${rel} carries a hidden character ${codepointName(hit.codepoint)} at offset ${hit.offset}; a package must not`);
  }

  return { ok: issues.length === 0, name, version, issues, problems: issues.map((i) => i.message), warnings };
}
