/**
 * The price clause (§5.5): the pricing arrangement, fixed fees, time and
 * materials with its cap and reservation, no charge, rating usage against a
 * schedule, settlement lines, and the operator fee (§5.5.8).
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { CURRENCY_RE, METER_NAME_RE, SOW_GRADES, type SowGrade, invalidIn, isNonNegInt, isPosInt } from "./shared.js";

const invalid: (message: string) => never = invalidIn("5.5");

// ── §2 / §5.5: the pricing arrangement ──────────────────────────────────────

/** The basis on which an engagement prices work (§2, §5.5). Every engagement
 *  declares one; there is no undeclared default. */
export type PricingArrangement = "fixed_fee" | "time_and_materials" | "no_charge";

/** The closed set. A price clause naming anything else is a validation error. */
export const PRICING_ARRANGEMENTS: ReadonlySet<string> = new Set<PricingArrangement>([
  "fixed_fee",
  "time_and_materials",
  "no_charge",
]);


/** The window a spend ceiling is measured over (§5.5.1). */
export type SowPeriod = "month";

// ── §5.5.1: fixed fee ───────────────────────────────────────────────────────

/** One published rate: this offering costs this much per task. Money is an
 *  integer in the smallest unit of the clause's `currency` — never a float. */
export interface SowFixedFeeRate {
  offering: string;
  per_task: number;
}

/** An optional spend ceiling per period (§5.5.1). Work beyond it is refused
 *  with a quote rather than performed and billed. */
export interface SowCeiling {
  amount: number;
  period: SowPeriod;
}

/** §5.5.1 — rates per offering, the settlement currency, an optional ceiling.
 *  The price of a task is known before the task runs. */
export interface SowFixedFeePrice {
  arrangement: "fixed_fee";
  currency: string;
  rates: SowFixedFeeRate[];
  ceiling?: SowCeiling;
  grade: SowGrade;
}

// ── §5.5.2: time and materials ──────────────────────────────────────────────

/**
 * One line of a rate schedule (§5.5.2): a meter, the divisor that turns its
 * raw counts into billable units, the price of one unit, and a label a person
 * reads.
 *
 * `per` is the divisor — how many raw meter counts make one billable unit. A
 * positive integer, defaulting to 1. `unit` is a LABEL FOR PEOPLE and carries
 * no arithmetic: a runtime MUST rate on `per` and MUST NOT parse `unit`.
 *
 * That split is the buyer's protection, not decoration. Time and materials has
 * no deliverable to accept (§5.5.5), so all the buyer has is a meter it can
 * check independently — and a unit of "1000 tokens" that only a human can
 * convert defeats exactly that. The divisor puts the conversion inside the
 * signed bytes, where both parties compute the same charge from the same
 * counts.
 *
 * `pass_through` marks a line the provider bought elsewhere (§5.5.6). It is
 * billed at cost against an upstream receipt, never above it.
 */
export interface SowScheduleLine {
  meter: string;
  unit: string;
  /** The divisor (§5.5.2). Positive integer; defaults to 1 when absent. */
  per?: number;
  per_unit: number;
  pass_through?: boolean;
}

/** The divisor a line rates by: its `per`, or 1 when it names none (§5.5.2). */
export function divisorOf(line: SowScheduleLine): number {
  return line.per ?? 1;
}

/**
 * What one line charges for a raw meter count: `floor(count × per_unit / per)`
 * (§5.5.2).
 *
 * The floor is deliberate and it favours the buyer — a partial unit never
 * charges a partial unit's money. The arithmetic runs in BigInt because
 * `count × per_unit` overflows a double long before either factor does, and
 * two SDKs that disagree by one micro-unit are two SDKs that disagree about
 * the bill.
 */
export function rateLine(line: SowScheduleLine, count: number): number {
  if (!isNonNegInt(count)) invalid(`the count for '${line.meter}' must be a non-negative integer`);
  const amount =
    (BigInt(count) * BigInt(line.per_unit)) / BigInt(divisorOf(line));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(`rating '${line.meter}' overflows an exact integer — split the settlement`);
  }
  return Number(amount);
}

/** The not-to-exceed cap (§5.5.3). Mandatory on every time and materials
 *  engagement: there is no uncapped one, and this is the single number an Agent
 *  Mandate ceiling check tests before formation. */
export interface SowCap {
  amount: number;
}

/** The reservation window (§5.5.4). Funds are reserved for the cap amount when
 *  the engagement forms and the unused remainder is released at the end of the
 *  window. The window MUST NOT extend beyond `ends_at`. */
export interface SowReservation {
  window_days: number;
}

/** §5.5.2 — a rate schedule over declared meters, with the mandatory §5.5.3
 *  cap and the mandatory §5.5.4 reservation. Both are REQUIRED: a time and
 *  materials price missing either does not typecheck and does not validate.
 *  The arrangement is a purchase order, and a purchase order that commits no
 *  funds and names no period has no defined settlement behaviour. */
export interface SowTimeAndMaterialsPrice {
  arrangement: "time_and_materials";
  currency: string;
  schedule: SowScheduleLine[];
  /** REQUIRED (§5.5.3). Never make this optional. */
  cap: SowCap;
  /** REQUIRED (§5.5.4). Never make this optional. */
  reservation: SowReservation;
  grade: SowGrade;
}

// ── §5.5.7: no charge ───────────────────────────────────────────────────────

/**
 * §5.5.7 — the provider charges nothing for the work.
 *
 * The clause carries the arrangement and its grade and nothing else. Every
 * price field §5.5 defines is typed `never` here, so a clause carrying one does
 * not compile: there is no rate to state, no ceiling to test, and no cap to
 * reserve against. The list is exhaustive on purpose — §5.5.7 refuses
 * `currency`, `rates`, `schedule`, `cap`, `reservation`, `ceiling` "or any
 * other price field", and {@link validateSowPrice} enforces that wider rule for
 * untyped callers by refusing any member beyond `arrangement` and `grade`.
 *
 * Everything else about the engagement is ordinary. It forms, amends,
 * terminates and lapses like any other, produces the same task and evidence
 * records, and may be reviewed under §15 — so an agent that works for nothing
 * still earns a reputation from the work.
 */
export interface SowNoChargePrice {
  arrangement: "no_charge";
  grade: SowGrade;
  /** §5.5.7: there is no settlement currency, because nothing settles. */
  currency?: never;
  /** §5.5.7: there is no rate to state. */
  rates?: never;
  /** §5.5.7: there is no schedule to meter. */
  schedule?: never;
  /** §5.5.7: there is no cap to reserve against. */
  cap?: never;
  /** §5.5.7: nothing is reserved, because nothing is drawn. */
  reservation?: never;
  /** §5.5.7: there is no ceiling to test. */
  ceiling?: never;
}

/** The price clause (§5.5), discriminated on `arrangement`. */
export type SowPrice = SowFixedFeePrice | SowTimeAndMaterialsPrice | SowNoChargePrice;

// A compile-time proof of §5.5.7's refusal, checked by `tsc --noEmit` on every
// build. The test suite cannot make this assertion — `tsconfig.json` excludes
// `__tests__` and vitest does not typecheck — so the guard lives here, beside
// the type it guards. Delete the `never` fields from SowNoChargePrice and this
// stops compiling, which is the point: a clause carrying a price field must not
// be a SowPrice at all, not merely something the validator catches later.
type _Assert<T extends true> = T;
type _NotAssignable<A, B> = [A] extends [B] ? false : true;
type _NoChargeRejectsACurrency = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; currency: string; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsACap = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; cap: SowCap; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsRates = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; rates: SowFixedFeeRate[]; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsASchedule = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; schedule: SowScheduleLine[]; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsAReservation = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; reservation: SowReservation; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsACeiling = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; ceiling: SowCeiling; grade: SowGrade }, SowPrice>
>;
/** The clause the specification writes IS assignable, which is the other half:
 *  the proofs above must fail for carrying a price, not for being no-charge. */
type _NoChargeItselfIsAPrice = _Assert<
  [{ arrangement: "no_charge"; grade: SowGrade }] extends [SowPrice] ? true : false
>;

export function isTimeAndMaterials(price: SowPrice): price is SowTimeAndMaterialsPrice {
  return price.arrangement === "time_and_materials";
}

export function isFixedFee(price: SowPrice): price is SowFixedFeePrice {
  return price.arrangement === "fixed_fee";
}

export function isNoCharge(price: SowPrice): price is SowNoChargePrice {
  return price.arrangement === "no_charge";
}


/**
 * Build a `fixed_fee` price clause (§5.5.1).
 *
 * The arrangement is stamped here, so a caller that already constructed a fixed
 * fee price before 0.4.0 introduced the field does not have to learn about it —
 * pass what you always passed and get a conformant 0.4.0 clause back. What is
 * NOT offered is a reader that infers `fixed_fee` from a clause that names no
 * arrangement: §5.5 makes that a validation error a runtime MUST refuse, and a
 * silent upgrade at admission would be exactly the defaulting the spec forbids.
 */
export function fixedFeePrice(init: {
  currency: string;
  rates: readonly SowFixedFeeRate[];
  ceiling?: SowCeiling;
  grade?: SowGrade;
}): SowFixedFeePrice {
  const price: SowFixedFeePrice = {
    arrangement: "fixed_fee",
    currency: init.currency,
    rates: init.rates.map((r) => ({ offering: r.offering, per_task: r.per_task })),
    ...(init.ceiling !== undefined ? { ceiling: { ...init.ceiling } } : {}),
    grade: init.grade ?? "enforced",
  };
  validateSowPrice(price);
  return price;
}

/**
 * Build a `time_and_materials` price clause (§5.5.2).
 *
 * `cap` and `reservation` are required parameters, not options with defaults.
 * §5.5.3 says there is no uncapped time and materials engagement and §5.5.4
 * says there is no unreserved one, so there is no call shape here that produces
 * either. Omitting one is a compile error, and one arriving as `undefined` from
 * untyped JavaScript is refused at construction.
 */
export function timeAndMaterialsPrice(init: {
  currency: string;
  schedule: readonly SowScheduleLine[];
  cap: SowCap;
  reservation: SowReservation;
  grade?: SowGrade;
}): SowTimeAndMaterialsPrice {
  if (init.cap === undefined || init.cap === null) {
    invalid(
      "a time and materials engagement MUST carry a not-to-exceed cap — there is no uncapped " +
        "time and materials engagement (§5.5.3)",
    );
  }
  if (init.reservation === undefined || init.reservation === null) {
    invalid(
      "a time and materials engagement MUST carry a reservation with a stated window — an " +
        "arrangement that commits no funds and names no period has no defined settlement " +
        "behaviour (§5.5.4)",
    );
  }
  const price: SowTimeAndMaterialsPrice = {
    arrangement: "time_and_materials",
    currency: init.currency,
    schedule: init.schedule.map((l) => ({
      meter: l.meter,
      unit: l.unit,
      ...(l.per !== undefined ? { per: l.per } : {}),
      per_unit: l.per_unit,
      ...(l.pass_through === true ? { pass_through: true } : {}),
    })),
    cap: { amount: init.cap.amount },
    reservation: { window_days: init.reservation.window_days },
    grade: init.grade ?? "enforced",
  };
  validateSowPrice(price);
  return price;
}

/**
 * Build a `no_charge` price clause (§5.5.7).
 *
 * There is nothing to pass but the grade, and that is the whole design. The
 * init object has no slot for a currency, a rate, a schedule, a cap, a
 * reservation or a ceiling, so a caller cannot supply one by accident, and a
 * caller who casts around the type is refused by `validateSowPrice` on the way
 * out.
 */
export function noChargePrice(init: { grade?: SowGrade } = {}): SowNoChargePrice {
  const price: SowNoChargePrice = {
    arrangement: "no_charge",
    grade: init.grade ?? "enforced",
  };
  validateSowPrice(price);
  return price;
}

// ── validation ──────────────────────────────────────────────────────────────

/** The two members a `no_charge` clause may carry, and nothing else (§5.5.7). */
const NO_CHARGE_MEMBERS: ReadonlySet<string> = new Set(["arrangement", "grade"]);

/**
 * Shape check for a price clause (§5.5), per `conformance/sow-pricing.json`.
 *
 * The three refusals that matter most: a clause naming no arrangement (§5.5), a
 * time and materials clause with no cap (§5.5.3), and a no-charge clause
 * carrying a price field (§5.5.7). All three are the spec's own MUSTs and all
 * three fail closed — a proposal carrying any of them is refused rather than
 * repaired.
 */
export function validateSowPrice(v: unknown): asserts v is SowPrice {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid("must be an object");
  const p = v as Record<string, unknown>;

  if (p.arrangement === undefined) {
    invalid("every engagement declares an arrangement — there is no undeclared default");
  }
  if (typeof p.arrangement !== "string" || !PRICING_ARRANGEMENTS.has(p.arrangement)) {
    invalid("arrangement is 'fixed_fee', 'time_and_materials' or 'no_charge'");
  }
  if (typeof p.grade !== "string" || !SOW_GRADES.has(p.grade)) {
    invalid("grade is 'enforced', 'evidence' or 'recorded' (§4.2)");
  }

  if (p.arrangement === "no_charge") {
    // §5.5.7 refuses a named list and then everything else, so this is a
    // membership check rather than six field checks: a clause carrying any
    // member beyond the arrangement and its grade is malformed.
    for (const member of Object.keys(p)) {
      if (NO_CHARGE_MEMBERS.has(member)) continue;
      invalid(
        `a no_charge clause carries the arrangement and its grade and nothing else, so it ` +
          `MUST NOT carry '${member}'. There is no rate to state, no ceiling to test, and no ` +
          "cap to reserve against (§5.5.7)",
      );
    }
    return;
  }

  if (typeof p.currency !== "string" || !CURRENCY_RE.test(p.currency)) {
    invalid("currency is a three-letter uppercase code");
  }

  if (p.arrangement === "fixed_fee") {
    if (!Array.isArray(p.rates) || p.rates.length === 0) {
      invalid("fixed_fee prices work per offering — rates must be a non-empty array");
    }
    const seen = new Set<string>();
    for (const r of p.rates as unknown[]) {
      if (typeof r !== "object" || r === null) invalid("each rate is an object");
      const rate = r as Record<string, unknown>;
      if (typeof rate.offering !== "string" || rate.offering === "") {
        invalid("each rate names an offering");
      }
      if (seen.has(rate.offering)) invalid(`two rates for offering '${rate.offering}'`);
      seen.add(rate.offering);
      if (!isNonNegInt(rate.per_task)) {
        invalid("per_task is a non-negative integer in the smallest unit of currency");
      }
    }
    if (p.ceiling !== undefined) validateCeiling(p.ceiling);
    if (p.schedule !== undefined) invalid("a fixed_fee clause carries no schedule");
    if (p.cap !== undefined) invalid("a fixed_fee clause carries no cap — it carries a ceiling");
    return;
  }

  // time_and_materials
  if (!Array.isArray(p.schedule) || p.schedule.length === 0) {
    invalid("time_and_materials is a rate schedule — schedule must be a non-empty array");
  }
  const meters = new Set<string>();
  for (const l of p.schedule as unknown[]) {
    if (typeof l !== "object" || l === null) invalid("each schedule line is an object");
    const line = l as Record<string, unknown>;
    if (typeof line.meter !== "string" || !METER_NAME_RE.test(line.meter)) {
      invalid("each schedule line names a meter matching ^[a-z0-9_]{1,64}$");
    }
    if (meters.has(line.meter)) invalid(`the schedule prices '${line.meter}' twice`);
    meters.add(line.meter);
    if (typeof line.unit !== "string" || line.unit === "") {
      invalid("each schedule line carries a unit label for the people reading it");
    }
    if (line.per !== undefined && !isPosInt(line.per)) {
      invalid(
        "per is the divisor — how many raw meter counts make one billable unit — and is a " +
          "positive integer, defaulting to 1 when absent (§5.5.2)",
      );
    }
    if (!isNonNegInt(line.per_unit)) {
      invalid("per_unit is a non-negative integer in the smallest unit of currency");
    }
    if (line.pass_through !== undefined && line.pass_through !== true) {
      invalid("pass_through, when present, is the literal true (§5.5.6)");
    }
  }

  if (p.cap === undefined) {
    invalid(
      "a time and materials engagement MUST carry a not-to-exceed cap — there is no uncapped " +
        "time and materials engagement (§5.5.3)",
    );
  }
  if (typeof p.cap !== "object" || p.cap === null || Array.isArray(p.cap)) {
    invalid("cap is an object carrying an amount (§5.5.3)");
  }
  if (!isPosInt((p.cap as Record<string, unknown>).amount)) {
    invalid("cap.amount is a positive integer — a zero cap admits no work at all (§5.5.3)");
  }

  if (p.reservation === undefined) {
    invalid(
      "a time and materials engagement MUST carry a reservation with a stated window — the " +
        "arrangement is a purchase order, and one that commits no funds and names no period " +
        "has no defined settlement behaviour (§5.5.4)",
    );
  }
  const r = p.reservation as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    invalid("reservation is an object carrying window_days (§5.5.4)");
  }
  if (!isPosInt(r.window_days)) invalid("reservation.window_days is a positive integer (§5.5.4)");

  if (p.rates !== undefined) invalid("a time_and_materials clause carries no rates");
  if (p.ceiling !== undefined) {
    invalid("a time_and_materials clause carries a cap, not a per-period ceiling (§5.5.3)");
  }
}

function validateCeiling(v: unknown): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid("ceiling is an object");
  const c = v as Record<string, unknown>;
  if (!isPosInt(c.amount)) invalid("ceiling.amount is a positive integer");
  if (c.period !== "month") invalid("ceiling.period is 'month'");
}

/** Shape, then the arrangement's own rules. Throws rather than returning a
 *  verdict, so a caller that forgets to check cannot proceed on a bad clause. */
export function loadSowPrice(v: unknown): SowPrice {
  validateSowPrice(v);
  return v;
}

/**
 * §5.5.2 — a schedule MUST NOT price a meter the offering does not declare.
 *
 * The other half of that sentence (a runtime MUST NOT bill a meter the schedule
 * does not price) is enforced by {@link rateUsage}, which refuses an unpriced
 * meter rather than dropping it.
 */
export function validateScheduleAgainstMeters(
  price: SowTimeAndMaterialsPrice,
  declaredMeters: readonly string[],
): void {
  const declared = new Set(declaredMeters);
  for (const line of price.schedule) {
    if (!declared.has(line.meter)) {
      invalid(
        `the schedule prices '${line.meter}', which the offering does not declare — ` +
          "this is a validation error, not a default to be filled in (§5.5.2)",
      );
    }
  }
}

// ── §5.5.4: the reservation window ──────────────────────────────────────────

const DAY_MS = 86_400_000;

/** When the reservation releases: `window_days` after the engagement forms.
 *  The unused remainder of the cap returns to the client at this instant. */
export function reservationReleaseAt(reservation: SowReservation, startsAt: string): string {
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) invalid("starts_at must be an RFC-3339 instant (§5.5.4)");
  return new Date(start + reservation.window_days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * §5.5.4 — the window MUST NOT extend beyond `ends_at`.
 *
 * An engagement whose term outlasts its window needs a new reservation before
 * more work runs; an engagement whose window outlasts its term is holding the
 * client's money past the point any work can consume it.
 */
export function reservationWithinTerm(
  reservation: SowReservation,
  startsAt: string,
  endsAt: string,
): boolean {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return false;
  return Date.parse(reservationReleaseAt(reservation, startsAt)) <= end;
}

// ── rating, the cap, and §5.5.5 exhaustion ──────────────────────────────────

/** A RAW meter count, in the meter's own natural grain (§5.5.2). Raw, not
 *  pre-divided: the schedule's `per` does the conversion, inside the signed
 *  bytes, so the buyer's own token count is the number it hands in. */
export interface SowMeteredCount {
  meter: string;
  count: number;
}

/** One line of a settlement record (§5.5, §5.5.6).
 *
 *  It carries everything the charge was computed from — the raw `count`, the
 *  `per` divisor and the `per_unit` price — so a buyer can recompute `amount`
 *  from its own records without holding the engagement. That is the whole
 *  point of §5.5.2's machine-readable divisor. */
export interface SowSettlementLine {
  meter: string;
  /** The human label the schedule carried. Never parsed. */
  unit: string;
  count: number;
  /** The divisor actually applied, written out even when it is 1. */
  per: number;
  per_unit: number;
  amount: number;
  /** Present and `true` only on a line the provider bought elsewhere. */
  pass_through?: true;
  /** REQUIRED on a pass-through line (§5.5.6): the upstream receipt that
   *  evidences the cost. The proof is usually free — the upstream engagement
   *  settled and issued its own record. */
  upstream_receipt?: string;
  /** OPTIONAL evidence of what the upstream actually charged. When present it
   *  is checked: a pass-through line MUST NOT be priced above the upstream
   *  cost (§5.5.6). */
  upstream_amount?: number;
}

/** What rating a batch of metered units produced (§5.5.2, §5.5.3, §5.5.5). */
export interface SowRating {
  currency: string;
  lines: SowSettlementLine[];
  /** The sum of `lines`: the PROVIDER's rated total, already clamped so that it
   *  plus the operator fee taken on it never exceeds the cap (§5.5.3). */
  total: number;
  /** The operator fee taken on `total` (§5.5.8). Present only where a basis was
   *  supplied AND something was rated: a fee is a cut out of what the client
   *  pays, so where nothing was billed nothing was taken. */
  operator_fee?: SowOperatorFee;
  /** What the CLIENT pays for this rating: `total` plus the fee inside it. Equal
   *  to `total` where no operator stands in the path. */
  client_total: number;
  /** How much of the cap remains after this rating, measured as REMAINING
   *  CLIENT EXPOSURE — cap less everything the client has been billed, fees
   *  included (§5.5.3). Where no fee is in play this is the same number it has
   *  always been. */
  cap_remaining: number;
  /** True when the cap has been reached: admission stops and the engagement
   *  moves to `exhausted` (§5.5.5). "Reached" means no further rated work fits
   *  under the remaining exposure once the fee on it is counted. */
  exhausted: boolean;
  /** What the schedule would have charged before the cap clamped it. The
   *  difference is the provider's to bear (§5.5.3). */
  unbilled: number;
}

/**
 * Rate raw meter counts against a time and materials schedule, honouring the
 * cap.
 *
 * Counts are RAW, in each meter's natural grain: the schedule's `per` divisor
 * does the conversion (§5.5.2), so the buyer hands in the same token count it
 * can read off its own records and gets back the same charge either side
 * computes.
 *
 * Three MUSTs are enforced here. A meter the schedule does not price is refused
 * rather than billed (§5.5.2). Metered usage is not billed past the cap
 * (§5.5.3) — the total clamps, `unbilled` records what the provider absorbed,
 * and `exhausted` says the work is concluded. And **the cap bounds what the
 * CLIENT pays, fee included** (§5.5.3, §5.5.8): where `operatorFeeBasis` names
 * an operator's cut, the provider's rated work runs to the cap LESS the fee
 * taken on it, and reaching that limit reaches the cap in the ordinary way. A
 * runtime MUST NOT bill the client a sum of provider lines and operator fees
 * greater than the cap.
 *
 * `alreadyBilled` is what the CLIENT has been billed under this engagement so
 * far, INCLUDING any operator fees inside those charges, so the cap is measured
 * over the engagement rather than over one batch and measures the client's real
 * exposure. Callers that take no fee are unaffected: with no basis every number
 * here means exactly what it meant before.
 */
export function rateUsage(
  price: SowTimeAndMaterialsPrice,
  usage: readonly SowMeteredCount[],
  opts: {
    alreadyBilled?: number;
    receipts?: Readonly<Record<string, string>>;
    /** §5.5.8 — the operator's cut on this rating, as the basis it is computed
     *  from. A basis rather than a built line, because the amount follows from
     *  the rated total and the rated total is what this function decides. */
    operatorFeeBasis?: SowOperatorFeeBasis;
    /** Who takes the cut, written onto the line this rating produces. */
    operator?: string;
  } = {},
): SowRating {
  // §5.5.7's first prohibition, backing the type up for untyped callers: a
  // runtime MUST NOT rate work under a no-charge engagement. Rating it would
  // produce a zero-valued settlement record for every task, which is the
  // design §5.5.7 exists to rule out.
  const clause = price as unknown as SowPrice;
  if (clause?.arrangement === "no_charge") {
    invalid(
      "this engagement is priced no_charge, so a runtime MUST NOT rate work under it and there " +
        "is no settlement record to hold (§5.5.7)",
    );
  }
  if (clause?.arrangement !== "time_and_materials") {
    invalid("rating a schedule requires a time_and_materials clause (§5.5.2)");
  }
  const byMeter = new Map(price.schedule.map((l) => [l.meter, l]));
  const alreadyBilled = opts.alreadyBilled ?? 0;
  if (!isNonNegInt(alreadyBilled)) invalid("alreadyBilled is a non-negative integer");
  const basis = opts.operatorFeeBasis;
  if (basis !== undefined) validateOperatorFeeBasis(basis);

  // §5.5.3: the cap bounds what the client pays, fee included. What is left of
  // the client's exposure is the cap less everything already billed to it; what
  // is left for the PROVIDER is that, less the fee this rating will take on it.
  const exposure = Math.max(0, price.cap.amount - alreadyBilled);
  let budget = maxRatedTotalUnderCap(exposure, basis);
  let total = 0;
  let unbilled = 0;
  const lines: SowSettlementLine[] = [];

  for (const u of usage) {
    const line = byMeter.get(u.meter);
    if (line === undefined) {
      invalid(
        `a runtime MUST NOT bill '${u.meter}' — the schedule does not price it (§5.5.2)`,
      );
    }

    const gross = rateLine(line, u.count);
    const billed = Math.min(gross, budget);
    budget -= billed;
    total += billed;
    unbilled += gross - billed;

    const settled: SowSettlementLine = {
      meter: line.meter,
      unit: line.unit,
      count: u.count,
      per: divisorOf(line),
      per_unit: line.per_unit,
      amount: billed,
    };
    if (line.pass_through === true) {
      settled.pass_through = true;
      const receipt = opts.receipts?.[line.meter];
      if (receipt !== undefined) settled.upstream_receipt = receipt;
    }
    validateSettlementLine(settled);
    lines.push(settled);
  }

  // The fee follows the rated total, and a fee is a cut out of what the client
  // pays: where nothing was rated nothing was charged, so nothing was taken and
  // no line is written. Under a fixed basis that is load-bearing rather than
  // tidy — a fixed charge is `basis.fixed` whatever the base, so a line on a
  // zero total would bill the client for work it did not receive.
  const fee =
    basis === undefined || total === 0
      ? undefined
      : operatorFee({
          ...(opts.operator !== undefined ? { operator: opts.operator } : {}),
          basis,
          base: total,
        });
  const clientTotal = total + (fee?.amount ?? 0);
  const capRemaining = exposure - clientTotal;

  return {
    currency: price.currency,
    lines,
    total,
    ...(fee !== undefined ? { operator_fee: fee } : {}),
    client_total: clientTotal,
    cap_remaining: capRemaining,
    // §5.5.5 — reaching the cap concludes the work. "Reached" is the point at
    // which no further rated work fits under what is left once the fee on it is
    // counted, which with no fee is exactly the old `cap_remaining === 0`.
    exhausted: maxRatedTotalUnderCap(capRemaining, basis) === 0,
    unbilled,
  };
}

/**
 * §5.5.6 — every settlement record for a pass-through line MUST reference the
 * upstream receipt, and MUST NOT be priced above the upstream cost.
 *
 * A pass-through line with no receipt is a bare assertion that a cost was
 * incurred, which is the thing "at cost, with proof" exists to rule out.
 */
export function validateSettlementLine(line: unknown): asserts line is SowSettlementLine {
  if (typeof line !== "object" || line === null) invalid("a settlement line is an object");
  const l = line as Record<string, unknown>;
  if (typeof l.meter !== "string" || !METER_NAME_RE.test(l.meter)) invalid("line.meter is a meter name");
  if (typeof l.unit !== "string" || l.unit === "") invalid("line.unit is required");
  if (!isNonNegInt(l.count)) invalid("line.count is a non-negative integer");
  if (!isPosInt(l.per)) {
    invalid("line.per is the divisor actually applied, written out even when it is 1 (§5.5.2)");
  }
  if (!isNonNegInt(l.per_unit)) invalid("line.per_unit is a non-negative integer");
  if (!isNonNegInt(l.amount)) invalid("line.amount is a non-negative integer");
  if (l.pass_through === undefined) {
    if (l.upstream_receipt !== undefined) {
      invalid("upstream_receipt belongs to a pass_through line (§5.5.6)");
    }
    return;
  }
  if (l.pass_through !== true) invalid("pass_through, when present, is the literal true (§5.5.6)");
  if (typeof l.upstream_receipt !== "string" || l.upstream_receipt === "") {
    invalid(
      "a pass-through settlement record MUST reference the upstream receipt that evidences " +
        "the cost (§5.5.6)",
    );
  }
  if (l.upstream_amount !== undefined) {
    if (!isNonNegInt(l.upstream_amount)) invalid("upstream_amount is a non-negative integer");
    if ((l.amount as number) > l.upstream_amount) {
      invalid(
        "a pass-through line MUST NOT be priced above the upstream cost — price resold work " +
          "as your own metered line if you want a margin (§5.5.6)",
      );
    }
  }
}

/** The pass-through lines of a schedule (§5.5.6): what this provider resells
 *  rather than performs, and therefore what it owes receipts for. */
export function passThroughLines(price: SowTimeAndMaterialsPrice): SowScheduleLine[] {
  return (price.schedule ?? []).filter((l) => l.pass_through === true);
}

// ── §5.5.7: nothing settles ─────────────────────────────────────────────────

/**
 * Whether an engagement priced this way settles at all (§5.5).
 *
 * True under `fixed_fee` and `time_and_materials`, where every billable unit of
 * work is rated at the engagement's price and produces a settlement record both
 * parties hold. False under `no_charge`, which has no billable units: §5.5.7
 * says a runtime MUST NOT rate the work, MUST NOT draw from the client's
 * balance, MUST NOT produce a settlement record, and MUST NOT call clearing.
 */
export function settles(price: SowPrice): boolean {
  return price.arrangement !== "no_charge";
}

/**
 * §5.5.7 — the refusal a client node owes a settlement record that cites a
 * no-charge engagement, and the same refusal on the way in for a runtime about
 * to rate one.
 *
 * Written as a prohibition rather than left to implementations because the
 * alternative design produces a settlement record of zero for every task, and
 * those records carry no information while sitting in both accounts' books
 * beside the records that do.
 *
 * `act` names what was attempted, so the sentence reads as what happened rather
 * than as a category. Throws; a caller that forgets to check cannot file the
 * record.
 */
export function admitSettlement(price: SowPrice, act = "settle"): asserts price is Exclude<SowPrice, SowNoChargePrice> {
  if (price?.arrangement === "no_charge") {
    invalid(
      `this engagement is priced no_charge, so a runtime MUST NOT ${act} it and there is no ` +
        "settlement record to hold. Nothing was billed and nothing is owed (§5.5.7)",
    );
  }
}

/**
 * The committed price of an engagement — the single number an Agent Mandate
 * ceiling check tests before formation (§5.5.3, §5.5.7).
 *
 * For time and materials it is the cap, which is the whole point of requiring
 * one. For no charge it is zero, and any ceiling covers it. For fixed fee it is
 * the ceiling when the clause states one; a fixed fee clause with no ceiling
 * commits no bounded total, and `null` says so rather than inventing a number.
 */
export function committedPrice(price: SowPrice): number | null {
  if (isTimeAndMaterials(price)) return price.cap.amount;
  if (isNoCharge(price)) return 0;
  return price.ceiling?.amount ?? null;
}

// ── §5.5.8: the operator fee ────────────────────────────────────────────────

/**
 * The basis an operator fee was computed from (§5.5.8): a percentage, or a
 * fixed charge.
 *
 * `percent` is a NON-NEGATIVE INTEGER. §5.5.8 does not say whether a fractional
 * percentage is permitted, and this SDK does not accept one: a fraction inside
 * the signed bytes is a float two implementations must print identically
 * forever, and the arithmetic rule below ("`amount` MUST equal the basis
 * applied to `base`") stops being exact the moment one appears. Nothing is
 * lost. An operator wanting two and a half percent of 2500000 states the
 * fixed charge it computed, `{ kind: "fixed", fixed: 62500 }`, against the
 * same `base` — which discloses strictly more than a rate the buyer would have
 * had to multiply out itself.
 */
export type SowOperatorFeeBasis =
  | { kind: "percent"; percent: number }
  | { kind: "fixed"; fixed: number };

/**
 * §5.5.8 — the operator's own cut, disclosed on its own line.
 *
 * An **operator** is a party that stands between the client and the provider
 * when money moves: it hosts one or both agents, builds the quote, settles the
 * charge, or does more than one of those. Its fee is not the provider's price
 * and it is not a §5.5.6 pass-through, which is a cost bought elsewhere and
 * billed at cost. This is a margin, and it is the operator's to charge — what
 * it is not is invisible.
 *
 * Three members are required. `amount` is the cut in the settlement currency.
 * `basis` is what it was computed from. `base` is what that basis was applied
 * to, and it is not decoration: ten percent of the provider's price and ten
 * percent of the total the buyer pays are different numbers from the same
 * percentage, so a client node MUST NOT infer the base. `operator` is optional
 * and names who took it.
 *
 * Disclosure binds at two moments and both are required (§5.5.8): in the quote,
 * before the client commits, and in the settlement record afterwards. A quote or
 * record carrying no line asserts that no operator fee is inside its total —
 * see {@link checkSettlement}, which is the client node's side of that.
 *
 * Disclosing the cut reveals the provider's net, because the total minus the
 * cut IS the provider's net. §5.5.8 accepts that trade deliberately and says
 * so; a provider unwilling to have its net readable by its clients cannot sell
 * through an operator that takes a disclosed fee. The remedy is to change the
 * arrangement, not to omit the line.
 */
export interface SowOperatorFee {
  /** OPTIONAL (§5.5.8). Who took the cut. */
  operator?: string;
  basis: SowOperatorFeeBasis;
  /** REQUIRED. A percentage is uncheckable without the number it was taken
   *  from, and a client node MUST NOT infer it. */
  base: number;
  amount: number;
}

/** The exact fee a basis applied to a base produces, before flooring, as a
 *  numerator over 100. Kept rational so the check below never compares floats. */
function feeNumerator(basis: SowOperatorFeeBasis, base: number): bigint {
  return basis.kind === "percent"
    ? BigInt(basis.percent) * BigInt(base)
    : BigInt(basis.fixed) * 100n;
}

/**
 * The whole-unit fee a basis applied to a base produces (§5.5.8).
 *
 * There is ONE rule and it takes no argument. Under a percentage basis the
 * amount is `floor(base × percent / 100)`; under a fixed basis nothing is
 * rounded and the amount is `basis.fixed`, whatever the base is. Flooring is
 * the direction §5.5.2 already applies to usage rating, so money is computed
 * one way throughout the specification, and the floor favours the buyer.
 *
 * There is no rounding parameter and there was one until 0.9.0-draft. It
 * existed because §5.5.8 defined no field for a rounding rule, so no rule was
 * ever stated, so a reader had to accept several answers to the same line. The
 * specification now states the rule, so the choice is gone and the check
 * {@link checkOperatorFee} performs is exact.
 *
 * A percentage of a base too small to produce one whole unit produces NOTHING.
 * An operator that intends to charge a whole unit there states a fixed basis of
 * one unit, which discloses the charge as the charge it is.
 */
export function operatorFeeAmount(basis: SowOperatorFeeBasis, base: number): number {
  validateOperatorFeeBasis(basis);
  if (!isNonNegInt(base)) invalid("operator_fee.base is a non-negative integer (§5.5.8)");
  if (basis.kind === "fixed") return basis.fixed;
  const amount = feeNumerator(basis, base) / 100n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid("the operator fee overflows an exact integer — split the settlement (§5.5.8)");
  }
  return Number(amount);
}

/**
 * Build an operator fee line (§5.5.8), computing `amount` from the basis and
 * the base.
 *
 * Pass `amount` only to state a cut this SDK did not compute — a fee taken by
 * some other implementation, being written down as it stands. It is checked
 * against the basis before it is returned, so a line that does not close is
 * refused here rather than at the counterparty. Since 0.9.0-draft that check is
 * exact, so a line an operator rounded any way but down is refused at
 * construction.
 */
export function operatorFee(init: {
  operator?: string;
  basis: SowOperatorFeeBasis;
  base: number;
  amount?: number;
}): SowOperatorFee {
  const fee: SowOperatorFee = {
    ...(init.operator !== undefined ? { operator: init.operator } : {}),
    basis:
      init.basis?.kind === "fixed"
        ? { kind: "fixed", fixed: init.basis.fixed }
        : { kind: "percent", percent: (init.basis as { percent: number })?.percent },
    base: init.base,
    amount: init.amount ?? operatorFeeAmount(init.basis, init.base),
  };
  validateOperatorFee(fee);
  const verdict = checkOperatorFee(fee);
  if (!verdict.ok) invalid(verdict.why);
  return fee;
}

function validateOperatorFeeBasis(v: unknown): asserts v is SowOperatorFeeBasis {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("operator_fee.basis is an object — a percentage or a fixed charge (§5.5.8)");
  }
  const b = v as Record<string, unknown>;
  if (b.kind === "percent") {
    if (!isNonNegInt(b.percent)) {
      invalid(
        "operator_fee.basis.percent is a non-negative integer — a fractional percentage would " +
          "put a float inside the signed bytes and would make the arithmetic check inexact; " +
          "state the charge you computed as a fixed basis instead (§5.5.8)",
      );
    }
    if (b.fixed !== undefined) invalid("a percent basis carries no fixed charge (§5.5.8)");
    return;
  }
  if (b.kind === "fixed") {
    if (!isNonNegInt(b.fixed)) {
      invalid("operator_fee.basis.fixed is a non-negative integer in the settlement currency (§5.5.8)");
    }
    if (b.percent !== undefined) invalid("a fixed basis carries no percentage (§5.5.8)");
    return;
  }
  invalid("operator_fee.basis.kind is 'percent' or 'fixed' — a basis is one or the other (§5.5.8)");
}

/**
 * Shape check for an operator fee line (§5.5.8). Arithmetic is
 * {@link checkOperatorFee}: a line can be well formed and still not close, and
 * those are different failures to a client node reading a settlement record.
 */
export function validateOperatorFee(v: unknown): asserts v is SowOperatorFee {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("an operator fee line is an object carrying amount, basis and base (§5.5.8)");
  }
  const f = v as Record<string, unknown>;
  if (f.operator !== undefined && (typeof f.operator !== "string" || f.operator === "")) {
    invalid("operator_fee.operator, when present, names the operator that took the cut (§5.5.8)");
  }
  validateOperatorFeeBasis(f.basis);
  if (f.base === undefined) {
    invalid(
      "operator_fee.base is REQUIRED — a percentage is not checkable until the buyer knows what " +
        "it was applied to, and a client node MUST NOT infer the base (§5.5.8)",
    );
  }
  if (!isNonNegInt(f.base)) invalid("operator_fee.base is a non-negative integer (§5.5.8)");
  if (!isNonNegInt(f.amount)) {
    invalid("operator_fee.amount is a non-negative integer in the settlement currency (§5.5.8)");
  }
}

/**
 * §5.5.8 — does the disclosed amount follow from the disclosed basis and base?
 *
 * EXACT, both kinds. `amount` MUST equal the basis applied to `base`, computed
 * by flooring: `floor(base × percent / 100)` under a percentage, and
 * `basis.fixed` under a fixed charge. There is no tolerance for a difference of
 * one unit or of any other size.
 *
 * The one-whole-unit tolerance this function applied until 0.9.0-draft is
 * WITHDRAWN. It existed because the subsection defined no field for a rounding
 * rule, so no rule was ever stated, so the fallback always applied and an
 * arithmetic check called `enforced` accepted several answers to the same line
 * forever. With one rule the check is exact, which is the point of stating it.
 *
 * This check is the `enforced` half of §5.5.8. It runs on bytes the client
 * already holds, so a violation produces a mechanical refusal rather than a
 * grievance. What it does NOT establish is that the disclosed basis is the rate
 * the operator actually agreed with the provider — the client is not party to
 * that agreement, so the basis itself grades `evidence`
 * ({@link OPERATOR_FEE_BASIS_GRADE}).
 */
export function checkOperatorFee(fee: SowOperatorFee): { ok: true } | { ok: false; why: string } {
  validateOperatorFee(fee);
  if (fee.basis.kind === "fixed") {
    return fee.amount === fee.basis.fixed
      ? { ok: true }
      : {
          ok: false,
          why:
            `the operator fee states ${fee.amount} against a fixed basis of ${fee.basis.fixed} — ` +
            "a fixed charge is rounded by nothing, so amount MUST equal it exactly (§5.5.8)",
        };
  }
  const floored = feeNumerator(fee.basis, fee.base) / 100n;
  if (BigInt(fee.amount) === floored) return { ok: true };
  return {
    ok: false,
    why:
      `the operator fee states ${fee.amount}, and ${fee.basis.percent}% of ${fee.base} floors to ` +
      `${floored}. A client node MUST reject an amount that is not the floored figure, and there ` +
      "is no tolerance of one unit or of any other size. An operator whose rate is finer than a " +
      "whole percent states the charge that rate produced as a fixed basis against the same base " +
      "(§5.5.8)",
  };
}

/**
 * The largest rated total that fits under `capRemaining` once the operator fee
 * taken on it is counted (§5.5.3, §5.5.8) — **the maximal fit rule**.
 *
 * §5.5.8 says the cap bounds what the client pays, fee included, so the
 * provider's rated work runs to the cap less the fee taken on it. Turning that
 * sentence into a number needs one decision the specification does not force,
 * and this is where it is made.
 *
 * The obvious closed form, `floor(cap × 100 / (100 + percent))`, is WRONG, or
 * rather it is merely conservative: it assumes the fee scales continuously, and
 * the fee floors. At a cap of 100 with a ten percent fee it gives 90, but 91
 * also fits, because ten percent of 91 floors to 9 and 91 + 9 is exactly 100.
 * Both answers satisfy §5.5.8 and a client reading either record cannot tell
 * them apart, so this is not a specification defect. But two implementations
 * that pick differently disagree by a unit at every boundary, and they disagree
 * inside signed bytes. So the rule is pinned rather than left to taste:
 *
 * > **the largest rated total whose sum with its own fee is within the cap.**
 *
 * `conformance/sow-pricing.json` carries the cap-100-at-ten-percent case as an
 * explicit fixture so a third implementation cannot get it wrong. The loop
 * below runs at most once — a floored fee can only ever hide one whole unit of
 * headroom — but it is written as a loop because the bound is a proof and the
 * loop is the rule.
 *
 * With no basis the answer is the whole remaining cap, which is what every
 * peer-to-peer caller gets and why nothing changes for them.
 */
export function maxRatedTotalUnderCap(
  capRemaining: number,
  basis?: SowOperatorFeeBasis,
): number {
  if (!isNonNegInt(capRemaining)) {
    invalid("the remaining cap is a non-negative integer (§5.5.3)");
  }
  if (basis === undefined) return capRemaining;
  validateOperatorFeeBasis(basis);
  if (basis.kind === "fixed") {
    // A fixed charge is taken whole, whatever the base (§5.5.8), so it comes
    // off the top. Where it does not fit at all, nothing does.
    return capRemaining >= basis.fixed ? capRemaining - basis.fixed : 0;
  }
  const cap = BigInt(capRemaining);
  const percent = BigInt(basis.percent);
  let fit = (cap * 100n) / (100n + percent);
  while (fit + 1n + ((fit + 1n) * percent) / 100n <= cap) fit += 1n;
  return Number(fit);
}

/** §5.5.8 — the basis itself grades `evidence`, always. A client node can check
 *  that the disclosed percentage was applied to the disclosed base; it cannot
 *  check that the disclosed percentage is the rate the operator agreed with the
 *  provider, because it is not party to that agreement. */
export const OPERATOR_FEE_BASIS_GRADE: SowGrade = "evidence";

/**
 * The grade §5.5.8 earns on a given money path. Never guess upward.
 *
 * `enforced` requires BOTH: the operator built the quote and the operator
 * settled the charge. Presence and arithmetic are then mechanically checkable
 * against two records the client holds.
 *
 * Anything less is `recorded`. Where no operator constructed the quote there is
 * no second record to test the quote's assertion against, so a client node can
 * check a disclosed line's arithmetic — and MUST — but cannot detect a line
 * that was never written. §5.5.8 names the both-ends case and the neither-end
 * case and is silent on the mixed one; this returns `recorded` for it, because
 * an omission at the end nobody operates is exactly the omission nothing can
 * refuse, and grading it `enforced` would be the laundering of trust as
 * enforcement §8.2 forbids.
 */
export function operatorFeeGrade(path: {
  operatorBuiltQuote: boolean;
  operatorSettled: boolean;
}): SowGrade {
  return path.operatorBuiltQuote && path.operatorSettled ? "enforced" : "recorded";
}

/** A quote: a total offered before commitment, and the operator fee inside it.
 *  §5.5.8 defines the LINE, not the envelope carrying it, so this is the
 *  minimum a client node needs to hold in order to test the settlement record
 *  that follows. Implementations carry whatever else they carry. */
export interface SowQuote {
  total: number;
  currency?: string;
  /** Absent asserts that no operator fee is inside `total` (§5.5.8). */
  operator_fee?: SowOperatorFee;
}

/** A settlement record: what was actually charged, line by line. `total` is
 *  what the client pays, and the operator fee is one of the lines that total
 *  MUST account for — the fee is inside the total, and the total minus the fee
 *  is the provider's net (§5.5.8). */
export interface SowSettlementRecord {
  total: number;
  lines: SowSettlementLine[];
  currency?: string;
  /** Absent asserts that no operator fee is inside `total` (§5.5.8). */
  operator_fee?: SowOperatorFee;
}

/** What a record's own lines account for: the rated lines plus the operator's
 *  cut. §5.5.8 gives the fee the shape of a §5.5.6 pass-through line, and a
 *  pass-through line is part of the total, so this one is too. */
export function settlementTotal(record: {
  lines: readonly SowSettlementLine[];
  operator_fee?: SowOperatorFee;
}): number {
  const lines = record.lines.reduce((sum, l) => sum + l.amount, 0);
  return lines + (record.operator_fee?.amount ?? 0);
}

/** What the provider receives: the total minus the operator's cut (§5.5.8).
 *  This is the number disclosure reveals, and the specification says so rather
 *  than leaving an implementer to discover it. */
export function providerNet(x: { total: number; operator_fee?: SowOperatorFee }): number {
  return x.total - (x.operator_fee?.amount ?? 0);
}

/** §5.5.3, §5.5.8 — the refusal a total owes a cap it exceeds. The cap bounds
 *  what the CLIENT pays, and the fee is inside that total, so a quote or a
 *  record stating more than the cap states a charge the engagement forbids. */
function withinCap(total: number, cap: number | undefined, what: string): void {
  if (cap === undefined) return;
  if (!isNonNegInt(cap)) invalid("the cap is a non-negative integer (§5.5.3)");
  if (total > cap) {
    invalid(
      `this ${what} states a total of ${total} against a not-to-exceed cap of ${cap}. The cap ` +
        "bounds what the client pays, operator fee included, so the provider's rated work runs " +
        "to the cap less the fee taken on it and a runtime MUST NOT bill past it (§5.5.3, §5.5.8)",
    );
  }
}

/** Build the quote §5.5.8 requires: the provider's total, the operator's cut
 *  beside it, and a total that is the sum of the two. A quote built with no fee
 *  asserts there is none inside it, which is an assertion §5.10 tests if it
 *  later proves false.
 *
 *  Pass `cap` where one is in play (§5.5.3) and the resulting total is asserted
 *  against it, fee included — a quote whose total exceeds the cap is a quote for
 *  work the engagement will not admit. */
export function quoteWithOperatorFee(init: {
  providerTotal: number;
  fee?: SowOperatorFee;
  currency?: string;
  cap?: number;
}): SowQuote {
  if (!isNonNegInt(init.providerTotal)) invalid("the provider's total is a non-negative integer");
  if (init.fee !== undefined) {
    validateOperatorFee(init.fee);
    const verdict = checkOperatorFee(init.fee);
    if (!verdict.ok) invalid(verdict.why);
  }
  const total = init.providerTotal + (init.fee?.amount ?? 0);
  withinCap(total, init.cap, "quote");
  return {
    total,
    ...(init.currency !== undefined ? { currency: init.currency } : {}),
    ...(init.fee !== undefined ? { operator_fee: init.fee } : {}),
  };
}

/** Build the settlement record §5.5.8 requires from a {@link rateUsage} result:
 *  the same lines, the same fee line the quote carried, and a total its own
 *  lines account for. Rating is not re-done here and no arithmetic of the
 *  schedule is repeated — the rating is the authority for what the work cost.
 *
 *  `fee` defaults to the line the rating already took, so a caller that rated
 *  against an operator basis cannot forget to disclose the cut that rating
 *  clamped the work for. Pass `cap` to assert the record's total against the
 *  not-to-exceed cap (§5.5.3), fee included. */
export function settlementWithOperatorFee(init: {
  rating: SowRating;
  fee?: SowOperatorFee;
  cap?: number;
}): SowSettlementRecord {
  const fee = init.fee ?? init.rating.operator_fee;
  if (fee !== undefined) {
    validateOperatorFee(fee);
    const verdict = checkOperatorFee(fee);
    if (!verdict.ok) invalid(verdict.why);
  }
  const total = init.rating.total + (fee?.amount ?? 0);
  withinCap(total, init.cap, "settlement record");
  const record: SowSettlementRecord = {
    total,
    lines: init.rating.lines,
    currency: init.rating.currency,
    ...(fee !== undefined ? { operator_fee: fee } : {}),
  };
  return record;
}

/** Why a settlement is disputed (§5.5.8). The first three are the three checks
 *  §5.5.8 requires a client node to make. The fourth is the mirror of the
 *  first: a record disclosing a fee where the quote disclosed none contradicts
 *  the quote's own assertion that no operator fee was inside that total, which
 *  §5.5.8 states as an assertion without naming the check that catches it. */
export type SowDisputeReason =
  | "operator_fee_missing"
  | "operator_fee_arithmetic"
  | "total_unaccounted"
  | "operator_fee_undisclosed";

/**
 * A disputed settlement (§5.5.8), holding both documents exactly as they were
 * compared.
 *
 * `quote` and `record` are DEEP FROZEN. §5.5.8 says a client node MUST NOT
 * repair the record by supplying the missing line or recomputing the total,
 * because a record the client rewrote is no longer evidence of what the
 * operator claimed. This module offers no repair function, and the copies it
 * hands back refuse the write.
 */
export interface SowDisputedSettlement {
  reason: SowDisputeReason;
  detail: string;
  quote: Readonly<SowQuote>;
  record: Readonly<SowSettlementRecord>;
}

/** The verdict of {@link checkSettlement}. On a dispute the charge is NOT
 *  settled in the client's evidence chain: the discrepancy is what gets
 *  recorded (§5.5.8). */
export type SowSettlementVerdict =
  | { settled: true }
  | { settled: false; disputed: SowDisputedSettlement };

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const member of Object.values(v as Record<string, unknown>)) deepFreeze(member);
  }
  return v;
}

/**
 * The client node's read of a settlement record against the quote it holds
 * (§5.5.8).
 *
 * Three checks, in the specification's own order: that an operator fee line is
 * present where the quote carried one, that the line's `amount` follows from
 * its `basis` and `base`, and that the record's total accounts for every line
 * the record carries. A record failing any of them is a **disputed
 * settlement**, and on one the client node MUST NOT record the charge as
 * settled, MUST record the discrepancy instead holding both documents, MUST
 * raise it under the engagement's dispute clause (§5.10) where it counts as a
 * failed obligation for §5.9 and §5.10, and MUST NOT repair the record.
 *
 * It MAY continue to admit work — one discrepancy is not by itself grounds to
 * stop — and SHOULD refuse further work under the same operator after a second
 * one ({@link refuseFurtherWorkUnderOperator}).
 *
 * Nothing is mutated and nothing is repaired. The returned dispute holds frozen
 * copies of exactly what was compared.
 */
export function checkSettlement(quote: SowQuote, record: SowSettlementRecord): SowSettlementVerdict {
  const dispute = (reason: SowDisputeReason, detail: string): SowSettlementVerdict => ({
    settled: false,
    disputed: deepFreeze({
      reason,
      detail,
      // A JSON round trip, not a structured clone: these are JSON documents by
      // definition (the canonical bytes are the contract), and a clone that
      // THREW on an unexpected member would fail the one path whose whole job
      // is to record what arrived.
      quote: JSON.parse(JSON.stringify(quote)) as SowQuote,
      record: JSON.parse(JSON.stringify(record)) as SowSettlementRecord,
    }),
  });

  if (quote.operator_fee !== undefined && record.operator_fee === undefined) {
    return dispute(
      "operator_fee_missing",
      "the quote disclosed an operator fee and the settlement record carries no operator fee " +
        "line. Every settlement record for a charge that carried an operator fee MUST carry the " +
        "same line, with the amount actually taken (§5.5.8)",
    );
  }
  if (quote.operator_fee === undefined && record.operator_fee !== undefined) {
    return dispute(
      "operator_fee_undisclosed",
      "the settlement record discloses an operator fee the quote did not. A quote that states a " +
        "total and carries no operator fee line asserts that no operator fee is inside that " +
        "total, and this record contradicts that assertion (§5.5.8)",
    );
  }
  if (record.operator_fee !== undefined) {
    const verdict = checkOperatorFee(record.operator_fee);
    if (!verdict.ok) return dispute("operator_fee_arithmetic", verdict.why);
  }
  const accounted = settlementTotal(record);
  if (record.total !== accounted) {
    return dispute(
      "total_unaccounted",
      `the settlement record states a total of ${record.total} and its own lines account for ` +
        `${accounted}. A settlement record MUST NOT state a total that its own lines do not ` +
        "account for (§5.5.8)",
    );
  }
  return { settled: true };
}

/** §5.5.8 — a client node SHOULD refuse further work under the same operator
 *  after a SECOND disputed settlement. One discrepancy is not by itself grounds
 *  to stop the work. */
export function refuseFurtherWorkUnderOperator(priorDisputes: number): boolean {
  return priorDisputes >= 2;
}
