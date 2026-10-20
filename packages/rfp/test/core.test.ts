/**
 * The Agent RFP core on its own: a posting minted, signed and verified with a
 * key held outside the core, the two byte strings kept apart, acts signed
 * under their own tag, the lifecycle derived on read, and a response's
 * document checked against the posting it answers. The pinned conformance
 * files run in vectors.test.ts; these cases need no fixture and no platform.
 */
import { describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import {
  assemblePosting,
  mintPostingId,
  postingState,
  refusePosting,
  resolveActTagged,
  responseDocRefusal,
  rfpHashedJSON,
  rfpIdFor,
  rfpSignedJSON,
  signResolveAct,
  signRfp,
  verifyResolveAct,
  verifyRfp,
  type ProposalDoc,
  type RfpPostingDoc,
  type RfpPostingInput,
  type RfpResolveActBody,
  type Signer,
} from "../index.js";

// ── a key the core never sees the private half of ───────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** A user nkey and a signer for it, from Node's own Ed25519. */
function testKey(): { key: string; signer: Signer } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
  const raw = Buffer.from(jwk.x, "base64url");
  const payload = Uint8Array.from([20 << 3, ...raw]);
  const crc = crc16(payload);
  const key = base32(Uint8Array.from([...payload, crc & 0xff, crc >> 8]));
  return { key, signer: { sign: (data) => new Uint8Array(sign(null, data, priv)) } };
}

const NOW = "2026-10-20T12:00:00Z";
const POSTED = "2026-10-20T12:00:00Z";
const EXPIRES = "2026-11-20T12:00:00Z";

function input(over: Partial<RfpPostingInput> = {}): RfpPostingInput {
  return {
    posted_at: POSTED,
    expires_at: EXPIRES,
    poster: { agent: "UPOSTER", owner: "Harbor & Line Outfitters" },
    need: { summary: "Audit inbound freight invoices and flag overbilling." },
    ...over,
  };
}

function minted(poster: string, signer: Signer): RfpPostingDoc {
  const body = assemblePosting(input({ poster: { agent: poster, owner: "Harbor & Line Outfitters" } }));
  body.id = mintPostingId(body);
  const sig = signRfp(body as unknown as Record<string, unknown>, signer);
  return { ...body, signatures: [{ role: "poster", key: poster, held_by: "platform", signed_at: POSTED, sig }] };
}

describe("a posting minted, signed and verified", () => {
  const { key, signer } = testKey();
  const doc = minted(key, signer);

  it("derives the identifier from the hashed bytes, which leave out id and signatures", () => {
    expect(doc.id).toMatch(/^rfp_[0-9abcdefghjkmnpqrstvwxyz]{16}$/);
    expect(rfpIdFor(doc as unknown as Record<string, unknown>)).toBe(doc.id);
    const hashed = rfpHashedJSON(doc as unknown as Record<string, unknown>);
    expect(hashed).not.toContain('"id"');
    expect(hashed).not.toContain('"signatures"');
  });

  it("signs the signed bytes, which keep id", () => {
    expect(rfpSignedJSON(doc as unknown as Record<string, unknown>)).toContain(`"id":"${doc.id}"`);
    expect(verifyRfp(doc)).toBe(true);
  });

  it("refuses a changed posting, another key, and a missing signature", () => {
    expect(verifyRfp({ ...doc, expires_at: "2026-12-31T00:00:00Z" })).toBe(false);
    expect(verifyRfp({ ...doc, signatures: [{ ...doc.signatures[0], key: testKey().key }] })).toBe(false);
    expect(verifyRfp({ ...doc, signatures: [] })).toBe(false);
    expect(verifyRfp({ ...doc, signatures: [{ ...doc.signatures[0], sig: 42 as unknown as string }] })).toBe(false);
  });

  it("signs an act under its own tag, naming the action", () => {
    const act: RfpResolveActBody = { posting: doc.id, version: 1, action: "award", response: "sow_x", at: NOW };
    expect(resolveActTagged(act).startsWith("agent-rfp-resolve-v1\n")).toBe(true);
    const sig = signResolveAct(act, signer);
    expect(verifyResolveAct(act, key, sig)).toBe(true);
    // A relay cannot turn an award into a withdrawal: the action is in the bytes.
    expect(verifyResolveAct({ ...act, action: "withdraw" }, key, sig)).toBe(false);
  });
});

describe("the refusals keep a posting answerable", () => {
  it("takes a plain posting and refuses one with no need", () => {
    expect(refusePosting(input())).toBeNull();
    expect(refusePosting(input({ need: { summary: " " } }))).toMatch(/need.summary is required/);
  });

  it("refuses a buy posting with a monthly ceiling", () => {
    expect(
      refusePosting(input({ need: { summary: "A model.", procurement: "buy" }, budget: { currency: "XCR", ceiling: { amount: 1, period: "month" } } })),
    ).toMatch(/a buy budget is a fixed amount/);
  });

  it("refuses an agent-shaped posting with both a role and a profile", () => {
    expect(
      refusePosting(input({ need: { summary: "A bookkeeper.", sought: "agent", role: { offering: "role-bookkeeper", registry: "https://agentroles.ai" }, profile: "answers four questions" } })),
    ).toMatch(/exactly one of need.role or need.profile/);
  });

  it("checks handling promises against Agent SoW §5.11's list", () => {
    expect(refusePosting(input({ handling: { promises: ["no_training"] } }))).toBeNull();
    expect(refusePosting(input({ handling: { promises: ["no_spying" as "no_training"] } }))).toMatch(/Agent SoW §5.11/);
  });
});

describe("the lifecycle is derived on read", () => {
  const doc = { expires_at: EXPIRES } as Pick<RfpPostingDoc, "expires_at" | "respond" | "resolution">;

  it("is open before expiry and expired after", () => {
    expect(postingState({ doc, acts: [] }, NOW)).toBe("open");
    expect(postingState({ doc, acts: [] }, EXPIRES)).toBe("expired");
  });

  it("takes the terminal act first, and a responder's withdrawal is not one", () => {
    expect(postingState({ doc, acts: [{ body: { action: "award" } }] }, EXPIRES)).toBe("awarded");
    expect(postingState({ doc, acts: [{ body: { action: "close" } }] }, NOW)).toBe("closed");
    expect(postingState({ doc, acts: [{ body: { action: "withdraw" } }] }, NOW)).toBe("withdrawn");
    expect(postingState({ doc, acts: [{ body: { action: "withdraw_response" } }] }, NOW)).toBe("open");
  });

  it("fills only where messages are admitted", () => {
    const messaging = { ...doc, respond: { mode: "message" as const, grade: "recorded" as const }, resolution: { rule: "first_come" as const, seats: 2, grade: "recorded" as const } };
    expect(postingState({ doc: messaging, acts: [], granted: 2 }, NOW)).toBe("filled");
    expect(postingState({ doc: messaging, acts: [], granted: 1 }, NOW)).toBe("open");
    expect(postingState({ doc, acts: [], granted: 5 }, NOW)).toBe("open");
  });
});

describe("a response's document answers the posting it names", () => {
  const posting = { id: "rfp_9c4t7w2m5k8q1x3e", poster: { agent: "UPOSTER" }, versions: [1, 2] };
  const good: ProposalDoc = {
    id: "sow_f3q8n1z6v4b7c2m5",
    version: 1,
    parties: { provider: { agent: "URESPONDER" }, offered_to: { agent: "UPOSTER", expires_at: EXPIRES } },
    solicitation: { rfp: posting.id, version: 2 },
  };

  it("takes a document addressed to this poster for a version the posting has had", () => {
    expect(responseDocRefusal(posting, good, "URESPONDER", NOW)).toBeNull();
  });

  it("refuses each way the addressing can be wrong", () => {
    expect(responseDocRefusal(posting, good, "USOMEONEELSE", NOW)).toMatch(/provider seat names a different agent/);
    expect(responseDocRefusal(posting, { ...good, solicitation: undefined }, "URESPONDER", NOW)).toMatch(/does not say which posting/);
    expect(responseDocRefusal(posting, { ...good, solicitation: { rfp: "rfp_other", version: 1 } }, "URESPONDER", NOW)).toMatch(/answers rfp_other/);
    expect(responseDocRefusal(posting, { ...good, solicitation: { rfp: posting.id, version: 3 } }, "URESPONDER", NOW)).toMatch(/never had one/);
    expect(responseDocRefusal(posting, { ...good, parties: { provider: { agent: "URESPONDER" } } }, "URESPONDER", NOW)).toMatch(/offered to the market/);
    expect(
      responseDocRefusal(posting, { ...good, parties: { provider: { agent: "URESPONDER" }, offered_to: { agent: "UOTHER", expires_at: EXPIRES } } }, "URESPONDER", NOW),
    ).toMatch(/different party than this posting's poster/);
    expect(
      responseDocRefusal(posting, { ...good, parties: { provider: { agent: "URESPONDER" }, offered_to: { agent: "UPOSTER" } } }, "URESPONDER", NOW),
    ).toMatch(/does not say when it lapses/);
    expect(responseDocRefusal(posting, good, "URESPONDER", EXPIRES)).toMatch(/lapsed at/);
  });
});
