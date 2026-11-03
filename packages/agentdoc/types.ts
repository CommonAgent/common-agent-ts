/**
 * The shapes this package reads and writes: the AgentDoc of Common Agent
 * Section 9, what `assemble` is given, and what `check` reports.
 *
 * An AgentDoc is a view. Every section names the sources it was built from,
 * and every member it could not fill is named in `not_stated`. The types are
 * loose where the specification lets a source say more than this package
 * reads: an unknown member is carried, never dropped.
 */

/** Whether a source's own signature was checked, and how it came out (Section 9.4). */
export type SignatureState = "verified" | "unsigned" | "failed" | "not_checked";

/** One thing the AgentDoc was built from (Section 9.4). */
export interface AgentDocSource {
  id: string;
  kind: string;
  url?: string;
  fetched_at?: string;
  digest?: string;
  signature?: SignatureState;
  /** An observation's moment and what was done, in place of `url` (Section 9.4). */
  at?: string;
  what?: string;
  /** The version a Descriptor or a package names, where it names one. */
  agent_version?: string;
  /** Where a projection disagrees with what it projects: reported, never merged (Section 9.4). */
  disagreements?: string[];
  [member: string]: unknown;
}

/** A section: the sources it came from, and the facts it carries. */
export interface AgentDocSection {
  from: string[];
  [member: string]: unknown;
}

/** The assembled view of one agent, or of one package (Sections 9.4 and 13.4). */
export interface AgentDoc {
  agentdoc: "v1";
  /** The agent described. Absent only in a package AgentDoc, which carries `package`. */
  subject?: { id: string; handle?: string; name?: string };
  /** The package a package AgentDoc was assembled from (Section 13.4). */
  package?: { name?: string; version?: string };
  assembled_at?: string;
  assembled_by?: string;
  stale_after?: string;
  sources: AgentDocSource[];
  sections: Record<string, AgentDocSection>;
  not_stated: string[];
  signatures: unknown[];
  [member: string]: unknown;
}

/** A JSON document handed in: parsed already, as its exact bytes, as its text, or (a string starting `http://` or `https://`) where to fetch it. */
export type DocumentInput = object | string | Uint8Array;

/** What `assemble` is given. Everything is optional; it assembles from what it has and names the rest. */
export interface AssembleInput {
  /** The agent's address, such as `https://agent.example`. The card and the Descriptor are discovered from it. */
  address?: string;
  /** The A2A Agent Card, when it is already in hand. */
  card?: DocumentInput;
  /** The agent's Descriptor (Section 6), when it is not served at the address. */
  descriptor?: DocumentInput;
  /** Agent SoW standing proposals: the agent's signed terms. */
  terms?: DocumentInput[];
  /** Attestations other parties published about the agent. */
  attestations?: object[];
  /** Signed evaluation records (Section 8.4) about the agent. */
  evalRecords?: object[];
  /** The fetch to use. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** The moment of assembly. Defaults to now. */
  now?: Date;
  /**
   * A package's manifest (`plugin.json`). With it, and the package's draft
   * Descriptor in `descriptor`, assemble writes a package AgentDoc
   * (Section 13.4) instead of one about a running agent.
   */
  package?: DocumentInput;
  /** Who assembled it, in words. Defaults to this package's name and version. */
  assembledBy?: string;
}

/** The fourteen checks of Section 9.10, by the ids every Common Agent checker shares. */
export const RULE_IDS = [
  "sources-exist",
  "section-has-source",
  "source-digest",
  "fact-in-source",
  "no-summary-grade",
  "visibility-supports-claim",
  "decided-by-rule",
  "sells-scope",
  "open-offering-members",
  "open-ended-no-claim",
  "assembled-at",
  "fetched-at",
  "not-stated-complete",
  "no-default",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** One problem `check` found: the rule, where, and what, in words. */
export interface Finding {
  rule: RuleId;
  path: string;
  message: string;
  level: "fail" | "warn";
}

/** What `check` reports. `ok` is true when no finding has level `fail`. */
export interface CheckReport {
  ok: boolean;
  findings: Finding[];
}

/** How `check` runs. With `fetchSources`, it fetches each source to check its digest and the facts taken from it. */
export interface CheckOptions {
  fetch?: typeof fetch;
  fetchSources?: boolean;
}
