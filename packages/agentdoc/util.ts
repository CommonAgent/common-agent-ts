/**
 * Small helpers the rest of the package shares: reading loose JSON safely,
 * the one spelling of a time and a digest, and fetching a JSON document with
 * its exact bytes.
 */
import { canonicalJSON, sha256Digest } from "@common-agent/crypto";
import type { DocumentInput } from "./types.js";

export type Rec = Record<string, unknown>;

export const isObj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A non-empty trimmed string, or undefined. */
export const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const arr = <T = Rec>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/** A moment as the AgentDoc spells it: UTC, to the second. */
export const isoSecond = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Whether a string is an address to fetch rather than JSON text. */
export const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A JSON document as read: its value, its exact bytes where they are known, where it came from, and its digest. */
export interface Loaded {
  value: unknown;
  bytes?: Uint8Array;
  url?: string;
  digest: string;
  fetchedAt: string;
}

/** Why a document could not be read, in plain words. */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ReadError";
  }
}

/** Parse bytes as one JSON document, or throw a ReadError that says why. */
export function parseBytes(bytes: Uint8Array, where: string): unknown {
  let textValue: string;
  try {
    textValue = decoder.decode(bytes);
  } catch {
    throw new ReadError(`${where} is not UTF-8 text`);
  }
  try {
    return JSON.parse(textValue.replace(/^﻿/, ""));
  } catch (e) {
    throw new ReadError(`${where} is not valid JSON: ${(e as Error).message}`);
  }
}

/** The digest of a loaded document: over its exact bytes where they are known, over its canonical JSON otherwise. */
export function digestOf(value: unknown, bytes?: Uint8Array): string {
  return bytes ? sha256Digest(bytes) : sha256Digest(canonicalJSON(value));
}

/** Fetch a JSON document and keep its exact bytes. A 404 is a ReadError with status 404. */
export async function fetchJson(f: typeof fetch, url: string, now: string): Promise<Loaded> {
  let res: Response;
  try {
    res = await f(url, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new ReadError(`could not reach ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new ReadError(`${url} answered ${res.status}`, res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const value = parseBytes(bytes, url);
  return { value, bytes, url, digest: sha256Digest(bytes), fetchedAt: now };
}

/** Read a document handed in any of the accepted forms. A URL is fetched. */
export async function load(input: DocumentInput, f: typeof fetch, now: string, what: string): Promise<Loaded> {
  if (typeof input === "string") {
    if (isUrl(input)) return fetchJson(f, input.trim(), now);
    const bytes = new TextEncoder().encode(input);
    return { value: parseBytes(bytes, what), bytes, digest: sha256Digest(bytes), fetchedAt: now };
  }
  if (input instanceof Uint8Array) {
    return { value: parseBytes(input, what), bytes: input, digest: sha256Digest(input), fetchedAt: now };
  }
  return { value: input, digest: digestOf(input), fetchedAt: now };
}

/** A list joined for a sentence: "a", "a and b", "a, b and c". */
export function joinWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
