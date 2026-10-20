/**
 * The two pieces of the family's signing convention this core needs (Agent
 * Mandate §4): the canonical JSON a signature covers, and the check of one
 * Ed25519 signature by an nkey public key over a tagged body.
 *
 * Both come from the shared crypto core (../crypto/). The keys this core
 * reads are the public kinds the NATS nkeys library accepts for signing
 * (server, operator, cluster, account and user); a curve key (`X`), a seed
 * and a private key are refused whatever their bytes.
 */
import { NKEY_PUBLIC_PREFIXES, canonicalJSON, verifyTagged as verifyNkeyTagged } from "@common-agent/crypto";

export { canonicalJSON };

/**
 * Does `sig` verify by `publicKey` over `prefix + canonical`? False for a key
 * that is not one of the public kinds above, a signature that is not 64
 * bytes, and a signature that does not verify; it never throws.
 */
export function verifyTagged(publicKey: string, prefix: string, canonical: string, sig: Uint8Array): boolean {
  return verifyNkeyTagged(publicKey, prefix, canonical, sig, NKEY_PUBLIC_PREFIXES);
}
