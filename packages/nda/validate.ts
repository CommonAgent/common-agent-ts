/**
 * Document validation for Agent NDA 0.2.0-draft: the refusals of §11 and the
 * shape rules of §4 and §5 they rest on.
 *
 * A failure is typed. The codes are the ones the conformance fixture
 * (`nda-grading.json`) names, so a caller and the vectors read the same
 * words:
 *
 *   false_enforcement     a clause graded `enforced` (§3, §11 rule 1)
 *   wrong_grade           any other grade the table of §11 does not fix
 *   closed_list           a token outside a closed list, a repeat, or an
 *                         empty `categories` (§11 rules 2 and 3, and 8 for
 *                         `at_end.action`)
 *   members               a multilateral agreement's seats (§11 rule 4)
 *   signatures            a signature record that names no seat, or the
 *                         wrong one, for its role, carries a member §6 does
 *                         not define, has no digest, `over` where it may not
 *                         be, or a sig in any spelling but the canonical
 *                         one (§6, §11 rules 4 and 12)
 *   offer                 an open offer's rules (§6.1, §11 rules 5 and 6)
 *   require_subset        a declaration outside `disclosure.require` (§5.5)
 *   processor_subset      a processor outside its party's jurisdictions
 *                         (Agent SoW §5.11)
 *   positive_whole_number survival.days or at_end.within_days (§11 rule 8)
 *   instants              ends_at before a non-null effective_at (§11 rule 9)
 *   mandate               an organization's seat signed with no mandate
 *                         (§6.2, §11 rule 10)
 *   owner_key             a seat without an organization and without an
 *                         owner_key, or one with an organization that
 *                         carries one (§5.1, §11 rule 11)
 *   shape                 a REQUIRED member missing or of the wrong type
 *                         (§4.2), which §11 takes as read
 *
 * Validation reads declared structure only. Whether a signature verifies, an
 * acceptance holds, or a party is bound are separate questions with their own
 * functions (signatures.ts, records.ts, references.ts), because a document can be well formed
 * and unsigned.
 */
import { DIGEST, PUBLIC_KEY, SIG_SPELLING } from "./crypto.js";
import { RECORD_MEMBERS } from "./records.js";
import {
  ACTIVITIES,
  AT_END_ACTIONS,
  CATEGORIES,
  DIRECTIONS,
  EXCLUSIONS,
  FIXED_GRADES,
  NDA_ID,
  NEED_TO_KNOW,
  SUBCONTRACTORS,
  type Agreement,
  type Seat,
  type SignatureRecord,
} from "./types.js";

export type ValidationCode =
  | "false_enforcement"
  | "wrong_grade"
  | "closed_list"
  | "members"
  | "signatures"
  | "offer"
  | "require_subset"
  | "processor_subset"
  | "positive_whole_number"
  | "instants"
  | "mandate"
  | "owner_key"
  | "shape";

export interface ValidationError {
  code: ValidationCode;
  /** Where in the document, in dotted form (`disclosure.recipient.processed_in`). */
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; agreement: Agreement } | { ok: false; errors: ValidationError[] };

/** §3, said once so every caller that reports it says the same thing. */
export const FALSE_ENFORCEMENT_MESSAGE =
  "an Agent NDA clause cannot be enforced: no runtime can refuse a recipient's private use of what it holds (Agent NDA 3)";

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_MEMBERS = 16;
const MIN_MEMBERS = 3;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isInstant(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
}

function isPositiveWhole(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Agent SoW §5.11's reading of a jurisdiction list, which §5.5 adopts: a list
 * whose entries are all non-empty strings has stated jurisdictions, and
 * anything else, absence included, has stated none.
 */
export function statedJurisdictions(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) return null;
  return v as string[];
}

/**
 * Validate an agreement. Every refusal found is returned, in document order,
 * so a form can show them all at once.
 */
export function validateAgreement(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const fail = (code: ValidationCode, path: string, message: string) => errors.push({ code, path, message });

  if (!isObj(raw)) return { ok: false, errors: [{ code: "shape", path: "", message: "an agreement is a JSON object" }] };
  const doc = raw;

  // ── §4.2 top level ──
  if (doc.nda !== "v1") fail("shape", "nda", "nda must be \"v1\"");
  if (typeof doc.id !== "string" || !NDA_ID.test(doc.id)) fail("shape", "id", "id must be nda_ and 16 lowercase Crockford base32 characters");
  if (!isPositiveWhole(doc.version)) fail("shape", "version", "version is a whole number from 1");
  const lang = doc.language;
  if (!isObj(lang) || typeof lang.id !== "string" || !lang.id || !isPositiveWhole(lang.version) || typeof lang.sha256 !== "string" || !HEX64.test(lang.sha256)) {
    fail("shape", "language", "language names a template by id, version and the lowercase hex sha256 of its text (4.3)");
  }
  if (!isInstant(doc.ends_at)) fail("shape", "ends_at", "ends_at is a REQUIRED instant");
  if (doc.effective_at !== undefined && doc.effective_at !== null && !isInstant(doc.effective_at)) {
    fail("shape", "effective_at", "effective_at is an instant or null");
  }
  if (!Array.isArray(doc.signatures)) fail("shape", "signatures", "signatures is a REQUIRED list");

  // ── §11 rule 1: grades ──
  for (const [clause, grade] of Object.entries(FIXED_GRADES)) {
    const c = doc[clause];
    if (c === undefined) continue;
    if (!isObj(c)) {
      fail("shape", clause, `${clause} is an object`);
      continue;
    }
    if (c.grade === "enforced") fail("false_enforcement", `${clause}.grade`, FALSE_ENFORCEMENT_MESSAGE);
    else if (c.grade !== grade) fail("wrong_grade", `${clause}.grade`, `${clause} is graded ${grade} (11)`);
  }
  for (const req of ["parties", "purpose", "covers"] as const) {
    if (doc[req] === undefined) fail("shape", req, `${req} is REQUIRED`);
  }

  // ── §11 rule 3: direction ──
  const direction = doc.direction;
  if (!(DIRECTIONS as readonly unknown[]).includes(direction)) fail("closed_list", "direction", "direction is one_way, mutual or multilateral");

  // ── §5.3 purpose, §5.4 covers, §5.6 exclusions: closed lists ──
  const purpose = doc.purpose;
  if (isObj(purpose)) {
    if (typeof purpose.statement !== "string" || !purpose.statement.trim()) fail("shape", "purpose.statement", "the purpose statement is REQUIRED");
    if (purpose.activities !== undefined) closedList(purpose.activities, ACTIVITIES, "purpose.activities", false, fail);
    if (purpose.named !== undefined && (!Array.isArray(purpose.named) || !purpose.named.every(isObj))) {
      fail("shape", "purpose.named", "named lists documents by identifier");
    }
  }
  const covers = doc.covers;
  if (isObj(covers)) closedList(covers.categories, CATEGORIES, "covers.categories", true, fail);
  const exclusions = doc.exclusions;
  if (isObj(exclusions)) closedList(exclusions.allowed, EXCLUSIONS, "exclusions.allowed", false, fail);

  // ── §5.1 parties and §11 rule 4 ──
  const parties = doc.parties;
  const hasOffer = doc.offer !== undefined;
  const seats = new Map<string, Seat>(); // role key -> seat
  if (isObj(parties)) {
    if (direction === "multilateral") {
      if (parties.discloser !== undefined || parties.recipient !== undefined) {
        fail("members", "parties", "a multilateral agreement names its seats in parties.members only (5.1)");
      }
      const members = parties.members;
      if (!Array.isArray(members) || members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
        fail("members", "parties.members", "a multilateral agreement has 3 to 16 members (5.1)");
      }
      if (Array.isArray(members)) {
        const keys = new Set<string>();
        members.forEach((m, i) => {
          if (!seatShape(m, `parties.members.${i}`, fail)) return;
          const seat = m as unknown as Seat;
          if (keys.has(seat.agent)) fail("members", `parties.members.${i}.agent`, "no two members may share an agent key (5.1)");
          keys.add(seat.agent);
          seats.set(`member:${seat.agent}`, seat);
        });
      }
      if (hasOffer) fail("offer", "offer", "a multilateral agreement has no open offer (5.1)");
    } else if (direction === "one_way" || direction === "mutual") {
      if (parties.members !== undefined) fail("members", "parties.members", "members belongs to a multilateral agreement");
      if (seatShape(parties.discloser, "parties.discloser", fail)) seats.set("discloser", parties.discloser as unknown as Seat);
      if (parties.recipient === null) {
        // §11 rule 5: an empty recipient seat is an open offer, and only that.
        if (!hasOffer) fail("offer", "parties.recipient", "a recipient seat of null is an open offer, which carries an offer member (6.1)");
      } else if (seatShape(parties.recipient, "parties.recipient", fail)) {
        const recipient = parties.recipient as unknown as Seat;
        seats.set("recipient", recipient);
        const discloser = seats.get("discloser");
        if (discloser && discloser.agent === recipient.agent) fail("shape", "parties.recipient.agent", "the two seats name different agents");
      }
    }
  }

  // ── §6.1 and §11 rule 6: the open offer ──
  if (hasOffer) {
    const offer = doc.offer;
    if (!isObj(offer)) fail("offer", "offer", "offer is an object");
    else {
      if (!isInstant(offer.expires_at)) fail("offer", "offer.expires_at", "an open offer MUST carry expires_at (6.1)");
      const openTo = offer.open_to;
      if (openTo !== "any" && !(Array.isArray(openTo) && openTo.length > 0 && openTo.every((h) => typeof h === "string" && h.length > 0))) {
        fail("offer", "offer.open_to", "open_to is \"any\" or a list of handles (6.1)");
      }
      if (offer.owners !== undefined && offer.owners !== "confirmed" && offer.owners !== "any") {
        fail("offer", "offer.owners", "owners is confirmed or any (6.1)");
      }
    }
    if (isObj(purpose) && Array.isArray(purpose.named) && purpose.named.some((n) => isObj(n) && n.rfp !== undefined)) {
      fail("offer", "purpose.named", "an open offer MUST NOT name the posting that gates on it; the posting commits to the offer digest (5.3)");
    }
    // §6.1: an open offer sets both recipient members to null. A disclosure
    // clause that leaves its recipient member out would make the offer bytes
    // re-derived at acceptance (which set it to null) differ from the bytes
    // the discloser signed, so no acceptance could ever pass.
    if (isObj(parties) && parties.recipient === null && isObj(doc.disclosure) && doc.disclosure.recipient !== null) {
      fail("offer", "disclosure.recipient", "an open offer sets disclosure.recipient to null until acceptance (6.1)");
    }
  }

  // ── §5.5 disclosure ──
  const disclosure = doc.disclosure;
  if (isObj(disclosure)) {
    if (disclosure.subcontractors !== undefined && !(SUBCONTRACTORS as readonly unknown[]).includes(disclosure.subcontractors)) {
      fail("closed_list", "disclosure.subcontractors", "subcontractors is none or bound (5.5)");
    }
    if (disclosure.need_to_know !== undefined) closedList(disclosure.need_to_know, NEED_TO_KNOW, "disclosure.need_to_know", false, fail);

    const required = isObj(disclosure.require) ? disclosure.require.processed_in : undefined;
    const requireSet = required === undefined ? null : statedJurisdictions(required);
    if (required !== undefined && !requireSet) fail("shape", "disclosure.require.processed_in", "require.processed_in lists jurisdictions");

    const declarations: [string, unknown][] = [];
    if (disclosure.recipient !== undefined && disclosure.recipient !== null) declarations.push(["disclosure.recipient", disclosure.recipient]);
    if (disclosure.discloser !== undefined) declarations.push(["disclosure.discloser", disclosure.discloser]);
    if (Array.isArray(disclosure.members)) {
      disclosure.members.forEach((m, i) => {
        declarations.push([`disclosure.members.${i}`, m]);
        if (isObj(m) && direction === "multilateral" && !seats.has(`member:${String(m.agent)}`)) {
          fail("members", `disclosure.members.${i}.agent`, "a member declaration names a member seat by agent (5.5)");
        }
      });
    } else if (disclosure.members !== undefined) fail("shape", "disclosure.members", "members is a list of declarations");

    for (const [path, decl] of declarations) {
      if (!isObj(decl)) {
        fail("shape", path, "a declaration is an object");
        continue;
      }
      const partySet = statedJurisdictions(decl.processed_in);
      if (requireSet && (!partySet || !partySet.every((j) => requireSet.includes(j)))) {
        fail("require_subset", `${path}.processed_in`, "every declared processed_in MUST be stated and inside require.processed_in (5.5)");
      }
      if (decl.processors !== undefined) {
        if (!Array.isArray(decl.processors)) {
          fail("shape", `${path}.processors`, "processors is a list");
          continue;
        }
        decl.processors.forEach((p, i) => {
          const at = `${path}.processors.${i}`;
          if (!isObj(p) || typeof p.service !== "string" || !p.service) {
            fail("shape", at, "a processor names its service (Agent SoW 5.11)");
            return;
          }
          if (p.processed_in === undefined || !partySet) return;
          const own = statedJurisdictions(p.processed_in);
          if (!own || !own.every((j) => partySet.includes(j))) {
            fail("processor_subset", `${at}.processed_in`, "a processor's processed_in is a subset of its party's (Agent SoW 5.11)");
          }
        });
      }
    }
  }

  // ── §5.2 survival, §5.8 at end, §7.3 termination: numbers ──
  const survival = doc.survival;
  if (isObj(survival) && !isPositiveWhole(survival.days)) fail("positive_whole_number", "survival.days", "survival.days is a positive whole number (5.2)");
  const atEnd = doc.at_end;
  if (isObj(atEnd)) {
    if (!(AT_END_ACTIONS as readonly unknown[]).includes(atEnd.action)) fail("closed_list", "at_end.action", "at_end.action is return, destroy or return_or_destroy (5.8)");
    if (atEnd.within_days !== undefined && !isPositiveWhole(atEnd.within_days)) fail("positive_whole_number", "at_end.within_days", "within_days is a positive whole number (5.8)");
  }
  const termination = doc.termination;
  if (isObj(termination) && termination.notice_days !== undefined) {
    const n = termination.notice_days;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) fail("shape", "termination.notice_days", "notice_days is a whole number of days (7.3)");
  }
  const compelled = doc.compelled;
  if (isObj(compelled) && typeof compelled.notice !== "boolean") fail("shape", "compelled.notice", "notice is true or false (5.7)");

  // ── §5.5 flow-down reference ──
  if (doc.flows_from !== undefined) {
    const f = doc.flows_from;
    if (!isObj(f) || typeof f.id !== "string" || !NDA_ID.test(f.id) || !isPositiveWhole(f.version) || typeof f.digest !== "string" || !DIGEST.test(f.digest)) {
      fail("shape", "flows_from", "flows_from names an agreement by id, version and digest (5.5)");
    }
  }

  // ── §11 rule 9: instants ──
  if (isInstant(doc.ends_at) && isInstant(doc.effective_at) && Date.parse(doc.ends_at) < Date.parse(doc.effective_at)) {
    fail("instants", "ends_at", "ends_at is before effective_at (11)");
  }

  // ── §6, §6.2 and §11 rules 4 and 10: signature records ──
  if (Array.isArray(doc.signatures)) {
    const signedSeats = new Set<string>();
    doc.signatures.forEach((s, i) => {
      const at = `signatures.${i}`;
      if (!isObj(s)) {
        fail("shape", at, "a signature record is an object");
        return;
      }
      const rec = s as unknown as SignatureRecord;
      for (const k of Object.keys(s)) {
        if (!(RECORD_MEMBERS as readonly string[]).includes(k)) fail("signatures", `${at}.${k}`, "a signature record carries only the members 6 defines (11 rule 12)");
      }
      if (typeof rec.key !== "string" || !PUBLIC_KEY.test(rec.key)) fail("shape", `${at}.key`, "key is a public key");
      if (typeof rec.sig !== "string" || !SIG_SPELLING.test(rec.sig)) fail("signatures", `${at}.sig`, "sig is the 64-byte Ed25519 signature in canonical padded base64 (6)");
      if (typeof rec.digest !== "string" || !DIGEST.test(rec.digest)) fail("signatures", `${at}.digest`, "digest names the bytes the record covers (6)");
      if (!isInstant(rec.signed_at)) fail("shape", `${at}.signed_at`, "signed_at is an instant");
      let seatKey: string | null = null;
      if (direction === "multilateral") {
        if (rec.role !== "member") fail("signatures", `${at}.role`, "every signature on a multilateral agreement is a member's (6)");
        else if (typeof rec.agent !== "string") fail("signatures", `${at}.agent`, "a member signature names its seat by agent (6)");
        else if (!seats.has(`member:${rec.agent}`)) fail("signatures", `${at}.agent`, "a member signature names a member seat (6)");
        else seatKey = `member:${rec.agent}`;
      } else if (rec.role === "discloser" || rec.role === "recipient") {
        seatKey = rec.role;
        if (rec.role === "recipient" && isObj(parties) && parties.recipient === null) {
          fail("signatures", at, "an open offer has no recipient to sign for it (6.1)");
          seatKey = null;
        }
      } else fail("signatures", `${at}.role`, "role is discloser or recipient, or member in a multilateral agreement (6)");
      if (rec.over !== undefined && (rec.over !== "offer" || rec.role !== "discloser" || !hasOffer)) {
        fail("signatures", `${at}.over`, "only the discloser's signature on an open offer or its acceptance covers the offer bytes (6.1)");
      }
      if (!seatKey) return;
      if (signedSeats.has(seatKey)) fail("signatures", at, "one signature per seat");
      signedSeats.add(seatKey);
      const seat = seats.get(seatKey);
      if (seat?.organization !== undefined && (typeof rec.mandate !== "string" || !rec.mandate)) {
        fail("mandate", `${at}.mandate`, "a seat that names an organization signs under a mandate holding the nda power (6.2)");
      }
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, agreement: doc as unknown as Agreement };
}

function seatShape(v: unknown, path: string, fail: (c: ValidationCode, p: string, m: string) => void): boolean {
  if (!isObj(v)) {
    fail("shape", path, "a seat is an object");
    return false;
  }
  let ok = true;
  if (typeof v.agent !== "string" || !PUBLIC_KEY.test(v.agent)) {
    fail("shape", `${path}.agent`, "a seat names its agent by public key (5.1)");
    ok = false;
  }
  if (typeof v.owner !== "string" || !v.owner) {
    fail("shape", `${path}.owner`, "a seat names its accountable owner (5.1)");
    ok = false;
  }
  if (v.handle !== undefined && typeof v.handle !== "string") fail("shape", `${path}.handle`, "handle is a string");
  if (v.organization !== undefined && (typeof v.organization !== "string" || !v.organization)) fail("shape", `${path}.organization`, "organization names an organization");
  // §5.1 and §11 rule 11: a seat says which key signs for it.
  if (v.organization === undefined && (typeof v.owner_key !== "string" || !PUBLIC_KEY.test(v.owner_key))) {
    fail("owner_key", `${path}.owner_key`, "a seat without an organization names the key that signs for it in owner_key (5.1)");
  }
  if (v.organization !== undefined && v.owner_key !== undefined) {
    fail("owner_key", `${path}.owner_key`, "a seat that names an organization carries no owner_key; its signers are named by their mandates (5.1, 6.2)");
  }
  return ok;
}

function closedList(
  v: unknown,
  allowed: readonly string[],
  path: string,
  nonEmpty: boolean,
  fail: (c: ValidationCode, p: string, m: string) => void,
): void {
  if (!Array.isArray(v)) {
    fail("closed_list", path, `${path} is a list`);
    return;
  }
  if (nonEmpty && v.length === 0) fail("closed_list", path, `${path} MUST NOT be empty (11)`);
  const seen = new Set<unknown>();
  v.forEach((x, i) => {
    if (!allowed.includes(x as string)) fail("closed_list", `${path}.${i}`, `${String(x)} is not in the closed list (5)`);
    if (seen.has(x)) fail("closed_list", `${path}.${i}`, `${String(x)} is listed twice (11)`);
    seen.add(x);
  });
}
