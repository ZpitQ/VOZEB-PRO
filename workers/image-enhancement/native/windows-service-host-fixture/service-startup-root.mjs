import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Technical first action plus the existing production graceful frame; no startup phase or business work.
const directory = process.argv[2];
appendFileSync(join(directory, "root-starts.ndjson"), JSON.stringify({ pid: process.pid }) + "\n");
writeFileSync(join(directory, "root-first-action-complete"), "", { flag: "wx" });
process.stdout.write("service-startup-node-first-action\n");
const expected = Buffer.from("ZEB_WORKER_SHUTDOWN_V1\n");
let received = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  received = Buffer.concat([received, chunk]);
  if (received.length < expected.length) return;
  if (received.equals(expected)) {
    writeFileSync(join(directory, "service-stop-frame-received"), received, { flag: "wx" });
    process.exitCode = 0;
  } else process.exitCode = 2;
  process.stdin.destroy();
});
process.stdin.on("end", () => {
  if (!received.equals(expected)) process.exitCode = 2;
});
process.stdin.resume();
