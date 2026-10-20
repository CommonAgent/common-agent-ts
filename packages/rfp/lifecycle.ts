/**
 * The posting lifecycle (Agent RFP §9), derived on read.
 *
 * A posting's state is never stored. `expired` comes from the signed
 * `expires_at` and the clock, `filled` from the signed seats bound and the
 * board's own grant count, and the three terminal states from the one
 * poster-side act on the record. Deriving it per read is what stops a cached
 * row serving an expired posting as open.
 */
import { admitsMessages, isTerminalAct, seatsOf, type RfpPostingDoc, type RfpResolveActBody } from "./posting.js";

/** The states of §9 a signed posting can be in. `draft` is not here: an
 *  unsigned document is not a posting. */
export type PostingState = "open" | "awarded" | "withdrawn" | "closed" | "filled" | "expired";

/** What the state is read from: the signed document, the acts recorded beside
 *  it, and, where the board tracks grants (§5.9.1), how many seats it has
 *  granted. */
export interface PostingFacts {
  doc: Pick<RfpPostingDoc, "expires_at" | "respond" | "resolution">;
  acts: ReadonlyArray<{ body: Pick<RfpResolveActBody, "action"> }>;
  granted?: number;
}

/**
 * The posting's state at `now`, an ISO 8601 instant.
 *
 * A terminal act wins over everything, then `filled`, then expiry: a posting
 * that was awarded, or filled, and then aged keeps the state it reached first.
 */
export function postingState(facts: PostingFacts, now: string): PostingState {
  const terminal = facts.acts.find((a) => isTerminalAct(a.body));
  if (terminal) return terminalState(terminal.body.action);
  // Derived `filled` (§5.9.1, §9): the signed seats bound reached by the
  // granted count. Only where messages are admitted, because only there are
  // seats granted at all.
  if (admitsMessages(facts.doc) && (facts.granted ?? 0) >= seatsOf(facts.doc)) return "filled";
  if (now >= facts.doc.expires_at) return "expired";
  return "open";
}

/** The state a terminal act leaves a posting in. */
export function terminalState(action: RfpResolveActBody["action"]): "awarded" | "closed" | "withdrawn" {
  return action === "award" ? "awarded" : action === "close" ? "closed" : "withdrawn";
}
