/**
 * The human page (Section 9.8): one self-contained HTML file rendered from
 * the AgentDoc alone, readable without JavaScript.
 *
 * What it keeps from Section 9.8: every section shows which sources it came
 * from; `not_stated` is shown as plainly as what was stated; the assembly time
 * is shown, and `stale_after` where there is one; nothing is added that the
 * document does not hold, so there is no badge, score or trust mark. And the
 * four differences that vanish once lost: an absent `reaches` is not an empty
 * reach, a grant is shown apart from a file, an absent `access` is not an open
 * door, and an open offering is shown with its scope in words, never as a
 * list of work it can do.
 *
 * Nothing is presented above what `shape.visibility` supports (Section
 * 9.5.1). A ceiling decided by rule is shown as the operator's word that a
 * rule holds the agent to it, and as enforced only where the document itself
 * marks it so at a visibility that allows it.
 */
import type { AgentDoc, AgentDocSource } from "./types.js";
import { arr, isObj, joinWords, str, type Rec } from "./util.js";

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const utc = (iso: unknown): string => {
  const m = str(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]} ${m[2]}${m[3] ? `:${m[3]}` : ""} UTC` : str(iso);
};
const shortDigest = (d: unknown): string => {
  const s = str(d);
  return s.length > 24 ? `${s.slice(0, 15)}…${s.slice(-6)}` : s;
};
const words = (v: unknown): string => (Array.isArray(v) ? joinWords(v.map((x) => String(x))) : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""));

/** What a source is, in words. */
function sourceLabel(s: AgentDocSource | undefined, id: string): string {
  if (!s) return id;
  switch (s.kind) {
    case "a2a-card": return "the agent card";
    case "agent-descriptor": return "the Descriptor";
    case "sow-standing-proposal": return "signed terms";
    case "eval-record": return "an evaluation record";
    case "attestation": return "an attestation";
    case "plugin-package": return "the package manifest";
    case "interface-definition": return `the ${id.replace(/^iface-/, "")} interface definition`;
    case "observation": return "an observation";
    default: return id;
  }
}

const SIG_WORDS: Record<string, string> = {
  verified: "signature verified",
  unsigned: "not signed",
  failed: "signature does not verify",
  not_checked: "signature not checked",
};

/** What a `not_stated` path means to a reader. */
function notStatedWords(p: string): [string, string] {
  const table: Record<string, [string, string]> = {
    identity: ["who it is", "nothing says who runs it or what it is called"],
    "identity.name": ["its name", "no source gives it a name"],
    "identity.operator": ["who runs it", "no operator is named"],
    "identity.acts_for": ["whom it acts for", "it has not said whether it acts for a person, an organization or anyone. Nothing here guesses."],
    shape: ["whether a person attends it", "it has not said whether it runs as a service or with a person in the loop"],
    "shape.visibility": ["how much of it can be checked", "no record here says what stands behind its door"],
    asked: ["which standard questions it answers", "it declares no standard interface"],
    role: ["which standard role it holds", "it declares no role"],
    sells: ["what it offers", "no offerings are declared"],
    "sells.samples": ["samples of its work", "no samples were read for this document"],
    "sells.offerings.price": ["its prices", "no signed terms give a price. That does not mean it is free."],
    access: ["how to reach it and who it lets in", "nothing says where to send a message or what to present. That is not an open door."],
    "access.schemes": ["what a caller presents", "its card does not say. Do not assume nothing is needed."],
    "access.admission": ["who it lets in", "no admission policy is published. It may still refuse you."],
    refuses: ["what it refuses", "no refusals are stated. That is silence, not a promise to do anything asked."],
    reaches: ["what systems it reaches", "no standing systems are declared. That is not a promise that it reaches nothing."],
    leaves: ["what records a job leaves", "no records are declared"],
    configs: ["what a job may set", "nothing says which settings a job may choose"],
    "configs.tested_models": ["which models were tested", "settings are declared, and no tested models are listed, so treat every model as untested"],
    handling: ["where your content goes and how long it is kept", "nothing says where content is processed or kept. It has promised to delete nothing."],
    "handling.processed_in": ["where your content is processed", "no place is named, so it may be anywhere"],
    "handling.retention_max_days": ["how long it keeps what you send", "it has promised to delete nothing"],
    "handling.processors": ["which services see your content", "no processors are named"],
    "handling.memory": ["whether it remembers one job in the next", "it has not said, so do not assume each job starts clean"],
    standing: ["what others have published about it", "no attestation, evaluation or report was read"],
    subject: ["which agent this is", "a package describes no running agent until someone installs it"],
  };
  if (table[p]) return table[p]!;
  const off = p.match(/^sells\.offerings\.(.+)\.(inputs|outputs|price|deliverables)$/);
  if (off) return [`${off[2] === "price" ? "the price" : off[2] === "inputs" ? "what to send" : "what comes back"} for ${off[1]}`, off[2] === "price" ? "no signed terms price it. That does not mean it is free." : "nothing says, so it has not promised it"];
  const m = p.match(/^sells\.offerings\.(inputs|outputs)$/);
  if (m) return [m[1] === "inputs" ? "what to send each offering" : "what each offering returns", "no offering says, so none has promised it"];
  if (p.startsWith("asked.")) return [`the ${p.slice(6)} interface's questions`, "it declares the interface, and its definition could not be read"];
  return [p, ""];
}

const AUTHORITY_WORDS: Record<string, string> = {
  "reads-files": "reads files in its workspace",
  "writes-files": "creates, changes and deletes files in its workspace",
  "reads-systems": "reads a standing system",
  "updates-systems": "changes the records a standing system holds",
  "triggers-systems": "sets off actions in a standing system",
  "runs-commands": "runs programs on its host or in its workspace",
  "reaches-network": "reaches network addresses no declared system names",
  "sends-messages": "sends messages to parties other than you",
  "spends-money": "commits money on your or its owner's behalf",
};
const CEILING_WORDS: Record<string, string> = {
  job_seconds: "seconds one job runs",
  cost_per_job: "what one job costs you",
  spend_per_job: "what one job may spend for you",
  messages_per_job: "messages one job sends to others",
};
const KIND_WORDS: Record<string, string> = {
  text: "text",
  "text/plain": "text",
  "text/markdown": "text (Markdown)",
  "text/html": "a web page",
  "application/json": "data (JSON)",
  "application/pdf": "a PDF",
  "text/csv": "a table (CSV)",
  url: "a link",
  identifier: "a name or id",
  document: "a file",
};
const kindWords = (k: unknown): string => KIND_WORDS[str(k).toLowerCase()] ?? (str(k) || "not stated");

const money = (v: unknown): string => {
  if (isObj(v) && Number.isInteger(v.amount_micro)) return `${((v.amount_micro as number) / 1e6).toFixed(2)} ${str(v.currency) || ""}`.trim();
  return typeof v === "number" ? String(v) : words(v);
};

function table(head: string[], rows: string[][]): string {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

const p = (s: string) => `<p>${s}</p>`;
const note = (s: string) => `<p class="note">${s}</p>`;

/** Render an AgentDoc as a self-contained page. */
export function render(doc: AgentDoc): string {
  const s = isObj(doc.sections) ? (doc.sections as Record<string, Rec>) : {};
  const sources = arr<AgentDocSource>(doc.sources).filter(isObj) as AgentDocSource[];
  const byId = new Map(sources.map((x) => [x.id, x]));
  const notStated = arr<unknown>(doc.not_stated).filter((x): x is string => typeof x === "string");
  const isPackage = doc.package !== undefined && doc.subject === undefined;
  const identity = s.identity ?? {};
  const visibility = str(s.shape?.visibility);
  const name = str(identity.name) || str(doc.subject?.name) || str(doc.package?.name) || str(doc.subject?.handle) || "An agent with no name stated";

  const fromLine = (sec: Rec | undefined): string => {
    const ids = arr<string>(sec?.from).filter((x) => typeof x === "string");
    return ids.length ? `from ${joinWords(ids.map((id) => sourceLabel(byId.get(id), id)))}` : "";
  };
  const absent = (path: string): string => {
    const [w, means] = notStatedWords(path);
    return `<p class="absent"><span class="tag">not stated</span> ${esc(w)}${means ? `: ${esc(means)}` : ""}.</p>`;
  };
  const band = (id: string, title: string, sec: Rec | undefined, body: string, path = id): string => `
<details open id="${esc(id)}" class="band">
  <summary><h2>${esc(title)}</h2><span class="from">${sec ? esc(fromLine(sec)) : "not stated"}</span></summary>
  <div class="body">${sec ? body : absent(path)}</div>
</details>`;
  const enforcedWords = (c: Rec): string => {
    if (c.enforced === true && c.decided_by === "rule" && visibility === "verifiable") return "enforced, as a record about this deploy shows";
    if (c.decided_by === "rule") return "the operator says a rule holds it to this; nobody here saw it applied";
    if (c.decided_by === "model") return "a limit the model is asked to keep";
    return "what holds it to this is not stated";
  };

  // ── reaching it ──
  const access = s.access;
  let accessBody = "";
  if (access) {
    const rows: string[][] = [];
    if (str(access.address)) rows.push(["Address", `<code>${esc(access.address)}</code>`, "Where a message to it is sent."]);
    if (str(access.protocol)) rows.push(["Protocol", esc(str(access.protocol).toUpperCase() === "A2A" ? "A2A (Agent2Agent)" : access.protocol), str(access.transport) ? `Over ${esc(access.transport)}${str(access.protocol_version) ? `, protocol version ${esc(access.protocol_version)}` : ""}.` : ""]);
    const schemes = Array.isArray(access.schemes) ? (access.schemes as Rec[]) : null;
    rows.push([
      "You present",
      schemes === null ? `<span class="tag">not stated</span>` : schemes.length === 0 ? "nothing: it says no credential is needed" : esc(joinWords(schemes.map((x) => [str(x.id), str(x.type) || str(x.scheme)].filter(Boolean).join(", a ")))),
      schemes === null ? "Its card does not say. That is not the same as needing nothing." : schemes.length > 1 ? "Any one of these. They are alternatives, not a checklist." : "",
    ]);
    rows.push(["Who it lets in", str(access.admission) ? esc(access.admission) : `<span class="tag">not stated</span>`, str(access.admission) ? "" : "No admission policy is published. It may still refuse you."]);
    if (isObj(access.capabilities)) {
      const c = access.capabilities;
      rows.push(["How it answers", esc([c.streaming === true ? "streams its answers" : c.streaming === false ? "does not stream" : "", c.push_notifications === true ? "can notify you when a task changes" : c.push_notifications === false ? "sends no push notifications" : ""].filter(Boolean).join("; ")), ""]);
    }
    if (isObj(access.limits)) rows.push(["Limits per caller", esc(Object.entries(access.limits).filter(([k]) => k !== "past_them").map(([k, v]) => `${k.replace(/_/g, " ")}: ${isObj(v) ? `${money(v.most)} (${enforcedWords(v)})` : `${money(v)} (what holds it to this is not stated)`}`).join("; ")), str(access.limits.past_them) ? esc(`Past them: ${access.limits.past_them}`) : ""]);
    accessBody = table(["", "", ""], rows).replace("<thead><tr><th></th><th></th><th></th></tr></thead>", "");
  }

  // ── offerings ──
  const offerings = arr(s.sells?.offerings).filter(isObj);
  const ioRows = (list: Rec[], kind: "in" | "out"): string => table(
    kind === "in" ? ["What you send", "Form", "Needed"] : ["What comes back", "Form", "When"],
    list.map((x) => [esc(str(x.name) || "unnamed"), `${esc(kindWords(x.kind ?? x.media_type))} <code>${esc(str(x.kind) || str(x.media_type))}</code>`, kind === "in" ? (x.required === true ? "required" : x.required === false ? "optional" : "not stated") : esc(str(x.when) === "standing" ? "kept up across tasks" : str(x.when) === "per_task" ? "each task" : str(x.when) || "not stated")]),
  );
  const offeringHtml = (o: Rec, i: number): string => {
    const scope = str(o.scope) || "task-specific";
    const label = scope === "open-ended" ? "open-ended: takes any instruction" : scope === "open-with-focus" ? `open, within a focus on ${str(o.focus) || "a focus it has not named"}` : "";
    const parts: string[] = [];
    if (scope === "open-ended") parts.push(note("<b>Open-ended.</b> It takes any instruction and makes no claim about what it can do. Read it by what it can touch, its limits, and what it does with your content."));
    else if (scope === "open-with-focus") parts.push(note(`<b>Open, within a focus on ${esc(o.focus)}.</b> That says where the instructions it will try lie, not what work it can do.${str(o.role) ? ` It names the standard role <code>${esc(o.role)}</code>.` : ""}`) + (str(o.does) ? p(`Where its instructions lie: ${esc(o.does)}`) : ""));
    else if (str(o.does)) parts.push(p(`${esc(o.does)} <span class="tag">the operator's words</span>`));
    const inputs = arr(o.inputs).filter(isObj);
    const granted = inputs.filter((x) => x.external === true || x.grant !== undefined || x.kind === "shared_resource");
    const sent = inputs.filter((x) => !granted.includes(x));
    if (sent.length) parts.push(ioRows(sent, "in"));
    if (granted.length) {
      const order = [...granted].sort((a, b) => (str(b.when) === "standing" ? 1 : 0) - (str(a.when) === "standing" ? 1 : 0));
      parts.push(`<h4>Access you grant, not files you send</h4>${table(["Resource", "It may", "How you grant it"], order.map((x) => [esc(str(x.name)), esc(str(x.access) || "not stated"), esc(str(x.grant) || words(x.via) || "not stated") + (str(x.when) === "standing" ? " (standing: still true after the work is done)" : "")]))}`);
    }
    if (!inputs.length && Array.isArray(o.input_modes)) parts.push(p(`It accepts ${esc(joinWords(o.input_modes.map(kindWords)))}. The card does not name its inputs.`));
    const outputs = arr(o.outputs).filter(isObj);
    if (outputs.length) parts.push(ioRows(outputs, "out"));
    else if (isObj(o.deliverables)) parts.push(ioRows([...arr(o.deliverables.per_task).filter(isObj).map((x) => ({ ...x, when: "per_task" })), ...arr(o.deliverables.interim).filter(isObj).map((x) => ({ ...x, when: "on a schedule" }))], "out"));
    else if (Array.isArray(o.output_modes)) parts.push(p(`It returns ${esc(joinWords(o.output_modes.map(kindWords)))}. The card does not name what comes back.`));
    if (outputs.length || inputs.length) parts.push(note("The form of each input and deliverable is a promise. Its quality is not, and nothing here says the work will be good."));
    if (Array.isArray(o.authority)) parts.push(o.authority.length ? `<h4>What it can touch</h4><ul>${o.authority.map((a) => `<li>${esc(AUTHORITY_WORDS[str(a)] ?? a)}</li>`).join("")}</ul>${note(o.authority_decided_by === "rule" ? "The operator says the runtime keeps a job inside this list." : o.authority_decided_by === "model" ? "The model is told this list and asked to keep to it." : "What keeps a job inside this list is not stated.")}` : p("What it can touch: nothing beyond what you send and what it returns."));
    else if (scope !== "task-specific") parts.push(p(`What it can touch: <span class="tag">not stated</span>`));
    if (Array.isArray(o.workspace)) parts.push(o.workspace.length ? `<h4>Where it works</h4><ul>${o.workspace.filter(isObj).map((w) => `<li>${esc(str(w.kind) || str(w.system))}, ${esc(str(w.access) || "access not stated")}: ${esc(w.for)}</li>`).join("")}</ul>` : p("Where it works: only on what a request sends it."));
    if (isObj(o.ceilings)) parts.push(`<h4>Limits on one job</h4><ul>${Object.entries(o.ceilings).filter(([, v]) => isObj(v)).map(([k, v]) => `<li>${esc(CEILING_WORDS[k] ?? k)}: at most ${esc(money((v as Rec).most))}. ${esc(enforcedWords(v as Rec))}.</li>`).join("")}</ul>`);
    if (o.price !== undefined) parts.push(p(`<b>Price</b> (${esc(str(o.arrangement).replace(/_/g, " ") || "arrangement not stated")}), from signed terms: <code>${esc(JSON.stringify(o.price))}</code>`));
    const steps = arr(o.steps).filter(isObj);
    if (steps.length) parts.push(`<h4>How it is delivered</h4><ol>${steps.map((x) => `<li>${esc(str(x.name) || str(x.id))}${str(x.does) ? `: ${esc(x.does)}` : ""}</li>`).join("")}</ol>${note("Steps are how the offering is delivered, not things to order.")}`);
    if (isObj(o.trial)) parts.push(o.trial.offered === true ? p(`<b>Trial:</b> open to ${esc(str(o.trial.who).replace("_", " "))}, ${esc(Object.entries(isObj(o.trial.limits) ? o.trial.limits : {}).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", "))}.`) : p("<b>Trial:</b> it offers no trial of this work."));
    for (const e of arr(o.evaluated_against).filter(isObj)) parts.push(p(`On the evaluation set ${esc(isObj(e.set) ? `${str(e.set.name)} version ${str(e.set.version)}` : "")}, an evaluator recorded ${esc(isObj(e.result) ? Object.entries(e.result).map(([k, v]) => `${v} ${k}`).join(", ") : "")}. That is this record's result on this set, not a rating.`));
    const state = str(o.state) || "declared";
    return `<details class="offering"${i === 0 ? " open" : ""}><summary><code>${esc(str(o.id) || str(o.name) || `offering ${i + 1}`)}</code> ${esc(str(o.name) && str(o.name) !== str(o.id) ? str(o.name) : "")} ${label ? `<span class="tag">${esc(label)}</span>` : ""} <span class="tag">${esc(state)}</span></summary>${parts.join("")}</details>`;
  };
  const sellsBody = offerings.length
    ? note("Declared means the operator says so and nobody has checked. Confirmed or failed means an evaluation record says so.") + offerings.map(offeringHtml).join("")
    : p("No offerings.");

  // ── who it is ──
  const ACTS: Record<string, string> = { person: "one person, its owner", organization: `an organization${str(identity.organization_name) ? `, ${str(identity.organization_name)}` : ""}`, anyone: "anyone: a public service with no principal" };
  const whoRows: string[][] = [];
  if (str(identity.operator)) whoRows.push(["Run by", esc(identity.operator) + (str(identity.url) ? ` (<a href="${esc(identity.url)}">${esc(identity.url)}</a>)` : "")]);
  if (str(identity.handle)) whoRows.push(["Handle", `<code>${esc(identity.handle)}</code>`]);
  if (str(identity.version)) whoRows.push(["Version", esc(identity.version)]);
  whoRows.push(["Acts for", ACTS[str(identity.acts_for)] ? esc(ACTS[str(identity.acts_for)]) : `<span class="tag">not stated</span>`]);
  if (typeof identity.fleet === "boolean") whoRows.push(["Fleet", identity.fleet ? "several processes answer as this one agent" : "one agent, not a set of copies"]);
  if (str(s.shape?.interaction)) whoRows.push(["Runs as", s.shape!.interaction === "service" ? "a service, with nobody attending it" : "an agent a person attends right now"]);
  whoRows.push(["How much is checkable", visibility === "verifiable" ? "what runs can be checked against what was built" : visibility === "observed" ? "the door is watched; the inside is not" : visibility === "opaque" ? "the door alone: an address, what was sent, and what came back" : `<span class="tag">not stated</span> no record here says what stands behind its door`]);
  if (s.role) whoRows.push(["Role", `<code>${esc(s.role.name)}</code> <span class="tag">${esc(str(s.role.state) || "declared")}</span>`]);
  if (str(identity.documentation)) whoRows.push(["Documentation", `<a href="${esc(identity.documentation)}">${esc(identity.documentation)}</a>`]);
  const whoBody = `<table><tbody>${whoRows.map((r) => `<tr><th>${esc(r[0])}</th><td>${r[1]}</td></tr>`).join("")}</tbody></table>`;

  // ── standard questions ──
  const askedBody = arr(s.asked?.interfaces).filter(isObj).map((i) => {
    const ex = arr(i.exchanges).filter(isObj);
    return `<h4><code>${esc(i.name)}</code>${str(i.version) ? ` ${esc(i.version)}` : ""}${str(i.definition) ? ` <a href="${esc(i.definition)}">definition</a>` : ""}</h4>${ex.length ? table(["It may be asked", "The answer carries", "State"], ex.map((e) => [esc(str(e.asks) || str(e.id)), esc(words(e.answer_carries)), `<span class="tag">${esc(str(e.state) || "declared")}</span>`])) : note("Its definition could not be read, so its questions are not listed.")}`;
  }).join("") + note("Each question is the agent's own claim until an evaluation record marks it confirmed or failed.");

  // ── refuses ──
  const refusalLines = str(s.refuses?.statement).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const handsOver = arr<unknown>(s.refuses?.hands_over).filter((x): x is string => typeof x === "string");
  const refusesBody = (refusalLines.length ? `<h4>It refuses</h4><ul>${refusalLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "")
    + (handsOver.length ? `<h4>It hands to a person</h4><ul>${handsOver.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "")
    + note(str(s.refuses?.kind) === "prose" ? "The operator's own words, not a signed clause." : "");

  // ── reaches ──
  const systems = arr(s.reaches?.systems).filter(isObj);
  const ceilings = arr(s.reaches?.ceilings).filter(isObj);
  const reachesBody = (systems.length ? table(["System", "Access", "What for", "Your content goes to it"], systems.map((y) => [esc(str(y.name) || "a system"), esc(str(y.access) || "not stated"), esc(y.needs), y.leaves === true ? "yes" : y.leaves === false ? "no" : "not stated"])) : "")
    + (ceilings.length ? `<h4>Suggested spending ceilings</h4>${table(["System", "Per", "Suggested"], ceilings.map((c) => [esc(c.system), esc(str(c.per) || "not stated"), esc(c.suggested ?? "not stated")]))}${note("The package suggests these. The host that installed the agent set the ones in force.")}` : "")
    + note("Each system is named by what it does, never by a product or an address.");

  const recordsBody = table(["Record", "When", "File"], arr(s.leaves?.records).filter(isObj).map((r) => [esc(r.name), esc(str(r.when) === "per_task" ? "each task" : r.when), r.file ? `<code>${esc(r.file)}</code>` : ""])) + note("An evaluation checks that a real job left these records.");

  const settings = arr(s.configs?.settings).filter(isObj);
  const tested = arr<unknown>(s.configs?.tested_models).map(String);
  const configsBody = settings.length
    ? table(["Setting", "Kind", "Default", "Allowed", "A sender may set it"], settings.map((x) => [`<code>${esc(x.name)}</code>`, esc(x.kind), esc(words(x.default)), esc(Array.isArray(x.allowed) ? words(x.allowed.map((a) => (x.name === "model" && s.configs?.tested_models !== undefined && !tested.includes(String(a)) ? `${a} (untested)` : a))) : "not listed"), x.job_may_set === true ? "yes" : "no"]))
      + (arr(s.configs?.named).length ? `<h4>Named run configs</h4><ul>${arr(s.configs?.named).filter(isObj).map((n) => `<li>${esc(n.name)} <code>${esc(shortDigest(n.digest))}</code></li>`).join("")}</ul>` : "")
    : p("It takes no settings.");

  const handling = s.handling ?? {};
  const handlingRows: string[][] = [];
  if (handling.hosted_in) handlingRows.push(["Runs in", esc(words(handling.hosted_in))]);
  handlingRows.push(["Processed in", handling.processed_in ? esc(words(handling.processed_in)) : `<span class="tag">not stated</span> so it may be anywhere`]);
  handlingRows.push(["Kept for", typeof handling.retention_max_days === "number" ? `at most ${esc(handling.retention_max_days)} days` : `<span class="tag">not stated</span> it has promised to delete nothing`]);
  if (Array.isArray(handling.processors)) handlingRows.push(["Seen by", esc(joinWords(handling.processors.map((x) => (isObj(x) ? [str(x.service), str(x.purpose)].filter(Boolean).join(", for ") : String(x)))) || "no other service")]);
  if (isObj(handling.promises)) handlingRows.push(["It promises", esc(Object.entries(handling.promises).filter(([k, v]) => k !== "grade" && v === true).map(([k]) => k.replace(/_/g, " ")).join("; ") + (typeof handling.promises.grade === "string" ? ` (graded ${handling.promises.grade})` : ""))]);
  const handlingBody = `<table><tbody>${handlingRows.map((r) => `<tr><th>${esc(r[0])}</th><td>${r[1]}</td></tr>`).join("")}</tbody></table>`;

  const standingBody = arr(s.standing?.entries).filter(isObj).map((e) => p(`${esc(e.kind === "eval-record" ? "An evaluation record" : "An attestation")}${str(e.by) ? ` by <b>${esc(e.by)}</b>` : ""}${str(e.as_of) ? `, as of ${esc(utc(e.as_of))}` : ""}. ${esc(SIG_WORDS[str(e.signature)] ?? "")}.${typeof e.conforms === "boolean" ? ` Its own verdict: ${e.conforms ? "conforms" : "does not conform"}.` : ""}${isObj(e.areas) ? ` Areas: ${esc(Object.entries(e.areas).map(([k, v]) => `${k} ${String(v).replace("_", " ")}`).join("; "))}.` : ""}${str(e.words) ? ` In its words: ${esc(e.words)}` : ""}`)).join("") + note("Carried as published, never audited or averaged here.");

  const notStatedBody = notStated.length
    ? table(["Not stated", "What that means"], notStated.map((x) => {
        const [w, means] = notStatedWords(x);
        return [`${esc(w)} <code>${esc(x)}</code>`, esc(means)];
      })) + note("When something is not stated, do not assume the answer you would like.")
    : p("Every question this document asks has an answer on record.");

  const sourcesBody = table(["Source", "Kind", "Digest", "Fetched", "Signature"], sources.map((x) => [
    `${x.url ? `<a href="${esc(x.url)}">${esc(sourceLabel(x, x.id))}</a>` : esc(sourceLabel(x, x.id))} <code>${esc(x.id)}</code>${arr<string>(x.disagreements).length ? `<br><span class="warn">Disagrees: ${esc(arr<string>(x.disagreements).join("; "))}</span>` : ""}${str(x.not_used) ? `<br><span class="warn">Not used: ${esc(x.not_used)}</span>` : ""}`,
    `<code>${esc(x.kind)}</code>${x.agent_version ? ` ${esc(x.agent_version)}` : ""}`,
    `<code>${esc(shortDigest(x.digest))}</code>`,
    esc(utc(x.fetched_at ?? x.at)),
    `<span class="${x.signature === "verified" ? "ok" : x.signature === "failed" ? "warn" : ""}">${esc(SIG_WORDS[str(x.signature)] ?? "")}</span>`,
  ])) + p(`${arr(doc.signatures).length ? "The assembler signed this document. That says it gathered these sources at this time and reported them faithfully, not that what they say is true." : "Nobody signed this assembly."} ${esc(str(doc.assembled_by))}`)
    + note("A digest is a fingerprint of a source's exact contents. Each fact on this page is copied from a source listed here; none is typed in.");

  const head = isPackage
    ? `<p class="lede">This page describes a package: what any agent installed from it will declare. It says nothing about any agent that is running.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · AgentDoc</title>
<meta name="description" content="The AgentDoc for ${esc(name)}: how to reach it, what it offers, what it refuses, and where each line came from.">
<style>
:root{--bg:#fbfaf7;--fg:#1d2327;--dim:#5c666d;--line:#dcd8cf;--band:#ffffff;--accent:#1f6f5c;--warn:#a1402b;--tag:#eeebe3;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#121619;--fg:#e4e7e9;--dim:#9aa4ab;--line:#2c343a;--band:#182024;--accent:#5fc7a6;--warn:#f08c72;--tag:#253036}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
header{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:16px}
h1{font-size:1.9rem;margin:0 0 4px}
h2{font-size:1.15rem;margin:0;display:inline}
h4{margin:16px 0 6px;font-size:1rem}
.lede{font-size:1.08rem;margin:6px 0}
.meta{color:var(--dim);font-size:.92rem;margin:4px 0}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
a{color:var(--accent)}
.band{background:var(--band);border:1px solid var(--line);border-radius:8px;margin:12px 0}
.band>summary{cursor:pointer;padding:12px 16px;list-style-position:inside}
.band .from{color:var(--dim);font-size:.88rem;margin-left:10px}
.body{padding:0 16px 14px}
.offering{border-top:1px solid var(--line);padding:8px 0}
.offering>summary{cursor:pointer;font-weight:600}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:.94rem;display:block;overflow-x:auto}
th,td{text-align:left;vertical-align:top;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;white-space:nowrap}
.tag{display:inline-block;background:var(--tag);border-radius:4px;padding:0 6px;font-size:.8rem;color:var(--dim);font-weight:500}
.note{color:var(--dim);font-size:.9rem}
.absent{margin:4px 0}
.ok{color:var(--accent)}
.warn{color:var(--warn)}
footer{color:var(--dim);font-size:.88rem;margin-top:24px}
</style>
</head>
<body>
<main>
<header>
  <h1>${esc(name)}</h1>
  ${str(identity.description) ? `<p class="lede">${esc(identity.description)}</p>` : ""}
  ${head}
  ${doc.subject ? `<p class="meta">Agent <code>${esc(doc.subject.id)}</code></p>` : ""}
  ${isPackage ? `<p class="meta">Package <code>${esc(str(doc.package?.name))}</code> ${esc(str(doc.package?.version))}</p>` : ""}
  <p class="meta">${doc.assembled_at ? `Assembled ${esc(utc(doc.assembled_at))}.` : "Fixed to its package, not to a moment."}${doc.stale_after ? ` Treat it as an old view after ${esc(utc(doc.stale_after))}, and assemble it again.` : ""} ${sources.length} source${sources.length === 1 ? "" : "s"}, ${notStated.length} thing${notStated.length === 1 ? "" : "s"} not stated.</p>
</header>
${isPackage ? "" : band("access", "Reaching it", access, accessBody)}
${band("sells", "What it offers", s.sells, sellsBody)}
${band("identity", "Who it is", s.identity, whoBody)}
${band("asked", "Standard questions", s.asked, askedBody)}
${band("refuses", "What it refuses", s.refuses, refusesBody)}
${band("reaches", "What it reaches", s.reaches, reachesBody)}
${band("leaves", "Records a job leaves", s.leaves, recordsBody)}
${band("configs", "What a job may set", s.configs, configsBody)}
${isPackage ? "" : band("handling", "Where your content goes", s.handling, handlingBody)}
${isPackage ? "" : band("standing", "Checked by others", s.standing, standingBody)}
<details open id="not-stated" class="band"><summary><h2>Not stated</h2><span class="from">${notStated.length} question${notStated.length === 1 ? "" : "s"} the sources leave open</span></summary><div class="body">${notStatedBody}</div></details>
<details open id="sources" class="band"><summary><h2>Sources</h2><span class="from">what was read, and whether each was signed</span></summary><div class="body">${sourcesBody}</div></details>
<footer>
  <p>An AgentDoc is assembled from what an agent publishes. It carries no score and no badge. <a href="./.well-known/agentdoc.json">The document this page shows</a> is for programs. Read more at <a href="https://agentdoc.net">agentdoc.net</a>.</p>
</footer>
</main>
</body>
</html>
`;
}
