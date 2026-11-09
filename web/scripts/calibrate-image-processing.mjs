import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runImageProcessing } from "./image-processing-supervisor.mjs";

const profiles = {
    prepare_reference: { operation: "prepare_reference" },
    prepare_review: { operation: "prepare_review" },
    white_protection: { operation: "build_protection" },
    local_protection: { operation: "build_protection", mode: "local_edit" },
    scene_selection: { operation: "build_protection", mode: "scene_selection" },
    ordinary_result: { operation: "process_result", mode: "ordinary" },
    scene_result: { operation: "process_result", mode: "scene_protection" },
    product_result: { operation: "process_result", mode: "product_protection" },
    layers_result: { operation: "process_result", mode: "layers" },
    enhancement_global_jpeg: { operation: "process_enhancement", scope: "full_image" },
    enhancement_legacy_png: { operation: "process_enhancement", scope: "full_image", stagedFormat: "png" },
    enhancement_product: { operation: "process_enhancement", scope: "product_background" },
    enhancement_scene: { operation: "process_enhancement", scope: "local_edit" },
};

if (process.argv.length !== 3) throw new Error("Usage: node scripts/calibrate-image-processing.mjs <request-fixture.json>");
const fixture = JSON.parse(await readFile(path.resolve(process.argv[2]), "utf8"));
const profile = profiles[fixture.profile];
if (!profile || !Array.isArray(fixture.inputs) || !fixture.inputs.length || !fixture.options || typeof fixture.options !== "object" || (profile.mode !== undefined && fixture.options.mode !== profile.mode))
    throw new Error("Calibration fixture profile, inputs or options are invalid");
if (
    profile.scope !== undefined &&
    (fixture.options.scope !== profile.scope ||
        (profile.stagedFormat !== undefined && fixture.options.stagedDelivered?.expected.format !== profile.stagedFormat) ||
        (fixture.profile === "enhancement_global_jpeg" && fixture.options.stagedDelivered?.expected.format === "png"))
)
    throw new Error("Calibration fixture does not match its enhancement profile");
if (!Number.isSafeInteger(fixture.maxHeapMiB) || fixture.maxHeapMiB <= 0) throw new Error("Calibration maxHeapMiB must be a positive integer");
const directory = await mkdtemp(path.join(tmpdir(), "image-processing-calibration-"));
try {
    const outputDirectory = path.join(directory, "output");
    await mkdir(outputDirectory);
    const inputs = [];
    for (const [index, source] of fixture.inputs.entries()) {
        if (!source || typeof source.path !== "string" || typeof source.assetId !== "string" || typeof source.assetVersion !== "string") throw new Error("Calibration input paths and identities are required");
        const inputPath = path.join(directory, `input-${index}`);
        await copyFile(path.resolve(source.path), inputPath);
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(inputPath)) digest.update(chunk);
        const sha256 = digest.digest("hex");
        if (source.expectedSha256 !== undefined && source.expectedSha256 !== sha256) throw new Error(`Calibration input ${index} does not match its frozen hash`);
        inputs.push({ path: inputPath, assetId: source.assetId, assetVersion: source.assetVersion, expectedSha256: sha256 });
    }
    const before = process.memoryUsage();
    const request = { version: "image-processing.v1", jobId: "calibration-job", executionId: "calibration-execution", operation: profile.operation, inputs, options: fixture.options, outputDirectory };
    const outcome = await runImageProcessing(request, { taskDirectory: directory, maxHeapMiB: fixture.maxHeapMiB });
    const after = process.memoryUsage();
    console.log(
        JSON.stringify({
            version: "image-processing-calibration.v1",
            operationProfile: fixture.profile,
            options: fixture.options,
            node: process.version,
            sourceIdentities: outcome.status === "completed" ? outcome.result.sourceIdentities : undefined,
            artifacts: outcome.status === "completed" ? outcome.result.artifacts.map(({ path: _path, ...artifact }) => artifact) : undefined,
            resultBindings: outcome.status === "completed" ? outcome.result.results : undefined,
            geometry: outcome.status === "completed" ? outcome.result.geometry : undefined,
            enhancement: outcome.status === "completed" ? outcome.result.enhancement : undefined,
            child: { status: outcome.status, pid: outcome.pid, exitCode: outcome.exitCode, signal: outcome.signal, stderr: outcome.stderr, ...(outcome.status === "completed" ? { metrics: outcome.result.metrics } : { failure: outcome }) },
            supervisor: { maxRssBytes: process.resourceUsage().maxRSS * 1024, before, after },
            measurementScope:
                "One real supervisor and one child, including file reads, complete pixels, artifact writes and post-close stream verification. Staging copy/hash precedes supervisor samples. RSS includes OS high-water; heap/external are explicit samples, not absolute peaks. Record cgroup peak/events independently.",
            temporaryArtifactsRemoved: true,
        }),
    );
    if (outcome.status !== "completed") process.exitCode = 1;
} finally {
    await rm(directory, { recursive: true, force: true });
}
