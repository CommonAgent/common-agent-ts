/**
 * Holding an identifier (Agent Mandate §4, 0.6.0-draft).
 *
 * A charter's identifier is public before the charter is filed: the
 * organization publishes it for its domain proof. A registry may reserve it
 * for that domain when it hands it out, and must refuse a filing under an
 * identifier that a reservation or an earlier filing holds for a different
 * domain. A mandate's identifier is held for the organization its first
 * filing names. An identifier nobody holds is never refused for failing to
 * re-derive.
 *
 * Pure: the registry's records arrive through a view, the clock as an
 * argument, so the registry and the conformance file run the same rule.
 */

/** What the rule reads from a registry. */
export interface IdentifierView {
  /** The domain an unlapsed reservation holds a charter identifier for at `at`, or null. */
  reservedFor(id: string, at: number): string | null;
  /** The domain of the charter on file under this identifier, or null. */
  charterDomain(id: string): string | null;
  /** The organization of the mandate on file under this identifier, or null. */
  mandateOrganization(id: string): string | null;
}

export type Filing =
  | { kind: "charter"; id: string; domain: string; at: number }
  | { kind: "mandate"; id: string; organization: string; at: number };

export type HoldVerdict =
  | { held: false }
  | { held: true; by: "reservation" | "filing"; holder: string };

/** Whether another party holds this identifier against this filing. */
export function identifierHeld(filing: Filing, view: IdentifierView): HoldVerdict {
  if (filing.kind === "charter") {
    const filed = view.charterDomain(filing.id);
    if (filed !== null) return filed === filing.domain ? { held: false } : { held: true, by: "filing", holder: filed };
    const reserved = view.reservedFor(filing.id, filing.at);
    if (reserved !== null && reserved !== filing.domain) return { held: true, by: "reservation", holder: reserved };
    return { held: false };
  }
  const org = view.mandateOrganization(filing.id);
  if (org !== null && org !== filing.organization) return { held: true, by: "filing", holder: org };
  const reserved = view.reservedFor(filing.id, filing.at);
  if (org === null && reserved !== null && reserved !== filing.organization) return { held: true, by: "reservation", holder: reserved };
  return { held: false };
}
