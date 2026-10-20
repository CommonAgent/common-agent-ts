/**
 * Confidentiality and retention (§5.11): the split clause, its processors,
 * and the shortfall of a clause against a requirement.
 *
 * Ported from the TypeScript SDK's sow.ts (agent-messaging-server at
 * a941404a4a29, main, 2026-10-18), which
 * the Rust SDK mirrors and the conformance files pin; the refusals are
 * SowRefusal (shared.ts) instead of the SDK's MeshError.
 */
import { invalidIn, isPosInt } from "./shared.js";

const invalid: (message: string) => never = invalidIn("5.11");

// ── §5.11: confidentiality and retention ────────────────────────────────────

/**
 * The closed promise vocabulary (§5.11), and the only spelling a promise has:
 * presence, as the literal `true`. Absence carries the weak meaning
 * throughout — a promise left out is a promise not made, and a reader MUST
 * NOT infer it. There is no `false`: it is spelled by omission.
 */
export type SowConfidentialityPromise =
  | "no_training"
  | "no_third_party_sharing"
  | "no_human_reading";

export const SOW_CONFIDENTIALITY_PROMISES: readonly SowConfidentialityPromise[] = [
  "no_training",
  "no_third_party_sharing",
  "no_human_reading",
];

/** One service a client's content passes through so the work can happen
 *  (§5.11): the model API behind the agent, a transcription service, any host
 *  that can read what it holds. `service` is the one REQUIRED member — the
 *  client is owed the name so it can go read that service's terms. `domain`
 *  says which service of that name is meant; `purpose` is the narrowest true
 *  statement of what it is used for. Declaring a processor is neither
 *  endorsement nor a transfer of obligation. */
export interface SowProcessor {
  service: string;
  domain?: string;
  purpose?: string;
  /** Where this processor processes the content (0.20.0-draft). Where both it and the clause's are stated, it is a subset of the clause's. */
  processed_in?: string[];
}

/** A data processing agreement attached as a named addendum (0.17.0-draft): its exact bytes committed by digest. Its contents are graded `recorded`. */
export interface SowDpa {
  digest: string;
  ref?: string;
  title?: string;
}

/** The promises a provider makes about what happens inside its own walls
 *  (§5.11). Only `true` is ever stored: a promise left out is a promise not
 *  made — `false` is not a value, it is omission. `no_third_party_sharing`
 *  quantifies over everything EXCEPT the declared processors: it is the
 *  promise that content goes nowhere beyond that list, not the fiction that
 *  it goes nowhere at all. */
export interface SowConfidentialityPromises {
  no_training?: true;
  no_third_party_sharing?: true;
  no_human_reading?: true;
}

/**
 * The canonical split clause (§5.11). Sub-clauses are graded separately and
 * MUST NOT be merged: sealed transport and retention windows are
 * runtime-checkable and graded `enforced`; what a party does with data inside
 * its own walls is checkable by nobody, so the promises are `recorded`, and a
 * conforming renderer MUST NOT present them as enforced.
 *
 * Absence carries the weak meaning throughout. An EMPTY `processors` list is
 * itself a statement — content leaves the provider for nowhere — while
 * omitting the member entirely states nothing, and a reader MUST NOT mistake
 * silence for either answer. Shapes pinned by `conformance/sow-data-use.json`.
 */
export interface SowConfidentiality {
  transport?: { sealed: boolean; grade: "enforced" };
  retention?: { max_days: number; grade: "enforced" };
  processors?: SowProcessor[];
  promises?: SowConfidentialityPromises & { grade: "recorded" };
  /** The jurisdictions the content may be processed in, in tokens the parties agree. */
  processed_in?: string[];
  dpa?: SowDpa;
}

/**
 * What a client requires of a counterparty's confidentiality clause — the
 * requirement side of §5.11's pre-admission shadow, compared by
 * {@link confidentialityShortfall}. Every required promise must be declared,
 * and a declared retention window must be no longer than the required
 * ceiling.
 *
 * Processor ACCEPTABILITY is deliberately not here in v1: which processors a
 * client will tolerate is a policy question with its own machinery, and
 * tracker #145 owns it. The list is still validated and still signed — it is
 * only the comparison that does not read it yet.
 */
export interface SowConfidentialityRequirement {
  promises?: SowConfidentialityPromise[];
  retention_max_days?: number;
  /**
   * The jurisdictions content may be processed in. The document's declared
   * `processed_in` must be stated and a subset of this list: the same test
   * §5.15 applies going down a subcontract chain, applied here between a
   * requirement and the document answering it, and for the same reason.
   * Silence fails rather than passing, because an unstated jurisdiction may
   * be any jurisdiction.
   *
   * An EMPTY list asks nothing, exactly as an empty `promises` list does. A
   * requirement allowing no jurisdiction at all would forbid the work rather
   * than confine it, and is not a thing anybody means.
   */
  processed_in?: string[];
}

/** Backstops, not policy. A clause naming dozens of processors is a data-flow
 *  inventory wearing a clause's clothes. */
const CONFIDENTIALITY_PROCESSORS_MAX = 16;
const PROCESSOR_SERVICE_MAX = 120;
const PROCESSOR_DOMAIN_MAX = 120;
const PROCESSOR_PURPOSE_MAX = 300;

export function validateSowConfidentiality(v: unknown): asserts v is SowConfidentiality {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid(
      "a confidentiality clause is an object of separately graded sub-clauses — transport, retention, processors, promises (§5.11)",
    );
  }
  const c = v as Record<string, unknown>;
  if (c.transport !== undefined) {
    if (typeof c.transport !== "object" || c.transport === null || Array.isArray(c.transport)) {
      invalid("transport is an object carrying sealed and grade (§5.11)");
    }
    const t = c.transport as Record<string, unknown>;
    if (typeof t.sealed !== "boolean") {
      invalid("transport.sealed is a boolean: the channel either is sealed or it is not (§5.11)");
    }
    if (t.grade !== "enforced") {
      invalid(
        "transport is graded 'enforced': whether the channel is sealed is runtime-checkable, and a clause claiming less understates what ships (§5.11, §4.2)",
      );
    }
  }
  if (c.retention !== undefined) {
    if (typeof c.retention !== "object" || c.retention === null || Array.isArray(c.retention)) {
      invalid("retention is an object carrying max_days and grade (§5.11)");
    }
    const r = c.retention as Record<string, unknown>;
    if (!isPosInt(r.max_days)) {
      invalid(
        "retention.max_days is a positive whole number of days; a fractional ceiling invites two implementations to round differently (§5.11)",
      );
    }
    if (r.grade !== "enforced") {
      invalid(
        "retention is graded 'enforced': a retention window is runtime-checkable, and a clause claiming less understates what ships (§5.11, §4.2)",
      );
    }
  }
  if (c.processors !== undefined) {
    if (!Array.isArray(c.processors)) {
      invalid(
        "processors is a list of the services content passes through, even with one entry — and an empty list is itself a statement: content leaves the provider for nowhere (§5.11)",
      );
    }
    // NO minimum: [] is valid and meaningful (§5.11's absence paragraph —
    // empty states "nowhere", omission states nothing). This deliberately
    // differs from additions/rests_on, where empty is a second spelling of
    // omission and refused for it.
    if (c.processors.length > CONFIDENTIALITY_PROCESSORS_MAX) {
      invalid(
        `a confidentiality clause names at most ${CONFIDENTIALITY_PROCESSORS_MAX} processors; a clause naming dozens is a data-flow inventory wearing a clause's clothes (§5.11)`,
      );
    }
    const seen = new Set<string>();
    for (const p of c.processors) {
      if (typeof p !== "object" || p === null || Array.isArray(p)) {
        invalid("each processor is an object carrying service, and optionally domain and purpose (§5.11)");
      }
      const pr = p as Record<string, unknown>;
      if (typeof pr.service !== "string" || !pr.service.trim() || pr.service.length > PROCESSOR_SERVICE_MAX) {
        invalid(
          `a processor's service is the one required member — the client is owed the name so it can go read that service's terms — up to ${PROCESSOR_SERVICE_MAX} characters, and not blank (§5.11)`,
        );
      }
      if (
        pr.domain !== undefined &&
        (typeof pr.domain !== "string" || !pr.domain.trim() || pr.domain.length > PROCESSOR_DOMAIN_MAX)
      ) {
        invalid(
          `a processor's domain says which service of that name is meant, up to ${PROCESSOR_DOMAIN_MAX} characters, and not blank (§5.11)`,
        );
      }
      if (
        pr.purpose !== undefined &&
        (typeof pr.purpose !== "string" || !pr.purpose.trim() || pr.purpose.length > PROCESSOR_PURPOSE_MAX)
      ) {
        invalid(
          `a processor's purpose is the narrowest true statement of what it is used for, up to ${PROCESSOR_PURPOSE_MAX} characters, and not blank (§5.11)`,
        );
      }
      const key = `${pr.service}\n${typeof pr.domain === "string" ? pr.domain : ""}`;
      if (seen.has(key)) {
        invalid(
          "the same service and domain pair twice states nothing new; a reader cannot tell whether the second entry is a mistake or a different service (§5.11)",
        );
      }
      seen.add(key);
    }
  }
  if (c.promises !== undefined) {
    if (typeof c.promises !== "object" || c.promises === null || Array.isArray(c.promises)) {
      invalid("promises is an object of the promises made, each spelled as the literal true, plus its grade (§5.11)");
    }
    const p = c.promises as Record<string, unknown>;
    for (const name of SOW_CONFIDENTIALITY_PROMISES) {
      if (p[name] !== undefined && p[name] !== true) {
        invalid(
          `a promise is spelled by presence: ${name} is either the literal true or absent — false is not a value, it is spelled by omission, because a promise left out is a promise not made (§5.11)`,
        );
      }
    }
    if (p.grade !== "recorded") {
      invalid(
        "promises are graded 'recorded': what a party does with data inside its own walls is checkable by nobody, and a conforming renderer MUST NOT present these as enforced (§5.11, §4.2)",
      );
    }
  }
  // A processor's own jurisdictions sit inside the clause's, where both are
  // stated: a provider cannot promise content stays in one place and name, in
  // the same clause, a service that takes it somewhere else (0.20.0-draft).
  const clauseIn = statedJurisdictions(c);
  if (clauseIn !== null && Array.isArray(c.processors)) {
    for (const p of c.processors as Array<Record<string, unknown>>) {
      const own = statedJurisdictions(p);
      if (own === null) continue;
      const outside = own.find((j) => !clauseIn.includes(j));
      if (outside !== undefined) {
        invalid(
          `the processor '${String(p.service)}' processes in '${outside}', which the clause's processed_in does not name; a processor's jurisdictions are a subset of the clause's (§5.11)`,
        );
      }
    }
  }
  if (c.dpa !== undefined) {
    const d = c.dpa as Record<string, unknown> | null;
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      invalid("dpa is an object carrying digest, and optionally ref and title (§5.11)");
    }
    if (typeof d.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(d.digest)) {
      invalid("dpa.digest is REQUIRED, spelled sha256: and 64 lowercase hex characters over the addendum's bytes, and compared exactly (§5.11)");
    }
    if (d.ref !== undefined && (typeof d.ref !== "string" || !d.ref.trim())) invalid("dpa.ref, where present, is a locator and not blank (§5.11)");
    if (d.title !== undefined && (typeof d.title !== "string" || !d.title.trim() || d.title.length > 200)) {
      invalid("dpa.title, where present, is for the reader, up to 200 characters and not blank (§5.11)");
    }
  }
}

/** The clause a document declares, unvalidated, or null where it declares
 *  none. Same contract as {@link reportingOf}. */
export function confidentialityOf(doc: unknown): SowConfidentiality | null {
  if (typeof doc !== "object" || doc === null) return null;
  const c = (doc as { confidentiality?: unknown }).confidentiality;
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as SowConfidentiality) : null;
}

/**
 * The deterministic comparison §5.11's pre-admission shadow rests on: does
 * this document meet `required`? Null where it meets — including a retention
 * ceiling met exactly, because the test is a ceiling, and including any
 * document at all against an empty requirement, which asks nothing.
 *
 * A shortfall is a SENTENCE, not a refusal — same contract as
 * {@link reportingShortfall}, and the wording is pinned by the fixture for
 * the same reason: a client reads one message whichever SDK evaluated it.
 * Three facts get three kinds of sentence — declared nothing, declared
 * something unreadable, and declared less than was required — checked in that
 * order, with required promises compared in the REQUIREMENT'S declared order
 * (the first missing one is reported), then retention, then jurisdictions.
 *
 * The jurisdiction test is §5.15's, applied between a requirement and the
 * document answering it rather than between a prime and its subcontract: the
 * declared set must be stated and a subset of the required one, and silence
 * fails because an unstated jurisdiction may be any jurisdiction. It reads
 * `processed_in` as declared structure, which is the posture
 * `subcontractConformance` already takes and the reason there is one
 * implementation of this rule rather than two.
 *
 * Unlike reporting, absence here is NOT a level that meets a floor: a
 * document declaring no clause against a requirement that states terms is
 * counted as not meeting rather than read charitably — silence is not an
 * answer (§5.11).
 *
 * Processor acceptability is deliberately not compared in v1 — tracker #145
 * owns it. See {@link SowConfidentialityRequirement}.
 */
export function confidentialityShortfall(
  required: SowConfidentialityRequirement,
  doc: unknown,
): string | null {
  const wantedPromises = required.promises ?? [];
  const wantedIn = required.processed_in ?? [];
  const wantsAnything =
    wantedPromises.length > 0 || required.retention_max_days !== undefined || wantedIn.length > 0;
  if (!wantsAnything) return null;
  const raw =
    typeof doc === "object" && doc !== null ? (doc as { confidentiality?: unknown }).confidentiality : undefined;
  if (raw === undefined || raw === null) {
    return (
      "the requirement states confidentiality terms and this document declares none; " +
      "silence is not an answer, and it is counted as not meeting rather than read charitably (§5.11)"
    );
  }
  try {
    validateSowConfidentiality(raw);
  } catch {
    return (
      "the requirement states confidentiality terms and this document's confidentiality clause is in a shape that cannot be read, " +
      "so what it promises cannot be established; it is counted as not meeting rather than passed unread (§5.11)"
    );
  }
  const clause = raw as SowConfidentiality;
  for (const name of wantedPromises) {
    if (clause.promises?.[name] !== true) {
      return `the requirement includes the promise ${name} and this document does not make it; a promise left out is a promise not made (§5.11)`;
    }
  }
  if (required.retention_max_days !== undefined) {
    const n = required.retention_max_days;
    if (clause.retention === undefined) {
      return `the requirement caps retention at ${n} days and this document states no retention ceiling; an unstated ceiling does not meet a stated one (§5.11)`;
    }
    const m = clause.retention.max_days;
    if (m > n) {
      return `the requirement caps retention at ${n} days and this document keeps content up to ${m} days; the test is a ceiling, and it is not met (§5.11)`;
    }
  }
  if (wantedIn.length > 0) {
    const list = wantedIn.join(", ");
    const declared = statedJurisdictions(raw as Record<string, unknown>);
    if (declared === null) {
      return `the requirement confines processing to ${list} and this document states no jurisdictions; an unstated jurisdiction may be any jurisdiction, and it is counted as not meeting rather than read charitably (§5.11)`;
    }
    const allowed = new Set(wantedIn);
    for (const j of declared) {
      if (!allowed.has(j)) {
        return `the requirement confines processing to ${list} and this document processes in ${j}; a party may touch no jurisdiction the requirement allowed (§5.11)`;
      }
    }
  }
  return null;
}

/** The jurisdictions a confidentiality clause states content is processed in, or null when it states none in a readable form. */
export function statedJurisdictions(clause: Record<string, unknown> | null): string[] | null {
  const j = clause?.processed_in;
  if (!Array.isArray(j)) return null;
  if (!j.every((v): v is string => typeof v === "string" && v.trim() !== "")) return null;
  return j;
}
