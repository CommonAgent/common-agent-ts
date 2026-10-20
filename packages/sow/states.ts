/**
 * The document states (§7.1).
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */

// ── §7.1: document states, including `exhausted` ────────────────────────────

/**
 * The document states of §7.1, by signature count and time.
 *
 * `exhausted` is not a failure. `lapsed` means the term ran out; `exhausted`
 * means the cap ran out (§5.5.5). A runtime MUST NOT record an exhausted
 * engagement as failed, and MUST treat lapse, exhaustion and termination
 * identically at the gate: the counterparty reverts to general admission
 * policy.
 */
export type SowDocumentState =
  | "template"
  | "standing_proposal"
  | "agreed"
  | "active"
  | "amendment_proposed"
  | "amended"
  | "exhausted"
  | "lapsed"
  | "terminated";

/** The three ways an engagement ends (§7.1). Identical at the gate. */
export const SOW_END_STATES: ReadonlySet<SowDocumentState> = new Set<SowDocumentState>([
  "exhausted",
  "lapsed",
  "terminated",
]);

/** §7.1 — lapse, exhaustion and termination are the same answer at admission:
 *  no. Nothing breaks and nothing lingers. */
export function admitsWork(state: SowDocumentState): boolean {
  return state === "active";
}

/** §5.5.5 — an engagement that ends `exhausted` is recorded as a fact and is
 *  not scored, the same way terminations are recorded unscored. */
export function isScoredOutcome(state: SowDocumentState): boolean {
  return state !== "exhausted" && state !== "terminated";
}

// ── §5.5.5: `exhausted` as a task state ─────────────────────────────────────

/**
 * A task's states, as the Common Agent Specification and Agent Messaging name
 * them (§5.2 of the one, §7.3 of the other), with Agent SoW's `exhausted`: the
 * cap was reached while the task was in flight (§5.5.5). The task concludes
 * where it stood, with whatever artifacts exist attached, and it is not a
 * failure.
 */
export type SowTaskState =
  | "submitted"
  | "working"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "exhausted";

export const TASK_TERMINAL_STATES: ReadonlySet<SowTaskState> = new Set<SowTaskState>(["completed", "failed", "canceled", "rejected", "exhausted"]);

/** Every non-terminal state may end `exhausted`: the cap is reached when it is reached (§5.5.5). */
export const TASK_TRANSITIONS: Readonly<Record<SowTaskState, readonly SowTaskState[]>> = {
  submitted: ["working", "canceled", "rejected", "exhausted"],
  working: ["completed", "failed", "input_required", "auth_required", "canceled", "exhausted"],
  input_required: ["working", "canceled", "exhausted"],
  auth_required: ["working", "canceled", "exhausted"],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
  exhausted: [],
};

export function isTaskTransition(from: SowTaskState, to: SowTaskState): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}
