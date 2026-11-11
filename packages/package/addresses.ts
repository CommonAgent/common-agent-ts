/**
 * The address check of Common Agent Section 12.10: the address literals a
 * script carries. It reads text, with no knowledge of the language a script
 * is written in, so two checkers given one package report the same literals.
 * A literal is a warning against Section 12.6, rule 2, and never a refusal.
 */

/**
 * The prefixes of the literals that name a format and are never called
 * (Section 12.10, the address check, item 3). The list is closed.
 */
export const EXCEPTED_ADDRESS_PREFIXES = Object.freeze([
  "http://www.w3.org/",
  "https://www.w3.org/",
  "http://json-schema.org/",
  "https://json-schema.org/",
  "http://purl.org/",
  "http://schemas.openxmlformats.org/",
  "http://schemas.microsoft.com/",
]);

/** One address literal, and the line it is on. The first line is line 1. */
export interface AddressLiteral {
  line: number;
  literal: string;
}

// A scheme of http, https, ws or wss in any case, then "://", then a letter,
// a digit or "[". The scheme is not the tail of a longer word, so "news://"
// is not read as "ws://". Section 12.10 says where a literal starts and not
// where it ends: here it runs to the first white space, quote, backtick,
// angle bracket, backslash, brace, vertical bar or caret, or to "${".
const SCHEME_LITERAL = /(?<![A-Za-z0-9])(?:https?|wss?):\/\/[A-Za-z0-9[](?:(?!\$\{)[^\s"'`<>\\{}|^])*/gi;

// An IPv4 address in 169.254.0.0/16, where cloud machines serve their metadata.
const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const LINK_LOCAL = new RegExp(`(?<![0-9.])169\\.254\\.${OCTET}\\.${OCTET}(?![0-9])(?!\\.[0-9])`, "g");

/** A literal without the punctuation of the sentence or the call around it. */
const trimmed = (s: string): string => {
  let t = s.replace(/[.,;:!?]+$/, "");
  if (t.endsWith(")") && !t.includes("(")) t = t.slice(0, -1).replace(/[.,;:!?]+$/, "");
  return t;
};

/**
 * Every address literal in a text, comments included, in the order they
 * appear, without the literals Section 12.10 excepts. An address a script
 * builds while it runs is not a literal and is not found here.
 */
export function addressLiterals(text: string): AddressLiteral[] {
  const out: AddressLiteral[] = [];
  text.split("\n").forEach((row, i) => {
    const found: { at: number; end: number; literal: string }[] = [];
    for (const m of row.matchAll(SCHEME_LITERAL)) found.push({ at: m.index, end: m.index + m[0].length, literal: trimmed(m[0]) });
    const schemes = found.length;
    // An address in the range with no scheme. One inside a literal already found is that literal.
    for (const m of row.matchAll(LINK_LOCAL)) {
      if (!found.slice(0, schemes).some((f) => m.index >= f.at && m.index < f.end)) found.push({ at: m.index, end: m.index + m[0].length, literal: m[0] });
    }
    found.sort((a, b) => a.at - b.at);
    for (const f of found) if (!EXCEPTED_ADDRESS_PREFIXES.some((p) => f.literal.startsWith(p))) out.push({ line: i + 1, literal: f.literal });
  });
  return out;
}
