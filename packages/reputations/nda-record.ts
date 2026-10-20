/**
 * The NDA record (Agent Reputations §4.9): the part of a report that shows
 * the claims of breach about a subject, as dated findings and counts, and,
 * for the readers rule 6 names, the claims it filed. Pure: the bureau reads
 * each claim's standing from its ledger (nda-claims.ts says how a claim
 * stands) and this decides what a reader may be shown of it.
 *
 * What a report never shows (rule 4) is never an input here: no agreement
 * identifier or digest, no claimant identity, no note, no answer text, no
 * record a claim cites. `agreement` and `respondent` below only group upheld
 * claims, and nothing of either reaches the output.
 */
import { RECORD_PERIOD_DAYS, type ClaimState } from "./nda-claims.js";

/** One claim, with its amendments, as the NDA record reads it. */
export interface ClaimView {
  state: ClaimState;
  basis?: string;
  resolvedAt?: string;
  filedAt: string;
  answers: number;
  lastAnsweredAt?: string;
  /** Inside the record period from its latest entry. Outside it, the claim leaves reports. */
  inRecord: boolean;
  categories: readonly string[];
  direction: string;
  claimantAnchorHash: string;
  /** The salted hash of the claimant's operator, where the bureau knew it: claimants that share one count once. */
  claimantOperatorHash?: string;
  /** With `respondent`, groups several upheld claims on one agreement against one respondent into one entry (rule 1). Never shown. */
  agreement: string;
  respondent: string;
}

export interface NdaRecordUpheld {
  upheld_at: string;
  basis: string;
  categories: string[];
  direction: string;
  claimant_anchor_hash: string;
  answered: boolean;
  answered_at?: string;
}

/** The claims a party filed in the record period, in each state (rule 6). */
export interface NdaFiledCounts {
  open: number;
  upheld: number;
  dismissed: number;
  withdrawn: number;
  set_aside: number;
  lapsed: number;
}

export interface NdaRecord {
  record_days: number;
  upheld: NdaRecordUpheld[];
  open: { count: number; claimants: number; earliest: string | null; answered: number };
  closed: { dismissed: number; withdrawn: number; set_aside: number; lapsed: number };
  /**
   * Only in the party's own subject-scoped excerpt, and in a respondent's
   * excerpt beside a claim the party filed (rule 6, Agent Reputations
   * 0.10.0-draft). Never in a report another reader can fetch: there it
   * would move at the moment the respondent's open count does, and tell a
   * poller who filed against whom.
   */
  filed?: NdaFiledCounts;
}

const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a);
const count = (vs: readonly ClaimView[], s: ClaimState) => vs.filter((v) => v.state === s).length;

/** How many distinct claimants: those that share an anchor or an operator are one (rule 2). */
function distinctClaimants(views: readonly ClaimView[]): number {
  const parent = views.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const seen = new Map<string, number>();
  views.forEach((v, i) => {
    for (const k of [`a:${v.claimantAnchorHash}`, ...(v.claimantOperatorHash ? [`o:${v.claimantOperatorHash}`] : [])]) {
      const j = seen.get(k);
      if (j === undefined) seen.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  return new Set(views.map((_, i) => find(i))).size;
}

/** The counts of a party's filings in the record period, in each state (rule 6). */
export function filedCounts(filed: readonly ClaimView[]): NdaFiledCounts {
  const shown = filed.filter((v) => v.inRecord);
  return {
    open: count(shown, "open"),
    upheld: count(shown, "upheld"),
    dismissed: count(shown, "dismissed"),
    withdrawn: count(shown, "withdrawn"),
    set_aside: count(shown, "set_aside"),
    lapsed: count(shown, "lapsed"),
  };
}

/**
 * The NDA record of a subject from the claims against it. Rejected claims
 * are never inputs (they appear in the two parties' excerpts and nowhere
 * else), and only claims inside the record period are shown. `filed`, the
 * claims the subject filed, is given only for a reader rule 6 serves it to.
 */
export function ndaRecord(about: readonly ClaimView[], opts: { recordDays?: number; filed?: readonly ClaimView[] } = {}): NdaRecord {
  const shown = about.filter((v) => v.inRecord);

  // 1. Upheld breaches, one entry per agreement and respondent, with the latest date.
  const byAgreement = new Map<string, ClaimView[]>();
  for (const v of shown.filter((x) => x.state === "upheld")) {
    const k = `${v.agreement}|${v.respondent}`;
    byAgreement.set(k, [...(byAgreement.get(k) ?? []), v]);
  }
  const upheld: NdaRecordUpheld[] = [...byAgreement.values()].map((vs) => {
    const latest = vs.reduce((a, b) => (Date.parse(b.resolvedAt ?? b.filedAt) > Date.parse(a.resolvedAt ?? a.filedAt) ? b : a));
    const answeredAt = vs.reduce<string | undefined>((a, v) => later(a, v.lastAnsweredAt), undefined);
    return {
      upheld_at: latest.resolvedAt ?? latest.filedAt,
      basis: latest.basis ?? "",
      categories: [...new Set(vs.flatMap((v) => v.categories))].sort(),
      direction: latest.direction,
      claimant_anchor_hash: latest.claimantAnchorHash,
      answered: vs.some((v) => v.answers > 0),
      ...(answeredAt ? { answered_at: answeredAt } : {}),
    };
  }).sort((a, b) => Date.parse(b.upheld_at) - Date.parse(a.upheld_at));

  // 2. Open claims, as counts only.
  const open = shown.filter((v) => v.state === "open");
  const earliest = open.reduce<string | null>((a, v) => (!a || Date.parse(v.filedAt) < Date.parse(a) ? v.filedAt : a), null);

  return {
    record_days: opts.recordDays ?? RECORD_PERIOD_DAYS,
    upheld,
    open: { count: open.length, claimants: distinctClaimants(open), earliest, answered: open.filter((v) => v.answers > 0).length },
    // 3. Closed claims, in the states they ended in.
    closed: { dismissed: count(shown, "dismissed"), withdrawn: count(shown, "withdrawn"), set_aside: count(shown, "set_aside"), lapsed: count(shown, "lapsed") },
    // 6. Only for the readers rule 6 names.
    ...(opts.filed ? { filed: filedCounts(opts.filed) } : {}),
  };
}
