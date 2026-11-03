/**
 * The checker: the fourteen checks of Section 9.10, by the rule ids every
 * Common Agent checker shares.
 *
 * Twelve are static: they read the document alone, and each reads it exactly
 * as the Common Agent Standards' reference checker does
 * (`common-agent/conformance/lib/check-agentdoc.mjs`), so that this package
 * and that checker agree on every conformance case. Two need the sources and
 * run only with `fetchSources`: `source-digest` fetches each listed source and
 * compares its digest, and `fact-in-source` looks for each fact of a section
 * in the sources that section cites.
 *
 * A finding at level `fail` is a check the document fails. A finding at level
 * `warn` is something Section 9 asks for that the shared reading leaves out,
 * or something this checker could not decide, such as a source with no
 * address to fetch. Warnings never make `ok` false.
 */
import { canonicalJSON, sha256Digest } from "@common-agent/crypto";
import { KNOWN_SECTIONS, covered, offeringPaths } from "./paths.js";
import type { AgentDoc, CheckOptions, CheckReport, Finding, RuleId } from "./types.js";
import { ReadError, arr, isObj, parseBytes, str, type Rec } from "./util.js";

/** The keys that are a summary grade wherever they appear (Section 9.3), and the endings that make one. */
export const GRADE_KEYS = ["score", "rating", "grade", "badge", "badges", "tier", "rank", "stars", "trust", "trust_label", "trust_level", "trust_mark"];
export const GRADE_ENDINGS = ["_score", "_rating", "_grade", "_badge", "_tier", "_rank", "_stars"];
/** The grades an Agent SoW clause carries (Agent SoW Section 3). A `grade` with one of these values grades a quoted clause, not the agent, and is allowed. */
export const CLAUSE_GRADES = ["enforced", "evidence", "recorded"];
/** The keys that are a statement of what an open-ended offering can do (Section 9.5). */
export const CLAIM_KEYS = ["does", "focus", "role", "can_do", "capabilities", "skills", "examples"];
/** What a package AgentDoc always names in `not_stated` (Section 13.4, rule 2). */
export const PACKAGE_NAMES = ["subject", "standing", "access", "handling", "shape.visibility", "sells.offerings.price"];

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Every object under a value, with its path, the value itself included. */
function* objects(value: unknown, path: string): Generator<[Rec, string]> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* objects(value[i], `${path}[${i}]`);
  } else if (isObj(value)) {
    yield [value, path];
    for (const [k, v] of Object.entries(value)) yield* objects(v, `${path}.${k}`);
  }
}

/** The value at a dotted path, reading the rest of the path in each element of an array on the way. */
function valueAt(root: unknown, parts: string[]): unknown {
  if (!parts.length) return root;
  if (Array.isArray(root)) {
    for (const el of root) {
      const v = valueAt(el, parts);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  if (!isObj(root) || !Object.prototype.hasOwnProperty.call(root, parts[0]!)) return undefined;
  return valueAt(root[parts[0]!], parts.slice(1));
}

/** The twelve static checks, and the warnings that go with them. */
export function staticFindings(doc: unknown): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: RuleId, path: string, message: string, level: "fail" | "warn" = "fail") => findings.push({ rule, path, message, level });
  if (!isObj(doc)) {
    add("section-has-source", "", "the document is not a JSON object");
    return findings;
  }

  const isPackage = doc.package !== undefined;
  const sources = arr<unknown>(doc.sources);
  const sourceIds = new Set(sources.filter(isObj).map((s) => s.id));
  const sections = isObj(doc.sections) ? doc.sections : {};
  const notStated = arr<unknown>(doc.not_stated).filter((p): p is string => typeof p === "string");
  const named = (path: string) => notStated.some((e) => path === e || path.startsWith(`${e}.`));

  // sources-exist and section-has-source (Section 9.3)
  for (const [name, s] of Object.entries(sections)) {
    if (!isObj(s) || !Array.isArray(s.from) || s.from.length === 0) {
      add("section-has-source", `sections.${name}.from`, `the ${name} section names no source`);
      continue;
    }
    for (const id of s.from) {
      if (!sourceIds.has(id)) add("sources-exist", `sections.${name}.from`, `the ${name} section cites ${JSON.stringify(id)}, which is not among the sources`);
    }
    // A member's own pointer narrows the section's sources and never widens them (Section 9.3).
    for (const [o, path] of objects(s, `sections.${name}`)) {
      for (const [k, v] of Object.entries(o)) {
        if (!k.endsWith("_from") || typeof v !== "string") continue;
        if (!sourceIds.has(v)) add("sources-exist", `${path}.${k}`, `${k} names ${JSON.stringify(v)}, which is not among the sources`);
        else if (!s.from.includes(v)) add("sources-exist", `${path}.${k}`, `${k} names ${JSON.stringify(v)}, which the ${name} section does not cite`, "warn");
      }
    }
  }

  // no-summary-grade (Section 9.3)
  for (const [o, path] of objects(doc, "")) {
    for (const k of Object.keys(o)) {
      const key = k.toLowerCase();
      if (key === "grade" && CLAUSE_GRADES.includes(String(o[k]))) continue; // an Agent SoW clause grade grades the clause, not the agent
      if (GRADE_KEYS.includes(key) || GRADE_ENDINGS.some((e) => key.endsWith(e))) {
        add("no-summary-grade", `${path}.${k}`.replace(/^\./, ""), `${k} is a summary grade, and an AgentDoc carries none`);
      }
    }
  }

  // visibility-supports-claim and decided-by-rule (Sections 9.5.1 and 6.11): presented as enforced is "enforced": true.
  const visibility = isObj(sections.shape) ? sections.shape.visibility : undefined;
  for (const [o, path] of objects(sections, "sections")) {
    if (o.enforced !== true) continue;
    const atDoor = path === "sections.access" || path.startsWith("sections.access.") || path.startsWith("sections.access[");
    const supported = visibility === "verifiable" || (visibility === "observed" && atDoor);
    if (!supported) {
      add("visibility-supports-claim", path, `${path} is presented as enforced, and visibility ${visibility === undefined ? "absent" : JSON.stringify(visibility)} does not support that${visibility === "observed" ? " away from the door" : ""}`);
    }
    if (o.decided_by !== "rule") {
      add("decided-by-rule", path, `${path} is presented as enforced, and what decides it is ${o.decided_by === undefined ? "not stated" : JSON.stringify(o.decided_by)}, not a rule`);
    }
  }

  // sells-scope, open-offering-members and open-ended-no-claim (Sections 9.5 and 6.11)
  const sells = isObj(sections.sells) ? sections.sells : undefined;
  const offerings = sells && Array.isArray(sells.offerings) ? (sells.offerings as unknown[]) : [];
  const handling = isObj(sections.handling) ? sections.handling : {};
  offerings.forEach((o, i) => {
    const at = `sections.sells.offerings[${i}]`;
    if (!isObj(o)) {
      add("sells-scope", at, "the offering is not an object");
      return;
    }
    const label = str(o.name) || str(o.id) || String(i);
    if (!isStr(o.scope)) {
      add("sells-scope", at, `offering ${label} carries no scope`);
      return;
    }
    if (o.scope !== "open-with-focus" && o.scope !== "open-ended") return;
    const lacks: string[] = [];
    if (o.scope === "open-with-focus") {
      if (!isStr(o.focus)) lacks.push("focus");
      if (!Array.isArray(o.workspace)) lacks.push("workspace");
      const outs = (Array.isArray(o.outputs) && o.outputs.length > 0) || (isObj(o.deliverables) && Array.isArray(o.deliverables.per_task) && o.deliverables.per_task.length > 0);
      if (!outs) lacks.push("an output");
    }
    if (!Array.isArray(o.authority)) lacks.push("authority");
    if (!isObj(o.ceilings)) lacks.push("ceilings");
    else {
      for (const c of ["job_seconds", "cost_per_job"]) if (o.ceilings[c] === undefined) lacks.push(`ceilings.${c}`);
      const authority = arr<unknown>(o.authority);
      if (authority.includes("spends-money") && o.ceilings.spend_per_job === undefined) lacks.push("ceilings.spend_per_job");
      if (authority.includes("sends-messages") && o.ceilings.messages_per_job === undefined) lacks.push("ceilings.messages_per_job");
    }
    for (const l of lacks) add("open-offering-members", at, `the ${o.scope} offering ${label} lacks ${l}`);
    if (o.scope === "open-ended") {
      for (const k of CLAIM_KEYS) if (o[k] !== undefined) add("open-ended-no-claim", `${at}.${k}`, `the open-ended offering ${label} carries ${k}, a statement of what it can do`);
      // Section 6.11 also asks an open-ended agent to declare its data use; the shared reading leaves that out, so it is a warning here.
      const dataUse = ["retention_max_days", "processors", "memory"].filter((m) => handling[m] === undefined && !named(`handling.${m}`));
      if (dataUse.length) add("open-offering-members", at, `the open-ended offering ${label} has no data use in handling (${dataUse.join(", ")})`, "warn");
    }
  });

  // assembled-at and fetched-at (Section 9.3), not applied to a package AgentDoc (Section 13.4, rule 3)
  if (!isPackage) {
    if (!isStr(doc.assembled_at)) add("assembled-at", "assembled_at", "the document does not say when it was assembled");
    sources.forEach((s, i) => {
      const ok = isObj(s) && (isStr(s.fetched_at) || (s.kind === "observation" && isStr(s.at)));
      if (!ok) add("fetched-at", `sources[${i}]`, `source ${isObj(s) ? String(s.id ?? i) : i} does not say when it was fetched`);
    });
  }

  // not-stated-complete (Sections 9.5, 9.6, 9.5.1 and 13.4)
  const need = (path: string, present: boolean) => {
    if (!present && !named(path)) add("not-stated-complete", "not_stated", `${path} is absent and not named in not_stated`);
  };
  for (const name of KNOWN_SECTIONS) need(name, sections[name] !== undefined);
  if (sections.identity !== undefined) need("identity.acts_for", isObj(sections.identity) && sections.identity.acts_for !== undefined);
  if (sections.shape !== undefined) need("shape.visibility", visibility !== undefined);
  if (sections.access !== undefined) {
    need("access.schemes", isObj(sections.access) && sections.access.schemes !== undefined);
    need("access.admission", isObj(sections.access) && sections.access.admission !== undefined);
  }
  const interfaces = isObj(sections.asked) ? arr<unknown>(sections.asked.interfaces) : [];
  for (const iface of interfaces) {
    if (isObj(iface) && isStr(iface.name)) need(`asked.${iface.name}`, Array.isArray(iface.exchanges) && iface.exchanges.length > 0);
  }
  if (isPackage) for (const path of PACKAGE_NAMES) need(path, false);
  // What Section 9.5 also asks to be named, which the shared reading leaves out: warnings.
  offerings.forEach((o, i) => {
    if (!isObj(o)) return;
    if (o.inputs === undefined && !covered(notStated, offeringPaths(o, "inputs"))) add("not-stated-complete", `sections.sells.offerings[${i}]`, `offering ${str(o.name) || str(o.id) || i} lists no inputs and does not name them in not_stated`, "warn");
    if (o.outputs === undefined && o.deliverables === undefined && !covered(notStated, [...offeringPaths(o, "outputs"), ...offeringPaths(o, "deliverables")])) add("not-stated-complete", `sections.sells.offerings[${i}]`, `offering ${str(o.name) || str(o.id) || i} lists no deliverables and does not name them in not_stated`, "warn");
  });
  if (isObj(sections.configs) && arr(sections.configs.settings).length && sections.configs.tested_models === undefined) need2("configs.tested_models");
  function need2(path: string) {
    if (!named(path)) add("not-stated-complete", "not_stated", `${path} is absent and not named in not_stated`, "warn");
  }

  // no-default (Section 9.6): a path is read in the sections first, then at the top of the document.
  for (const entry of notStated) {
    const parts = entry.split(".");
    const inSections = valueAt(sections, parts);
    const v = inSections !== undefined ? inSections : valueAt(doc, parts);
    if (v !== undefined) add("no-default", `not_stated: ${entry}`, `${entry} is named in not_stated and given a value anyway`);
  }
  return findings;
}

// ── the two checks that need the sources ────────────────────────────────────

/** Members that say how the document was built, not what a source said: never looked for in a source. */
const CONSTRUCTION = new Set(["from", "state", "declared_in", "scope", "scopes", "visibility", "confirmed_at", "confirmed_by", "failed_at", "failed_by", "record", "signature", "protocol", "offered", "kind"]);

/** Every string and number a source holds, its member names included. */
function scalarsOf(v: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(v)) for (const x of v) scalarsOf(x, out);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
    out.add(k);
    scalarsOf(x, out);
  }
  else if (typeof v === "string") out.add(v);
  else if (typeof v === "number") out.add(String(v));
  return out;
}

/** Every fact of a section: each string and number, with where it is, leaving out how the document was built. */
function factsOf(v: unknown, path: string, out: Array<[string, string]>): Array<[string, string]> {
  if (Array.isArray(v)) v.forEach((x, i) => factsOf(x, `${path}[${i}]`, out));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (CONSTRUCTION.has(k) || k.endsWith("_from")) continue;
      factsOf(x, `${path}.${k}`, out);
    }
  } else if (typeof v === "string" && v.length) out.push([path, v]);
  else if (typeof v === "number") out.push([path, String(v)]);
  return out;
}

/** Check an AgentDoc. Static checks always; with `fetchSources`, the sources themselves too. */
export async function check(doc: AgentDoc | unknown, opts: CheckOptions = {}): Promise<CheckReport> {
  const findings = staticFindings(doc);
  if (opts.fetchSources && isObj(doc)) findings.push(...(await sourceFindings(doc, opts.fetch ?? globalThis.fetch)));
  return { ok: !findings.some((f) => f.level === "fail"), findings };
}

async function sourceFindings(doc: Rec, f: typeof fetch): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (rule: RuleId, path: string, message: string, level: "fail" | "warn" = "fail") => findings.push({ rule, path, message, level });
  const fetched = new Map<string, Set<string>>();
  const sources = arr<unknown>(doc.sources);
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!isObj(s) || typeof s.id !== "string") continue;
    if (s.kind === "observation") continue;
    const url = str(s.url);
    if (!/^https?:\/\//i.test(url)) {
      add("source-digest", `sources[${i}]`, `source ${s.id} has no address to fetch, so its digest cannot be checked here`, "warn");
      continue;
    }
    let bytes: Uint8Array;
    try {
      const res = await f(url, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new ReadError(`it answered ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      add("source-digest", `sources[${i}]`, `source ${s.id} at ${url} cannot be fetched: ${(e as Error).message}`);
      continue;
    }
    let value: unknown;
    try {
      value = parseBytes(bytes, url);
    } catch {
      value = undefined;
    }
    if (typeof s.digest === "string") {
      // A digest is over the exact bytes; one over the canonical JSON is accepted too, which is how a document handed in parsed, or committed by Agent SoW's terms extension, is digested.
      const exact = sha256Digest(bytes) === s.digest;
      let canonical = false;
      try {
        canonical = value !== undefined && sha256Digest(canonicalJSON(value)) === s.digest;
      } catch {
        canonical = false;
      }
      if (!exact && !canonical) add("source-digest", `sources[${i}].digest`, `source ${s.id} at ${url} no longer matches its digest: it has changed since ${str(s.fetched_at) || "it was fetched"}, so assemble again`);
    }
    if (value !== undefined) fetched.set(s.id, scalarsOf(value, new Set()));
  }

  const ids = new Set(sources.filter(isObj).map((s) => s.id));
  const sections = isObj(doc.sections) ? doc.sections : {};
  for (const [name, s] of Object.entries(sections)) {
    if (!isObj(s)) continue;
    const cited = arr<unknown>(s.from).filter((x): x is string => typeof x === "string" && ids.has(x));
    const known = cited.filter((id) => fetched.has(id));
    if (!known.length) {
      if (cited.length) add("fact-in-source", `sections.${name}`, `none of the sources the ${name} section cites could be read, so its facts were not checked`, "warn");
      continue;
    }
    const pool = new Set<string>();
    for (const id of known) for (const x of fetched.get(id)!) pool.add(x);
    const partial = known.length < cited.length;
    const { from: _f, ...rest } = s;
    for (const [path, fact] of factsOf(rest, `sections.${name}`, [])) {
      if (pool.has(fact)) continue;
      if (typeof fact === "string" && [...pool].some((x) => x.length > fact.length && x.includes(fact))) continue;
      add("fact-in-source", path, `${JSON.stringify(fact.length > 80 ? `${fact.slice(0, 77)}...` : fact)} is not in any source the ${name} section cites`, partial ? "warn" : "fail");
    }
  }
  return findings;
}

