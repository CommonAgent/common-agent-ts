/**
 * The Agent Mandate document model (https://agentmandate.net, 0.8.0-draft):
 * charters (§5), mandates (§6), resolve acts (§13), and the two rules that
 * are the specification's whole point — an administrator signature never
 * carries an act of root authority (§5.3), and authority narrows going down
 * (§6 rule 3).
 *
 * Everything here is pure. It reads documents and returns verdicts; it holds
 * no database, opens no socket, and knows nothing about registry state. That
 * is deliberate: §6 says a chain is "verifiable offline by anyone holding the
 * documents", so the verifier a counterparty runs and the verifier the
 * registry runs have to be the same code with no ambient inputs. Registry
 * state (suspension, revocation) and the clock arrive as explicit optional
 * arguments, and their absence is honest rather than assumed.
 *
 * Signing follows the family convention (§4): the ASCII tag, one newline,
 * then the JCS (RFC 8785) canonical JSON of the document with `signatures`
 * removed. canonicalJSON and the signature check are the shared crypto
 * core's (../crypto/), through ./crypto.ts.
 *
 * Two rules this code once had to choose for itself are now the
 * specification's: identifiers are derived with `id` excluded along with
 * `signatures` (§4 rule 1), and a mandate that permits sub-delegation or
 * holds `nda` carries `holder.key` (§6 rule 2).
 */
import { canonicalJSON, verifyTagged } from "./crypto.js";
// Crockford base32, lowercase (§4): RFC 4648's alphabet excludes 0, 1, 8 and 9,
// and every identifier in the specification's example contains one of them.
import { crockford32, fromLooseBase64, sha256 } from "@common-agent/crypto";

export const CHARTER_TAG = "agent-charter-v1";
export const MANDATE_TAG = "agent-mandate-v1";
export const RESOLVE_TAG = "agent-mandate-resolve-v1";

export const CHARTER_SIG_PREFIX = `${CHARTER_TAG}\n`;
export const MANDATE_SIG_PREFIX = `${MANDATE_TAG}\n`;
export const RESOLVE_SIG_PREFIX = `${RESOLVE_TAG}\n`;

/** Ed25519 user nkey, public half. The same shape every other key in this
 *  deployment has; a charter that names something else names nothing. */
const NKEY_PUBLIC = /^U[A-Z2-7]{55}$/;
const ORG_ID = /^org_[0-9a-hjkmnp-tv-z]{16}$/;
const MANDATE_ID = /^mnd_[0-9a-hjkmnp-tv-z]{16}$/;
/** A domain, lowercase, at least one dot. No scheme, no path, no port: the
 *  charter binds to a host, and a value that carries anything else would make
 *  the well-known probe ambiguous. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const POWERS = ["form", "amend", "terminate", "award", "nda", "write"] as const;
export type MandatePower = (typeof POWERS)[number];

/**
 * The categories of Agent NDA §5.4, which `scope.nda_categories` may name
 * (§6 rule 8). Restated here rather than imported: a core uses no other
 * core's code, and the list is closed by the NDA specification, so a change
 * to it is a change to that standard's version and to this one's.
 */
export const NDA_CATEGORIES = ["solicitation", "agreement_terms", "relationship", "inputs", "deliverables", "own_material"] as const;
export type NdaCategory = (typeof NDA_CATEGORIES)[number];

export interface DocSignature {
  role: string;
  key: string;
  signed_at: string;
  sig: string;
}

export interface CharterDoc {
  charter: "v1";
  id: string;
  version: number;
  domain: string;
  name: string;
  legal?: { jurisdiction?: string; registration?: string; grade: "recorded" };
  root_authority: { keys: string[]; threshold: number; grade?: string };
  administrator?: { keys: string[] };
  created_at: string;
  signatures: DocSignature[];
  [k: string]: unknown;
}

export type MandateIssuer = { kind: "root" } | { kind: "mandate"; mandate: string };

export interface MandateDoc {
  mandate: "v1";
  id: string;
  version: number;
  organization: string;
  issuer: MandateIssuer;
  holder: { account: string; person: string; key?: string };
  powers: MandatePower[];
  ceiling?: { currency: string; per_engagement?: number; per_month?: number };
  scope?: { offerings?: string[]; resources?: string[]; nda_categories?: NdaCategory[]; note?: string };
  settlement?: { payer: "holder" | "organization" };
  sub_delegation?: { allowed: boolean; max_depth?: number };
  starts_at: string;
  expires_at: string;
  signatures: DocSignature[];
  [k: string]: unknown;
}

export interface ResolveActDoc {
  /** Exactly one of these names the subject. */
  mandate?: string;
  charter?: string;
  action: "revoke" | "suspend" | "restore";
  at: string;
  reason?: string;
  signatures: DocSignature[];
  [k: string]: unknown;
}

// ── canonical bytes and identifiers ──────────────────────────────

/** §4: the canonical JSON a signature covers, which is the document with
 *  `signatures` removed. */
export function signedBody(doc: Record<string, unknown>): string {
  const { signatures: _drop, ...body } = doc;
  return canonicalJSON(body);
}

/**
 * §4: `org_<crockford32(sha256(canonical bytes of version 1, minus id and
 * signatures))>`, sixteen characters.
 *
 * Only a minting implementation derives an identifier, once, when it mints
 * version 1 (§4, "Minting and re-derivation"). A reader, the registry
 * included, never refuses a document because its identifier does not
 * re-derive: documents minted under an earlier reading carry identifiers
 * that remain theirs. `idCheck` below is the diagnostic §4 allows.
 */
export function deriveId(prefix: "org" | "mnd", versionOneDoc: Record<string, unknown>): string {
  const { signatures: _s, id: _i, ...body } = versionOneDoc;
  return `${prefix}_${crockford32(sha256(canonicalJSON(body)), 16)}`;
}

/**
 * The diagnostic §4 permits: does this version-1 document's identifier equal
 * what its bytes derive? A mismatch is reported and never refused, because it
 * cannot tell a damaged document from one minted under an earlier revision,
 * and it is not a tamper check (the signature is).
 */
export function idCheck(prefix: "org" | "mnd", versionOneDoc: Record<string, unknown>): { derived: string; matches: boolean } {
  const derived = deriveId(prefix, versionOneDoc);
  return { derived, matches: derived === versionOneDoc.id };
}

/** Signature bytes as base64 or base64url, padded or not, both accepted. The
 *  family emits base64url; the specification's example prints padded base64.
 *  Characters outside the two alphabets are refused, not skipped. */
function decodeSig(sig: string): Uint8Array | null {
  const bytes = fromLooseBase64(sig);
  return bytes && bytes.length === 64 ? bytes : null;
}

/** One signature over a tagged canonical body. Untagged signatures are
 *  refused, which since protocol 0.3 is verifyTagged's only behavior; the
 *  explicit opt-out this call used to pass existed for the 0.2 dual-accept
 *  window, now closed. */
export function verifyDocSignature(prefix: string, body: string, s: DocSignature): boolean {
  const bytes = decodeSig(s?.sig);
  if (!bytes || typeof s.key !== "string") return false;
  return verifyTagged(s.key, prefix, body, bytes);
}

// ── shape validation ─────────────────────────────────────────────

export type Validation<T> = { ok: true; doc: T } | { ok: false; error: string };

function isIsoInstant(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function sigsOf(raw: unknown): DocSignature[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) return null;
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return null;
    const r = s as Record<string, unknown>;
    if (typeof r.key !== "string" || typeof r.sig !== "string" || typeof r.role !== "string") return null;
    if (!isIsoInstant(r.signed_at)) return null;
  }
  return raw as DocSignature[];
}

function keyList(raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) return null;
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string" || !NKEY_PUBLIC.test(k)) return null;
    if (out.includes(k)) return null;
    out.push(k);
  }
  return out;
}

export function validateCharter(raw: unknown): Validation<CharterDoc> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "A charter must be a JSON object." };
  }
  const d = raw as Record<string, unknown>;
  if (d.charter !== "v1") return { ok: false, error: 'A charter must carry "charter": "v1".' };
  if (typeof d.id !== "string" || !ORG_ID.test(d.id)) {
    return { ok: false, error: "A charter must carry an id of the form org_ followed by 16 base32 characters." };
  }
  if (typeof d.version !== "number" || !Number.isInteger(d.version) || d.version < 1) {
    return { ok: false, error: "A charter version must be a whole number of 1 or more." };
  }
  if (typeof d.domain !== "string" || !DOMAIN.test(d.domain)) {
    return { ok: false, error: "A charter must name a lowercase domain with no scheme, port or path." };
  }
  if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 200) {
    return { ok: false, error: "A charter must carry a name of 1 to 200 characters." };
  }
  const root = d.root_authority as Record<string, unknown> | undefined;
  if (typeof root !== "object" || root === null) {
    return { ok: false, error: "A charter must carry a root_authority block." };
  }
  const rootKeys = keyList(root.keys, 16);
  if (!rootKeys) {
    return { ok: false, error: "root_authority.keys must be 1 to 16 distinct public keys." };
  }
  if (typeof root.threshold !== "number" || !Number.isInteger(root.threshold) || root.threshold < 1) {
    return { ok: false, error: "root_authority.threshold must be a whole number of 1 or more." };
  }
  if (root.threshold > rootKeys.length) {
    return { ok: false, error: "root_authority.threshold is higher than the number of root keys, so no act could ever meet it." };
  }
  let adminKeys: string[] = [];
  if (d.administrator !== undefined) {
    const admin = d.administrator as Record<string, unknown>;
    if (typeof admin !== "object" || admin === null) {
      return { ok: false, error: "administrator must be an object naming keys, or be left out." };
    }
    const parsed = keyList(admin.keys, 16);
    if (!parsed) return { ok: false, error: "administrator.keys must be 1 to 16 distinct public keys." };
    adminKeys = parsed;
  }
  // §5.3 separates custody from authority. A key that is both is neither:
  // it would make "an administrator signature is never sufficient" impossible
  // to enforce by looking at the signature.
  const both = adminKeys.filter((k) => rootKeys.includes(k));
  if (both.length) {
    return {
      ok: false,
      error: "A key cannot be both a root authority key and an administrator key. Custody and authority are separate roles. Give the administrator its own key.",
    };
  }
  if (d.legal !== undefined) {
    const legal = d.legal as Record<string, unknown>;
    if (typeof legal !== "object" || legal === null) {
      return { ok: false, error: "legal must be an object, or be left out." };
    }
    // §5.4: the grade is not the filer's to choose. Anything else is a
    // document claiming more enforcement than the runtime delivers.
    if (legal.grade !== "recorded") {
      return { ok: false, error: 'legal.grade must be "recorded". No runtime verifies a legal identity, and a charter may not say otherwise.' };
    }
  }
  if (!isIsoInstant(d.created_at)) return { ok: false, error: "created_at must be an ISO 8601 timestamp." };
  const sigs = sigsOf(d.signatures);
  if (!sigs) return { ok: false, error: "A charter must carry 1 to 16 signatures, each with role, key, signed_at and sig." };
  return { ok: true, doc: { ...(d as object) } as CharterDoc };
}

export function validateMandate(raw: unknown): Validation<MandateDoc> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "A mandate must be a JSON object." };
  }
  const d = raw as Record<string, unknown>;
  if (d.mandate !== "v1") return { ok: false, error: 'A mandate must carry "mandate": "v1".' };
  if (typeof d.id !== "string" || !MANDATE_ID.test(d.id)) {
    return { ok: false, error: "A mandate must carry an id of the form mnd_ followed by 16 base32 characters." };
  }
  if (typeof d.version !== "number" || !Number.isInteger(d.version) || d.version < 1) {
    return { ok: false, error: "A mandate version must be a whole number of 1 or more." };
  }
  if (typeof d.organization !== "string" || !ORG_ID.test(d.organization)) {
    return { ok: false, error: "A mandate must name the organization it is issued under." };
  }
  const issuer = d.issuer as Record<string, unknown> | undefined;
  if (typeof issuer !== "object" || issuer === null) {
    return { ok: false, error: "A mandate must carry an issuer block." };
  }
  if (issuer.kind === "mandate") {
    if (typeof issuer.mandate !== "string" || !MANDATE_ID.test(issuer.mandate)) {
      return { ok: false, error: "An issuer of kind mandate must name the issuing mandate id." };
    }
  } else if (issuer.kind !== "root") {
    return { ok: false, error: 'issuer.kind must be "root" or "mandate".' };
  }
  const holder = d.holder as Record<string, unknown> | undefined;
  if (typeof holder !== "object" || holder === null) {
    return { ok: false, error: "A mandate must carry a holder block." };
  }
  if (typeof holder.account !== "string" || !holder.account.trim() || holder.account.length > 128) {
    return { ok: false, error: "holder.account must name the account the mandate authorizes." };
  }
  if (typeof holder.person !== "string" || !holder.person.trim() || holder.person.length > 256) {
    return { ok: false, error: "holder.person must name the person behind the account." };
  }
  if (holder.key !== undefined && (typeof holder.key !== "string" || !NKEY_PUBLIC.test(holder.key))) {
    return { ok: false, error: "holder.key, when present, must be a public key." };
  }
  if (!Array.isArray(d.powers) || d.powers.length === 0) {
    return { ok: false, error: "A mandate must list at least one power. A power not listed is not held." };
  }
  const powers: MandatePower[] = [];
  for (const p of d.powers) {
    if (typeof p !== "string" || !(POWERS as readonly string[]).includes(p)) {
      return { ok: false, error: `Unknown power ${JSON.stringify(p)}. The powers are form, amend, terminate, award, nda and write.` };
    }
    if (powers.includes(p as MandatePower)) return { ok: false, error: `The power ${p} is listed twice.` };
    powers.push(p as MandatePower);
  }
  if (d.ceiling !== undefined) {
    const c = d.ceiling as Record<string, unknown>;
    if (typeof c !== "object" || c === null) return { ok: false, error: "ceiling must be an object, or be left out." };
    if (typeof c.currency !== "string" || !/^[A-Z]{3,8}$/.test(c.currency)) {
      return { ok: false, error: "ceiling.currency must be a currency code of 3 to 8 capital letters." };
    }
    for (const field of ["per_engagement", "per_month"] as const) {
      const v = c[field];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return { ok: false, error: `ceiling.${field} must be a number of 0 or more.` };
      }
    }
    if (c.per_engagement === undefined && c.per_month === undefined) {
      return { ok: false, error: "A ceiling with neither per_engagement nor per_month bounds nothing. Give it one, or leave the ceiling out." };
    }
  }
  if (d.scope !== undefined) {
    const s = d.scope as Record<string, unknown>;
    if (typeof s !== "object" || s === null) return { ok: false, error: "scope must be an object, or be left out." };
    if (s.offerings !== undefined) {
      if (!Array.isArray(s.offerings) || s.offerings.some((o) => typeof o !== "string" || !o)) {
        return { ok: false, error: "scope.offerings must be a list of offering patterns." };
      }
    }
    // §6 rule 9: non-empty, each a resource name or a prefix with one
    // trailing *, none repeated.
    if (s.resources !== undefined) {
      const list = s.resources;
      if (!Array.isArray(list) || list.length === 0) {
        return { ok: false, error: "scope.resources, when present, must list at least one resource pattern. Leave it out to place no limit on resources." };
      }
      const seen = new Set<string>();
      for (const r of list) {
        if (!isResourcePattern(r)) {
          return { ok: false, error: `${JSON.stringify(r)} is not a resource pattern: a resource name, or a prefix followed by a single trailing *.` };
        }
        if (seen.has(r)) return { ok: false, error: `The resource pattern ${r} is listed twice.` };
        seen.add(r);
      }
    }
    // §6 rule 8: non-empty, only Agent NDA §5.4 categories, none repeated.
    if (s.nda_categories !== undefined) {
      const cats = s.nda_categories;
      if (!Array.isArray(cats) || cats.length === 0) {
        return { ok: false, error: "scope.nda_categories, when present, must list at least one Agent NDA category. Leave it out to place no limit on categories." };
      }
      const seen = new Set<string>();
      for (const c of cats) {
        if (typeof c !== "string" || !(NDA_CATEGORIES as readonly string[]).includes(c)) {
          return { ok: false, error: `Unknown Agent NDA category ${JSON.stringify(c)}. The categories are ${NDA_CATEGORIES.join(", ")}.` };
        }
        if (seen.has(c)) return { ok: false, error: `The Agent NDA category ${c} is listed twice.` };
        seen.add(c);
      }
    }
  }
  if (d.settlement !== undefined) {
    const s = d.settlement as Record<string, unknown>;
    if (typeof s !== "object" || s === null) return { ok: false, error: "settlement must be an object, or be left out." };
    if (s.payer !== "holder" && s.payer !== "organization") {
      return { ok: false, error: 'settlement.payer must be "holder" or "organization".' };
    }
  }
  if (d.sub_delegation !== undefined) {
    const s = d.sub_delegation as Record<string, unknown>;
    if (typeof s !== "object" || s === null) return { ok: false, error: "sub_delegation must be an object, or be left out." };
    if (typeof s.allowed !== "boolean") return { ok: false, error: "sub_delegation.allowed must be true or false." };
    if (s.allowed) {
      if (typeof s.max_depth !== "number" || !Number.isInteger(s.max_depth) || s.max_depth < 1 || s.max_depth > 8) {
        return { ok: false, error: "sub_delegation.max_depth must be a whole number from 1 to 8 when sub-delegation is allowed." };
      }
      // The spec's holder block names an account and a person, neither of
      // which is a key, so nothing in a mandate tells a verifier which key a
      // sub-mandate's issuer signature should be checked against. Requiring
      // the key exactly where sub-delegation is permitted keeps every chain
      // verifiable offline, which §6 promises, and asks for nothing anywhere
      // else.
      if (typeof holder.key !== "string") {
        return {
          ok: false,
          error: "A mandate that permits sub-delegation must carry holder.key. Without it no sub-mandate signed by this holder can be verified.",
        };
      }
    }
  }
  // §6 rule 2, since 0.6.0: an Agent NDA signature made under a mandate
  // that holds nda is checked against holder.key (§7.2 check 1), so the key
  // has to be there for anyone to check it.
  if (powers.includes("nda") && typeof holder.key !== "string") {
    return {
      ok: false,
      error: "A mandate that holds the nda power must carry holder.key. An Agent NDA signed under it is checked against that key.",
    };
  }
  if (!isIsoInstant(d.starts_at)) return { ok: false, error: "starts_at must be an ISO 8601 timestamp." };
  if (!isIsoInstant(d.expires_at)) return { ok: false, error: "expires_at must be an ISO 8601 timestamp." };
  if (Date.parse(d.expires_at as string) <= Date.parse(d.starts_at as string)) {
    return { ok: false, error: "expires_at must be later than starts_at." };
  }
  const sigs = sigsOf(d.signatures);
  if (!sigs) return { ok: false, error: "A mandate must carry 1 to 16 signatures, each with role, key, signed_at and sig." };
  return { ok: true, doc: { ...(d as object) } as MandateDoc };
}

export function validateResolveAct(raw: unknown): Validation<ResolveActDoc> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "A resolve act must be a JSON object." };
  }
  const d = raw as Record<string, unknown>;
  const named = [d.mandate, d.charter].filter((v) => v !== undefined);
  if (named.length !== 1) {
    return { ok: false, error: "A resolve act names exactly one subject: either mandate or charter." };
  }
  if (d.mandate !== undefined && (typeof d.mandate !== "string" || !MANDATE_ID.test(d.mandate))) {
    return { ok: false, error: "A resolve act on a mandate must name a mandate id." };
  }
  if (d.charter !== undefined && (typeof d.charter !== "string" || !ORG_ID.test(d.charter))) {
    return { ok: false, error: "A resolve act on a charter must name an organization id." };
  }
  if (d.action !== "revoke" && d.action !== "suspend" && d.action !== "restore") {
    return { ok: false, error: 'action must be "revoke", "suspend" or "restore".' };
  }
  if (d.mandate !== undefined && d.action !== "revoke") {
    return { ok: false, error: "A mandate is resolved by revoking it. Suspend and restore act on a charter." };
  }
  if (d.charter !== undefined && d.action === "revoke") {
    return { ok: false, error: "A charter is not revoked. Suspend it, or file an amendment at the next version." };
  }
  if (!isIsoInstant(d.at)) return { ok: false, error: "at must be an ISO 8601 timestamp." };
  const sigs = sigsOf(d.signatures);
  if (!sigs) return { ok: false, error: "A resolve act must carry 1 to 16 signatures, each with role, key, signed_at and sig." };
  return { ok: true, doc: { ...(d as object) } as ResolveActDoc };
}

// ── acts of root authority ───────────────────────────────────────

export type RootAuthorityVerdict =
  | { ok: true; signers: string[] }
  | { ok: false; reason: "administrator_only" | "threshold" | "unknown_signer" | "bad_signature"; error: string };

/**
 * §5.2 and §5.3, together: does this signed body carry an act of root
 * authority under this charter?
 *
 * The refusal that matters is `administrator_only`. An administrator files
 * the record and keeps the domain proof current; the signature never issues a
 * mandate, amends the charter, rotates a key or approves anything. Naming that
 * case separately is what turns a MUST in prose into an error message an
 * operator can act on, instead of a generic "not enough signatures" that reads
 * like a threshold problem and sends them looking for a second allocator.
 */
export function verifyRootAuthority(
  charter: CharterDoc,
  prefix: string,
  body: string,
  signatures: DocSignature[],
): RootAuthorityVerdict {
  const rootKeys = new Set(charter.root_authority.keys);
  const adminKeys = new Set(charter.administrator?.keys ?? []);
  const signers = new Set<string>();
  let sawAdmin = false;
  let sawStranger = false;
  let sawBad = false;

  for (const s of signatures) {
    const fromRoot = rootKeys.has(s.key);
    const fromAdmin = adminKeys.has(s.key);
    if (!fromRoot && !fromAdmin) {
      sawStranger = true;
      continue;
    }
    if (!verifyDocSignature(prefix, body, s)) {
      sawBad = true;
      continue;
    }
    if (fromAdmin) {
      sawAdmin = true;
      continue;
    }
    signers.add(s.key);
  }

  if (signers.size >= charter.root_authority.threshold) {
    return { ok: true, signers: [...signers] };
  }
  if (signers.size === 0 && sawAdmin) {
    return {
      ok: false,
      reason: "administrator_only",
      error:
        "This act is carried by administrator signatures alone. An administrator files and maintains the record and cannot issue a mandate, amend the charter, rotate a key or approve anything. Have an allocator holding a root authority key sign it.",
    };
  }
  if (signers.size === 0 && sawBad) {
    return {
      ok: false,
      reason: "bad_signature",
      error: "No root authority signature on this act verifies over its canonical bytes. Re-sign the document as it stands.",
    };
  }
  if (signers.size === 0 && sawStranger) {
    return {
      ok: false,
      reason: "unknown_signer",
      error: "This act is signed by a key the charter does not name as root authority. Only an allocator named in the charter can carry an act of root authority.",
    };
  }
  return {
    ok: false,
    reason: "threshold",
    error: `This act carries ${signers.size} valid root authority signature${signers.size === 1 ? "" : "s"} and the charter requires ${charter.root_authority.threshold}. Collect the remaining signatures and file it again.`,
  };
}

/** A charter's own signatures are an act of root authority over itself. */
export function verifyCharterSignatures(charter: CharterDoc): RootAuthorityVerdict {
  return verifyRootAuthority(charter, CHARTER_SIG_PREFIX, signedBody(charter), charter.signatures);
}

// ── the narrowing rule (§6.2) ────────────────────────────────────

export interface Narrowing {
  dimension: "organization" | "powers" | "ceiling" | "scope" | "term" | "depth" | "settlement";
  error: string;
}

/** Only a trailing `*` is understood as a wildcard. Anything else is read
 *  literally, which can refuse a legitimate narrowing but can never admit a
 *  widening, and refusing is the safe direction for a rule whose whole job is
 *  to stop authority growing. */
/** §6 rule 9: a resource name, or a prefix followed by a single trailing `*`, or `*` alone. */
export function isResourcePattern(p: unknown): p is string {
  return typeof p === "string" && /^(\*|[^*]+\*?)$/.test(p);
}

/**
 * §5 rule 6: `domain` is fixed for the life of a charter. Returns why an
 * amendment may not follow the charter on file, or null.
 */
export function charterAmendmentFailure(current: Pick<CharterDoc, "domain">, next: Pick<CharterDoc, "domain">): string | null {
  return next.domain === current.domain
    ? null
    : `A charter's domain is fixed for its life, and this amendment moves it from ${current.domain} to ${next.domain}. A new domain is a new charter: prepare one, which gives it its own identifier.`;
}

export function patternMatches(pattern: string, offering: string): boolean {
  if (pattern === offering) return true;
  if (pattern === "*") return true;
  const star = pattern.indexOf("*");
  if (star === -1 || star !== pattern.length - 1) return false;
  return offering.startsWith(pattern.slice(0, -1));
}

/** Does `outer` admit every offering `inner` admits? */
export function patternCovers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  if (outer === "*") return true;
  const star = outer.indexOf("*");
  if (star === -1 || star !== outer.length - 1) return false;
  return inner.startsWith(outer.slice(0, -1));
}

const payerOf = (m: MandateDoc): "holder" | "organization" => m.settlement?.payer ?? "holder";

/**
 * §6 rule 3: a sub-mandate MUST be at most as broad as its issuer's mandate in
 * every dimension. Returns the first dimension that widens, or null.
 *
 * The specification enumerates powers, ceilings, scope, expiry and depth. Two
 * more are checked here and reported separately so the addition is visible:
 * `starts_at` earlier than the issuer's (authority before the issuer held it,
 * which is a widening of the term the enumeration does not name), and the
 * settlement payer, which §6.5 states as its own MUST rather than as part of
 * the narrowing list.
 */
export function narrowingFailure(sub: MandateDoc, issuer: MandateDoc): Narrowing | null {
  if (sub.organization !== issuer.organization) {
    return {
      dimension: "organization",
      error: "A sub-mandate must name the same organization as the mandate that issues it.",
    };
  }

  const wider = sub.powers.filter((p) => !issuer.powers.includes(p));
  if (wider.length) {
    return {
      dimension: "powers",
      error: `The issuing mandate does not hold ${wider.join(", ")}, so it cannot pass ${wider.length === 1 ? "it" : "them"} down. Remove ${wider.length === 1 ? "that power" : "those powers"} from the sub-mandate.`,
    };
  }

  const ic = issuer.ceiling;
  const sc = sub.ceiling;
  if (ic) {
    if (!sc) {
      return {
        dimension: "ceiling",
        error: "The issuing mandate carries a ceiling and this sub-mandate carries none, which is no bound at all. Give the sub-mandate a ceiling at or below the issuer's.",
      };
    }
    if (sc.currency !== ic.currency) {
      return {
        dimension: "ceiling",
        error: `The issuing mandate's ceiling is in ${ic.currency} and this sub-mandate's is in ${sc.currency}. Two currencies cannot be compared, so the sub-mandate must use ${ic.currency}.`,
      };
    }
    for (const field of ["per_engagement", "per_month"] as const) {
      const limit = ic[field];
      if (limit === undefined) continue;
      const asked = sc[field];
      if (asked === undefined) {
        return {
          dimension: "ceiling",
          error: `The issuing mandate bounds ${field} at ${limit} ${ic.currency} and this sub-mandate leaves it unbounded. Set ${field} to ${limit} ${ic.currency} or less.`,
        };
      }
      if (asked > limit) {
        return {
          dimension: "ceiling",
          error: `This sub-mandate sets ${field} to ${asked} ${sc.currency} and the issuing mandate holds ${limit}. Authority narrows going down. Set it to ${limit} or less.`,
        };
      }
    }
  }

  const issuerScope = issuer.scope?.offerings;
  if (issuerScope && issuerScope.length) {
    const subScope = sub.scope?.offerings;
    if (!subScope || !subScope.length) {
      return {
        dimension: "scope",
        error: `The issuing mandate is scoped to ${issuerScope.join(", ")} and this sub-mandate names no scope, which is every offering. Name a scope inside the issuer's.`,
      };
    }
    const outside = subScope.filter((p) => !issuerScope.some((q) => patternCovers(q, p)));
    if (outside.length) {
      return {
        dimension: "scope",
        error: `The offering pattern${outside.length === 1 ? "" : "s"} ${outside.join(", ")} fall outside the issuing mandate's scope of ${issuerScope.join(", ")}. Narrow the sub-mandate's scope.`,
      };
    }
  }

  // §6 rule 3, for rule 8's list: where the issuer carries one, the
  // sub-mandate carries one too and stays inside it. Where the issuer carries
  // none, the sub-mandate may narrow by carrying one.
  // The same for rule 9's resources: where the issuer carries a list, the
  // sub-mandate carries one, and each of its patterns is covered by one of
  // the issuer's.
  const issuerResources = issuer.scope?.resources;
  if (issuerResources && issuerResources.length) {
    const subResources = sub.scope?.resources;
    if (!subResources || !subResources.length) {
      return {
        dimension: "scope",
        error: `The issuing mandate limits writes to the resources ${issuerResources.join(", ")} and this sub-mandate names no list, which is every resource. Give it scope.resources inside the issuer's.`,
      };
    }
    const wider = subResources.filter((p) => !issuerResources.some((q) => patternCovers(q, p)));
    if (wider.length) {
      return {
        dimension: "scope",
        error: `The resource ${wider.length === 1 ? "pattern" : "patterns"} ${wider.join(", ")} ${wider.length === 1 ? "is" : "are"} not covered by the issuing mandate's list of ${issuerResources.join(", ")}. Narrow the sub-mandate's scope.resources.`,
      };
    }
  }

  const issuerCats = issuer.scope?.nda_categories;
  if (issuerCats && issuerCats.length) {
    const subCats = sub.scope?.nda_categories;
    if (!subCats || !subCats.length) {
      return {
        dimension: "scope",
        error: `The issuing mandate limits Agent NDAs to ${issuerCats.join(", ")} and this sub-mandate names no list, which is every category. Give it scope.nda_categories inside the issuer's.`,
      };
    }
    const outsideCats = subCats.filter((c) => !issuerCats.includes(c));
    if (outsideCats.length) {
      return {
        dimension: "scope",
        error: `The Agent NDA ${outsideCats.length === 1 ? "category" : "categories"} ${outsideCats.join(", ")} ${outsideCats.length === 1 ? "falls" : "fall"} outside the issuing mandate's list of ${issuerCats.join(", ")}. Narrow the sub-mandate's scope.nda_categories.`,
      };
    }
  }

  if (Date.parse(sub.expires_at) > Date.parse(issuer.expires_at)) {
    return {
      dimension: "term",
      error: `This sub-mandate expires ${sub.expires_at} and the issuing mandate expires ${issuer.expires_at}. A sub-mandate cannot outlive the authority it comes from.`,
    };
  }
  if (Date.parse(sub.starts_at) < Date.parse(issuer.starts_at)) {
    return {
      dimension: "term",
      error: `This sub-mandate starts ${sub.starts_at} and the issuing mandate starts ${issuer.starts_at}. A sub-mandate cannot begin before the authority it comes from.`,
    };
  }

  const sd = issuer.sub_delegation;
  if (!sd?.allowed) {
    return {
      dimension: "depth",
      error: "The issuing mandate does not permit sub-delegation, so it cannot issue this mandate.",
    };
  }
  // The issuer's max_depth counts levels BELOW the issuer. This document
  // spends one of them; whatever is left is all the sub-mandate may pass on.
  const remaining = (sd.max_depth ?? 0) - 1;
  if (remaining < 0) {
    return {
      dimension: "depth",
      error: "The issuing mandate's sub-delegation depth is already spent, so it cannot issue this mandate.",
    };
  }
  if (sub.sub_delegation?.allowed) {
    if (remaining < 1) {
      return {
        dimension: "depth",
        error: `The issuing mandate permits sub-delegation ${sd.max_depth} level${sd.max_depth === 1 ? "" : "s"} deep, and this mandate spends the last of it. Set sub_delegation.allowed to false.`,
      };
    }
    const asked = sub.sub_delegation.max_depth ?? 0;
    if (asked > remaining) {
      return {
        dimension: "depth",
        error: `This sub-mandate asks to delegate ${asked} level${asked === 1 ? "" : "s"} further and only ${remaining} remain${remaining === 1 ? "s" : ""} under the issuing mandate. Set max_depth to ${remaining} or less.`,
      };
    }
  }

  if (payerOf(sub) === "organization" && payerOf(issuer) !== "organization") {
    return {
      dimension: "settlement",
      error: "This sub-mandate names the organization as payer and the issuing mandate does not. A draw on the treasury cannot be granted by someone who does not hold it.",
    };
  }

  return null;
}

// ── chain verification (§6, §7.2) ────────────────────────────────

export interface ChainInput {
  charter: CharterDoc;
  /** The target mandate first, its issuer next, the root-issued one last. */
  mandates: MandateDoc[];
}

export interface ChainOptions {
  /** Milliseconds. Omit to verify the documents alone, with no clock. */
  now?: number;
  /** Registry state. Absent means the caller is verifying offline and is
   *  saying so, rather than being told the charter is fine. */
  charterState?: "active" | "suspended";
  /** Mandate ids the registry has recorded as revoked. */
  revoked?: ReadonlySet<string>;
}

export type ChainCheck =
  | "charter_signatures"
  | "charter_suspended"
  | "organization"
  | "chain_order"
  | "issuer_signature"
  | "root_signature"
  | "narrowing"
  | "revoked"
  | "term";

export type ChainVerdict =
  | { ok: true; depth: number; mandates: string[] }
  | { ok: false; check: ChainCheck; error: string; mandate?: string };

/**
 * A mandate plus the mandates above it, up to root authority (§2). Every hop
 * is a signature over canonical bytes, so this runs the same either side of
 * the network: the registry calls it holding its own records, and a
 * counterparty calls it holding nothing but the documents it was handed.
 */
export function verifyMandateChain(input: ChainInput, opts: ChainOptions = {}): ChainVerdict {
  const { charter, mandates } = input;

  const charterSigs = verifyCharterSignatures(charter);
  if (!charterSigs.ok) {
    return { ok: false, check: "charter_signatures", error: charterSigs.error };
  }
  if (opts.charterState === "suspended") {
    return {
      ok: false,
      check: "charter_suspended",
      error: `The charter for ${charter.id} is suspended because its domain proof on ${charter.domain} could not be found. Restore the proof and the chain verifies again.`,
    };
  }
  if (!mandates.length) {
    return { ok: false, check: "chain_order", error: "A chain needs at least one mandate." };
  }

  for (const m of mandates) {
    if (m.organization !== charter.id) {
      return {
        ok: false,
        check: "organization",
        mandate: m.id,
        error: `Mandate ${m.id} names organization ${m.organization} and this chain is anchored to ${charter.id}.`,
      };
    }
    if (opts.revoked?.has(m.id)) {
      return {
        ok: false,
        check: "revoked",
        mandate: m.id,
        error: m.id === mandates[0].id
          ? `Mandate ${m.id} is revoked.`
          : `Mandate ${m.id}, which this chain passes through, is revoked. Revoking a mandate revokes every mandate issued under it.`,
      };
    }
    if (opts.now !== undefined) {
      if (opts.now < Date.parse(m.starts_at)) {
        return {
          ok: false,
          check: "term",
          mandate: m.id,
          error: `Mandate ${m.id} has no force before ${m.starts_at}.`,
        };
      }
      if (opts.now >= Date.parse(m.expires_at)) {
        return {
          ok: false,
          check: "term",
          mandate: m.id,
          error: `Mandate ${m.id} expired on ${m.expires_at}. A renewal is a fresh signature.`,
        };
      }
    }
  }

  for (let i = 0; i < mandates.length; i++) {
    const m = mandates[i];
    const body = signedBody(m);
    const above = mandates[i + 1];

    if (m.issuer.kind === "root") {
      if (above) {
        return {
          ok: false,
          check: "chain_order",
          mandate: m.id,
          error: `Mandate ${m.id} is issued by root authority, so nothing stands above it in the chain.`,
        };
      }
      const verdict = verifyRootAuthority(charter, MANDATE_SIG_PREFIX, body, m.signatures);
      if (!verdict.ok) {
        return { ok: false, check: "root_signature", mandate: m.id, error: verdict.error };
      }
      continue;
    }

    if (!above) {
      return {
        ok: false,
        check: "chain_order",
        mandate: m.id,
        error: `Mandate ${m.id} is issued under ${m.issuer.mandate}, which is missing from this chain.`,
      };
    }
    if (above.id !== m.issuer.mandate) {
      return {
        ok: false,
        check: "chain_order",
        mandate: m.id,
        error: `Mandate ${m.id} is issued under ${m.issuer.mandate} and the next document in this chain is ${above.id}.`,
      };
    }
    const issuerKey = above.holder.key;
    if (!issuerKey) {
      return {
        ok: false,
        check: "issuer_signature",
        mandate: m.id,
        error: `Mandate ${above.id} carries no holder.key, so a signature by its holder cannot be checked.`,
      };
    }
    const signed = m.signatures.some((s) => s.key === issuerKey && verifyDocSignature(MANDATE_SIG_PREFIX, body, s));
    if (!signed) {
      return {
        ok: false,
        check: "issuer_signature",
        mandate: m.id,
        error: `No signature on mandate ${m.id} verifies against the holder of ${above.id}, which is the mandate that issued it.`,
      };
    }
    const widened = narrowingFailure(m, above);
    if (widened) {
      return {
        ok: false,
        check: "narrowing",
        mandate: m.id,
        error: `Mandate ${m.id} widens its issuer in ${widened.dimension}. ${widened.error}`,
      };
    }
  }

  return { ok: true, depth: mandates.length - 1, mandates: mandates.map((m) => m.id) };
}
