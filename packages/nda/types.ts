/**
 * The Agent NDA document model at 0.2.0-draft (https://agentnda.net): the
 * agreement (§4, §5), its signature records (§6), the acts that end it (§7.3)
 * and the reference other documents name it by (§8).
 *
 * The closed lists are exported as constants so that a validator, a renderer
 * and a form all read the same tokens. A value outside a list is not covered,
 * not permitted, or not valid, never guessed at (§5).
 */

/** §4.1: an agreement's identifier. */
export const NDA_ID = /^nda_[0-9a-hjkmnp-tv-z]{16}$/;

/** §6: the signed bytes of an agreement. */
export const AGREEMENT_TAG = "agent-nda-v1";
/** §7.3: the signed bytes of a termination or a withdrawal. */
export const ACT_TAG = "agent-nda-act-v1";
/** §6: the bytes one signature record signs. */
export const SIG_TAG = "agent-nda-sig-v1";

export const DIRECTIONS = ["one_way", "mutual", "multilateral"] as const;
export const CATEGORIES = ["solicitation", "agreement_terms", "relationship", "inputs", "deliverables", "own_material"] as const;
export const ACTIVITIES = ["evaluate_solicitation", "validation_probe", "negotiation", "perform_engagements", "process_runs"] as const;
export const EXCLUSIONS = ["public", "already_known", "independently_developed", "third_party"] as const;
export const NEED_TO_KNOW = ["personnel", "advisers"] as const;
export const SUBCONTRACTORS = ["none", "bound"] as const;
export const AT_END_ACTIONS = ["return", "destroy", "return_or_destroy"] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type Category = (typeof CATEGORIES)[number];
export type Activity = (typeof ACTIVITIES)[number];
export type Exclusion = (typeof EXCLUSIONS)[number];
export type NeedToKnow = (typeof NEED_TO_KNOW)[number];
export type Grade = "enforced" | "evidence" | "recorded";

/** §11: the grade each clause MUST carry. Nothing in an agreement is
 *  `enforced` (§3). */
export const FIXED_GRADES = {
  parties: "evidence",
  purpose: "recorded",
  covers: "recorded",
  disclosure: "recorded",
  survival: "recorded",
  exclusions: "recorded",
  compelled: "recorded",
  at_end: "recorded",
  termination: "evidence",
} as const satisfies Record<string, Grade>;

export type GradedClause = keyof typeof FIXED_GRADES;

/** §5.1: one seat, the shape of an Agent SoW parties seat. */
export interface Seat {
  agent: string;
  handle?: string;
  owner: string;
  /** The organization the seat signs for (§6.2). */
  organization?: string;
  /** §5.1: the key that signs for a seat with no organization. */
  owner_key?: string;
}

export interface Parties {
  discloser?: Seat;
  /** `null` in an open offer (§6.1). */
  recipient?: Seat | null;
  /** Multilateral agreements only: 3 to 16 seats (§5.1). */
  members?: Seat[];
  grade: Grade;
}

/** Agent SoW §5.11's processor entry, shared so an engagement compares with
 *  the agreement it runs under (§5.5). */
export interface Processor {
  service: string;
  domain?: string;
  purpose?: string;
  processed_in?: string[];
}

/** One party's declaration of who processes material and where (§5.5). */
export interface Declaration {
  processors?: Processor[];
  processed_in?: string[];
}

export interface MemberDeclaration extends Declaration {
  agent: string;
}

export interface Disclosure {
  require?: { processed_in?: string[] };
  /** `null` in an open offer, written at acceptance (§6.1). */
  recipient?: Declaration | null;
  /** The discloser's own declaration, in a mutual agreement. */
  discloser?: Declaration;
  /** One declaration per member, in a multilateral agreement. */
  members?: MemberDeclaration[];
  subcontractors?: "none" | "bound";
  need_to_know?: NeedToKnow[];
  grade: Grade;
}

/** §8: how a document names one version of an agreement. */
export interface AgreementReference {
  id: string;
  version: number;
  digest: string;
  ref?: string;
  grade?: Grade;
}

export interface SignatureRecord {
  role: "discloser" | "recipient" | "member";
  key: string;
  signed_at: string;
  sig: string;
  /** §6: the digest of the bytes the record covers. */
  digest: string;
  /** §6.1: the discloser's record on an open offer, and on each acceptance
   *  of it, covers the offer bytes. */
  over?: "offer";
  /** §6.2: REQUIRED when the seat names an organization. */
  mandate?: string;
  /** REQUIRED on a `member` record: the seat it signs for. */
  agent?: string;
}

export interface Agreement {
  nda: "v1";
  id: string;
  version: number;
  language: { id: string; version: number; sha256: string };
  direction: Direction;
  parties: Parties;
  offer?: {
    open_to: "any" | string[];
    expires_at: string;
    /** §6.1: which recipient owners a decision accepts; absent is confirmed. */
    owners?: "confirmed" | "any";
  };
  flows_from?: { id: string; version: number; digest: string };
  effective_at?: string | null;
  ends_at: string;
  purpose: {
    statement: string;
    activities?: Activity[];
    named?: Record<string, unknown>[];
    grade: Grade;
  };
  covers: { categories: Category[]; grade: Grade };
  disclosure?: Disclosure;
  survival?: { days: number; grade: Grade };
  exclusions?: { allowed: Exclusion[]; grade: Grade };
  compelled?: { notice: boolean; grade: Grade };
  at_end?: { action: (typeof AT_END_ACTIONS)[number]; within_days?: number; certify?: boolean; grade: Grade };
  termination?: { notice_days?: number; grade: Grade };
  signatures: SignatureRecord[];
}

/** §7.3: the body of a termination or a withdrawal, signed on its own. */
export interface ActBody {
  nda: string;
  version: number;
  /** The agreement's digest, or the offer digest for a withdrawn offer. */
  digest: string;
  action: "terminate" | "withdraw";
  at: string;
  reason?: string;
  /** §7.3: the acting seat. */
  by: "discloser" | "recipient" | "member";
  /** REQUIRED when `by` is `member`: the seat's agent key. */
  agent?: string;
}

/** A signed act (§7.3). The signature covers the body and its own record;
 *  `mandate` is REQUIRED where the acting seat names an organization. */
export interface SignedAct {
  act: ActBody;
  signature: { key: string; signed_at: string; sig: string; mandate?: string };
}
