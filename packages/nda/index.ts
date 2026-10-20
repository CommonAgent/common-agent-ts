/**
 * The Agent NDA core (https://agentnda.net): the agreement, its bytes,
 * signatures, acts and lifecycle, and the read-only answers the other
 * standards ask of it. Pure: no storage, no network, and no clock but the
 * instant a caller passes. It imports only Node's crypto and, for the `nda`
 * power, the Agent Mandate core's types.
 */

/** The standard and the version this core is written against. */
export const NDA_SPEC = {
  id: "nda",
  name: "Agent NDA",
  version: "0.2.0-draft",
  url: "https://agentnda.net/spec.html",
} as const;

export * from "./types.js";
export * from "./crypto.js";
export * from "./bytes.js";
export * from "./validate.js";
export * from "./records.js";
export * from "./signatures.js";
export * from "./acts.js";
export * from "./state.js";
export * from "./flowdown.js";
export * from "./references.js";
export * from "./ports.js";
