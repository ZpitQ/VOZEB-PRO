import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { generationRuntimeEnvironment, superviseGenerationRuntime } from "./generation-runtime.mjs";

const mode = process.argv[2];
if (mode !== "dev") throw new Error("Usage: run-app.mjs dev");

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextEntry = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const imageBuild = spawnSync(process.execPath, [path.join(webRoot, "scripts", "build-image-processing.mjs")], { cwd: webRoot, stdio: "inherit" });
if (imageBuild.error) throw imageBuild.error;
if (imageBuild.status !== 0) process.exit(imageBuild.status ?? 1);
const runtime = generationRuntimeEnvironment({ allowEphemeralToken: true });
const environment = { ...runtime.environment, NEXT_DIST_DIR: runtime.environment.NEXT_DIST_DIR?.trim() || ".next-dev" };
if (runtime.ephemeralToken) console.log("Generated ephemeral maintenance and worker tokens for this local development process.");

process.exitCode = await superviseGenerationRuntime({
    app: {
        command: process.execPath,
        args: [`--max-old-space-size=${environment.VOZEB_PRO_WEB_HEAP_MB ?? 384}`, "--import", new URL("./web-resource-preload.mjs", import.meta.url).href, nextEntry, "dev", "--webpack", "-H", "0.0.0.0", "-p", "3000"],
        cwd: webRoot,
    },
    workerScript: path.join(webRoot, "scripts", "generation-worker.mjs"),
    environment,
});
