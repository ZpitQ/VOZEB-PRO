import { cp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function prepareStandaloneAssets({ webRoot, distDir = ".next" }) {
    const buildRoot = resolveChildPath(webRoot, distDir, "build directory");
    const standaloneRoot = path.join(buildRoot, "standalone");
    const serverEntry = path.join(standaloneRoot, "server.js");
    const sourceStatic = path.join(buildRoot, "static");
    const targetStatic = path.join(standaloneRoot, distDir, "static");
    const sourcePublic = path.join(webRoot, "public");
    const targetPublic = path.join(standaloneRoot, "public");

    await assertFile(serverEntry, `Standalone server was not found: ${serverEntry}`);
    let targetModules;
    try {
        targetModules = await realpath(path.join(standaloneRoot, "node_modules"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (targetModules !== undefined) {
        const sourceModules = await realpath(path.join(webRoot, "node_modules"));
        if (targetModules === sourceModules) throw new Error("Standalone dependency destination aliases source node_modules");
    }
    await copyImageProcessingRuntime(webRoot, standaloneRoot);
    const sharpRuntimePackages = await copySharpRuntimePackages(webRoot, standaloneRoot);
    const sourceStaticFiles = await listRelativeFiles(sourceStatic);
    if (!sourceStaticFiles.length) throw new Error(`Build static directory is empty: ${sourceStatic}`);

    const sourcePublicFiles = await listRelativeFiles(sourcePublic);
    for (const requiredAsset of ["logo.svg", "icon.svg"]) {
        if (!sourcePublicFiles.includes(requiredAsset)) throw new Error(`Required brand asset is missing: public/${requiredAsset}`);
    }

    await copyDirectoryContents(sourceStatic, targetStatic);
    await copyDirectoryContents(sourcePublic, targetPublic);

    const targetStaticFiles = await listRelativeFiles(targetStatic);
    const targetPublicFiles = await listRelativeFiles(targetPublic);
    if (!targetStaticFiles.length) throw new Error(`Standalone static directory is empty: ${targetStatic}`);
    const missingPublicFiles = sourcePublicFiles.filter((file) => !targetPublicFiles.includes(file));
    if (missingPublicFiles.length) throw new Error(`Standalone public directory is incomplete: ${missingPublicFiles.join(", ")}`);

    return { serverEntry, standaloneRoot, staticFiles: targetStaticFiles.length, publicFiles: targetPublicFiles.length, sharpRuntimePackages };
}

async function copyImageProcessingRuntime(webRoot, standaloneRoot) {
    const sourceRuntime = path.join(webRoot, ".image-processing-runtime");
    await assertFile(path.join(sourceRuntime, "workers/image-processing-child.mjs"), `Image processing runtime is missing: ${sourceRuntime}`);
    await assertFile(path.join(sourceRuntime, "workers/image-processing-lane.mjs"), `Image processing lane is missing: ${sourceRuntime}`);
    const manifest = JSON.parse(await readFile(path.join(sourceRuntime, "package.json"), "utf8"));
    if (manifest.type !== "module") throw new Error("Image processing runtime must declare type: module");
    const targetRuntime = path.join(standaloneRoot, ".image-processing-runtime");
    await rm(targetRuntime, { recursive: true, force: true });
    await cp(sourceRuntime, targetRuntime, { recursive: true, dereference: true });
    const supervisor = path.join(webRoot, "scripts/image-processing-supervisor.mjs");
    await assertFile(supervisor, `Image processing supervisor is missing: ${supervisor}`);
    await mkdir(path.join(standaloneRoot, "scripts"), { recursive: true });
    await cp(supervisor, path.join(standaloneRoot, "scripts/image-processing-supervisor.mjs"));
    await Promise.all(["generation-worker.mjs", "generation-runtime.mjs", "generation-worker-policy.mjs", "web-resource-preload.mjs"].map((name) => cp(path.join(webRoot, "scripts", name), path.join(standaloneRoot, "scripts", name))));
    for (const name of ["sharp", "file-type"]) await copyRuntimePackage(name, path.join(webRoot, "node_modules"), path.join(standaloneRoot, "node_modules"), false);
}

async function copyRuntimePackage(name, sourceModules, targetModules, optional) {
    let source;
    try {
        source = await realpath(path.join(sourceModules, name));
    } catch (error) {
        if (optional && error.code === "ENOENT") return;
        throw new Error(`Image processing runtime package is missing: ${name}`, { cause: error });
    }
    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    const target = path.join(targetModules, name);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: true, filter: (entry) => path.basename(entry) !== "node_modules" });
    // Locked pnpm packages resolve their exact dependency links from their nearest node_modules.
    let dependenciesRoot = source;
    while (path.basename(dependenciesRoot) !== "node_modules") {
        const parent = path.dirname(dependenciesRoot);
        if (parent === dependenciesRoot) throw new Error(`Image processing package is outside node_modules: ${name}`);
        dependenciesRoot = parent;
    }
    const optionalDependencies = manifest.optionalDependencies || {};
    for (const dependency of Object.keys({ ...manifest.dependencies, ...optionalDependencies })) {
        await copyRuntimePackage(dependency, dependenciesRoot, path.join(target, "node_modules"), Object.hasOwn(optionalDependencies, dependency));
    }
}

async function copySharpRuntimePackages(webRoot, standaloneRoot) {
    const sourcePnpmRoot = path.join(webRoot, "node_modules", ".pnpm");
    const targetPnpmRoot = path.join(standaloneRoot, "node_modules", ".pnpm");
    const packages = (await readdir(sourcePnpmRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("@img+sharp-"));
    if (!packages.length) throw new Error(`Sharp runtime packages were not found: ${sourcePnpmRoot}`);
    if (process.platform === "linux" && !packages.some((entry) => entry.name.startsWith("@img+sharp-linux"))) {
        throw new Error(`Sharp native Linux runtime package was not found: ${sourcePnpmRoot}`);
    }
    if (process.platform === "linux" && !packages.some((entry) => entry.name.startsWith("@img+sharp-libvips-linux"))) {
        throw new Error(`Sharp libvips runtime package was not found: ${sourcePnpmRoot}`);
    }

    await mkdir(targetPnpmRoot, { recursive: true });
    const copies = packages.map((entry) => ({ source: path.join(sourcePnpmRoot, entry.name), target: path.join(targetPnpmRoot, entry.name) }));
    await Promise.all(copies.map(({ target }) => rm(target, { recursive: true, force: true })));
    await Promise.all(copies.map(({ source, target }) => cp(source, target, { recursive: true, force: true, verbatimSymlinks: true })));
    return packages.map((entry) => entry.name).sort();
}

async function assertFile(target, message) {
    try {
        if (!(await stat(target)).isFile()) throw new Error(message);
    } catch {
        throw new Error(message);
    }
}

async function copyDirectoryContents(source, target) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    await Promise.all(entries.map((entry) => cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true, force: true })));
}

async function listRelativeFiles(root, current = root) {
    const entries = await readdir(current, { withFileTypes: true });
    const files = await Promise.all(
        entries.map(async (entry) => {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) return listRelativeFiles(root, target);
            return entry.isFile() ? [path.relative(root, target).replaceAll(path.sep, "/")] : [];
        }),
    );
    return files.flat().sort();
}

function resolveChildPath(root, child, label) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, child);
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Invalid ${label}: ${child}`);
    return resolved;
}
