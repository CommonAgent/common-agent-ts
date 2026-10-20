/**
 * Claims of breach of an Agent NDA (Agent Reputations §4.8), the parts that
 * are pure: the claim document, its signed bytes and digest, its shape, the
 * claimant's signature, the claim window (check 8), and the key that makes a
 * later claim an amendment of an earlier one (check 9); the signed answers,
 * acknowledgments and withdrawals; the resolutions a claim may take and in
 * what order; and the open and record periods, which say how a claim stands
 * on a given day.
 *
 * Checks 2, 3, 4, 6 and 7 read the agreement itself, which is the Agent NDA
 * core's to read; the bureau's host asks it and hands the answers in. This
 * core uses no other core.
 */
import { createHash } from "node:crypto";
import { USER_KEY_RE, decodeSignature, nkeyFromRaw, rawFromBase64Key, rawUserKey, verifyRaw } from "@common-agent/crypto";
import { jcs } from "./signing.js";

export const NDA_CLAIM_TAG = "fdbk-nda-claim-v1";

/** The kinds of disclosure record a claim may cite (§4.8). */
export const DISCLOSURE_KINDS = ["rfp_release", "sow_task", "delivery"] as const;
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number];

/** The claim body a claimant signs (§4.8). */
export interface NdaClaim {
  nda: { id: string; version: number; digest: string; ref?: string };
  claimant: { agent: string; handle?: string };
  respondent: { agent: string; handle?: string };
  categories: string[];
  disclosures: Array<{ kind: DisclosureKind; digest: string; at: string }>;
  found: { at: string; material_digest: string; note?: string };
  breach_at: string | null;
  at: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INSTANT = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s));

/** The bytes the claimant signs: the tag, a line feed, and the JCS of the claim. */
export function claimSignedBytes(claim: NdaClaim): Uint8Array {
  return new TextEncoder().encode(`${NDA_CLAIM_TAG}\n${jcs(claim)}`);
}

/**
 * The claim's digest, which answers, acknowledgments and withdrawals sign
 * over: `sha256:` and the hex SHA-256 of the claim's JCS. §4.8 names a claim's
 * digest without defining it; this is the definition this bureau uses, the
 * one Agent NDA uses for an agreement.
 */
export function claimDigest(claim: NdaClaim): string {
  return `sha256:${createHash("sha256").update(jcs(claim)).digest("hex")}`;
}

/** What is wrong with a claim's shape, or nothing. */
export function claimProblems(x: unknown): string[] {
  const out: string[] = [];
  const c = x as Partial<NdaClaim> | null;
  if (!c || typeof c !== "object") return ["a claim is a JSON object"];
  const nda = c.nda as NdaClaim["nda"] | undefined;
  if (!nda || typeof nda.id !== "string" || !Number.isInteger(nda.version) || typeof nda.digest !== "string" || !DIGEST.test(nda.digest)) {
    out.push("nda names the agreement: id, version, and the sha256: digest of the completed agreement");
  }
  for (const side of ["claimant", "respondent"] as const) {
    const p = c[side];
    if (!p || typeof p.agent !== "string" || !rawKey(p.agent)) out.push(`${side} names an agent key, as an nkey or padded base64`);
    else if (p.handle !== undefined && (typeof p.handle !== "string" || p.handle.length > 320)) out.push(`${side}.handle is a handle`);
  }
  if (!Array.isArray(c.categories) || !c.categories.length || !c.categories.every((k) => typeof k === "string" && k)) out.push("categories names at least one category");
  if (!Array.isArray(c.disclosures) || !c.disclosures.length) out.push("disclosures cites at least one record");
  else for (const d of c.disclosures) {
    if (!d || !(DISCLOSURE_KINDS as readonly string[]).includes(d.kind) || typeof d.digest !== "string" || !DIGEST.test(d.digest) || !INSTANT(d.at)) {
      out.push(`each disclosure names its kind (${DISCLOSURE_KINDS.join(", ")}), the sha256: digest of its record, and the instant the record states`);
      break;
    }
  }
  const found = c.found as NdaClaim["found"] | undefined;
  if (!found || !INSTANT(found.at) || typeof found.material_digest !== "string" || !DIGEST.test(found.material_digest)) out.push("found says when, and the sha256: digest of what was found");
  if (c.breach_at !== null && !INSTANT(c.breach_at)) out.push("breach_at is an instant, or null");
  if (!INSTANT(c.at)) out.push("at is the instant of filing");
  return out;
}

/** An agent key's raw bytes, from a user nkey whose checksum holds or from padded base64. Null when it is neither. */
function rawKey(agent: string): Uint8Array | null {
  return USER_KEY_RE.test(agent) ? rawUserKey(agent) : rawFromBase64Key(agent);
}

/**
 * The one spelling a bureau keeps an agent key in, the nkey, whichever way a
 * claim spells it, so one agent is never two subjects. Null for a string that
 * is not an agent key.
 */
export function nkeyOf(agent: string): string | null {
  const raw = rawKey(agent);
  return raw ? nkeyFromRaw(raw) : null;
}

/** Whether `sigB64` (padded base64 Ed25519) is `key`'s signature over `bytes`; `key` an nkey or padded base64. */
export function signedByKey(bytes: Uint8Array, key: string, sigB64: string): boolean {
  // One spelling per signature: base64 whose spare bits are set in its last
  // character names the same bytes another way, and would let one act be
  // recorded twice, so only the canonical spelling decodes.
  return verifyRaw(rawKey(key), bytes, decodeSignature(sigB64, "base64"));
}

/** Check 1, in part: the claimant's key signed the claim (padded base64 Ed25519). Resolving the key's identity is the bureau's. */
export function claimSignedBy(claim: NdaClaim, sigB64: string): boolean {
  return signedByKey(claimSignedBytes(claim), claim.claimant.agent, sigB64);
}

/** The salted hash a ledger entry carries in place of an anchor (§4.1). */
export function saltedAnchorHash(anchor: string, salt: string): string {
  return `sha256:${createHash("sha256").update(`${salt}\n${anchor.toLowerCase()}`).digest("hex")}`;
}

/** Check 8, the window: from the first disclosure the claim cites until the filing period has passed after the duties ended. */
export function withinClaimWindow(x: { disclosedAt: readonly string[]; dutiesEndAt: string; filedAt: string; filingPeriodDays: number }): boolean {
  const first = Math.min(...x.disclosedAt.map((a) => Date.parse(a)));
  const filed = Date.parse(x.filedAt);
  const closes = Date.parse(x.dutiesEndAt) + x.filingPeriodDays * 86_400_000;
  return Number.isFinite(first) && Number.isFinite(filed) && filed >= first && filed <= closes;
}

/** The filing period this bureau publishes (§4.8, §10): the recommended 365 days; never under 90. */
export const FILING_PERIOD_DAYS = 365;

/** Check 9: claims that share this key are one claim, the later an amendment of the earlier. */
export function amendmentKey(x: { claimantAnchorHash: string; ndaDigest: string; respondent: string }): string {
  return `${x.claimantAnchorHash}|${x.ndaDigest}|${x.respondent}`;
}

// ── Answers, acknowledgments and withdrawals (§4.8) ─────────────────────────

export const NDA_ANSWER_TAG = "fdbk-nda-answer-v1";
export const NDA_ACK_TAG = "fdbk-nda-ack-v1";
export const NDA_WITHDRAW_TAG = "fdbk-nda-withdraw-v1";

/** The respondent's answer: over the claim's digest and the answer text. */
export interface NdaAnswer {
  claim: string;
  text: string;
}
/** The respondent's acknowledgment of the breach. A seat that names an organization carries the signer's mandate. */
export interface NdaAck {
  claim: string;
  mandate?: string;
}
/** The claimant's withdrawal. */
export interface NdaWithdrawal {
  claim: string;
}

/** At most this many characters in an answer: it is stored and shown, never scored. */
export const MAX_ANSWER_CHARS = 4000;

/** The bytes an answer, acknowledgment or withdrawal is signed over: its tag, a line feed, and the JCS of the body. */
export function ndaActBytes(tag: typeof NDA_ANSWER_TAG | typeof NDA_ACK_TAG | typeof NDA_WITHDRAW_TAG, body: NdaAnswer | NdaAck | NdaWithdrawal): Uint8Array {
  return new TextEncoder().encode(`${tag}\n${jcs(body)}`);
}

// ── Resolutions and the periods (§4.8) ──────────────────────────────────────

/** The four bases on which a claim is upheld, and only these. */
export const UPHOLD_BASES = ["acknowledged", "arbiter", "owners", "court"] as const;
export type UpholdBasis = (typeof UPHOLD_BASES)[number];

/** What an `nda_resolved` entry records. `lapsed` is never recorded: it is how an open claim stands after the open period. */
export const RESOLUTIONS = ["upheld", "dismissed", "withdrawn", "set_aside"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** How a claim stands. */
export type ClaimState = "open" | "lapsed" | Resolution;

/** The open period this bureau publishes (§4.8, §10): the recommended 365 days. */
export const OPEN_PERIOD_DAYS = 365;
/** The record period this bureau publishes: the recommended five years; never under 1095 days. */
export const RECORD_PERIOD_DAYS = 1825;
export const MIN_RECORD_PERIOD_DAYS = 1095;
export const MIN_FILING_PERIOD_DAYS = 90;

/**
 * Why a resolution may not follow the state a claim is in, or null when it
 * may. A claim leaves open (or lapsed, since a resolution after the open
 * period still lands) only once: upheld, dismissed or withdrawn. Only an
 * upheld breach can be set aside, and a set-aside claim stays set aside.
 */
export function resolutionRefusal(current: ClaimState, outcome: Resolution): string | null {
  if (outcome === "set_aside") return current === "upheld" ? null : `only an upheld breach is set aside, and this claim is ${current}`;
  return current === "open" || current === "lapsed" ? null : `this claim is already ${current}`;
}

/**
 * How a claim stands on one day, from what its entries record: the latest
 * resolution, or open until the open period has passed from filing and
 * lapsed after; when it last moved (its filing, an answer or a resolution);
 * and whether it is still within the record period from that latest entry,
 * after which it leaves reports and stays in the excerpts.
 */
export function claimStanding(x: {
  filedAt: string;
  answeredAt: readonly string[];
  resolutions: ReadonlyArray<{ outcome: Resolution; basis?: string; at: string }>;
  nowMs: number;
  openPeriodDays?: number;
  recordPeriodDays?: number;
}): { state: ClaimState; basis?: string; resolvedAt?: string; answers: number; lastAnsweredAt?: string; latestAt: string; inRecord: boolean } {
  const last = x.resolutions.at(-1);
  const filed = Date.parse(x.filedAt);
  const state: ClaimState = last ? last.outcome : x.nowMs > filed + (x.openPeriodDays ?? OPEN_PERIOD_DAYS) * 86_400_000 ? "lapsed" : "open";
  const instants = [x.filedAt, ...x.answeredAt, ...x.resolutions.map((r) => r.at)];
  const latestAt = instants.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  const lastAnsweredAt = x.answeredAt.length ? x.answeredAt.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : undefined;
  return {
    state,
    ...(last?.basis ? { basis: last.basis } : {}),
    ...(last ? { resolvedAt: last.at } : {}),
    answers: x.answeredAt.length,
    ...(lastAnsweredAt ? { lastAnsweredAt } : {}),
    latestAt,
    inRecord: x.nowMs <= Date.parse(latestAt) + (x.recordPeriodDays ?? RECORD_PERIOD_DAYS) * 86_400_000,
  };
}
