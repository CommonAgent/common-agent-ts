/**
 * The rules a response's own document must meet (Agent RFP §7).
 *
 * A response is a complete Agent SoW document, a directed standing proposal,
 * signed by the responder. The board holds no signature over it, so an index
 * row naming a response is only worth anything if the document really says
 * what the row claims: that it is the filing agent's, that it answers this
 * posting at a version the posting has had, and that it is offered to this
 * poster, with a lapse that has not passed.
 *
 * These checks read the document's addressing only. Whether the posting is
 * open, whether the filing account holds the agent, and the handling
 * comparison of §7 rule 8 (Agent SoW §5.11's, run by the SDK) stay with the
 * board.
 */
import type { ProposalDoc } from "./ports.js";

/** What these checks read of the posting being answered. */
export interface AnsweredPosting {
  id: string;
  poster: { agent: string };
  /** Every version the posting has had, current one included. */
  versions: number[];
}

/** Which rule of §7 a response's document broke. The conformance file names
 *  its cases by these. */
export type ResponseRule =
  | "provider_mismatch"
  | "no_solicitation"
  | "other_posting"
  | "unknown_version"
  | "undirected"
  | "other_party"
  | "no_lapse"
  | "lapsed";

/**
 * Why this document is not a response to this posting, or null where it is.
 * The sentences are the board's refusals, word for word.
 */
export function responseDocRefusal(
  posting: AnsweredPosting,
  proposal: ProposalDoc,
  agentKey: string,
  now: string,
): string | null {
  return responseDocCheck(posting, proposal, agentKey, now)?.reason ?? null;
}

/** The rule a response's document broke, and the board's sentence for it, or
 *  null where the document answers the posting. */
export function responseDocCheck(
  posting: AnsweredPosting,
  proposal: ProposalDoc,
  agentKey: string,
  now: string,
): { rule: ResponseRule; reason: string } | null {
  const refuse = (rule: ResponseRule, reason: string) => ({ rule, reason });
  if (proposal.parties?.provider?.agent !== agentKey) {
    return refuse("provider_mismatch", "that document's provider seat names a different agent");
  }
  const solicitation = proposal.solicitation;
  if (!solicitation) {
    return refuse(
      "no_solicitation",
      "that document does not say which posting it answers. A response carries a solicitation " +
      "reference inside the bytes its owner signed, so the claim is the responder's and not the board's."
    );
  }
  if (solicitation.rfp !== posting.id) {
    return refuse("other_posting", `that document answers ${solicitation.rfp}, not this posting. The reference is inside the signed bytes and cannot be re-pointed without re-signing.`);
  }
  if (!posting.versions.includes(solicitation.version as number)) {
    return refuse("unknown_version", `that document answers version ${solicitation.version} of this posting, and this posting has never had one. Its versions are ${posting.versions.join(", ")}.`);
  }
  const offeredTo = proposal.parties?.offered_to;
  if (!offeredTo) {
    return refuse(
      "undirected",
      "that document is offered to the market rather than to this poster. A response names the " +
      "poster as the one party entitled to countersign it, so that a price quoted to one buyer does not become a price anyone can take."
    );
  }
  if (offeredTo.agent !== posting.poster.agent) {
    return refuse(
      "other_party",
      "that document is offered to a different party than this posting's poster. A document offered " +
      "to somebody other than the poster is not an answer to this posting, whatever its solicitation reference says."
    );
  }
  if (!offeredTo.expires_at) {
    return refuse(
      "no_lapse",
      "that offer does not say when it lapses, so nothing could ever form under it. Give it an expiry — " +
      "this posting's own closing date is the natural one."
    );
  }
  if (now >= offeredTo.expires_at) {
    return refuse("lapsed", `that offer lapsed at ${offeredTo.expires_at}, so filing it would file something nobody can accept. Re-sign it with a later expiry.`);
  }
  return null;
}
