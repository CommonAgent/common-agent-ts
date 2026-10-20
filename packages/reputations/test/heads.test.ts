// Changing a bureau's witness list (§4.1.1): one witness joins or leaves per
// change, the change is the bureau's own, and the cached tree answers as the
// plain one does.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SparseTree,
  WITNESSES_TAG,
  rootFromProof,
  seedSigner,
  signedBytes,
  slotsOf,
  witnessChangeSigned,
  witnessListHash,
  type Witness,
  type WitnessChange,
} from "../index.js";

const signer = (n: string) => seedSigner(new Uint8Array(createHash("sha256").update(n).digest()));
const w1s = signer("one");
const w2s = signer("two");
const w3s = signer("three");
const w = (id: string, key: string): Witness => ({ id, key, kind: "cosigner" });
const W1 = w("https://w.example/1", w1s.key);
const W2 = w("https://w.example/2", w2s.key);
const W3 = w("https://w.example/3", w3s.key);
const BUREAU = "https://bureau.example";

function signedChange(from: Witness[], to: Witness[], by: Array<{ id: string; s: ReturnType<typeof signer> }>, bureau = BUREAU) {
  const change: WitnessChange = { bureau, previous: witnessListHash(from), after: null, witnesses: to };
  return { change, signatures: by.map((b) => ({ witness: b.id, sig: Buffer.from(b.s.sign(signedBytes(WITNESSES_TAG, change))).toString("base64") })) };
}

describe("a change of the witness list", () => {
  it("holds when one witness joins, signed by the list it changes", () => {
    const c = signedChange([W1], [W1, W2], [{ id: W1.id, s: w1s }]);
    expect(witnessChangeSigned([W1], c.change, c.signatures, { bureau: BUREAU })).toBe("ok");
  });
  it("refuses two witnesses moving at once, even signed by all", () => {
    const c = signedChange([W1, W2], [W1, W3], [{ id: W1.id, s: w1s }, { id: W2.id, s: w2s }]);
    expect(witnessChangeSigned([W1, W2], c.change, c.signatures, { bureau: BUREAU })).toMatch(/exactly one witness/);
    const none = signedChange([W1], [W1], [{ id: W1.id, s: w1s }]);
    expect(witnessChangeSigned([W1], none.change, none.signatures, { bureau: BUREAU })).toMatch(/exactly one witness/);
  });
  it("refuses another bureau's change", () => {
    const c = signedChange([W1], [W1, W2], [{ id: W1.id, s: w1s }], "https://other.example");
    expect(witnessChangeSigned([W1], c.change, c.signatures, { bureau: BUREAU })).toMatch(/another bureau/);
  });
});

describe("the cached tree", () => {
  it("answers every proof, present and absent, with the root it built", () => {
    const heads = Array.from({ length: 300 }, (_, i) => ({ subject: `subject-${i}`, seq: i + 1, head_hash: `h${i}` }));
    const slots = slotsOf(heads);
    const tree = new SparseTree(slots);
    for (const key of [...slots.keys()].slice(0, 50)) expect(rootFromProof(key, tree.get(key), tree.proof(key))).toBe(tree.root);
    const absent = createHash("sha256").update("nobody").digest("hex");
    expect(tree.get(absent)).toBeNull();
    expect(rootFromProof(absent, null, tree.proof(absent))).toBe(tree.root);
  });
});
