import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const webDirectory = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = path.join(webDirectory, ".image-processing-runtime");
rmSync(runtimeDirectory, { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [path.join(webDirectory, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.image-processing.json", "--pretty", "false"], { cwd: webDirectory, stdio: "inherit" });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
writeFileSync(path.join(runtimeDirectory, "package.json"), JSON.stringify({ type: "module" }) + "\n");
