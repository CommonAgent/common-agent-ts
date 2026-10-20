/**
 * The Agent RFP core (https://agentrfp.net).
 *
 * The posting document and its two byte strings (posting.ts), the lifecycle
 * derived from it (lifecycle.ts), the rules a response's own document must
 * meet (responses.ts), and the signing convention they share (crypto.ts, over
 * the shared crypto core). No storage and no HTTP: the board that keeps
 * postings and answers requests is the platform's, around this core.
 */

export * from "./posting.js";
export * from "./lifecycle.js";
export * from "./responses.js";
export * from "./gate.js";
export { canonicalJSON, crockford32, verifyTagged, type Signer } from "./crypto.js";
export type { GateAnswer, GateOffer, MandateCheck, NdaGate, ProposalDoc, ProposalLookup } from "./ports.js";

/** The standard and the version this core is written against. */
export const RFP_SPEC = {
  id: "rfp",
  name: "Agent RFP",
  version: "0.10.0-draft",
  url: "https://agentrfp.net/spec.html",
} as const;
