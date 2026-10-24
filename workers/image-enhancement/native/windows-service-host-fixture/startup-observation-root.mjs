import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

appendFileSync(join(process.argv[2], "root-starts.ndjson"), JSON.stringify({ pid: process.pid }) + "\n");
writeFileSync(join(process.argv[2], "root-first-action-complete"), "", { flag: "wx" });
process.stdout.write("startup-node-first-action\n");
process.stdin.resume();
