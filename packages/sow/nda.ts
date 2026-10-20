/**
 * The Agent NDA an engagement runs under (§5.16): the top-level `nda` member,
 * and the two tests a runtime that holds the referenced agreement's bytes runs
 * before it forms an engagement or agrees an amendment. The parties test: the
 * agreement's seats hold the engagement's two agent keys. The disclosure test:
 * the engagement's §5.11 declarations fit inside what the agreement permits
 * for the provider's seat.
 *
 * The member is evidence of which bytes were agreed. What the agreement
 * obliges is graded `recorded`, and nothing here presents it otherwise.
 */
import { invalidIn, isPosInt, isRecord } from "./shared.js";
import type { NdaMember } from "./ports.js";

const invalid: (message: string) => never = invalidIn("5.16");

export type { NdaMember };

/** The `sha256:` spelling every digest in the family uses, compared exactly. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** An Agent NDA identifier. */
export const NDA_ID_RE = /^nda_[0-9a-hjkmnp-tv-z]{16}$/;

/**
 * Validate the `nda` member where a document carries one. Absence states
 * nothing, so a document without it passes; a reader MUST NOT infer from
 * absence either that the parties have no NDA or that §5.11 alone protects
 * the content.
 */
export function validateSowNda(member: unknown): asserts member is NdaMember | undefined {
  if (member === undefined) return;
  if (!isRecord(member)) {
    invalid("the nda member is an object carrying id, version, digest and grade: an id alone names no bytes (§5.16)");
  }
  if (typeof member.id !== "string" || !NDA_ID_RE.test(member.id)) {
    invalid("nda.id names the agreement in the identifier form Agent NDA defines: nda_ and 16 lowercase Crockford base32 characters (§5.16)");
  }
  if (!isPosInt(member.version)) invalid("nda.version is a positive integer: versions start at 1 (§5.16)");
  if (typeof member.digest !== "string" || !DIGEST_RE.test(member.digest)) {
    invalid("nda.digest is REQUIRED, spelled sha256: and 64 lowercase hex characters over the agreement's signed bytes, and compared exactly (§5.16)");
  }
  if (member.ref !== undefined && (typeof member.ref !== "string" || !member.ref.trim())) {
    invalid("nda.ref, where present, is a locator for the agreement and not blank (§5.16)");
  }
  if (member.grade !== "evidence") {
    invalid("nda is graded 'evidence': which bytes were agreed is mechanical, and what the agreement obliges is recorded, so 'enforced' would be a false claim (§5.16)");
  }
}

/** The engagement's two agent keys, as §5.1 seats them. */
export interface EngagementAgents {
  provider: string;
  client: string;
}

/**
 * The NDA's seats, by agent key. `recipient` is null for an open offer, which
 * names no recipient and so no agreement with the counterparty. `members` is
 * set for a multilateral agreement (Agent NDA §5.1).
 */
export interface NdaSeats {
  discloser: string | null;
  recipient: string | null;
  members?: string[];
}

/**
 * The parties test (§5.16): the agreement's two seats hold the engagement's
 * two agent keys, in either order, matched on key. In a multilateral
 * agreement both keys are among its members.
 */
export function ndaPartiesMatch(engagement: EngagementAgents, nda: NdaSeats): boolean {
  if (nda.members !== undefined) {
    return nda.members.includes(engagement.provider) && nda.members.includes(engagement.client) && engagement.provider !== engagement.client;
  }
  if (!nda.discloser || !nda.recipient || nda.discloser === nda.recipient) return false;
  const seats = new Set([nda.discloser, nda.recipient]);
  return seats.has(engagement.provider) && seats.has(engagement.client) && engagement.provider !== engagement.client;
}

/** Which of the agreement's disclosure members are the provider's terms. */
export type NdaSeat = "discloser" | "recipient" | "member";

/** What the agreement permits the party in a seat, in §5.11's shape (Agent NDA §5.5). */
export interface NdaPermits {
  processors?: Array<{ service: string; domain?: string }>;
  processed_in?: unknown;
}

/** The result of the disclosure test: which test failed, and at which entry of the engagement's declarations. */
export type NdaDisclosureResult = { ok: true } | { ok: false; test: "processors" | "processed_in"; entry?: number };

/** A `processed_in` that states jurisdictions: a list whose entries are all non-empty strings. Anything else states none (§5.11). */
function statedJurisdictionList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "") ? (v as string[]) : null;
}

/**
 * The disclosure test (§5.16): the engagement's §5.11 declarations fit inside
 * the agreement's terms for the provider's seat. Processors first, each
 * matched on service and domain (an entry without a domain matches only an
 * entry without one); then jurisdictions, where the agreement states them. The
 * first failing entry is reported by its index in the engagement's order.
 *
 * Where the agreement is one-way and the provider is its discloser, the
 * agreement covers none of the client's content and neither test applies:
 * call this only for the seat whose terms govern the provider.
 */
export function ndaDisclosureFits(permits: NdaPermits, confidentiality: Record<string, unknown> | null | undefined): NdaDisclosureResult {
  const declared = confidentiality?.processors;
  if (Array.isArray(declared)) {
    const allowed = Array.isArray(permits.processors) ? permits.processors : [];
    for (let i = 0; i < declared.length; i++) {
      const p = declared[i] as Record<string, unknown> | null;
      const service = isRecord(p) ? p.service : undefined;
      const domain = isRecord(p) ? p.domain : undefined;
      const match = allowed.some((a) => a.service === service && (a.domain ?? undefined) === (domain ?? undefined));
      if (!match) return { ok: false, test: "processors", entry: i };
    }
  }
  const wanted = statedJurisdictionList(permits.processed_in);
  if (wanted) {
    const stated = statedJurisdictionList(confidentiality?.processed_in);
    if (!stated) return { ok: false, test: "processed_in" };
    const i = stated.findIndex((j) => !wanted.includes(j));
    if (i >= 0) return { ok: false, test: "processed_in", entry: i };
  }
  return { ok: true };
}

/**
 * The provider's disclosure terms in an agreement's `disclosure` member: its
 * entry under `recipient` where the provider holds the recipient seat, under
 * `discloser` where it holds the discloser seat of a mutual agreement, and its
 * entry under `members` in a multilateral one. Null where the provider is the
 * discloser of a one-way agreement: the agreement then covers none of the
 * client's content, and the disclosure test does not apply.
 */
export function providerDisclosureTerms(
  disclosure: Record<string, unknown> | undefined,
  seat: NdaSeat,
  opts: { mutual: boolean; providerKey?: string },
): NdaPermits | null {
  if (!disclosure) return {};
  if (seat === "recipient") return (isRecord(disclosure.recipient) ? disclosure.recipient : {}) as NdaPermits;
  if (seat === "discloser") return opts.mutual ? ((isRecord(disclosure.discloser) ? disclosure.discloser : {}) as NdaPermits) : null;
  const members = disclosure.members;
  if (isRecord(members) && opts.providerKey && isRecord(members[opts.providerKey])) return members[opts.providerKey] as NdaPermits;
  return {};
}
