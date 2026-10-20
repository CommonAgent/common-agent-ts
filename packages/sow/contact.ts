/**
 * The two members Agent SoW 0.25.0-draft adds:
 * the buyer's reference (§5.17), the client's purchase-order number carried
 * on every record the engagement produces, and contracted contact by the
 * provider (§5.18), which admits the provider's agent at named agents of the
 * client's for the engagement's term and no longer.
 *
 * Pinned by conformance/sow-buyer-reference.json and
 * conformance/sow-provider-contact.json.
 */
import { invalidIn, isPosInt, isRecord } from "./shared.js";

const invalidReference: (message: string) => never = invalidIn("5.17");
const invalidContact: (message: string) => never = invalidIn("5.18");

// ── §5.17 the buyer's reference ─────────────────────────────────────────────

/** The longest reference, in Unicode code points. */
export const BUYER_REFERENCE_MAX = 128;

/** A control character, general category Cc: U+0000 to U+001F and U+007F to U+009F. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The form of `buyer_reference` (§5.17): a string of 1 to 128 code points
 * with no control character. Absence is valid and states nothing. The
 * runtime interprets nothing else about it: it never refuses formation,
 * admission or settlement because of the value, and never routes, rates or
 * deduplicates by it.
 */
export function validateBuyerReference(v: unknown): asserts v is string | undefined {
  if (v === undefined) return;
  if (typeof v !== "string") invalidReference("buyer_reference is a string; a number would lose its leading zeros, and an absent reference is spelled by omitting the member (§5.17)");
  const length = [...v].length;
  if (length === 0) invalidReference("buyer_reference is 1 to 128 code points: an empty reference matches nothing (§5.17)");
  if (length > BUYER_REFERENCE_MAX) invalidReference(`buyer_reference is at most ${BUYER_REFERENCE_MAX} code points, and this one is ${length} (§5.17)`);
  if (CONTROL.test(v)) invalidReference("buyer_reference contains no control character (§5.17)");
}

/**
 * The reference every settlement record and task receipt for a piece of work
 * carries (§5.17): the one in the version of the engagement the work was
 * admitted under, byte for byte, or none where that version carries none.
 */
export function buyerReferenceFor(versions: Record<number, string | null | undefined>, admittedUnder: number): string | null {
  return versions[admittedUnder] ?? null;
}

/**
 * The client node's read of a record's reference (§5.17). A missing or
 * different one is a discrepancy to record, and the client may ask for a
 * corrected record. It never by itself makes the settlement disputed, because
 * it does not change what was owed.
 */
export function buyerReferenceDiscrepancy(expected: string | null, recorded: string | null | undefined): { discrepancy: boolean; disputed_settlement: false } {
  return { discrepancy: (recorded ?? null) !== expected, disputed_settlement: false };
}

// ── §5.18 contracted contact by the provider ────────────────────────────────

/** The grants a provider may hold at the client's door: the Common Agent Specification §7.1 set, less `errands` (§5.18). */
export type SowContactGrant = "messages" | "scheduling" | "share";
export const SOW_CONTACT_GRANTS: readonly SowContactGrant[] = ["messages", "scheduling", "share"];

/**
 * The engagement's `provider_contact` member (§5.18): which of the client's
 * agents the provider's agent may contact, with which grants and how often,
 * for the life of the engagement. The client's door enforces it like a
 * connection's roster entry (Common Agent §7.1), and the stop control
 * overrides it.
 */
export interface ProviderContact {
  /** The client's agents the provider's agent may contact, each by handle or by agent key (§5.18). */
  agents: string[];
  /** Grants from the Common Agent §7.1 connection set. `errands` is not among them: a contracted provider places no orders on the client. */
  grants: Array<"messages" | "share" | "scheduling">;
  /** How many messages the provider's agent may send to each named agent in an hour, and in a day. At least one is stated. */
  per_hour?: number;
  per_day?: number;
  /** The client's door enforces it, and that is the only grade it takes. */
  grade: "enforced";
}

/** The same member under this core's older name. */
export type SowProviderContact = ProviderContact;

/** Validate `provider_contact` (§5.18). Absence admits nothing, and is valid. */
export function validateProviderContact(v: unknown): asserts v is SowProviderContact | undefined {
  if (v === undefined) return;
  if (!isRecord(v)) invalidContact("provider_contact is an object carrying agents, grants, a per_hour or per_day limit, and grade (§5.18)");
  if (!Array.isArray(v.agents) || v.agents.length === 0 || !v.agents.every((a) => typeof a === "string" && a.trim() !== "" && a.length <= 256)) {
    invalidContact("provider_contact.agents names one or more of the client's agents, each by handle or agent key (§5.18)");
  }
  if (new Set(v.agents).size !== v.agents.length) invalidContact("provider_contact.agents names each agent once (§5.18)");
  if (!Array.isArray(v.grants) || v.grants.length === 0) invalidContact("provider_contact.grants is a non-empty list of grant names (§5.18)");
  for (const g of v.grants) {
    if (g === "errands") {
      invalidContact("provider_contact.grants MUST NOT name errands: an order from the provider would spend the client's money outside the engagement's price (§5.18)");
    }
    if (!SOW_CONTACT_GRANTS.includes(g as SowContactGrant)) invalidContact(`provider_contact.grants names grants from a closed set, messages, scheduling and share; '${String(g)}' is not one (§5.18)`);
  }
  if (new Set(v.grants).size !== v.grants.length) invalidContact("provider_contact.grants names each grant once (§5.18)");
  if (v.per_hour === undefined && v.per_day === undefined) invalidContact("provider_contact states at least one of per_hour and per_day (§5.18)");
  for (const k of ["per_hour", "per_day"] as const) {
    if (v[k] !== undefined && !isPosInt(v[k])) invalidContact(`provider_contact.${k} is a positive integer (§5.18)`);
  }
  if (v.grade !== "enforced") invalidContact("provider_contact is graded 'enforced': the client's door enforces it, and that is the only value (§5.18)");
}

/** What ended or changed the admission, with the instants a runtime holds. */
export interface SowContactTerm {
  starts_at: string;
  ends_at: string;
  terminated_at?: string;
  cap_reached_at?: string;
  /** An agreed amendment that changed the member: from `agreed_at`, `member` governs (null: dropped). */
  amendment?: { agreed_at: string; member: SowProviderContact | null };
}

/**
 * The member that admits the provider's agent at an instant, or null when
 * none does (§5.18): from `starts_at`, until the engagement lapses at
 * `ends_at` or ends by termination or by reaching its cap, and as an agreed
 * amendment last left it.
 */
export function providerContactAt(member: SowProviderContact | null | undefined, term: SowContactTerm, at: string): SowProviderContact | null {
  const t = Date.parse(at);
  if (t < Date.parse(term.starts_at) || t > Date.parse(term.ends_at)) return null;
  if (term.terminated_at !== undefined && t >= Date.parse(term.terminated_at)) return null;
  if (term.cap_reached_at !== undefined && t >= Date.parse(term.cap_reached_at)) return null;
  if (term.amendment && t >= Date.parse(term.amendment.agreed_at)) return term.amendment.member;
  return member ?? null;
}

/** What a message carries, read from the message and never from its words. */
export type SowMessageCarries = "text" | "attachment" | "scheduling" | "order";

/** The grants that cover each kind of message: any one of them is enough (Common Agent Specification §7.1). */
const COVERED_BY: Record<SowMessageCarries, readonly string[]> = {
  text: ["messages"],
  attachment: ["share"],
  scheduling: ["scheduling", "messages"],
  order: ["errands"],
};

/** What the client's door does with a message from the provider's side. */
export type SowDoorOutcome =
  | { outcome: "delivered" }
  /** Not covered: refused, naming the grant that was missing. */
  | { outcome: "refused"; missing_grant: string }
  /** Over a window: refused with a retry time, never held. */
  | { outcome: "refused_retry"; window: "per_hour" | "per_day" }
  /** The member does not apply: the door decides by the sender's tier, as it would without the engagement. */
  | { outcome: "tier" }
  /** An explicit block or the stop control: refused, and not acknowledged. */
  | { outcome: "refused_silently" };

/**
 * The client's door applying `provider_contact` during its term (§5.18), as a
 * connection's roster entry is applied. An explicit block and the stop control
 * win. Only the provider's agent named in the parties is admitted, and only
 * at the named agents. Grants are read from what the message carries; then the
 * windows.
 */
export function providerContactDoor(
  member: SowProviderContact,
  message: {
    from: "provider" | "subcontractor" | "other";
    to: string;
    carries: SowMessageCarries;
    sent_this_hour?: number;
    sent_today?: number;
    client_roster?: "block";
    stop_control?: "on";
  },
): SowDoorOutcome {
  if (message.stop_control === "on" || message.client_roster === "block") return { outcome: "refused_silently" };
  if (message.from !== "provider" || !member.agents.includes(message.to)) return { outcome: "tier" };
  const covering = COVERED_BY[message.carries];
  if (!covering.some((g) => (member.grants as readonly string[]).includes(g))) return { outcome: "refused", missing_grant: covering[0]! };
  if (member.per_hour !== undefined && (message.sent_this_hour ?? 0) >= member.per_hour) return { outcome: "refused_retry", window: "per_hour" };
  if (member.per_day !== undefined && (message.sent_today ?? 0) >= member.per_day) return { outcome: "refused_retry", window: "per_day" };
  return { outcome: "delivered" };
}

/**
 * An interim deliverable and the client's door (§5.18). One sent before its
 * due instant that the door held, or refused for want of a grant covering it,
 * is recorded as held at the client's door and is not a missed due instant.
 * One sent late, or never sent, is missed.
 */
export function interimDeliverableAtDoor(d: {
  sent_at: string | null;
  due: string;
  door: "delivered" | "held" | "refused" | null;
}): { missed_due_instant: boolean; recorded_as?: "held_at_client_door" } {
  if (d.sent_at === null || Date.parse(d.sent_at) > Date.parse(d.due)) return { missed_due_instant: true };
  if (d.door === "held" || d.door === "refused") return { missed_due_instant: false, recorded_as: "held_at_client_door" };
  return { missed_due_instant: false };
}
