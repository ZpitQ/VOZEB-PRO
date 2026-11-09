import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { prepareStandaloneAssets } from "./standalone-assets.mjs";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const directories = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "image-runtime-package-"));
    directories.push(root);
    const source = path.join(root, "source");
    await mkdir(path.join(source, ".next/standalone"), { recursive: true });
    await mkdir(path.join(source, ".next/static"), { recursive: true });
    await mkdir(path.join(source, "public"));
    await mkdir(path.join(source, "scripts"));
    await writeFile(path.join(source, ".next/standalone/server.js"), "// Packaging fixture server entry.\n");
    await writeFile(path.join(source, ".next/static/entry.js"), "export {};\n");
    await writeFile(path.join(source, "public/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(source, "public/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await symlink(path.join(webRoot, "node_modules"), path.join(source, "node_modules"), "junction");
    await cp(path.join(webRoot, ".image-processing-runtime"), path.join(source, ".image-processing-runtime"), { recursive: true });
    await cp(path.join(webRoot, "scripts/image-processing-supervisor.mjs"), path.join(source, "scripts/image-processing-supervisor.mjs"));
    await cp(path.join(webRoot, "scripts/generation-worker.mjs"), path.join(source, "scripts/generation-worker.mjs"));
    await cp(path.join(webRoot, "scripts/generation-runtime.mjs"), path.join(source, "scripts/generation-runtime.mjs"));
    await cp(path.join(webRoot, "scripts/web-resource-preload.mjs"), path.join(source, "scripts/web-resource-preload.mjs"));
    await cp(path.join(webRoot, "scripts/generation-worker-policy.mjs"), path.join(source, "scripts/generation-worker-policy.mjs"));
    return { root, source };
}

describe("standalone image runtime packaging", () => {
    it("loads the resident Worker from an isolated deliverable", async () => {
        const setup = await fixture();
        const prepared = await prepareStandaloneAssets({ webRoot: setup.source });
        const isolated = path.join(setup.root, "resident-deliverable");
        await cp(prepared.standaloneRoot, isolated, { recursive: true, dereference: true });
        const entry = pathToFileURL(path.join(isolated, "scripts/generation-worker.mjs")).href;
        const program = `process.env.VOZEB_PRO_WORKER_TOKEN = ""; process.env.VOZEB_PRO_WORKER_API_ORIGIN = "http://fixture.invalid"; await import(${JSON.stringify(entry)});`;
        const result = await runNode(program, isolated);
        expect(result.code, result.stderr).toBe(1);
        expect(result.stderr).toContain("VOZEB_PRO_WORKER_TOKEN");
    });

    it("runs protected PNG work from isolated deliverables without source or TypeScript", async () => {
        const setup = await fixture();
        const prepared = await prepareStandaloneAssets({ webRoot: setup.source });
        expect(existsSync(path.join(prepared.standaloneRoot, ".image-processing-runtime/workers/image-processing-child.mjs"))).toBe(true);
        expect(existsSync(path.join(prepared.standaloneRoot, "scripts/image-processing-supervisor.mjs"))).toBe(true);
        const isolated = path.join(setup.root, "isolated");
        await cp(prepared.standaloneRoot, isolated, { recursive: true, dereference: true });
        expect(existsSync(path.join(isolated, "src"))).toBe(false);
        expect(existsSync(path.join(isolated, "node_modules/typescript"))).toBe(false);
        const taskDirectory = path.join(setup.root, "task");
        await mkdir(taskDirectory);
        const outputDirectory = path.join(taskDirectory, "output");
        await mkdir(outputDirectory);
        const inputPath = path.join(taskDirectory, "source.png");
        const foreground = await sharp({ create: { width: 12, height: 10, channels: 4, background: "#2e5ba8" } })
            .png()
            .toBuffer();
        await writeFile(
            inputPath,
            await sharp({ create: { width: 32, height: 24, channels: 4, background: "#ffffff" } })
                .composite([{ input: foreground, left: 8, top: 6 }])
                .png()
                .toBuffer(),
        );
        const request = {
            version: "image-processing.v1",
            jobId: "package-job",
            executionId: "package-execution",
            operation: "build_protection",
            inputs: [{ path: inputPath, assetId: "asset", assetVersion: "version" }],
            options: { transparentBackground: false },
            outputDirectory,
        };
        const entry = pathToFileURL(path.join(isolated, "scripts/image-processing-supervisor.mjs")).href;
        const program = `import { runImageProcessing } from ${JSON.stringify(entry)}; const outcome = await runImageProcessing(${JSON.stringify(request)}, ${JSON.stringify({ taskDirectory, maxHeapMiB: 128 })}); console.log(JSON.stringify(outcome)); if (outcome.status !== "completed") process.exitCode = 1;`;
        const result = await runNode(program, isolated);
        expect(result.code, result.stderr).toBe(0);
        const outcome = JSON.parse(result.stdout.trim());
        expect(outcome).toMatchObject({ status: "completed", exitCode: 0, result: { geometry: { sourceSize: { width: 32, height: 24 }, productBounds: { x: 8, y: 6, width: 12, height: 10 } } } });
        const pixels = await sharp(await readFile(outcome.result.artifacts[0].path))
            .ensureAlpha()
            .raw()
            .toBuffer();
        expect(pixels[3]).toBe(0);
        expect(pixels[(6 * 32 + 8) * 4 + 3]).toBe(255);
    });

    it("fails packaging explicitly when the independently built runtime is absent", async () => {
        const setup = await fixture();
        await rm(path.join(setup.source, ".image-processing-runtime"), { recursive: true });
        await expect(prepareStandaloneAssets({ webRoot: setup.source })).rejects.toThrow(/image.processing.*runtime/i);
    });

    it("rejects standalone dependency aliases before changing any source or deliverable bytes", async () => {
        const setup = await fixture();
        const sourceModules = path.join(setup.source, "node_modules");
        expect((await lstat(sourceModules)).isSymbolicLink()).toBe(true);
        await unlink(sourceModules);

        const modules = path.join(setup.root, "owned-dependencies/node_modules");
        const sharpPackage = path.join(modules, ".pnpm/sharp@fixture/node_modules/sharp");
        const fileTypePackage = path.join(modules, ".pnpm/file-type@fixture/node_modules/file-type");
        const sharpNative = path.join(modules, ".pnpm/@img+sharp-linux-x64@fixture/native.node");
        const vipsNative = path.join(modules, ".pnpm/@img+sharp-libvips-linux-x64@fixture/libvips.so");
        const standalone = path.join(setup.source, ".next/standalone");
        const targetModules = path.join(standalone, "node_modules");
        const targetRuntime = path.join(standalone, ".image-processing-runtime");
        const targetScripts = path.join(standalone, "scripts");
        await Promise.all([
            mkdir(sharpPackage, { recursive: true }),
            mkdir(fileTypePackage, { recursive: true }),
            mkdir(path.dirname(sharpNative), { recursive: true }),
            mkdir(path.dirname(vipsNative), { recursive: true }),
            mkdir(targetRuntime),
            mkdir(targetScripts),
        ]);
        await Promise.all([
            writeFile(path.join(sharpPackage, "package.json"), '{"name":"sharp","version":"0.0.0"}\n'),
            writeFile(path.join(fileTypePackage, "package.json"), '{"name":"file-type","version":"0.0.0"}\n'),
            writeFile(sharpNative, "owned sharp native fixture bytes\n"),
            writeFile(vipsNative, "owned libvips fixture bytes\n"),
            writeFile(path.join(modules, ".modules.yaml"), "owned dependency metadata\n"),
            writeFile(path.join(targetRuntime, "sentinel.txt"), "existing deliverable runtime\n"),
            writeFile(path.join(targetScripts, "image-processing-supervisor.mjs"), "// Existing deliverable supervisor.\n"),
            symlink(sharpPackage, path.join(modules, "sharp"), "junction"),
            symlink(fileTypePackage, path.join(modules, "file-type"), "junction"),
            symlink(modules, sourceModules, "junction"),
            symlink(modules, targetModules, "junction"),
        ]);
        const ownedModules = path.join(await realpath(setup.root), "owned-dependencies/node_modules");
        expect(await realpath(sourceModules)).toBe(ownedModules);
        expect(await realpath(targetModules)).toBe(ownedModules);

        const snapshot = () =>
            Promise.all([
                readlink(sourceModules),
                readlink(targetModules),
                readlink(path.join(modules, "sharp")),
                readlink(path.join(modules, "file-type")),
                readFile(path.join(sharpPackage, "package.json")),
                readFile(path.join(fileTypePackage, "package.json")),
                readFile(sharpNative),
                readFile(vipsNative),
                readFile(path.join(modules, ".modules.yaml")),
                readFile(path.join(targetRuntime, "sentinel.txt")),
                readFile(path.join(targetScripts, "image-processing-supervisor.mjs")),
                readdir(modules),
                readdir(path.join(modules, ".pnpm")),
                readdir(standalone),
                readdir(targetRuntime),
                readdir(targetScripts),
            ]);
        const before = await snapshot();
        await expect(prepareStandaloneAssets({ webRoot: setup.source })).rejects.toThrow(/standalone.*aliases.*source.*node_modules/i);
        expect(await snapshot()).toStrictEqual(before);
    });
});

function runNode(program, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", program], { cwd, env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
}
