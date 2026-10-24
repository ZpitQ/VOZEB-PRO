import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertEnhancementJob, type ImageEnhancementJob, type StoredEnhancementArtifact } from "./database/image-enhancement-job-repository";
import { initializePostgresSchema, postgresQuery } from "./database/postgres";
import { planImageEnhancement } from "./image-enhancement-plan";
import { countLocalMediaReferences } from "./local-media-references";

const pg = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const owners = ["enhancement-media-reference-fixture-owner-a", "enhancement-media-reference-fixture-owner-b"];
const imageTaskId = "enhancement-media-reference-fixture-task";
const media = {
    source: "permanent/enhancement-media-reference-fixture/native.png",
    stagedAi: "permanent/enhancement-media-reference-fixture/staged-ai.png",
    stagedDelivered: "permanent/enhancement-media-reference-fixture/staged-delivered.png",
    publishedAi: "permanent/enhancement-media-reference-fixture/published-ai.png",
    publishedDelivered: "permanent/enhancement-media-reference-fixture/published-delivered.png",
};
const unreferenced = "permanent/enhancement-media-reference-fixture/unreferenced.png";
const keys = [...Object.values(media), unreferenced];

function artifact(key: string): StoredEnhancementArtifact {
    return { url: `/api/reference-assets/${key}`, width: 4096, height: 4096, format: "png", sha256: "b".repeat(64), byteLength: 1000 };
}

function candidate(userId: string, status: ImageEnhancementJob["status"]): ImageEnhancementJob {
    const id = randomUUID();
    const now = Date.now();
    const decision = planImageEnhancement({
        nativeValid: true, enabled: status !== "skipped", requested4k: true, protectedContract: false, layered: false,
        source: { url: `/api/generation-log-assets/${media.source}`, width: 1254, height: 1254, sha256: "a".repeat(64), byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" },
        target: { width: 4096, height: 4096 },
        connection: { revision: "fixture-policy", credentialRef: "fixture-credential", serviceId: "fixture-service", timeoutMs: 60_000, model: { id: "fixture-model", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [256], defaultTile: 256, tta: false, gpuId: 0 } },
    });
    return {
        id, userId, imageTaskId, resultId: "fixture-result", decision, status, phase: "completed", reason: decision.reason,
        attempt: 1, remoteKey: `enhancement:${id}:1`, receiptId: randomUUID(),
        staged: { ai: artifact(media.stagedAi), delivered: artifact(media.stagedDelivered) },
        publication: { ai: artifact(media.publishedAi), delivered: artifact(media.publishedDelivered), assetId: null, publishedAt: now },
        events: [], cancelRequested: status === "cancelled", createdAt: now, updatedAt: now,
        nextPollAt: null, workerId: null, leaseToken: null, leaseUntil: null,
    };
}

for (const provider of ["file", "postgres"] as const) {
    describe.skipIf(provider === "postgres" && !pg)(`${provider} durable enhancement media references`, () => {
        let directory: string | undefined;
        let createdOwners: string[];
        let createdJobs: string[];

        beforeEach(async () => {
            createdOwners = [];
            createdJobs = [];
            directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-media-references-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            if (provider === "postgres") {
                const target = new URL(process.env.DATABASE_URL || "");
                if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e")) throw new Error("An explicitly isolated M5 PostgreSQL fixture is required");
                await initializePostgresSchema();
                for (const owner of owners) {
                    const inserted = await postgresQuery<{ id: string }>("INSERT INTO users (id,username,display_name,password_hash) VALUES ($1,$1,'fixture','fixture-hash') ON CONFLICT (id) DO NOTHING RETURNING id", [owner]);
                    if (!inserted.rows[0]) throw new Error("Enhancement media reference fixture owner already exists");
                    createdOwners.push(owner);
                }
                expect((await postgresQuery<{ total: number }>("SELECT count(*)::int AS total FROM creative_assets WHERE storage_key = ANY($1::text[])", [keys])).rows[0]?.total).toBe(0);
            }
        });

        afterEach(async () => {
            try {
                if (provider === "postgres" && createdOwners.length) {
                    await postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id = ANY($1::text[]) AND id = ANY($2::text[])", [createdOwners, createdJobs]);
                    await postgresQuery("DELETE FROM users WHERE id = ANY($1::text[])", [createdOwners]);
                }
            } finally {
                vi.unstubAllEnvs();
                if (directory) await rm(directory, { recursive: true, force: true });
                directory = undefined;
            }
        });

        async function insert(job: ImageEnhancementJob) {
            createdJobs.push(job.id);
            await insertEnhancementJob(job);
        }

        it.each(["queued", "running", "succeeded", "failed", "skipped", "cancelled"] as const)("keeps source, staged and published media without creative assets in %s jobs", async (status) => {
            await insert(candidate(owners[0], status));

            expect(await countLocalMediaReferences(keys)).toEqual(new Map(keys.map((key) => [key, key === unreferenced ? 0 : 1])));
        });

        it("aggregates references to the same media across different owners", async () => {
            await insert(candidate(owners[0], "failed"));
            await insert(candidate(owners[1], "cancelled"));

            expect(await countLocalMediaReferences(keys)).toEqual(new Map(keys.map((key) => [key, key === unreferenced ? 0 : 2])));
        });
    });
}
