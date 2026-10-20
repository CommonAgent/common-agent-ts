/**
 * What the Agent NDA core asks the platform for. The core never fetches: the
 * platform answers these ahead of time and passes the answers in, so that
 * every check in the core stays synchronous and pure.
 *
 *   MandateLookup   the §6.2 check on a signature for an organization's seat,
 *                   answered through the Agent Mandate core's MandateCheck
 *   HandleResolver  the agent key a handle names now, for an open offer
 *                   that lists handles (§6.1 step 4)
 *   OwnerResolver   the owner the registry held for a seat's agent when the
 *                   receiving verifier received the record (§6, binding
 *                   rule 1)
 *   ActReceipts     when the receiving verifier received each act (§7.3)
 *   DocReceipts     when the receiving verifier received each completed
 *                   document: an acceptance, or the last signature of a
 *                   countersigned agreement (§6)
 *
 * The ports other standards define and the NDA platform module implements
 * are theirs: Agent RFP's NdaGate (packages/rfp/ports.ts) and Agent SoW's
 * NdaReference (packages/sow/ports.ts). This core gives the module the
 * answers they need (references.ts).
 */
import type { MandateCheckRequest } from "@common-agent/mandate";
import type { Agreement, Category, SignedAct } from "./types.js";

/** What a mandate check is asked about one signature (§6.2; Agent Mandate §7.2). */
export interface MandateQuery {
  mandate: string;
  /** The owner key that signed. */
  signer: string;
  /** The organization the seat signs for. */
  organization: string;
  /** The agreement's `covers.categories`, for `scope.nda_categories`. */
  categories: Category[];
  /** When the act was signed. */
  at: string;
}

/**
 * The answer to a mandate check, already looked up. `unknown` is an honest
 * answer: the check was not run, and nothing may present the agreement as
 * mandate-verified (§6.2).
 */
export type MandateLookup = (q: MandateQuery) => "ok" | "refused" | "unknown";

/** Resolves a handle to the agent key it currently names, or undefined. */
export type HandleResolver = (handle: string) => string | undefined;

/**
 * What the registry held for an agent's owner when the receiving verifier
 * resolved it at receipt (Agent Messaging §8.6): the owner key, and whether
 * the registry verified it through an `owner_attestation`. A default owner
 * (the hosting node's key) is not attested. Undefined when the registry was
 * unreachable or does not list the agent.
 */
export type OwnerResolver = (agent: string) => { owner: string; attested: boolean } | undefined;

/** When this verifier received an act, or undefined when it did not. */
export type ActReceipts = (act: SignedAct) => string | undefined;

/** When this verifier received a completed document (an acceptance, or the
 *  signature that countersigned an agreement), as recorded at receipt, or
 *  undefined when there is no such record. */
export type DocReceipts = (doc: Agreement) => string | undefined;

/**
 * The request the Agent Mandate core's MandateCheck takes for one of these
 * queries: the `nda` power, with the agreement's categories for
 * `scope.nda_categories` (Agent Mandate §7.2). The account of the person who
 * signed is the platform's to supply; the agreement names only the key.
 */
export function mandateCheckRequest(q: MandateQuery, account: string): MandateCheckRequest {
  return { organization: q.organization, account, power: "nda", mandate: q.mandate, nda_categories: [...q.categories] };
}
