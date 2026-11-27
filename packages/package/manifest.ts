/**
 * The Agent Plugins 1.0.0 manifest schema, pinned (Common Agent 12.2), and
 * the namespace this standard adds inside the manifest.
 *
 * The schema is pinned rather than fetched, so a moved or unavailable address
 * cannot make a valid package unverifiable. It is small enough to apply by
 * hand, which costs less than a schema library would.
 */

/** The namespace that holds the pointers in the manifest and the generated views in the package. */
export const PACKAGE_NS = "net.agentdoc.package";

/** The Agent Plugins schema version a package declares, by its `$schema` address. */
export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/**
 * The Agent Plugins 1.0.0 MCP configuration schema, by its `$schema` address.
 * Agent Plugins publishes both schemas of a release in one folder under one
 * version (its Section 10.1), and `mcp.json` names the version `plugin.json`
 * names, so the address is derived from the manifest's.
 */
export const MCP_SCHEMA_URL = PLUGIN_SCHEMA_URL.replace(/[^/]+$/, "mcp.schema.json");

/**
 * The longest `plugin.json` description: it is the line a harness shows a
 * person picking a plugin, one or two sentences on one line. The whole account
 * of what the agent does is the Descriptor's `does`.
 */
export const DESCRIPTION_MAX = 300;

/** Words about how a package was made or which of a publisher's groups it is in, which tell a person searching nothing; a keyword is never one. */
export const INTERNAL_KEYWORDS = Object.freeze(["built-agent", "draft", "system-agent", "demo-agent"]);

/** Why a description is too long for the line a harness shows, or null. */
export function descriptionProblem(d: string): string | null {
  if (d.includes("\n") || d.length > DESCRIPTION_MAX) {
    return `plugin.json description is what a harness shows a person choosing a plugin: one or two sentences on one line, at most ${DESCRIPTION_MAX} characters, and this one is ${d.includes("\n") ? "more than one line" : `${d.length} characters`}`;
  }
  return null;
}

/** The pinned copy of the Agent Plugins 1.0.0 manifest schema: what is required, what is allowed, and the types. */
export const PLUGIN_SCHEMA = Object.freeze({
  required: ["$schema", "name"],
  properties: {
    $schema: { const: PLUGIN_SCHEMA_URL },
    name: { type: "string", minLength: 1, maxLength: 64, pattern: "^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$" },
    version: { type: "string" },
    description: { type: "string" },
    author: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, url: { type: "string" } }, additionalProperties: false },
    homepage: { type: "string" },
    repository: { type: "string" },
    license: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    extensions: { type: "object", additionalProperties: { type: "object" } },
  },
  additionalProperties: false,
} as const);

/**
 * The pinned schema, applied by hand: the required members, no member it does
 * not list, the name pattern, and the types of what is present. Returns the
 * first problem in words, or null when the manifest validates.
 */
export function manifestProblem(m: unknown, jobs: readonly string[] = []): string | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "plugin.json is a JSON object";
  const man = m as Record<string, unknown>;
  const props = PLUGIN_SCHEMA.properties as Record<string, unknown>;
  for (const k of PLUGIN_SCHEMA.required) if (!(k in man)) return `plugin.json is missing ${k}`;
  for (const k of Object.keys(man)) if (!(k in props)) return `plugin.json carries "${k}", which the Agent Plugins schema does not allow`;
  if (man.$schema !== PLUGIN_SCHEMA_URL) return `plugin.json must declare ${PLUGIN_SCHEMA_URL}`;
  const name = man.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || !new RegExp(PLUGIN_SCHEMA.properties.name.pattern).test(name)) {
    return `plugin.json name "${String(name)}" does not match the schema's pattern`;
  }
  for (const k of ["version", "description", "homepage", "repository", "license"]) if (k in man && typeof man[k] !== "string") return `plugin.json ${k} must be a string`;
  if ("keywords" in man && !(Array.isArray(man.keywords) && man.keywords.every((x) => typeof x === "string"))) return "plugin.json keywords must be strings";
  // One of the agent's own jobs is what it does, whatever its slug: a step named draft is a keyword.
  const inner = ((man.keywords as string[] | undefined) ?? []).filter((k) => INTERNAL_KEYWORDS.includes(k.trim().toLowerCase()) && !jobs.includes(k.trim()));
  if (inner.length) return `plugin.json keywords carry ${inner.join(", ")}, which say how the package was made and not what the agent does`;
  if (typeof man.description === "string") {
    const long = descriptionProblem(man.description);
    if (long) return long;
  }
  if ("author" in man) {
    const allowed = Object.keys(PLUGIN_SCHEMA.properties.author.properties);
    const a = man.author;
    if (!a || typeof a !== "object" || Object.keys(a).some((k) => !allowed.includes(k))) return "plugin.json author may carry only name, email, url";
  }
  if ("extensions" in man) {
    const e = man.extensions;
    if (!(e && typeof e === "object" && Object.values(e).every((v) => v && typeof v === "object"))) return "plugin.json extensions must map a namespace to an object";
  }
  return null;
}
