/**
 * The Agent Mandate core (https://agentmandate.net).
 *
 * The standard it implements, the check every other standard asks it for,
 * and the documents themselves: charters, mandates and resolve acts, their ids and signatures,
 * the chain to root authority, the five checks at approval, and what counts
 * as proof of domain control, at Agent Mandate 0.6.0-draft: the `nda` power,
 * `scope.nda_categories`, the check for an Agent NDA (§7.2), and the holder
 * key every mandate holding `nda` carries (§6 rule 2).
 *
 * This file and ports.ts are the core's public face: code outside the core
 * imports from them only.
 */

/** The standard and the version this core is written against. */
export const MANDATE_SPEC = {
  id: "mandate",
  name: "Agent Mandate",
  version: "0.8.0-draft",
  url: "https://agentmandate.net/spec.html",
} as const;

import type { MandatePower } from "./mandate-doc.js";

/**
 * The powers a mandate can hold (Agent Mandate §6 rule 4). An act needs the
 * power named for it: `form` for formation, `amend` for amendments,
 * `terminate` for terminations, `award` for RFP awards, `nda` for every act
 * on an Agent NDA (§7, check 3) and `write` for a mutating act through a
 * resource proxy whose grant names no other power (§7.1). The set is the
 * documents' own `POWERS`.
 */
export type { MandatePower };

/**
 * The five checks of §7, in order, and §7.2 step 4, which an act on an
 * Agent NDA takes in their place. A refusal names the one that failed, so
 * the person who was refused can tell which kind of fix to ask for.
 */
export type MandateCheckName = "holder" | "in_force" | "power" | "ceiling" | "scope" | "nda_categories";

/** What an act asks a mandate check to approve. */
export interface MandateCheckRequest {
  /** The organization the act's party names (an Agent SoW party's `organization`). */
  organization: string;
  /** The account of the person confirming the act. */
  account: string;
  /** The power the act needs. */
  power: MandatePower;
  /** The mandate the act cites, where it cites one. Only that mandate is then checked. */
  mandate?: string;
  /** The key the act was signed with, where known. Check 1 fails when it is not the mandate's `holder.key` (§7.2 step 1). */
  signer_key?: string;
  /** For a mutating act through a resource proxy: the resource it targets, for `scope.resources` (§6 rule 9). */
  resource?: string;
  /** When the act was signed, in milliseconds. A signature is checked against the mandate as it stood then (§7.2 step 2). Absent means now. */
  at?: number;
  /** The committed price, in the clearing binding's integer unit, for check 4. Absent for acts that commit nothing. */
  committed?: number;
  /** The currency of `committed`. A mandate bounded in another currency fails check 4 rather than being compared. */
  currency?: string;
  /**
   * What the confirming account has already committed for the organization
   * this calendar month, before this act, for check 4's `per_month`. The caller
   * computes it from the engagements it formed until the treasury's draw
   * records exist (§8.3). Required whenever `committed` is present.
   */
  month_to_date?: number;
  /** The offerings the act covers, for check 5. */
  offerings?: string[];
  /** For an act on an Agent NDA: the categories of information it covers (§7.2). */
  nda_categories?: string[];
}

/**
 * The answer. `grade` says whether the answer was enforced or is evidence
 * only (§7, last paragraph). On a pass, `chain` is the mandate and the ones
 * above it up to root authority, and `settlement_payer` says who pays under it
 * (§6.5).
 *
 * Neither `unavailable` nor `unreachable` is a pass. An act whose party names
 * an organization is refused when authority to bind it cannot be checked:
 * letting it through would record organizational authority nothing checked,
 * and an enforced check that fails open is not one.
 */
export type MandateCheckResult =
  | { ok: true; mandate: string; grade: "enforced" | "evidence"; chain?: string[]; settlement_payer?: "holder" | "organization" }
  | { ok: false; failed: MandateCheckName; reason: string }
  /** The deployment runs no mandate registry. */
  | { ok: false; failed: "unavailable"; reason: string }
  /** The registry did not answer, or answered with an error. The act can be tried again. */
  | { ok: false; failed: "unreachable"; reason: string };

/**
 * The check at approval (§7), as a port. Agent RFP asks it at award and
 * Agent SoW at formation, amendment and termination; the Mandate platform
 * module implements it. It lives in this core because both callers may use
 * Mandate's types and neither owns the answer.
 */
export interface MandateCheck {
  authorize(request: MandateCheckRequest): Promise<MandateCheckResult>;
}

// ── the documents, the chain and the five checks ─────────────────

export {
  CHARTER_TAG,
  MANDATE_TAG,
  RESOLVE_TAG,
  CHARTER_SIG_PREFIX,
  MANDATE_SIG_PREFIX,
  RESOLVE_SIG_PREFIX,
  POWERS,
  NDA_CATEGORIES,
  signedBody,
  deriveId,
  idCheck,
  verifyDocSignature,
  validateCharter,
  validateMandate,
  validateResolveAct,
  verifyRootAuthority,
  verifyCharterSignatures,
  patternMatches,
  patternCovers,
  isResourcePattern,
  charterAmendmentFailure,
  narrowingFailure,
  verifyMandateChain,
} from "./mandate-doc.js";
export type {
  /** The same set as MandatePower, kept under this name for the callers that import it. */
  MandatePower as HeldPower,
  NdaCategory,
  DocSignature,
  CharterDoc,
  MandateIssuer,
  MandateDoc,
  ResolveActDoc,
  Validation,
  RootAuthorityVerdict,
  Narrowing,
  ChainInput,
  ChainOptions,
  ChainCheck,
  ChainVerdict,
} from "./mandate-doc.js";
export { POWER_FOR_ACT, checkAtApproval } from "./mandate-check.js";
export { WRITES_POWERS, validateProxyWrites, powerForWrite, checkAtProxy } from "./proxy.js";
export type { WritesPower, ProxyGrant, ProxyAct, ProxyMandate, ProxyVerdict, ProxyCheck } from "./proxy.js";
export { identifierHeld } from "./ids.js";
export type { IdentifierView, Filing, HoldVerdict } from "./ids.js";
export type { ApprovalAct, ApprovalCheck, ApprovalRequest, ApprovalVerdict, MandateRegistryView } from "./mandate-check.js";
export { DNS_LABEL, WELL_KNOWN_PATH, namesCharter, checkDomainControl } from "./domain-proof.js";
export type { DomainProbe, ProofResult } from "./domain-proof.js";
