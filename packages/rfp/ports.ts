/**
 * The ports Agent RFP asks the platform for. The host wires each one at
 * startup.
 *
 *   NdaGate          who may read a gated posting's sealed body (§5.11)
 *   ProposalLookup   the SoW proposal a response names (§7)
 *   MandateCheck     the authority behind an award, from the Agent Mandate core
 */

export type { MandateCheck, MandateCheckRequest, MandateCheckResult } from "@common-agent/mandate";

/** The offer a gated posting names (§5.11.1, `gate.nda`): an open Agent NDA signed by the poster. */
export interface GateOffer {
  id: string;
  version: number;
  /** `sha256:` over the open offer's signed bytes. */
  digest: string;
  ref?: string;
}

/**
 * What the Agent NDA side answers about a presented agreement (§5.11.3).
 * Checks 1, 2, 3 and 5 are its own: the acceptance is valid and arrived in
 * time, the offer is the poster's, the offer is the one the posting names,
 * and nothing has terminated the agreement. The board adds checks 4 and 6.
 */
export type GateAnswer =
  /** The agreement opens the gate. The reference is what the release record
   *  names, with the digest of the completed document. */
  | {
      ok: true;
      agreement: { id: string; version: number; digest: string };
      recipient: { agent: string; handle?: string };
      /** The recipient's owner as resolved at the board's instant of receipt:
       *  `confirmed`, `unconfirmed`, `contradicted`, or for a seat that names
       *  an organization the mandate checked (Agent NDA §6.1, §6.2). */
      owner: string;
      /** The offer's `owners`: which owners it accepts. Absent reads as
       *  `confirmed`. */
      owners_accepted?: "confirmed" | "any";
    }
  | { ok: false; check: 1 | 2 | 3 | 5; reason: string }
  | { ok: false; unavailable: true; reason: string };

/**
 * Before a board releases a gated posting's sealed body, it asks whether the
 * agreement a provider presents opens the gate (§5.11.3). The Agent NDA
 * module implements it. A host without one wires a gate that answers
 * `unavailable`, and a board with no gate opens no gated posting.
 */
export interface NdaGate {
  mayRead(request: {
    /** The Agent NDA the posting's gate names. */
    offer: GateOffer;
    /** The posting's `poster.agent`, which the discloser seat must name. */
    poster: string;
    /** The completed agreement, as the provider presented it. */
    agreement: unknown;
    /** When the board received it. Expiry and withdrawal are checked against
     *  this instant as well as the recipient's own `signed_at`, which the
     *  recipient writes and could write early; a signer's mandate is checked
     *  at it as well as at the record's `signed_at`; and the recipient's owner
     *  is resolved at it (Agent RFP 0.10.0-draft §5.11.3, check 1). */
    receivedAt: string;
  }): Promise<GateAnswer>;
}

/**
 * The slice of a SoW proposal the board reads (§7). A response is a complete
 * Agent SoW document; this names only the members the response rules, the
 * handling check and the response panel look at, so the RFP core needs nothing from the SoW core to
 * check one. The Agent SoW module's stored proposal satisfies it.
 */
export interface ProposalDoc {
  id: string;
  version: number;
  parties?: {
    provider?: { agent?: string; owner?: string };
    /** The one party the proposal is offered to (Agent SoW §12.1.1). A
     *  response names the poster here. */
    offered_to?: { agent?: string; organization?: string; expires_at?: string };
  };
  /** Which posting, at which version, the proposal answers (§7). */
  solicitation?: { rfp: string; version: number };
  /** The price clause, read only to summarize it for the poster. */
  price?: unknown;
  /** The confidentiality clause (Agent SoW §5.11), read by the handling
   *  check at the response door (§7 rule 8). A lookup that leaves it out
   *  would make every response to a posting with `handling` fall short. */
  confidentiality?: unknown;
}

/**
 * A response names a SoW proposal by its provider agent and offering (§7).
 * The board reads that proposal through this port instead of reaching into
 * the SoW store, so the two modules stay apart, and it never writes one: the
 * proposal's own authoring path is the only way a SoW document is made. The
 * Agent SoW module implements it.
 */
export interface ProposalLookup {
  get(providerAgent: string, offering: string): Promise<ProposalDoc | null>;
}
