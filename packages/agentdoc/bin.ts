#!/usr/bin/env node
// The executable: runs the command line tool on this process's arguments.
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  },
);
