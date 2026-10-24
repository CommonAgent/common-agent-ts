/**
 * The names a package's two authored files go by, in one place (Common
 * Agent 0.30.0-draft, Section 12.2).
 *
 * The draft Descriptor is `agent-descriptor.json`. The runtime requirements
 * are `agent-runtime-requirements.json`, the manifest points at them under
 * `runtime_requirements`, and their `format` is
 * `"agent-runtime-requirements-v1"`. Before 0.30.0-draft they were
 * `descriptor.json`, `install.json`, the pointer `install` and the format
 * `"agent-install-v1"`.
 *
 * A writer emits only the current names. A reader accepts each former name
 * where its current one is absent, and prefers the current one where a
 * package carries both. This package warns each time it reads a former name,
 * and each time it finds both.
 */

/** The draft Descriptor: every caller-facing fact. */
export const DESCRIPTOR_FILE = "agent-descriptor.json";
/** The runtime requirements: every host-facing fact. */
export const RUNTIME_REQUIREMENTS_FILE = "agent-runtime-requirements.json";
/** The runtime requirements' format. */
export const RUNTIME_REQUIREMENTS_FORMAT = "agent-runtime-requirements-v1";
/** The manifest pointer at the runtime requirements. */
export const RUNTIME_REQUIREMENTS_POINTER = "runtime_requirements";
/** The manifest pointer at the draft Descriptor, whose name did not change. */
export const DESCRIPTOR_POINTER = "descriptor";

/** The draft Descriptor's file name before 0.30.0-draft. */
export const LEGACY_DESCRIPTOR_FILE = "descriptor.json";
/** The runtime requirements' file name before 0.30.0-draft. */
export const LEGACY_RUNTIME_REQUIREMENTS_FILE = "install.json";
/** The runtime requirements' format before 0.30.0-draft. */
export const LEGACY_RUNTIME_REQUIREMENTS_FORMAT = "agent-install-v1";
/** The manifest pointer at the runtime requirements before 0.30.0-draft. */
export const LEGACY_RUNTIME_REQUIREMENTS_POINTER = "install";

/** The manifest's own file, which Agent Plugins names. */
export const MANIFEST_FILE = "plugin.json";

/** Each authored file: its name and former name, and the manifest pointer at it and its former name. */
export const AUTHORED_FILES = Object.freeze({
  descriptor: Object.freeze({ name: DESCRIPTOR_FILE, legacy: LEGACY_DESCRIPTOR_FILE, pointer: DESCRIPTOR_POINTER, legacyPointer: DESCRIPTOR_POINTER }),
  runtime: Object.freeze({ name: RUNTIME_REQUIREMENTS_FILE, legacy: LEGACY_RUNTIME_REQUIREMENTS_FILE, pointer: RUNTIME_REQUIREMENTS_POINTER, legacyPointer: LEGACY_RUNTIME_REQUIREMENTS_POINTER }),
} as const);

export type AuthoredKind = keyof typeof AUTHORED_FILES;

/** Which of a current name and a former name something is found under. */
export interface ResolvedName {
  /** The name it is read under, or null when neither is present. */
  path: string | null;
  /** True when it is read under its former name. */
  legacy: boolean;
  /** True when both names are present; the current one is read. */
  both: boolean;
}

/** Read a current name, or its former name where the current one is absent. */
function resolve(has: (name: string) => boolean, name: string, legacy: string): ResolvedName {
  if (name === legacy) return { path: has(name) ? name : null, legacy: false, both: false };
  const now = has(name);
  const old = has(legacy);
  if (now) return { path: name, legacy: false, both: old };
  if (old) return { path: legacy, legacy: true, both: false };
  return { path: null, legacy: false, both: false };
}

/** Find one authored file among a set of paths, by its name or its former name. */
export function resolveName(has: (path: string) => boolean, kind: AuthoredKind): ResolvedName {
  const f = AUTHORED_FILES[kind];
  return resolve(has, f.name, f.legacy);
}

/** Find the manifest pointer at one authored file, by its name or its former name. */
export function resolvePointer(entry: Record<string, unknown>, kind: AuthoredKind): ResolvedName {
  const f = AUTHORED_FILES[kind];
  return resolve((k) => entry[k] !== undefined, f.pointer, f.legacyPointer);
}

/** The warnings for what was found under a former name, or under both names. */
export function nameWarnings(r: ResolvedName, current: string, former: string): string[] {
  if (r.legacy) return [`${former} is read as ${current}, its name since Common Agent 0.30.0-draft; use ${current}`];
  if (r.both) return [`both ${current} and ${former} are present; ${current} is read and ${former} is ignored`];
  return [];
}

/** The warnings for one authored file's name. */
export const fileWarnings = (r: ResolvedName, kind: AuthoredKind): string[] => nameWarnings(r, AUTHORED_FILES[kind].name, AUTHORED_FILES[kind].legacy);

/** The warnings for one manifest pointer's name. */
export const pointerWarnings = (r: ResolvedName, kind: AuthoredKind): string[] =>
  nameWarnings(r, `the pointer ${AUTHORED_FILES[kind].pointer}`, `the pointer ${AUTHORED_FILES[kind].legacyPointer}`);

/** Whether a runtime requirements format is one a reader accepts, and whether it is the former one. */
export function runtimeFormat(format: unknown): "current" | "legacy" | null {
  if (format === RUNTIME_REQUIREMENTS_FORMAT) return "current";
  if (format === LEGACY_RUNTIME_REQUIREMENTS_FORMAT) return "legacy";
  return null;
}

/** The warning for the former format. */
export const formatWarning = (file: string): string =>
  `${file} says format "${LEGACY_RUNTIME_REQUIREMENTS_FORMAT}", read as "${RUNTIME_REQUIREMENTS_FORMAT}", its format since Common Agent 0.30.0-draft`;
