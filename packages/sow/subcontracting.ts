/**
 * Subcontracting (§5.15): who does the work, and the terms that flow down
 * from the prime engagement to a subcontract.
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { invalidIn, isPosInt } from "./shared.js";
import { SOW_CONFIDENTIALITY_PROMISES, type SowConfidentialityPromise, statedJurisdictions } from "./confidentiality.js";
import { DEFAULT_REPORTING_LEVEL, SOW_REPORTING_LEVELS, type SowReportingLevel, meetsReportingLevel } from "./reporting.js";

const invalid: (message: string) => never = invalidIn("5.15");

// ── §5.15: subcontracting ───────────────────────────────────────────────────

/**
 * The closed posture vocabulary (§5.15). Exactly one per clause:
 *
 *  - `none`: the provider performs the work itself. On a mesh where
 *    delegation forms engagements, this is not merely a promise: the platform
 *    holds the engagement records, so on-mesh delegation under a `none`
 *    posture is discoverable evidence, not an argument.
 *  - `disclosed`: delegation is permitted, and every subcontractor is named
 *    in `subcontractors` before its work begins, each entry carrying who and
 *    the narrowest true statement of what is delegated.
 *  - `approved`: as `disclosed`, and each subcontractor additionally requires
 *    the client's countersigned approval before its work begins, riding the
 *    same two-seat machinery amendments use.
 *
 * Whatever the posture, the first principle is the one everything else hangs
 * from: THE BUYER'S CONTRACT IS WITH THE PRIME, FULL STOP. Delegation never
 * dilutes accountability — a subcontractor's failure surfaces to the client
 * as the provider's failure with its cause named, every remedy runs against
 * the provider, and a subcontractor answers to the provider, who is its
 * client in a separate engagement under this same specification.
 */
export type SowSubcontractingPosture = "none" | "disclosed" | "approved";

export const SOW_SUBCONTRACTING_POSTURES: readonly SowSubcontractingPosture[] = [
  "none",
  "disclosed",
  "approved",
];

/**
 * One named delegate (§5.15): a mesh agent by key or handle, or a published
 * role a conforming agent holds — at least one of the three — plus `scope`,
 * the narrowest true statement of what is delegated.
 *
 * **An entry names a party on the mesh, and the vocabulary offers no other
 * kind.** There is deliberately no free-text field for an off-mesh
 * organisation, for the same reason the qualification vocabulary (§12.1) has
 * no probe kind a runtime cannot check: a vocabulary must not express what
 * nothing can verify, and a disclosure nobody can look up, vouch, rate, or
 * hold to account is decoration wearing disclosure's clothes. Under any
 * stated posture, delegating work to a party this clause cannot name is
 * undisclosed subcontracting, which is breach. The parties remain free to
 * arrange anything they like outside this clause and outside this machinery;
 * what the vocabulary refuses to do is bless it.
 *
 * A subcontractor does WORK; a processor supplies a CAPABILITY. A party that
 * produces part of the deliverable or exercises judgment over the work
 * belongs here; a metered service under the provider's own direction (the
 * model API behind the agent) belongs in §5.11's processor list, where
 * off-mesh services are permitted because they are the provider's tools, not
 * its delegates.
 */
export interface SowSubcontractorEntry {
  /** The delegate's agent public key. Shape only: whether the key is real is
   *  the platform's problem. */
  agent?: string;
  /** The delegate's mesh handle. */
  handle?: string;
  /** A published role contract a conforming agent holds. */
  role?: string;
  /** REQUIRED: the narrowest true statement of what is delegated. */
  scope: string;
  /**
   * The §4.1 identifier of the countersigned engagement between this provider
   * and this delegate — the PIN.
   *
   * WHAT IT FIXES. Without it an entry names WHO but not UNDER WHAT, so chain
   * conformance can only be computed against whatever that delegate happens
   * to be offering when somebody asks. A chain that conformed at signature
   * drifts the moment a delegate reprices, loosens its retention or adds a
   * jurisdiction, and nothing in the document records that it moved. The
   * prime is then in breach of terms it never agreed to change.
   *
   * With it, {@link subcontractConformance} compares against a document that
   * cannot move: the engagement both parties signed. The subcontract changes
   * only by amendment, which §6.1 already puts a person in front of.
   *
   * This is what makes a SOLUTION signable. A composing organisation offering
   * several agents as one product can only promise terms it controls, and it
   * controls a delegate's terms exactly when it holds a countersigned
   * engagement with that delegate. Pinning each part at signature is the
   * difference between a product and a wiring diagram.
   *
   * Optional, because §5.15 also serves plain disclosure: naming who you
   * delegate to, with no engagement of your own to point at, is a true and
   * useful statement. A runtime that REQUIRES pins says so itself (the
   * `require_pins` option below); the vocabulary does not decide that for it.
   */
  engagement?: string;
}

/**
 * The subcontracting clause (§5.15). Shapes pinned by
 * `conformance/sow-subcontracting.json`.
 *
 * Graded `evidence`, flatly: the named chain and the on-mesh engagement
 * records are checkable and exportable, while the claim that nothing was
 * delegated off-mesh is `recorded` like every statement about conduct beyond
 * the mesh's sight — breach is its consequence, not detection its guarantee.
 *
 * The chain composes by the same rules, all the way down: disclosure
 * flattens upward, and terms only narrow going down — the deterministic
 * comparison {@link subcontractConformance} computes.
 */
export interface SowSubcontracting {
  posture: SowSubcontractingPosture;
  /** REFUSED when `posture` is `"none"` — a none clause naming delegates
   *  contradicts itself. Optional under the other postures: a disclosing
   *  clause with nobody named yet omits the member. */
  subcontractors?: SowSubcontractorEntry[];
  grade: "evidence";
}

const SOW_SUBCONTRACTING_POSTURE_SET: ReadonlySet<string> = new Set(SOW_SUBCONTRACTING_POSTURES);

/** Backstops, not policy — the same ceilings this file's other name-shaped
 *  strings get. */
const SUBCONTRACTORS_MAX = 16;
const SUBCONTRACTOR_AGENT_MAX = 64;
const SUBCONTRACTOR_HANDLE_MAX = 120;
const SUBCONTRACTOR_ROLE_MAX = 64;
const SUBCONTRACTOR_SCOPE_MAX = 300;
const SUBCONTRACTOR_ENGAGEMENT_MAX = 128;

export function validateSowSubcontracting(v: unknown): asserts v is SowSubcontracting {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a subcontracting clause is an object carrying posture and grade (§5.15)");
  }
  const s = v as Record<string, unknown>;
  if (typeof s.posture !== "string" || !SOW_SUBCONTRACTING_POSTURE_SET.has(s.posture)) {
    invalid(
      "a subcontracting clause's posture is 'none', 'disclosed' or 'approved' — exactly one, from a closed set (§5.15)",
    );
  }
  if (s.grade !== "evidence") {
    invalid(
      "a subcontracting clause is graded 'evidence', flatly: the named chain and the on-mesh engagement records are checkable and exportable. " +
        "Not 'enforced' — the claim that nothing was delegated off-mesh is beyond the mesh's sight, with breach as its consequence rather than detection as its guarantee — and not 'recorded', because on this mesh delegation forms engagements the platform holds, which is more than a record of the clause (§5.15, §4.2)",
    );
  }
  if (s.subcontractors === undefined) return;
  if (s.posture === "none") {
    invalid(
      "only a disclosing posture names delegates: a 'none' clause naming subcontractors is two clauses disagreeing about whether the provider delegates at all (§5.15)",
    );
  }
  if (!Array.isArray(s.subcontractors)) {
    invalid("subcontractors is a list of the named delegates, even with one entry (§5.15)");
  }
  if (s.subcontractors.length === 0) {
    invalid(
      "an empty subcontractors list declares nothing, which OMITTING the member already means — a disclosing clause with nobody named yet omits it; two spellings of one state is how implementations come to disagree about which is which (§5.15)",
    );
  }
  if (s.subcontractors.length > SUBCONTRACTORS_MAX) {
    invalid(
      `a subcontracting clause names at most ${SUBCONTRACTORS_MAX} subcontractors; a clause naming dozens is an org chart wearing a clause's clothes (§5.15)`,
    );
  }
  const seenAgents = new Set<string>();
  const seenHandles = new Set<string>();
  for (const raw of s.subcontractors) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      invalid("each subcontractor entry is an object carrying who — agent, handle or role — and the scope delegated (§5.15)");
    }
    const e = raw as Record<string, unknown>;
    if (
      e.agent !== undefined &&
      (typeof e.agent !== "string" || !e.agent.trim() || e.agent.length > SUBCONTRACTOR_AGENT_MAX)
    ) {
      invalid(
        `a subcontractor's agent is the delegate's public key as a non-empty string up to ${SUBCONTRACTOR_AGENT_MAX} characters — shape only: whether the key is real is the platform's problem (§5.15)`,
      );
    }
    if (
      e.handle !== undefined &&
      (typeof e.handle !== "string" || !e.handle.trim() || e.handle.length > SUBCONTRACTOR_HANDLE_MAX)
    ) {
      invalid(
        `a subcontractor's handle names the delegate's mesh handle, up to ${SUBCONTRACTOR_HANDLE_MAX} characters, and not blank (§5.15)`,
      );
    }
    if (
      e.role !== undefined &&
      (typeof e.role !== "string" || !e.role.trim() || e.role.length > SUBCONTRACTOR_ROLE_MAX)
    ) {
      invalid(
        `a subcontractor's role names the published role contract the delegate holds, up to ${SUBCONTRACTOR_ROLE_MAX} characters, and not blank (§5.15)`,
      );
    }
    if (e.agent === undefined && e.handle === undefined && e.role === undefined) {
      invalid(
        "a subcontractor entry names a party on the mesh — an agent by key or handle, or a published role a conforming agent holds — and this one names nobody; a disclosure nobody can look up, vouch, rate, or hold to account is decoration wearing disclosure's clothes (§5.15, §12.1)",
      );
    }
    if (typeof e.scope !== "string" || !e.scope.trim() || e.scope.length > SUBCONTRACTOR_SCOPE_MAX) {
      invalid(
        `a subcontractor's scope is the narrowest true statement of what is delegated, up to ${SUBCONTRACTOR_SCOPE_MAX} characters, and not blank — an entry that names who without what has disclosed nothing (§5.15)`,
      );
    }
    if (
      e.engagement !== undefined &&
      (typeof e.engagement !== "string" || !e.engagement.trim() || e.engagement.length > SUBCONTRACTOR_ENGAGEMENT_MAX)
    ) {
      invalid(
        `a subcontractor's engagement is the §4.1 identifier of the countersigned engagement this delegation runs under, up to ${SUBCONTRACTOR_ENGAGEMENT_MAX} characters, and not blank — the pin is what stops a delegate's terms moving under the party that promised them (§5.15)`,
      );
    }
    if (typeof e.agent === "string") {
      if (seenAgents.has(e.agent)) {
        invalid(
          "two subcontractor entries name the same agent; a reader cannot tell whether the second is a mistake or a second delegation — state the whole delegated scope on one entry (§5.15)",
        );
      }
      seenAgents.add(e.agent);
    }
    if (typeof e.handle === "string") {
      if (seenHandles.has(e.handle)) {
        invalid(
          "two subcontractor entries name the same handle; a reader cannot tell whether the second is a mistake or a second delegation — state the whole delegated scope on one entry (§5.15)",
        );
      }
      seenHandles.add(e.handle);
    }
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link disputesOf}, and the same discipline about
 * silence: ABSENCE STATES NOTHING (§5.15). A document without this clause
 * has said nothing about delegation either way, and a reader MUST NOT infer
 * a posture.
 */
export function subcontractingOf(doc: unknown): SowSubcontracting | null {
  if (typeof doc !== "object" || doc === null) return null;
  const s = (doc as { subcontracting?: unknown }).subcontracting;
  return typeof s === "object" && s !== null && !Array.isArray(s) ? (s as SowSubcontracting) : null;
}

// The structural reads the flow-down comparison rests on. DECLARED structure
// only: whether a clause validates is the validators' question, answered at
// document validation, not smuggled into a comparison that was asked
// something else — a member that does not read structurally is a member the
// document has not stated.
function confidentialityClauseOf(doc: unknown): Record<string, unknown> | null {
  if (typeof doc !== "object" || doc === null) return null;
  const c = (doc as { confidentiality?: unknown }).confidentiality;
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
}

function statedPromises(clause: Record<string, unknown> | null): Set<SowConfidentialityPromise> {
  const out = new Set<SowConfidentialityPromise>();
  const p = clause?.promises;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return out;
  for (const name of SOW_CONFIDENTIALITY_PROMISES) {
    if ((p as Record<string, unknown>)[name] === true) out.add(name);
  }
  return out;
}

function statedRetentionDays(clause: Record<string, unknown> | null): number | null {
  const r = clause?.retention;
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const days = (r as Record<string, unknown>).max_days;
  return isPosInt(days) ? days : null;
}

function statedReportingLevel(doc: unknown): SowReportingLevel | null {
  if (typeof doc !== "object" || doc === null) return null;
  const r = (doc as { reporting?: unknown }).reporting;
  if (typeof r === "object" && r !== null && !Array.isArray(r)) {
    const level = (r as Record<string, unknown>).level;
    if (typeof level === "string" && SOW_REPORTING_LEVELS.includes(level as SowReportingLevel)) {
      return level as SowReportingLevel;
    }
  }
  return null;
}

function statedTimeAndMaterialsCap(doc: unknown): number | null {
  if (typeof doc !== "object" || doc === null) return null;
  const price = (doc as { price?: unknown }).price;
  if (typeof price !== "object" || price === null || Array.isArray(price)) return null;
  const p = price as Record<string, unknown>;
  if (p.arrangement !== "time_and_materials") return null;
  const cap = p.cap;
  if (typeof cap !== "object" || cap === null || Array.isArray(cap)) return null;
  const amount = (cap as Record<string, unknown>).amount;
  return isPosInt(amount) ? amount : null;
}

/**
 * §5.15's chain rule as the computation it claims to be: does `subDoc` (the
 * delegate's engagement with the provider) narrow every checkable term of
 * `primeDoc` (the provider's engagement with its own client)? EMPTY where it
 * does — including terms met exactly, because narrowing includes staying
 * put — else one pinned sentence per violation, in a pinned order.
 *
 * Each term is checked ONLY where the prime states it: a prime that says
 * nothing constrains nothing. What "states" means is structural — the member
 * reads as its declared shape — because whether a clause validates is the
 * validators' question at document validation, and a comparison that
 * silently re-validated would answer a question nobody asked it. The v1
 * checks, in the order violations are reported:
 *
 *  (a) confidentiality promises: every promise the prime's clause makes must
 *      be made by the sub's — a sub that may train on content the prime
 *      promised never trains on breaks the chain. Compared in the closed
 *      vocabulary's declared order.
 *  (b) retention: the sub's ceiling is stated and no longer than the
 *      prime's; a sub silent while the prime states is a violation, because
 *      an unstated ceiling narrows nothing.
 *  (c) jurisdiction: the sub's `processed_in` is stated and a subset of the
 *      prime's; silent-while-stated violates for the same reason, and each
 *      jurisdiction outside the prime's set is its own sentence, in the
 *      sub's declared order.
 *  (d) reporting: the sub's level meets or exceeds the prime's. Silence here
 *      is §5.12's honest default — records_only — so it violates exactly
 *      where that floor does not meet the prime's level: the link above
 *      cannot meet its own reporting over a silent delegate.
 *  (e) the cap: where the caller supplies `prime_cap_remaining` (only the
 *      platform holding the money knows it) and the sub is time and
 *      materials, the sub's cap fits inside the remainder. Money is floored
 *      on the way in, the one way this file computes money.
 *
 * The sentences are pinned by `conformance/sow-subcontracting.json`,
 * byte-identical across SDKs: a provider refused a subcontract reads one
 * message whichever runtime computed the chain. A runtime MAY use a
 * violation to refuse forming a subcontract that could put the provider in
 * breach of the engagement above it; nothing in this function refuses
 * anything itself.
 */
export function subcontractConformance(
  primeDoc: unknown,
  subDoc: unknown,
  opts?: {
    prime_cap_remaining?: number;
    /**
     * The caller requires every named delegate to be PINNED to a
     * countersigned engagement, and reports violation (f) for any that is
     * not.
     *
     * OFF BY DEFAULT, and the default is the decision. §5.15 also serves
     * plain disclosure — naming who you delegate to, with no engagement of
     * your own to point at, is a true statement and this function must not
     * call it a breach. What requires pins is a particular kind of offer: a
     * solution, where one organisation promises terms for parts it does not
     * own and can only keep that promise for parts it has already contracted.
     * That is a policy of the runtime publishing the offer, not a property of
     * the vocabulary, so the runtime says it here rather than the document
     * carrying a flag about it.
     */
    require_pins?: boolean;
  },
): string[] {
  const violations: string[] = [];

  // (f) The pin, when the caller requires one. Reported FIRST because it is
  // the finding that invalidates the others: every check below compares the
  // prime against a sub document, and without a pin nothing says that this
  // document is the one the delegation actually runs under. A chain that
  // conforms against today's offer and was signed against last month's has
  // not been checked, it has been guessed at.
  if (opts?.require_pins) {
    const clause = subcontractingOf(primeDoc);
    for (const e of clause?.subcontractors ?? []) {
      if (typeof e.engagement === "string" && e.engagement.trim()) continue;
      const who = e.handle ?? e.agent ?? e.role ?? "a delegate";
      violations.push(
        `${who} is named as a delegate with no engagement pinned to it; terms that are not pinned can change after this is signed, and a party cannot promise terms it does not hold (§5.15)`,
      );
    }
  }
  const primeConf = confidentialityClauseOf(primeDoc);
  const subConf = confidentialityClauseOf(subDoc);

  // (a) The promises the prime made, in the closed vocabulary's order.
  const primeMakes = statedPromises(primeConf);
  const subMakes = statedPromises(subConf);
  for (const name of SOW_CONFIDENTIALITY_PROMISES) {
    if (!primeMakes.has(name)) continue;
    if (!subMakes.has(name)) {
      violations.push(
        `the prime promises ${name} and this subcontract does not; a delegate may not be freer with the content than the party that took it (§5.15)`,
      );
    }
  }

  // (b) Retention: a ceiling, and silence narrows nothing.
  const primeDays = statedRetentionDays(primeConf);
  if (primeDays !== null) {
    const subDays = statedRetentionDays(subConf);
    if (subDays === null) {
      violations.push(
        `the prime caps retention at ${primeDays} days and this subcontract states no retention ceiling; an unstated ceiling narrows nothing, and terms only narrow going down (§5.15)`,
      );
    } else if (subDays > primeDays) {
      violations.push(
        `the prime caps retention at ${primeDays} days and this subcontract keeps content up to ${subDays} days; a delegate may retain no longer than the party that took the content (§5.15)`,
      );
    }
  }

  // (c) Jurisdiction: a set, and the test is subset.
  const primeIn = statedJurisdictions(primeConf);
  if (primeIn !== null) {
    const subIn = statedJurisdictions(subConf);
    const list = primeIn.join(", ");
    if (subIn === null) {
      violations.push(
        `the prime confines processing to ${list} and this subcontract states no jurisdictions; an unstated jurisdiction may be any jurisdiction, and terms only narrow going down (§5.15)`,
      );
    } else {
      const allowed = new Set(primeIn);
      for (const j of subIn) {
        if (!allowed.has(j)) {
          violations.push(
            `the prime confines processing to ${list} and this subcontract processes in ${j}; a delegate may touch no jurisdiction the party above it did not (§5.15)`,
          );
        }
      }
    }
  }

  // (d) Reporting: ordinal, silence is the §5.12 floor, and the test is
  // meets or exceeds.
  const primeLevel = statedReportingLevel(primeDoc);
  if (primeLevel !== null) {
    const subLevel = statedReportingLevel(subDoc);
    if (subLevel === null) {
      if (!meetsReportingLevel(DEFAULT_REPORTING_LEVEL, primeLevel)) {
        violations.push(
          `the prime owes ${primeLevel} reporting and this subcontract declares none, which offers records_only; a delegate's reporting must be sufficient for the link above to meet its own (§5.15)`,
        );
      }
    } else if (!meetsReportingLevel(subLevel, primeLevel)) {
      violations.push(
        `the prime owes ${primeLevel} reporting and this subcontract offers ${subLevel}; a delegate's reporting must be sufficient for the link above to meet its own (§5.15)`,
      );
    }
  }

  // (e) The cap, where the caller knows the remainder. Floored on the way
  // in — the one way this file computes money.
  if (opts?.prime_cap_remaining !== undefined && Number.isFinite(opts.prime_cap_remaining)) {
    const remaining = Math.max(0, Math.floor(opts.prime_cap_remaining));
    const subCap = statedTimeAndMaterialsCap(subDoc);
    if (subCap !== null && subCap > remaining) {
      violations.push(
        `the subcontract's cap of ${subCap} is larger than what remains of the cap above it (${remaining}); at every link the cap fits inside the remainder of the cap above (§5.15)`,
      );
    }
  }

  return violations;
}
