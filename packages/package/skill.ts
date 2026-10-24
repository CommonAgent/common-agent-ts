/**
 * Skills (Common Agent 12.5): one skill folder per job, an Agent Skill with
 * a SKILL.md whose frontmatter names it and says when to use it. A skill the
 * developer wrote is packed as written; a missing one is generated from the
 * job's lines.
 */
import type { JobSpec } from "./types.js";

/** What was copied into a skill's folders, by the name each copy has there. */
export interface Copied {
  scripts: string[];
  references: string[];
  assets: string[];
}

/** A generated SKILL.md for a job, from its `when`, `good` and `empty` lines, its inputs and outputs, and what was copied. */
export function skillMd(job: JobSpec, agentName: string, copied: Copied, instructions?: string): string {
  const when = String(job.when ?? "When the request matches this job.").trim();
  const lines = ["---", `name: ${job.slug}`, `description: ${when.slice(0, 1024)}`, "---", "", `# ${job.title}`, "", `Part of ${agentName}. ${when}`, "", "## When to use this", "", when, ""];
  if (job.inputs?.length) {
    lines.push("## What this needs", "");
    for (const i of job.inputs) lines.push(`- ${i.name} (${i.kind}, ${i.required ? "required" : "optional"})`);
    lines.push("");
  }
  lines.push("## What a good result looks like", "", String(job.good ?? "The job is done and its records are left.").trim(), "");
  if (job.outputs?.length) {
    lines.push("## What it produces", "");
    for (const o of job.outputs) lines.push(`- ${o.name} (${o.kind}${o.when ? `, ${o.when.replace("_", " ")}` : ""})`);
    lines.push("");
  }
  lines.push("## When it comes back empty", "", String(job.empty ?? "Say so plainly and name what is missing, rather than inventing a result.").trim(), "");
  if (instructions) lines.push("## How to do it", "", String(instructions).trim(), "");
  if (copied.scripts.length) lines.push("## Scripts", "", "Run these from this skill's folder; each one says what it needs at the top.", "", ...copied.scripts.map((p) => `- scripts/${p}`), "");
  if (copied.references.length) lines.push("## References", "", ...copied.references.map((p) => `- references/${p}`), "");
  if (copied.assets.length) lines.push("## Assets", "", "Templates and resources the scripts fill in; never edited by hand.", "", ...copied.assets.map((p) => `- assets/${p}`), "");
  return lines.join("\n");
}

/** Whether a SKILL.md has frontmatter carrying a `name` and a `description`, as the Agent Skills format requires. */
export function hasSkillFrontmatter(text: string): boolean {
  const fm = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : "";
  return /^\s*name:\s*\S/m.test(fm) && /^\s*description:\s*\S/m.test(fm);
}
