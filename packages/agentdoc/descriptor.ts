/**
 * The Descriptor an owner adds to an agent that has only a card: a draft
 * written from the card, for the owner to correct, and the check that a
 * Descriptor holds what a signed one must before it is signed.
 *
 * The draft adds no address, no key and no claim the card does not make.
 * Every value it had to guess is listed under `_draft.guesses`, and every
 * member it could not fill is listed under `_draft.fill_in`. `sign` refuses a
 * Descriptor that still carries `_draft`, so no guess is signed unread.
 */
import { arr, isObj, str, text, type Rec } from "./util.js";

/** The member that marks a draft written by `init`. */
export const DRAFT_MARK = "_draft";

const ACTS_FOR = ["person", "organization", "anyone"];

/** The value kind (Section 6.3) a media type from a card coarsens back to: our best guess, marked as one. */
function kindOf(mode: unknown): string {
  const m = str(mode).toLowerCase();
  if (!m || m === "text" || m === "text/plain") return "text";
  return m;
}

/** A draft Descriptor from an A2A card: unbound, unsigned, and every guess marked. */
export function draftFromCard(card: Rec): Rec {
  const guesses: string[] = [];
  const fillIn: string[] = [];
  const version = text(card.version);
  if (!version) guesses.push("/agent_version: the card gives no version, so 0.1.0 is a placeholder");
  const does = text(card.description);
  if (!does) fillIn.push("does: one sentence on what the agent does");
  const offerings = arr(card.skills).filter(isObj).map((s, i) => {
    const inModes = arr<unknown>(Array.isArray(s.inputModes) ? s.inputModes : card.defaultInputModes);
    const outModes = arr<unknown>(Array.isArray(s.outputModes) ? s.outputModes : card.defaultOutputModes);
    const at = `/offerings/${i}`;
    guesses.push(`${at}/inputs: the card lists accepted media types, not named inputs; name each input and say whether it is required`);
    guesses.push(`${at}/outputs: the card lists returned media types, not named deliverables; name each one`);
    if (!text(s.description)) fillIn.push(`${at}/does: one sentence on what this offering does`);
    return {
      id: text(s.id) ?? `offering-${i + 1}`,
      name: text(s.name) ?? text(s.id) ?? `Offering ${i + 1}`,
      ...(text(s.description) ? { does: text(s.description) } : {}),
      inputs: (inModes.length ? inModes : ["text"]).slice(0, 1).map((m) => ({ name: "request", kind: kindOf(m), required: true })),
      outputs: (outModes.length ? outModes : ["text"]).slice(0, 1).map((m) => ({ name: "reply", kind: kindOf(m), when: "per_task" })),
    };
  });
  if (!offerings.length) fillIn.push("offerings: the card lists no skills; an empty list says the agent takes no work");
  fillIn.push(`acts_for: whom the agent acts for, one of ${ACTS_FOR.join(", ")} (add organization_name beside organization)`);
  fillIn.push("refusals: what the agent will not do, in your own words");
  return {
    [DRAFT_MARK]: {
      note: "A draft written from your agent's card by common-agent-doc init. Check every guess, fill in each missing member, then delete this _draft member and sign it with common-agent-doc sign.",
      guesses,
      fill_in: fillIn,
    },
    format: "agent-descriptor-v1",
    agent_version: version ?? "0.1.0",
    ...(does ? { does } : {}),
    offerings,
  };
}

/**
 * What stops a Descriptor from being signed as an agent's own: the members of
 * the minimal Descriptor (Section 6.2) it lacks, and a `_draft` left in it.
 * Empty when it can be signed.
 */
export function signingProblems(d: unknown): string[] {
  if (!isObj(d)) return ["it is not a JSON object"];
  const out: string[] = [];
  if (d[DRAFT_MARK] !== undefined) out.push(`it still carries ${DRAFT_MARK}: check each guess, fill in what it lists, then delete it`);
  if (d.format !== "agent-descriptor-v1") out.push('format must be "agent-descriptor-v1"');
  if (typeof d.agent_version !== "string" || !d.agent_version) out.push("agent_version is missing");
  if (typeof d.does !== "string" || !d.does.trim()) out.push("does is missing: one sentence on what the agent does");
  if (!ACTS_FOR.includes(str(d.acts_for))) out.push(`acts_for must be one of ${ACTS_FOR.join(", ")}`);
  if (d.organization_name !== undefined && d.acts_for !== "organization") out.push("organization_name goes only beside acts_for organization");
  if (!Array.isArray(d.offerings)) out.push("offerings is missing (an empty list says the agent takes no work)");
  else d.offerings.forEach((o, i) => {
    if (!isObj(o)) return out.push(`offering ${i + 1} is not an object`);
    for (const k of ["id", "name"]) if (!text(o[k])) out.push(`offering ${i + 1} has no ${k}`);
    if (!Array.isArray(o.inputs)) out.push(`offering ${str(o.id) || i + 1} has no inputs list (it may be empty)`);
    if (!Array.isArray(o.outputs)) out.push(`offering ${str(o.id) || i + 1} has no outputs list (it may be empty)`);
  });
  if (d.shape !== undefined) out.push("shape was removed from the format; take it out (Section 6.12)");
  return out;
}
