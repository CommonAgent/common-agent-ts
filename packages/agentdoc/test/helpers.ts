// What the tests share: a fake fetch that serves fixed documents, a realistic
// A2A card, and signed documents made with test keys. The keys control
// nothing: each is the SHA-256 of a label, so no seed is written in the
// repository.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJSON, encodeSignature, sha256, sha256Digest, signTagged, signerFromRawSeed, signerFromUserSeed, utf8 } from "@common-agent/crypto";
import { encodeUserSeed, pae, signDescriptor } from "../signatures.js";
import { validate } from "./schema-validate.js";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "schema", "agentdoc-v1.schema.json"), "utf8")) as Record<string, unknown>;
export const schemaErrors = (doc: unknown): string[] => validate(SCHEMA, doc);

export const NOW = new Date("2026-11-03T12:00:00.000Z");
export const ORIGIN = "https://recipes.example";

/** The Descriptor test key: its seed, spelled as an nkey user seed, and its public key. */
export const SUBJECT_SEED = encodeUserSeed(sha256("agentdoc test key: subject"));
export const SUBJECT_KEY = signerFromUserSeed(SUBJECT_SEED).getPublicKey();
export const labelSigner = (label: string) => signerFromRawSeed(sha256(label));

type Body = string | Uint8Array | object | { status: number };
const isStatus = (b: Body): b is { status: number } => typeof b === "object" && !(b instanceof Uint8Array) && Object.keys(b).length === 1 && typeof (b as { status?: unknown }).status === "number";

/** A fetch that answers from a table of URLs, 404 for anything else, and remembers what was asked. */
export function fakeFetch(routes: Record<string, Body>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (isStatus(body)) return new Response("", { status: body.status });
    const bytes = typeof body === "string" ? body : body instanceof Uint8Array ? body : JSON.stringify(body, null, 2);
    return new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

/** A realistic A2A Agent Card (protocol 0.3), with nothing from this family on it. */
export function card(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: "0.3.0",
    name: "Recipe Helper",
    description: "Suggests recipes from the ingredients you have.",
    url: `${ORIGIN}/a2a`,
    preferredTransport: "JSONRPC",
    provider: { organization: "Example Kitchen", url: "https://kitchen.example" },
    version: "1.2.0",
    documentationUrl: `${ORIGIN}/docs`,
    capabilities: { streaming: true, pushNotifications: false },
    securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "A token from the kitchen's sign-in page." } },
    security: [{ bearer: [] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      { id: "suggest-recipes", name: "Suggest recipes", description: "Suggests three recipes that use what you have.", tags: ["cooking", "recipes"], examples: ["I have eggs, spinach and feta."] },
      { id: "shopping-list", name: "Shopping list", description: "Turns a recipe into a shopping list.", tags: ["cooking"], outputModes: ["application/json"] },
    ],
    ...extra,
  };
}

/** The same agent's Descriptor, unbound and unsigned. */
export function draftDescriptor(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "agent-descriptor-v1",
    agent_version: "1.2.0",
    does: "Suggests recipes from the ingredients you have.",
    acts_for: "anyone",
    interaction: "service",
    offerings: [
      {
        id: "suggest-recipes",
        name: "Suggest recipes",
        does: "Suggests three recipes that use what you have.",
        inputs: [{ name: "ingredients", kind: "text", required: true }],
        outputs: [{ name: "recipes", kind: "text/markdown", when: "per_task" }],
        trial: { who: "anyone", limits: { per_requester_per_day: 3 } },
      },
      {
        id: "shopping-list",
        name: "Shopping list",
        does: "Turns a recipe into a shopping list.",
        inputs: [{ name: "recipe", kind: "text", required: true }],
        outputs: [{ name: "list", kind: "application/json", when: "per_task" }],
      },
    ],
    refusals: "medical or allergy advice.\nrecipes that need alcohol for anyone who says they are under 21.",
    escalates: ["a question about a severe allergy."],
    systems: [{ name: "recipe-index", access: "read", needs: "to look up recipes" }],
    records: [{ name: "the ingredients as received", when: "per_task" }],
    hosted_in: ["eu"],
    ...extra,
  };
}

/** The Descriptor, bound to the subject key and signed, as the bytes an agent would serve. */
export function signedDescriptorText(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(signDescriptor(draftDescriptor(extra), SUBJECT_SEED), null, 2)}\n`;
}

/** A standing proposal for the two offerings, signed by the provider seat's key (Agent SoW, Section 6). */
export function signedTerms(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const provider = labelSigner("agentdoc test key: provider");
  const body: Record<string, unknown> = {
    sow: "v1",
    id: "sow_test0000000000",
    version: 1,
    parties: { provider: { agent: SUBJECT_KEY, owner_key: provider.getPublicKey() }, client: null },
    scope: { offerings: ["suggest-recipes", "shopping-list"], grade: "enforced" },
    price: { arrangement: "fixed_fee", currency: "USD", rates: [{ offering: "suggest-recipes", amount_micro: 250000 }], grade: "enforced" },
    confidentiality: {
      retention: { max_days: 30, grade: "enforced" },
      processed_in: ["eu"],
      processors: [{ service: "A model API", purpose: "writing the recipes", processed_in: ["eu"] }],
      promises: { no_training: true, grade: "recorded" },
    },
    ...extra,
  };
  const sig = encodeSignature(signTagged(provider, "agent-sow-v1\n", canonicalJSON(body)));
  return { ...body, signatures: [{ role: "provider", key: provider.getPublicKey(), signed_at: "2026-11-01T00:00:00Z", sig }] };
}

/** The card extension that commits to those terms by digest. */
export function termsExtension(url: string, terms: unknown, digest = sha256Digest(canonicalJSON(terms))): Record<string, unknown> {
  return { uri: "https://agentsow.com/extensions/a2a-terms/v1", required: false, params: { sow_spec: "0.30.0-draft", proposals: [{ url, digest, offering: "suggest-recipes" }] } };
}

/** An evaluation record about the subject, signed by an evaluator (Section 8.4). */
export function evalRecord(cases: unknown[], extra: Record<string, unknown> = {}, sign = true): Record<string, unknown> {
  const evaluator = labelSigner("agentdoc test key: evaluator");
  const body: Record<string, unknown> = {
    format: "agent-eval-record-v1",
    subject: { agent_key: SUBJECT_KEY },
    cases,
    conforms: true,
    produced_at: "2026-11-02T10:00:00Z",
    by: evaluator.getPublicKey(),
    ...extra,
  };
  if (!sign) return { ...body, signatures: [] };
  const sig = encodeSignature(signTagged(evaluator, "agent-eval-record-v1\n", canonicalJSON(body)));
  return { ...body, signatures: [{ tag: "agent-eval-record-v1", by: evaluator.getPublicKey(), sig, alg: "ed25519" }] };
}

/** An attestation in a DSSE envelope, signed by an attester. */
export function attestation(): Record<string, unknown> {
  const attester = labelSigner("agentdoc test key: attester");
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "recipe-helper", digest: { sha256: "a".repeat(64) } }],
    predicateType: "https://commonagent.net/attestation/v0.1",
    predicate: {
      attester: { name: "An Example Attester", id: attester.getPublicKey() },
      checked_at: "2026-11-01T09:00:00Z",
      expires_at: "2027-01-30T09:00:00Z",
      areas: { identity: { result: "passed" }, spend: { result: "not_attested" } },
      words: "Checked the identity area only.",
    },
  };
  const payload = utf8(JSON.stringify(statement));
  const sig = encodeSignature(attester.sign(pae("application/vnd.in-toto+json", payload)));
  return { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(payload).toString("base64"), signatures: [{ keyid: attester.getPublicKey(), sig }] };
}
