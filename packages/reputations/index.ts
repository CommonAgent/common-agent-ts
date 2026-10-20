/**
 * The Agent Reputations core (https://agentreputations.com).
 *
 * The scoring formula and its priors (score.ts), the pool of §7.1 over the
 * standard's ledger events (pool.ts), the pure rules of the bureau's ledger
 * (ledger.ts), the report as data (report.ts), signing and verifying a
 * report (signing.ts), and the pure parts of a claim of breach of an Agent
 * NDA (nda-claims.ts). A bureau's process, its database and its signing key
 * are the host's, which uses this core.
 *
 * This core asks the platform for nothing and calls no other standard. It
 * learns about engagements only from the evidence the bureau records.
 */

/** The standard and the version this core is written against. */
export const REPUTATIONS_SPEC = {
  id: "reputations",
  name: "Agent Reputations",
  version: "0.6.0-draft",
  url: "https://agentreputations.com/spec.html",
} as const;

export {
  OUTCOME_VALUES,
  VALUE_OUTCOMES,
  UNSCORED_OUTCOMES,
  FORMULA_VERSION,
  HALF_LIFE_DAYS,
  UNPROVEN_THRESHOLD,
  K_VALUE,
  decayWeight,
  eventWeight,
  scorePool,
  scoreWeighted,
  portfolioPrior,
  checkPrior,
  UNIFORM_PRIOR,
  MAX_PRIOR_WEIGHT,
  type Prior,
  type ScoredEvent,
  type QualityScore,
} from "./score.js";

export { poolFromEvents, NO_WORK, type LedgerEvent, type PoolEntry } from "./pool.js";

export {
  GENESIS,
  SOURCE_RANK,
  enrollmentFromActs,
  poolFromEntries,
  entryHashOf,
  verifyChainEntries,
  LEDGER_ACTIONS,
  type LedgerAction,
  type LedgerEntry,
  type EnrollmentInfo,
  type PoolResult,
} from "./ledger.js";

export {
  REPORT_SIG_PREFIX,
  ENROLL_TAG,
  WITHDRAW_TAG,
  VALUE_TAG,
  enrollmentActText,
  valueJudgmentText,
  REPORT_TTL_MS,
  capabilityState,
  capabilityBlock,
  factsBlock,
  assembleReport,
  assembleCapabilityReport,
  type CapabilityState,
  type CapabilityBlock,
  type FactsBlock,
  type Report,
  type SignedReport,
  type CapabilityReport,
} from "./report.js";

export {
  REPORT_TAG,
  ORG_REPORT_TAG,
  REPORT_KEY_USE,
  CLOCK_GRACE_SECONDS,
  jcs,
  signedBytes,
  kidOf,
  keySetFor,
  rawKeyFromNkey,
  keyFromRaw,
  seedSigner,
  signReport,
  inexactInteger,
  verifyReport,
  verifyReportText,
  repeatedMember,
  type KeySet,
  type KeySetEntry,
  type ReportSigner,
  type ReportEnvelope,
  type VerifyOptions,
  type ExpectedAnswer,
  type VerifyResult,
} from "./signing.js";

export {
  NDA_CLAIM_TAG,
  DISCLOSURE_KINDS,
  FILING_PERIOD_DAYS,
  claimSignedBytes,
  claimDigest,
  claimProblems,
  claimSignedBy,
  nkeyOf,
  signedByKey,
  saltedAnchorHash,
  withinClaimWindow,
  amendmentKey,
  NDA_ANSWER_TAG,
  NDA_ACK_TAG,
  NDA_WITHDRAW_TAG,
  MAX_ANSWER_CHARS,
  ndaActBytes,
  UPHOLD_BASES,
  RESOLUTIONS,
  OPEN_PERIOD_DAYS,
  RECORD_PERIOD_DAYS,
  MIN_RECORD_PERIOD_DAYS,
  MIN_FILING_PERIOD_DAYS,
  resolutionRefusal,
  claimStanding,
  type DisclosureKind,
  type NdaClaim,
  type NdaAnswer,
  type NdaAck,
  type NdaWithdrawal,
  type UpholdBasis,
  type Resolution,
  type ClaimState,
} from "./nda-claims.js";

export { ndaRecord, filedCounts, type ClaimView, type NdaFiledCounts, type NdaRecord, type NdaRecordUpheld } from "./nda-record.js";

export {
  HEADS_TAG,
  COSIGN_TAG,
  WITNESSES_TAG,
  EMPTY,
  foldSubject,
  subjectKey,
  slotBody,
  slotDigest,
  slotsOf,
  smtRoot,
  smtProof,
  rootFromProof,
  commitmentHash,
  commitmentOf,
  signCommitment,
  verifiesUnder,
  erasuresDated,
  followsFrom,
  carriesForward,
  cosignedObject,
  cosign,
  witnessCosigns,
  cosignedByAll,
  witnessListHash,
  witnessChangeSigned,
  type Slot,
  type Head,
  type Tombstone,
  type Commitment,
  type CommitmentEnvelope,
  type Witness,
  type Cosignature,
  type WitnessChange,
} from "./heads.js";
