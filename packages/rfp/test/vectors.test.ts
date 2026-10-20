// The Agent RFP conformance files, pinned in standards-pin.json: rfp-posting.json
// at rfp-v0.11.0-draft and rfp-sealed-body.json at rfp-v0.10.0-draft.
//
// The files are the authority: when a case fails, the core is wrong, or the
// specification changed and the copy is stale.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPinnedVectors } from "../../vectors/index.js";
import {
  bodyDigest,
  bodyRefRefusal,
  canonicalJSON,
  nonceRefusal,
  sealedBodyRefusal,
  postingState,
  resolveActTagged,
  responseDocCheck,
  rfpHashedJSON,
  rfpIdFor,
  rfpSignedJSON,
  verifyResolveAct,
  verifyRfp,
  type PostingFacts,
  type ProposalDoc,
  type RfpPostingDoc,
  type RfpResolveActBody,
} from "../index.js";

const file = loadPinnedVectors("rfp/conformance/rfp-posting.json").data as Record<string, any>;
const asRecord = (d: unknown) => d as Record<string, unknown>;

describe("identity and signed bytes (§4.1, §6)", () => {
  const { posting, hashed_json, id, signed_json, sig_prefix } = file.identity;

  it("derives the identifier from the hashed bytes", () => {
    expect(rfpHashedJSON(asRecord(posting))).toBe(hashed_json);
    expect(rfpIdFor(asRecord(posting))).toBe(id);
    expect(posting.id).toBe(id);
  });

  it("signs the signed bytes, which keep the id", () => {
    expect(rfpSignedJSON(asRecord(posting))).toBe(signed_json);
    expect(sig_prefix).toBe("agent-rfp-v1\n");
    expect(verifyRfp(posting as RfpPostingDoc)).toBe(true);
  });

  for (const c of file.identity.invalid as Array<{ case: string; posting: RfpPostingDoc }>) {
    it(`refuses ${c.case}`, () => expect(verifyRfp(c.posting)).toBe(false));
  }
});

describe("acts (§6)", () => {
  for (const c of file.acts.valid as Array<{ body: RfpResolveActBody; tagged: string; key: string; sig: string }>) {
    it(`verifies ${c.body.action}`, () => {
      expect(resolveActTagged(c.body)).toBe(c.tagged);
      expect(verifyResolveAct(c.body, c.key, c.sig)).toBe(true);
    });
  }
  for (const c of file.acts.invalid as Array<{ case: string; body: RfpResolveActBody; key: string; sig: string }>) {
    it(`refuses ${c.case}`, () => expect(verifyResolveAct(c.body, c.key, c.sig)).toBe(false));
  }
});

describe("lifecycle (§9)", () => {
  for (const c of file.lifecycle.cases as Array<{ case: string; doc: PostingFacts["doc"]; acts: Array<{ action: RfpResolveActBody["action"] }>; granted?: number; now: string; state: string }>) {
    it(c.case, () => {
      expect(postingState({ doc: c.doc, acts: c.acts.map((a) => ({ body: a })), granted: c.granted }, c.now)).toBe(c.state);
    });
  }
});

describe("responses (§7)", () => {
  const { posting, now } = file.responses;
  for (const c of file.responses.cases as Array<{ case: string; agent: string; proposal: ProposalDoc; refused: string | null }>) {
    it(c.case, () => {
      expect(responseDocCheck(posting, c.proposal, c.agent, now)?.rule ?? null).toBe(c.refused);
    });
  }
});

describe("gated postings (§5.11)", () => {
  const g = file.gate;

  it("commits the signed public document to the sealed body by digest", () => {
    const posting = g.posting as RfpPostingDoc;
    expect(verifyRfp(posting)).toBe(true);
    expect(rfpIdFor(asRecord(posting))).toBe(posting.id);
    expect(bodyDigest(g.body_bytes)).toBe(g.body_digest);
    expect(posting.gate?.body.digest).toBe(g.body_digest);
    for (const m of g.public_members_absent as string[]) expect(asRecord(posting)[m]).toBeUndefined();
  });

  it("carries the nonce the label derives", () => {
    const body = JSON.parse(g.body_bytes);
    expect(nonceRefusal(body.nonce)).toBeNull();
    expect(body.nonce).toBe(createHash("sha256").update(g.nonce_label, "utf8").digest().subarray(0, 16).toString("base64"));
    expect(canonicalJSON(body)).toBe(g.body_bytes);
  });
});

describe("a gate's body ref never names the posting (§5.11.1, 0.11.0-draft)", () => {
  for (const c of file.body_refs as Array<{ case: string; posting_id: string; ref?: string; valid: boolean }>) {
    it(c.case, () => {
      expect(bodyRefRefusal(c.ref, c.posting_id) === null).toBe(c.valid);
    });
  }
});

// The standard's own file for the sealed body, pinned at rfp-v0.10.0-draft.
describe("rfp-sealed-body.json (pinned)", () => {
  const pinned = loadPinnedVectors("rfp/conformance/rfp-sealed-body.json").data as {
    nonce_label: string;
    body: Record<string, unknown> & { nonce: string; language: string };
    bytes: string;
    digest: string;
    invalid: Array<{ case: string; remove?: string; nonce?: string }>;
    traps: Array<{ case: string; digest: string }>;
  };

  it("hashes the example body, nonce and all, to its digest", () => {
    expect(canonicalJSON(pinned.body)).toBe(pinned.bytes);
    expect(bodyDigest(pinned.bytes)).toBe(pinned.digest);
    expect(sealedBodyRefusal(pinned.body, "en")).toBeNull();
    expect(pinned.body.nonce).toBe(createHash("sha256").update(pinned.nonce_label, "utf8").digest().subarray(0, 16).toString("base64"));
  });

  for (const c of pinned.invalid) {
    it(`refuses ${c.case}`, () => {
      const body: Record<string, unknown> = { ...pinned.body };
      if (c.remove) delete body[c.remove];
      if (c.nonce !== undefined) body.nonce = c.nonce;
      expect(sealedBodyRefusal(body, "en")).not.toBeNull();
    });
  }

  for (const t of pinned.traps) {
    it(`does not mistake ${t.case} for the body's digest`, () => {
      expect(bodyDigest(pinned.bytes)).not.toBe(t.digest);
    });
  }
});
