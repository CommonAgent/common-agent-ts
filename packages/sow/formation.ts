/**
 * Forming an amended version (§5.8, 0.29.0-draft): the three signed messages
 * that let each side know at every moment which version governs for it.
 *
 *   1. The acknowledgement: the proposer acknowledges every approval it
 *      receives, saying whether the version formed, with a deadline of the
 *      instant it received the approval plus the governing review window. It
 *      re-sends it at least once a day until it holds a receipt or the
 *      deadline passes.
 *   2. The receipt: the counterparty, on an acknowledgement that the version
 *      formed, applies the new version and sends a receipt, again for every
 *      copy it receives.
 *   3. The void: a proposer that holds no receipt when the deadline passes
 *      voids the formation, and the counterparty applies the current version
 *      again from the instant it receives the void. The counterparty sends a
 *      receipt of every copy of the void; the proposer re-sends the void at
 *      least once a day until it holds that receipt, and answers any request
 *      that names the voided version with a copy of the void in place of
 *      admitting it.
 *
 * The timeline functions are pure functions of the messages and the instants
 * each side received them; the platform holds the messages and calls them.
 * The messages themselves (0.29.0-draft) are JSON objects with a closed set
 * of members, each signed by its seat's owner_key over the prefix
 * `agent-sow-formation-v1`, one newline, and the JCS of the message less `sig`.
 */
import { canonicalJSON, fromB64Url, PUBLIC_KEY_RE, sha256Digest, signTagged, verifyTagged, type Signer } from "./crypto.js";
import { encodeSowSig, isCanonicalSowSig, seatOwnerKey, sowSignedBytes } from "./signing.js";
import { invalid, isRecord, refused, RFC3339 } from "./shared.js";
import type { SowDocument } from "./document.js";

// ── the signed messages (§5.8, 0.29.0-draft) ────────────────────────────────

/**
 * The tag formation messages are signed under: the prefix differs from the
 * document's `agent-sow-v1` (§6), so a signature over a message can never be
 * read as one over a document, and the reverse.
 */
export const SOW_FORMATION_SIG_PREFIX = "agent-sow-formation-v1\n";

type Role = "provider" | "client";

/** What every formation message carries: what it is about, and who sent and signed it. */
interface SowFormationMessageBase {
  /** The engagement's identifier. */
  engagement: string;
  /** The proposed version. */
  version: number;
  /** `sha256:` and the hex SHA-256 of the approved replacement's signed bytes (§6), the bytes the counterparty countersigned. */
  digest: string;
  /** The seat that sends it. */
  by: Role;
  /** That seat's owner_key (§5.1); a message signed with any other key is refused. */
  key: string;
  /** When the sender signed: a record, which counts nothing. */
  signed_at: string;
  /** Ed25519 over the message's signed bytes, in the canonical padded base64 of §6. */
  sig: string;
}

/** The proposer's acknowledgement of an approval it received: whether the version formed, and, where it did, the deadline for a receipt. */
export interface SowAcknowledgement extends SowFormationMessageBase {
  kind: "acknowledgement";
  formed: boolean;
  /** The instant the proposer received the approval plus the governing review window. On a formed acknowledgement only, where it is required. */
  deadline?: string;
}

/** The counterparty's receipt of an acknowledgement that the version formed, or of a void. */
export interface SowFormationReceipt extends SowFormationMessageBase {
  kind: "receipt";
  of: "acknowledgement" | "void";
}

/** The proposer's void of a formation it held no receipt for at the deadline, naming that deadline. */
export interface SowFormationVoid extends SowFormationMessageBase {
  kind: "void";
  deadline: string;
}

export type SowFormationMessage = SowAcknowledgement | SowFormationReceipt | SowFormationVoid;

/** A message before its sender signs it: `by`, `key`, `signed_at` and `sig` are the signer's. */
export type SowUnsignedFormationMessage<T extends SowFormationMessage = SowFormationMessage> = T extends unknown
  ? Omit<T, "by" | "key" | "signed_at" | "sig">
  : never;

/** The members a message carries (§5.8); any other is refused. */
export const SOW_FORMATION_MEMBERS: ReadonlySet<string> = new Set([
  "kind", "engagement", "version", "digest", "formed", "deadline", "of", "by", "key", "signed_at", "sig",
]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function messageBytes(message: object): string {
  const { sig: _s, ...body } = message as { sig?: unknown };
  return canonicalJSON(body);
}

/** The digest every message about one approval names: of the approved replacement's signed bytes (§6). */
export function formationDigest(approved: SowDocument): string {
  return sha256Digest(sowSignedBytes(approved));
}

/** Sign a formation message as `role`'s seat: `by` is the seat, `key` the signer's public key, and `sig` covers the rest. */
export function signFormationMessage(message: SowUnsignedFormationMessage<SowAcknowledgement>, signer: Signer, role: Role, signedAt?: string): SowAcknowledgement;
export function signFormationMessage(message: SowUnsignedFormationMessage<SowFormationReceipt>, signer: Signer, role: Role, signedAt?: string): SowFormationReceipt;
export function signFormationMessage(message: SowUnsignedFormationMessage<SowFormationVoid>, signer: Signer, role: Role, signedAt?: string): SowFormationVoid;
export function signFormationMessage(message: SowUnsignedFormationMessage, signer: Signer, role: Role, signedAt?: string): SowFormationMessage;
export function signFormationMessage(message: SowUnsignedFormationMessage, signer: Signer, role: Role, signedAt?: string): SowFormationMessage {
  const body = { ...message, by: role, key: signer.getPublicKey(), signed_at: signedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  return { ...body, sig: encodeSowSig(signTagged(signer, SOW_FORMATION_SIG_PREFIX, messageBytes(body))) } as SowFormationMessage;
}

/**
 * The shape of a formation message (§5.8): only the members it defines,
 * `formed` on an acknowledgement only, `deadline` on a formed
 * acknowledgement (required) and on a void (required) and nowhere else, `of`
 * on a receipt only, and `sig` in the canonical spelling. Throws an invalid
 * SowRefusal naming the rule.
 */
export function validateFormationMessage(message: unknown): asserts message is SowFormationMessage {
  if (!isRecord(message)) invalid("a formation message is a JSON object (§5.8)");
  for (const member of Object.keys(message)) {
    if (!SOW_FORMATION_MEMBERS.has(member)) invalid(`a formation message carries only the members §5.8 defines, and ${member} is not one (§5.8)`);
  }
  const m = message as Record<string, unknown>;
  if (m.kind !== "acknowledgement" && m.kind !== "receipt" && m.kind !== "void") invalid("kind is acknowledgement, receipt or void (§5.8)");
  if (typeof m.engagement !== "string" || !m.engagement) invalid("engagement names the engagement (§5.8)");
  if (!Number.isInteger(m.version) || (m.version as number) < 1) invalid("version is the proposed version, a positive integer (§5.8)");
  if (typeof m.digest !== "string" || !DIGEST_RE.test(m.digest)) invalid("digest is sha256: and 64 lowercase hex digits (§5.8)");
  if (m.by !== "provider" && m.by !== "client") invalid("by is the sending seat, provider or client (§5.8)");
  if (typeof m.key !== "string" || !PUBLIC_KEY_RE.test(m.key)) invalid("key is the sending seat's owner_key (§5.8, §5.1)");
  if (typeof m.signed_at !== "string" || !RFC3339.test(m.signed_at)) invalid("signed_at is an RFC 3339 instant (§5.8)");
  if (typeof m.sig !== "string" || !isCanonicalSowSig(m.sig)) invalid("sig is the canonical padded base64 of the 64-byte signature (§5.8, §6)");
  const instant = (v: unknown) => typeof v === "string" && RFC3339.test(v);
  if (m.kind === "acknowledgement") {
    if (typeof m.formed !== "boolean") invalid("an acknowledgement says in formed whether the version formed (§5.8)");
    if (m.formed && !instant(m.deadline)) invalid("an acknowledgement that the version formed names its deadline (§5.8)");
    if (!m.formed && m.deadline !== undefined) invalid("deadline appears only on an acknowledgement that the version formed, and on a void (§5.8)");
  } else if (m.formed !== undefined) invalid("formed appears on an acknowledgement only (§5.8)");
  if (m.kind === "void" && !instant(m.deadline)) invalid("a void names the deadline it voids at (§5.8)");
  if (m.kind === "receipt") {
    if (m.of !== "acknowledgement" && m.of !== "void") invalid("a receipt names in of what it receives: acknowledgement or void (§5.8)");
    if (m.deadline !== undefined) invalid("deadline appears only on an acknowledgement that the version formed, and on a void (§5.8)");
  } else if (m.of !== undefined) invalid("of appears on a receipt only (§5.8)");
}

/** Whether a message is well formed, sent by `role`'s seat with `key`, and signed over its bytes. Never throws. */
export function formationMessageSigned(message: unknown, role: Role, key: string): boolean {
  try {
    validateFormationMessage(message);
  } catch {
    return false;
  }
  if (message.by !== role || message.key !== key) return false;
  try {
    return verifyTagged(key, SOW_FORMATION_SIG_PREFIX, messageBytes(message), fromB64Url(message.sig));
  } catch {
    return false;
  }
}

/** What a formation message is about: one approval of one version, the proposer, and the key each seat signs with. */
export interface SowFormationSubject {
  engagement: string;
  version: number;
  /** formationDigest of the approved replacement. */
  digest: string;
  proposer: Role;
  /** Each seat's owner_key; an engagement written before 0.26.0-draft gives the key that signed for the seat. */
  keys: Partial<Record<Role, string | null>>;
}

/** The subject of the messages about an approved replacement, keyed by its seats' owner_key. */
export function formationSubject(approved: SowDocument, proposer: Role): SowFormationSubject {
  return {
    engagement: approved.id,
    version: approved.version,
    digest: formationDigest(approved),
    proposer,
    keys: { provider: seatOwnerKey(approved, "provider"), client: seatOwnerKey(approved, "client") },
  };
}

/**
 * Check a received formation message against what it is about (§5.8): well
 * formed, naming the engagement, the version and the approved replacement's
 * digest, sent by the seat that sends its kind (the proposer's for an
 * acknowledgement or a void, the counterparty's for a receipt), signed with
 * that seat's key, and the signature good. Throws a SowRefusal naming the
 * rule that failed.
 */
export function checkFormationMessage(message: unknown, about: SowFormationSubject): asserts message is SowFormationMessage {
  validateFormationMessage(message);
  if (message.engagement !== about.engagement) refused(`the message is about engagement ${message.engagement}, and this one is ${about.engagement} (§5.8)`);
  if (message.version !== about.version) refused(`the message names version ${message.version}, and the approval is of version ${about.version} (§5.8)`);
  if (message.digest !== about.digest) refused("the message's digest is not the digest of the approved replacement's signed bytes (§5.8)");
  const sender: Role = message.kind === "receipt" ? (about.proposer === "provider" ? "client" : "provider") : about.proposer;
  if (message.by !== sender) {
    refused(`a ${message.kind} comes from the ${message.kind === "receipt" ? "counterparty's" : "proposer's"} seat, the ${sender}'s, and this one names the ${message.by} (§5.8)`);
  }
  const key = about.keys[sender];
  if (!key || !formationMessageSigned(message, sender, key)) refused(`the ${message.kind} is not signed with the ${sender} seat's owner_key (§5.8, §6)`);
}

// ── the timeline ────────────────────────────────────────────────────────────

/** A void, or a receipt of one, and when it went and arrived. */
interface Sent {
  sent: string;
}

/** When each message went and arrived. A message that never arrived has `null`. */
export interface SowFormationTimeline {
  approval_received_by_proposer: string;
  acknowledgements: Array<{ sent: string; received_by_counterparty: string | null; formed?: boolean }>;
  receipts: Array<{ sent: string; received_by_proposer: string | null }>;
  /** The one void, where only one went. */
  void?: Sent & { received_by_counterparty: string | null };
  /** Every copy of the void the proposer sent, the first at the deadline and then at least daily. */
  voids?: Array<Sent & { received_by_counterparty: string | null }>;
  /** The counterparty's receipts of the void. */
  void_receipts?: Array<Sent & { received_by_proposer: string | null }>;
  /** Requests the counterparty sent, and the copy of the void any was answered with. */
  requests?: Array<{ names_version: number; admitted_at?: string; sent_at?: string; answered_with_void_at?: string }>;
}

/** Where the proposer stands (§5.8's table). */
export type SowProposerFormationState =
  /** The approval is in, and no acknowledgement has gone yet. */
  | "approved"
  /** The acknowledgement went and no receipt has come: new version for a request that names it, the current one for its own acts. */
  | "formed_unacknowledged"
  /** It holds a receipt: the new version. */
  | "formed"
  /** No receipt by the deadline: the current version, and it sends the void. */
  | "void"
  /** The approval came at or after the lapse instant and the proposer did not accept it: nothing formed. */
  | "lapsed";

const DAY_MS = 86_400_000;
const at = (s: string) => Date.parse(s);

/** Whether the proposer's acknowledgements say the version formed. An acknowledgement that does not say is one that it formed. */
function formed(t: SowFormationTimeline): boolean {
  return t.acknowledgements.length > 0 && t.acknowledgements.every((a) => a.formed !== false);
}

/** Every copy of the void that reached the counterparty or went to it: the voids sent, and the requests answered with one. */
function voidCopies(t: SowFormationTimeline): Array<{ sent: string; received_by_counterparty: string | null }> {
  const sent = [...(t.void ? [t.void] : []), ...(t.voids ?? [])];
  const answers = (t.requests ?? []).flatMap((r) => (r.answered_with_void_at ? [{ sent: r.answered_with_void_at, received_by_counterparty: r.answered_with_void_at }] : []));
  return [...sent, ...answers];
}

/**
 * The acknowledgement's deadline: the instant the proposer received the
 * approval plus the governing review window, or null where the version did
 * not form and there is nothing to acknowledge into force.
 */
export function formationDeadline(t: SowFormationTimeline, windowDays: number): string | null {
  if (!formed(t)) return null;
  return new Date(at(t.approval_received_by_proposer) + windowDays * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The proposer's state at an instant, and the version it applies to its own new acts. */
export function proposerFormationAt(
  t: SowFormationTimeline,
  instant: string,
  versions: { current: number; next: number; windowDays: number },
): { state: SowProposerFormationState; own_acts: number } {
  const now = at(instant);
  if (!formed(t)) return { state: t.acknowledgements.length ? "lapsed" : "approved", own_acts: versions.current };
  const deadline = at(formationDeadline(t, versions.windowDays)!);
  const receipt = t.receipts.some((r) => r.received_by_proposer !== null && at(r.received_by_proposer) <= now && at(r.received_by_proposer) < deadline);
  if (receipt) return { state: "formed", own_acts: versions.next };
  if (now >= deadline) return { state: "void", own_acts: versions.current };
  const acknowledged = t.acknowledgements.some((a) => at(a.sent) <= now);
  return { state: acknowledged ? "formed_unacknowledged" : "approved", own_acts: versions.current };
}

/** The version the counterparty applies at an instant: the new one from an acknowledgement that it formed until a copy of the void arrives. */
export function counterpartyVersionAt(t: SowFormationTimeline, instant: string, versions: { current: number; next: number }): number {
  const now = at(instant);
  if (voidCopies(t).some((v) => v.received_by_counterparty !== null && at(v.received_by_counterparty) <= now)) return versions.current;
  const acknowledged = t.acknowledgements.some((a) => a.formed !== false && a.received_by_counterparty !== null && at(a.received_by_counterparty) <= now);
  return acknowledged ? versions.next : versions.current;
}

/**
 * Whether the proposer is re-sending the void at an instant (0.28.0-draft):
 * it voided, and it holds no receipt of the void yet.
 */
export function resendingVoid(t: SowFormationTimeline, instant: string, versions: { current: number; next: number; windowDays: number }): boolean {
  if (proposerFormationAt(t, instant, versions).state !== "void") return false;
  return !(t.void_receipts ?? []).some((r) => r.received_by_proposer !== null && at(r.received_by_proposer) <= at(instant));
}

/** Whether the proposer owes another copy of the void: it is re-sending it, and a day has passed since the last copy went. */
export function voidResendDue(t: SowFormationTimeline, instant: string, versions: { current: number; next: number; windowDays: number }): boolean {
  if (!resendingVoid(t, instant, versions)) return false;
  const copies = voidCopies(t).filter((v) => at(v.sent) <= at(instant));
  if (copies.length === 0) return true;
  return at(instant) - Math.max(...copies.map((v) => at(v.sent))) >= DAY_MS;
}

/**
 * The version a request is admitted and priced under, on the proposer's
 * side. While the proposer is formed, unacknowledged it admits each request
 * under the version the request names, current or new; once it holds the
 * receipt, under the new one; otherwise under the current one. Work admitted
 * under the new version before a void stays priced under it.
 */
export function requestVersion(
  t: SowFormationTimeline,
  request: { admitted_at: string; names_version: number },
  versions: { current: number; next: number; windowDays: number },
): number {
  const { state } = proposerFormationAt(t, request.admitted_at, versions);
  if (state === "formed") return versions.next;
  if (state === "formed_unacknowledged" && (request.names_version === versions.current || request.names_version === versions.next)) {
    return request.names_version;
  }
  return versions.current;
}

/** The proposer's answer to a request: admitted under a version, or answered with a copy of the void. */
export type SowRequestAnswer = { admitted: true; priced_under: number } | { admitted: false; answered_with: "void" };

/**
 * The proposer's answer to a request it receives at `received_at`
 * (0.28.0-draft): once it voided, a request that names the voided version is
 * answered with a copy of the void and admitted under nothing; any other
 * request is admitted under `requestVersion`.
 */
export function requestAnswerAt(
  t: SowFormationTimeline,
  request: { received_at: string; names_version: number },
  versions: { current: number; next: number; windowDays: number },
): SowRequestAnswer {
  const { state } = proposerFormationAt(t, request.received_at, versions);
  if (state === "void" && request.names_version === versions.next) return { admitted: false, answered_with: "void" };
  return { admitted: true, priced_under: requestVersion(t, { admitted_at: request.received_at, names_version: request.names_version }, versions) };
}

/** Whether the proposer owes another copy of its acknowledgement: no receipt yet, the deadline not passed, and a day since the last copy. */
export function acknowledgementResendDue(t: SowFormationTimeline, instant: string, windowDays: number): boolean {
  const deadline = formationDeadline(t, windowDays);
  if (deadline === null || at(instant) >= at(deadline)) return false;
  if (t.receipts.some((r) => r.received_by_proposer !== null && at(r.received_by_proposer) <= at(instant))) return false;
  const last = Math.max(...t.acknowledgements.map((a) => at(a.sent)));
  return at(instant) - last >= DAY_MS;
}
