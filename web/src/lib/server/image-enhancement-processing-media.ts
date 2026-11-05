import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { imageMimeType, orientedDimensions } from "../image-processing/generated-image";
import type { ImageProcessingEnhancementOptions } from "../image-processing/contracts";
import type { EncodedImageProcessingInput, ImageProcessingResourceFacts } from "../image-processing/resource-model";
import { assertEnhancementFrozenInputs, EnhancementProcessingConflict, type EnhancementProcessingTask } from "./image-enhancement-processing-store";
import type { StoredImageProcessingArtifact } from "./image-processing-service";
import { GENERATION_MEDIA_ROOT, REFERENCE_MEDIA_ROOT } from "./local-media-storage";
import { getLocalMediaRegistrations, isLocalMediaRegistrationExpired, type LocalMediaRegistration } from "./local-media-registry";
import { readExternalMediaStream } from "./object-storage-service";

export function enhancementInputBudget(options: ImageProcessingEnhancementOptions, inputIndex: number) {
    const budgets: Array<{ maxBytes: number; maxPixels: number }> = [];
    if (inputIndex === options.aiInputIndex) budgets.push(options.budgets.ai);
    if (options.stagedDelivered?.inputIndex === inputIndex || (options.scope !== "full_image" && options.baselineInputIndex === inputIndex)) budgets.push(options.budgets.delivery);
    if (options.scope !== "full_image" && [options.sourceInputIndex, options.nativeInputIndex, options.maskInputIndex].includes(inputIndex)) budgets.push(options.budgets.input);
    const permanent = inputIndex === options.aiInputIndex || options.stagedDelivered?.inputIndex === inputIndex || (options.scope !== "full_image" && options.baselineInputIndex === inputIndex);
    return { maxBytes: Math.min(...budgets.map((budget) => budget.maxBytes)), maxPixels: Math.min(...budgets.map((budget) => budget.maxPixels), permanent ? 40_000_000 : Number.MAX_SAFE_INTEGER) };
}

export async function enhancementRegisteredStream(registration: LocalMediaRegistration, signal?: AbortSignal) {
    if (registration.storageProvider === "object") return readExternalMediaStream(registration, signal);
    const root = resolve(registration.scope === "generation" ? GENERATION_MEDIA_ROOT : REFERENCE_MEDIA_ROOT);
    const filename = resolve(root, registration.storageKey);
    if (registration.storageKey.includes("\\") || filename === root || !filename.startsWith(root + sep)) throw new EnhancementProcessingConflict("增强原件路径无效");
    return createReadStream(filename, { signal });
}

async function copyVerified(registration: LocalMediaRegistration, expected: { sha256: string; bytes: number }, filename: string, maxBytes: number, signal?: AbortSignal) {
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > expected.bytes || bytes > maxBytes) return done(new EnhancementProcessingConflict("增强原件流超过冻结字节限制", 413));
            hash.update(chunk);
            done(null, chunk);
        },
    });
    await pipeline(await enhancementRegisteredStream(registration, signal), meter, createWriteStream(filename, { flags: "wx" }), { signal });
    if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new EnhancementProcessingConflict("增强原件实际字节或SHA已变化");
}

/** The returned file is closed, byte-exact and metadata checked; pixels remain the CPU child responsibility. */
export async function readVerifiedEnhancementMedia(registration: LocalMediaRegistration, expected: { sha256: string; bytes: number; width: number; height: number; mimeType: string }, budget: { maxBytes: number; maxPixels: number }) {
    const directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-owned-media-"));
    const filePath = join(directory, "closed-input");
    try {
        await copyVerified(registration, expected, filePath, budget.maxBytes);
        const metadata = await sharp(filePath, { failOn: "warning", limitInputPixels: budget.maxPixels }).metadata();
        const size = orientedDimensions(metadata);
        if (size.width !== expected.width || size.height !== expected.height || imageMimeType(metadata) !== expected.mimeType || !metadata.format || !metadata.depth || !metadata.channels)
            throw new EnhancementProcessingConflict("Enhancement owned input metadata changed");
        return { filePath, metadata: { format: metadata.format, depth: metadata.depth, channels: metadata.channels }, dispose: () => rm(directory, { recursive: true, force: true }) };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

/** All original stream/hash/metadata I/O happens before relation database locks. */
export async function readEnhancementProcessingFacts(child: EnhancementProcessingTask): Promise<ImageProcessingResourceFacts> {
    const registrations = await getLocalMediaRegistrations(
        child.payload.sources.map((source) => source.storageKey),
        { ownerUserId: child.userId },
    );
    assertEnhancementFrozenInputs(child.payload, registrations, Date.now());
    const directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-facts-"));
    const encodedInputs: EncodedImageProcessingInput[] = [];
    const decodedInputs: Array<ImageProcessingResourceFacts["decodedInputs"][number]> = [];
    try {
        for (const [inputIndex, input] of child.payload.inputs.entries()) {
            const source = child.payload.sources.find((value) => value.inputIndex === inputIndex)!;
            const frozen = child.payload.enhancementInputs[inputIndex];
            const registration = registrations.find((value) => value.storageKey === source.storageKey)!;
            const identity = { inputIndex, assetId: input.assetId, assetVersion: input.assetVersion, sha256: frozen.expectedSha256 };
            const budget = enhancementInputBudget(child.payload.options, inputIndex);
            const filename = join(directory, String(inputIndex));
            await copyVerified(registration, { sha256: frozen.expectedSha256, bytes: frozen.bytes }, filename, budget.maxBytes);
            const metadata = await sharp(filename, { failOn: "warning", limitInputPixels: budget.maxPixels }).metadata();
            const dimensions = orientedDimensions(metadata);
            if (dimensions.width !== frozen.width || dimensions.height !== frozen.height || imageMimeType(metadata) !== frozen.mimeType || !metadata.format || !metadata.depth || !metadata.channels)
                throw new EnhancementProcessingConflict("增强原件实际布局与冻结事实不符");
            encodedInputs.push({ ...identity, bytes: frozen.bytes, layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels } });
            decodedInputs.push({ ...identity, ...dimensions });
        }
        return { encodedInputs, decodedInputs };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function readVerifiedEnhancementArtifact(child: EnhancementProcessingTask, artifact: StoredImageProcessingArtifact) {
    const registration = (await getLocalMediaRegistrations([artifact.storageKey], { ownerUserId: child.userId }))[0];
    if (
        !registration ||
        registration.scope !== "reference" ||
        registration.type !== "image" ||
        registration.taskId !== child.id ||
        registration.source !== "image-processing-final" ||
        registration.bytes !== artifact.bytes ||
        registration.mimeType !== artifact.mimeType ||
        isLocalMediaRegistrationExpired(registration, Date.now())
    )
        throw new EnhancementProcessingConflict("增强交付工件登记已变化或失效");
    const directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-artifact-"));
    const filePath = join(directory, "closed-artifact");
    try {
        await copyVerified(registration, artifact, filePath, child.payload.options.budgets.delivery.maxBytes);
        const metadata = await sharp(filePath, { failOn: "warning", limitInputPixels: Math.min(40_000_000, child.payload.options.budgets.delivery.maxPixels) }).metadata();
        const size = orientedDimensions(metadata);
        if (
            size.width !== artifact.width ||
            size.height !== artifact.height ||
            imageMimeType(metadata) !== artifact.mimeType ||
            (metadata.orientation !== undefined && metadata.orientation !== 1) ||
            (metadata.pages !== undefined && metadata.pages !== 1) ||
            (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)
        )
            throw new EnhancementProcessingConflict("增强交付工件实际元数据已变化");
        return { filePath, registration, dispose: () => rm(directory, { recursive: true, force: true }) };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}
