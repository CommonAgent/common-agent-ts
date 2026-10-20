/**
 * The ports Agent SoW asks the platform for. The host wires each one at
 * startup, and a deployment without the service behind a port gets an
 * implementation that says so: an engagement on a mesh with no clearing is
 * evidence grade.
 *
 *   Settlement     money, through whatever clearing binding the host has
 *   MandateCheck   the check at approval, from the Agent Mandate core
 *   NdaReference   the Agent NDA an engagement names (§5.16)
 *   OwnerResolver  the registry's attested owner of an agent (§6 binding)
 */

export type { MandateCheck, MandateCheckRequest, MandateCheckResult } from "@common-agent/mandate";

/**
 * The engagement's `provider_contact` member (Agent SoW 0.25.0-draft), defined
 * with its validation in contact.ts.
 */
export type { ProviderContact } from "./contact.js";

/**
 * The client's purchase-order number or internal reference (Agent SoW
 * 0.25.0-draft). Free text, set by the client at formation and changed only
 * by amendment. Nothing interprets it: it is carried unchanged onto every
 * receipt and settlement record issued under the engagement, so the client's
 * own books can match them.
 */
export type BuyerReference = string;

// ── Settlement ─────────────────────────────────────────────────────────────

/** The refusal codes a clearing binding answers with. A code this list does not name is read as the status alone. */
export type ClearingCode =
  | "not_permitted"
  | "not_offered"
  | "no_such_object"
  | "no_such_route"
  | "invalid_request"
  | "insufficient_funds"
  | "terms_conflict"
  | "already_reversed"
  | "not_reversible"
  | "closed"
  | "internal_error";

/** A settlement's state. An absent state on an accepted answer reads as `settled`. */
export type SettlementState = "settled" | "pending" | "failed";

/**
 * Every Settlement answer. `applied` is false when the call was a replay of
 * one that already happened: nothing moved twice.
 */
export type SettlementAnswer<T> =
  | ({ ok: true; applied: boolean } & T)
  | { ok: false; status: number; code?: ClearingCode | string; error: string }
  /** No clearing binding on this deployment, or it does not offer the operation. */
  | { ok: false; status: 501; code: "unavailable"; error: string };

/** Open a reservation for a time and materials engagement (Agent SoW §5.5.4; a clearing open-hold). */
export interface ReserveRequest {
  /** The engagement's own identity, so a retried formation finds the same hold. */
  holdId: string;
  /** The paying account. */
  account: string;
  /** The cap, in the binding's integer unit. */
  amount: number;
  /** The end of the reservation window, ISO 8601. */
  expiresAt: string;
  ref?: string;
  memo?: string;
}

/** A reservation as the binding reports it. The binding is the authority on `drawn`. */
export interface Reservation {
  holdId: string;
  account: string;
  amount: number;
  drawn: number;
  status: "open" | "released";
  openedAt: string;
  expiresAt: string;
  releasedAt?: string | null;
}

/** Move a reservation to a new cap, from an amendment (a clearing resize-hold). */
export interface ResizeRequest {
  holdId: string;
  amount: number;
  expiresAt?: string;
  reason?: string;
}

/** One metered line, already rated by the SoW rules. */
export interface UsageLine {
  meter: string;
  amount: number;
  unit?: string;
  count?: number;
  per?: number;
  per_unit?: number;
  pass_through?: boolean;
  upstream_receipt?: string;
}

/** Bill metered usage against a reservation, never past its cap (a clearing draw). */
export interface DrawRequest {
  holdId: string;
  /** Identifies the usage window being billed; the idempotency key. */
  txnId: string;
  /** The paying account; it must own the hold. */
  caller: string;
  /** The earning account. */
  owner: string;
  lines: UsageLine[];
  ref?: string;
  memo?: string;
  /** The engagement's buyer reference, for the receipt the SoW module keeps. Not sent to clearing, which has no such field. */
  buyer_reference?: BuyerReference;
}

export interface DrawResult {
  billed: number;
  refused: number;
  remaining: number;
  exhausted: boolean;
  /** The settlement's state: an accepted answer with no state is settled. */
  state: SettlementState;
}

/** Settle one fixed-price task: the client pays, the provider earns (a clearing settle). */
export interface ChargeRequest {
  txnId: string;
  /** The paying account. */
  caller: string;
  /** The earning account. */
  owner: string;
  /** What the provider earns. */
  rate: number;
  /** What the client pays; never below `rate`. */
  retail: number;
  ref?: string;
  memo?: string;
  /** The paying agent, for the platform's usage rollup. */
  spendAgentKey?: string;
  /** The engagement's buyer reference, for the receipt the SoW module keeps. Not sent to clearing, which has no such field. */
  buyer_reference?: BuyerReference;
}

/** Close a reservation and let the unused remainder go (a clearing release-hold). */
export interface ReleaseRequest {
  holdId: string;
  reason?: string;
}

/** Undo a settlement, for `refund_on_failed_task` (Agent SoW §5.10; a clearing reverse). */
export interface RefundRequest {
  /** The identifier of the refund itself. */
  txnId: string;
  /** The settlement being undone. */
  reverses: string;
  reason: string;
  actor?: string;
}

/**
 * One settlement as the binding records it (a clearing read-settlement):
 * the receipt both parties can point to. `account` is the paying account and
 * `amount` what it paid.
 */
export interface Receipt {
  txn_id: string;
  state: SettlementState | "unknown";
  amount: number;
  account: string;
  opened_at?: string;
  settled_at?: string | null;
  legs: Array<{ account: string; delta: number; kind: string }>;
  reversed_by: string | null;
  period?: string;
  /** The engagement's buyer reference. A clearing binding may have no such field, and then the host supplies it from the engagement; a binding that stores it may return it here. */
  buyer_reference?: BuyerReference;
}

/**
 * Money, as Agent SoW needs it. Formation reserves, metered work draws,
 * fixed-price tasks charge, the window's end releases, and a failed task under
 * `refund_on_failed_task` is refunded. The host binds it to a clearing
 * service; a different binding needs no change here.
 */
export interface Settlement {
  reserve(request: ReserveRequest): Promise<SettlementAnswer<{ reservation: Reservation; available?: number }>>;
  resize(request: ResizeRequest): Promise<SettlementAnswer<{ reservation: Reservation; delta?: number }>>;
  draw(request: DrawRequest): Promise<SettlementAnswer<DrawResult>>;
  charge(request: ChargeRequest): Promise<SettlementAnswer<{ state: SettlementState }>>;
  /** What the hold handed back. A replay (`applied: false`) releases nothing, and carries the hold as the binding now reports it where it sends one, so the caller can say what had been left. */
  release(request: ReleaseRequest): Promise<SettlementAnswer<{ released: number; reservation?: Reservation }>>;
  refund(request: RefundRequest): Promise<SettlementAnswer<{ amount?: number; state: SettlementState }>>;
  receipt(txnId: string): Promise<SettlementAnswer<{ receipt: Receipt }>>;
  /** One reservation as the binding holds it (clearing read-reservation, §6.6, OPTIONAL). A binding without the door answers status 404; the binding is the authority on `drawn`. */
  reservation(holdId: string): Promise<SettlementAnswer<{ reservation: Reservation }>>;
}

// ── NdaReference ───────────────────────────────────────────────────────────

/** The `nda` member of an engagement (Agent SoW §5.16). */
export interface NdaMember {
  id: string;
  version: number;
  /** `sha256:` over the completed agreement's signed bytes. */
  digest: string;
  ref?: string;
  grade: "evidence";
}

/**
 * What Agent SoW asks about the NDA an engagement names, at formation and on
 * every amendment that changes the member: is there a completed agreement
 * with these bytes, and are its parties this engagement's parties (§5.16,
 * "The parties are the engagement's parties")? The Agent NDA module
 * implements it.
 */
export interface NdaReference {
  check(member: NdaMember, parties: { provider: string; client: string }): Promise<
    | { ok: true }
    | { ok: false; reason: string }
    /** The deployment has no Agent NDA module; the member stays evidence the counterparty can check. */
    | { ok: false; unavailable: true; reason: string }
  >;
}

// ── OwnerResolver ──────────────────────────────────────────────────────────

/**
 * The registry's owner of an agent, which the party that receives a document
 * resolves at receipt to confirm a seat's `owner_key` (§6, binding; Agent
 * Messaging §8.6). Null where the registry cannot be reached or does not list
 * the agent. Only an owner the registry verified through an owner_attestation
 * confirms a seat; `attested: false` leaves it unconfirmed.
 */
export interface OwnerResolver {
  ownerOf(agent: string): Promise<{ owner: string; attested: boolean } | null>;
}
