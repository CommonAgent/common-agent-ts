/**
 * The offering checks of Common Agent Section 6.11, as a registry would make
 * them, in words. A package's draft Descriptor carries each offering's scope
 * and the members it requires, so the packer and the validator both hold
 * every offering to these checks.
 */

export const SCOPE_VALUES = Object.freeze(["task-specific", "open-with-focus", "open-ended"] as const);
export const FOCUS_VALUES = Object.freeze(["software", "documents", "data", "research", "operations"] as const);
export const AUTHORITY_VALUES = Object.freeze([
  "reads-files",
  "writes-files",
  "reads-systems",
  "updates-systems",
  "triggers-systems",
  "runs-commands",
  "reaches-network",
  "sends-messages",
  "spends-money",
] as const);
export const CEILING_KEYS = Object.freeze(["job_seconds", "cost_per_job", "spend_per_job", "messages_per_job"] as const);

/** A system as an offering check reads it: its name (or the `role` alias) and its access. */
export interface SystemRef {
  name?: unknown;
  role?: unknown;
  access?: unknown;
}

/** The agent's data use, which an open-ended offering's agent must declare. */
export interface DataUse {
  retention?: unknown;
  processors?: unknown;
  memory?: unknown;
}

const has = (list: readonly string[], v: unknown): boolean => typeof v === "string" && list.includes(v);

/**
 * What a Section 6.11 checker would say about one offering, in words, inside a
 * Descriptor with these `systems` and this agent-level data use. An empty list
 * passes. Each problem starts with the offering's id and a colon.
 */
export function offeringScopeProblems(o: unknown, { systems = [], dataUse = null }: { systems?: readonly SystemRef[]; dataUse?: DataUse | null } = {}): string[] {
  const out: string[] = [];
  if (!o || typeof o !== "object") return ["an offering is an object"];
  const off = o as Record<string, unknown>;
  const id = (off.id as string | undefined) ?? "?";
  const scope = off.scope ?? "task-specific";
  if (off.scope !== undefined && !has(SCOPE_VALUES, off.scope)) out.push(`${id}: scope "${String(off.scope)}" is not one of ${SCOPE_VALUES.join(", ")}`);
  if (off.focus !== undefined && !has(FOCUS_VALUES, off.focus)) out.push(`${id}: focus "${String(off.focus)}" is not one of ${FOCUS_VALUES.join(", ")}`);
  const auth = off.authority;
  if (auth !== undefined) {
    if (!Array.isArray(auth)) out.push(`${id}: authority is a list`);
    else for (const a of auth) if (!has(AUTHORITY_VALUES, a)) out.push(`${id}: authority "${String(a)}" is not one of the nine, so the whole list is unreadable`);
  }
  if (off.authority_decided_by !== undefined && !["rule", "model"].includes(off.authority_decided_by as string)) out.push(`${id}: authority_decided_by is rule or model`);
  const c = off.ceilings as Record<string, unknown> | undefined;
  if (c !== undefined) {
    if (!c || typeof c !== "object" || Array.isArray(c)) out.push(`${id}: ceilings is an object`);
    else
      for (const [k, v] of Object.entries(c)) {
        const cv = v as Record<string, unknown> | null;
        if (!has(CEILING_KEYS, k)) out.push(`${id}: ceilings.${k} is not one of ${CEILING_KEYS.join(", ")}`);
        else if (!cv || typeof cv !== "object" || cv.most === undefined) out.push(`${id}: ceilings.${k} is { most, decided_by }`);
        else if (cv.decided_by !== undefined && !["rule", "model"].includes(cv.decided_by as string)) out.push(`${id}: ceilings.${k}.decided_by is rule or model`);
      }
  }
  const ws = off.workspace;
  if (ws !== undefined) {
    if (!Array.isArray(ws)) out.push(`${id}: workspace is a list`);
    else
      for (const w of ws) {
        if (!w || typeof w !== "object") {
          out.push(`${id}: a workspace entry is an object`);
          continue;
        }
        const we = w as Record<string, unknown>;
        if (Object.keys(we).some((k) => ["uri", "url", "href", "address", "path"].includes(k)) || Object.values(we).some((v) => typeof v === "string" && /:\/\//.test(v))) {
          out.push(`${id}: a workspace entry carries shapes and never an address`);
        }
        if (we.system !== undefined) {
          if (!systems.some((s) => (s?.name ?? s?.role) === we.system)) out.push(`${id}: workspace names the system "${String(we.system)}", which systems[] does not declare`);
          continue;
        }
        if (typeof we.kind !== "string" || !we.kind) out.push(`${id}: a workspace entry names its kind`);
        if (!["read", "read-write"].includes(we.access as string)) out.push(`${id}: a workspace entry's access is read or read-write`);
      }
  }
  const open = scope === "open-with-focus" || scope === "open-ended";
  if (scope === "open-with-focus") {
    if (off.focus === undefined) out.push(`${id}: open-with-focus declares its focus`);
    if (!Array.isArray(ws)) out.push(`${id}: open-with-focus declares its workspace, even an empty one`);
    if (!Array.isArray(off.outputs) || !off.outputs.length) out.push(`${id}: open-with-focus declares at least one deliverable in outputs`);
  }
  if (open) {
    if (!Array.isArray(auth)) out.push(`${id}: an open offering declares its authority`);
    if (!c || typeof c !== "object") out.push(`${id}: an open offering declares its ceilings`);
    else for (const k of ["job_seconds", "cost_per_job"]) if (!c[k]) out.push(`${id}: an open offering's ceilings include ${k}`);
  }
  if (scope === "open-ended") {
    for (const k of ["retention", "processors", "memory"] as const) if (dataUse?.[k] === undefined) out.push(`${id}: an open-ended offering's agent declares its data use ${k}`);
  }
  if (Array.isArray(auth)) {
    if (auth.includes("spends-money") && !c?.spend_per_job) out.push(`${id}: spend_per_job is required where authority includes spends-money`);
    if (auth.includes("sends-messages") && !c?.messages_per_job) out.push(`${id}: messages_per_job is required where authority includes sends-messages`);
    const need: Record<string, string> = { "reads-systems": "read", "updates-systems": "write", "triggers-systems": "trigger" };
    for (const [a, access] of Object.entries(need)) {
      if (auth.includes(a) && !systems.some((s) => s?.access === access)) out.push(`${id}: ${a} needs a systems[] entry with access ${access}`);
    }
  }
  return out;
}

/** Whether a problem is the data-use one: the install, not the draft Descriptor, carries the agent's data use. */
export const isDataUseProblem = (p: string): boolean => /declares its data use/.test(p);
