/**
 * The Agent Mandate conformance files for documents and checks, pinned at
 * mandate-v0.6.1-draft (standards-pin.json), run by this core: identifiers,
 * signed bytes and signatures, shapes, chains, the check at approval and the
 * check for an Agent NDA.
 */
import { describe, expect, it } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import {
  CHARTER_SIG_PREFIX,
  MANDATE_SIG_PREFIX,
  checkAtApproval,
  deriveId,
  idCheck,
  signedBody,
  validateCharter,
  validateMandate,
  verifyCharterSignatures,
  verifyDocSignature,
  verifyMandateChain,
  type ApprovalRequest,
  type CharterDoc,
  type ChainCheck,
  type MandateDoc,
  type MandateRegistryView,
} from "../index.js";

type Doc = Record<string, unknown>;
const read = (name: string) => loadPinnedVectors(`mandate/conformance/${name}`).data;
const documentsFile = read("mandate-documents.json");
const checksFile = read("mandate-checks.json");

const isCharter = (d: Doc) => d.charter === "v1";
const prefixOf = (tag: string) => (tag === "agent-charter-v1" ? CHARTER_SIG_PREFIX : MANDATE_SIG_PREFIX);

describe("mandate-documents.json", () => {
  for (const c of documentsFile.identifiers as Array<{ name: string; prefix: "org" | "mnd"; document: Doc; expect_id: string }>) {
    it(`identifier: ${c.name}`, () => {
      expect(deriveId(c.prefix, c.document)).toBe(c.expect_id);
      expect(c.document.id).toBe(c.expect_id);
    });
  }

  for (const c of documentsFile.minted_earlier as Array<{ name: string; document: Doc; derives: string }>) {
    it(`minted earlier: ${c.name}`, () => {
      const v = validateCharter(c.document);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(verifyCharterSignatures(v.doc).ok).toBe(true);
      expect(idCheck("org", c.document)).toEqual({ derived: c.derives, matches: false });
    });
  }

  for (const c of documentsFile.signatures as Array<{ name: string; tag: string; document: Doc; signed_bytes?: string; expect: "valid" | "invalid" }>) {
    it(`signature: ${c.name}`, () => {
      const prefix = prefixOf(c.tag);
      const body = signedBody(c.document);
      if (c.signed_bytes !== undefined) expect(`${prefix}${body}`).toBe(c.signed_bytes);
      const sigs = c.document.signatures as Array<{ role: string; key: string; signed_at: string; sig: string }>;
      const ok = sigs.length > 0 && sigs.every((s) => verifyDocSignature(prefix, body, s));
      expect(ok).toBe(c.expect === "valid");
    });
  }

  for (const c of documentsFile.shapes as Array<{ name: string; document: Doc; expect: "valid" | "refused" }>) {
    it(`shape: ${c.name}`, () => {
      const v = isCharter(c.document) ? validateCharter(c.document) : validateMandate(c.document);
      expect(v.ok).toBe(c.expect === "valid");
    });
  }
});

/** The words the file uses for each chain check this core reports. */
const FAILS: Record<ChainCheck, string> = {
  charter_signatures: "charter signatures",
  charter_suspended: "charter suspended",
  organization: "organization",
  chain_order: "chain order",
  issuer_signature: "issuer signature",
  root_signature: "root authority",
  narrowing: "narrowing",
  revoked: "revoked",
  term: "term",
};

describe("mandate-checks.json", () => {
  const documents = checksFile.documents as Record<string, Doc>;
  const charter = documents.charter as unknown as CharterDoc;

  for (const c of checksFile.chains as Array<{ name: string; mandates: string[]; at: string; revoked: string[]; expect: { ok: boolean; depth?: number; fails?: string } }>) {
    it(`chain: ${c.name}`, () => {
      const verdict = verifyMandateChain(
        { charter, mandates: c.mandates.map((n) => documents[n] as unknown as MandateDoc) },
        { now: Date.parse(c.at), charterState: "active", revoked: new Set(c.revoked) },
      );
      if (c.expect.ok) {
        expect(verdict).toMatchObject({ ok: true, depth: c.expect.depth });
      } else {
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(FAILS[verdict.check]).toBe(c.expect.fails);
      }
    });
  }

  for (const c of checksFile.approvals as Array<{
    name: string;
    registry: { charter_state: "active" | "suspended"; mandates: string[]; revoked: string[] };
    request: Record<string, unknown> & { at: string };
    expect: { ok: boolean; mandate?: string; check?: number | string };
  }>) {
    it(`approval: ${c.name}`, () => {
      const held = c.registry.mandates.map((n) => documents[n] as unknown as MandateDoc);
      const byId = new Map(held.map((m) => [m.id, m]));
      const registry: MandateRegistryView = {
        charter: (org) => (org === charter.id ? { doc: charter, state: c.registry.charter_state } : null),
        chainOf: (id) => {
          const out: MandateDoc[] = [];
          let m = byId.get(id);
          while (m) {
            out.push(m);
            if (m.issuer.kind === "root") return out;
            m = byId.get(m.issuer.mandate);
          }
          return null;
        },
        revokedAmong: (ids) => new Set(ids.filter((i) => c.registry.revoked.includes(i))),
        mandatesForAccount: (org, account) => held.filter((m) => m.organization === org && m.holder.account === account).map((doc) => ({ doc })),
      };
      const { at, ...rest } = c.request;
      const verdict = checkAtApproval(registry, { ...(rest as unknown as ApprovalRequest), now: Date.parse(at) });
      if (c.expect.ok) {
        expect(verdict).toMatchObject({ ok: true, mandate: c.expect.mandate });
      } else if (c.expect.check === "7.2 step 4") {
        expect(verdict).toMatchObject({ ok: false, name: "nda_categories" });
      } else {
        expect(verdict).toMatchObject({ ok: false, check: c.expect.check });
      }
    });
  }
});
