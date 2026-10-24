// The packer's input as an agent is now kept: a folder holding
// agent-descriptor.json, agent-runtime-requirements.json and plugin.json
// directly, with its skills. The old file names are read with a warning, and
// the spec input still works, with a warning that it is deprecated.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, type Io } from "../cli.js";

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});
const NOW = new Date("2026-10-24T12:00:00Z");

function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW };
  const code = main(args, io);
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(out.join("\n"));
  } catch {
    json = null;
  }
  return { code, out: json, stdout: out.join("\n"), stderr: err.join("\n") };
}
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const SPEC = {
  name: "brief-summarizer",
  version: "1.0.0",
  description: "Summarizes a document into a one-page brief.",
  license: "Apache-2.0",
  author: { name: "A. Builder" },
  repository: "https://example.com/brief-summarizer.git",
  jobs: [{ slug: "summarize", title: "Summarize a document", when: "when a document arrives", inputs: [{ name: "document", kind: "document", required: true }] }],
  systems: [{ name: "speech", access: "trigger", kind: "service", credential: "speech-key", env: "SPEECH_TOKEN", spends: { unit: "characters" } }],
  refuses: ["summarizing a document it could not read"],
  records: ["the brief as sent"],
};

/** A package built from the spec, whose folder is then an agent's folder as it is now kept. */
function agentFolder(): { dir: string; first: Record<string, any> } {
  const src = tmp("spec-src-");
  writeFileSync(join(src, "agent.json"), JSON.stringify(SPEC));
  const r = run([src, "--json"]);
  expect(r.code, r.stderr).toBe(0);
  const dir = join(tmp("agent-"), "brief-summarizer");
  cpSync(r.out?.package_dir, dir, { recursive: true });
  return { dir, first: r.out as Record<string, any> };
}

describe("packing an agent's folder", () => {
  it("packs the three files and the skills, and gives the same package the spec gave", () => {
    const { dir, first } = agentFolder();
    rmSync(join(dir, "net.agentdoc.package"), { recursive: true });
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.out?.warnings).toEqual([]);
    expect(r.out?.sha256).toBe(first.sha256);
    expect(r.out?.descriptor_sha256).toBe(first.descriptor_sha256);
    const manifest = readJson(join(r.out?.package_dir, "plugin.json"));
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.author).toEqual({ name: "A. Builder" });
    expect(manifest.repository).toBe("https://example.com/brief-summarizer.git");
    expect(existsSync(join(r.out?.package_dir, "net.agentdoc.package", "NOT.md")), "the views are generated again").toBe(true);
  });

  it("warns that the spec input is deprecated", () => {
    const src = tmp("spec-src-");
    writeFileSync(join(src, "agent.json"), JSON.stringify(SPEC));
    const r = run([src]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: packing from a spec \(agent\.json\) is deprecated/);
  });

  it("reads the old file names, with a warning for each, and writes the new ones", () => {
    const { dir } = agentFolder();
    renameSync(join(dir, "agent-descriptor.json"), join(dir, "descriptor.json"));
    renameSync(join(dir, "agent-runtime-requirements.json"), join(dir, "install.json"));
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.out?.warnings).toHaveLength(2);
    expect(r.out?.warnings[0]).toMatch(/descriptor\.json is read as agent-descriptor\.json/);
    expect(existsSync(join(r.out?.package_dir, "agent-descriptor.json"))).toBe(true);
    expect(existsSync(join(r.out?.package_dir, "descriptor.json"))).toBe(false);
  });

  it("refuses a folder that holds both names for one file", () => {
    const { dir } = agentFolder();
    cpSync(join(dir, "agent-descriptor.json"), join(dir, "descriptor.json"));
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code).toBe(1);
    expect(r.out?.refused).toMatch(/holds both agent-descriptor\.json and descriptor\.json/);
  });

  it("never invents what the agent refuses or records", () => {
    const { dir } = agentFolder();
    const p = join(dir, "agent-descriptor.json");
    const desc = readJson(p);
    desc.refusals = "";
    writeFileSync(p, JSON.stringify(desc));
    const r = run([dir, "--out", tmp("out-")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/does not say what the agent refuses/);
    expect(r.stderr).toMatch(/Add "refusals" to .*agent-descriptor\.json/);
  });

  it("generates a SKILL.md an offering lacks, and fills a lockfile's digest", () => {
    const { dir } = agentFolder();
    rmSync(join(dir, "skills", "summarize", "SKILL.md"));
    mkdirSync(join(dir, "skills", "summarize", "scripts"), { recursive: true });
    writeFileSync(join(dir, "skills", "summarize", "scripts", "package-lock.json"), "{}\n");
    const rp = join(dir, "agent-runtime-requirements.json");
    const inst = readJson(rp);
    inst.dependencies = [{ skill: "summarize", lockfile: "skills/summarize/scripts/package-lock.json" }];
    writeFileSync(rp, JSON.stringify(inst));
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code, r.stdout).toBe(0);
    const md = readFileSync(join(r.out?.package_dir, "skills", "summarize", "SKILL.md"), "utf8");
    expect(md.startsWith("---\nname: summarize\n")).toBe(true);
    expect(r.out?.lockfiles[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a draft that carries a subject", () => {
    const { dir } = agentFolder();
    const p = join(dir, "agent-descriptor.json");
    writeFileSync(p, JSON.stringify({ ...readJson(p), subject: "UEXAMPLE" }));
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code).toBe(1);
    expect(r.out?.refused).toMatch(/carries subject/);
  });
});

describe("packing a folder written by hand", () => {
  function handWritten(): string {
    const dir = join(tmp("hand-"), "notes-taker");
    mkdirSync(join(dir, "skills", "take-notes"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "notes-taker", version: "0.2.0", description: "Takes notes from a meeting transcript.", license: "MIT" }));
    writeFileSync(join(dir, "agent-descriptor.json"), JSON.stringify({
      format: "agent-descriptor-v1", agent_version: "0.2.0", does: "Takes notes from a meeting transcript.",
      offerings: [{ id: "take-notes", name: "Take notes", does: "Turns a transcript into notes.", inputs: [{ name: "transcript", kind: "text", required: true }] }],
      refusals: "inventing what nobody said.", records: [{ name: "the notes as sent", when: "per_task" }],
    }));
    writeFileSync(join(dir, "agent-runtime-requirements.json"), JSON.stringify({ format: "agent-install-v1", runtimes: [], binaries: [], dependencies: [], systems: [], ceilings: [], directories: [] }));
    return dir;
  }

  it("packs it, generating the skill, the views and the README", () => {
    const r = run([handWritten(), "--json", "--out", tmp("out-")]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.out?.version).toBe("0.2.0");
    const m = readJson(join(r.out?.package_dir, "plugin.json"));
    expect(m.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(m.license).toBe("MIT");
    for (const f of ["skills/take-notes/SKILL.md", "net.agentdoc.package/RECORDS.md", "README.md"]) expect(existsSync(join(r.out?.package_dir, f)), f).toBe(true);
  });

  it("refuses versions that disagree", () => {
    const dir = handWritten();
    const p = join(dir, "plugin.json");
    writeFileSync(p, JSON.stringify({ ...readJson(p), version: "2.0.0" }));
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code).toBe(1);
    expect(r.out?.refused).toMatch(/they are one version/);
  });

  it("refuses a step that is not an object, rather than failing", () => {
    const dir = handWritten();
    const p = join(dir, "agent-descriptor.json");
    const d = readJson(p);
    d.offerings[0].steps = [null];
    writeFileSync(p, JSON.stringify(d));
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code).toBe(1);
    expect(r.out?.refused).toMatch(/is an object/);
  });

  it("warns about a file it does not pack, and keeps the warnings when it refuses", () => {
    const dir = handWritten();
    writeFileSync(join(dir, "notes.txt"), "scratch\n");
    const ok = run([dir, "--json", "--out", tmp("out-")]);
    expect(ok.out?.warnings).toEqual(["notes.txt is not packed; a package carries plugin.json, the two authored files, mcp.json, README.md and skills/"]);
    renameSync(join(dir, "agent-descriptor.json"), join(dir, "descriptor.json"));
    const p = join(dir, "descriptor.json");
    writeFileSync(p, JSON.stringify({ ...readJson(p), records: [] }));
    const r = run([dir, "--json", "--out", tmp("out-")]);
    expect(r.code).toBe(1);
    expect(r.out?.refused).toMatch(/^descriptor.json does not say what records/);
    expect(r.out?.warnings.some((w: string) => /descriptor.json is read as/.test(w))).toBe(true);
  });

  it("asks for the folder when given one of its files", () => {
    const dir = handWritten();
    const r = run([join(dir, "agent-descriptor.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pack the folder that holds it/);
  });
});

describe("validating under the old names", () => {
  it("passes a package built before the rename, with a warning for each old name", () => {
    const { dir } = agentFolder();
    renameSync(join(dir, "agent-descriptor.json"), join(dir, "descriptor.json"));
    renameSync(join(dir, "agent-runtime-requirements.json"), join(dir, "install.json"));
    const mp = join(dir, "plugin.json");
    const m = readJson(mp);
    m.extensions["net.agentdoc.package"].descriptor.path = "descriptor.json";
    m.extensions["net.agentdoc.package"].install.path = "install.json";
    writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
    const v = run(["validate", dir, "--json"]);
    expect(v.code, v.stdout).toBe(0);
    expect(v.out?.warnings).toHaveLength(2);
  });
});
