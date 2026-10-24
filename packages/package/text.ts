/**
 * Small helpers the packer and the validator share: the one spelling of a
 * JSON file, its digest, sentences, and the hidden-character scan of
 * Common Agent 12.6 rule 8.
 */
import { createHash } from "node:crypto";

/** One spelling of a JSON file, so its digest is reproducible: two-space indent and a final newline. */
export const dumps = (obj: unknown): string => `${JSON.stringify(obj, null, 2)}\n`;

/** SHA-256 in lowercase hex. */
export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** A line as a sentence: trimmed, with a full stop at the end. */
export const sentence = (s: unknown): string => {
  const t = String(s).trim();
  return t.endsWith(".") ? t : `${t}.`;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** UTF-8 bytes of a string. */
export const utf8Bytes = (s: string): Uint8Array => encoder.encode(s);

/** A file's bytes read as UTF-8, with any byte that is not UTF-8 read as U+FFFD. */
export const utf8Text = (b: Uint8Array): string => decoder.decode(b);

/** A hidden character found in a text. */
export interface HiddenCharacter {
  codepoint: number;
  offset: number;
}

/**
 * The first zero-width character, bidirectional control or tag-block
 * character in a text: what can carry an instruction a reader never sees. A
 * package with one does not conform. `offset` is in UTF-16 code units.
 */
export function hiddenCharacter(text: string): HiddenCharacter | null {
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i) as number;
    if (c > 0xffff) i++;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff || (c >= 0xe0000 && c <= 0xe007f)) {
      return { codepoint: c, offset: i };
    }
  }
  return null;
}

/** U+XXXX, at least four hex digits. */
export const codepointName = (c: number): string => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * The hidden character in a file, if any. A file that does not read as UTF-8
 * (it holds U+FFFD once read) is taken to be binary and is not scanned.
 */
export function hiddenInFile(bytes: Uint8Array): HiddenCharacter | null {
  const text = utf8Text(bytes);
  if (text.includes("�")) return null;
  return hiddenCharacter(text);
}
