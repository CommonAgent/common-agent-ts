/**
 * Reporting (§5.12): what arrives while there is still time to act.
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { type SowGrade, invalidIn } from "./shared.js";

const invalid: (message: string) => never = invalidIn("5.12");

// ── §5.12: reporting ────────────────────────────────────────────────────────

/**
 * What arrives while there is still time to act (§5.12).
 *
 * Everything else in the specification reports at the end of something — a
 * task completes or fails, an engagement lapses, a review is written — and all
 * of it arrives when it is already too late to act. The reporting clause says
 * what arrives DURING the work. Three levels, ordered, and the order is the
 * point: two parties compare as integers, and the test is meets or exceeds,
 * never equals — offering more than was asked is not a violation.
 *
 * `check_ins` exists because of the failure `on_change` cannot see: an agent
 * that is quietly stuck reports nothing under a change-triggered rule, because
 * from where it stands nothing has changed — its expectation is stable and
 * wrong. Hence the calendar, and hence the rule that a check-in is not a ping:
 * it MUST carry what was completed, what remains and what it waits on, so a
 * stuck provider cannot emit "on track" forever. Risk is contents of
 * `check_ins`, not a fourth level, and an open risk MUST name what would
 * dissolve it. A missed report rides §5.4's interim-deliverable machinery —
 * no parallel mechanism.
 */
export type SowReportingLevel = "records_only" | "on_change" | "check_ins";

/** Ascending: position IS the rank. The rank is derived from the level string
 *  and never declared, or the two could drift. */
export const SOW_REPORTING_LEVELS: readonly SowReportingLevel[] = [
  "records_only",
  "on_change",
  "check_ins",
];

/** What an absent clause offers: the mechanical record — task states,
 *  deliveries, spend — and nothing else. The honest default for short or
 *  cheap work. Absent is NOT unknown. */
export const DEFAULT_REPORTING_LEVEL: SowReportingLevel = "records_only";

/** §5.12 grades this clause flatly. Not `enforced`: no runtime can make a
 *  provider look honestly at its own work, and a report's content is a claim
 *  like any other. Not `recorded`: detecting the report that did not arrive
 *  is a MUST of both runtimes, which is more than a record of the clause.
 *  What is mechanical is whether it arrived. */
export const SOW_REPORTING_GRADE: SowGrade = "evidence";

export function reportingLevelRank(level: SowReportingLevel): number {
  return SOW_REPORTING_LEVELS.indexOf(level);
}

/** The §5.12 test: meets or exceeds, never equals. A provider offering
 *  `check_ins` against a requirement of `on_change` has exceeded it, not
 *  violated it. */
export function meetsReportingLevel(offered: SowReportingLevel, required: SowReportingLevel): boolean {
  return reportingLevelRank(offered) >= reportingLevelRank(required);
}

/** The clause (§5.12). Shapes pinned by `conformance/sow-reporting.json`. */
export interface SowReporting {
  level: SowReportingLevel;
  /** The cadence, an ISO 8601 duration like `P1W`. `check_ins` only, and
   *  required there: without it, the report that did not arrive cannot be
   *  detected, and §5.12's miss machinery has nothing to measure against. */
  every?: string;
  /** What arrives beyond the level's floor, in words a person reads. */
  additions?: string[];
  /** Always `evidence` — see {@link SOW_REPORTING_GRADE}. */
  grade: "evidence";
}

const REPORTING_ADDITION_MAX = 300;
/** A backstop, not a policy — mirrors §12.1's. A clause stating dozens of
 *  additions is a reporting regime wearing a clause's clothes. */
const REPORTING_ADDITIONS_MAX = 10;

const MS_PER_DAY = 86400000;

/**
 * The cadence in milliseconds, or a refusal (§5.12).
 *
 * ISO 8601 durations restricted to spans of FIXED length: weeks, days, hours,
 * minutes, seconds, in whole units of at most six digits per component, with
 * ISO's own rule that a week term stands alone. Months and years are refused
 * by name: a calendar month is not a fixed span of time, and a cadence two
 * runtimes measure differently is a missed-report detector that disagrees
 * with itself. The millisecond values are pinned by the fixture so both SDKs
 * derive the same deadline from the same document.
 */
export function reportingEveryMs(every: string): number {
  const shape = (): never =>
    invalid("every is an ISO 8601 duration in whole weeks, days, hours, minutes or seconds — P1W, P3D, PT12H (§5.12)");
  if (typeof every !== "string" || every[0] !== "P") shape();
  let i = 1;
  let inTime = false;
  let sawWeeks = false;
  let sawAny = false;
  let sawTimeComponent = false;
  // Order within each part: D before T; then H, M, S once each, in order.
  let last = 0;
  let total = 0;
  while (i < every.length) {
    if (every[i] === "T") {
      if (inTime || sawWeeks) shape();
      inTime = true;
      i += 1;
      continue;
    }
    let j = i;
    while (j < every.length && every[j] >= "0" && every[j] <= "9") j += 1;
    if (j === i || j - i > 6 || j >= every.length) shape();
    const n = Number(every.slice(i, j));
    const unit = every[j];
    if (!inTime) {
      if (unit === "W") {
        if (sawAny) invalid("an ISO 8601 week term stands alone: state the cadence as weeks or as days and time, not both (§5.12)");
        sawWeeks = true;
        total += n * 604800000;
      } else if (unit === "D") {
        if (sawWeeks || last > 0) shape();
        last = 1;
        total += n * MS_PER_DAY;
      } else if (unit === "M" || unit === "Y") {
        invalid(
          "a calendar month or year is not a fixed span of time, so a cadence stated in one is not computable the same way twice; state every in weeks, days or hours (§5.12)",
        );
      } else {
        shape();
      }
    } else {
      const order = unit === "H" ? 2 : unit === "M" ? 3 : unit === "S" ? 4 : shape();
      if (order <= last) shape();
      last = order;
      total += n * (unit === "H" ? 3600000 : unit === "M" ? 60000 : 1000);
      sawTimeComponent = true;
    }
    sawAny = true;
    i = j + 1;
  }
  if (!sawAny) shape();
  if (inTime && !sawTimeComponent) shape();
  if (total === 0) invalid("a cadence of zero is no cadence at all (§5.12)");
  return total;
}

export function validateSowReporting(v: unknown): asserts v is SowReporting {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a reporting clause is an object carrying level and grade (§5.12)");
  }
  const r = v as Record<string, unknown>;
  if (typeof r.level !== "string" || !SOW_REPORTING_LEVELS.includes(r.level as SowReportingLevel)) {
    invalid(
      "a reporting clause's level is 'records_only', 'on_change' or 'check_ins', in ascending order of what the provider owes (§5.12)",
    );
  }
  const level = r.level as SowReportingLevel;
  if (r.grade !== SOW_REPORTING_GRADE) {
    invalid(
      "a reporting clause is graded 'evidence', flatly: the cadence and contents are in the signed document, reports are exportable, and a miss is recorded. " +
        "Not 'enforced' — no runtime can make a provider look honestly at its own work — and not 'recorded', because detecting the report that did not arrive is a MUST (§5.12, §4.2)",
    );
  }
  if (level === "check_ins") {
    if (typeof r.every !== "string") {
      invalid(
        "check_ins is the level with a calendar: without every, the report that did not arrive cannot be detected, and §5.12's miss machinery has nothing to measure against",
      );
    }
    reportingEveryMs(r.every);
  } else if (r.every !== undefined) {
    invalid(
      "only check_ins carries every: on_change is change-triggered with no calendar, and records_only owes nothing beyond the mechanical record (§5.12)",
    );
  }
  if (r.additions !== undefined) {
    if (!Array.isArray(r.additions)) {
      invalid("additions is a list of what arrives beyond the level's floor, in words (§5.12)");
    }
    if (r.additions.length === 0) {
      invalid(
        "an empty additions list declares nothing, which OMITTING the member already means; two spellings of one state is how implementations come to disagree about which is which (§5.12)",
      );
    }
    if (r.additions.length > REPORTING_ADDITIONS_MAX) {
      invalid(
        `a reporting clause states at most ${REPORTING_ADDITIONS_MAX} additions; a clause stating dozens is a reporting regime wearing a clause's clothes (§5.12)`,
      );
    }
    for (const a of r.additions) {
      if (typeof a !== "string" || !a.trim() || a.length > REPORTING_ADDITION_MAX) {
        invalid(`each addition is a sentence a person reads, up to ${REPORTING_ADDITION_MAX} characters (§5.12)`);
      }
    }
  }
}

/** The clause a document declares, unvalidated, or null where it declares
 *  none. Same contract as {@link qualificationsOf}. */
export function reportingOf(doc: unknown): SowReporting | null {
  if (typeof doc !== "object" || doc === null) return null;
  const r = (doc as { reporting?: unknown }).reporting;
  return typeof r === "object" && r !== null && !Array.isArray(r) ? (r as SowReporting) : null;
}

/**
 * The advisory comparison a mandate uses: does what this document offers meet
 * `required`? Null where it meets — including everything against a
 * requirement of `records_only`, which is the floor every document meets.
 *
 * A shortfall is a SENTENCE, not a refusal: an advisory mandate marks the
 * document non-conforming and shows the sentence, and whoever stated the
 * requirement decides what to do about it. Three facts get three different
 * sentences — declared lower, declared nothing, declared something
 * unreadable — because "you offered less" and "what you offered cannot be
 * established" are different statements, and only one of them is about the
 * responder's choice. The exact wording is pinned by the fixture: a responder
 * reads one message whichever SDK evaluated it.
 *
 * The comparison is over two DECLARED fields (§5.12: the declaring party owns
 * its own structure) — nothing here reads anyone's prose.
 */
export function reportingShortfall(required: SowReportingLevel, doc: unknown): string | null {
  if (required === DEFAULT_REPORTING_LEVEL) return null;
  const raw = typeof doc === "object" && doc !== null ? (doc as { reporting?: unknown }).reporting : undefined;
  if (raw === undefined || raw === null) {
    return (
      `the required reporting level is ${required} and this document declares no reporting clause, ` +
      "which offers records_only, the mechanical record only; the test is meets or exceeds, and it does not meet (§5.12)"
    );
  }
  try {
    validateSowReporting(raw);
  } catch {
    return (
      `the required reporting level is ${required} and this document's reporting clause is in a shape that cannot be read, ` +
      "so what it offers cannot be established; it is counted as not meeting rather than passed unread (§5.12)"
    );
  }
  const offered = (raw as SowReporting).level;
  if (meetsReportingLevel(offered, required)) return null;
  return `the required reporting level is ${required} and this document offers ${offered}; the test is meets or exceeds, and it does not meet (§5.12)`;
}

/**
 * §5.12's "cadence follows the money", as the warning a runtime MAY show and
 * the refusal it MUST NOT make.
 *
 * Where the engagement has a cap, `every` SHOULD be shorter than the time in
 * which the provider could spend what remains of it — weekly check-ins on an
 * engagement whose whole cap can burn in a day are decoration. The derivation
 * rests on a spend rate neither party knows exactly in advance, so
 * `spendPerDay` is whatever the caller measured (a metering platform has an
 * observed rate; a client node may only have an estimate), and no answer here
 * refuses anything. Zero cap or zero spend is no derivation at all: null.
 *
 * Money is floored on the way in — the one way this file computes money — and
 * the boundary is exact: warn when `everyMs * spendPerDay >=
 * capRemaining * msPerDay`, cross-multiplied in BigInt so two implementations
 * cannot disagree by one at the boundary. "Not shorter" includes "equal": an
 * interval that exactly covers the burn still lets the money be gone when the
 * report arrives.
 */
export function reportingCadenceWarning(
  reporting: SowReporting,
  capRemaining: number,
  spendPerDay: number,
): string | null {
  if (reporting.level !== "check_ins" || typeof reporting.every !== "string") return null;
  const cap = Math.floor(capRemaining);
  const spend = Math.floor(spendPerDay);
  if (cap <= 0 || spend <= 0) return null;
  const everyMs = reportingEveryMs(reporting.every);
  if (BigInt(everyMs) * BigInt(spend) < BigInt(cap) * BigInt(MS_PER_DAY)) return null;
  return (
    `at ${spend} per day, the remaining cap of ${cap} can be spent within one reporting interval of ${reporting.every}; ` +
    "the money can be gone before the next check-in arrives (§5.12: cadence follows the money). " +
    "A runtime MAY warn on this and MUST NOT refuse the engagement over it"
  );
}
