// The command line tool, run as a newcomer runs it, in a temporary folder,
// against a fake network serving their A2A agent:
//
//   build from the card alone, then init a Descriptor, keygen, sign, publish
//   it, build again and see the Descriptor-sourced sections, and check.
//
// Also: the seed is written readable only by its owner and never printed,
// sign refuses unchecked guesses and missing members, and every command has
// --help and the exit codes the contract names.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rawFromUserSeed } from "@common-agent/crypto";
import { main, type Io } from "../cli.js";
import { checkDescriptorSignature, encodeUserSeed } from "../signatures.js";
import { NOW, ORIGIN, SUBJECT_SEED, card, fakeFetch } from "./helpers.js";

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "agentdoc-cli-"));
  cleanups.push(d);
  return d;
};

const CARD_URL = `${ORIGIN}/.well-known/agent-card.json`;
const DESC_URL = `${ORIGIN}/.well-known/agent-descriptor.json`;

async function run(args: string[], cwd: string, f: typeof fetch = fakeFetch({})) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, fetch: f, cwd };
  const code = await main(args, io);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("the seed spelling", () => {
  it("writes the nkey user seed the family reads, and reads back the same bytes", () => {
    const raw = rawFromUserSeed(SUBJECT_SEED)!;
    expect(encodeUserSeed(raw)).toBe(SUBJECT_SEED);
  });
});

describe("common-agent-doc, end to end", () => {
  it("builds from the card, then adds a signed Descriptor in three commands, and builds again", async () => {
    const dir = tempDir();
    const routes: Record<string, unknown> = { [CARD_URL]: card() };
    const f = fakeFetch(routes as Record<string, object>);

    // 1. build from the address alone
    const first = await run(["build", ORIGIN], dir, f);
    expect(first.code, first.stderr).toBe(0);
    const jsonPath = join(dir, "agentdoc-out", ".well-known", "agentdoc.json");
    const htmlPath = join(dir, "agentdoc-out", "agentdoc.html");
    expect(existsSync(jsonPath) && existsSync(htmlPath)).toBe(true);
    const cardOnly = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(cardOnly.sources.map((s: { kind: string }) => s.kind)).toEqual(["a2a-card"]);
    expect(cardOnly.not_stated).toContain("refuses");
    expect(first.stdout).toMatch(/no Descriptor yet/);
    expect(readFileSync(htmlPath, "utf8")).toContain("Recipe Helper");

    // 2. init drafts a Descriptor from the card, with every guess marked
    const init = await run(["init", ORIGIN], dir, f);
    expect(init.code, init.stderr).toBe(0);
    const descPath = join(dir, "agent-descriptor.json");
    const draft = JSON.parse(readFileSync(descPath, "utf8"));
    expect(draft.subject).toBeUndefined();
    expect(draft.signatures).toBeUndefined();
    expect(draft._draft.guesses.length).toBeGreaterThan(0);
    expect(draft._draft.fill_in.join(" ")).toMatch(/acts_for/);
    expect(draft.offerings.map((o: { id: string }) => o.id)).toEqual(["suggest-recipes", "shopping-list"]);
    expect(JSON.stringify(draft)).not.toContain(ORIGIN);
    expect((await run(["init", ORIGIN], dir, f)).code).toBe(2);

    // 3. keygen: the seed on disk, readable only by its owner, and only the public key printed
    const keygen = await run(["keygen"], dir);
    expect(keygen.code, keygen.stderr).toBe(0);
    const keyPath = join(dir, "agent.key");
    const seed = readFileSync(keyPath, "utf8").trim();
    expect(seed).toMatch(/^SU[A-Z2-7]{56}$/);
    expect(keygen.stdout + keygen.stderr).not.toContain(seed);
    const publicKey = keygen.stdout.match(/U[A-Z2-7]{55}/)![0];
    if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect((await run(["keygen"], dir)).code).toBe(2);

    // sign refuses unchecked guesses and missing members, and says which
    const refused = await run(["sign", "agent-descriptor.json", "--key", "agent.key"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/_draft/);
    expect(refused.stderr).toMatch(/acts_for/);

    // the owner checks the guesses and fills in what was missing
    delete draft._draft;
    draft.acts_for = "organization";
    draft.organization_name = "Example Kitchen";
    draft.refusals = "medical or allergy advice.";
    draft.offerings[0].inputs = [{ name: "ingredients", kind: "text", required: true }];
    writeFileSync(descPath, JSON.stringify(draft, null, 2));

    // 4. sign binds it to the key and signs it
    const signed = await run(["sign", "agent-descriptor.json", "--key", "agent.key"], dir);
    expect(signed.code, signed.stderr).toBe(0);
    const signedText = readFileSync(descPath, "utf8");
    const signedDoc = JSON.parse(signedText);
    expect(signedDoc.subject.id).toBe(publicKey);
    expect(checkDescriptorSignature(signedDoc).state).toBe("verified");
    expect(signed.stdout + signed.stderr).not.toContain(seed);

    // 5. the owner publishes it beside the card, and build reads it
    routes[DESC_URL] = signedText;
    const second = await run(["build", ORIGIN, "--json"], dir, f);
    expect(second.code, second.stdout).toBe(0);
    const doc = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(doc.subject.id).toBe(publicKey);
    expect(doc.sources.find((s: { kind: string }) => s.kind === "agent-descriptor")).toMatchObject({ signature: "verified", url: DESC_URL });
    expect(doc.sections.identity).toMatchObject({ acts_for: "organization", organization_name: "Example Kitchen" });
    expect(doc.sections.refuses).toMatchObject({ statement: "medical or allergy advice.", kind: "prose" });
    expect(doc.not_stated).not.toContain("refuses");
    expect(readFileSync(htmlPath, "utf8")).toContain("medical or allergy advice.");

    // --descriptor names a local file instead of the published one
    const local = await run(["build", ORIGIN, "--descriptor", "agent-descriptor.json", "--out", "other"], dir, fakeFetch({ [CARD_URL]: card() }));
    expect(local.code, local.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "other", ".well-known", "agentdoc.json"), "utf8")).sections.refuses).toBeDefined();

    // 6. check the written file, and a tampered copy
    const ok = await run(["check", join("agentdoc-out", ".well-known", "agentdoc.json")], dir);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/passes every check/);
    const fetched = await run(["check", join("agentdoc-out", ".well-known", "agentdoc.json"), "--fetch-sources"], dir, f);
    expect(fetched.code, fetched.stderr).toBe(0);
    doc.score = 97;
    writeFileSync(join(dir, "bad.json"), JSON.stringify(doc));
    const bad = await run(["check", "bad.json"], dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/no-summary-grade/);
  });

  it("builds from a card file on disk", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "card.json"), JSON.stringify(card()));
    const r = await run(["build", "card.json", "--out", "site"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(dir, "site", ".well-known", "agentdoc.json"))).toBe(true);
  });

  it("exits 1 when the published Descriptor's signature does not verify", async () => {
    const dir = tempDir();
    const tampered = { format: "agent-descriptor-v1", agent_version: "1", does: "x", acts_for: "anyone", offerings: [], subject: { id: "UBMBH4BK6EIHQFVMHLSABFSQXB3JXUFZOXVZQTIERO33AD4HHAI3D7QP" }, signatures: [{ tag: "descriptor-statement-v1", by: "UBMBH4BK6EIHQFVMHLSABFSQXB3JXUFZOXVZQTIERO33AD4HHAI3D7QP", sig: "A".repeat(86) + "==" }] };
    const r = await run(["build", ORIGIN], dir, fakeFetch({ [CARD_URL]: card(), [DESC_URL]: tampered }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/does not verify/);
  });

  it("exits 2 on usage errors and on an address that serves nothing", async () => {
    const dir = tempDir();
    expect((await run([], dir)).code).toBe(2);
    expect((await run(["frobnicate"], dir)).code).toBe(2);
    expect((await run(["build"], dir)).code).toBe(2);
    expect((await run(["build", ORIGIN, "--out"], dir)).code).toBe(2);
    expect((await run(["build", ORIGIN, "--nope"], dir)).code).toBe(2);
    expect((await run(["build", ORIGIN], dir)).code).toBe(2);
    expect((await run(["check", "missing.json"], dir)).code).toBe(2);
    writeFileSync(join(dir, "card.json"), "{ not json");
    expect((await run(["check", "card.json"], dir)).code).toBe(2);
    expect((await run(["sign", "x.json"], dir)).code).toBe(2);
  });

  it("has --help for every command, in plain words", async () => {
    const dir = tempDir();
    const top = await run(["--help"], dir);
    expect(top.code).toBe(0);
    expect(top.stdout).toMatch(/agentdoc\.net/);
    for (const c of ["build", "check", "init", "keygen", "sign"]) {
      const r = await run([c, "--help"], dir);
      expect(r.code, c).toBe(0);
      expect(r.stdout, c).toContain(`common-agent-doc ${c}`);
      expect(r.stdout, c).not.toMatch(/agentmesh|—/i);
    }
  });
});
