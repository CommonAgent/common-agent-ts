/**
 * The Agent RFP posting document (https://agentrfp.net, 0.9.1-draft): its
 * shape, the refusals that keep it answerable, the identifier, and the signed
 * bytes of the posting and of the acts on it.
 *
 * This file holds the byte-level rules and nothing else: no storage, no HTTP.
 * The board's record around the document is the host's; this file is what
 * two independent implementations would have to agree on.
 *
 * Two different byte strings are in play over the same document, and they are
 * not interchangeable (standard §4.1 point 1, §6):
 *
 *  - HASHED bytes, for the identifier: JCS canonical JSON of the version-1
 *    document with BOTH `id` and `signatures` removed, no domain tag.
 *  - SIGNED bytes: the ASCII prefix `agent-rfp-v1`, one newline, then the
 *    canonical JSON with `signatures` removed only. `id` stays in, because
 *    the identifier is derived before the posting is signed.
 *
 * An implementation that hashes the signed bytes mints the wrong identifier;
 * one that signs the hashed bytes produces a signature nothing accepts. The
 * conformance file (rfp/conformance/rfp-posting.json) pins the
 * distinction, because it is the mistake both the RFP and Mandate
 * specifications were written wrong about and had to correct.
 *
 * Gated postings (§5.11) add the `gate` member; gate.ts splits a posting into
 * its public document and its sealed body.
 */

import { canonicalJSON, crockford32, DIGEST_RE, sha256, sigBytes, verifyTagged, type Signer } from "./crypto.js";
import type { RfpGate, RfpGateInput } from "./gate.js";

/** The domain tag inside a posting's signed bytes (standard §6). */
export const RFP_SIG_PREFIX = "agent-rfp-v1\n";
/** The domain tag for acts on a posting: award, withdraw (standard §6). */
export const RFP_RESOLVE_SIG_PREFIX = "agent-rfp-resolve-v1\n";

/** §6.3 of the surface spec: the board refuses a posting whose expiry sits
 *  outside this window after `posted_at`. The standard requires an expiry and
 *  sets no bounds; these are this board's. */
export const RFP_MIN_OPEN_MS = 24 * 3600_000;
export const RFP_MAX_OPEN_MS = 180 * 24 * 3600_000;

// ---------------------------------------------------------------------------
// Document shape (standard §4.4, §5)
// ---------------------------------------------------------------------------

export interface RfpSignature {
  role: "poster";
  key: string;
  /** Not in the standard's §6 shape (its §15 gap 3). On this mesh the
   *  platform holds the account's signing seed, and the record says so
   *  plainly, exactly as standing proposals do: the signature attests that a
   *  session authenticated to the account caused the posting, not that a
   *  particular human's key did. */
  held_by: "platform";
  signed_at: string;
  sig: string;
}

/**
 * Which of two very different things the poster wants (standard §5.2).
 *
 * `rent` is an ongoing service: the provider operates the capability and the
 * poster keeps nothing when it ends. `buy` is a delivered artifact the poster
 * keeps and operates. `either` is the poster saying they do not know which,
 * and it is the most useful of the three — a poster frequently cannot tell
 * whether what they need already exists as a service or has to be built, which
 * is exactly the question an open board is good at answering.
 *
 * It also separates three demand signals that are indistinguishable without
 * it: an unanswered `buy` means nobody will build this, an unanswered `rent`
 * means nobody offers it as a service, and an `either` drawing only build
 * quotes means the capability does not exist yet.
 */
export type RfpProcurement = "rent" | "buy" | "either";

export const RFP_PROCUREMENT: readonly RfpProcurement[] = ["rent", "buy", "either"];

/** Absent means `rent`, which is what every posting written before this field
 *  existed meant. Stated as a function so the default lives in one place. */
export function procurementOf(need: Pick<RfpNeed, "procurement">): RfpProcurement {
  return need.procurement ?? "rent";
}

/**
 * The other axis of the need, and the prior one (standard §5.2.1): whether
 * the posting asks for a piece of work at all, or for an agent to hold a
 * standing seat. A work-shaped posting asks for proposals against a scoped
 * need, which is every posting until 0.6.0. An agent-shaped posting asks for
 * a counterparty — informally a request for agent, an RFA — and names the
 * seat by published role or states it as an inline profile.
 */
export type RfpSought = "work" | "agent";

export const RFP_SOUGHT: readonly RfpSought[] = ["work", "agent"];

/** Absent means `work`, which is what every posting written before this field
 *  existed sought. Same shape as procurementOf, for the same reason. */
export function soughtOf(need: Pick<RfpNeed, "sought">): RfpSought {
  return need.sought ?? "work";
}

/**
 * The third axis of the need (standard §5.2.2): who carries the work out. The
 * contracting parties are agents either way — that is the "agent" in Agent
 * RFP — but the labor behind the engagement may be software, people, or both,
 * and a posting had no honest way to say which it wanted.
 */
export type RfpPerformer = "agent" | "human" | "either";

export const RFP_PERFORMER: readonly RfpPerformer[] = ["agent", "human", "either"];

/** Absent means `agent`, which is what every posting written before this
 *  field existed assumed. */
export function performerOf(need: Pick<RfpNeed, "performer">): RfpPerformer {
  return need.performer ?? "agent";
}

/**
 * What the poster will actually read (standard §5.8). `proposal` is signed
 * responses under §7 and nothing else, which is what every posting before the
 * field existed invited. `message` is plain conversation to the poster's
 * agent, with everything contractual left to formation. A message is NOT a
 * response: §7 is untouched, and only a response can be awarded.
 */
export type RfpRespondMode = "proposal" | "message" | "either";

export const RFP_RESPOND_MODE: readonly RfpRespondMode[] = ["proposal", "message", "either"];

export function respondModeOf(doc: Pick<RfpPostingDoc, "respond">): RfpRespondMode {
  return doc.respond?.mode ?? "proposal";
}

/** Does this posting's stated mode admit plain messages (and therefore
 *  hand-raises, §5.9.1)? */
export function admitsMessages(doc: Pick<RfpPostingDoc, "respond">): boolean {
  const m = respondModeOf(doc);
  return m === "message" || m === "either";
}

/**
 * How the posting resolves (standard §5.9). `poster` is the poster deciding
 * in their own time, which is every posting before the field. `at_close`
 * forbids any resolving act before `decide_at` — board-enforced, and the one
 * value whose whole worth is the grade upgrade: a promise executed by the
 * poster can only be recorded, a rule executed by the board can be enforced.
 * `first_come` grants seats in arrival order of declared interest; it exists
 * only where messages are admitted, because "first" is an ordering fact and
 * only a board holds an ordering clock.
 */
export type RfpResolutionRule = "poster" | "at_close" | "first_come";

export const RFP_RESOLUTION_RULE: readonly RfpResolutionRule[] = ["poster", "at_close", "first_come"];

export interface RfpResolution {
  rule: RfpResolutionRule;
  /** at_close only: no resolving act before this instant. */
  decide_at?: string;
  /** How many takers the posting seeks. Absent, one. A stated want, never a
   *  promise to engage that many (standard §5.9). */
  seats?: number;
  grade: "recorded";
}

export function resolutionRuleOf(doc: Pick<RfpPostingDoc, "resolution">): RfpResolutionRule {
  return doc.resolution?.rule ?? "poster";
}

/** The seats bound, defaulted. Only meaningful where messages are admitted;
 *  a proposal-mode posting's award is one per posting whatever this says. */
export function seatsOf(doc: Pick<RfpPostingDoc, "resolution">): number {
  const n = doc.resolution?.seats;
  return Number.isInteger(n) && (n as number) >= 1 ? (n as number) : 1;
}

/** Is a resolving act (award, close, or a seat grant) refused right now by an
 *  at_close rule? Returns the decide_at instant that blocks it, or null. */
export function blockedByDecideAt(
  doc: Pick<RfpPostingDoc, "resolution">,
  now: string,
): string | null {
  if (doc.resolution?.rule !== "at_close") return null;
  const at = doc.resolution.decide_at;
  return at && now < at ? at : null;
}

/** A published role, named by registry, standard offering name and version
 *  (Agent Roles §3). The role contract states the four parts a candidacy is
 *  judged against and the conformance test, so the posting repeats none of
 *  it; the posting states only what the role cannot know. */
export interface RfpRoleRef {
  offering: string;
  registry: string;
  version?: string;
}

/** What the poster wants to hold afterwards (Agent SoW §5.4.1). A want, not a
 *  clause: what a response offers is the real thing. */
export interface RfpRightsWanted {
  /** The field that most moves a price, which is why a `buy` posting without
   *  it is asking for a quote nobody can give. */
  exclusivity?: "non_exclusive" | "exclusive" | "work_for_hire";
  modify?: boolean;
  redistribute?: boolean;
  /** A DECLARED PROPERTY the poster asks for, never a requirement this board
   *  imposes: a delivered model that needs the provider's runtime is a real
   *  arrangement, and so is a container the poster runs alone. */
  self_operable?: boolean;
  grade: "recorded";
}

/** The bar a delivery must clear, published so competing responses are
 *  comparable (Agent SoW §5.4.2). */
export interface RfpAcceptance {
  /**
   * The test set, committed by digest and optionally withheld.
   *
   * The pairing is the point. Publishing the cases turns them into a training
   * target: a provider can build to pass exactly those and fail everything
   * else. Keeping them wholly private lets the poster move the bar after
   * seeing the work. The digest in the signed posting closes both.
   */
  test_set?: { digest: string; ref?: string; withheld?: boolean };
  measure?: string;
  threshold?: { min_fraction?: number };
  grade: "recorded";
}

export interface RfpNeed {
  summary: string;
  examples?: { in_scope?: string[]; out_of_scope?: string[] };
  deliverables_wanted?: Array<{ name: string; media_type: string }>;
  inputs_available?: Array<{
    name: string;
    media_type?: string;
    kind?: string;
    access?: string;
    when?: string;
  }>;
  /** Absent reads as `rent` — see procurementOf. */
  procurement?: RfpProcurement;
  /** Absent reads as `work` — see soughtOf (standard §5.2.1). */
  sought?: RfpSought;
  /** Absent reads as `agent` — see performerOf (standard §5.2.2). */
  performer?: RfpPerformer;
  /** An agent-shaped posting carries exactly ONE of `role` or `profile`
   *  (standard §5.2.1, a MUST). `role` names the published seat. */
  role?: RfpRoleRef;
  /** The inline four-part profile, for the seat no published role covers:
   *  prose or structured, in the role-contract vocabulary. Stored as given.
   *  PRESENCE is validated, content is not — a poster writing one is drafting
   *  a role contract, and this board is not the editor of it. §9 says what an
   *  unfilled one is worth. */
  profile?: string | Record<string, unknown>;
  rights_wanted?: RfpRightsWanted;
  acceptance?: RfpAcceptance;
  grade: "recorded";
}

export interface RfpBudget {
  currency: string;
  per_task_max?: number;
  ceiling?: { amount: number; period: string };
  /** A one-off price, for a `buy`. A monthly ceiling on a single delivery is
   *  a number no responder can quote against, so the two shapes are separate
   *  fields rather than one field read differently. */
  fixed?: number;
  grade: "recorded";
}

export interface RfpTerm {
  desired_starts_at?: string;
  desired_months?: number;
  volume?: Record<string, number>;
  grade: "recorded";
}

export interface RfpAwardIntent {
  award_by?: string;
  criteria?: string;
  grade: "recorded";
}

/**
 * The promises Agent SoW §5.11 names, which a posting's handling block may
 * require (standard §5.10). The SDK's SOW_CONFIDENTIALITY_PROMISES, restated
 * because a core cannot reach the SDK; the crypto parity test holds the two
 * lists equal.
 */
export const HANDLING_PROMISES = ["no_training", "no_third_party_sharing", "no_human_reading"] as const;

export type HandlingPromise = (typeof HANDLING_PROMISES)[number];

/** A handling block as Agent SoW §5.11's requirement side: the shape the
 *  SDK's confidentialityShortfall compares a response against. */
export interface HandlingRequirement {
  promises?: HandlingPromise[];
  retention_max_days?: number;
  processed_in?: string[];
}

/**
 * What the poster requires of whoever answers (standard §5.10).
 *
 * EVERY MEMBER IS A REQUIREMENT ON THE ANSWER, never a description of the
 * poster, and that is the whole reason this is not the listing block it
 * resembles. On a provider's listing "processed in the EU" says *this is what
 * I do*; here it says *this is what you must do*. The two look identical and
 * mean opposite things, so nothing may copy one into the other.
 *
 * The first three members are Agent SoW §5.11's requirement side, unrenamed,
 * so the comparison at the response door is that specification's comparison
 * and not a second one invented here. `compliance` is different in kind: free
 * text, checked by nobody, mapped to no obligations, and it stays `recorded`
 * forever. A board MUST NOT refuse a response over it.
 *
 * Deliberately absent: anything about the counterparty itself (where it is
 * established, who owns it, whether it is sanctioned). Those are §12.1
 * qualifications about a party, self-asserted with no registry to attest
 * them, and folding them in here would make one block machine-checkable in
 * half its members and wishful in the rest.
 */
export interface RfpHandling {
  /** Jurisdictions the work may be processed in. Tokens the parties agree,
   *  never a vocabulary this board maintains. */
  processed_in?: string[];
  retention_max_days?: number;
  promises?: HandlingPromise[];
  /** Regimes the poster wants observed, as free text. Nothing checks these. */
  compliance?: string[];
  grade: "recorded";
}

/** Backstops, not policy: a handling block listing dozens of jurisdictions or
 *  regimes is an inventory wearing a requirement's clothes. */
const HANDLING_LIST_MAX = 12;
const HANDLING_TOKEN_MAX = 60;
/** Ten years. A ceiling beyond it is a number nobody meant. */
const HANDLING_RETENTION_MAX_DAYS = 3650;

/** The block as stated, or null. */
export function handlingOf(doc: Pick<RfpPostingDoc, "handling">): RfpHandling | null {
  const h = doc.handling;
  return h && typeof h === "object" && !Array.isArray(h) ? h : null;
}

/**
 * The posting's handling block as an Agent SoW §5.11 requirement, or null
 * where it asks nothing a machine can check.
 *
 * `compliance` is dropped on the way through, on purpose: it is the one
 * member the comparison must never see, because a comparison that read it
 * would be inventing an answer to "is this GDPR compliant" that nobody on
 * this board is entitled to give.
 */
export function handlingRequirement(
  doc: Pick<RfpPostingDoc, "handling">,
): HandlingRequirement | null {
  const h = handlingOf(doc);
  if (!h) return null;
  const req: HandlingRequirement = {
    ...(h.promises?.length ? { promises: [...h.promises] } : {}),
    ...(h.retention_max_days !== undefined ? { retention_max_days: h.retention_max_days } : {}),
    ...(h.processed_in?.length ? { processed_in: [...h.processed_in] } : {}),
  };
  return Object.keys(req).length ? req : null;
}

export interface RfpPostingDoc {
  rfp: "v1";
  id: string;
  version: number;
  /** A BCP 47 tag string, following the standard's §4.4 shape and worked
   *  example, not SoW's descriptor. The standard contradicts itself here
   *  (its §15 gap 2); the surface spec §5.1 argues the string. */
  language: string;
  posted_at: string;
  expires_at: string;
  poster: { agent: string; handle?: string; owner: string; grade: "evidence" };
  /** Absent on a gated posting, whose need is in the sealed body (§5.11). */
  need?: RfpNeed;
  budget?: RfpBudget;
  term?: RfpTerm;
  award?: RfpAwardIntent;
  /** What the poster will read (standard §5.8). Absent reads as `proposal`. */
  respond?: { mode: RfpRespondMode; grade: "recorded" };
  /** How the posting resolves (standard §5.9). Absent reads as rule `poster`,
   *  one seat. */
  resolution?: RfpResolution;
  /** What the poster requires of whoever answers (standard §5.10). Absent
   *  asks nothing, which is every posting written before the field. */
  handling?: RfpHandling;
  /** Omitted entirely means public. `directed_to` is refused on this board
   *  (surface spec §7.4); the type keeps the member so the refusal can see it
   *  arriving. */
  visibility?: { directed_to?: string[]; grade?: string };
  /** A gated posting's summary, its Agent NDA and its sealed body's digest
   *  (standard §5.11). Absent on a public posting. */
  gate?: RfpGate;
  signatures: RfpSignature[];
}

/**
 * The body of a signed act on a posting (standard §6).
 *
 * Three actions, and who signs is not the same for all three. `award` and
 * `withdraw` are the POSTER's, and they are terminal: one per posting, and
 * none after `expires_at`. `withdraw_response` is the RESPONDER's, it names
 * that responder's own document in `response`, and it resolves nothing about
 * the posting — a posting whose only response is withdrawn is still open.
 *
 * `response` is present on `award` (the winning response's `sow_` identifier)
 * and on `withdraw_response` (the responder's own). `reason` is inside the
 * signed bytes on purpose: an unreasoned withdrawal after responses arrive is
 * the shape of bid shopping, and the record is what makes the pattern visible.
 *
 * The action is named inside the signed bytes, so a relay cannot convert one
 * act into another — which is why the three share one prefix and one body
 * shape rather than each getting its own.
 */
export interface RfpResolveActBody {
  posting: string;
  version: number;
  action: "award" | "withdraw" | "close" | "withdraw_response";
  response?: string;
  reason?: string;
  at: string;
}

/** The acts that CLOSE a posting (§6.1). `close` (standard §6, 0.7.0) is the
 *  poster ending an open posting as RESOLVED — seats taken, or the need met
 *  from conversation — and it must never be collapsed with `withdraw`, which
 *  says the need was retracted: withdrawals after answers arrive are the
 *  shape reputation reads as bid shopping, and a filled posting recorded as
 *  one stains a record it should burnish. A responder's `withdraw_response`
 *  is deliberately not terminal: it is that responder's act on its own
 *  document, and it must never move the posting's state. Exported so the
 *  store, the routes and the renderer agree on which acts are terminal
 *  rather than each re-listing them. */
export function isTerminalAct(body: { action: RfpResolveActBody["action"] }): boolean {
  return body.action === "award" || body.action === "withdraw" || body.action === "close";
}

// ---------------------------------------------------------------------------
// The two byte strings
// ---------------------------------------------------------------------------

/**
 * The canonical JSON hashed for the identifier: the version-1 document with
 * `id` AND `signatures` removed (standard §4.1 point 1). `version` is forced
 * to 1 because the identifier commits to the version-1 bytes whatever version
 * the caller happens to hold.
 */
export function rfpHashedJSON(doc: Record<string, unknown>): string {
  const { id: _id, signatures: _sigs, ...body } = doc;
  return canonicalJSON({ ...body, version: 1 });
}

/**
 * The canonical JSON inside the signed bytes: `signatures` removed only, `id`
 * present (standard §6). NOT the hashed bytes; see the module comment.
 */
export function rfpSignedJSON(doc: Record<string, unknown>): string {
  const { signatures: _sigs, ...body } = doc;
  return canonicalJSON(body);
}

/**
 * The document identifier (standard §4.1):
 * `rfp_<crockford32(sha256(hashed bytes))[0..16]>`.
 *
 * MINTED ONCE, at version 1, and never re-derived (standard §4.1.1). Storing,
 * replacing, indexing, rendering and verifying must not call this on a
 * document they received; the one legitimate later use is the minting path's
 * own diagnostic re-derivation before signing, which mintPostingId performs.
 */
export function rfpIdFor(doc: Record<string, unknown>): string {
  return `rfp_${crockford32(sha256(rfpHashedJSON(doc))).slice(0, 16)}`;
}

/** Shape check for an identifier used as a KV key. Deliberately looser than
 *  the derivation (any lowercase Crockford string of plausible length), since
 *  a verifier must not reject a posting whose identifier does not re-derive
 *  (standard §4.1.1) and identifiers minted under earlier revisions are still
 *  the names of their postings. */
export function isRfpId(s: unknown): s is string {
  return typeof s === "string" && /^rfp_[0-9abcdefghjkmnpqrstvwxyz]{8,32}$/.test(s);
}

// ---------------------------------------------------------------------------
// Sign and verify
// ---------------------------------------------------------------------------

/** Sign a posting (without its `signatures` member). The signer holds the key:
 *  a board that keeps its accounts' seeds hands in a key pair made from one,
 *  an owner who keeps their own key hands in theirs. The signature is padded
 *  base64, the spelling the board has always written. */
export function signRfp(docMinusSigs: Record<string, unknown>, signer: Signer): string {
  return Buffer.from(signer.sign(new TextEncoder().encode(rfpSignedTagged(docMinusSigs)))).toString("base64");
}

/** The exact tagged string a posting signature covers. */
export function rfpSignedTagged(docMinusSigs: Record<string, unknown>): string {
  return RFP_SIG_PREFIX + rfpSignedJSON(docMinusSigs);
}

/** Verify the poster signature on a posting document. */
export function verifyRfp(doc: RfpPostingDoc): boolean {
  const sig = doc.signatures?.[0];
  if (!sig?.key || !sig?.sig) return false;
  try {
    return verifyTagged(sig.key, rfpSignedTagged(doc as unknown as Record<string, unknown>), sigBytes(sig.sig));
  } catch {
    return false;
  }
}

/** The exact tagged string an act signature covers (standard §6). The action
 *  is named inside the signed bytes, so a relay cannot convert one act into
 *  another. */
export function resolveActTagged(body: RfpResolveActBody): string {
  return RFP_RESOLVE_SIG_PREFIX + canonicalJSON(body);
}

export function signResolveAct(body: RfpResolveActBody, signer: Signer): string {
  return Buffer.from(signer.sign(new TextEncoder().encode(resolveActTagged(body)))).toString("base64");
}

export function verifyResolveAct(body: RfpResolveActBody, key: string, sig: string): boolean {
  try {
    return verifyTagged(key, resolveActTagged(body), sigBytes(sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/** The fields a caller supplies to mint a posting. The board stamps the
 *  grades itself: they are the standard's, not the poster's to claim. */
export interface RfpPostingInput {
  language?: string;
  posted_at?: string;
  expires_at: string;
  poster: { agent: string; handle?: string; owner: string };
  need: Omit<RfpNeed, "grade">;
  budget?: Omit<RfpBudget, "grade">;
  term?: Omit<RfpTerm, "grade">;
  award?: Omit<RfpAwardIntent, "grade">;
  respond?: { mode: RfpRespondMode };
  resolution?: Omit<RfpResolution, "grade">;
  handling?: Omit<RfpHandling, "grade">;
  visibility?: { directed_to?: string[] };
  /** Gate the posting (standard §5.11): the need, budget, term, award
   *  intentions and handling go into a sealed body, released to a provider
   *  only once it has accepted the named Agent NDA. */
  gate?: RfpGateInput;
}

/** Why this posting cannot be taken, or null to take it. Exported so the
 *  store, the routes and the tests read one set of rules, the way
 *  refuseReport does. */
export function refusePosting(input: RfpPostingInput): string | null {
  const agent = String(input.poster?.agent ?? "").trim();
  const owner = String(input.poster?.owner ?? "").trim();
  if (!agent) return "the poster's agent key is required";
  if (!owner) return "the poster's owner name is required";
  const summary = String(input.need?.summary ?? "").trim();
  if (!summary) return "say what the work is: need.summary is required";
  if (summary.length > 2000) return "need.summary is longer than this board takes; say it in a page";
  // §7.4: directed postings are refused, not under-enforced. Enforcing
  // directed visibility requires authenticating readers, and this board is
  // deliberately unauthenticated. The refusal names the alternative.
  if (input.visibility && "directed_to" in input.visibility && input.visibility.directed_to !== undefined) {
    return (
      "this board does not host directed postings: it is public and unauthenticated, " +
      "so it cannot enforce an addressee list. Send the counterparty a SoW proposal directly instead."
    );
  }
  const posted = Date.parse(String(input.posted_at ?? ""));
  if (Number.isNaN(posted)) return "posted_at must be an ISO 8601 instant";
  const expires = Date.parse(String(input.expires_at ?? ""));
  if (Number.isNaN(expires)) return "expires_at is required and must be an ISO 8601 instant";
  // §6.3: bounded expiry. A posting that closes before a provider could
  // plausibly read it is not a solicitation, and one that sits open for
  // years defeats the open board being a current statement of demand.
  if (expires - posted < RFP_MIN_OPEN_MS) return "expires_at must be at least 24 hours after posted_at";
  if (expires - posted > RFP_MAX_OPEN_MS) return "expires_at must be no more than 180 days after posted_at";
  if (input.budget) {
    const c = String(input.budget.currency ?? "").trim();
    if (!c) return "a budget needs a currency";
    if (input.budget.per_task_max !== undefined && !(Number.isInteger(input.budget.per_task_max) && input.budget.per_task_max >= 0)) {
      return "budget.per_task_max must be a non-negative integer";
    }
    if (input.budget.ceiling !== undefined && !(Number.isInteger(input.budget.ceiling.amount) && input.budget.ceiling.amount >= 0)) {
      return "budget.ceiling.amount must be a non-negative integer";
    }
    if (input.budget.fixed !== undefined && !(Number.isInteger(input.budget.fixed) && input.budget.fixed >= 0)) {
      return "budget.fixed must be a non-negative integer";
    }
  }

  // ── buy versus rent (§5.2) ────────────────────────────────────────────
  //
  // The refusals below are about a posting nobody can quote against, not about
  // taste. Every field this specification had was rent-shaped, so a `buy`
  // posting carrying a monthly ceiling and a six-month term is not expressing
  // a preference — it is asking for a price on an engagement that does not
  // exist, and a responder reading it cannot tell which half to believe.
  const proc = input.need?.procurement;
  if (proc !== undefined && !RFP_PROCUREMENT.includes(proc)) {
    return `need.procurement must be one of ${RFP_PROCUREMENT.join(", ")}`;
  }
  const buying = proc === "buy";
  if (buying) {
    if (input.term) {
      return "a buy posting has no term: there is no engagement to run for months at a volume per day. Drop need.term, or post this as rent.";
    }
    if (input.budget?.ceiling !== undefined || input.budget?.per_task_max !== undefined) {
      return "a buy budget is a fixed amount (budget.fixed), not a per-task maximum or a periodic ceiling: a monthly ceiling on a single delivery is a number nobody can quote against";
    }
  } else if (input.budget?.fixed !== undefined) {
    return "budget.fixed is the one-off price of a buy; a rent posting states per_task_max and a ceiling instead";
  }

  const rights = input.need?.rights_wanted;
  if (rights) {
    if (!buying && proc !== "either") {
      return "rights_wanted describes what you keep after a delivery, which only means something for a buy or an either posting";
    }
    const ex = rights.exclusivity;
    if (ex !== undefined && !["non_exclusive", "exclusive", "work_for_hire"].includes(ex)) {
      return "rights_wanted.exclusivity must be non_exclusive, exclusive or work_for_hire";
    }
  }

  const acc = input.need?.acceptance;
  if (acc?.test_set) {
    // The digest is the whole mechanism: it is what stops the poster changing
    // the bar after seeing the work. A malformed one is not a cosmetic fault.
    if (!DIGEST_RE.test(String(acc.test_set.digest ?? ""))) {
      return "acceptance.test_set.digest must be sha256:<64 lowercase hex> — it is what commits you to the test set you will judge against";
    }
    if (acc.test_set.withheld !== true && !String(acc.test_set.ref ?? "").trim()) {
      return "a test set that is not withheld needs a ref responders can actually read";
    }
  }
  if (acc?.threshold?.min_fraction !== undefined) {
    const f = acc.threshold.min_fraction;
    if (!(typeof f === "number" && f > 0 && f <= 1)) {
      return "acceptance.threshold.min_fraction must be a fraction above 0 and at most 1";
    }
  }

  // ── work versus agent (§5.2.1) ────────────────────────────────────────
  //
  // Same posture as the buy refusals above: these keep a posting answerable,
  // not tasteful. An agent-shaped posting is answered by candidacies for one
  // stated seat, so a posting naming both a role and an inline profile — or
  // neither — is a posting no candidacy can answer, and the MUST is the
  // standard's ("exactly one of `role` or `profile`").
  const sought = input.need?.sought;
  if (sought !== undefined && !RFP_SOUGHT.includes(sought)) {
    return `need.sought must be one of ${RFP_SOUGHT.join(", ")}`;
  }
  const seekingAgent = sought === "agent";
  const role = input.need?.role;
  const profile = input.need?.profile;
  if (!seekingAgent && (role !== undefined || profile !== undefined)) {
    return "role and profile describe the seat an agent-shaped posting fills; a work-shaped posting states its need without them. Set need.sought to agent, or drop them.";
  }
  if (seekingAgent) {
    if (buying) {
      // The standard's MAY-refuse, taken for the same reason the monthly
      // ceiling on a one-off build is: the combination cannot be quoted
      // against. The boundary is exact (§5.2.1): buy acquires the artifact
      // and ends, an agent-shaped posting engages the holder and continues.
      return (
        "an agent-shaped posting engages a holder and continues; buy acquires an artifact and ends. " +
        "To own and operate the agent, post a work-shaped buy whose deliverable is the agent; otherwise drop need.procurement."
      );
    }
    if (role !== undefined && profile !== undefined) {
      return "an agent-shaped posting carries exactly one of need.role or need.profile; naming both gives a candidate two different seats to answer";
    }
    if (role === undefined && profile === undefined) {
      return "an agent-shaped posting carries exactly one of need.role or need.profile: name the published role this seat fills, or state the profile inline where no role covers it";
    }
    if (role !== undefined) {
      // Presence, not content: the board does not resolve the registry or
      // check the role exists. A reference with no offering or no registry
      // names nothing, which is the one shape nobody could answer.
      if (!String(role.offering ?? "").trim()) return "need.role names a published role: role.offering is required";
      if (!String(role.registry ?? "").trim()) return "need.role names a published role: role.registry is required";
    } else {
      // Presence, not content, again. Prose or structured, the poster's
      // choice; an empty profile states no seat at all.
      const stated =
        typeof profile === "string"
          ? profile.trim().length > 0
          : typeof profile === "object" && profile !== null && !Array.isArray(profile) && Object.keys(profile).length > 0;
      if (!stated) return "need.profile states the seat inline, as prose or structure; an empty profile states nothing";
    }
    // rights_wanted and acceptance are buy machinery the standard says an
    // agent-shaped posting SHOULD omit. SHOULD, not MUST — and with
    // procurement absent the rent rules above already refuse rights_wanted,
    // so nothing more is refused here.
  }

  // ── who performs (§5.2.2) ─────────────────────────────────────────────
  const performer = input.need?.performer;
  if (performer !== undefined && !RFP_PERFORMER.includes(performer)) {
    return `need.performer must be one of ${RFP_PERFORMER.join(", ")}`;
  }
  if (performer !== undefined && seekingAgent) {
    // The standard's SHOULD-omit, taken as a refusal for the same reason the
    // role/profile rules are: a seat's holder is an agent by definition, so
    // the field on an agent-shaped posting either repeats `sought` or
    // contradicts it, and a contradiction is a posting no candidacy can read.
    return "an agent-shaped posting seeks an agent to hold a seat; need.performer repeats or contradicts that. Drop it.";
  }

  // ── how the poster hears (§5.8) ───────────────────────────────────────
  const mode = input.respond?.mode;
  if (mode !== undefined && !RFP_RESPOND_MODE.includes(mode)) {
    return `respond.mode must be one of ${RFP_RESPOND_MODE.join(", ")}`;
  }

  // ── resolution (§5.9) ─────────────────────────────────────────────────
  const res = input.resolution;
  if (res) {
    if (!RFP_RESOLUTION_RULE.includes(res.rule)) {
      return `resolution.rule must be one of ${RFP_RESOLUTION_RULE.join(", ")}`;
    }
    if (res.seats !== undefined && !(Number.isInteger(res.seats) && res.seats >= 1 && res.seats <= 500)) {
      return "resolution.seats must be a whole number from 1 to 500";
    }
    const admits = mode === "message" || mode === "either";
    if (res.seats !== undefined && res.seats > 1 && !admits) {
      // The standard's SHOULD-omit for proposal-mode seats, taken as a
      // refusal here because the board would be displaying a number nothing
      // enforces: the award is one per posting and multi-award is deferred.
      return "seats above one only mean something where respond.mode admits messages; a proposal-mode posting awards one response (multi-award is future work)";
    }
    if (res.rule === "at_close") {
      const at = Date.parse(String(res.decide_at ?? ""));
      if (Number.isNaN(at)) return "resolution.rule at_close needs resolution.decide_at, the instant before which nothing may be decided";
      if (at <= posted) return "resolution.decide_at must be after posted_at, or there is nothing the rule holds anyone to";
      if (at > expires) return "resolution.decide_at must be at or before expires_at: a decision instant after expiry decides nothing";
    } else if (res.decide_at !== undefined) {
      return "resolution.decide_at belongs to the at_close rule; drop it, or set resolution.rule to at_close";
    }
    if (res.rule === "first_come") {
      if (!admits) {
        // The standard's MAY-refuse, taken: "first" orders declared interest,
        // and a proposal-mode posting has none to order.
        return "first_come grants seats in arrival order of declared interest, which only exists where respond.mode is message or either";
      }
      if (seekingAgent) {
        return "an agent-shaped posting seeks one trusted holder for a seat; first_come would hand the seat to whoever arrives first, which is not that question";
      }
    }
  }

  // ── handling (§5.10) ──────────────────────────────────────────────────
  //
  // Shape only. What the tokens MEAN is the parties' business: this board
  // maintains no vocabulary of places and no map from a regime name to a
  // body of law, because either one would be wrong somewhere within a week
  // and wrong in a way a reader would trust.
  const hand = input.handling;
  if (hand) {
    const list = (v: unknown, field: string): string | null => {
      if (v === undefined) return null;
      if (!Array.isArray(v) || v.length === 0) {
        return `handling.${field} is a non-empty list; omit the member to ask nothing, because an empty list and an absent one would be two spellings of the same silence`;
      }
      if (v.length > HANDLING_LIST_MAX) {
        return `handling.${field} names at most ${HANDLING_LIST_MAX} entries; a longer list is an inventory wearing a requirement's clothes`;
      }
      const seen = new Set<string>();
      for (const raw of v) {
        if (typeof raw !== "string" || !raw.trim() || raw.length > HANDLING_TOKEN_MAX) {
          return `each handling.${field} entry is a non-empty string up to ${HANDLING_TOKEN_MAX} characters`;
        }
        if (seen.has(raw)) return `handling.${field} names ${raw} twice, which states nothing new`;
        seen.add(raw);
      }
      return null;
    };
    const badIn = list(hand.processed_in, "processed_in");
    if (badIn) return badIn;
    const badCompliance = list(hand.compliance, "compliance");
    if (badCompliance) return badCompliance;
    if (hand.promises !== undefined) {
      if (!Array.isArray(hand.promises) || hand.promises.length === 0) {
        return "handling.promises is a non-empty list; omit the member to require none";
      }
      for (const p of hand.promises) {
        if (!(HANDLING_PROMISES as readonly string[]).includes(p)) {
          // A closed vocabulary, unlike the two above, because this one is
          // compared mechanically and a typo would silently require nothing.
          return `handling.promises entries come from Agent SoW §5.11: ${HANDLING_PROMISES.join(", ")}`;
        }
      }
      if (new Set(hand.promises).size !== hand.promises.length) {
        return "handling.promises names the same promise twice, which states nothing new";
      }
    }
    if (hand.retention_max_days !== undefined) {
      const d = hand.retention_max_days;
      if (!(Number.isInteger(d) && d >= 1 && d <= HANDLING_RETENTION_MAX_DAYS)) {
        return `handling.retention_max_days is a whole number of days from 1 to ${HANDLING_RETENTION_MAX_DAYS}`;
      }
    }
    // A block with nothing but compliance in it is legitimate and stays: it
    // says "read this before answering" and refuses nobody. A block with
    // NOTHING in it is a requirement that requires nothing, which reads on
    // the page as terms the responder must meet.
    if (
      hand.processed_in === undefined &&
      hand.retention_max_days === undefined &&
      hand.promises === undefined &&
      hand.compliance === undefined
    ) {
      return "an empty handling block states terms and asks nothing; omit it instead";
    }
  }
  return null;
}

/** Assemble the version-1 document (unsigned, `id` empty) from an input the
 *  refusal above has passed. Grades are stamped here, once. */
export function assemblePosting(input: RfpPostingInput): Omit<RfpPostingDoc, "signatures"> {
  return {
    rfp: "v1",
    id: "",
    version: 1,
    language: String(input.language ?? "en").trim() || "en",
    posted_at: input.posted_at!,
    expires_at: input.expires_at,
    poster: {
      agent: input.poster.agent.trim(),
      ...(input.poster.handle ? { handle: String(input.poster.handle).trim() } : {}),
      owner: input.poster.owner.trim(),
      grade: "evidence",
    },
    need: { ...input.need, grade: "recorded" },
    ...(input.budget ? { budget: { ...input.budget, grade: "recorded" as const } } : {}),
    ...(input.term ? { term: { ...input.term, grade: "recorded" as const } } : {}),
    ...(input.award ? { award: { ...input.award, grade: "recorded" as const } } : {}),
    ...(input.respond ? { respond: { mode: input.respond.mode, grade: "recorded" as const } } : {}),
    ...(input.resolution ? { resolution: { ...input.resolution, grade: "recorded" as const } } : {}),
    ...(input.handling ? { handling: { ...input.handling, grade: "recorded" as const } } : {}),
  };
}

/**
 * Derive the identifier for a freshly assembled version-1 document, write it
 * in, and run the minting path's own diagnostic (standard §4.1.1: a minting
 * implementation SHOULD re-derive its own output once, before signing, which
 * is the last moment a wrong identifier is cheap to fix).
 */
export function mintPostingId(body: Omit<RfpPostingDoc, "signatures">): string {
  const id = rfpIdFor(body as unknown as Record<string, unknown>);
  const check = rfpIdFor({ ...(body as unknown as Record<string, unknown>), id });
  if (check !== id) {
    throw new Error(
      `rfp identifier derivation is unstable (${id} then ${check}): refusing to sign a damaged document`,
    );
  }
  return id;
}
