/**
 * The clauses the TypeScript SDK's sow.ts stopped short of: scope and the
 * process scope (§5.2, §5.2.1), inputs and how access is granted (§5.3,
 * §5.3.1), deliverables with their rights and acceptance (§5.4, §5.4.1,
 * §5.4.2), revisions and their arithmetic (§5.4.3), volume (§5.6), change
 * control (§5.8) and termination (§5.9). Each validator answers for its own
 * clause; the document validator (document.ts) calls them.
 */
import { DIGEST_RE } from "./nda.js";
import { CURRENCY_RE, invalidIn, isNonNegInt, isPosInt, isRecord, refused, RFC3339 } from "./shared.js";
import { APPROVAL_AUTHORITIES } from "./parties.js";

const invalidScope: (message: string) => never = invalidIn("5.2");
const invalidInputs: (message: string) => never = invalidIn("5.3");
const invalidDeliverables: (message: string) => never = invalidIn("5.4");
const invalidRevisions: (message: string) => never = invalidIn("5.4.3");
const invalidVolume: (message: string) => never = invalidIn("5.6");
const invalidChange: (message: string) => never = invalidIn("5.8");
const invalidTermination: (message: string) => never = invalidIn("5.9");

function nonBlank(v: unknown, max = 300): v is string {
  return typeof v === "string" && v.trim() !== "" && v.length <= max;
}

// ── §5.2 scope, §5.2.1 a process as the scope ───────────────────────────────

export interface SowProcessScope {
  id: string;
  /** The digest of the process document's text, never its version label (§5.2.1). */
  version: string;
}

export interface SowScope {
  offerings?: string[];
  process?: SowProcessScope;
  examples?: { in_scope?: string[]; out_of_scope?: string[] };
  grade: "enforced";
}

/** Validate the scope clause: offerings or one process, never both (§5.2, §5.2.1). */
export function validateSowScope(v: unknown): asserts v is SowScope {
  if (!isRecord(v)) invalidScope("scope is an object carrying offerings or a process, examples, and grade (§5.2)");
  const hasOfferings = v.offerings !== undefined;
  const hasProcess = v.process !== undefined;
  if (hasOfferings && hasProcess) {
    invalidScope("scope carries offerings or process, never both: a list beside a process would be a second, quieter answer to what was agreed (§5.2.1)");
  }
  if (!hasOfferings && !hasProcess) invalidScope("scope names the work, as a list of the provider's offerings or as one process (§5.2)");
  if (hasOfferings) {
    if (!Array.isArray(v.offerings) || v.offerings.length === 0 || !v.offerings.every((o) => nonBlank(o, 128))) {
      invalidScope("scope.offerings is a non-empty list of the provider's published offering identifiers (§5.2)");
    }
    if (new Set(v.offerings).size !== v.offerings.length) invalidScope("scope.offerings names each offering once (§5.2)");
  }
  if (hasProcess) {
    const p = v.process;
    if (!isRecord(p) || !nonBlank(p.id, 200)) invalidScope("scope.process names one published process by id (§5.2.1)");
    if (typeof p.version !== "string" || !DIGEST_RE.test(p.version)) {
      invalidScope("scope.process.version is the digest of the process document's text, spelled sha256: and 64 lowercase hex characters; a version label names nothing (§5.2.1)");
    }
  }
  if (v.examples !== undefined) {
    const e = v.examples;
    if (!isRecord(e)) invalidScope("scope.examples is an object carrying in_scope and out_of_scope lists (§5.2)");
    for (const k of ["in_scope", "out_of_scope"] as const) {
      if (e[k] !== undefined && (!Array.isArray(e[k]) || !(e[k] as unknown[]).every((x) => nonBlank(x, 1000)))) {
        invalidScope(`scope.examples.${k} is a list of example requests, each a non-blank sentence (§5.2)`);
      }
    }
  }
  if (v.grade !== "enforced") invalidScope("scope is graded 'enforced': a provider node refuses a request naming an offering the scope does not list (§5.2)");
}

/** What a request under the engagement names: an offering, or a process at a version. */
export type SowScopedRequest = { offering: string } | { process: SowProcessScope };

/**
 * The provider's gate on a request (§5.2, §5.2.1): a request naming an
 * offering the scope does not list, or a process or digest other than the one
 * agreed, is refused with a typed refusal. Requests are matched on the
 * offering, never on prose.
 */
export function checkScopedRequest(scope: SowScope, request: SowScopedRequest): void {
  if ("offering" in request) {
    if (!scope.offerings) refused(`the engagement's scope is a process, and the request names the offering '${request.offering}' (§5.2.1)`);
    if (!scope.offerings.includes(request.offering)) refused(`the offering '${request.offering}' is not in the engagement's scope (§5.2)`);
    return;
  }
  if (!scope.process) refused(`the engagement's scope is a list of offerings, and the request names the process '${request.process.id}' (§5.2.1)`);
  if (request.process.id !== scope.process.id) refused(`the request names the process '${request.process.id}', and the engagement agreed '${scope.process.id}' (§5.2.1)`);
  if (request.process.version !== scope.process.version) {
    refused(`the request names ${request.process.version} of '${scope.process.id}', and the engagement agreed ${scope.process.version}; a new version is an amendment the client approves (§5.2.1)`);
  }
}

// ── §5.3 inputs, §5.3.1 granting access ─────────────────────────────────────

/** How a grant is made (§5.3.1). A closed vocabulary that may grow: an unrecognized value is carried and rendered verbatim, never dropped. */
export type SowGrantVia = "link" | "mcp" | "api_token" | "oauth" | "seat" | "proxy";
export const SOW_GRANT_VIAS: readonly SowGrantVia[] = ["link", "mcp", "api_token", "oauth", "seat", "proxy"];

export interface SowInput {
  name: string;
  media_type?: string;
  kind?: string;
  access?: string;
  /** Absent means the parties have not said; never read as `link` (§5.3.1). */
  via?: string;
  when?: "per_task" | "standing";
  /** On a grant made via proxy: the Agent Mandate power, write or amend, a mutating act on each resource needs (§5.3.1). A resource it does not name needs write. */
  writes?: Record<string, "write" | "amend">;
  [member: string]: unknown;
}

/** The power a mutating act on a resource behind a proxy grant needs (§5.3.1): what `writes` names for it, or `write`. */
export function powerToWrite(input: SowInput, resource: string): "write" | "amend" {
  return input.writes?.[resource] ?? "write";
}

/** Validate the inputs list (§5.3, §5.3.1). */
export function validateSowInputs(v: unknown): asserts v is SowInput[] {
  if (!Array.isArray(v)) invalidInputs("inputs is a list of what the client furnishes, in what form and when (§5.3)");
  const names = new Set<string>();
  for (const i of v) {
    if (!isRecord(i)) invalidInputs("each input is an object carrying a name (§5.3)");
    if (!nonBlank(i.name, 128)) invalidInputs("each input has a name, up to 128 characters and not blank (§5.3)");
    if (names.has(i.name)) invalidInputs(`the input '${i.name}' is named twice (§5.3)`);
    names.add(i.name);
    if (i.when !== undefined && i.when !== "per_task" && i.when !== "standing") {
      invalidInputs(`input '${i.name}': when is per_task or standing (§5.3)`);
    }
    if (i.via !== undefined && !nonBlank(i.via, 64)) {
      invalidInputs(`input '${i.name}': via names how the grant is made; an unrecognized value is carried as it is, but it is not blank (§5.3.1)`);
    }
    if (i.via !== undefined && i.kind !== "shared_resource") {
      invalidInputs(`input '${i.name}': via says how access to a shared resource is granted, so only a shared_resource input carries it (§5.3.1)`);
    }
    if (i.writes !== undefined) {
      if (i.via !== "proxy") invalidInputs(`input '${i.name}': writes names the Agent Mandate power a mutating act needs, and only a grant made via proxy carries it (§5.3.1)`);
      if (!isRecord(i.writes) || Object.keys(i.writes).length === 0) {
        invalidInputs(`input '${i.name}': writes maps each resource it covers to the power a mutating act on it needs (§5.3.1)`);
      }
      for (const [resource, power] of Object.entries(i.writes)) {
        if (!resource.trim()) invalidInputs(`input '${i.name}': writes names each resource (§5.3.1)`);
        if (power !== "write" && power !== "amend") {
          invalidInputs(`input '${i.name}': writes gives '${resource}' the power '${String(power)}'; the power is write or amend, so a grant cannot lend the authority to form, award, sign an Agent NDA or issue mandates (§5.3.1)`);
        }
      }
    }
  }
}

/** Whether a `via` is one this core knows. An unknown one is carried and rendered verbatim (§5.3.1). */
export function isKnownVia(via: string): via is SowGrantVia {
  return (SOW_GRANT_VIAS as readonly string[]).includes(via);
}

/** Members whose name says they carry a binding rather than a shape. */
const BINDING_MEMBERS = /^(url|uri|endpoint|href|address|host|token|credential|credentials|secret|password|api_key|key|account|account_id|tenant|tenant_id|path|location|repository|repo|bucket|folder)$/i;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PATH_LIKE = /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * A non-directed standing proposal publishes requirements, never addresses
 * (§5.3.1): no input entry may carry a credential, a token, an endpoint, an
 * account or tenant identifier, or a filesystem path. Returns the first
 * offending input and member, or null. A directed proposal and an executed
 * engagement name their counterparty and may carry the real thing, so this is
 * asked only of a standing proposal that names no counterparty.
 */
export function publishedInputBinding(inputs: SowInput[]): { input: string; member: string } | null {
  for (const i of inputs) {
    for (const [k, val] of Object.entries(i)) {
      if (k === "name" || k === "media_type" || k === "kind" || k === "access" || k === "via" || k === "when" || k === "writes") continue;
      if (BINDING_MEMBERS.test(k)) return { input: i.name, member: k };
      if (typeof val === "string" && (URL_LIKE.test(val) || PATH_LIKE.test(val))) return { input: i.name, member: k };
    }
  }
  return null;
}

/**
 * The order §5.3.1 requires a renderer to show inputs in: grants apart from
 * the inputs the client simply sends, and among grants the standing ones
 * first, because a standing grant is the one input still true after the work
 * is done.
 */
export function inputsForRendering(inputs: SowInput[]): { standingGrants: SowInput[]; perTaskGrants: SowInput[]; sent: SowInput[] } {
  const grants = inputs.filter((i) => i.kind === "shared_resource");
  return {
    standingGrants: grants.filter((i) => i.when === "standing"),
    perTaskGrants: grants.filter((i) => i.when !== "standing"),
    sent: inputs.filter((i) => i.kind !== "shared_resource"),
  };
}

// ── §5.4 deliverables, §5.4.1 rights, §5.4.2 acceptance ─────────────────────

export type SowExclusivity = "non_exclusive" | "exclusive" | "work_for_hire";
export const SOW_EXCLUSIVITIES: readonly SowExclusivity[] = ["non_exclusive", "exclusive", "work_for_hire"];

export interface SowRights {
  exclusivity?: SowExclusivity;
  modify?: boolean;
  redistribute?: boolean;
  /** A declared property, not a requirement (§5.4.1). */
  self_operable?: boolean;
  grade: "recorded";
}

export interface SowAcceptance {
  test_set: { digest: string; ref?: string; withheld?: boolean };
  measure: string;
  threshold: { min_fraction: number };
  /** Absent: silence is not acceptance (§5.4.2). */
  deemed_accepted_after_days?: number;
  grade: "evidence";
}

export interface SowDeliverable {
  name: string;
  media_type: string;
  rights?: SowRights;
  acceptance?: SowAcceptance;
  due?: string;
  recurrence?: { every: string; due_by_day?: number };
}

export interface SowDeliverables {
  per_task?: SowDeliverable[];
  interim?: SowDeliverable[];
  grade: "enforced";
}

/** Validate a deliverable's `rights` (§5.4.1). Absence grants nothing and is not validated here. */
export function validateSowRights(v: unknown): asserts v is SowRights {
  if (!isRecord(v)) invalidDeliverables("rights is an object carrying exclusivity, modify, redistribute, self_operable and grade (§5.4.1)");
  if (v.exclusivity !== undefined && !SOW_EXCLUSIVITIES.includes(v.exclusivity as SowExclusivity)) {
    invalidDeliverables("rights.exclusivity is non_exclusive, exclusive or work_for_hire (§5.4.1)");
  }
  for (const k of ["modify", "redistribute", "self_operable"] as const) {
    if (v[k] !== undefined && typeof v[k] !== "boolean") invalidDeliverables(`rights.${k} is a boolean (§5.4.1)`);
  }
  if (v.grade !== "recorded") {
    invalidDeliverables("rights is graded 'recorded': no runtime can stop a provider reselling something, and claiming otherwise is the pretend enforcement §3 refuses (§5.4.1)");
  }
}

/** Validate an `acceptance` clause (§5.4.2). */
export function validateSowAcceptance(v: unknown): asserts v is SowAcceptance {
  if (!isRecord(v)) invalidDeliverables("acceptance is an object carrying test_set, measure, threshold and grade (§5.4.2)");
  const t = v.test_set;
  if (!isRecord(t) || typeof t.digest !== "string" || !DIGEST_RE.test(t.digest)) {
    invalidDeliverables("acceptance.test_set commits the test set by digest, spelled sha256: and 64 lowercase hex characters (§5.4.2)");
  }
  if (t.withheld !== undefined && typeof t.withheld !== "boolean") invalidDeliverables("acceptance.test_set.withheld is a boolean (§5.4.2)");
  if (t.ref !== undefined && !nonBlank(t.ref, 300)) invalidDeliverables("acceptance.test_set.ref, where present, is a locator and not blank (§5.4.2)");
  if (t.ref === undefined && t.withheld !== true) {
    invalidDeliverables("acceptance.test_set.ref may be absent only while the set is withheld; a published set says where it is (§5.4.2)");
  }
  if (!nonBlank(v.measure, 300)) invalidDeliverables("acceptance.measure says what is counted, in a sentence (§5.4.2)");
  const th = v.threshold;
  if (!isRecord(th) || typeof th.min_fraction !== "number" || !(th.min_fraction > 0 && th.min_fraction <= 1)) {
    invalidDeliverables("acceptance.threshold.min_fraction is a fraction above 0 and at most 1 (§5.4.2)");
  }
  if (v.deemed_accepted_after_days !== undefined && !isPosInt(v.deemed_accepted_after_days)) {
    invalidDeliverables("acceptance.deemed_accepted_after_days is a positive whole number of days; absent, silence is not acceptance (§5.4.2)");
  }
  if (v.grade !== "evidence") {
    invalidDeliverables("acceptance is graded 'evidence': running the test is somebody's claim unless a third party both trust runs it (§5.4.2)");
  }
}

function validateDeliverable(d: unknown, kind: "per_task" | "interim"): void {
  if (!isRecord(d)) invalidDeliverables(`each ${kind} deliverable is an object carrying name and media_type (§5.4)`);
  if (!nonBlank(d.name, 128)) invalidDeliverables(`each ${kind} deliverable has a name, not blank (§5.4)`);
  if (!nonBlank(d.media_type, 128)) invalidDeliverables(`deliverable '${String(d.name)}' declares its media_type: form is what is machine-judged (§5.4)`);
  if (d.rights !== undefined) validateSowRights(d.rights);
  if (d.acceptance !== undefined) validateSowAcceptance(d.acceptance);
  if (kind === "per_task") {
    if (d.due !== undefined || d.recurrence !== undefined) invalidDeliverables(`per-task deliverable '${d.name}' carries no due date: it is owed with each completed task (§5.4)`);
    return;
  }
  const hasDue = d.due !== undefined;
  const hasRecurrence = d.recurrence !== undefined;
  if (hasDue === hasRecurrence) invalidDeliverables(`interim deliverable '${d.name}' carries either a single due instant or a recurrence (§5.4)`);
  if (hasDue && (typeof d.due !== "string" || !Number.isFinite(Date.parse(d.due)))) invalidDeliverables(`interim deliverable '${d.name}': due is an RFC 3339 instant (§5.4)`);
  if (hasRecurrence) {
    const r = d.recurrence;
    if (!isRecord(r) || !nonBlank(r.every, 32)) invalidDeliverables(`interim deliverable '${d.name}': recurrence names its period in every (§5.4)`);
    if (r.due_by_day !== undefined && !(isPosInt(r.due_by_day) && r.due_by_day <= 31)) {
      invalidDeliverables(`interim deliverable '${d.name}': recurrence.due_by_day is a day of the period, 1 to 31 (§5.4)`);
    }
  }
}

/** Validate the deliverables clause (§5.4), with each deliverable's rights and acceptance. */
export function validateSowDeliverables(v: unknown): asserts v is SowDeliverables {
  if (!isRecord(v)) invalidDeliverables("deliverables is an object carrying per_task and interim lists and grade (§5.4)");
  const names = new Set<string>();
  for (const kind of ["per_task", "interim"] as const) {
    if (v[kind] === undefined) continue;
    if (!Array.isArray(v[kind])) invalidDeliverables(`deliverables.${kind} is a list (§5.4)`);
    for (const d of v[kind] as unknown[]) {
      validateDeliverable(d, kind);
      const name = (d as { name: string }).name;
      if (names.has(name)) invalidDeliverables(`the deliverable '${name}' is named twice (§5.4)`);
      names.add(name);
    }
  }
  if (v.grade !== "enforced") invalidDeliverables("deliverables are graded 'enforced' for form: a completion missing a named per-task artifact is a failed task (§5.4)");
}

/**
 * The form check (§5.4): a completion that claims success without every named
 * per-task artifact in its declared media type is a failed task, on both
 * sides. Quality is not judged here, and nothing here judges it.
 */
export function checkDeliverableForm(
  deliverables: SowDeliverables,
  attached: Array<{ name: string; media_type: string }>,
): { ok: true } | { ok: false; missing: string[] } {
  const missing = (deliverables.per_task ?? [])
    .filter((d) => !attached.some((a) => a.name === d.name && a.media_type === d.media_type))
    .map((d) => d.name);
  return missing.length ? { ok: false, missing } : { ok: true };
}

/**
 * Whether silence has become acceptance (§5.4.2): only where the clause states
 * a window and the window has passed since delivery. Absent the window,
 * silence is never acceptance.
 */
export function deemedAccepted(acceptance: SowAcceptance | undefined, deliveredAt: string, now: string): boolean {
  const days = acceptance?.deemed_accepted_after_days;
  if (days === undefined) return false;
  return Date.parse(now) - Date.parse(deliveredAt) > days * 86_400_000;
}

// ── §5.4.3 revisions ────────────────────────────────────────────────────────

export interface SowRevisionPrice {
  model: "flat";
  amount_micro: number;
  currency: string;
}

export interface SowRevisions {
  included?: { count: number; window_days: number };
  steps?: Array<{ id: string; price: SowRevisionPrice }>;
  flat?: SowRevisionPrice;
  grade: "enforced";
}

function validateRevisionPrice(v: unknown, where: string): void {
  if (!isRecord(v) || v.model !== "flat") invalidRevisions(`${where} is a flat price: model 'flat', amount_micro and currency (§5.4.3)`);
  if (!isNonNegInt(v.amount_micro)) invalidRevisions(`${where}.amount_micro is a non-negative integer (§5.4.3)`);
  if (typeof v.currency !== "string" || !CURRENCY_RE.test(v.currency)) invalidRevisions(`${where}.currency is a three-letter currency code (§5.4.3)`);
}

/** Validate the revisions clause (§5.4.3): steps or flat, never both. */
export function validateSowRevisions(v: unknown): asserts v is SowRevisions {
  if (!isRecord(v)) invalidRevisions("revisions is an object carrying included, steps or flat, and grade (§5.4.3)");
  if (v.included !== undefined) {
    const i = v.included;
    if (!isRecord(i) || !isNonNegInt(i.count) || !isPosInt(i.window_days)) {
      invalidRevisions("revisions.included carries count, a whole number, and window_days, a positive whole number of days (§5.4.3)");
    }
  }
  if (v.steps !== undefined && v.flat !== undefined) invalidRevisions("revisions carries steps or flat, never both: they are alternatives (§5.4.3)");
  if (v.steps !== undefined) {
    if (!Array.isArray(v.steps) || v.steps.length === 0) invalidRevisions("revisions.steps lists the delivery steps that may be redone (§5.4.3)");
    const ids = new Set<string>();
    for (const s of v.steps) {
      if (!isRecord(s) || !nonBlank(s.id, 128)) invalidRevisions("each revision step names a delivery step of the offering by id (§5.4.3)");
      if (ids.has(s.id)) invalidRevisions(`the revision step '${s.id}' is listed twice (§5.4.3)`);
      ids.add(s.id);
      validateRevisionPrice(s.price, `the price of step '${s.id}'`);
    }
  }
  if (v.flat !== undefined) validateRevisionPrice(v.flat, "revisions.flat");
  if (v.grade !== "enforced") invalidRevisions("revisions are graded 'enforced' for the count, the window and the price arithmetic (§5.4.3)");
}

/** What a revision request costs, and whether it is admitted (§5.4.3). */
export type SowRevisionQuote =
  | { admitted: true; included: boolean; amount_micro: number; currency?: string }
  | { admitted: false; reason: "not_offered" | "no_price" | "budget"; amount_micro?: number; currency?: string; message: string };

/**
 * The revision arithmetic the provider's runtime applies (§5.4.3). Included
 * revisions are counted per original task: a revision of a revision draws on
 * the original's count and window. Inside the count and the window a
 * revision is admitted at no charge. Beyond them it is priced (the named
 * steps' sum, or the flat price), and refused with the price as a quote
 * unless the request carries a covering budget. A document with no revisions
 * clause offers none, so a request naming a prior task is an ordinary task.
 */
export function quoteRevision(
  revisions: SowRevisions | undefined,
  request: { steps?: string[]; budget_micro?: number },
  original: { completed_at: string; revisions_used: number },
  now: string,
): SowRevisionQuote {
  if (!revisions) {
    return { admitted: false, reason: "not_offered", message: "the engagement offers no revisions; a request naming a prior task is an ordinary new task at the offering's price (§5.4.3)" };
  }
  const inc = revisions.included;
  if (inc && original.revisions_used < inc.count && Date.parse(now) - Date.parse(original.completed_at) <= inc.window_days * 86_400_000) {
    return { admitted: true, included: true, amount_micro: 0 };
  }
  let amount: number;
  let currency: string | undefined;
  if (revisions.steps) {
    const asked = request.steps ?? [];
    if (!asked.length) return { admitted: false, reason: "no_price", message: "a revision names the steps it asks to have redone (§5.4.3)" };
    let sum = 0;
    for (const id of asked) {
      const step = revisions.steps.find((s) => s.id === id);
      if (!step) return { admitted: false, reason: "no_price", message: `the step '${id}' is not one the revisions clause prices (§5.4.3)` };
      sum += step.price.amount_micro;
      currency = step.price.currency;
    }
    amount = sum;
  } else if (revisions.flat) {
    amount = revisions.flat.amount_micro;
    currency = revisions.flat.currency;
  } else {
    return { admitted: false, reason: "no_price", message: "the included revisions are used and the clause prices no others, so there is no price to quote (§5.4.3)" };
  }
  if (request.budget_micro !== undefined && request.budget_micro >= amount) return { admitted: true, included: false, amount_micro: amount, ...(currency ? { currency } : {}) };
  return {
    admitted: false,
    reason: "budget",
    amount_micro: amount,
    ...(currency ? { currency } : {}),
    message: `the revision costs ${amount} micro-units${currency ? ` of ${currency}` : ""} and the request carries no budget covering it (§5.4.3)`,
  };
}

// ── §5.6 volume ─────────────────────────────────────────────────────────────

export interface SowVolume {
  per_hour?: number;
  per_day?: number;
  grade: "enforced";
}

/** Validate the volume clause: at most two windows, each a positive integer (§5.6). */
export function validateSowVolume(v: unknown): asserts v is SowVolume {
  if (!isRecord(v)) invalidVolume("volume is an object carrying per_hour, per_day and grade (§5.6)");
  if (v.per_hour === undefined && v.per_day === undefined) invalidVolume("volume states at least one window, per_hour or per_day (§5.6)");
  for (const k of ["per_hour", "per_day"] as const) {
    if (v[k] !== undefined && !isPosInt(v[k])) invalidVolume(`volume.${k} is a positive integer (§5.6)`);
  }
  if (v.grade !== "enforced") invalidVolume("volume is graded 'enforced', at the provider's admission gate (§5.6)");
}

// ── §5.8 change control, §5.9 termination ───────────────────────────────────

export interface SowChangeControl {
  review_window_days?: number;
  /** On a proposed replacement, and the version approval makes of it: the instant it was proposed (§5.8). */
  proposed_at?: string;
  approval?: { formation?: string; amendment?: string };
  grade: "enforced";
}

/** Validate the change-control clause (§5.8, §6.1). */
export function validateSowChangeControl(v: unknown): asserts v is SowChangeControl {
  if (!isRecord(v)) invalidChange("change_control is an object carrying review_window_days, approval and grade (§5.8)");
  if (v.review_window_days !== undefined && !isPosInt(v.review_window_days)) {
    invalidChange("change_control.review_window_days is a positive whole number of days (§5.8)");
  }
  if (v.proposed_at !== undefined && (typeof v.proposed_at !== "string" || !RFC3339.test(v.proposed_at))) {
    invalidChange("change_control.proposed_at is an RFC 3339 instant (§5.8)");
  }
  if (v.approval !== undefined) {
    const a = v.approval;
    if (!isRecord(a)) invalidChange("change_control.approval is an object carrying formation and amendment (§6.1)");
    for (const k of ["formation", "amendment"] as const) {
      if (a[k] !== undefined && !APPROVAL_AUTHORITIES.has(a[k] as string)) {
        invalidChange(`change_control.approval.${k} is agent, person or agent_then_person (§6.1)`);
      }
    }
  }
  if (v.grade !== "enforced") invalidChange("change control is graded 'enforced' by the signing rule itself (§5.8)");
}

export interface SowTermination {
  convenience_notice_hours: number;
  grade: "enforced";
}

/** Validate the termination clause (§5.9). */
export function validateSowTermination(v: unknown): asserts v is SowTermination {
  if (!isRecord(v)) invalidTermination("termination is an object carrying convenience_notice_hours and grade (§5.9)");
  if (!isNonNegInt(v.convenience_notice_hours)) invalidTermination("termination.convenience_notice_hours is a whole number of hours (§5.9)");
  if (v.grade !== "enforced") invalidTermination("termination is graded 'enforced' (§5.9)");
}
