/**
 * The paths of `not_stated`, read the same way by the assembler that writes
 * them and the checker that reads them.
 *
 * A path is dotted: a section, then members, such as `handling.processed_in`.
 * A path whose first word is not a section names a top-level member, such as
 * `subject` in a package AgentDoc. Inside a list, a word that is an entry's
 * `id` or `name` picks that entry (`sells.offerings.summarize.inputs`), and
 * any other word applies to every entry (`sells.offerings.price`). Under
 * `sells`, a word that is not a member of the section applies to each
 * offering (`sells.price`). A path covers itself and every path below it.
 */
import { isObj, type Rec } from "./util.js";

/** The sections of Section 9.5, in the order a reader meets them. */
export const KNOWN_SECTIONS = ["identity", "shape", "asked", "role", "sells", "access", "refuses", "reaches", "leaves", "configs", "handling", "standing"] as const;

const isSection = (doc: Rec, word: string): boolean =>
  (KNOWN_SECTIONS as readonly string[]).includes(word) || (isObj(doc.sections) && Object.prototype.hasOwnProperty.call(doc.sections, word));

function step(v: unknown, segs: string[], parent: string): unknown[] {
  if (v === undefined) return [];
  if (!segs.length) return [v];
  const [s, ...rest] = segs as [string, ...string[]];
  if (Array.isArray(v)) {
    const hit = v.find((e) => isObj(e) && (e.id === s || e.name === s));
    if (hit !== undefined) return step(hit, rest, s);
    return v.flatMap((e) => step(e, segs, parent));
  }
  if (isObj(v)) {
    if (Object.prototype.hasOwnProperty.call(v, s)) return step(v[s], rest, s);
    if (parent === "sells" && Array.isArray(v.offerings)) return step(v.offerings, segs, "offerings");
  }
  return [];
}

/** Every value present at a path; empty when nothing is there. */
export function valuesAt(doc: Rec, path: string): unknown[] {
  const segs = path.split(".").filter(Boolean);
  if (!segs.length) return [];
  const [first, ...rest] = segs as [string, ...string[]];
  const root = isSection(doc, first) ? (isObj(doc.sections) ? doc.sections[first] : undefined) : doc[first];
  return step(root, rest, first).filter((x) => x !== undefined && x !== null);
}

/** Whether `not_stated` names one of these paths or a path above one of them. */
export function covered(notStated: readonly string[], candidates: readonly string[]): boolean {
  return candidates.some((c) => notStated.some((n) => n === c || c.startsWith(`${n}.`)));
}

/** The paths that name an offering's member, under every spelling a reader accepts. */
export function offeringPaths(o: Rec, member: string): string[] {
  const keys = [o.id, o.name].filter((k): k is string => typeof k === "string" && k.length > 0);
  return [...keys.map((k) => `sells.offerings.${k}.${member}`), `sells.offerings.${member}`, `sells.${member}`];
}

/** The paths that name a declared interface's exchanges. */
export function interfacePaths(name: string): string[] {
  return [`asked.interfaces.${name}.exchanges`, `asked.interfaces.${name}`, `asked.${name}`];
}
