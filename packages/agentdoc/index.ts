/**
 * @common-agent/agentdoc: make, publish and check an AgentDoc (Common Agent
 * Specification, Chapter 9, https://agentdoc.net).
 *
 * An AgentDoc is one document that assembles what an agent publishes about
 * itself, its A2A card and its signed Descriptor first, and says where every
 * line came from. `assemble` builds one, `check` runs the checks of Section
 * 9.10, and `render` writes the page a person reads.
 */
export { AGENTDOC_PATH, AssembleError, CARD_PATHS, DESCRIPTOR_PATH, INTERFACE_REGISTRY, TERMS_EXTENSION, assemble, assembleWithNotes, cardCandidates, notStatedOf, type Assembled } from "./assemble.js";
export { CLAIM_KEYS, GRADE_ENDINGS, GRADE_KEYS, PACKAGE_NAMES, check, staticFindings } from "./check.js";
export { DRAFT_MARK, draftFromCard, signingProblems } from "./descriptor.js";
export { KNOWN_SECTIONS } from "./paths.js";
export { render } from "./render.js";
export { DESCRIPTOR_TAG, EVAL_TAG, SOW_TAG, checkDescriptorSignature, checkEvalSignature, checkTermsSignature, encodeUserSeed, openAttestation, signDescriptor, type SignatureCheck } from "./signatures.js";
export { RULE_IDS, type AgentDoc, type AgentDocSection, type AgentDocSource, type AssembleInput, type CheckOptions, type CheckReport, type DocumentInput, type Finding, type RuleId, type SignatureState } from "./types.js";
export { VERSION } from "./version.js";
