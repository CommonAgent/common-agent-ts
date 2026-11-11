// The archive: what the packer writes, the reader reads back, byte for byte,
// and the reader refuses what is not a package's files.
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ArchiveError, readArchive, walkOrder, writeArchive } from "../archive.js";
import { validateArchive } from "../index.js";
import { sha256Hex, utf8Bytes, utf8Text } from "../text.js";

const files = new Map<string, Uint8Array>([
  ["plugin.json", utf8Bytes("{}\n")],
  ["skills/b/SKILL.md", utf8Bytes("b\n")],
  ["skills/a/scripts/run.mjs", utf8Bytes("run\n")],
  ["skills/a/SKILL.md", utf8Bytes("a\n")],
  [`skills/a/references/${"deep-".repeat(12)}/${"name-".repeat(10)}.md`, utf8Bytes("long\n")],
]);
/** SHA-256 over the archive of those files under `demo/`. */
const GOLDEN = "9c492e322ae0dd0a72dec39709f3ddfe86f3c42a7a3d250a096f7e6ea50680ad";

/** One entry's header, as the tar carries it. */
interface Entry {
  name: string;
  mode: string;
  uid: string;
  gid: string;
  mtime: string;
  uname: string;
  gname: string;
}

/** The entries of an archive, in the order it carries them. */
function entriesOf(archive: Uint8Array): Entry[] {
  const tar = gunzipSync(archive);
  const text = (h: Buffer, from: number, to: number) => h.subarray(from, to).toString("utf8").replace(/\0.*$/s, "");
  const out: Entry[] = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const prefix = text(h, 345, 500);
    out.push({
      name: prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100),
      mode: text(h, 100, 108),
      uid: text(h, 108, 116),
      gid: text(h, 116, 124),
      mtime: text(h, 136, 148),
      uname: text(h, 265, 297),
      gname: text(h, 297, 329),
    });
    off += 512 + Math.ceil(parseInt(text(h, 124, 136), 8) / 512) * 512;
  }
  return out;
}

describe("the archive", () => {
  it("puts the paths in the order of their bytes, which no locale changes", () => {
    expect(walkOrder(files.keys())).toEqual([
      "plugin.json",
      "skills/a/SKILL.md",
      `skills/a/references/${"deep-".repeat(12)}/${"name-".repeat(10)}.md`,
      "skills/a/scripts/run.mjs",
      "skills/b/SKILL.md",
    ]);
  });

  it("reads back what it wrote, long names included", () => {
    const back = readArchive(writeArchive(files, "demo"));
    expect(back.arcname).toBe("demo");
    expect([...back.files.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [k, v] of files) expect(utf8Text(back.files.get(k) as Uint8Array)).toBe(utf8Text(v));
  });

  it("marks a skill's scripts executable and nothing else", () => {
    const modes = new Map(entriesOf(writeArchive(files, "demo")).map((e) => [e.name, e.mode]));
    expect(modes.get("demo/skills/a/scripts/run.mjs")).toBe("0000755");
    expect(modes.get("demo/skills/a/SKILL.md")).toBe("0000644");
    expect(modes.get("demo/skills/")).toBe("0000755");
  });
});

describe("the archive is deterministic (Section 12.6, rule 5)", () => {
  it("writes the same bytes for the same files, in whatever order they were added", () => {
    const reversed = new Map([...files].reverse());
    expect(Buffer.from(writeArchive(reversed, "demo")).equals(Buffer.from(writeArchive(files, "demo")))).toBe(true);
  });

  it("carries every entry, folders included, in the byte order of its path", () => {
    const names = entriesOf(writeArchive(files, "demo")).map((e) => e.name);
    expect(names).toEqual([
      "demo/",
      "demo/plugin.json",
      "demo/skills/",
      "demo/skills/a/",
      "demo/skills/a/SKILL.md",
      "demo/skills/a/references/",
      `demo/skills/a/references/${"deep-".repeat(12)}/`,
      `demo/skills/a/references/${"deep-".repeat(12)}/${"name-".repeat(10)}.md`,
      "demo/skills/a/scripts/",
      "demo/skills/a/scripts/run.mjs",
      "demo/skills/b/",
      "demo/skills/b/SKILL.md",
    ]);
    expect(names).toEqual([...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  });

  it("gives every entry one fixed time, and names no owner and no group", () => {
    for (const e of entriesOf(writeArchive(files, "demo"))) {
      expect(e.mtime, e.name).toBe("00000000000");
      expect([e.uid, e.gid, e.uname, e.gname], e.name).toEqual(["0000000", "0000000", "", ""]);
      expect(["0000644", "0000755"], e.name).toContain(e.mode);
    }
  });

  it("writes a gzip header with no time and no operating system in it", () => {
    expect(Buffer.from(writeArchive(files, "demo").subarray(0, 10)).toString("hex")).toBe("1f8b08000000000000ff");
  });

  // The digest of the archive of the files above. It is the same on Windows
  // and on Linux, on x64 and on arm64, under Node 20, 22 and 24. A change to
  // the writer, or a zlib that compresses differently, changes it and fails
  // this test, which is the point: a package's digest must not move.
  it("packs these files to the bytes it always has", () => {
    expect(sha256Hex(writeArchive(files, "demo"))).toBe(GOLDEN);
  });
});

describe("what the archive writer and reader refuse", () => {

  it("refuses a file name too long for a tar header", () => {
    expect(() => writeArchive(new Map([[`skills/a/${"x".repeat(101)}`, utf8Bytes("x")]]), "demo")).toThrow(/too long for a tar header/);
  });

  it("refuses a folder path too long, in bytes, for the prefix field", () => {
    const deep = `skills/x/${"\u00e9".repeat(80)}/${"\u00e9".repeat(40)}/f.txt`;
    expect(() => writeArchive(new Map([[deep, utf8Bytes("x")]]), "demo")).toThrow(/too long for a tar header/);
  });

  it("refuses an archive that is not gzip, or holds a link, or two top folders", () => {
    expect(() => readArchive(utf8Bytes("plain text"))).toThrow(ArchiveError);
    const link = tarOf([{ name: "demo/x", type: "2", body: "" }]);
    expect(() => readArchive(link)).toThrow(/not a regular file or a directory/);
    const two = tarOf([
      { name: "demo/a", type: "0", body: "a" },
      { name: "other/b", type: "0", body: "b" },
    ]);
    expect(() => readArchive(two)).toThrow(/more than one top folder/);
    const escape = tarOf([{ name: "demo/../x", type: "0", body: "x" }]);
    expect(() => readArchive(escape)).toThrow(/leaves the package/);
    const back = tarOf([{ name: "demo/..\\..\\x", type: "0", body: "x" }]);
    expect(() => readArchive(back)).toThrow(/leaves the package/);
    const twice = tarOf([
      { name: "demo/a", type: "0", body: "a" },
      { name: "demo/a", type: "0", body: "b" },
    ]);
    expect(() => readArchive(twice)).toThrow(/appears twice/);
  });

  it("says when the archive's folder is not the package's name", () => {
    const v = validateArchive(writeArchive(new Map([["plugin.json", utf8Bytes(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "named" }))]]), "other"));
    expect(v.ok).toBe(false);
    expect(v.issues[0]).toEqual({ check: "layout", message: "the archive's folder is other, and the package is named named" });
  });
});

/** A tar of hand-made entries, for the refusals. */
function tarOf(entries: { name: string; type: string; body: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    const body = Buffer.from(e.body);
    h.write(e.name, 0);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(e.type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}
