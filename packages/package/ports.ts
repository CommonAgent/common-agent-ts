/**
 * What the packer asks its host for. The library reads no disk: the host
 * hands it the folder the spec sits in, through this port, and writes what
 * it returns. The command line tool (cli.ts) implements it over node:fs.
 *
 *   SourceTree   the files a spec names, relative to the spec's folder
 *   Signer       the key that signs the build record, when there is one
 */

export type { KeyedSigner } from "@common-agent/crypto";

/**
 * The folder a spec sits in. Every path is the one the spec wrote, relative
 * to that folder, and the host resolves it as it would resolve a path on its
 * own disk (so `../shared/tool.mjs` is allowed, as it always has been).
 */
export interface SourceTree {
  /** Whether the path is a file, a directory, or nothing. */
  kind(path: string): "file" | "directory" | null;
  /** A file's bytes. */
  read(path: string): Uint8Array;
  /** Every file under a directory, as posix paths relative to it, at any depth. */
  list(path: string): string[];
  /** The last segment of the path once resolved: what the copy is called. */
  baseName(path: string): string;
}
