/**
 * What every clause module shares: the refusal a broken rule raises, the
 * enforcement grade every clause carries (§3, §4.2), and the small patterns
 * and integer tests the validators use.
 */

/**
 * The two kinds of refusal. `invalid`: a document or clause breaks a rule of
 * its shape, and a runtime MUST refuse it (a proposal it may not carry, a
 * signature it may not accept). `refused`: the document is well formed, but
 * the act asked of it is one the rules do not allow in its state (rating work
 * under no charge, admitting work after the term, amending a terminated
 * engagement).
 */
export type SowRefusalKind = "invalid" | "refused";

/**
 * A rule of Agent SoW, refused. `section` is the clause the refusal cites, as
 * the specification numbers it ("5.5.8"); the message is the rule in words, for
 * the party that broke it.
 */
export class SowRefusal extends Error {
  override readonly name = "SowRefusal";
  readonly section: string;

  constructor(
    readonly kind: SowRefusalKind,
    message: string,
    section?: string,
  ) {
    super(message);
    this.section = section ?? citedSection(message) ?? "5";
  }
}

/** The section a message cites: its last §-reference, the citation that closes the sentence. */
function citedSection(message: string): string | undefined {
  const all = [...message.matchAll(/§(\d+(?:\.\d+)*)/g)];
  return all.length ? all[all.length - 1]![1] : undefined;
}

/** Throw an `invalid` refusal. The section is the one the message cites last, when it cites one. */
export function invalid(message: string, section?: string): never {
  throw new SowRefusal("invalid", `sow: ${message}`, section);
}

/** An `invalid` thrower for one clause module: a message that cites no section is read as citing `section`. */
export function invalidIn(section: string): (message: string) => never {
  return (message) => invalid(message, citedSection(message) ?? section);
}

/** Throw a `refused` refusal: the act is not allowed in the document's state. */
export function refused(message: string, section?: string): never {
  throw new SowRefusal("refused", `sow: ${message}`, section);
}

/** The enforcement gradient (§3). Every clause object carries one (§4.2). */
export type SowGrade = "enforced" | "evidence" | "recorded";

export const SOW_GRADES: ReadonlySet<string> = new Set<SowGrade>(["enforced", "evidence", "recorded"]);

export const CURRENCY_RE = /^[A-Z]{3}$/;
export const METER_NAME_RE = /^[a-z0-9_]{1,64}$/;
/** §6.2: the Agent Mandate reference forms. */
export const ORGANIZATION_REF_RE = /^org_[A-Za-z0-9_-]{1,64}$/;
export const MANDATE_REF_RE = /^mnd_[A-Za-z0-9_-]{1,64}$/;

export function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** A plain object off the wire: not null, not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An RFC 3339 instant in UTC with a `Z`, as the family writes them, that parses. */
export function isInstant(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v));
}

/** An RFC 3339 instant, with a `Z` or an offset. */
export const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A qualification's id (§12.1): lowercase, digits and hyphens, up to 40 characters. */
export const QUALIFICATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
