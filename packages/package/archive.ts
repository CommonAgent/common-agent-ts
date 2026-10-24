/**
 * The package archive (Common Agent 12.6 rule 5): a gzipped ustar archive of
 * the package's folder under `<name>/`. Its SHA-256 over the archive bytes is
 * the package's digest. Written here rather than pulled in, because the shape
 * is small and a dependency would be the heavier thing.
 *
 * node:zlib is used for the gzip layer; it computes and touches nothing else.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { PackageFiles } from "./types.js";

/** A problem with a path or an archive, in words. */
export class ArchiveError extends Error {}

/**
 * Every file path in the map, in the order a walk of the folder gives: each
 * directory's entries sorted by name with `localeCompare`, and a directory's
 * contents where the directory falls in that order.
 */
export function walkOrder(files: Iterable<string>): string[] {
  interface Node { files: Set<string>; dirs: Map<string, Node> }
  const root: Node = { files: new Set(), dirs: new Map() };
  for (const p of files) {
    const parts = p.split("/");
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = n.dirs.get(parts[i]);
      if (!next) n.dirs.set(parts[i], (next = { files: new Set(), dirs: new Map() }));
      n = next;
    }
    n.files.add(parts[parts.length - 1]);
  }
  const out: string[] = [];
  const visit = (n: Node, prefix: string) => {
    const names = [...new Set([...n.files, ...n.dirs.keys()])].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const sub = n.dirs.get(name);
      if (sub) visit(sub, `${prefix}${name}/`);
      if (n.files.has(name)) out.push(`${prefix}${name}`);
    }
  };
  visit(root, "");
  return out;
}

function header(nameIn: string, size: number, type: string, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  let name = nameIn;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new ArchiveError(`a path inside the package is too long for a tar header: ${name}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  h.write(name, 0, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "utf8");
  h.write("0000000\0", 108, "utf8");
  h.write("0000000\0", 116, "utf8");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8");
  h.write(`${Math.floor(mtime).toString(8).padStart(11, "0")}\0`, 136, "utf8");
  h.write("        ", 148, "utf8");
  h.write(type, 156, "utf8");
  h.write("ustar\0", 257, "utf8");
  h.write("00", 263, "utf8");
  if (prefix) h.write(prefix, 345, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return h;
}

/**
 * The archive of a package's files under `arcname/`, gzipped. `mtime` is the
 * time every entry carries, in seconds since 1970; the caller passes it,
 * because the library reads no clock. A script under a skill's `scripts/`
 * folder is mode 755 and every other file 644.
 */
export function writeArchive(files: PackageFiles, arcname: string, mtime = 0): Uint8Array {
  const blocks: Buffer[] = [];
  const order = walkOrder(files.keys());
  const dirs = new Set([arcname]);
  for (const rel of order) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${arcname}/${parts.slice(0, i).join("/")}`);
  }
  for (const d of [...dirs].sort()) blocks.push(header(`${d}/`, 0, "5", 0o755, mtime));
  for (const rel of order) {
    const body = Buffer.from(files.get(rel) as Uint8Array);
    blocks.push(header(`${arcname}/${rel}`, body.length, "0", rel.startsWith("skills/") && rel.includes("/scripts/") ? 0o755 : 0o644, mtime), body);
    const pad = Math.ceil(body.length / 512) * 512 - body.length;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

const field = (b: Buffer, at: number, len: number): string => {
  const s = b.subarray(at, at + len);
  const end = s.indexOf(0);
  return s.subarray(0, end === -1 ? len : end).toString("utf8");
};
const octal = (b: Buffer, at: number, len: number): number => {
  const s = field(b, at, len).trim();
  return s ? parseInt(s, 8) : 0;
};

/** What an archive holds: the folder every entry sits under, and the files under it. */
export interface ReadArchive {
  arcname: string;
  files: PackageFiles;
}

/**
 * Read a package archive: gunzip, then each ustar entry. Regular files and
 * directories are read; GNU long names and pax `path` records are honoured;
 * any other entry (a link, a device) is refused, because a package is files.
 * Every entry must sit under one top folder.
 */
export function readArchive(bytes: Uint8Array): ReadArchive {
  let tar: Buffer;
  try {
    tar = gunzipSync(Buffer.from(bytes));
  } catch {
    throw new ArchiveError("the archive is not gzip");
  }
  const files: PackageFiles = new Map();
  let top: string | null = null;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new ArchiveError(`a tar header at byte ${off} has a bad checksum`);
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new ArchiveError("the archive ends inside an entry");
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = field(body, 0, body.length);
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === "g") continue;
    const prefix = field(h, 345, 155);
    let name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    longName = null;
    paxPath = null;
    name = name.replace(/^\.\//, "");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new ArchiveError(`an entry's path leaves the package: ${name}`);
    const first = name.split("/")[0];
    if (top === null) top = first;
    else if (first !== top) throw new ArchiveError(`the archive holds more than one top folder: ${top} and ${first}`);
    if (type === "5") continue;
    if (type !== "0") throw new ArchiveError(`${name} is not a regular file or a directory (tar type ${type}); a package is files`);
    const rel = name.slice(first.length + 1);
    if (!rel) throw new ArchiveError(`${name} is a file where the package folder should be`);
    files.set(rel, new Uint8Array(body));
  }
  if (top === null) throw new ArchiveError("the archive is empty");
  return { arcname: top, files };
}
