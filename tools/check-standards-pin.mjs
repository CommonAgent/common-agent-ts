#!/usr/bin/env node
//
// The conformance files here are copies of the Common Agent Standards' own,
// each pinned in standards-pin.json to the file it copies, the tag, and the
// SHA-256 of that file at that tag (LF line endings).
//
//   node tools/check-standards-pin.mjs            every copy hashes to its pin
//   node tools/check-standards-pin.mjs --remote   also fetch each file at its tag
//                                                 and check that the pin is that file
//
// To move a copy to a newer tag, the tag must exist in
// https://github.com/CommonAgent/common-agent-standards. Change the pin's tag,
// copy the file at that tag, update the pin's sha256 and run --remote.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(ROOT, "standards-pin.json"), "utf8"));
const remote = process.argv.includes("--remote");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const lf = (s) => s.replace(/\r\n/g, "\n");
const raw = (repo, tag, path) => `${repo.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${tag}/${path}`;

let bad = 0;
for (const f of pin.files) {
  let text;
  try {
    text = lf(readFileSync(join(ROOT, f.local), "utf8"));
  } catch {
    console.error(`MISSING  ${f.local} (pinned to ${f.path} at ${f.tag})`);
    bad++;
    continue;
  }
  if (sha(text) !== f.sha256) {
    console.error(`DRIFTED  ${f.local}: its SHA-256 is not the pin's (${f.path} at ${f.tag})`);
    bad++;
    continue;
  }
  if (remote) {
    const url = raw(pin.repository, f.tag, f.path);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`UNREACHABLE  ${url}: ${res.status}`);
      bad++;
      continue;
    }
    if (sha(lf(await res.text())) !== f.sha256) {
      console.error(`NOT THE TAG  ${f.path} at ${f.tag} is not what ${f.local} pins`);
      bad++;
      continue;
    }
  }
  console.log(`ok  ${f.local}  ${f.path} at ${f.tag}`);
}
console.log(`${pin.files.length - bad} of ${pin.files.length} pinned files hold${remote ? ", checked against their tags" : ""}`);
process.exit(bad ? 1 : 0);
