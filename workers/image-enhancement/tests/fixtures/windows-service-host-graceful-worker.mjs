import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [fixture, directory, prefix, observerPid, observerCreation, scenario] = process.argv.slice(2);
const scenarios = ["graceful-cooperate", "graceful-ignore", "graceful-root-hung", "graceful-nonzero", "graceful-hard-stop", "graceful-sink-failure"];
if (![fixture, directory, prefix, observerPid, observerCreation].every(Boolean) || !scenarios.includes(scenario))
  throw new Error("Fixed graceful Host fixture arguments required.");
writeFileSync(join(directory, "root.marker"), "original-node-first-action", { flag: "wx" });
appendFileSync(join(directory, "root-starts.ndjson"), `${JSON.stringify({ pid: process.pid })}\n`);
if (scenario !== "graceful-cooperate") {
  const child = spawn(fixture, ["hung", directory, prefix, observerPid, observerCreation], {
    shell: false, windowsHide: true, detached: true, stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", (error) => { throw error; });
  child.unref();
}
process.stdout.write("original-node-ready\n");
process.stderr.write("original-node-stderr\n");
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
setInterval(() => {}, 60_000);
const frame = Buffer.from("ZEB_WORKER_SHUTDOWN_V1\n", "ascii");
let cursor = 0, selected = false;
process.stdin.on("data", (chunk) => {
  for (const byte of chunk) {
    if (byte !== frame[cursor++]) throw new Error("Fixed graceful Host frame invalid.");
    if (cursor !== frame.length) continue;
    cursor = 0;
    if (selected) continue;
    selected = true;
    if (scenario === "graceful-cooperate" || scenario === "graceful-root-hung") process.exit(0);
    if (scenario === "graceful-nonzero") process.exit(23);
    if (scenario === "graceful-sink-failure") process.stdout.write(Buffer.alloc(4096, 120));
  }
});
process.stdin.resume();
// The ignore/hard-stop cases never exit on stdin EOF or timers. Only the original Host may contain them.
