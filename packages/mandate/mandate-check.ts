/**
 * The check at approval (§7). This is why the specification exists.
 *
 * Agent SoW §6.1 already holds an act pending until the account's human
 * confirms with a credential that attests presence. That ceremony proves a
 * verified human was there; it does not prove the human was entitled to bind
 * anyone. Where the account is the holder of a mandate, these five checks
 * extend it, in the specification's order:
 *
 *   1. the confirming person's account holds a mandate for the organization
 *      the engagement's party names;
 *   2. the mandate is in force: started, unexpired, unrevoked, chain verifies
 *      up to the charter's root authority;
 *   3. the act is within the mandate's powers;
 *   4. the committed price is within per_engagement, and the holder's
 *      month-to-date formed total stays within per_month;
 *   5. the engagement's offerings fall within the mandate's scope.
 *
 * An act on an Agent NDA takes the same first three checks and, in place of
 * checks 4 and 5, the category check of §7.2 step 4: an Agent NDA commits no
 * price and names no offering, so a mandate's ceiling and offering scope
 * place no limit on the `nda` power.
 *
 * If any check fails, the platform refuses with the failing check named. That
 * is the contract, so the verdict carries the number and the name and not
 * only a sentence: a caller that wants to branch on which check failed can,
 * and a person who reads the sentence learns what to do about it.
 *
 * All five are `enforced` here, because the platform holds the act pending.
 * Where a platform cannot hold it, the mandate reference is `evidence` and
 * this code is not what refuses anything.
 */
import { patternMatches, verifyMandateChain, type CharterDoc, type MandateDoc, type MandatePower } from "./mandate-doc.js";

/**
 * What the five checks read from a registry. The core keeps no state, so the
 * registry's records arrive through this view; the platform's MandateStore
 * answers it from its database, and a test can answer it from a few objects.
 */
export interface MandateRegistryView {
  /** The organization's current charter and whether it stands or is suspended. */
  charter(org: string): { doc: CharterDoc; state: "active" | "suspended" } | null;
  /** The mandate and the mandates above it, the target first; null when a link is missing. */
  chainOf(id: string): MandateDoc[] | null;
  /** Which of these mandate ids the registry has recorded as revoked. */
  revokedAmong(ids: readonly string[]): ReadonlySet<string>;
  /** The mandates an account holds for an organization. */
  mandatesForAccount(org: string, account: string): Array<{ doc: MandateDoc }>;
}

export type ApprovalAct = "formation" | "amendment" | "termination" | "award" | "nda" | "write";

/** §7.3: the power each act takes. `issue` is not here; it is implied by
 *  sub_delegation.allowed and is checked when a mandate is filed, not when an
 *  engagement is approved. */
export const POWER_FOR_ACT: Record<ApprovalAct, MandatePower> = {
  formation: "form",
  amendment: "amend",
  termination: "terminate",
  award: "award",
  nda: "nda",
  write: "write",
};

export type ApprovalCheck =
  | "mandate_held"
  | "mandate_in_force"
  | "power_held"
  | "ceiling"
  | "scope"
  | "nda_categories";

export interface ApprovalRequest {
  /** The organization the engagement's party names. */
  organization: string;
  /** The confirming person's account. */
  account: string;
  act: ApprovalAct;
  /** The engagement's committed price (§5.5 of Agent SoW), or null when the
   *  document commits to no figure. */
  committed_price?: number | null;
  currency?: string | null;
  /** The offerings the engagement covers. */
  offerings?: string[];
  /**
   * The mandate the act cites, where it cites one: an approval record's
   * `mandate`, or an Agent NDA signature record's (§7.2). When present, only
   * that mandate is checked. Authority from some other mandate the account
   * holds would leave the record naming one that did not authorize the act.
   */
  mandate?: string;
  /**
   * The public key the act was signed with, where the caller knows it. Where
   * the mandate carries `holder.key` and this differs, check 1 fails: the
   * signer is not the mandate's holder (§7.2 step 1). The signature itself is
   * the caller's to verify.
   */
  signer_key?: string;
  /** For act `nda`: the agreement's `covers.categories` (§7.2 step 4). */
  nda_categories?: string[];
  /**
   * For a mutating act through a resource proxy, `write` or `amend`: the
   * resource it targets, read against `scope.resources` (§6 rule 9, §7
   * check 5). Such an act commits no price and names no offering.
   */
  resource?: string;
  /** The holder's formed commitments this calendar month, BEFORE this act. */
  month_to_date?: number;
  now?: number;
}

export type ApprovalVerdict =
  | {
      ok: true;
      mandate: string;
      chain: string[];
      settlement_payer: "holder" | "organization";
    }
  | { ok: false; check: number; name: ApprovalCheck; error: string };

const CHECK_NUMBER: Record<ApprovalCheck, number> = {
  mandate_held: 1,
  mandate_in_force: 2,
  power_held: 3,
  ceiling: 4,
  scope: 5,
  // §7.2 step 4 stands in the place of checks 4 and 5 for an act on an
  // Agent NDA, so it takes the fourth position.
  nda_categories: 4,
};

function refuse(name: ApprovalCheck, error: string): ApprovalVerdict {
  return { ok: false, check: CHECK_NUMBER[name], name, error };
}

/** One candidate mandate against all five checks, in order. */
function checkOne(
  store: MandateRegistryView,
  mandate: MandateDoc,
  req: ApprovalRequest,
  now: number,
): ApprovalVerdict {
  // 1, the part the registry can see: where the mandate names its holder's
  // key and the caller says which key signed, they are the same key. An act
  // on an Agent NDA is always signed, and §7.2 check 1 is made with that key
  // (0.6.0-draft), so one that names no key is not shown to be the holder's.
  if (req.act === "nda" && !req.signer_key) {
    return refuse(
      "mandate_held",
      `An act on an Agent NDA is checked against the key that signed it, and none was given, so the signer is not shown to hold mandate ${mandate.id}.`,
    );
  }
  if (req.signer_key && mandate.holder.key && req.signer_key !== mandate.holder.key) {
    return refuse(
      "mandate_held",
      `The act was signed with a key that is not the holder key of mandate ${mandate.id}, so its signer is not shown to hold the mandate.`,
    );
  }

  // 2. In force: started, unexpired, unrevoked, and the chain verifies up to
  //    the charter's root authority. verifyMandateChain does all four when it
  //    is given the clock and the registry's revocation set, so there is one
  //    reading of "in force" and not a second one here.
  const charter = store.charter(mandate.organization);
  if (!charter) {
    return refuse(
      "mandate_in_force",
      `This registry hosts no charter for ${mandate.organization}, so the chain behind ${mandate.id} cannot be verified.`,
    );
  }
  const chain = store.chainOf(mandate.id);
  if (!chain) {
    return refuse(
      "mandate_in_force",
      `The chain above ${mandate.id} is incomplete on this registry, so the mandate cannot be verified up to root authority.`,
    );
  }
  const verdict = verifyMandateChain(
    { charter: charter.doc, mandates: chain },
    { now, charterState: charter.state, revoked: store.revokedAmong(chain.map((m) => m.id)) },
  );
  if (!verdict.ok) {
    return refuse("mandate_in_force", verdict.error);
  }

  // 3. Powers. A power not listed is not held (§6 rule 4).
  const power = POWER_FOR_ACT[req.act];
  if (!mandate.powers.includes(power)) {
    return refuse(
      "power_held",
      `This act needs the ${power} power and mandate ${mandate.id} holds ${mandate.powers.join(", ")}. A power not listed is not held. The act needs someone whose mandate holds ${power}.`,
    );
  }

  // §7.1: a mutating act through a resource proxy, write or amend, commits
  // no price and names no offering. Check 5 reads its resource against
  // scope.resources (§6 rule 9), as the proxy's own check does (proxy.ts).
  if (req.act === "write" || req.resource !== undefined) {
    const patterns = mandate.scope?.resources;
    if (patterns && patterns.length) {
      const resource = req.resource ?? "";
      if (!resource || !patterns.some((p) => patternMatches(p, resource))) {
        return refuse(
          "scope",
          resource
            ? `The resource ${resource} falls outside mandate ${mandate.id}, which reaches ${patterns.join(", ")}.`
            : `Mandate ${mandate.id} reaches the resources ${patterns.join(", ")} and this act names none, so it cannot be shown to fall inside.`,
        );
      }
    }
    return {
      ok: true,
      mandate: mandate.id,
      chain: verdict.mandates,
      settlement_payer: mandate.settlement?.payer ?? "holder",
    };
  }

  // §7.2: an act on an Agent NDA takes step 4, the categories, and neither
  // ceiling nor offering scope, which an agreement that commits no price and
  // names no offering cannot be read against.
  if (req.act === "nda") {
    const allowed = mandate.scope?.nda_categories;
    if (allowed && allowed.length) {
      const covers = req.nda_categories ?? [];
      const outside = covers.filter((c) => !(allowed as readonly string[]).includes(c));
      if (outside.length) {
        return refuse(
          "nda_categories",
          `The agreement covers ${outside.join(", ")}, outside mandate ${mandate.id}, which may sign Agent NDAs covering ${allowed.join(", ")} only.`,
        );
      }
      if (!covers.length) {
        return refuse(
          "nda_categories",
          `Mandate ${mandate.id} may sign Agent NDAs covering ${allowed.join(", ")} only, and the request did not say what this agreement covers, so it cannot be shown to fall inside.`,
        );
      }
    }
    return {
      ok: true,
      mandate: mandate.id,
      chain: verdict.mandates,
      settlement_payer: mandate.settlement?.payer ?? "holder",
    };
  }

  // 4. Ceilings. Both run at approval time (§6 rule 5).
  const ceiling = mandate.ceiling;
  if (ceiling) {
    const price = req.committed_price ?? null;
    if (price !== null) {
      if (req.currency && req.currency !== ceiling.currency) {
        return refuse(
          "ceiling",
          `This engagement commits ${price} ${req.currency} and mandate ${mandate.id} is bounded in ${ceiling.currency}. Two currencies cannot be compared, so the ceiling cannot be checked.`,
        );
      }
      if (ceiling.per_engagement !== undefined && price > ceiling.per_engagement) {
        return refuse(
          "ceiling",
          `This engagement commits ${price} ${ceiling.currency} and mandate ${mandate.id} allows ${ceiling.per_engagement} per engagement. The act needs someone with a higher ceiling.`,
        );
      }
      if (ceiling.per_month !== undefined) {
        const mtd = req.month_to_date ?? 0;
        if (mtd + price > ceiling.per_month) {
          return refuse(
            "ceiling",
            `This engagement commits ${price} ${ceiling.currency} on top of ${mtd} already committed this month, and mandate ${mandate.id} allows ${ceiling.per_month} per calendar month. The act waits for next month or needs someone with a higher ceiling.`,
          );
        }
      }
    }
  }

  // 5. Scope.
  const patterns = mandate.scope?.offerings;
  if (patterns && patterns.length) {
    const offerings = req.offerings ?? [];
    const outside = offerings.filter((o) => !patterns.some((p) => patternMatches(p, o)));
    if (outside.length) {
      return refuse(
        "scope",
        `The offering${outside.length === 1 ? "" : "s"} ${outside.join(", ")} fall outside mandate ${mandate.id}, which is scoped to ${patterns.join(", ")}.`,
      );
    }
    if (!offerings.length) {
      return refuse(
        "scope",
        `Mandate ${mandate.id} is scoped to ${patterns.join(", ")} and this engagement names no offering, so it cannot be shown to fall inside.`,
      );
    }
  }

  return {
    ok: true,
    mandate: mandate.id,
    chain: verdict.mandates,
    settlement_payer: mandate.settlement?.payer ?? "holder",
  };
}

/**
 * Run §7 for one approval. An account may hold more than one mandate for an
 * organization; any one of them that passes all five is authority enough, so
 * every candidate is tried. When none passes, the refusal reported is the one
 * that got furthest, which is the most informative thing to say: telling
 * someone their scope is wrong is more use than telling them the first of
 * their three mandates has expired.
 */
export function checkAtApproval(store: MandateRegistryView, req: ApprovalRequest): ApprovalVerdict {
  const now = req.now ?? Date.now();

  // 1. Does this account hold a mandate for this organization at all?
  const all = store.mandatesForAccount(req.organization, req.account);
  if (!all.length) {
    return refuse(
      "mandate_held",
      `Account ${req.account} holds no mandate for ${req.organization}, so it cannot commit that organization. An allocator holding a root authority key issues one.`,
    );
  }
  const held = req.mandate ? all.filter((rec) => rec.doc.id === req.mandate) : all;
  if (!held.length) {
    return refuse(
      "mandate_held",
      `The act cites mandate ${req.mandate}, and account ${req.account} holds no mandate of that id for ${req.organization}.`,
    );
  }

  let worst: ApprovalVerdict | null = null;
  for (const rec of held) {
    const verdict = checkOne(store, rec.doc, req, now);
    if (verdict.ok) return verdict;
    if (!worst || (!worst.ok && verdict.check >= worst.check)) worst = verdict;
  }
  return worst!;
}
