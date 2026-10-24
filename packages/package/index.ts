/**
 * The Agent Package of the Common Agent Specification (Section 12): pack an
 * agent's spec and folder into a package, and validate a package, as files
 * in memory. No storage, no network, no clock but the one a caller passes.
 * The command line tool in cli.ts is the host that reads and writes a disk.
 */
import { ArchiveError, readArchive } from "./archive.js";
import type { PackageFiles } from "./types.js";
import { validatePackage, type Validation } from "./validate.js";

/** The standard this package implements, and the version of it. */
export const PACKAGE_SPEC = Object.freeze({ standard: "Common Agent Specification, Section 12", version: "0.29.2-draft" });

export { ArchiveError, readArchive, walkOrder, writeArchive, type ReadArchive } from "./archive.js";
export {
  ACCESS,
  CREDENTIAL_RE,
  ENFORCED_BY,
  ENV_RE,
  MEDIA_RE,
  NAME_RE,
  PackRefusal,
  SLUG_RE,
  SYSTEM_KINDS,
  VALUE_KINDS,
  WHEN,
  SPEC_DEPRECATED,
  buildFromFolder,
  buildPackage,
  isAgentFolder,
  draftDescriptor,
  installFile,
  type BuildOptions,
  type BuiltPackage,
} from "./build.js";
export {
  AUTHORED_FILES,
  DESCRIPTOR_FILE,
  LEGACY_DESCRIPTOR_FILE,
  LEGACY_RUNTIME_REQUIREMENTS_FILE,
  MANIFEST_FILE,
  RUNTIME_REQUIREMENTS_FILE,
  legacyWarning,
  resolveName,
  type AuthoredKind,
  type ResolvedName,
} from "./names.js";
export { PACKAGE_NS, PLUGIN_SCHEMA, PLUGIN_SCHEMA_URL, manifestProblem } from "./manifest.js";
export { AUTHORITY_VALUES, CEILING_KEYS, FOCUS_VALUES, SCOPE_VALUES, isDataUseProblem, offeringScopeProblems, type DataUse, type SystemRef } from "./offering.js";
export type { KeyedSigner, SourceTree } from "./ports.js";
export { BUILD_RECORD_TAG, UNSIGNED_NOTE, buildRecord, recordInstant, verifyBuildRecord, type BuildRecord } from "./record.js";
export { hasSkillFrontmatter, skillMd, type Copied } from "./skill.js";
export { codepointName, dumps, hiddenCharacter, hiddenInFile, sha256Hex, type HiddenCharacter } from "./text.js";
export type * from "./types.js";
export { HOW_VALUES, PER_FILE_PLACEHOLDERS, RUN_PLACEHOLDERS, validatePackage, type Issue, type Validation } from "./validate.js";
export { generatedViews, notMd, recordsMd, systemName, systemsMd } from "./views.js";

/** A validation with one more layout problem in front. */
export function withIssue(v: Validation, message: string): Validation {
  const issues = [{ check: "layout", message }, ...v.issues];
  return { ...v, ok: false, issues, problems: issues.map((i) => i.message) };
}

/**
 * Validate a package archive: read it, check that its one top folder is the
 * package's name, and run validatePackage over its files.
 */
export function validateArchive(bytes: Uint8Array): Validation & { files?: PackageFiles } {
  let read;
  try {
    read = readArchive(bytes);
  } catch (e) {
    if (e instanceof ArchiveError) return { ok: false, name: null, version: null, issues: [{ check: "layout", message: e.message }], problems: [e.message], warnings: [] };
    throw e;
  }
  const v = validatePackage(read.files);
  if (v.name !== null && read.arcname !== v.name) return { ...withIssue(v, `the archive's folder is ${read.arcname}, and the package is named ${v.name}`), files: read.files };
  return { ...v, files: read.files };
}
