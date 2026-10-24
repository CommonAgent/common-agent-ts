/**
 * The shapes the packer reads and writes. The spec is what a person writes
 * (agent.json); the draft Descriptor and the runtime requirements are the two
 * authored files of a package (Common Agent 12.3 and 12.4).
 */

/** One input or output of a job: a name and a kind, a media type or one of the value kinds. */
export interface Port {
  name: string;
  kind: string;
  required?: boolean;
  /** Outputs only: `per_task` or `standing`. */
  when?: string;
  [k: string]: unknown;
}

/** One job in the spec: something somebody would ask the agent for, or a step it runs to deliver one. */
export interface JobSpec {
  slug: string;
  title: string;
  does?: string;
  when?: string;
  good?: string;
  empty?: string;
  inputs?: Port[];
  outputs?: Port[];
  /** Until one job says `offered`, every job is offered. */
  offered?: boolean;
  /** The slugs of the jobs this one runs, in order, one level deep. */
  steps?: string[];
  scripts?: string[];
  references?: string[];
  assets?: string[];
  /** The job's long-form instructions, inline or as `{ file }` relative to the spec. */
  instructions?: string | { file: string };
  /** A lockfile under the skill's own folder, such as `scripts/package-lock.json`. */
  lockfile?: string;
  scope?: unknown;
  focus?: unknown;
  workspace?: unknown;
  authority?: unknown;
  authority_decided_by?: unknown;
  ceilings?: unknown;
  [k: string]: unknown;
}

/** One system the agent needs, named by what the work needs and never by product. */
export interface SystemSpec {
  name?: string;
  /** The alias of `name` kept for one revision. */
  role?: string;
  access: string;
  needs?: string;
  leaves?: boolean;
  kind?: string;
  credential?: string;
  env?: string;
  spends?: { unit: string };
  settings?: { env: string; purpose?: string }[];
  [k: string]: unknown;
}

/** A ceiling in the spec. `enforced_by` is `runtime` when it is not given. */
export interface CeilingSpec {
  system: string;
  per: "task" | "day";
  suggested?: number;
  enforced_by?: "runtime" | "platform";
}

/** The spec a person writes, agent.json. */
export interface AgentSpec {
  name: string;
  version?: string;
  description: string;
  jobs: JobSpec[];
  systems?: SystemSpec[];
  refuses: string[];
  escalates?: string[];
  records: (string | { name: string; when?: string; file?: string })[];
  runtimes?: { name: string; version?: string }[];
  binaries?: { name: string; purpose?: string }[];
  ceilings?: CeilingSpec[];
  directories?: { name: string; purpose?: string }[];
  author?: { name?: string; email?: string; url?: string };
  license?: string;
  homepage?: string;
  repository?: string;
  /** Who asked for the build, for the build record. */
  requested_by?: string;
  [k: string]: unknown;
}

/** A record obligation in the draft Descriptor. */
export interface RecordEntry {
  name: string;
  when: string;
  file?: string;
}

/** An offering, or a step under one, as the draft Descriptor carries it. */
export interface Offering {
  id: string;
  name: string;
  does?: string;
  inputs?: Port[];
  outputs?: Port[];
  steps?: Offering[];
  [k: string]: unknown;
}

/** The draft Descriptor (Common Agent 6 and 12.3): every caller-facing fact, and no subject. */
export interface DraftDescriptor {
  format: "agent-descriptor-v1";
  agent_version: string;
  does: string;
  offerings: Offering[];
  /** Prose, one sentence per line. */
  refusals: string;
  escalates?: string[];
  records: RecordEntry[];
  systems?: { name: string; access: string; needs?: string; leaves?: boolean }[];
  [k: string]: unknown;
}

/** One system entry in the runtime requirements. */
export interface InstallSystem {
  name: string;
  kind: string;
  credential?: string;
  env?: string;
  spends?: { unit: string };
  settings?: { env: string; purpose?: string }[];
}

/** One lockfile the runtime requirements name, with its digest. */
export interface Lockfile {
  skill: string;
  lockfile: string;
  sha256: string;
}

/** The runtime requirements (Common Agent 12.4): every host-facing fact, as names and never values. */
export interface InstallFile {
  /** "agent-runtime-requirements-v1"; "agent-install-v1" before Common Agent 0.30.0-draft. */
  format: string;
  runtimes: { name: string; version?: string }[];
  binaries: { name: string; purpose?: string }[];
  dependencies: Lockfile[];
  systems: InstallSystem[];
  ceilings: CeilingSpec[];
  directories: { name: string; purpose?: string }[];
  [k: string]: unknown;
}

/** A package's files: posix paths relative to the package's own folder, to their bytes. */
export type PackageFiles = Map<string, Uint8Array>;
