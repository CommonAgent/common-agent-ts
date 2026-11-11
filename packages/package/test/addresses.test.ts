// The address check of Section 12.10: which pieces of a script's text are
// address literals, on which line, and which are a format's identifier.
import { describe, expect, it } from "vitest";
import { EXCEPTED_ADDRESS_PREFIXES, addressLiterals } from "../addresses.js";

const literals = (text: string) => addressLiterals(text).map((a) => a.literal);

describe("an address literal (Section 12.10, the address check)", () => {
  it("is a scheme of http, https, ws or wss, in any case, then :// and a letter, a digit or a bracket", () => {
    expect(literals('fetch("http://api.example.com/v1")')).toEqual(["http://api.example.com/v1"]);
    expect(literals("const u = 'https://api.example.com/v1';")).toEqual(["https://api.example.com/v1"]);
    expect(literals("new WebSocket(`ws://stream.example.com`)")).toEqual(["ws://stream.example.com"]);
    expect(literals("open wss://stream.example.com/feed now")).toEqual(["wss://stream.example.com/feed"]);
    expect(literals("HTTPS://API.EXAMPLE.COM and Wss://Stream.Example.Com")).toEqual(["HTTPS://API.EXAMPLE.COM", "Wss://Stream.Example.Com"]);
    expect(literals("http://10.0.0.7:8080/health")).toEqual(["http://10.0.0.7:8080/health"]);
    expect(literals("http://[::1]:8080/health")).toEqual(["http://[::1]:8080/health"]);
  });

  it("is found in a comment as it is in code", () => {
    expect(addressLiterals("// see https://docs.example.com/api\nrun();\n# and http://localhost:3000\n")).toEqual([
      { line: 1, literal: "https://docs.example.com/api" },
      { line: 3, literal: "http://localhost:3000" },
    ]);
  });

  it("is not a scheme the check does not name, or the tail of a longer word", () => {
    expect(literals("file:///tmp/x s3://bucket/key ftp://files.example.com news://group")).toEqual([]);
    expect(literals("git+https://git.example.com/repo.git")).toEqual(["https://git.example.com/repo.git"]);
  });

  it("is not an address a script builds while it runs", () => {
    expect(literals("const u = `https://${process.env.SPEECH_HOST}/v1`;")).toEqual([]);
    expect(literals('const u = "https://" + host;')).toEqual([]);
    expect(literals("const u = `${process.env.MODEL_ENDPOINT}/v1/messages`;")).toEqual([]);
    // What a script wrote down before the part it fills in is still a literal.
    expect(literals("const u = `https://api.example.com/v1/${id}`;")).toEqual(["https://api.example.com/v1/"]);
  });

  it("is an address in 169.254.0.0/16, with or without a scheme", () => {
    expect(literals("curl 169.254.169.254/latest/meta-data")).toEqual(["169.254.169.254"]);
    expect(literals('const host = "169.254.0.1";')).toEqual(["169.254.0.1"]);
    expect(literals("http://169.254.169.254/latest/meta-data")).toEqual(["http://169.254.169.254/latest/meta-data"]);
    expect(literals("169.254.169.254 and 169.253.1.1 and 10.169.254.1.1 and 169.254.300.1 and 1169.254.1.1")).toEqual(["169.254.169.254"]);
  });

  it("does not report a literal that begins with an excepted prefix", () => {
    for (const p of EXCEPTED_ADDRESS_PREFIXES) expect(literals(`const NS = "${p}2000/name";`), p).toEqual([]);
    expect(literals('const A = "http://www.w3.org/2000/svg", B = "https://www.w3.example.com/";')).toEqual(["https://www.w3.example.com/"]);
    // The prefix is the whole of its host: a longer host is another place.
    expect(literals("https://json-schema.org.example.com/draft")).toEqual(["https://json-schema.org.example.com/draft"]);
  });

  it("names the line each literal is on, and every literal on a line in order", () => {
    const text = ["const a = 1;", "", 'const b = "https://b.example.com", c = "wss://c.example.com";', "", "// 169.254.169.254 then http://d.example.com"].join("\n");
    expect(addressLiterals(text)).toEqual([
      { line: 3, literal: "https://b.example.com" },
      { line: 3, literal: "wss://c.example.com" },
      { line: 5, literal: "169.254.169.254" },
      { line: 5, literal: "http://d.example.com" },
    ]);
  });

  it("counts lines the same way whatever ends them", () => {
    expect(addressLiterals("one\r\ntwo\r\nhttps://three.example.com\r\n")).toEqual([{ line: 3, literal: "https://three.example.com" }]);
  });

  it("leaves out the punctuation of the sentence or the call around a literal", () => {
    expect(literals("Read https://docs.example.com/api.")).toEqual(["https://docs.example.com/api"]);
    expect(literals("(see https://docs.example.com/api), then run")).toEqual(["https://docs.example.com/api"]);
    expect(literals("fetch(https://docs.example.com/api);")).toEqual(["https://docs.example.com/api"]);
    expect(literals("https://docs.example.com/page_(one)")).toEqual(["https://docs.example.com/page_(one)"]);
    expect(literals("<a href=https://docs.example.com/api>docs</a>")).toEqual(["https://docs.example.com/api"]);
  });
});
