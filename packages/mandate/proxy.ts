/**
 * The check at a resource proxy (Agent Mandate §7.1, 0.8.0-draft): a client
 * agent answering a provider's requests against a resource it granted
 * `via: "proxy"` (Agent SoW §5.3.1).
 *
 * A read within the grant is answered on the grant alone. Every other act is
 * mutating, including an operation that declares nothing, and needs a
 * mandate in force holding the power the grant names for that resource in
 * `writes`, or `write` where it names none. A grant's `writes` may name only
 * `write` or `amend`: a grant cannot lend a caller the authority to form an
 * engagement, award a posting, act on an Agent NDA or issue mandates.
 *
 * Pure, like the rest of the core: the mandate arrives as the answer a lookup
 * gave at the instant of the act, and the clock as an argument. The adapter's
 * proxy is the caller.
 */
import { patternMatches } from "./mandate-doc.js";

/** The powers a grant's `writes` may name (§7.1). */
export const WRITES_POWERS = ["write", "amend"] as const;
export type WritesPower = (typeof WRITES_POWERS)[number];

/** The parts of an Agent SoW `shared_resource` input this check reads. */
export interface ProxyGrant {
  via?: string;
  /** For each resource, the power a mutating act on it needs. */
  writes?: Record<string, string>;
  [k: string]: unknown;
}

/** One act the proxy is asked to answer. */
export interface ProxyAct {
  resource: string;
  operation: string;
  /** true where the operation is declared or known to read and change nothing; false or null otherwise. */
  read_only: boolean | null;
}

/** What a mandate lookup answered for the caller at the instant of the act. */
export interface ProxyMandate {
  organization: string;
  holder_key?: string;
  starts_at: string;
  expires_at: string;
  powers: string[];
  scope?: { resources?: string[]; offerings?: string[] };
  /** Whether the registry recorded it, or a mandate above it, as revoked. */
  revoked?: boolean;
}

export type ProxyCheck = "grant" | "mandate" | "organization" | "holder" | "in_force" | "powers" | "scope";

export type ProxyVerdict =
  | { allow: true; power?: WritesPower }
  | { allow: false; check: ProxyCheck; reason: string };

/** Whether a grant's `writes` is one §7.1 lets stand. */
export function validateProxyWrites(grant: ProxyGrant): { ok: true } | { ok: false; error: string } {
  if (grant.writes === undefined) return { ok: true };
  if (grant.via !== "proxy") {
    return { ok: false, error: 'writes names the power a write through a resource proxy needs, so it belongs only on a grant made via "proxy".' };
  }
  if (!grant.writes || typeof grant.writes !== "object" || Array.isArray(grant.writes)) {
    return { ok: false, error: "writes is an object naming, for each resource, the power a mutating act on it needs." };
  }
  for (const [resource, power] of Object.entries(grant.writes)) {
    if (!(WRITES_POWERS as readonly string[]).includes(power)) {
      return {
        ok: false,
        error: `writes names ${JSON.stringify(power)} for ${resource}, and a grant may name only write or amend: it cannot lend the authority to form, award, act on an Agent NDA or issue mandates.`,
      };
    }
  }
  return { ok: true };
}

/** The power a mutating act on this resource needs under this grant. */
export function powerForWrite(grant: ProxyGrant, resource: string): WritesPower {
  const named = grant.writes?.[resource];
  return named === "amend" ? "amend" : "write";
}


/**
 * §7.1 for one act, in the order a refusal is most useful in: the grant
 * itself, then whether the act reads only, then the mandate.
 *
 *   grant         the grant's writes does not validate, so nothing it says
 *                 about which power a write needs can be relied on
 *   mandate       a mutating act and no mandate presented
 *   organization  the mandate is not of the organization the grant accepts;
 *                 anyone can charter a domain of their own
 *   holder        the mandate names no holder key, or the key that made the
 *                 request is not it (§7 check 1)
 *   in_force      not started, expired, revoked, or with dates that do not
 *                 parse (§7 check 2)
 *   powers        the mandate does not hold the power the grant names for the
 *                 resource, or write (§7 check 3)
 *   scope         the resource falls outside the mandate's scope.resources,
 *                 whichever power the act needs (§6 rule 9, §7 check 5); a
 *                 mandate with no scope at all reaches every resource, but
 *                 one scoped to offerings and naming no resources was meant
 *                 to be limited, and reaches none
 */
export function checkAtProxy(input: {
  grant: ProxyGrant;
  act: ProxyAct;
  mandate: ProxyMandate | null;
  at: number;
  /** The key that made the request. */
  callerKey: string;
  /** The organization whose mandates this grant accepts. */
  expectedOrganization: string;
}): ProxyVerdict {
  const { grant, act, mandate, at } = input;
  const valid = validateProxyWrites(grant);
  if (!valid.ok) return { allow: false, check: "grant", reason: valid.error };
  if (act.read_only === true) return { allow: true };
  if (!mandate) {
    return { allow: false, check: "mandate", reason: `${act.operation} on ${act.resource} changes something, so it is answered only for a caller who presents a mandate.` };
  }
  if (!input.expectedOrganization || mandate.organization !== input.expectedOrganization) {
    return { allow: false, check: "organization", reason: `The mandate presented is of ${mandate.organization}, and this grant accepts mandates of ${input.expectedOrganization || "no organization"} only.` };
  }
  if (typeof mandate.holder_key !== "string" || !mandate.holder_key) {
    return { allow: false, check: "holder", reason: "The mandate presented names no holder key, so nothing binds the caller to it." };
  }
  if (!input.callerKey || input.callerKey !== mandate.holder_key) {
    return { allow: false, check: "holder", reason: "The key that made the request is not the holder key of the mandate presented." };
  }
  const starts = Date.parse(mandate.starts_at);
  const expires = Date.parse(mandate.expires_at);
  if (mandate.revoked || !Number.isFinite(at) || !Number.isFinite(starts) || !Number.isFinite(expires) || at < starts || at >= expires) {
    return { allow: false, check: "in_force", reason: "The mandate presented is not in force at the instant of the act." };
  }
  const power = powerForWrite(grant, act.resource);
  if (!mandate.powers.includes(power)) {
    return { allow: false, check: "powers", reason: `A change to ${act.resource} through this grant needs the ${power} power, and the mandate presented does not hold it.` };
  }
  const resources = Array.isArray(mandate.scope?.resources) ? mandate.scope!.resources!.filter((r): r is string => typeof r === "string") : [];
  // A mandate scoped to offerings was meant to be limited. Reading its missing
  // resources list as "every resource" would widen it at the resource
  // boundary, so it reaches none here until it names its resources. The
  // refusal is outright: offerings are not matched against resource names
  // (0.8.0-draft, §6 rule 9, §7.1).
  if (!resources.length && Array.isArray(mandate.scope?.offerings)) {
    const offerings = mandate.scope!.offerings!.filter((o): o is string => typeof o === "string");
    return { allow: false, check: "scope", reason: `The mandate presented is scoped to offerings (${offerings.join(", ")}) and names no resources, so it reaches no resource through this proxy. Its issuer can add scope.resources.` };
  }
  if (resources.length && !resources.some((p) => patternMatches(p, act.resource))) {
    return { allow: false, check: "scope", reason: `${act.resource} falls outside the resources the mandate reaches (${resources.join(", ")}).` };
  }
  return { allow: true, power };
}
