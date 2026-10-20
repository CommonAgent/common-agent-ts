/**
 * The flow-down test of §5.5. A party that may pass material to
 * subcontractors (`subcontractors: "bound"`) binds each one with its own
 * Agent NDA that names the upstream agreement in `flows_from`. That
 * agreement binds the subcontractor for §8.1 only when it is at least as
 * strict as the one above, compared field by field. Each field that fails is
 * named, so a party can see what to tighten.
 */
import { agreementDigest } from "./bytes.js";
import type { Agreement, Declaration, Processor, Seat } from "./types.js";
import { statedJurisdictions } from "./validate.js";

export type FlowDownCheck = { ok: true } | { ok: false; failures: string[] };

/** The declaration a party made in an agreement for the seat it holds:
 *  `disclosure.recipient` for the recipient, `disclosure.discloser` for the
 *  discloser of a mutual agreement, its entry of `disclosure.members` in a
 *  multilateral one, and null where it made none. */
export function declarationOf(doc: Agreement, agent: string): Declaration | null {
  const d = doc.disclosure;
  if (!d) return null;
  if (doc.direction === "multilateral") return d.members?.find((m) => m.agent === agent) ?? null;
  if (doc.parties.recipient?.agent === agent) return d.recipient ?? null;
  if (doc.parties.discloser?.agent === agent) return doc.direction === "mutual" ? d.discloser ?? null : null;
  return null;
}

/** The seat an agent key holds in an agreement, if any. */
export function seatFor(doc: Agreement, agent: string): Seat | null {
  if (doc.direction === "multilateral") return doc.parties.members?.find((m) => m.agent === agent) ?? null;
  if (doc.parties.discloser?.agent === agent) return doc.parties.discloser;
  if (doc.parties.recipient?.agent === agent) return doc.parties.recipient;
  return null;
}

/** Agent SoW §5.16's processor match: on `service` and `domain`, where an
 *  entry with no domain matches only an entry with none. */
export function sameProcessor(a: Processor, b: Processor): boolean {
  return a.service === b.service && (a.domain ?? null) === (b.domain ?? null);
}

function subset<T>(inner: readonly T[], outer: readonly T[]): boolean {
  return inner.every((x) => outer.includes(x));
}

/**
 * Whether `flowDown` passes the strictness test against `upstream`. The
 * party in the middle is the flow-down's discloser, and it must hold a seat
 * in the upstream agreement; the subcontractor is the flow-down's recipient.
 */
export function checkFlowDown(flowDown: Agreement, upstream: Agreement): FlowDownCheck {
  const failures: string[] = [];
  const f = flowDown.flows_from;
  if (!f) return { ok: false, failures: ["flows_from: the agreement names no upstream agreement"] };
  if (f.id !== upstream.id || f.version !== upstream.version || f.digest !== agreementDigest(upstream)) {
    failures.push("flows_from: it does not name this upstream agreement by id, version and digest");
  }
  if (upstream.disclosure?.subcontractors !== "bound") failures.push("subcontractors: the upstream agreement does not permit bound subcontractors");

  const party = flowDown.parties.discloser?.agent;
  const sub = flowDown.parties.recipient?.agent;
  if (!party || !seatFor(upstream, party)) failures.push("parties: the flow-down's discloser holds no seat upstream");
  if (!sub) failures.push("parties: the flow-down names no subcontractor in its recipient seat");

  // Categories a superset.
  if (!subset(upstream.covers.categories, flowDown.covers.categories)) failures.push("covers.categories: it drops a category the upstream agreement covers");
  // Activities a subset.
  if (!subset(flowDown.purpose.activities ?? [], upstream.purpose.activities ?? [])) failures.push("purpose.activities: it adds an activity outside the upstream purpose");

  // The subcontractor's processors and jurisdictions inside the party's own
  // upstream declaration.
  const above = party ? declarationOf(upstream, party) : null;
  const below = sub ? declarationOf(flowDown, sub) : null;
  const abovePlaces = statedJurisdictions(above?.processed_in);
  if (abovePlaces) {
    const belowPlaces = statedJurisdictions(below?.processed_in);
    if (!belowPlaces || !subset(belowPlaces, abovePlaces)) failures.push("processed_in: the subcontractor's jurisdictions are unstated or outside the party's upstream declaration");
  }
  for (const p of below?.processors ?? []) {
    if (!(above?.processors ?? []).some((q) => sameProcessor(p, q))) failures.push(`processors: ${p.service} is not among the party's upstream processors`);
  }

  // Survival at least as long, return or destruction no slower.
  const upSurvival = upstream.survival?.days;
  if (upSurvival !== undefined && !((flowDown.survival?.days ?? 0) >= upSurvival)) failures.push("survival.days: shorter than upstream");
  const upWithin = upstream.at_end?.within_days;
  if (upWithin !== undefined) {
    const within = flowDown.at_end?.within_days;
    if (within === undefined || within > upWithin) failures.push("at_end.within_days: longer than upstream, or unstated");
  }

  // Exclusions and need-to-know subsets. Absence of an exclusions clause
  // means none applies (§5.6); absence of need_to_know is read as the empty
  // list, the narrowest reading.
  if (!subset(flowDown.exclusions?.allowed ?? [], upstream.exclusions?.allowed ?? [])) failures.push("exclusions.allowed: it allows an exclusion upstream does not");
  if (!subset(flowDown.disclosure?.need_to_know ?? [], upstream.disclosure?.need_to_know ?? [])) failures.push("need_to_know: it permits people upstream does not");

  const subs = flowDown.disclosure?.subcontractors ?? "none";
  if (subs !== "none" && subs !== "bound") failures.push("subcontractors: none or bound");

  return failures.length ? { ok: false, failures } : { ok: true };
}
