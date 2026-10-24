/**
 * The build record (Common Agent 8.2): issued by whoever built a package, at
 * build time, attesting that these bytes were produced by this builder at
 * this moment. It says nothing about whether the agent is any good, and a
 * package's draft status survives it.
 *
 * Signed under the record convention of 8.1: Ed25519 over the tag, one
 * newline, and the canonical JSON of the record without `signatures`. A
 * builder with no key records the build unsigned and says so (8.1 rule 3).
 */
import { canonicalJSON, decodeSignature, encodeSignature, signTagged, verifyTagged, type KeyedSigner } from "@common-agent/crypto";
import type { BuiltPackage } from "./build.js";
import { PLUGIN_SCHEMA_URL } from "./manifest.js";

/** The signing tag of a build record. */
export const BUILD_RECORD_TAG = "agent-build-record-v1";

/** The note an unsigned record carries. */
export const UNSIGNED_NOTE = "no signing key was given; the record is faithful but unsigned";

export interface BuildRecord {
  record: "v1";
  role: "agent-builder";
  act: "build";
  requested_by: string;
  package: { name: string; version: string; schema: string; sha256: string; descriptor_sha256: string; install_sha256: string };
  shape: BuiltPackage["shape"];
  lockfiles: BuiltPackage["lockfiles"];
  checks: { kind: string; what: string }[];
  draft: true;
  produced_at: string;
  by: string;
  signatures: { tag: string; by: string; sig: string; alg: "ed25519" }[];
  _unsigned?: string;
  [k: string]: unknown;
}

/** An instant as the record spells it: UTC, to the second. */
export const recordInstant = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The build record for a built package, produced at `producedAt` (the caller
 * passes the clock), signed by `signer` when one is given and otherwise
 * unsigned with its note.
 */
export function buildRecord(built: BuiltPackage, { producedAt, requestedBy = "self", signer }: { producedAt: Date; requestedBy?: string; signer?: KeyedSigner }): BuildRecord {
  const record: BuildRecord = {
    record: "v1",
    role: "agent-builder",
    act: "build",
    requested_by: requestedBy,
    package: {
      name: built.name,
      version: built.version,
      schema: PLUGIN_SCHEMA_URL,
      sha256: built.sha256,
      descriptor_sha256: built.descriptor_sha256,
      install_sha256: built.install_sha256,
    },
    shape: built.shape,
    lockfiles: built.lockfiles,
    checks: [{ kind: "unrun", what: "nobody has run the agent this package describes" }],
    draft: true,
    produced_at: recordInstant(producedAt),
    by: signer ? signer.getPublicKey() : "unsigned",
    signatures: [],
  };
  if (signer) {
    const { signatures: _s, ...unsigned } = record;
    const sig = encodeSignature(signTagged(signer, `${BUILD_RECORD_TAG}\n`, canonicalJSON(unsigned)));
    record.signatures = [{ tag: BUILD_RECORD_TAG, by: record.by, sig, alg: "ed25519" }];
  } else {
    record._unsigned = UNSIGNED_NOTE;
  }
  return record;
}

/**
 * Whether a build record's signatures verify: at least one, each under the
 * build record tag, each by the record's own `by` (8.1 rule 1). The
 * `_unsigned` note is outside every signature by construction.
 */
export function verifyBuildRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const r = record as Record<string, unknown>;
  const sigs = r.signatures;
  if (!Array.isArray(sigs) || !sigs.length) return false;
  const { signatures: _s, _unsigned: _u, ...unsigned } = r;
  const text = canonicalJSON(unsigned);
  return sigs.every((s) => {
    const e = s as Record<string, unknown>;
    return e.tag === BUILD_RECORD_TAG && e.alg === "ed25519" && e.by === r.by && decodeSignature(e.sig) !== null && verifyTagged(e.by, `${BUILD_RECORD_TAG}\n`, text, decodeSignature(e.sig));
  });
}
