/**
 * The Agent SoW core (https://agentsow.com).
 *
 * The documents of Agent SoW at 0.26.0-draft: their types, the identifier (§4.1), the signed
 * bytes and signatures (§6), the validation of every clause, the document
 * states (§7.1) and the engagement's lifecycle as pure functions (formation,
 * amendment, termination, the cap), and pricing and rating (§5.5). It holds no
 * storage, sends nothing and moves no money: what it needs from the platform
 * it asks for through the ports in ports.ts.
 *
 * The clause modules began as the TypeScript SDK's sow.ts, which the Rust SDK
 * mirrors; the conformance files pin both, and test/vectors.test.ts runs every
 * one of them against this core. Signatures are written in canonical padded
 * base64 and, on a document whose seats name their `owner_key`, bound to those
 * keys (§5.1, §6); a document written before 0.26.0-draft stays agreed with
 * its signatures unbound.
 */

export type { BuyerReference, ProviderContact, Settlement, NdaReference } from "./ports.js";

export * from "./shared.js";
export { canonicalJSON, signerFromRawSeed, signerFromSeed, type Signer } from "./crypto.js";
export * from "./states.js";
export * from "./price.js";
export * from "./disputes.js";
export * from "./confidentiality.js";
export * from "./reporting.js";
export * from "./terms.js";
export * from "./subcontracting.js";
export * from "./parties.js";
export * from "./signing.js";
export * from "./nda.js";
export * from "./clauses.js";
export * from "./contact.js";
export * from "./document.js";
export * from "./lifecycle.js";
export * from "./formation.js";
export * from "./acts.js";

/** The standard and the version this core is written against. */
export const SOW_SPEC = {
  id: "sow",
  name: "Agent SoW",
  version: "0.30.0-draft",
  url: "https://agentsow.com/spec.html",
} as const;
