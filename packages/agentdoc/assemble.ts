/**
 * The assembler: one AgentDoc (Common Agent Section 9) from what an agent
 * publishes.
 *
 * Card first. Given only an A2A agent's address, it reads the card at
 * `/.well-known/agent-card.json` (or the older `/.well-known/agent.json`) and
 * writes an honest AgentDoc from it: the card's members restated and cited,
 * and everything the card does not say named in `not_stated`. Where the agent
 * also serves a signed Descriptor (`/.well-known/agent-descriptor.json`), it
 * verifies the `descriptor-statement-v1` signature, cites the Descriptor at
 * its digest, and prefers it over the card wherever both speak (Sections 9.4
 * and 6.8). Signed terms, attestations and evaluation records are used when
 * they are given or the card points to them.
 *
 * It adds no fact (Section 9.3). A member enters only when a listed source
 * says it, every member a source gave enters at `declared` until an
 * evaluation record moves it, a projection that disagrees with its
 * Descriptor is reported on the source rather than merged, and silence is
 * printed by path rather than filled (Section 9.6).
 *
 * `shape.visibility` (Section 9.5.1) is computed from deployment records and
 * from who keeps the agent's door. This assembler reads neither, so it never
 * claims more than it saw: the member is absent and named in `not_stated`.
 */
import { canonicalJSON, sha256Digest } from "@common-agent/crypto";
import { KNOWN_SECTIONS, covered, offeringPaths } from "./paths.js";
import { checkDescriptorSignature, checkEvalSignature, checkTermsSignature, openAttestation } from "./signatures.js";
import type { AgentDoc, AgentDocSection, AgentDocSource, AssembleInput, DocumentInput, SignatureState } from "./types.js";
import { ReadError, arr, digestOf, fetchJson, isObj, isUrl, isoSecond, load, str, text, unique, type Loaded, type Rec } from "./util.js";
import { VERSION } from "./version.js";

/** Where an A2A card is served, newest name first. */
export const CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"] as const;
/** Where a subject serves its Descriptor (Section 6.7). */
export const DESCRIPTOR_PATH = "/.well-known/agent-descriptor.json";
/** Where a subject serves its AgentDoc (Section 9.2). */
export const AGENTDOC_PATH = "/.well-known/agentdoc.json";
/** The card extension that commits to signed terms (Agent SoW's a2a-terms). */
export const TERMS_EXTENSION = "https://agentsow.com/extensions/a2a-terms/v1";
/** Where a declared interface's machine-readable definition is looked up, by name. */
export const INTERFACE_REGISTRY = "https://agentroles.ai/interfaces/";

const ACTS_FOR = ["person", "organization", "anyone"];
const INTERACTION = ["interactive", "service"];
const SCOPES = ["task-specific", "open-with-focus", "open-ended"];
const FOCUSES = ["software", "documents", "data", "research", "operations"];
const AUTHORITY = ["reads-files", "writes-files", "reads-systems", "updates-systems", "triggers-systems", "runs-commands", "reaches-network", "sends-messages", "spends-money"];
const CEILINGS = ["job_seconds", "cost_per_job", "spend_per_job", "messages_per_job"];
const TRIAL_WHO = ["anyone", "signed_in", "verified"];
const TRIAL_COUNTS = ["per_requester_per_day", "per_day", "per_requester_ever"];
/** What an open-ended offering never carries: any statement of what it can do (Section 9.5). */
export const OPEN_ENDED_CLAIMS = ["does", "focus", "role", "can_do", "capabilities", "skills", "examples", "tags"];

/**
 * A clause quoted from Agent SoW. Its enforcement grade is carried as
 * `enforcement`, because an AgentDoc carries no member named as a grade
 * (Section 9.3), and the word would read as one. Nothing else changes.
 */
function quoteClause(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(quoteClause);
  if (!isObj(v)) return v;
  const out: Rec = {};
  for (const [k, x] of Object.entries(v)) {
    const key = k === "grade" ? "enforcement" : k.endsWith("_grade") ? `${k.slice(0, -6)}_enforcement` : k;
    out[key] = quoteClause(x);
  }
  return out;
}

/** Why nothing could be assembled, in plain words. */
export class AssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssembleError";
  }
}

/** An AgentDoc and what the assembler noticed on the way: plain sentences for a person, never part of the document. */
export interface Assembled {
  doc: AgentDoc;
  notes: string[];
}

/** Assemble an AgentDoc. */
export async function assemble(input: AssembleInput): Promise<AgentDoc> {
  return (await assembleWithNotes(input)).doc;
}

// ── a section under construction ────────────────────────────────────────────

/** A section whose members each remember their source, so a section built from several sources can say which member came from which (Section 9.3). */
class Section {
  private members: Rec = {};
  private srcOf: Record<string, string> = {};
  private cited: string[] = [];

  put(key: string, value: unknown, src: string): void {
    if (value === undefined) return;
    this.members[key] = value;
    this.srcOf[key] = src;
  }

  has(key: string): boolean {
    return key in this.members;
  }

  get(key: string): unknown {
    return this.members[key];
  }

  /** Cite a source that fills members nested below this level. */
  cite(src: string): void {
    this.cited.push(src);
  }

  build(): AgentDocSection | undefined {
    const keys = Object.keys(this.members);
    if (!keys.length) return undefined;
    const from = unique([...keys.map((k) => this.srcOf[k]!), ...this.cited]);
    const out: AgentDocSection = { from, ...this.members };
    if (from.length > 1) for (const k of keys) out[`${k}_from`] = this.srcOf[k];
    return out;
  }
}

// ── reading a Descriptor (Section 6) ────────────────────────────────────────

/** One offering's scope members as Section 6.11 reads them. */
function scopeMembers(o: Rec): Rec {
  const focus = typeof o.focus === "string" && FOCUSES.includes(o.focus) ? o.focus : undefined;
  let scope = o.scope === undefined ? "task-specific" : typeof o.scope === "string" && SCOPES.includes(o.scope) ? o.scope : "open-ended";
  if (scope === "open-with-focus" && !focus) scope = "open-ended";
  const authority = Array.isArray(o.authority) && o.authority.every((a) => typeof a === "string" && AUTHORITY.includes(a)) ? (o.authority as string[]) : undefined;
  const ceilings: Rec = {};
  if (isObj(o.ceilings)) {
    for (const [k, v] of Object.entries(o.ceilings)) {
      if (!CEILINGS.includes(k) || !isObj(v) || v.most === undefined) continue;
      ceilings[k] = { most: v.most, ...(v.decided_by === "rule" || v.decided_by === "model" ? { decided_by: v.decided_by } : {}) };
    }
  }
  return {
    scope,
    ...(focus && scope === "open-with-focus" ? { focus } : {}),
    ...(text(o.role) ? { role: o.role } : {}),
    ...(Array.isArray(o.workspace) ? { workspace: o.workspace.filter(isObj) } : {}),
    ...(authority ? { authority } : {}),
    ...(o.authority_decided_by === "rule" || o.authority_decided_by === "model" ? { authority_decided_by: o.authority_decided_by } : {}),
    ...(Object.keys(ceilings).length ? { ceilings } : {}),
  };
}

/** An offering's trial as Section 7.7 reads it; one that does not validate is no trial (Section 9.6). */
function trialOf(o: Rec): Rec {
  const t = o.trial;
  if (!isObj(t) || !TRIAL_WHO.includes(str(t.who))) return { offered: false };
  const l = t.limits;
  if (!isObj(l)) return { offered: false };
  const whole = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  if (!TRIAL_COUNTS.some((k) => whole(l[k]))) return { offered: false };
  if (Object.keys(l).some((k) => !TRIAL_COUNTS.includes(k) || !whole(l[k]))) return { offered: false };
  return { offered: true, who: t.who, ...(isObj(t.shape) ? { shape: t.shape } : {}), limits: l };
}

/** An offering's own members, as the Descriptor gives them. */
function offeringShape(o: Rec): Rec {
  const does = text(o.does) ?? text(o.description);
  return {
    ...(o.id !== undefined ? { id: o.id } : {}),
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(does ? { does } : {}),
    ...(Array.isArray(o.inputs) ? { inputs: o.inputs } : {}),
    ...(Array.isArray(o.outputs) ? { outputs: o.outputs } : {}),
    ...(isObj(o.revisions) ? { revisions: o.revisions } : {}),
  };
}

/** A Descriptor offering as it enters `sells`: an open-ended one carries no statement of what it can do (Section 9.5). */
function sellsOffering(o: Rec): Rec {
  const scope = scopeMembers(o);
  const shape = offeringShape(o);
  const open = scope.scope === "open-ended";
  if (open) for (const k of OPEN_ENDED_CLAIMS) delete shape[k];
  if (open) for (const k of OPEN_ENDED_CLAIMS) delete scope[k];
  return {
    ...shape,
    ...scope,
    ...(Array.isArray(o.steps) && o.steps.length ? { steps: o.steps.filter(isObj).map(offeringShape) } : {}),
    trial: trialOf(o),
    state: "declared",
  };
}

/** An A2A card skill as it enters `sells`: a projection of an offering, so it is task-specific, which is what an offering without a scope means (Section 6.11). */
function cardOffering(skill: Rec, card: Rec): Rec {
  const inModes = Array.isArray(skill.inputModes) ? skill.inputModes : Array.isArray(card.defaultInputModes) ? card.defaultInputModes : undefined;
  const outModes = Array.isArray(skill.outputModes) ? skill.outputModes : Array.isArray(card.defaultOutputModes) ? card.defaultOutputModes : undefined;
  return {
    ...(skill.id !== undefined ? { id: skill.id } : {}),
    ...(skill.name !== undefined ? { name: skill.name } : {}),
    ...(text(skill.description) ? { does: skill.description } : {}),
    scope: "task-specific",
    ...(inModes ? { input_modes: inModes } : {}),
    ...(outModes ? { output_modes: outModes } : {}),
    ...(Array.isArray(skill.tags) && skill.tags.length ? { tags: skill.tags } : {}),
    ...(Array.isArray(skill.examples) && skill.examples.length ? { examples: skill.examples } : {}),
    state: "declared",
  };
}

/** The security schemes a card declares, as shapes: what a caller presents, never a binding (Section 9.5, access). */
function cardSchemes(card: Rec): Rec[] | undefined {
  const declared = isObj(card.securitySchemes) ? card.securitySchemes : undefined;
  if (declared) {
    return Object.entries(declared).filter(([, v]) => isObj(v)).map(([id, v]) => {
      const s = v as Rec;
      return {
        id,
        ...(text(s.type) ? { type: s.type } : {}),
        ...(text(s.scheme) ? { scheme: s.scheme } : {}),
        ...(text(s.bearerFormat) ? { bearer_format: s.bearerFormat } : {}),
        ...(text(s.in) ? { in: s.in } : {}),
        ...(text(s.name) ? { name: s.name } : {}),
        ...(text(s.description) ? { description: s.description } : {}),
        ...(isObj(s.flows) ? { flows: Object.keys(s.flows) } : {}),
      };
    });
  }
  // An explicit empty requirement list says nothing is required; an absent one says nothing at all.
  if (Array.isArray(card.security) && card.security.length === 0) return [];
  return undefined;
}

// ── the result ──────────────────────────────────────────────────────────────

interface Context {
  f: typeof fetch;
  now: string;
  notes: string[];
  sources: AgentDocSource[];
  ids: Set<string>;
}

function newId(ctx: Context, base: string): string {
  let id = base;
  for (let n = 2; ctx.ids.has(id); n++) id = `${base}-${n}`;
  ctx.ids.add(id);
  return id;
}

function sourceEntry(id: string, kind: string, l: Loaded, signature: SignatureState, timed: boolean): AgentDocSource {
  return {
    id,
    kind,
    ...(l.url ? { url: l.url } : {}),
    ...(timed ? { fetched_at: l.fetchedAt } : {}),
    digest: l.digest,
    signature,
  };
}

async function tryLoad(ctx: Context, input: DocumentInput, what: string): Promise<Loaded | null> {
  try {
    return await load(input, ctx.f, ctx.now, what);
  } catch (e) {
    ctx.notes.push(`The ${what} could not be read: ${(e as Error).message}.`);
    return null;
  }
}

/** The address as a URL, with https assumed where no scheme is given. */
function addressUrl(address: string): URL {
  const a = address.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? a : `https://${a}`);
  } catch {
    throw new AssembleError(`${address} is not an address this tool can read. Give the agent's address, such as https://your-agent.example`);
  }
}

/** The places a card may be, for an address: the address itself when it names a JSON file, else the well-known paths under it and under its origin. */
export function cardCandidates(address: string): string[] {
  const u = addressUrl(address);
  if (/\.json$/i.test(u.pathname)) return [u.href];
  const path = u.pathname.replace(/\/+$/, "");
  return unique([...(path ? CARD_PATHS.map((p) => `${u.origin}${path}${p}`) : []), ...CARD_PATHS.map((p) => `${u.origin}${p}`)]);
}

/** The base a card was found under: the URL with its well-known suffix taken off. */
function baseOf(cardUrl: string): string {
  for (const p of CARD_PATHS) if (cardUrl.endsWith(p)) return cardUrl.slice(0, -p.length);
  return new URL(cardUrl).origin;
}

async function discoverCard(ctx: Context, address: string): Promise<Loaded | null> {
  const tried: string[] = [];
  for (const url of cardCandidates(address)) {
    tried.push(url);
    try {
      const l = await fetchJson(ctx.f, url, ctx.now);
      if (isObj(l.value)) return l;
      ctx.notes.push(`${url} is not a JSON object, so it is not an agent card.`);
    } catch (e) {
      if (!(e instanceof ReadError && e.status === 404)) ctx.notes.push(`${(e as Error).message}.`);
    }
  }
  ctx.notes.push(`No A2A Agent Card was found. Tried ${tried.join(" and ")}.`);
  return null;
}

async function discoverDescriptor(ctx: Context, bases: string[]): Promise<Loaded | null> {
  for (const base of unique(bases)) {
    const url = `${base}${DESCRIPTOR_PATH}`;
    try {
      return await fetchJson(ctx.f, url, ctx.now);
    } catch (e) {
      if (!(e instanceof ReadError && e.status === 404)) ctx.notes.push(`${(e as Error).message}.`);
    }
  }
  return null;
}

// ── assembling ──────────────────────────────────────────────────────────────

/** Assemble an AgentDoc, with plain notes on what the assembler found on the way. */
export async function assembleWithNotes(input: AssembleInput): Promise<Assembled> {
  const f = input.fetch ?? globalThis.fetch;
  const ctx: Context = { f, now: isoSecond(input.now ?? new Date()), notes: [], sources: [], ids: new Set() };
  if (input.package !== undefined) return assemblePackage(input, ctx);

  // The card: handed in, or discovered at the address.
  let card: Loaded | null = null;
  if (input.card !== undefined) card = await tryLoad(ctx, input.card, "agent card");
  else if (input.address) card = await discoverCard(ctx, input.address);
  if (card && !isObj(card.value)) {
    ctx.notes.push("The agent card is not a JSON object, so it was not used.");
    card = null;
  }

  // The Descriptor: handed in, or discovered beside the card.
  let desc: Loaded | null = null;
  if (input.descriptor !== undefined) desc = await tryLoad(ctx, input.descriptor, "Descriptor");
  else {
    const bases: string[] = [];
    if (card?.url) bases.push(baseOf(card.url));
    if (input.address) bases.push(addressUrl(input.address).origin);
    if (bases.length) desc = await discoverDescriptor(ctx, bases);
  }
  if (!card && !desc) {
    throw new AssembleError(
      input.address
        ? `Nothing to assemble from: ${input.address} serves no A2A Agent Card and no Descriptor. ${ctx.notes.join(" ")}`.trim()
        : "Nothing to assemble from. Give an agent's address, its card or its Descriptor.",
    );
  }

  const c: Rec = card && isObj(card.value) ? card.value : {};
  const cardId = card ? newId(ctx, "card") : "";
  if (card) {
    const signed = Array.isArray(c.signatures) && c.signatures.length > 0;
    ctx.sources.push(sourceEntry(cardId, "a2a-card", card, signed ? "not_checked" : "unsigned", true));
  }

  // The Descriptor is used only when it is one and its signature does not fail.
  let d: Rec | null = null;
  let descId = "";
  if (desc) {
    descId = newId(ctx, "descriptor");
    const v = desc.value;
    const sig = checkDescriptorSignature(v);
    const entry = sourceEntry(descId, "agent-descriptor", desc, sig.state, true);
    if (isObj(v) && v.agent_version !== undefined) entry.agent_version = String(v.agent_version);
    if (!isObj(v) || v.format !== "agent-descriptor-v1") {
      entry.not_used = "it is not an agent-descriptor-v1 document";
      ctx.notes.push("The Descriptor is not an agent-descriptor-v1 document, so it was not used.");
    } else if (sig.state === "failed") {
      entry.not_used = `its signature does not verify (${sig.note ?? "failed"})`;
      ctx.notes.push(`The Descriptor's signature does not verify: ${sig.note ?? "it failed"}. Nothing in it was used. Sign it again with common-agent-doc sign.`);
    } else {
      d = v;
      if (sig.state === "unsigned") ctx.notes.push("The Descriptor is not signed. Readers take it only as far as the place it was fetched from. Sign it with common-agent-doc sign.");
      if (sig.state === "not_checked") ctx.notes.push(`The Descriptor's signature was not checked: ${sig.note}.`);
    }
    ctx.sources.push(entry);
  }

  // A card is a projection of the Descriptor (Section 6.8): a disagreement is reported on the card, never merged.
  if (card && d) {
    const dis: string[] = [];
    if (text(c.description) && text(d.does) && text(c.description) !== text(d.does)) dis.push(`the card's description differs from the Descriptor's does`);
    if (text(c.version) && d.agent_version !== undefined && text(c.version) !== String(d.agent_version)) dis.push(`the card's version "${c.version}" differs from the Descriptor's agent_version "${String(d.agent_version)}"`);
    const offered = new Set(arr(d.offerings).filter(isObj).map((o) => str(o.id)));
    const skills = arr(c.skills).filter(isObj).map((s) => str(s.id)).filter(Boolean);
    const extra = skills.filter((s) => !offered.has(s));
    if (extra.length) dis.push(`the card lists skill${extra.length === 1 ? "" : "s"} ${extra.join(", ")} that the Descriptor does not offer`);
    const missing = [...offered].filter((o) => o && !skills.includes(o));
    if (skills.length && missing.length) dis.push(`the Descriptor offers ${missing.join(", ")}, which the card does not list`);
    if (dis.length) {
      ctx.sources.find((s) => s.id === cardId)!.disagreements = dis;
      for (const x of dis) ctx.notes.push(`Disagreement: ${x}. The Descriptor's value is used.`);
    }
  }

  const sections: Record<string, AgentDocSection> = {};
  const offerings = buildSells(ctx, c, cardId, d, descId);
  const usedTerms = await readTerms(ctx, input, c, cardId);

  // identity
  const identity = new Section();
  if (card) {
    identity.put("name", text(c.name), cardId);
    if (!d) identity.put("description", text(c.description), cardId);
    const provider = isObj(c.provider) ? c.provider : {};
    identity.put("operator", text(provider.organization), cardId);
    identity.put("url", text(provider.url), cardId);
    if (!d) identity.put("version", text(c.version), cardId);
    identity.put("documentation", text(c.documentationUrl), cardId);
  }
  if (d) {
    identity.put("description", text(d.does), descId);
    if (d.agent_version !== undefined) identity.put("version", String(d.agent_version), descId);
    const subj = isObj(d.subject) ? d.subject : {};
    identity.put("handle", text(subj.handle), descId);
    if (typeof d.acts_for === "string" && ACTS_FOR.includes(d.acts_for)) {
      identity.put("acts_for", d.acts_for, descId);
      if (d.acts_for === "organization") identity.put("organization_name", text(d.organization_name), descId);
    }
    if (typeof d.fleet === "boolean") identity.put("fleet", d.fleet, descId);
  }
  setSection(sections, "identity", identity);

  // shape: whether a person attends it. visibility is never computed here (see the head of this file).
  if (d && typeof d.interaction === "string" && INTERACTION.includes(d.interaction)) {
    const shape = new Section();
    shape.put("interaction", d.interaction, descId);
    setSection(sections, "shape", shape);
  }

  if (d) descriptorSections(sections, d, descId);

  // asked: each declared interface, with the exchanges its published definition lists.
  if (d && arr(d.interfaces).length) sections.asked = await askedSection(ctx, d, descId, true);

  // sells
  if (offerings.list.length) {
    const sells = new Section();
    sells.put("scopes", unique(offerings.list.map((o) => str(o.scope))), offerings.src);
    sells.put("offerings", offerings.list, offerings.src);
    if (d && text(d.samples_ref)) sells.put("samples_ref", d.samples_ref, descId);
    for (const t of usedTerms) {
      let priced = false;
      for (const o of offerings.list) {
        if (!t.offerings.has(str(o.id)) || o.price !== undefined) continue;
        const price = isObj(t.value.price) ? (quoteClause(t.value.price) as Rec) : undefined;
        if (!price) continue;
        o.price = price;
        o.price_from = t.id;
        if (typeof price.arrangement === "string") {
          o.arrangement = price.arrangement;
          o.arrangement_from = t.id;
        }
        priced = true;
      }
      if (priced) sells.cite(t.id);
    }
    setSection(sections, "sells", sells);
  }

  // access: where a message is sent and what a caller presents, from the card; the per-caller limits, from the Descriptor.
  const access = new Section();
  if (card) {
    access.put("address", text(c.url), cardId);
    if (text(c.url)) access.put("protocol", "a2a", cardId);
    access.put("transport", text(c.preferredTransport), cardId);
    access.put("protocol_version", text(c.protocolVersion), cardId);
    access.put("schemes", cardSchemes(c), cardId);
    const caps = isObj(c.capabilities) ? c.capabilities : {};
    const capabilities: Rec = {};
    if (typeof caps.streaming === "boolean") capabilities.streaming = caps.streaming;
    if (typeof caps.pushNotifications === "boolean") capabilities.push_notifications = caps.pushNotifications;
    if (Object.keys(capabilities).length) access.put("capabilities", capabilities, cardId);
  }
  if (d && isObj(d.limits)) access.put("limits", d.limits, descId);
  setSection(sections, "access", access);

  // handling: where it runs, from the Descriptor; where content is processed and how long it is kept, from signed terms.
  const handling = new Section();
  if (d && arr(d.hosted_in).length) handling.put("hosted_in", d.hosted_in, descId);
  const conf = usedTerms.find((t) => isObj(t.value.confidentiality));
  if (conf) {
    const k = conf.value.confidentiality as Rec;
    if (Array.isArray(k.processed_in)) handling.put("processed_in", k.processed_in, conf.id);
    if (isObj(k.retention) && typeof k.retention.max_days === "number") handling.put("retention_max_days", k.retention.max_days, conf.id);
    if (Array.isArray(k.processors)) handling.put("processors", quoteClause(k.processors), conf.id);
    if (isObj(k.promises)) handling.put("promises", quoteClause(k.promises), conf.id);
  }
  setSection(sections, "handling", handling);

  const subjectId = d && isObj(d.subject) && text(d.subject.id) ? String(d.subject.id) : undefined;
  applyEvalRecords(ctx, sections, input.evalRecords ?? [], subjectId);
  applyAttestations(ctx, sections, input.attestations ?? []);

  // The subject: its key where a Descriptor binds one, else the card's address, which is the most stable name the card gives.
  const subject: { id: string; handle?: string; name?: string } = {
    id: subjectId ?? text(c.url) ?? (card?.url ? new URL(card.url).origin : undefined) ?? (input.address ? addressUrl(input.address).origin : undefined) ?? (card ?? desc)!.digest,
    ...(d && isObj(d.subject) && text(d.subject.handle) ? { handle: String(d.subject.handle) } : {}),
    ...(text(c.name) ? { name: String(c.name) } : {}),
  };

  const doc: AgentDoc = {
    agentdoc: "v1",
    subject,
    assembled_at: ctx.now,
    assembled_by: input.assembledBy ?? `@common-agent/agentdoc ${VERSION}; the assembly is not signed`,
    sources: ctx.sources,
    sections,
    not_stated: notStatedOf(sections, { pkg: false, card: !!card }),
    signatures: [],
  };
  return { doc, notes: ctx.notes };
}

function setSection(sections: Record<string, AgentDocSection>, name: string, s: Section): void {
  const built = s.build();
  if (built) sections[name] = built;
}

/** The offerings, from the Descriptor where there is one, else from the card's skills. */
function buildSells(ctx: Context, c: Rec, cardId: string, d: Rec | null, descId: string): { list: Rec[]; src: string } {
  if (d) return { list: arr(d.offerings).filter(isObj).map(sellsOffering), src: descId };
  if (cardId) return { list: arr(c.skills).filter(isObj).map((s) => cardOffering(s, c)), src: cardId };
  void ctx;
  return { list: [], src: "" };
}

/** The sections only a Descriptor fills: role, refuses, reaches, leaves and configs. */
function descriptorSections(sections: Record<string, AgentDocSection>, d: Rec, descId: string): void {
  if (text(d.role)) {
    const role = new Section();
    role.put("name", d.role, descId);
    role.put("declared_in", "descriptor", descId);
    role.put("state", "declared", descId);
    setSection(sections, "role", role);
  }

  // What it refuses and what it hands to a person: both the operator's own sentences, carried as prose.
  const refusals = typeof d.refusals === "string" ? text(d.refusals) : Array.isArray(d.refusals) ? d.refusals.filter((x) => typeof x === "string" && x.trim()).join("\n") || undefined : undefined;
  const handsOver = arr<unknown>(d.escalates).filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  const refuses = new Section();
  if (refusals) {
    refuses.put("statement", refusals, descId);
    refuses.put("kind", "prose", descId);
  }
  if (handsOver.length) refuses.put("hands_over", handsOver, descId);
  setSection(sections, "refuses", refuses);

  // reaches: the standing systems, `role` read as the alias of `name` (Section 6.2).
  const systems = arr(d.systems).filter(isObj).map((s) => {
    const { role, name, ...rest } = s;
    const n = name ?? role;
    return { ...(n !== undefined ? { name: n } : {}), ...rest };
  });
  const ceilings = arr(d.ceilings).filter((x) => isObj(x) && typeof x.system === "string");
  const reaches = new Section();
  if (systems.length) reaches.put("systems", systems, descId);
  if (ceilings.length) reaches.put("ceilings", ceilings, descId);
  setSection(sections, "reaches", reaches);

  const records = arr(d.records).filter((r) => isObj(r) && typeof r.name === "string");
  if (records.length) {
    const leaves = new Section();
    leaves.put("records", records, descId);
    setSection(sections, "leaves", leaves);
  }

  // configs: an agent whose Descriptor has no run_config takes no settings (Section 6.2), which is a statement, not silence.
  const configs = new Section();
  const rc = isObj(d.run_config) ? d.run_config : undefined;
  configs.put("settings", rc && Array.isArray(rc.settings) ? rc.settings.filter(isObj) : [], descId);
  if (rc && Array.isArray(rc.tested_models)) configs.put("tested_models", rc.tested_models, descId);
  if (rc && Array.isArray(rc.named)) configs.put("named", rc.named.filter(isObj).map((n) => ({ ...(n.name !== undefined ? { name: n.name } : {}), ...(n.digest !== undefined ? { digest: n.digest } : {}) })), descId);
  if (rc && typeof rc.replay === "boolean") configs.put("replay", rc.replay, descId);
  setSection(sections, "configs", configs);
}

/** The `asked` section: every declared interface, each with the exchanges its definition publishes, each at `declared`. */
async function askedSection(ctx: Context, d: Rec, descId: string, resolve: boolean): Promise<AgentDocSection> {
  const from = [descId];
  const interfaces: Rec[] = [];
  for (const name of arr<unknown>(d.interfaces).filter((x): x is string => typeof x === "string" && x.trim().length > 0)) {
    let def: Loaded | null = null;
    if (resolve) {
      const url = isUrl(name) ? name : `${INTERFACE_REGISTRY}${encodeURIComponent(name)}.json`;
      try {
        def = await fetchJson(ctx.f, url, ctx.now);
      } catch {
        def = null;
      }
    }
    const v = def && isObj(def.value) ? def.value : null;
    const exchanges = v ? arr(v.exchanges).filter(isObj) : [];
    if (def && exchanges.length) {
      const id = newId(ctx, `iface-${name.replace(/[^A-Za-z0-9_-]+/g, "-")}`);
      ctx.sources.push(sourceEntry(id, "interface-definition", def, Array.isArray(v!.signatures) && v!.signatures.length ? "not_checked" : "unsigned", true));
      from.push(id);
      interfaces.push({
        name,
        ...(text(v!.version) ? { version: v!.version } : {}),
        ...(text(v!.definition) ? { definition: v!.definition } : {}),
        declared_in: descId,
        definition_from: id,
        exchanges: exchanges.map((e) => ({
          ...(e.id !== undefined ? { id: e.id } : {}),
          ...(e.asks !== undefined ? { asks: e.asks } : {}),
          ...(Array.isArray(e.answer_carries) ? { answer_carries: e.answer_carries } : {}),
          state: "declared",
        })),
      });
    } else {
      if (resolve) ctx.notes.push(`The definition of the interface ${name} could not be read, so its exchanges are not listed.`);
      interfaces.push({ name, declared_in: descId });
    }
  }
  return { from, interfaces };
}

interface UsedTerms {
  id: string;
  value: Rec;
  offerings: Set<string>;
}

/** Read signed terms: those handed in, and those the card's terms extension commits to. Only a verified proposal is used (Agent SoW a2a-terms, Section 7). */
async function readTerms(ctx: Context, input: AssembleInput, c: Rec, cardId: string): Promise<UsedTerms[]> {
  const wanted: Array<{ input: DocumentInput; committed?: string; offering?: string; via?: string }> = [];
  for (const t of input.terms ?? []) wanted.push({ input: t });
  if (cardId && isObj(c.capabilities)) {
    for (const ext of arr(c.capabilities.extensions).filter(isObj)) {
      if (ext.uri !== TERMS_EXTENSION || !isObj(ext.params)) continue;
      for (const p of arr(ext.params.proposals).filter(isObj)) {
        if (!text(p.url) || !isUrl(str(p.url))) continue;
        if (wanted.some((w) => w.input === p.url)) continue;
        wanted.push({ input: str(p.url), committed: text(p.digest), offering: text(p.offering), via: cardId });
      }
    }
  }
  const used: UsedTerms[] = [];
  for (const w of wanted) {
    const l = await tryLoad(ctx, w.input, "terms");
    if (!l) continue;
    const id = newId(ctx, "terms");
    const sig = checkTermsSignature(l.value);
    const entry = sourceEntry(id, "sow-standing-proposal", l, sig.state, true);
    let why: string | undefined;
    if (!isObj(l.value)) why = "it is not a JSON object";
    else if (w.committed && w.committed !== sha256Digest(canonicalJSON(l.value)) && w.committed !== l.digest) why = "its digest is not the one the card commits to";
    else if (sig.state !== "verified") why = sig.state === "unsigned" ? "it carries no provider signature, so it is a suggestion, not terms" : `its provider signature does not verify (${sig.note ?? sig.state})`;
    if (w.via) entry.committed_by = w.via;
    if (why) {
      entry.not_used = why;
      ctx.notes.push(`Terms at ${l.url ?? "the given file"} were not used: ${why}.`);
    } else {
      const v = l.value as Rec;
      const scope = isObj(v.scope) ? v.scope : {};
      const offerings = new Set(arr<unknown>(scope.offerings).filter((x): x is string => typeof x === "string"));
      if (w.offering) offerings.add(w.offering);
      used.push({ id, value: v, offerings });
    }
    ctx.sources.push(entry);
  }
  return used;
}

/** Evaluation records (Section 8.4): listed like any source, and applied case by case, never wholesale, only when verified and about this subject. */
function applyEvalRecords(ctx: Context, sections: Record<string, AgentDocSection>, records: object[], subjectId: string | undefined): void {
  const standing = sections.standing ?? { from: [] as string[] };
  const entries = arr(standing.entries);
  for (const rec of records) {
    const id = newId(ctx, "eval");
    const sig = checkEvalSignature(rec);
    const r = isObj(rec) ? rec : {};
    ctx.sources.push({ id, kind: "eval-record", fetched_at: ctx.now, digest: digestOf(rec), signature: sig.state });
    entries.push({
      kind: "eval-record",
      ...(text(r.by) ?? sig.by ? { by: text(r.by) ?? sig.by } : {}),
      ...(text(r.produced_at) ? { as_of: r.produced_at } : {}),
      ...(typeof r.conforms === "boolean" ? { conforms: r.conforms } : {}),
      signature: sig.state,
      record: id,
    });
    standing.from = unique([...standing.from, id]);
    const about = isObj(r.subject) ? r.subject.agent_key : undefined;
    if (sig.state !== "verified" || !subjectId || about !== subjectId) {
      if (sig.state === "verified" && about !== subjectId) ctx.notes.push("An evaluation record names another subject, so it moved nothing.");
      continue;
    }
    const at = text(r.produced_at);
    const move = (target: Rec, verdict: unknown): boolean => {
      if (verdict === "pass") {
        target.state = "confirmed";
        if (at) target.confirmed_at = at;
        target.confirmed_by = id;
        return true;
      }
      if (verdict === "fail") {
        target.state = "failed";
        if (at) target.failed_at = at;
        target.failed_by = id;
        return true;
      }
      return false;
    };
    const asked = sections.asked;
    const sells = sections.sells;
    for (const cs of arr(r.cases).filter(isObj)) {
      const names = [str(cs.source), str(cs.id)].filter(Boolean);
      for (const iface of arr(asked?.interfaces).filter(isObj)) {
        for (const ex of arr(iface.exchanges).filter(isObj)) {
          const keys = ["/", ".", ":"].map((sep) => `${str(iface.name)}${sep}${str(ex.id)}`);
          if (names.some((n) => keys.includes(n)) && move(ex, cs.verdict) && asked) asked.from = unique([...asked.from, id]);
        }
      }
      for (const o of arr(sells?.offerings).filter(isObj)) {
        const keys = [str(o.id), `offering:${str(o.id)}`, `offerings/${str(o.id)}`];
        if (o.id !== undefined && names.some((n) => keys.includes(n)) && move(o, cs.verdict) && sells) sells.from = unique([...sells.from, id]);
      }
    }
    // An open-with-focus offering's result on an evaluation set: the record's own counts, cited, never rounded into a rating (Section 9.5).
    if (sells && text(r.offering) && isObj(r.evaluation_set) && isObj(r.result)) {
      const o = arr(sells.offerings).filter(isObj).find((x) => x.id === r.offering);
      if (o) {
        o.evaluated_against = [...arr(o.evaluated_against), { set: r.evaluation_set, result: r.result, record: id }];
        sells.from = unique([...sells.from, id]);
      }
    }
  }
  if (entries.length) sections.standing = { ...standing, entries };
}

/** Attestations: carried, attributed and never audited (Section 9.5, standing). A failed one is shown, not dropped (Section 8.1). */
function applyAttestations(ctx: Context, sections: Record<string, AgentDocSection>, attestations: object[]): void {
  if (!attestations.length) return;
  const standing = sections.standing ?? { from: [] as string[] };
  const entries = arr(standing.entries);
  for (const a of attestations) {
    const opened = openAttestation(a);
    const id = newId(ctx, "attestation");
    const state = opened?.check.state ?? "failed";
    ctx.sources.push({ id, kind: "attestation", fetched_at: ctx.now, digest: digestOf(a), signature: state });
    standing.from = unique([...standing.from, id]);
    if (!opened) {
      entries.push({ kind: "attestation", signature: state, record: id });
      ctx.notes.push("An attestation could not be read; it is listed as failed.");
      continue;
    }
    const st = opened.statement;
    const pr = isObj(st.predicate) ? st.predicate : st;
    const attester = isObj(pr.attester) ? pr.attester : undefined;
    const subj = arr(st.subject).filter(isObj)[0];
    const areas: Rec = {};
    if (isObj(pr.areas)) for (const [k, v] of Object.entries(pr.areas)) areas[k] = isObj(v) ? v.result : v;
    entries.push({
      kind: "attestation",
      ...(attester && text(attester.name) ? { by: attester.name } : text(pr.by) ? { by: pr.by } : opened.check.by ? { by: opened.check.by } : {}),
      ...(attester && text(attester.id) ? { by_key: attester.id } : {}),
      ...(subj ? { about: { ...(text(subj.name) ? { name: subj.name } : {}), ...(isObj(subj.digest) && text(subj.digest.sha256) ? { sha256: subj.digest.sha256 } : {}) } } : {}),
      ...(text(pr.checked_at) ?? text(pr.produced_at) ? { as_of: text(pr.checked_at) ?? text(pr.produced_at) } : {}),
      ...(text(pr.expires_at) ? { expires_at: pr.expires_at } : {}),
      ...(Object.keys(areas).length ? { areas } : {}),
      ...(text(pr.words) ? { words: pr.words } : {}),
      signature: state,
      record: id,
    });
  }
  sections.standing = { ...standing, entries };
}

// ── silence, printed ────────────────────────────────────────────────────────

/**
 * The paths a document names in `not_stated`: every section nobody sourced,
 * and every member Section 9 says a reader must be told is missing.
 */
export function notStatedOf(sections: Record<string, AgentDocSection>, opts: { pkg: boolean; card: boolean }): string[] {
  const out: string[] = [];
  if (opts.pkg) out.push("subject");
  const add = (p: string) => {
    if (!covered(out, [p])) out.push(p);
  };
  for (const name of KNOWN_SECTIONS) if (!sections[name]) add(name);

  const id = sections.identity;
  if (id) for (const m of ["name", "operator", "acts_for"]) if (id[m] === undefined) add(`identity.${m}`);
  if (sections.shape && sections.shape.visibility === undefined) add("shape.visibility");
  const access = sections.access;
  if (access) for (const m of ["schemes", "admission"]) if (access[m] === undefined) add(`access.${m}`);

  const offerings = arr(sections.sells?.offerings).filter(isObj);
  const members = ["inputs", "outputs", ...(opts.pkg ? [] : ["price"])];
  for (const m of members) {
    const lacking = offerings.filter((o) => o[m] === undefined && !(m === "outputs" && o.deliverables !== undefined));
    if (!lacking.length) continue;
    if (lacking.length === offerings.length && offerings.length > 1) add(`sells.offerings.${m}`);
    else for (const o of lacking) add(offeringPaths(o, m)[0]!);
  }
  if (opts.pkg) add("sells.offerings.price");
  if (opts.pkg) add("shape.visibility");
  if (sections.sells) add("sells.samples");

  for (const i of arr(sections.asked?.interfaces).filter(isObj)) if (!arr(i.exchanges).length) add(`asked.${str(i.name)}`);
  const configs = sections.configs;
  if (configs && arr(configs.settings).length && configs.tested_models === undefined) add("configs.tested_models");

  const handling = sections.handling;
  if (handling) for (const m of ["processed_in", "retention_max_days", "processors", "memory"]) if (handling[m] === undefined) add(`handling.${m}`);
  return out;
}

// ── the package AgentDoc (Section 13.4) ────────────────────────────────────

/**
 * A package AgentDoc: assembled from the package's manifest and its draft
 * Descriptor alone, with `package` in place of `subject`, no assembly time
 * and no fetch time, so the same package always gives the same bytes. It
 * carries no subject, access, standing, price or handling, and names each.
 */
async function assemblePackage(input: AssembleInput, ctx: Context): Promise<Assembled> {
  if (input.descriptor === undefined) throw new AssembleError("A package AgentDoc needs the package's draft Descriptor as well as its manifest.");
  const man = await load(input.package!, ctx.f, ctx.now, "package manifest");
  const desc = await load(input.descriptor, ctx.f, ctx.now, "Descriptor");
  const m = isObj(man.value) ? man.value : {};
  const d = isObj(desc.value) ? desc.value : null;
  if (!d || d.format !== "agent-descriptor-v1") throw new AssembleError("The package's Descriptor is not an agent-descriptor-v1 document.");
  if (isObj(d.subject) && d.subject.id !== undefined) {
    throw new AssembleError("This Descriptor names a subject, so it describes an agent that exists. A package AgentDoc describes no running agent (Section 13.4).");
  }
  const descEntry = sourceEntry(newId(ctx, "descriptor"), "agent-descriptor", desc, "unsigned", false);
  if (d.agent_version !== undefined) descEntry.agent_version = String(d.agent_version);
  const pkgEntry = sourceEntry(newId(ctx, "package"), "plugin-package", man, "unsigned", false);
  if (text(m.version)) pkgEntry.agent_version = String(m.version);
  // The manifest points at its Descriptor by digest; a package paired with another Descriptor names the wrong agent.
  const ext = isObj(m.extensions) && isObj(m.extensions["net.agentdoc.package"]) ? m.extensions["net.agentdoc.package"] : {};
  const pointed = isObj(ext.descriptor) ? text(ext.descriptor.sha256) : undefined;
  if (pointed && `sha256:${pointed.replace(/^sha256:/, "")}` !== desc.digest) {
    pkgEntry.disagreements = [`the manifest points at Descriptor sha256:${pointed.replace(/^sha256:/, "")}, and the Descriptor given is ${desc.digest}`];
    ctx.notes.push(`Disagreement: ${pkgEntry.disagreements[0]}.`);
  }
  ctx.sources.push(descEntry, pkgEntry);
  const descId = descEntry.id;
  const pkgId = pkgEntry.id;

  const sections: Record<string, AgentDocSection> = {};
  const identity = new Section();
  identity.put("name", text(m.name), pkgId);
  identity.put("description", text(d.does) ?? text(m.description), text(d.does) ? descId : pkgId);
  identity.put("version", text(m.version) ?? (d.agent_version !== undefined ? String(d.agent_version) : undefined), text(m.version) ? pkgId : descId);
  setSection(sections, "identity", identity);
  if (typeof d.interaction === "string" && INTERACTION.includes(d.interaction)) {
    const shape = new Section();
    shape.put("interaction", d.interaction, descId);
    setSection(sections, "shape", shape);
  }
  descriptorSections(sections, d, descId);
  if (arr(d.interfaces).length) sections.asked = await askedSection(ctx, d, descId, false);
  const list = arr(d.offerings).filter(isObj).map(sellsOffering);
  if (list.length) {
    const sells = new Section();
    sells.put("scopes", unique(list.map((o) => str(o.scope))), descId);
    sells.put("offerings", list, descId);
    setSection(sections, "sells", sells);
  }
  const doc: AgentDoc = {
    agentdoc: "v1",
    package: { ...(text(m.name) ? { name: String(m.name) } : {}), ...(text(m.version) ? { version: String(m.version) } : {}) },
    assembled_by: input.assembledBy ?? `@common-agent/agentdoc ${VERSION}; assembled from the package, not signed`,
    sources: ctx.sources,
    sections,
    not_stated: notStatedOf(sections, { pkg: true, card: false }),
    signatures: [],
  };
  return { doc, notes: ctx.notes };
}
