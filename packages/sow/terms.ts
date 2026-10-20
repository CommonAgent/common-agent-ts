/**
 * Liability (§5.13) and service floors (§5.14).
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { CURRENCY_RE, QUALIFICATION_ID_RE, invalidIn, isPosInt } from "./shared.js";
import { reportingEveryMs } from "./reporting.js";

const invalid: (message: string) => never = invalidIn("5.13");

// ── §5.13: liability ────────────────────────────────────────────────────────

/**
 * The liability clause (§5.13). Shapes pinned by `conformance/sow-terms.json`.
 *
 * Everything else in the specification bounds what the CLIENT can lose: the
 * cap, the reservation, the ceiling. Nothing bounds what the PROVIDER can
 * lose, and that asymmetry prices honest sellers out of exactly the work
 * worth selling. This clause is where the parties bound it, mutually, in the
 * signed bytes.
 *
 * `cap` is MUTUAL — it bounds each party's total liability to the other — and
 * is stated in exactly ONE form: a multiple of fees actually paid or payable,
 * or an absolute figure in a stated currency. `carve_outs` and
 * `indemnification` are PROSE, deliberately: nothing here refuses or gates on
 * a carve-out, so a closed vocabulary would buy determinism nothing needs,
 * and the sentence a judge reads is the operative artifact.
 *
 * Graded `recorded`, and this is the clause the grade vocabulary exists for:
 * no runtime enforces a liability cap, measures damages, or holds anyone
 * harmless — courts do, reading the signed document. A conforming renderer
 * MUST NOT present any part of this clause as enforced, and a runtime MUST
 * NOT refuse or gate anything on it. What the machinery provides is exactly
 * what it can: the clause sits inside the signed bytes, so neither party can
 * later dispute what was agreed.
 */
export interface SowLiability {
  /** Exactly one form — both or neither is refused. */
  cap: { multiple_of_fees: number } | { amount: number; currency: string };
  /** What the cap does NOT cover, in words a court reads. */
  carve_outs?: string[];
  /** Each party's hold-harmless statements, prose again, same reasoning. */
  indemnification?: { by_provider?: string[]; by_client?: string[] };
  /** Always `recorded` — see the validator's refusal for why nothing else is
   *  an honest grade here. */
  grade: "recorded";
}

/** The same backstops the §5.12 additions list carries — a backstop, not a
 *  policy. A clause stating dozens of carve-outs is a liability regime
 *  wearing a clause's clothes. */
const LIABILITY_PROSE_MAX = 300;
const LIABILITY_PROSE_ENTRIES_MAX = 10;

function checkLiabilityProse(v: unknown, name: string): void {
  if (!Array.isArray(v)) {
    invalid(`${name} is a list of prose statements a court reads, even with one entry (§5.13)`);
  }
  if (v.length === 0) {
    invalid(
      `an empty ${name} list declares nothing, which OMITTING the member already means; two spellings of one state is how implementations come to disagree about which is which (§5.13)`,
    );
  }
  if (v.length > LIABILITY_PROSE_ENTRIES_MAX) {
    invalid(
      `a liability clause states at most ${LIABILITY_PROSE_ENTRIES_MAX} ${name} entries; a clause stating dozens is a liability regime wearing a clause's clothes (§5.13)`,
    );
  }
  for (const e of v) {
    if (typeof e !== "string" || !e.trim() || e.length > LIABILITY_PROSE_MAX) {
      invalid(`each ${name} entry is a sentence a court reads, up to ${LIABILITY_PROSE_MAX} characters, and not blank (§5.13)`);
    }
  }
}

export function validateSowLiability(v: unknown): asserts v is SowLiability {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a liability clause is an object carrying cap and grade (§5.13)");
  }
  const l = v as Record<string, unknown>;
  if (typeof l.cap !== "object" || l.cap === null || Array.isArray(l.cap)) {
    invalid(
      "the cap is required, and it is an object: a liability clause exists to bound each party's exposure, and one that names no bound states nothing a court can read a number from (§5.13)",
    );
  }
  const cap = l.cap as Record<string, unknown>;
  const asMultiple = "multiple_of_fees" in cap;
  const asAmount = "amount" in cap || "currency" in cap;
  if (asMultiple && asAmount) {
    invalid(
      "the cap is stated in exactly ONE form — a multiple of fees, or an absolute amount with its currency, never both: two bounds in one cap is two clauses disagreeing about the number (§5.13)",
    );
  }
  if (!asMultiple && !asAmount) {
    invalid(
      "the cap is stated in exactly ONE form — multiple_of_fees, or amount with currency; a cap naming neither bounds nothing (§5.13)",
    );
  }
  if (asMultiple) {
    if (!isPosInt(cap.multiple_of_fees)) {
      invalid(
        "multiple_of_fees is a positive whole number, applied to fees actually paid or payable; a zero multiple caps at nothing, and a fractional one invites two implementations to round differently (§5.13)",
      );
    }
  } else {
    if (!isPosInt(cap.amount)) {
      invalid("cap.amount is a positive integer in the smallest unit of its currency — never a float, never zero (§5.13)");
    }
    if (typeof cap.currency !== "string" || !CURRENCY_RE.test(cap.currency)) {
      invalid("cap.currency is a three-letter uppercase code (§5.13)");
    }
  }
  if (l.carve_outs !== undefined) checkLiabilityProse(l.carve_outs, "carve_outs");
  if (l.indemnification !== undefined) {
    if (typeof l.indemnification !== "object" || l.indemnification === null || Array.isArray(l.indemnification)) {
      invalid("indemnification is an object carrying by_provider and/or by_client (§5.13)");
    }
    const ind = l.indemnification as Record<string, unknown>;
    if (ind.by_provider === undefined && ind.by_client === undefined) {
      invalid(
        "an indemnification member naming neither party's statements declares nothing, which OMITTING the member already means (§5.13)",
      );
    }
    if (ind.by_provider !== undefined) checkLiabilityProse(ind.by_provider, "indemnification.by_provider");
    if (ind.by_client !== undefined) checkLiabilityProse(ind.by_client, "indemnification.by_client");
  }
  if (l.grade !== "recorded") {
    invalid(
      "a liability clause is graded 'recorded', and this is the clause the grade vocabulary exists for: no runtime enforces a liability cap, measures damages, or holds anyone harmless — courts do, reading the signed document. " +
        "Not 'enforced' — a conforming renderer MUST NOT present any part of this clause as enforced, and a runtime MUST NOT refuse or gate anything on it — and not 'evidence', because what the machinery provides is exactly the record of what was agreed, nothing more (§5.13, §4.2)",
    );
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link disputesOf}.
 *
 * ABSENCE STATES NOTHING (§5.13). A document without a liability clause
 * leaves the parties wherever the law leaves them, which for the provider
 * usually means unbounded. There is deliberately no default cap: silence is
 * not a number, and a party that wants a bound writes one — so null here is
 * null, never a synthesized clause.
 */
export function liabilityOf(doc: unknown): SowLiability | null {
  if (typeof doc !== "object" || doc === null) return null;
  const l = (doc as { liability?: unknown }).liability;
  return typeof l === "object" && l !== null && !Array.isArray(l) ? (l as SowLiability) : null;
}

// ── §5.14: service floors ───────────────────────────────────────────────────

/**
 * One floor (§5.14): a bound over facts BOTH parties' records already hold.
 *
 * One kind in this revision — `each_task_within`, the span from a task's
 * request arriving to its terminal response, in the §5.12 duration grammar
 * ({@link reportingEveryMs} is the ONE duration reading in the system). The
 * vocabulary is closed and deliberately small, and it grows only where a
 * record exists to measure against: a floor written over something neither
 * party's records can check is not a floor, it is decoration. Uptime
 * percentages and latency percentiles are exactly that here.
 */
export interface SowServiceFloor {
  /** 1-40 lowercase letters, digits and dashes — the qualification-id shape,
   *  and what a recorded miss names. */
  id: string;
  each_task_within: string;
}

/**
 * The stated consequence (§5.14): after `misses` floor misses inside
 * `within`, the client MAY terminate for cause (§5.9), citing the recorded
 * misses. MAY, deliberately — the machinery counts and records, and the
 * client decides. Nothing terminates anyone automatically, because a floor
 * miss can have a cause the parties want to talk about first, and a remedy
 * exercised by a machine is a remedy nobody can waive.
 */
export interface SowServiceFloorsBreach {
  misses: number;
  within: string;
  remedy: "terminate_for_cause";
}

/** The closed remedy set — one member, deliberately, and it grows only with
 *  the spec: a remedy is what §5.9's existing machinery can carry, and a
 *  remedy invented here would promise an enforcement no runtime performs. */
export const SOW_FLOOR_REMEDIES: readonly ["terminate_for_cause"] = ["terminate_for_cause"];

/**
 * The service floors clause (§5.14). Shapes pinned by
 * `conformance/sow-terms.json`.
 *
 * The reporting clause (§5.12) catches the agent that is silently stuck;
 * this one catches the agent that is honestly, measurably slow. A miss is a
 * RECORDED OBLIGATION FAILURE, not a money movement: a task that ran past
 * its floor is recorded on the engagement the way a failed deliverable-form
 * check is (§5.4), from timestamps, with no new machinery. A refused task
 * misses no floor — refusal is its own record; floors bind work the provider
 * took.
 */
export interface SowServiceFloors {
  floors: SowServiceFloor[];
  /** REQUIRED: a floor without a stated consequence is decoration. */
  breach: SowServiceFloorsBreach;
  /** Always `evidence` — see the validator's refusal. */
  grade: "evidence";
}

/** A backstop, not a policy — the qualifications ceiling, for the same
 *  reason: a clause stating dozens of floors is an SLA wearing a clause's
 *  clothes. */
const SERVICE_FLOORS_MAX = 10;

export function validateSowServiceFloors(v: unknown): asserts v is SowServiceFloors {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a service floors clause is an object carrying floors, breach and grade (§5.14)");
  }
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.floors) || s.floors.length === 0) {
    invalid("floors is a non-empty list: a service floors clause that names no floor bounds nothing (§5.14)");
  }
  if (s.floors.length > SERVICE_FLOORS_MAX) {
    invalid(
      `a service floors clause states at most ${SERVICE_FLOORS_MAX} floors; a clause stating dozens is an SLA wearing a clause's clothes (§5.14)`,
    );
  }
  const seen = new Set<string>();
  for (const raw of s.floors) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      invalid("each floor is an object carrying id and each_task_within (§5.14)");
    }
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== "string" || !QUALIFICATION_ID_RE.test(f.id)) {
      invalid("a floor's id is 1-40 lowercase letters, digits and dashes — it is what a recorded miss names (§5.14)");
    }
    if (seen.has(f.id)) {
      invalid(`two floors share the id "${f.id}", and a recorded miss has to name one of them (§5.14)`);
    }
    seen.add(f.id);
    if (typeof f.each_task_within !== "string") {
      invalid(
        "each_task_within is the span from a task's request arriving to its terminal response, in the §5.12 duration grammar (§5.14)",
      );
    }
    // The §5.12 grammar, reused — ONE duration reading in the system. Its own
    // refusals ride along: a calendar month is refused by name here exactly as
    // it is on a reporting cadence.
    reportingEveryMs(f.each_task_within);
  }
  if (typeof s.breach !== "object" || s.breach === null || Array.isArray(s.breach)) {
    invalid(
      "breach — misses, within, remedy — is required: a floor without a stated consequence is decoration (§5.14)",
    );
  }
  const b = s.breach as Record<string, unknown>;
  if (!isPosInt(b.misses)) {
    invalid("breach.misses is a positive whole number of floor misses (§5.14)");
  }
  if (typeof b.within !== "string") {
    invalid("breach.within is the window the misses are counted inside, in the §5.12 duration grammar (§5.14)");
  }
  reportingEveryMs(b.within);
  if (b.remedy !== "terminate_for_cause") {
    invalid(
      "the remedy vocabulary is closed, and in this revision it has one member: 'terminate_for_cause' — §5.9's existing machinery carrying a stated cause. It grows only with the spec; a remedy invented here would promise an enforcement no runtime performs (§5.14)",
    );
  }
  if (s.grade !== "evidence") {
    invalid(
      "a service floors clause is graded 'evidence', flatly: the timestamps are in the records, the misses are recorded, and the termination-for-cause path is §5.9's existing machinery carrying a stated cause. " +
        "Not 'enforced' — nothing here pauses a slow task or makes a fast one, and a conforming renderer presents floors as agreed bounds with a record, never as a guarantee — and not 'recorded', because detecting the task that ran past its floor is a mechanical MUST, which is more than a record of the clause (§5.14, §4.2)",
    );
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link liabilityOf}.
 *
 * ABSENCE STATES NOTHING (§5.14): no floors were agreed, and no speed is
 * implied either way — null here is null, never a default bound.
 */
export function serviceFloorsOf(doc: unknown): SowServiceFloors | null {
  if (typeof doc !== "object" || doc === null) return null;
  const s = (doc as { service_floors?: unknown }).service_floors;
  return typeof s === "object" && s !== null && !Array.isArray(s) ? (s as SowServiceFloors) : null;
}
