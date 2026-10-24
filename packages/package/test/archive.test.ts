// The archive: what the packer writes, the reader reads back, byte for byte,
// and the reader refuses what is not a package's files.
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ArchiveError, readArchive, walkOrder, writeArchive } from "../archive.js";
import { validateArchive } from "../index.js";
import { utf8Bytes, utf8Text } from "../text.js";

const files = new Map<string, Uint8Array>([
  ["plugin.json", utf8Bytes("{}\n")],
  ["skills/b/SKILL.md", utf8Bytes("b\n")],
  ["skills/a/scripts/run.mjs", utf8Bytes("run\n")],
  ["skills/a/SKILL.md", utf8Bytes("a\n")],
  [`skills/a/references/${"deep-".repeat(12)}/${"name-".repeat(10)}.md`, utf8Bytes("long\n")],
]);

describe("the archive", () => {
  it("walks each folder in name order, a folder's files where the folder falls", () => {
    expect(walkOrder(files.keys())).toEqual([
      "plugin.json",
      `skills/a/references/${"deep-".repeat(12)}/${"name-".repeat(10)}.md`,
      "skills/a/scripts/run.mjs",
      "skills/a/SKILL.md",
      "skills/b/SKILL.md",
    ]);
  });

  it("reads back what it wrote, long names included", () => {
    const back = readArchive(writeArchive(files, "demo", 1_700_000_000));
    expect(back.arcname).toBe("demo");
    expect([...back.files.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [k, v] of files) expect(utf8Text(back.files.get(k) as Uint8Array)).toBe(utf8Text(v));
  });

  it("writes the same bytes for the same files and time", () => {
    expect(Buffer.from(writeArchive(files, "demo", 5)).equals(Buffer.from(writeArchive(files, "demo", 5)))).toBe(true);
  });

  it("marks a skill's scripts executable and nothing else", () => {
    const tar = gunzipSync(writeArchive(files, "demo"));
    const modes = new Map<string, string>();
    for (let off = 0; off + 512 <= tar.length; ) {
      const h = tar.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const prefix = h.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
      modes.set(prefix ? `${prefix}/${name}` : name, h.subarray(100, 107).toString("utf8"));
      const size = parseInt(h.subarray(124, 135).toString("utf8"), 8);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(modes.get("demo/skills/a/scripts/run.mjs")).toBe("0000755");
    expect(modes.get("demo/skills/a/SKILL.md")).toBe("0000644");
    expect(modes.get("demo/skills/")).toBe("0000755");
  });

  it("refuses a file name too long for a tar header", () => {
    expect(() => writeArchive(new Map([[`skills/a/${"x".repeat(101)}`, utf8Bytes("x")]]), "demo")).toThrow(/too long for a tar header/);
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
