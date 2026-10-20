#!/usr/bin/env node
//
// Publish each workspace package, in the order package.json lists them (each
// after the packages it depends on), unless npm already has that version.
// .github/workflows/publish.yml runs it after the build.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const npm = (args, opts = {}) => execFileSync("npm", args, { encoding: "utf8", ...opts });

for (const dir of root.workspaces) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (pkg.private) continue;
  let published = false;
  try {
    published = npm(["view", `${pkg.name}@${pkg.version}`, "version"], { stdio: ["ignore", "pipe", "ignore"] }).trim() === pkg.version;
  } catch {
    published = false;
  }
  if (published) {
    console.log(`${pkg.name}@${pkg.version} is on npm already`);
    continue;
  }
  console.log(`publishing ${pkg.name}@${pkg.version}`);
  npm(["publish", "--workspace", dir, "--access", "public", "--provenance"], { stdio: "inherit" });
}
