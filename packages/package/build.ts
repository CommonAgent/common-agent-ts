/**
 * The packer: an agent's spec and its folder in, an Agent Package out
 * (Common Agent Section 12). The package is an Agent Plugin, unchanged, with
 * two files beside its manifest: the draft Descriptor (every caller-facing
 * fact, once) and the install file (every host-facing fact, once). The
 * manifest points at both by digest and copies nothing; NOT.md, RECORDS.md
 * and SYSTEMS.md are generated from them.
 *
 * WHAT IT WILL NOT INVENT. Two parts of a package are judgment rather than
 * transcription: what the agent refuses, and what records it must leave. The
 * packer requires both in the spec and refuses, naming the missing part,
 * rather than filling them in.
 *
 * Pure: it reads the spec's folder through the SourceTree port and returns
 * the files; it writes nothing and reads no clock.
 */
import { writeArchive, ArchiveError } from "./archive.js";
import { PACKAGE_NS, PLUGIN_SCHEMA_URL, manifestProblem } from "./manifest.js";
import { AUTHORED_FILES, DESCRIPTOR_FILE, MANIFEST_FILE, RUNTIME_REQUIREMENTS_FILE, legacyWarning, resolveName } from "./names.js";
import { isDataUseProblem, offeringScopeProblems } from "./offering.js";
import type { SourceTree } from "./ports.js";
import { hasSkillFrontmatter, skillMd, type Copied } from "./skill.js";
import { codepointName, dumps, hiddenInFile, sentence, sha256Hex, utf8Bytes, utf8Text } from "./text.js";
import type { AgentSpec, CeilingSpec, DraftDescriptor, InstallFile, InstallSystem, JobSpec, Lockfile, Offering, PackageFiles, RecordEntry, SystemSpec } from "./types.js";
import { generatedViews, systemName } from "./views.js";
import { validatePackage } from "./validate.js";

/** A refusal to pack: the spec is missing a part a builder must not invent, or it is malformed. `missing` names the part when it is one. */
export class PackRefusal extends Error {
  readonly missing: string | null;
  /** What the packer had read, and warned about, before it refused. */
  warnings: string[] = [];
  constructor(reason: string, missing: string | null = null) {
    super(reason);
    this.name = "PackRefusal";
    this.missing = missing;
  }
}

export const NAME_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
export const SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;
export const CREDENTIAL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MEDIA_RE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/;
export const ACCESS = Object.freeze(["read", "write", "trigger"] as const);
export const SYSTEM_KINDS = Object.freeze(["directory", "mcp", "service"] as const);
export const VALUE_KINDS = Object.freeze(["text", "identifier", "url", "document"] as const);
export const WHEN = Object.freeze(["per_task", "standing"] as const);
export const ENFORCED_BY = Object.freeze(["runtime", "platform"] as const);

const inList = (list: readonly string[], v: unknown): boolean => typeof v === "string" && list.includes(v);

const needList = (spec: Record<string, unknown>, key: string, what: string): unknown[] => {
  const v = spec[key];
  if (!Array.isArray(v) || !v.length) throw new PackRefusal(`the description does not say ${what}; a package must carry it and it is not something to invent`, key);
  return v;
};

/** The draft Descriptor (Common Agent 6 and 12.3): the caller-facing facts, no subject, because the agent does not exist yet. Only what the spec said goes in. */
export function draftDescriptor(spec: AgentSpec, jobs: JobSpec[], systems: SystemSpec[], refuses: string[], escalates: string[], records: RecordEntry[]): DraftDescriptor {
  // One job as the descriptor carries it: the same shape for an offering and for a step under it.
  const project = (j: JobSpec): Offering => {
    const o: Offering = { id: j.slug, name: j.title };
    if (typeof j.does === "string" && j.does.trim()) o.does = j.does.trim();
    for (const side of ["inputs", "outputs"] as const) {
      const v = j[side] as unknown;
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v) || !v.every((e) => e && typeof e === "object" && typeof e.name === "string" && typeof e.kind === "string")) {
        throw new PackRefusal(`job ${j.slug}: each of ${side} needs at least a name and a kind`);
      }
      for (const e of v) {
        if (!(MEDIA_RE.test(e.kind) || inList(VALUE_KINDS, e.kind))) throw new PackRefusal(`job ${j.slug}: ${side} kind "${e.kind}" is neither a media type nor one of ${VALUE_KINDS.join(", ")}`);
        if (side === "outputs" && e.when !== undefined && !inList(WHEN, e.when)) throw new PackRefusal(`job ${j.slug}: an output's when must be one of ${WHEN.join(", ")}`);
      }
      o[side] = v;
    }
    // What the offering may be asked and what it can touch (6.11), carried
    // only when the spec says it: an offering without scope is task-specific.
    // Checked as a registry would, except for the agent's data use, which the
    // draft does not carry.
    for (const k of ["scope", "focus", "workspace", "authority", "authority_decided_by", "ceilings"]) {
      if (j[k] !== undefined && j[k] !== null) o[k] = j[k];
    }
    const bad = offeringScopeProblems(o, { systems }).filter((p) => !isDataUseProblem(p));
    if (bad.length) throw new PackRefusal(`job ${j.slug}: ${bad.map((p) => p.replace(/^[^:]*: /, "")).join("; ")}`);
    return o;
  };
  // Every job is checked; only the offered ones become offerings, each with
  // its delivery steps nested in order. Until one job says `offered`, every
  // job is offered.
  const projected = Object.fromEntries(jobs.map((j) => [j.slug, project(j)]));
  const anyoneSays = jobs.some((j) => "offered" in j);
  const offerings: Offering[] = [];
  for (const j of jobs) {
    if (anyoneSays && j.offered !== true) continue;
    const o = { ...projected[j.slug] };
    if (Array.isArray(j.steps) && j.steps.length) o.steps = j.steps.map((s) => ({ ...projected[s] }));
    offerings.push(o);
  }
  if (!offerings.length) throw new PackRefusal("no job is offered; at least one job must be what a caller orders");
  // Every job becomes a skill, and every skill is an offering's or a step's
  // (12.5), so a job that is neither has nowhere to stand.
  const reached = new Set(offerings.flatMap((o) => [o.id, ...(o.steps ?? []).map((s) => s.id)]));
  for (const j of jobs) {
    if (!reached.has(j.slug)) throw new PackRefusal(`job ${j.slug} is neither offered nor a step of an offered job; a package carries no skill without an offering or a step`);
  }
  // The members are added in the order every package has spelled them, so
  // the same spec gives the same bytes and the same digest.
  const doc = {
    format: "agent-descriptor-v1",
    agent_version: String(spec.version ?? "1.0.0"),
    does: spec.description.trim(),
    offerings,
    // Prose, one sentence per line: an evaluator turns each line into a
    // probe, and a line is the one boundary it can rely on.
    refusals: refuses.map(sentence).join("\n"),
  } as DraftDescriptor;
  if (escalates.length) doc.escalates = escalates.map(sentence);
  doc.records = records;
  // No `shape` (Common Agent 6.12) and no `acts_for` (12.6 rule 4): a draft carries neither.
  if (systems.length) {
    doc.systems = systems.map((s) => ({
      name: s.name as string,
      access: s.access,
      ...(s.needs ? { needs: String(s.needs).trim() } : {}),
      ...(s.leaves === true ? { leaves: true } : {}),
    }));
  }
  return doc;
}

/** The install file (Common Agent 12.4): what a host must have and do. Names, never values. */
export function installFile(spec: AgentSpec, systems: SystemSpec[], lockfiles: Lockfile[]): InstallFile {
  const runtimes = spec.runtimes ?? [];
  const binaries = spec.binaries ?? [];
  for (const r of runtimes) if (!r || typeof r.name !== "string" || !r.name) throw new PackRefusal("each runtime needs a name");
  for (const b of binaries) if (!b || typeof b.name !== "string" || !b.name) throw new PackRefusal("each binary needs a name");
  const entries: InstallSystem[] = [];
  for (const s of systems) {
    const kind = s.kind ?? "directory";
    if (!inList(SYSTEM_KINDS, kind)) throw new PackRefusal(`system ${s.name}: kind must be one of ${SYSTEM_KINDS.join(", ")}`);
    const e: InstallSystem = { name: s.name as string, kind };
    if (s.credential !== undefined && s.credential !== null) {
      if (kind === "directory") throw new PackRefusal(`system ${s.name}: a directory takes no credential`);
      if (typeof s.credential !== "string" || !CREDENTIAL_RE.test(s.credential)) throw new PackRefusal(`system ${s.name}: credential must be a NAME (lowercase, digits, . _ -), never a value`);
      e.credential = s.credential;
    }
    if (s.env !== undefined && s.env !== null) {
      if (typeof s.env !== "string" || !ENV_RE.test(s.env)) throw new PackRefusal(`system ${s.name}: env must be a variable name like TTS_TOKEN`);
      e.env = s.env;
    }
    if (s.spends !== undefined && s.spends !== null) {
      if (!s.spends || typeof s.spends.unit !== "string" || !s.spends.unit) throw new PackRefusal(`system ${s.name}: spends needs a unit, e.g. {"unit": "characters"}`);
      if (kind !== "service") throw new PackRefusal(`system ${s.name}: only a service spends`);
      e.spends = { unit: s.spends.unit };
    }
    if (s.settings !== undefined && s.settings !== null) {
      // A non-secret value the scripts read and the host must supply (a
      // billing project, a region): named here by variable and purpose,
      // valued in the owner's install instruction.
      if (kind === "directory") throw new PackRefusal(`system ${s.name}: a directory takes no settings`);
      const sts = s.settings as unknown;
      if (!Array.isArray(sts) || sts.length === 0 || !sts.every((st) => st && typeof st.env === "string" && ENV_RE.test(st.env))) {
        throw new PackRefusal(`system ${s.name}: each setting names the variable the scripts read, e.g. {"env": "TTS_PROJECT", "purpose": "..."}`);
      }
      e.settings = sts.map((st) => ({ env: st.env, ...(st.purpose ? { purpose: st.purpose } : {}) }));
    }
    entries.push(e);
  }
  const spending = entries.filter((e) => e.spends).map((e) => e.name);
  const given: unknown[] = spec.ceilings ?? spending.map((r) => ({ system: r, per: "task" }));
  const ceilings: CeilingSpec[] = [];
  for (const raw of given) {
    const c = raw as CeilingSpec | null;
    if (!c || !spending.includes(c.system) || !["task", "day"].includes(c.per)) throw new PackRefusal("each ceiling names a spending system and per task or day");
    // A suggested number, in the system's unit, that an approver's form may
    // offer as the default. The owner's instruction still sets the number.
    if ("suggested" in c && !(typeof c.suggested === "number" && Number.isFinite(c.suggested) && c.suggested > 0)) throw new PackRefusal("a ceiling's suggested value is a number above zero in the system's unit");
    // Which side applies the number (12.4 section 4) is derived from how the
    // package reaches the system, never written into the spec: a system the
    // scripts call with the credential the install file names is capped by
    // the runtime that makes the call, and a system reached through something
    // that is not the agent (kind mcp) by that party. With nothing to derive
    // it from, the build stops, because a wrong word here reads to a buyer as
    // somebody watching the spend.
    if ("enforced_by" in c) throw new PackRefusal(`system ${c.system}: a ceiling's enforcing side is derived from how the package reaches the system, never written into the spec`);
    const reached = entries.find((e) => e.name === c.system) as InstallSystem;
    const side = reached.credential ? "runtime" : reached.kind === "mcp" ? "platform" : null;
    if (!side) {
      throw new PackRefusal(`system ${c.system}: cannot tell which side applies its ceiling; a spending service the scripts call names the credential they read`);
    }
    ceilings.push({ system: c.system, per: c.per, enforced_by: side, ...("suggested" in c ? { suggested: c.suggested } : {}) });
  }
  for (const r of spending) if (!ceilings.some((c) => c.system === r)) throw new PackRefusal(`system ${r} spends money and has no ceiling`);
  const directories = spec.directories ?? [
    { name: "records", purpose: "every record the descriptor names" },
    { name: "work", purpose: "inputs and drafts in progress" },
  ];
  for (const d of directories) if (!d || typeof d.name !== "string" || !SLUG_RE.test(d.name)) throw new PackRefusal("each directory needs a lowercase-hyphen name");
  const doc: InstallFile = {
    format: "agent-install-v1",
    runtimes: runtimes.map((r) => ({ name: r.name, ...(r.version ? { version: r.version } : {}) })),
    binaries: binaries.map((b) => ({ name: b.name, ...(b.purpose ? { purpose: b.purpose } : {}) })),
    dependencies: lockfiles,
    systems: entries,
    ceilings,
    directories,
  };
  if (dumps(doc).includes("://")) throw new PackRefusal(`${RUNTIME_REQUIREMENTS_FILE} must not carry an address; name the system's role and the credential, and bind at install`);
  return doc;
}

/** The posix form of a path inside the package, or null when it leaves the folder it is relative to. */
function inside(base: string, rel: string): string | null {
  const parts: string[] = base ? base.split("/") : [];
  const floor = parts.length;
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === floor) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}


/** What the packer built. */
export interface BuiltPackage {
  name: string;
  version: string;
  /** The package's files, by path inside its folder. */
  files: PackageFiles;
  /** The archive: the package's folder under `<name>/`, gzipped ustar. */
  archive: Uint8Array;
  /** SHA-256 over the archive bytes: the package's digest. */
  sha256: string;
  /** SHA-256 over agent-descriptor.json. */
  descriptor_sha256: string;
  /** SHA-256 over agent-runtime-requirements.json. */
  install_sha256: string;
  skills: string[];
  /** How many skill folders the developer wrote and were packed as written. */
  skills_kept: number;
  systems: string[];
  lockfiles: Lockfile[];
  shape: { skills: number; systems: number; refuses: number; records: number };
  /** What the packer read that it would rather not have: an old file name, a deprecated input. */
  warnings: string[];
}

/** Options the host passes in. */
export interface BuildOptions {
  /** The time every archive entry carries, in seconds since 1970. Default 0. */
  mtime?: number;
}

type Meta = Omit<BuiltPackage, "files" | "archive" | "sha256" | "descriptor_sha256" | "install_sha256" | "name" | "version">;

/**
 * What both inputs end in: the two authored files written under their names,
 * the manifest pointing at them, the views generated, a README where the
 * package has none, the hidden-character scan, the package's own validator,
 * and the archive.
 */
function finish(files: PackageFiles, desc: DraftDescriptor, inst: InstallFile, manifestHead: Record<string, unknown>, extension: Record<string, unknown>, meta: Meta, opts: BuildOptions): BuiltPackage {
  const put = (path: string, data: string) => files.set(path, utf8Bytes(data));
  const descText = dumps(desc);
  const instText = dumps(inst);
  put(DESCRIPTOR_FILE, descText);
  put(RUNTIME_REQUIREMENTS_FILE, instText);
  const descriptor_sha256 = sha256Hex(descText);
  const install_sha256 = sha256Hex(instText);
  const manifest = {
    ...manifestHead,
    extensions: {
      ...((manifestHead.extensions as Record<string, unknown> | undefined) ?? {}),
      [PACKAGE_NS]: {
        ...extension,
        [AUTHORED_FILES.descriptor.member]: { path: DESCRIPTOR_FILE, sha256: descriptor_sha256 },
        [AUTHORED_FILES.runtime.member]: { path: RUNTIME_REQUIREMENTS_FILE, sha256: install_sha256 },
        built: true,
        draft: true,
      },
    },
  };
  const bad = manifestProblem(manifest);
  if (bad) throw new PackRefusal(bad);
  const name = manifestHead.name as string;
  const version = manifestHead.version as string;
  put(MANIFEST_FILE, dumps(manifest));
  for (const [path, text] of Object.entries(generatedViews(desc, inst, PACKAGE_NS))) put(path, text);
  if (!files.has("README.md")) {
    put(
      "README.md",
      `# ${name}\n\nAn Agent Package: an Agent Plugin carrying a draft Agent Descriptor (what\nthe agent does, refuses, needs and records) and its runtime requirements\n(what a host must have and do). It carries ${meta.skills.length} skill(s). Nobody has run\nit: this is a draft to review, not a vouched-for agent.\n`,
    );
  }
  for (const [rel, bytes] of files) {
    const hit = hiddenInFile(bytes);
    if (hit) throw new PackRefusal(`${rel} carries a hidden character ${codepointName(hit.codepoint)} at offset ${hit.offset}; a package must not`);
  }
  // The packer never hands over a package its own validator refuses.
  const problems = validatePackage(files).problems;
  if (problems.length) throw new PackRefusal(`the package would not conform: ${problems.join("; ")}`);

  let archive: Uint8Array;
  try {
    archive = writeArchive(files, name, opts.mtime ?? 0);
  } catch (e) {
    if (e instanceof ArchiveError) throw new PackRefusal(e.message);
    throw e;
  }
  return { name, version, files, archive, sha256: sha256Hex(archive), descriptor_sha256, install_sha256, ...meta };
}

/** The warning a spec input carries. */
export const SPEC_DEPRECATED =
  "packing from a spec (agent.json) is deprecated; keep agent-descriptor.json, agent-runtime-requirements.json and plugin.json in the agent's folder and pack the folder";

/**
 * Build the package from a spec (agent.json). Deprecated: an agent's folder
 * now holds its two authored files and its manifest directly, and
 * buildFromFolder packs that. Takes the spec, the folder it sits in (as a
 * SourceTree) and returns what it built, or throws a PackRefusal. A skill
 * folder that already exists under `skills/<slug>/` in the spec's folder is
 * copied whole, its SKILL.md kept as written, and only its missing pieces
 * are generated. The result always passes validatePackage.
 */
export function buildPackage(specIn: unknown, source: SourceTree, opts: BuildOptions = {}): BuiltPackage {
  if (!specIn || typeof specIn !== "object" || Array.isArray(specIn)) throw new PackRefusal("the spec is a JSON object");
  // The spec is the caller's; nothing below changes it.
  const spec = structuredClone(specIn) as AgentSpec;
  const name = spec.name ?? "";
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new PackRefusal(`the name "${String(name)}" must be lowercase letters, digits and hyphens`, "name");
  const version = String(spec.version ?? "1.0.0");
  if (typeof spec.description !== "string" || !spec.description.trim()) throw new PackRefusal("the description needs one sentence on what the agent does", "description");
  const jobs = needList(spec, "jobs", "what the agent does, as jobs") as JobSpec[];
  const systems = (spec.systems ?? []) as SystemSpec[];
  const refuses = needList(spec, "refuses", "what the agent refuses") as string[];
  const rawRecords = needList(spec, "records", "what records the agent must leave");
  const escalates = (spec.escalates ?? []) as string[];

  for (const j of jobs) if (!j || !SLUG_RE.test(j.slug ?? "") || !j.title) throw new PackRefusal("each job needs a slug (lowercase-hyphen) and a title");
  if (new Set(jobs.map((j) => j.slug)).size !== jobs.length) throw new PackRefusal("two jobs share a slug");
  {
    const slugs = new Set(jobs.map((j) => j.slug));
    for (const j of jobs) {
      if ("offered" in j && typeof j.offered !== "boolean") throw new PackRefusal(`job ${j.slug}: offered must be true or false`);
      if (j.steps === undefined || j.steps === null) continue;
      if (!Array.isArray(j.steps) || !j.steps.length || !j.steps.every((s) => typeof s === "string")) throw new PackRefusal(`job ${j.slug}: steps must be a non-empty list of job slugs`);
      if (new Set(j.steps).size !== j.steps.length) throw new PackRefusal(`job ${j.slug}: a step is listed twice`);
      for (const s of j.steps) {
        if (!slugs.has(s)) throw new PackRefusal(`job ${j.slug}: step "${s}" is not a job in this spec`);
        if (s === j.slug) throw new PackRefusal(`job ${j.slug}: a job cannot be its own step`);
      }
    }
    for (const j of jobs)
      for (const s of j.steps ?? []) {
        if (jobs.find((x) => x.slug === s)?.steps?.length) throw new PackRefusal(`job ${j.slug}: step "${s}" has steps of its own; steps are one level deep`);
      }
  }
  for (const s of systems) if (!s || !SLUG_RE.test(systemName(s)) || !inList(ACCESS, s.access)) throw new PackRefusal(`each system needs a name (lowercase-hyphen) and access one of ${ACCESS.join(", ")}`);
  if (new Set(systems.map(systemName)).size !== systems.length) throw new PackRefusal("two systems share a name");
  // Read once here, so nothing below this line knows the alias exists.
  for (let i = 0; i < systems.length; i += 1) {
    const { role: _role, ...rest } = systems[i];
    systems[i] = { ...rest, name: systemName(systems[i]) };
  }
  const records: RecordEntry[] = rawRecords.map((r) => {
    if (typeof r === "string" && r.trim()) return { name: r.trim(), when: "per_task" };
    const ro = r as { name?: unknown; when?: unknown; file?: unknown } | null;
    if (ro && typeof ro === "object" && typeof ro.name === "string" && ro.name.trim()) {
      const e: RecordEntry = { name: ro.name.trim(), when: (ro.when as string) ?? "per_task" };
      if (!inList(WHEN, e.when)) throw new PackRefusal(`record "${e.name}": when must be one of ${WHEN.join(", ")}`);
      if (ro.file) {
        if (typeof ro.file !== "string" || ro.file.startsWith("/") || ro.file.startsWith("..") || ro.file.includes("://")) throw new PackRefusal(`record "${e.name}": file must be a pattern relative to the records directory`);
        e.file = ro.file;
      }
      return e;
    }
    throw new PackRefusal("each record is a line or {name, when?, file?}");
  });

  const files: PackageFiles = new Map();
  const put = (path: string, data: Uint8Array | string) => files.set(path, typeof data === "string" ? utf8Bytes(data) : data);
  /** Copy a file or a folder the spec names into a folder of the package, under its own name; returns the name. */
  const copyInto = (rel: string, destDir: string): string => {
    const kind = source.kind(rel);
    if (!kind) throw new PackRefusal(`a file named in the spec does not exist: ${rel}`);
    const base = source.baseName(rel);
    if (kind === "file") put(`${destDir}/${base}`, source.read(rel));
    else for (const f of source.list(rel)) put(`${destDir}/${base}/${f}`, source.read(`${rel}/${f}`));
    return base;
  };

  const lockfiles: Lockfile[] = [];
  let kept = 0;
  for (const j of jobs) {
    const d = `skills/${j.slug}`;
    if (source.kind(d) === "directory") {
      // The developer's own skill folder: copied whole, SKILL.md as written.
      for (const f of source.list(d)) put(`${d}/${f}`, source.read(`${d}/${f}`));
      kept++;
    }
    const copied: Copied = { scripts: [], references: [], assets: [] };
    for (const kind of ["scripts", "references", "assets"] as const) for (const rel of j[kind] ?? []) copied[kind].push(copyInto(rel, `${d}/${kind}`));
    const ins = j.instructions;
    let instructions: string | undefined;
    if (ins && typeof ins === "object" && ins.file) {
      if (source.kind(ins.file) !== "file") throw new PackRefusal(`job ${j.slug}: the instructions file does not exist: ${ins.file}`);
      instructions = utf8Text(source.read(ins.file));
    } else if (typeof ins === "string") instructions = ins;
    if (j.lockfile) {
      const lp = typeof j.lockfile === "string" ? inside(d, j.lockfile) : null;
      const bytes = lp === null ? undefined : files.get(lp);
      if (!bytes) throw new PackRefusal(`job ${j.slug}: lockfile ${j.lockfile} is not in the skill; name it under scripts or references`);
      lockfiles.push({ skill: j.slug, lockfile: lp as string, sha256: sha256Hex(bytes) });
    }
    const md = files.get(`${d}/SKILL.md`);
    if (md) {
      if (!hasSkillFrontmatter(utf8Text(md))) throw new PackRefusal(`skills/${j.slug}/SKILL.md needs frontmatter with name and description (the Agent Skills format)`);
    } else {
      put(`${d}/SKILL.md`, skillMd(j, name, copied, instructions));
    }
  }

  const desc = draftDescriptor(spec, jobs, systems, refuses, escalates, records);
  const inst = installFile(spec, systems, lockfiles);
  const descNames = new Set((desc.systems ?? []).map((s) => s.name));
  if (descNames.size !== inst.systems.length || inst.systems.some((s) => !descNames.has(s.name))) throw new PackRefusal("the descriptor and the runtime requirements name different systems");

  const manifestHead = {
    $schema: PLUGIN_SCHEMA_URL,
    name,
    version,
    description: spec.description.trim(),
    ...(spec.author ? { author: spec.author } : {}),
    ...(spec.license ? { license: spec.license } : {}),
    ...(spec.homepage ? { homepage: spec.homepage } : {}),
    ...(spec.repository ? { repository: spec.repository } : {}),
    keywords: ["built-agent", "draft", ...jobs.map((j) => j.slug)],
  };
  return finish(files, desc, inst, manifestHead, {}, {
    skills: jobs.map((j) => j.slug),
    skills_kept: kept,
    systems: systems.map((s) => s.name as string),
    lockfiles,
    shape: { skills: jobs.length, systems: systems.length, refuses: refuses.length, records: records.length },
    warnings: [SPEC_DEPRECATED],
  }, opts);
}

const readJsonFile = (source: SourceTree, path: string): Record<string, unknown> => {
  let v: unknown;
  try {
    v = JSON.parse(utf8Text(source.read(path)));
  } catch (e) {
    throw new PackRefusal(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PackRefusal(`${path} is a JSON object`);
  return v as Record<string, unknown>;
};

/** Whether a folder holds an agent's authored files, under their names or their old names, beside a plugin.json. */
export function isAgentFolder(source: SourceTree): boolean {
  const has = (p: string) => source.kind(p) === "file";
  return has(MANIFEST_FILE) && (["descriptor", "runtime"] as const).some((k) => resolveName(has, k).path !== null);
}

/**
 * Build the package from an agent's folder, the way an agent is now kept:
 * the folder holds `agent-descriptor.json`, `agent-runtime-requirements.json`
 * and `plugin.json` (with the build-only members, such as license, author and
 * repository), and its skills under `skills/<id>/`. The old file names
 * `descriptor.json` and `install.json` are read as aliases, with a warning.
 *
 * The packer takes the two authored files as written, in the one spelling,
 * fills each lockfile's digest the runtime requirements leave out (and
 * refuses one that does not match), points the manifest at both by digest,
 * generates the views and any SKILL.md an offering or step lacks, and
 * archives the result. It invents nothing: a descriptor that does not say
 * what the agent refuses or what records it leaves is refused, naming the
 * part. The result always passes validatePackage.
 */
export function buildFromFolder(source: SourceTree, opts: BuildOptions = {}): BuiltPackage {
  const warnings: string[] = [];
  try {
    return packFolder(source, opts, warnings);
  } catch (e) {
    if (e instanceof PackRefusal) e.warnings = [...warnings];
    throw e;
  }
}

function packFolder(source: SourceTree, opts: BuildOptions, warnings: string[]): BuiltPackage {
  const has = (p: string) => source.kind(p) === "file";
  if (!has(MANIFEST_FILE)) throw new PackRefusal(`the agent's folder has no ${MANIFEST_FILE}`, MANIFEST_FILE);
  const located = { descriptor: "", runtime: "" };
  for (const kind of ["descriptor", "runtime"] as const) {
    const r = resolveName(has, kind);
    const f = AUTHORED_FILES[kind];
    if (r.both) throw new PackRefusal(`the agent's folder holds both ${f.name} and ${f.legacy}; keep ${f.name} only`);
    if (!r.path) throw new PackRefusal(`the agent's folder has no ${f.name}`, f.name);
    if (r.legacy) warnings.push(legacyWarning(kind));
    located[kind] = r.path;
  }
  if (has("agent.json")) warnings.push(`agent.json beside ${AUTHORED_FILES.descriptor.name} is ignored; the folder's authored files are what is packed`);
  const manifestIn = readJsonFile(source, MANIFEST_FILE);
  const desc = readJsonFile(source, located.descriptor) as DraftDescriptor;
  const inst = readJsonFile(source, located.runtime) as InstallFile;

  const name = manifestIn.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new PackRefusal(`${MANIFEST_FILE} name "${String(name)}" must be lowercase letters, digits and hyphens`, "name");
  if (typeof manifestIn.description !== "string" || !manifestIn.description.trim()) throw new PackRefusal(`${MANIFEST_FILE} needs a description, one sentence on what the agent does`, "description");
  if (typeof desc.refusals !== "string" || !desc.refusals.trim()) {
    throw new PackRefusal(`${located.descriptor} does not say what the agent refuses; a package must carry it and it is not something to invent`, "refusals");
  }
  if (!Array.isArray(desc.records) || !desc.records.length) {
    throw new PackRefusal(`${located.descriptor} does not say what records the agent must leave; a package must carry it and it is not something to invent`, "records");
  }
  if (manifestIn.version !== undefined && typeof manifestIn.version !== "string") throw new PackRefusal(`${MANIFEST_FILE} version must be a string`);
  if (typeof manifestIn.version === "string" && desc.agent_version !== undefined && String(desc.agent_version) !== manifestIn.version) {
    throw new PackRefusal(`${MANIFEST_FILE} says version ${manifestIn.version} and ${located.descriptor} says agent_version ${String(desc.agent_version)}; they are one version`);
  }
  if (!Array.isArray(desc.offerings) || !desc.offerings.length) throw new PackRefusal(`${located.descriptor} has no offering; at least one is what a caller orders`, "offerings");

  const files: PackageFiles = new Map();
  for (const f of source.kind("skills") === "directory" ? source.list("skills") : []) files.set(`skills/${f}`, source.read(`skills/${f}`));
  for (const f of ["mcp.json", "README.md"]) if (has(f)) files.set(f, source.read(f));
  const carried = new Set([MANIFEST_FILE, located.descriptor, located.runtime, "mcp.json", "README.md", "agent.json"]);
  for (const f of source.list(".")) {
    const top = f.split("/")[0];
    if (top === "skills" || top === "dist" || top === "node_modules" || top === "net.agentdoc.package" || carried.has(f) || top.startsWith(".")) continue;
    warnings.push(`${f} is not packed; a package carries plugin.json, the two authored files, mcp.json, README.md and skills/`);
  }

  // A skill for every offering and every step: the developer's as written,
  // or one generated from what the descriptor says the job is.
  const jobs: Offering[] = [];
  for (const o of desc.offerings) if (o && typeof o === "object") jobs.push(o, ...(Array.isArray(o.steps) ? o.steps : []));
  for (const o of jobs) if (!o || typeof o !== "object") throw new PackRefusal(`each offering and step in ${located.descriptor} is an object`);
  let kept = 0;
  const ids: string[] = [];
  for (const o of jobs) {
    if (typeof o.id !== "string" || !SLUG_RE.test(o.id)) throw new PackRefusal(`each offering and step has an id (lowercase-hyphen); bad: ${JSON.stringify(o.id)}`);
    if (ids.includes(o.id)) continue;
    ids.push(o.id);
    const md = files.get(`skills/${o.id}/SKILL.md`);
    if (md) {
      kept++;
      if (!hasSkillFrontmatter(utf8Text(md))) throw new PackRefusal(`skills/${o.id}/SKILL.md needs frontmatter with name and description (the Agent Skills format)`);
      continue;
    }
    const under = (kind: string) => [...files.keys()].filter((p) => p.startsWith(`skills/${o.id}/${kind}/`)).map((p) => p.slice(`skills/${o.id}/${kind}/`.length));
    const job: JobSpec = { slug: o.id, title: String(o.name ?? o.id), ...(typeof o.does === "string" ? { when: o.does } : {}), inputs: o.inputs, outputs: o.outputs };
    files.set(`skills/${o.id}/SKILL.md`, utf8Bytes(skillMd(job, name, { scripts: under("scripts"), references: under("references"), assets: under("assets") })));
  }

  // Each lockfile's digest: filled where the file leaves it out, held where it gives one.
  const lockfiles: Lockfile[] = [];
  for (const d of Array.isArray(inst.dependencies) ? inst.dependencies : []) {
    if (!d || typeof d.lockfile !== "string") continue;
    const bytes = files.get(d.lockfile);
    if (!bytes) throw new PackRefusal(`${located.runtime} names the lockfile ${d.lockfile}, which is not under the skills the folder holds; a lockfile lives in its skill's folder`);
    const sha = sha256Hex(bytes);
    if (typeof d.sha256 === "string" && d.sha256 && d.sha256 !== sha) throw new PackRefusal(`${located.runtime} names ${d.lockfile} by a digest the file does not have`);
    d.sha256 = sha;
    const skill = typeof d.skill === "string" ? d.skill : (/^skills\/([^/]+)\//.exec(d.lockfile)?.[1] ?? "");
    lockfiles.push({ skill, lockfile: d.lockfile, sha256: sha });
  }

  const { extensions: extIn, ...head } = manifestIn;
  const extensions = { ...((extIn as Record<string, unknown> | undefined) ?? {}) };
  const ownIn = extensions[PACKAGE_NS];
  if (ownIn !== undefined && (!ownIn || typeof ownIn !== "object" || Array.isArray(ownIn))) throw new PackRefusal(`${MANIFEST_FILE} extensions.${PACKAGE_NS} is an object`);
  const own = (ownIn as Record<string, unknown> | undefined) ?? {};
  delete extensions[PACKAGE_NS];
  const { descriptor: _d, install: _i, built: _b, draft: _r, ...keep } = own;
  const manifestHead = {
    $schema: PLUGIN_SCHEMA_URL,
    ...head,
    version: typeof head.version === "string" ? head.version : String(desc.agent_version ?? "1.0.0"),
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
  const systems = (Array.isArray(desc.systems) ? desc.systems : []).map((s) => systemName(s));
  return finish(files, desc, inst, manifestHead, keep, {
    skills: ids,
    skills_kept: kept,
    systems,
    lockfiles,
    shape: { skills: ids.length, systems: systems.length, refuses: desc.refusals.split("\n").filter((l) => l.trim()).length, records: desc.records.length },
    warnings,
  }, opts);
}
