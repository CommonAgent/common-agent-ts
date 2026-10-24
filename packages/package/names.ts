/**
 * The file names of a package's two authored files, in one place.
 *
 * The draft Descriptor is `agent-descriptor.json` and the install file is
 * `agent-runtime-requirements.json`. Packages built before the rename call
 * them `descriptor.json` and `install.json`. The packer writes only the new
 * names. The validator and the packer's folder input read the old names as
 * aliases, with a warning, so a package built under them still validates.
 */

/** The draft Descriptor: every caller-facing fact. */
export const DESCRIPTOR_FILE = "agent-descriptor.json";
/** The install file: every host-facing fact. */
export const RUNTIME_REQUIREMENTS_FILE = "agent-runtime-requirements.json";

/** The draft Descriptor's name before the rename, read as an alias. */
export const LEGACY_DESCRIPTOR_FILE = "descriptor.json";
/** The install file's name before the rename, read as an alias. */
export const LEGACY_RUNTIME_REQUIREMENTS_FILE = "install.json";

/** The manifest's own file, which Agent Plugins names. */
export const MANIFEST_FILE = "plugin.json";

/** Each authored file: the member of the manifest's namespace entry that points at it, its name, and its name before the rename. */
export const AUTHORED_FILES = Object.freeze({
  descriptor: Object.freeze({ member: "descriptor", name: DESCRIPTOR_FILE, legacy: LEGACY_DESCRIPTOR_FILE }),
  runtime: Object.freeze({ member: "install", name: RUNTIME_REQUIREMENTS_FILE, legacy: LEGACY_RUNTIME_REQUIREMENTS_FILE }),
} as const);

export type AuthoredKind = keyof typeof AUTHORED_FILES;

/** Which name a set of paths uses for one authored file. */
export interface ResolvedName {
  /** The path the files hold it under, or null when they hold neither name. */
  path: string | null;
  /** True when only the old name is present. */
  legacy: boolean;
  /** True when both names are present, which is ambiguous. */
  both: boolean;
}

/** Find one authored file among a set of paths, by its name or its old name. */
export function resolveName(has: (path: string) => boolean, kind: AuthoredKind): ResolvedName {
  const f = AUTHORED_FILES[kind];
  const now = has(f.name);
  const old = has(f.legacy);
  if (now) return { path: f.name, legacy: false, both: old };
  if (old) return { path: f.legacy, legacy: true, both: false };
  return { path: null, legacy: false, both: false };
}

/** The warning for an authored file read under its old name. */
export const legacyWarning = (kind: AuthoredKind): string => {
  const f = AUTHORED_FILES[kind];
  return `${f.legacy} is read as ${f.name}, its name since the rename; rename the file`;
};
