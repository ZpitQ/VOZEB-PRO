import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [fixture, directory, prefix, observerPid, observerCreation] =
  process.argv.slice(2);
if (![fixture, directory, prefix, observerPid, observerCreation].every(Boolean))
  throw new Error("Fixed service-host fixture arguments required.");

writeFileSync(join(directory, "root.marker"), "original-node-first-action", {
  flag: "wx",
});
appendFileSync(
  join(directory, "root-starts.ndjson"),
  `${JSON.stringify({ pid: process.pid })}\n`,
);
const child = spawn(
  fixture,
  ["hung", directory, prefix, observerPid, observerCreation],
  {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  },
);
child.once("error", (error) => {
  throw error;
});
child.once("spawn", () => {
  process.stdout.write("original-node-ready\n");
  process.stderr.write("original-node-stderr\n");
});
child.unref();

// Neither pipe closure nor a timer ends this Node or its one permanent hung child.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
setInterval(() => {}, 60_000);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line === "exit") process.exit(0);
  if (line === "flood") {
    const chunk = Buffer.alloc(4096, 120);
    for (let index = 0; index < 32; ++index) process.stdout.write(chunk);
  } else throw new Error("Unknown fixed Node fixture command.");
});
