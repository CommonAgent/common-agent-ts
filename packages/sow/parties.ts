/**
 * Parties and organizational authority (§5.1, §6.2), the standing proposal
 * that names its counterparty (§12.1.1), qualifications (§12.1), and approval
 * authority (§6.1).
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { MANDATE_REF_RE, ORGANIZATION_REF_RE, QUALIFICATION_ID_RE, RFC3339, SOW_GRADES, type SowGrade, invalidIn } from "./shared.js";

const invalid: (message: string) => never = invalidIn("5.1");

// ── §5.1 + §6.2: parties and organizational authority ───────────────────────

/** A seat in the engagement (§5.1). `organization` is the §6.2 addition: the
 *  organization on whose behalf this seat engages. Optional and additive — a
 *  document that omits it is conformant. */
export interface SowParty {
  agent: string;
  handle?: string;
  owner: string;
  organization?: string;
  /** The public key of the owner that signs for the seat (§5.1, 0.26.0-draft). */
  owner_key?: string;
}

export function validateSowParty(v: unknown): asserts v is SowParty {
  if (typeof v !== "object" || v === null) invalid("a party is an object");
  const p = v as Record<string, unknown>;
  if (typeof p.agent !== "string" || p.agent === "") invalid("a party names its agent's public key");
  if (typeof p.owner !== "string" || p.owner === "") invalid("a party names its owner");
  if (p.handle !== undefined && typeof p.handle !== "string") invalid("handle is a string");
  if (p.organization !== undefined) {
    if (typeof p.organization !== "string" || !ORGANIZATION_REF_RE.test(p.organization)) {
      invalid("organization is an Agent Mandate org reference, 'org_...' (§6.2)");
    }
  }
}

// ── §12.1.1: the standing proposal that names its counterparty ──────────────

/**
 * The one party a standing proposal is offered to (§12.1.1).
 *
 * A proposal carrying this clause is a DIRECTED standing proposal: an offer to
 * that party, not to the market. The name sits in the parties clause BESIDE
 * the seats rather than in one, and it is singly graded, as §4.2 requires of a
 * clause that splits across grades from the seats it sits next to.
 *
 * It is INSIDE THE SIGNED BYTES, because the signed bytes are the canonical
 * document less `signatures` (§6). The restriction is therefore a term of the
 * offer the selling owner signed, and it cannot be added, removed or altered
 * afterwards without breaking that signature. A platform that wants the
 * restriction MUST put it in the bytes before the provider signs; one that
 * lays it over a document that does not carry it has produced a document whose
 * signature does not verify.
 *
 * Naming a counterparty does not fill the client seat. The seat stays blank,
 * `starts_at` stays null, and formation remains the two-step gate of §12.1: a
 * countersign is a REQUEST to form, and the provider's runtime completes
 * formation with a fresh signature over the completed bytes.
 *
 * `expires_at` is the lapse §12.1.1 requires. A directed offer does not
 * outlive its occasion, and one bounded by neither an expiry nor a named
 * occasion is a validation error — an offer to one party with no end is an
 * open account of a different kind, held for months and countersigned at a
 * price set for a market that has moved.
 */
export interface SowOfferedTo extends SowParty {
  /** The instant the offer lapses (§12.1.1). */
  expires_at?: string;
  /** §4.2: `enforced` only where one platform both puts this clause inside the
   *  bytes it signs AND checks the countersigning party at formation. Both
   *  ends, or the restriction is evidence a dispute is read from. */
  grade?: SowGrade;
}

/**
 * The §12.1.1 clause: exactly one party, optionally bounded.
 *
 * A LIST is the shape refused loudest. A list of permitted signers is an
 * access control list rather than an offer, and it admits a race formation has
 * no rule for: two named parties countersign the same bytes, and only one of
 * them can form.
 */
export function validateSowOfferedTo(v: unknown, opts: { occasion?: unknown } = {}): asserts v is SowOfferedTo {
  if (Array.isArray(v)) {
    invalid(v.length === 1
      ? "offered_to names its one party directly, not as a list of one (§12.1.1)"
      : "offered_to names exactly one party — a list of permitted signers is an access control list rather than an offer, and two named parties countersigning the same bytes is a race formation has no rule for (§12.1.1)");
  }
  // Read the extra fields off the value BEFORE the seat assertion narrows it
  // to SowParty, which has no index signature.
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  validateSowParty(v);
  if (o.expires_at !== undefined && (typeof o.expires_at !== "string" || !RFC3339.test(o.expires_at))) {
    invalid("offered_to.expires_at must be an RFC-3339 instant (§12.1.1)");
  }
  if (o.grade !== undefined && (typeof o.grade !== "string" || !SOW_GRADES.has(o.grade))) {
    invalid("offered_to carries its own grade: 'enforced', 'evidence' or 'recorded' (§4.2)");
  }
  // A directed offer with no end is an open account of a different kind
  // (§12.1.1): it is bounded by its own expires_at or by the close of an
  // occasion the document names, such as the solicitation it answers.
  if (o.expires_at === undefined && (opts.occasion === undefined || opts.occasion === null)) {
    invalid("a directed proposal is bounded by an expires_at or by an occasion it names, and this one states neither (§12.1.1)");
  }
}

/**
 * The occasion a directed proposal names (§12.1.1): the solicitation it
 * answers, Agent RFP's `solicitation`, a posting and its version.
 */
export function validateSowSolicitation(v: unknown): void {
  const s = v as { rfp?: unknown; version?: unknown } | null;
  if (typeof s !== "object" || s === null || Array.isArray(s) || typeof s.rfp !== "string" || !/^rfp_[A-Za-z0-9_-]{1,64}$/.test(s.rfp)) {
    invalid("solicitation names the posting a response answers, by its rfp_ identifier (§12.1.1)");
  }
  if (!Number.isInteger(s.version) || (s.version as number) < 1) invalid("solicitation.version names the posting version the response answers (§12.1.1)");
}

/** The offered_to clause of a document, unvalidated, or null where the
 *  document offers to the market. */
function offeredToClause(doc: unknown): unknown {
  if (typeof doc !== "object" || doc === null) return null;
  const parties = (doc as { parties?: unknown }).parties;
  if (typeof parties !== "object" || parties === null) return null;
  const o = (parties as { offered_to?: unknown }).offered_to;
  return o === undefined || o === null ? null : o;
}

/**
 * §12.1.1: does this document name its counterparty?
 *
 * The listing surfaces are the caller. A catalog, marketplace, directory or
 * board MUST NOT derive a public listing from a directed standing proposal and
 * MUST NOT contribute its scope examples to a public index — §12.2 makes those
 * examples the listing's representative queries, and a document only one party
 * may form has no business answering the market's searches.
 *
 * Directedness is a FACT ABOUT THE OFFER, not a qualification about a
 * counterparty, exactly so that a surface deciding whether it may list a
 * document can read it without interpreting prose.
 */
export function isDirectedProposal(doc: unknown): boolean {
  return offeredToClause(doc) !== null;
}

/**
 * The §12.1.1 formation gate: may this party form under this document, now?
 *
 * Returns null where nothing in the document stands in the way, and a refusal
 * naming the restriction otherwise — the counterparty acted on a document it
 * was handed and deserves a reason, not a shrug.
 *
 * Four things end a directed offer, and this reads the two that live in the
 * bytes: the expiry it states, and the party it names. Withdrawal is the
 * provider's act and being spent by the formation it completes is the
 * runtime's own record; neither is readable from a document alone.
 *
 * A directed offer whose expiry this reader cannot find is REFUSED rather than
 * read as unbounded. §12.1.1 allows the lapse to be a named occasion defined
 * outside the specification, and says in the same breath that a runtime which
 * does not understand the occasion a document names MUST refuse formation.
 * This reader understands no occasion vocabulary, so an offer stating no
 * `expires_at` is exactly that case.
 */
export function directedOfferRefusal(
  doc: unknown,
  clientAgent: string,
  now: number = Date.now(),
): string | null {
  const raw = offeredToClause(doc);
  if (raw === null) return null;
  try {
    validateSowOfferedTo(raw);
  } catch (err) {
    return `this document names a counterparty in a shape that cannot be read, so who may form under it cannot be established: ${(err as Error).message}`;
  }
  const o = raw as SowOfferedTo;
  if (o.expires_at === undefined) {
    return "this offer names one counterparty and states no expiry, so nothing in it says when it ends; a runtime that cannot tell when a directed offer lapses refuses formation rather than reading the offer as unbounded (§12.1.1)";
  }
  if (now >= Date.parse(o.expires_at)) {
    return `this offer was made to one named party and lapsed at ${o.expires_at}; a lapsed offer stays readable, but nothing forms under it (§12.1.1)`;
  }
  // The match is on the agent key. `handle` and `owner` are labels for people,
  // and a handle pointed at a new key names a different party (§5.1).
  if (clientAgent !== o.agent) {
    return `this offer names ${o.handle ?? o.owner} as the one party entitled to countersign it, and the client seat names a different agent key — only the named party may form under a directed standing proposal (§12.1.1)`;
  }
  return null;
}

// ── §12.1: qualifications, the conditions a counterparty must meet ──────────

/**
 * What a qualification tests, and therefore whether any runtime can test it.
 *
 * §12.1 rule 1 admits three families: a passed validation probe (§13), account
 * standing, and capability requirements. This vocabulary is the part of that a
 * runtime can actually establish about a counterparty, plus the honest name for
 * everything else.
 *
 * - `mesh_registration` — the countersigning agent has a current registration
 *   in the mesh registry the checking runtime reads. A fact the runtime holds.
 * - `publishes_offering` — that registration publishes the named offering.
 *   §12.1's capability requirement, and the one a seller reaches for when the
 *   work only makes sense against a counterparty that can do something back.
 * - `platform_account` — the countersigning agent is attached to an account on
 *   the platform completing formation. The weakest true reading of §12.1's
 *   "account standing", and deliberately named for what it checks rather than
 *   for what "standing" might be taken to imply: it says an account exists, and
 *   it says nothing about that account's conduct, funding, or screening.
 * - `asserted` — a statement the counterparty makes about itself that no
 *   runtime here can check. A current third-party licence is the case this
 *   exists for.
 *
 * There is deliberately NO probe kind. §13's qualification is checkable
 * because the probe left a signed outcome, and a runtime that holds no probe
 * records would either invent one or publish a condition nothing can ever
 * satisfy. §13 forbids the first and §12.1 rule 2 makes the second a published
 * offer that refuses every counterparty. A deployment that records probes adds
 * the kind with the records.
 */
export type SowQualificationKind =
  | "mesh_registration"
  | "publishes_offering"
  | "platform_account"
  | "asserted";

export const SOW_QUALIFICATION_KINDS: ReadonlySet<string> = new Set<SowQualificationKind>([
  "mesh_registration",
  "publishes_offering",
  "platform_account",
  "asserted",
]);

/**
 * The kinds a runtime tests against a fact it holds, as opposed to the one it
 * can only hold a signed statement about.
 *
 * The split IS the enforcement gradient (§3) applied to this clause, and it is
 * why the vocabulary is closed rather than free text. A condition written as
 * prose can be graded anything a seller likes; a condition written as a kind
 * is graded by what the kind can be tested against.
 */
export const CHECKABLE_QUALIFICATION_KINDS: ReadonlySet<string> = new Set<SowQualificationKind>([
  "mesh_registration",
  "publishes_offering",
  "platform_account",
]);

/**
 * The highest grade a kind can honestly carry (§3 rule 1).
 *
 * A checkable kind reaches `enforced` in a deployment that actually performs
 * the refusal, which for a standing proposal is the deployment that both
 * publishes the document and completes formation under it. `asserted` tops out
 * at `evidence` and §12.1 rule 4 says so in as many words: the record is
 * evidence that the party asserted the thing, not proof that the thing is
 * true. A seller who grades a licence condition `enforced` has made the false
 * enforcement claim the whole gradient exists to prevent, so the validator
 * below refuses it rather than trusting the seller's own reading.
 */
export function qualificationGradeCeiling(kind: SowQualificationKind): SowGrade {
  return CHECKABLE_QUALIFICATION_KINDS.has(kind) ? "enforced" : "evidence";
}

/**
 * One condition a counterparty must meet for its countersign to be accepted
 * (§12.1 rule 1).
 *
 * Qualifications live in the SIGNED DOCUMENT, where a prospective client reads
 * them before spending anything. That is not decoration: a condition a buyer
 * cannot see before committing is a trap, and a condition outside the signed
 * bytes is one the seller can change after the buyer has read it.
 */
export interface SowQualification {
  /** Stable within the document, and what a refusal names. */
  id: string;
  kind: SowQualificationKind;
  /** The sentence a person reads. Required on every kind, including the
   *  checkable ones, because the buyer is owed the condition in words rather
   *  than a vocabulary term. */
  statement: string;
  /** §4.2: each qualification is singly graded, because this clause splits
   *  across grades by construction. */
  grade: SowGrade;
  /** `publishes_offering` only: the offering the counterparty must publish. */
  offering?: string;
}

const QUALIFICATION_STATEMENT_MAX = 300;
/** A backstop, not a policy. A document stating dozens of conditions is an
 *  admission process wearing an offer's clothes. */
const QUALIFICATIONS_MAX = 10;

export function validateSowQualification(v: unknown): asserts v is SowQualification {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid("a qualification is an object (§12.1)");
  const q = v as Record<string, unknown>;
  if (typeof q.id !== "string" || !QUALIFICATION_ID_RE.test(q.id)) {
    invalid("a qualification needs an id of 1-40 lowercase letters, digits and dashes — it is what a refusal names (§12.1)");
  }
  if (typeof q.kind !== "string" || !SOW_QUALIFICATION_KINDS.has(q.kind)) {
    invalid(
      `a qualification's kind is one of ${[...SOW_QUALIFICATION_KINDS].sort().join(", ")}. ` +
        "A condition written as prose can be graded anything a seller likes; a condition written as a kind is graded by what the kind can be tested against (§12.1)",
    );
  }
  const kind = q.kind as SowQualificationKind;
  if (typeof q.statement !== "string" || !q.statement.trim() || q.statement.length > QUALIFICATION_STATEMENT_MAX) {
    invalid(`a qualification states its condition in words a person reads, up to ${QUALIFICATION_STATEMENT_MAX} characters (§12.1)`);
  }
  if (typeof q.grade !== "string" || !SOW_GRADES.has(q.grade)) {
    invalid("a qualification is singly graded: 'enforced', 'evidence' or 'recorded' (§4.2)");
  }
  if (q.grade === "enforced" && kind === "asserted") {
    invalid(
      "a condition the counterparty asserts about itself, and that no runtime can check, MUST NOT be graded enforced. " +
        "The record is evidence that the party asserted the thing, not proof that the thing is true (§12.1 rule 4, §3 rule 1)",
    );
  }
  if (kind === "publishes_offering") {
    if (typeof q.offering !== "string" || !q.offering.trim() || q.offering.length > 60) {
      invalid("a publishes_offering qualification names the offering the counterparty must publish (§12.1)");
    }
  } else if (q.offering !== undefined) {
    invalid("only a publishes_offering qualification carries an offering (§12.1)");
  }
}

/** The clause: a list of singly-graded conditions with distinct ids. */
export function validateSowQualifications(v: unknown): asserts v is SowQualification[] {
  if (!Array.isArray(v)) invalid("qualifications is a list of conditions (§12.1)");
  if (v.length > QUALIFICATIONS_MAX) {
    invalid(`a standing proposal states at most ${QUALIFICATIONS_MAX} qualifications (§12.1)`);
  }
  const seen = new Set<string>();
  for (const q of v) {
    validateSowQualification(q);
    if (seen.has(q.id)) invalid(`two qualifications share the id "${q.id}", and a refusal has to name one of them (§12.1)`);
    seen.add(q.id);
  }
}

/** The conditions a document states, unvalidated, or [] where it states none.
 *  Both a standing proposal and a countersigned instance carry the clause in
 *  the same place, because the instance is the proposal plus the seat. */
export function qualificationsOf(doc: unknown): SowQualification[] {
  if (typeof doc !== "object" || doc === null) return [];
  const q = (doc as { qualifications?: unknown }).qualifications;
  return Array.isArray(q) ? (q as SowQualification[]) : [];
}

/**
 * The ids a countersign of this document MUST assert, sorted.
 *
 * Sorted because the list rides inside the client's signed bytes: two clients
 * accepting the same offer produce the same bytes, and a runtime rebuilding
 * what the instance must be has one answer rather than a permutation of them.
 */
export function requiredAssertions(doc: unknown): string[] {
  return qualificationsOf(doc)
    .filter((q) => q?.kind === "asserted" && typeof q?.id === "string")
    .map((q) => q.id)
    .sort();
}

/**
 * What a runtime established about the counterparty, for the checkable kinds.
 *
 * A field left `undefined` is a fact the runtime did NOT establish, which is
 * not the same as a fact it established as false, and the gate treats it as a
 * refusal rather than a pass. A registry that could not be read is a condition
 * that was not checked, and §12.1 rule 2 makes completing formation the thing
 * a runtime does for a counterparty that MEETS the conditions.
 */
export interface SowQualificationFacts {
  /** The agent key these facts describe. Checked against the client seat, so
   *  a runtime cannot gather facts about one party and admit another. */
  subject: string;
  /** Does the counterparty hold a current registration in the mesh registry? */
  registered?: boolean;
  /** The offerings that registration publishes. */
  offerings?: readonly string[];
  /** Is the counterparty's agent attached to an account on this platform? */
  account?: boolean;
}

/**
 * The §12.1 formation gate: does this counterparty meet the conditions this
 * offer states, and has it made the assertions the offer requires?
 *
 * Returns null where every stated condition is met, and a refusal NAMING THE
 * UNMET CONDITION otherwise — rule 2 says the refusal names it, and a
 * counterparty that read a published offer and acted on it is owed the reason
 * rather than a shrug.
 *
 * One function rather than two on purpose. The assertion half needs nothing
 * but the document, the fact half needs lookups, and a runtime that called
 * only the cheap one would have a gate that passes every unverifiable
 * condition in silence.
 *
 * What this is NOT: a screen. §12.1 is explicit that where an operator is
 * merchant of record, sanctions screening, customer identification and tax
 * status are that operator's obligations to the authorities that impose them;
 * a seller cannot discharge them by stating a condition and a buyer cannot
 * discharge them by asserting it is met. Those belong at account admission and
 * at settlement. Nothing here may be read as having performed one.
 */
export function qualificationRefusal(
  doc: unknown,
  clientAgent: string,
  asserted: readonly string[] | undefined,
  facts?: SowQualificationFacts,
): string | null {
  const raw = (typeof doc === "object" && doc !== null ? (doc as { qualifications?: unknown }).qualifications : undefined);
  if (raw === undefined || raw === null) return null;
  try {
    validateSowQualifications(raw);
  } catch (err) {
    return `this offer states conditions in a shape that cannot be read, so whether you meet them cannot be established: ${(err as Error).message}`;
  }
  const quals = raw as SowQualification[];
  if (!quals.length) return null;

  // The assertions the countersign carries, held to the offer's own list
  // BEFORE anything else: an unknown id means the two sides are reading
  // different documents, and that is worth saying plainly.
  const required = requiredAssertions({ qualifications: quals });
  const claimed = asserted ?? [];
  let previous: string | null = null;
  for (const id of claimed) {
    if (typeof id !== "string") return "each asserted condition is named by its id (§12.1)";
    if (previous !== null && previous >= id) {
      return "the asserted conditions are listed once each, in sorted order, because the list rides inside the bytes both parties sign (§12.1)";
    }
    previous = id;
    const q = quals.find((x) => x.id === id);
    if (!q) return `this offer states no condition called "${id}", and a countersign asserts only the conditions the offer states (§12.1)`;
    if (q.kind !== "asserted") {
      return `"${id}" is a condition this runtime checks rather than one you state, so a countersign does not assert it (§12.1)`;
    }
  }
  for (const id of required) {
    if (!claimed.includes(id)) {
      const q = quals.find((x) => x.id === id)!;
      return `this offer requires the countersigning party to state that it meets "${id}": ${q.statement} The countersign carries no such statement, so it is refused. Nothing here verifies the statement; what is held afterwards is evidence that you made it (§12.1)`;
    }
  }

  // The checkable half.
  const checkable = quals.filter((q) => q.kind !== "asserted");
  if (!checkable.length) return null;
  if (!facts) {
    return `this offer states conditions on who may countersign it, and this runtime checked none of them; an unchecked condition refuses formation rather than passing it (§12.1)`;
  }
  if (facts.subject !== clientAgent) {
    return "the conditions were checked against a different party than the one filling the client seat, so nothing has been established about the countersigning agent (§12.1)";
  }
  const unchecked = (q: SowQualification) =>
    `this offer states the condition "${q.id}": ${q.statement} This runtime could not check it just now, and an unchecked condition refuses formation rather than passing it (§12.1)`;
  const unmet = (q: SowQualification, because: string) =>
    `this offer states a condition the countersigning party does not meet, "${q.id}": ${q.statement} ${because} (§12.1)`;
  for (const q of checkable) {
    switch (q.kind) {
      case "mesh_registration":
        if (facts.registered === undefined) return unchecked(q);
        if (!facts.registered) return unmet(q, "That agent holds no current registration on this mesh.");
        break;
      case "publishes_offering":
        if (facts.offerings === undefined) return unchecked(q);
        if (!facts.offerings.includes(q.offering!)) {
          return unmet(q, `That agent's published manifest does not offer "${q.offering}".`);
        }
        break;
      case "platform_account":
        if (facts.account === undefined) return unchecked(q);
        if (!facts.account) return unmet(q, "That agent is not attached to an account on this platform.");
        break;
      default:
        // A kind this reader does not know is a condition it cannot test, and
        // reading it as met is how a document's own terms get waived by the
        // runtime that could not parse them.
        return `this offer states a condition of a kind this runtime does not understand, "${(q as SowQualification).kind}", so it cannot tell whether you meet it; formation is refused rather than completed unchecked (§12.1)`;
    }
  }
  return null;
}

// ── §6.1 + §6.2: approval authority and the mandate reference ───────────────

/** What kind of actor may bind an act (§6.1). */
export type ApprovalAuthority = "agent" | "person" | "agent_then_person";

export const APPROVAL_AUTHORITIES: ReadonlySet<string> = new Set<ApprovalAuthority>([
  "agent",
  "person",
  "agent_then_person",
]);

/** §6.1 defaults when unstated: formation is `agent`, amendments are
 *  `person`. */
export const DEFAULT_FORMATION_AUTHORITY: ApprovalAuthority = "agent";
export const DEFAULT_AMENDMENT_AUTHORITY: ApprovalAuthority = "person";

/** Which act an approval record covers (§6.1). */
export type SowApprovalAct = "formation" | "amendment";

/**
 * An approval record (§6.1), optionally carrying the §6.2 mandate reference.
 *
 * `mandate` names the mandate under which the approving person acted. It sits
 * inside the signed bytes and is additive. A runtime that does not perform the
 * Agent Mandate §7 checks MUST NOT present a document carrying it as
 * mandate-verified: the reference is then `evidence` that a mandate was cited,
 * not `enforced` authority.
 */
export interface SowApprovalRecord {
  act: SowApprovalAct;
  authority: ApprovalAuthority;
  key: string;
  approved_at: string;
  mandate?: string;
}


export function validateSowApproval(v: unknown): asserts v is SowApprovalRecord {
  if (typeof v !== "object" || v === null) invalid("an approval record is an object");
  const a = v as Record<string, unknown>;
  if (a.act !== "formation" && a.act !== "amendment") invalid("act is 'formation' or 'amendment'");
  if (typeof a.authority !== "string" || !APPROVAL_AUTHORITIES.has(a.authority)) {
    invalid("authority is 'agent', 'person' or 'agent_then_person' (§6.1)");
  }
  if (typeof a.key !== "string" || a.key === "") invalid("an approval names the approving key");
  if (typeof a.approved_at !== "string" || !RFC3339.test(a.approved_at)) {
    invalid("approved_at must be an RFC-3339 instant");
  }
  if (a.mandate !== undefined) {
    if (typeof a.mandate !== "string" || !MANDATE_REF_RE.test(a.mandate)) {
      invalid("mandate is an Agent Mandate reference, 'mnd_...' (§6.2)");
    }
    if (a.authority === "agent") {
      invalid(
        "a mandate names the mandate under which the approving PERSON acted (§6.2) — an " +
          "agent-authority approval has no person to hold one",
      );
    }
  }
}

/**
 * §6.2 — whether a runtime may present this approval as mandate-verified.
 *
 * Only where the deployment actually performs the Agent Mandate §7 checks. The
 * honest default is `false`: the reference is then evidence a mandate was
 * cited, and a runtime MUST NOT present it as a legal opinion either way.
 */
export function mandateVerified(
  approval: SowApprovalRecord,
  opts: { checksPerformed: boolean },
): boolean {
  return opts.checksPerformed && typeof approval.mandate === "string";
}
