/**
 * Gated postings (Agent RFP §5.11).
 *
 * A gated posting splits in two. The public document says what kind of work
 * is wanted, by when, and which Agent NDA a provider must accept to read
 * more. The rest, the sealed body, is its own document, released by the
 * board to one provider at a time once that provider has accepted the
 * poster's Agent NDA. The public document commits to the body by digest and
 * to the terms by digest, both inside the poster's signed bytes, so neither
 * can be swapped after the poster signs.
 *
 * This file holds the shapes, the split of an assembled posting into its
 * public document and its sealed body, and the release decision as a pure
 * function. Whether an acceptance is valid is the Agent NDA's question, asked
 * through the NdaGate port; the board decides the rest.
 */
import { randomBytes } from "node:crypto";
import { sha256Digest } from "@common-agent/crypto";
import { canonicalJSON, DIGEST_RE } from "./crypto.js";
import type { PostingState } from "./lifecycle.js";
import type { GateAnswer } from "./ports.js";
import type {
  RfpAwardIntent,
  RfpBudget,
  RfpHandling,
  RfpNeed,
  RfpPerformer,
  RfpPostingDoc,
  RfpProcurement,
  RfpRoleRef,
  RfpSought,
  RfpTerm,
} from "./posting.js";

/** What every reader of a gated posting sees of the need (§5.11.1). */
export interface RfpGateSummary {
  /** One or two sentences saying what kind of work is wanted, written so that
   *  nothing the poster wants sealed appears in it. REQUIRED. */
  text: string;
  sought?: RfpSought;
  procurement?: RfpProcurement;
  performer?: RfpPerformer;
  /** A published role is public already, so an agent-shaped posting may name
   *  it here; an inline profile stays sealed. */
  role?: RfpRoleRef;
  grade: "recorded";
}

/** A reference to an Agent NDA in the shape of Agent NDA §8. */
export interface RfpNdaRef {
  id: string;
  version: number;
  /** For an open offer, `sha256:` over the offer bytes; for an agreement
   *  already in force, over the completed document's signed bytes. */
  digest: string;
  ref?: string;
  grade: "evidence";
}

export interface RfpGate {
  summary: RfpGateSummary;
  nda: RfpNdaRef;
  body: { digest: string; ref?: string; grade: "evidence" };
  /** The grade of the release rule (§5.11.3): board-enforced. */
  grade: "enforced";
}

/** The sealed body (§5.11.2): its own JSON document, unsigned, whose
 *  authority is the digest in the poster's signed posting. */
export interface RfpSealedBody {
  rfp_body: "v1";
  /** At least 16 random bytes in padded base64, fresh for every body and
   *  every version (§5.11.2). The posting publishes the body's digest, and
   *  much of a body can be guessed; with the nonce inside the hashed bytes a
   *  guess cannot be checked against the digest. */
  nonce: string;
  language: string;
  need: RfpNeed;
  budget?: RfpBudget;
  term?: RfpTerm;
  award?: RfpAwardIntent;
  handling?: RfpHandling;
}

/** The members a gated posting keeps out of its public document (§5.11.1).
 *  `rights_wanted` and `acceptance` ride inside `need`. */
export const SEALED_MEMBERS = ["need", "budget", "term", "award", "handling"] as const;

/** What a poster states to gate a posting: the public summary and the Agent
 *  NDA a provider must accept. The board builds the body from the posting's
 *  own members. */
export interface RfpGateInput {
  summary: { text: string };
  nda: { id: string; version: number; digest: string; ref?: string };
}

const NDA_ID = /^nda_[0-9abcdefghjkmnpqrstvwxyz]{8,32}$/;
/** One or two sentences; a summary longer than a short paragraph is the body
 *  leaking into the public document. */
const SUMMARY_MAX = 600;

/** A fresh nonce for a sealed body: 16 bytes from the system's secure
 *  random source, in padded base64. */
export function freshNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Why a body's nonce does not meet §5.11.2, or null: base64 with padding in
 * the standard alphabet (RFC 4648 §4), at least 16 bytes. A spelling that
 * does not round-trip through the decoder is not base64 at all.
 */
export function nonceRefusal(nonce: unknown): string | null {
  if (typeof nonce !== "string" || !nonce) return "a sealed body carries a nonce";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(nonce) || nonce.length % 4 !== 0) {
    return "a sealed body's nonce is base64 with padding, in the standard alphabet";
  }
  const bytes = Buffer.from(nonce, "base64");
  if (bytes.toString("base64") !== nonce) return "a sealed body's nonce is base64 with padding, in the standard alphabet";
  if (bytes.length < 16) return "a sealed body's nonce is at least 16 bytes";
  return null;
}

/** Why a sealed body cannot be taken, or null (§5.11.2): the format, a valid
 *  nonce, and the posting's language. */
export function sealedBodyRefusal(body: Partial<RfpSealedBody>, language: string): string | null {
  if (body.rfp_body !== "v1") return "a sealed body names its format, rfp_body v1";
  const n = nonceRefusal(body.nonce);
  if (n) return n;
  if (body.language !== language) return "a sealed body's language is the posting's language";
  return null;
}

/** `sha256:` and the lowercase hex SHA-256 of the body's exact bytes. */
export function bodyDigest(bytes: string): string {
  return sha256Digest(bytes);
}

/** Is this posting gated? */
export function isGated(doc: Pick<RfpPostingDoc, "gate">): boolean {
  return doc.gate !== undefined && doc.gate !== null;
}

/** What a reader who has not been released the body may see of the need:
 *  the gate's summary on a gated posting, the need's summary otherwise. */
export function publicSummaryOf(doc: Pick<RfpPostingDoc, "gate" | "need">): string {
  return doc.gate?.summary?.text ?? doc.need?.summary ?? "";
}

/** Why this gate cannot be taken, or null. Read beside the posting's own
 *  refusals, which run over the sealed members as they run over a public
 *  posting's. */
export function refuseGate(gate: RfpGateInput | undefined): string | null {
  if (gate === undefined) return null;
  if (!gate || typeof gate !== "object") return "gate is an object naming the summary and the Agent NDA";
  const text = String(gate.summary?.text ?? "").trim();
  if (!text) return "a gated posting says in gate.summary.text what kind of work is wanted, in a sentence or two that gives nothing sealed away";
  if (text.length > SUMMARY_MAX) {
    return `gate.summary.text is at most ${SUMMARY_MAX} characters: everything a provider must sign to read belongs in the sealed body`;
  }
  const nda = gate.nda;
  if (!nda || typeof nda !== "object") return "a gated posting names the Agent NDA a provider must accept, in gate.nda";
  if (!NDA_ID.test(String(nda.id ?? ""))) return "gate.nda.id names an Agent NDA by its identifier (nda_ and Crockford base32)";
  if (!(Number.isInteger(nda.version) && nda.version >= 1)) return "gate.nda.version is the agreement's version, a whole number from 1";
  if (!DIGEST_RE.test(String(nda.digest ?? ""))) {
    return "gate.nda.digest is sha256:<64 lowercase hex> over the open offer's bytes; it is what every release is checked against";
  }
  if (nda.ref !== undefined && !/^https:\/\/\S{1,500}$/.test(String(nda.ref))) {
    return "gate.nda.ref, where given, is an https URL that locates the agreement";
  }
  return null;
}

/**
 * Split an assembled posting into the public document and the sealed body
 * (§5.11.1, §5.11.2).
 *
 * The body holds `need`, `budget`, `term`, `award` and `handling`. `sought`,
 * `procurement` and `performer`, and an agent-shaped posting's published
 * `role`, move to the public summary where the posting states them, so each
 * is stated once and in public; an inline profile stays sealed. The body's
 * bytes are its canonical JSON, so any party holding the parsed document can
 * reproduce them, and its digest goes into the public document, inside the
 * bytes the poster signs and the identifier is minted from.
 */
export function sealPosting(
  assembled: Omit<RfpPostingDoc, "signatures">,
  gate: RfpGateInput,
  /** Fresh for every body and every version. Given only by tests and the
   *  conformance generator, which need reproducible bytes. */
  nonce: string = freshNonce(),
): { posting: Omit<RfpPostingDoc, "signatures">; body: RfpSealedBody; bytes: string; digest: string } {
  const { need, budget, term, award, handling, ...rest } = assembled;
  const { sought, procurement, performer, role, ...sealedNeed } = need ?? ({ summary: "", grade: "recorded" } as RfpNeed);
  const nonceProblem = nonceRefusal(nonce);
  if (nonceProblem) throw new Error(nonceProblem);
  const body: RfpSealedBody = {
    rfp_body: "v1",
    nonce,
    language: assembled.language,
    need: sealedNeed as RfpNeed,
    ...(budget ? { budget } : {}),
    ...(term ? { term } : {}),
    ...(award ? { award } : {}),
    ...(handling ? { handling } : {}),
  };
  const bytes = canonicalJSON(body);
  const digest = bodyDigest(bytes);
  const posting: Omit<RfpPostingDoc, "signatures"> = {
    ...rest,
    gate: {
      summary: {
        text: gate.summary.text.trim(),
        ...(sought !== undefined ? { sought } : {}),
        ...(procurement !== undefined ? { procurement } : {}),
        ...(performer !== undefined ? { performer } : {}),
        ...(role !== undefined ? { role } : {}),
        grade: "recorded",
      },
      nda: {
        id: gate.nda.id,
        version: gate.nda.version,
        digest: gate.nda.digest,
        ...(gate.nda.ref ? { ref: gate.nda.ref } : {}),
        grade: "evidence",
      },
      body: { digest, grade: "evidence" },
      grade: "enforced",
    },
  };
  return { posting, body, bytes, digest };
}

/**
 * The posting as its poster, or a provider it has been released to, reads it:
 * the public document with the body's members put back, and the summary's
 * classifications put back into the need. The board reads this for the rules
 * that read sealed members (the handling check at the response door, §7 rule
 * 8; the award intentions, §5.7).
 */
export function openPosting<D extends Pick<RfpPostingDoc, "gate" | "need" | "budget" | "term" | "award" | "handling">>(
  doc: D,
  body: RfpSealedBody,
): D {
  const s = doc.gate?.summary;
  return {
    ...doc,
    need: {
      ...body.need,
      ...(s?.sought !== undefined ? { sought: s.sought } : {}),
      ...(s?.procurement !== undefined ? { procurement: s.procurement } : {}),
      ...(s?.performer !== undefined ? { performer: s.performer } : {}),
      ...(s?.role !== undefined ? { role: s.role } : {}),
    },
    ...(body.budget ? { budget: body.budget } : {}),
    ...(body.term ? { term: body.term } : {}),
    ...(body.award ? { award: body.award } : {}),
    ...(body.handling ? { handling: body.handling } : {}),
  };
}

/**
 * Why a gate's `ref` cannot be taken, or null (Agent RFP 0.11.0-draft
 * §5.11.1). A ref sits inside the bytes the identifier is derived from, so it
 * never contains the posting's identifier: a board addresses a body by its
 * digest instead, which is known before the posting is assembled. An absent
 * ref is fine; it is a SHOULD.
 */
export function bodyRefRefusal(ref: string | undefined, postingId: string): string | null {
  if (ref === undefined) return null;
  if (postingId && ref.includes(postingId)) {
    return "a gate's ref cannot contain the posting's identifier, which is derived from bytes the ref sits in; address the body by its digest";
  }
  return null;
}

/** Is a public document carrying a member that belongs to the sealed body?
 *  A board refuses to host one: a member is public or sealed, never both
 *  (§5.11.1). Names the first one found. */
export function sealedMemberInPublic(doc: Record<string, unknown>): string | null {
  if (doc.gate === undefined) return null;
  for (const m of SEALED_MEMBERS) if (doc[m] !== undefined) return m;
  return null;
}

/** Which of the release checks of §5.11.3 refused, or that the board cannot
 *  check at all. */
export type ReleaseRefusal =
  | { check: 1 | 2 | 3 | 4 | 5 | 6; reason: string }
  | { check: "unavailable"; reason: string }
  | { check: "not_gated"; reason: string };

/**
 * The release decision (§5.11.3), once the NdaGate has answered checks 1, 2,
 * 3 and 5 over the presented agreement.
 *
 * The board adds check 4, that the recipient is the provider asking, from the
 * agent keys it verified on the request, and check 6, that the posting allows
 * it: open, and a first release refused once it is closed. After close, a
 * provider may be released the body again only for a version it was released
 * before (`releasedThisVersion`), because the occasion that release was for
 * has not changed; any other release is a first one, and refused.
 */
export function releaseRefusal(input: {
  doc: Pick<RfpPostingDoc, "gate">;
  state: PostingState | "withheld";
  answer: GateAnswer;
  readerAgents: readonly string[];
  /** Whether this agent was released the body of the posting's current
   *  version, under the offer its gate names, before. */
  releasedThisVersion?: (agent: string) => boolean;
}): ReleaseRefusal | null {
  if (!isGated(input.doc)) return { check: "not_gated", reason: "this posting is not gated; everything in it is public" };
  const a = input.answer;
  if (!a.ok) {
    if ("unavailable" in a) return { check: "unavailable", reason: a.reason };
    return { check: a.check, reason: a.reason };
  }
  // The agreement the NDA side vouched for must be the one the gate names:
  // same identifier, same version. A gate that answered for another
  // agreement is check 3 failing, whatever else it says.
  const named = input.doc.gate!.nda;
  if (a.agreement.id !== named.id || a.agreement.version !== named.version) {
    return { check: 3, reason: `the agreement presented is ${a.agreement.id} version ${a.agreement.version}, and this posting's gate names ${named.id} version ${named.version}` };
  }
  // §5.11.3 check 1, the owner: never a contradicted owner, and an
  // unconfirmed one only where the offer said `owners: any`.
  if (a.owner === "contradicted") {
    return { check: 1, reason: "the registry contradicts the recipient's owner, and no offer accepts a contradicted owner" };
  }
  if (a.owner === "unconfirmed" && a.owners_accepted !== "any") {
    return { check: 1, reason: "the recipient's owner could not be confirmed, and the offer accepts only confirmed owners" };
  }
  if (!input.readerAgents.includes(a.recipient.agent)) {
    return {
      check: 4,
      reason: "the agreement's recipient seat names an agent this account does not hold; the body is released to the recipient, asking for itself",
    };
  }
  if (input.state !== "open" && !(input.releasedThisVersion?.(a.recipient.agent) ?? false)) {
    return {
      check: 6,
      reason: input.state === "withheld"
        ? "no posting under that identifier"
        : `this posting is ${input.state}, so the occasion the gate exists for has ended and no new release is made`,
    };
  }
  return null;
}

/** The release record (§5.11.3, board duty 2). `evidence`: it names the
 *  posting and version, the body released, the agreement with the digest of
 *  the completed document, the recipient, when the board received the
 *  agreement, the recipient's owner as resolved then, and when it released
 *  the body. */
export interface RfpRelease {
  posting: string;
  version: number;
  body: string;
  nda: { id: string; version: number; digest: string };
  released_to: { agent: string; handle?: string };
  received_at: string;
  /** The recipient's owner as the board resolved it at receipt: `confirmed`,
   *  `unconfirmed` where the offer accepts it, or the mandate checked for an
   *  organization's seat. */
  owner: string;
  at: string;
}
