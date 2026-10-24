#!/usr/bin/env node
// The executable: runs the command line tool on this process's arguments.
import { main } from "./cli.js";

process.exitCode = main(process.argv.slice(2));
