import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateImageTaskBody, ImageTaskRunResult } from "@/app/api/image-tasks/image-task-types";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import type { RuntimeFileDatabase } from "./creative-runtime-repository";
import type { CreativeRunEvent } from "@/lib/creative-runtime-contract";
import type { ImageTask } from "./image-task-store";
import type { QueryExecutor } from "./database";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceSources } from "./ecommerce-reference-roles";
import type { StructuredTextRequest } from "./text-planning-runtime";
import type { ImageProcessingOutcome } from "@/lib/image-processing/contracts";
import type { ClaimedImageProcessingTask, CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

type SqlRow = Record<string, unknown>;
type SettingsRow = {
    logical_models: unknown;
    default_models: unknown;
    model_point_costs: unknown;
    generation_concurrency: unknown;
    generation_defaults: unknown;
    ecommerce_generation_enabled: boolean;
    ecommerce_visual_quality_check_enabled: boolean;
    ecommerce_model_roles: unknown;
};
type PostgresFixture = { channelId: string; channelCiphertext: string; saved: SettingsRow; installed: SettingsRow };
type ChildIdentity = { pid: number; parentPid: number; startTime: string; state: string };
type CompleteWorker = {
    child: ClaimedImageProcessingTask;
    completion: CompleteImageProcessingInput;
    receipt: Awaited<ReturnType<typeof import("./image-processing-service").completeImageProcessingTask>>;
    uploads: Array<{ stored: StoredImageProcessingArtifact; bytes: Buffer }>;
};
type CancellationInput = {
    workerId: string;
    executionId: string;
    closed: Pick<ImageProcessingOutcome, "jobId" | "executionId" | "status" | "pid" | "exitCode" | "signal" | "stderr">;
    stopCause: "cancel_requested";
};
type CancellationReceipt = { jobId: string; executionId: string; status: "cancelled"; executionPhase: "completed" };
type CancelledWorker = { child: ClaimedImageProcessingTask; captured: ChildIdentity; pending: { sigPnd: string; shdPnd: string }; input: CancellationInput; receipt: CancellationReceipt };

type OriginalReadStream = typeof import("node:fs").createReadStream;
const postOriginalStreamBoundary = vi.hoisted((): { wrap?: (original: OriginalReadStream, args: Parameters<OriginalReadStream>) => Readable } => ({}));
vi.mock("node:fs", async (original) => {
    const actual = await original<typeof import("node:fs")>();
    return {
        ...actual,
        createReadStream: (...args: Parameters<OriginalReadStream>) => (postOriginalStreamBoundary.wrap ? postOriginalStreamBoundary.wrap(actual.createReadStream, args) : actual.createReadStream(...args)),
    };
});

const r03ProjectionRead = vi.hoisted((): { afterImageGet?: (imageId: string) => Promise<void> } => ({}));
const r03ProjectionWrite = vi.hoisted(() => ({ runId: "" }));
vi.mock("./data-adapter", async (original) => {
    const actual = await original<typeof import("./data-adapter")>();
    return {
        ...actual,
        writeJsonDataFile: async (file: string, value: unknown) => {
            if (file === "creative-runtime.json" && r03ProjectionWrite.runId) {
                const event = (value as RuntimeFileDatabase).events.at(-1);
                const data = event?.data as { imageProcessingProjectionKey?: string } | undefined;
                if (event?.runId === r03ProjectionWrite.runId && data?.imageProcessingProjectionKey) {
                    r03ProjectionWrite.runId = "";
                    throw new Error("controlled R03 fault before the real runtime rename");
                }
            }
            await actual.writeJsonDataFile(file, value);
        },
    };
});

const textPlanningActual = vi.hoisted((): { module?: typeof import("./text-planning-runtime") } => ({}));
const boundary = vi.hoisted(() => ({ cookie: "", create: vi.fn(), poll: vi.fn(), model: vi.fn<typeof import("./text-planning-runtime").requestStructuredText>() }));
const imageTaskSupportActual = vi.hoisted((): { module?: typeof import("@/app/api/image-tasks/image-task-support") } => ({}));
vi.mock("next/headers", async () => {
    const { RequestCookies } = await import("next/dist/server/web/spec-extension/cookies");
    return { cookies: async () => new RequestCookies(new Headers({ cookie: boundary.cookie })) };
});
// This fixture drives the persisted scheduler explicitly after real POST/link completes.
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/app/api/image-tasks/image-task-openai", () => ({ runOpenAiImageTask: boundary.create }));
vi.mock("./text-planning-runtime", async (original) => {
    const actual = await original<typeof import("./text-planning-runtime")>();
    textPlanningActual.module = actual;
    return { ...actual, requestStructuredText: boundary.model };
});
vi.mock("@/app/api/image-tasks/image-task-support", async (original) => {
    const actual = await original<typeof import("@/app/api/image-tasks/image-task-support")>();
    imageTaskSupportActual.module = actual;
    return { ...actual, pollOpenAiImageTask: boundary.poll };
});

export function imageTaskResultRunCopySuite(provider: "file" | "postgres") {
    const enabled = provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
    (enabled ? describe : describe.skip)(`${provider} ordinary Run copies through real dispatch, image Routes and result Workers`, () => {
        let directory: string;
        let userId: string;
        let imageModelId: string;
        let imageTasks: typeof import("./image-task-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        let processing: typeof import("./image-task-result-processing");
        let service: typeof import("./image-processing-service");
        let references: typeof import("./reference-asset-store");
        let registrations: typeof import("./local-media-registry");
        let auth: typeof import("@/lib/auth/store");
        let creative: typeof import("./creative-runtime-service");
        let logs: typeof import("./generation-log-store");
        let recovery: typeof import("./generation-task-recovery-service");
        let runtime: typeof import("./image-task-runtime");
        let runs: typeof import("./agent-run-store");
        let execution: typeof import("./agent-run-execution");
        let database: typeof import("./database");
        let pgFixture: PostgresFixture | undefined;
        let liveCancellation: Promise<void> | undefined;
        let liveCleanupUnconfirmed = false;
        let charges: Map<string, Awaited<ReturnType<typeof auth.consumeUserPoints>>>;
        let providerResults: Map<string, ImageTaskRunResult>;
        const workerToken = "fixture-run-copy-worker-token-00000001";
        const resourceEnvironment = {
            VOZEB_PRO_GENERATION_WORKER_MEMORY_MB: "8192",
            VOZEB_PRO_GENERATION_WORKER_HEAP_MB: "64",
            VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB: "6144",
            VOZEB_PRO_IMAGE_PROCESS_HEAP_MB: "384",
            VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY: "1",
        };

        beforeEach(async () => {
            if (liveCleanupUnconfirmed) throw new Error("SETUP: previous live fixture cleanup is unconfirmed; refusing to reuse its PostgreSQL pool");
            if (
                provider === "postgres" &&
                (process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
                    process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
                    process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
                    process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
                    !process.env.DATABASE_URL)
            )
                throw new Error("SETUP: explicit owned isolated PostgreSQL with startup pool maximum one is required");
            vi.resetModules();
            vi.clearAllMocks();
            r03ProjectionWrite.runId = "";
            r03ProjectionRead.afterImageGet = undefined;
            boundary.model.mockReset();
            userId = "";
            pgFixture = undefined;
            liveCancellation = undefined;
            directory = await mkdtemp(path.join(tmpdir(), `vozeb-run-copy-${provider}-`));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            if (provider === "file") {
                vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", "fixture-run-copy-file-install-token");
                vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            }
            vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
            vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-run-copy-maintenance-token-0001");
            for (const [key, value] of Object.entries(resourceEnvironment)) vi.stubEnv(key, value);
            database = await import("./database");
            if (provider === "postgres") await database.initializePostgresSchema();
            [imageTasks, tasks, scheduler, processing, service, references, registrations, auth, creative, logs, recovery, runtime, runs, execution] = await Promise.all([
                import("./image-task-store"),
                import("./generation-task-store"),
                import("./generation-task-scheduler"),
                import("./image-task-result-processing"),
                import("./image-processing-service"),
                import("./reference-asset-store"),
                import("./local-media-registry"),
                import("@/lib/auth/store"),
                import("./creative-runtime-service"),
                import("./generation-log-store"),
                import("./generation-task-recovery-service"),
                import("./image-task-runtime"),
                import("./agent-run-store"),
                import("./agent-run-execution"),
            ]);
            const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
            expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
            if (provider === "file") {
                const admin = await auth.createFirstAdmin({ username: "fixture-run-copy-file-admin", password: "FixtureRunCopyPassword1!", displayName: "Fixture administrator", installToken: process.env.VOZEB_PRO_INSTALL_TOKEN });
                const user = await auth.createUserByAdmin({ actorId: admin.id, username: "fixture-run-copy-file-user", password: "FixtureRunCopyPassword1!", displayName: "Fixture Run copy", pointsBalance: 100 });
                userId = user.id;
            } else {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                assert.ok(planId, "SETUP: fixture entitlement plan missing");
                userId = "fixture-run-copy-pg-" + randomUUID();
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: "fixture_" + randomUUID().replaceAll("-", "").slice(0, 16),
                    displayName: "Isolated PostgreSQL Run copy fixture",
                    bio: "",
                    role: "user",
                    adminPermissions: [],
                    status: "active",
                    planId,
                    pointsBalance: 0,
                    passwordHash: "fixture-only",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
                const wallet = await import("./points-wallet-service");
                expect(await wallet.creditPermanentPoints({ userId, amount: 100, description: "Isolated PostgreSQL Run copy fixture", idempotencyKey: "fixture-run-copy-credit:" + userId })).toMatchObject({
                    applied: true,
                    record: { userId, type: "credit", amount: 100 },
                });
            }
            if (provider === "file") {
                const defaults = await auth.getAuthSettings();
                const configured = await auth.setAuthSettings({
                    systemChannels: [{ id: "fixture-run-copy-channel", name: "Run copy fixture image channel", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only-image-key", apiFormat: "openai", models: ["gpt-image-1"], enabled: true }],
                    logicalModels: [
                        {
                            id: "fixture-run-copy-image",
                            name: "Run copy fixture image",
                            capability: "image",
                            enabled: true,
                            bindings: [{ id: "fixture-run-copy-binding", channelId: "fixture-run-copy-channel", upstreamModel: "gpt-image-1", enabled: true, priority: 1 }],
                        },
                    ],
                    generationConcurrency: { ...defaults.generationConcurrency, image: 2 },
                    generationDefaults: { ...defaults.generationDefaults, imageQuality: "low", imageSize: "1024x1024", imageCount: 1 },
                });
                const logical = configured.logicalModels.find((model) => model.capability === "image" && model.enabled && model.bindings.some((binding) => binding.channelId === "fixture-run-copy-channel" && binding.enabled));
                assert.ok(logical, "SETUP: actual settings normalization must retain a usable logical image model");
                imageModelId = logical.id;
                await auth.setAuthSettings({ defaultModels: { ...configured.defaultModels, imageModel: imageModelId }, modelPointCosts: { [imageModelId]: 2 } });
            } else {
                await configurePostgresFixture();
            }
            const session = await auth.createSession(userId);
            expect(await auth.getUserBySession(session)).toMatchObject({ id: userId });
            boundary.cookie = `vozeb_pro_session=${session}`;
            charges = new Map();
            providerResults = new Map();
            boundary.create.mockImplementation(async (submission: ImageTask, origin: string, _publicOrigin: string, cookie: string): Promise<ImageTaskRunResult> => {
                if (submission.sceneProtection && submission.ecommerceExecution?.canvas) {
                    const [{ buildImageEditFormData, normalizeQuality }, { recordEcommerceCanvasRequest, resolveCanvasRequestSize }] = await Promise.all([
                        import("@/app/api/image-tasks/image-task-support"),
                        import("@/app/api/image-tasks/image-task-size"),
                    ]);
                    const quality = normalizeQuality(submission.config.quality || "");
                    const formData = await buildImageEditFormData(submission, quality, resolveCanvasRequestSize(submission, quality), origin, cookie, "url", false);
                    expect(formData.get("size"), "SETUP: the real scene multipart adapter must retain its exact canvas").toBe("1024x1024");
                    expect(formData.getAll("image")).toHaveLength(submission.references.length);
                    expect(formData.get("mask")).toBeInstanceOf(File);
                    await recordEcommerceCanvasRequest(submission, { size: String(formData.get("size") || "") }, "OpenAI multipart");
                    expect((await imageTasks.getImageTask(submission.id))?.ecommerceCanvasRequest).toStrictEqual({ size: "1024x1024" });
                }
                const charge = await auth.consumeUserPoints(userId, imageModelId, 1, "image", `fixture-run-copy:${submission.id}`);
                charges.set(submission.id, charge);
                return {
                    dataUrl: "",
                    pending: { id: `fixture-upstream-${submission.id}`, mediaBaseUrl: "https://fixture.invalid", pollBaseUrl: "https://fixture.invalid/v1" },
                    pointsCost: charge.cost,
                    pointsRecordId: charge.recordId,
                    pointsRemaining: charge.remaining,
                };
            });
            boundary.poll.mockImplementation(async (_config: ImageTask["config"], upstreamId: string) => {
                const result = providerResults.get(upstreamId);
                assert.ok(result, "SETUP: query must target the same submitted upstream copy");
                return result;
            });
        }, 30_000);

        afterEach(async () => {
            if (liveCleanupUnconfirmed) {
                throw new Error(`CLEANUP: live fixture cleanup is unconfirmed; retained fixture user=${userId}, channel=${pgFixture?.channelId}, directory=${directory}; Root must verify cleanup before further PostgreSQL execution`);
            }
            try {
                if (provider === "postgres" && pgFixture) await restorePostgresFixture();
            } finally {
                try {
                    if (provider === "postgres" && userId) {
                        const ownedRunIds = (await database.postgresQuery<{ id: string }>("SELECT id FROM generation_tasks WHERE user_id=$1 AND task_type='agent' ORDER BY id", [userId])).rows.map((row) => row.id);
                        await database.postgresQuery("DELETE FROM creative_run_events WHERE run_id=ANY($1::text[])", [ownedRunIds]);
                        await database.postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id = $1", [userId]);
                        await database.createPostgresRepositories().users.delete(userId);
                        expect((await database.postgresQuery("SELECT id FROM users WHERE id = $1", [userId])).rows).toStrictEqual([]);
                        expect((await database.postgresQuery("SELECT id FROM generation_tasks WHERE user_id = $1", [userId])).rows).toStrictEqual([]);
                        expect((await database.postgresQuery("SELECT id FROM sessions WHERE user_id = $1", [userId])).rows).toStrictEqual([]);
                        expect((await database.postgresQuery("SELECT storage_key FROM local_media_assets WHERE owner_user_id = $1", [userId])).rows).toStrictEqual([]);
                        expect((await database.postgresQuery("SELECT id FROM point_records WHERE user_id = $1", [userId])).rows).toStrictEqual([]);
                        expect((await database.postgresQuery("SELECT id FROM creative_run_events WHERE run_id=ANY($1::text[])", [ownedRunIds])).rows).toStrictEqual([]);
                        userId = "";
                    }
                } finally {
                    try {
                        if (directory) await rm(directory, { recursive: true, force: true });
                    } finally {
                        boundary.cookie = "";
                        r03ProjectionWrite.runId = "";
                        r03ProjectionRead.afterImageGet = undefined;
                        vi.unstubAllEnvs();
                    }
                }
            }
        });

        async function readSettings(executor: QueryExecutor) {
            const result = await executor.query<SettingsRow>(
                "SELECT logical_models, default_models, model_point_costs, generation_concurrency, generation_defaults, ecommerce_generation_enabled, ecommerce_visual_quality_check_enabled, ecommerce_model_roles FROM app_settings WHERE id = 'default'",
            );
            expect(result.rows).toHaveLength(1);
            return result.rows[0];
        }

        async function writeSettings(executor: QueryExecutor, settings: SettingsRow) {
            await executor.query(
                "UPDATE app_settings SET logical_models=$1::jsonb, default_models=$2::jsonb, model_point_costs=$3::jsonb, generation_concurrency=$4::jsonb, generation_defaults=$5::jsonb, ecommerce_generation_enabled=$6, ecommerce_visual_quality_check_enabled=$7, ecommerce_model_roles=$8::jsonb WHERE id='default'",
                [
                    JSON.stringify(settings.logical_models),
                    JSON.stringify(settings.default_models),
                    JSON.stringify(settings.model_point_costs),
                    JSON.stringify(settings.generation_concurrency),
                    JSON.stringify(settings.generation_defaults),
                    settings.ecommerce_generation_enabled,
                    settings.ecommerce_visual_quality_check_enabled,
                    JSON.stringify(settings.ecommerce_model_roles),
                ],
            );
        }

        async function configurePostgresFixture() {
            const channelId = "fixture-run-copy-channel-" + randomUUID();
            const upstreamModel = "gpt-image-1-fixture-" + randomUUID();
            const { encryptSecretValue } = await import("./secret-crypto");
            const { readPostgresAuthSettings } = await import("@/lib/auth/store-repository");
            const channelCiphertext = encryptSecretValue("fixture-only-image-key");
            pgFixture = await database.withPostgresTransaction(async (executor) => {
                const repositories = database.createPostgresRepositories(executor);
                await repositories.settings.lock();
                const saved = await readSettings(executor);
                const defaults = await readPostgresAuthSettings(executor);
                assert.equal(await repositories.settings.getSystemModelChannelById(channelId), null, "SETUP: fixture channel must be new");
                await repositories.settings.upsertSystemModelChannel({
                    id: channelId,
                    name: "Run copy fixture image channel",
                    baseUrl: "https://fixture.invalid/v1",
                    apiKeyCiphertext: channelCiphertext,
                    webhookSecretCiphertext: "",
                    apiFormat: "openai",
                    models: [upstreamModel],
                    enabled: true,
                    sortOrder: 0,
                });
                await writeSettings(executor, {
                    ...saved,
                    logical_models: [
                        ...defaults.logicalModels,
                        {
                            id: "fixture-run-copy-image-" + randomUUID(),
                            name: "Run copy fixture image",
                            capability: "image",
                            enabled: true,
                            bindings: [{ id: "fixture-run-copy-binding-" + randomUUID(), channelId, upstreamModel, enabled: true, priority: 1 }],
                        },
                    ],
                    generation_concurrency: { ...defaults.generationConcurrency, image: 2 },
                    generation_defaults: { ...defaults.generationDefaults, imageQuality: "low", imageSize: "1024x1024", imageCount: 1 },
                });
                return { channelId, channelCiphertext, saved, installed: await readSettings(executor) };
            });
            const configured = await auth.getFreshAuthSettings();
            const logical = configured.logicalModels.find((model) => model.capability === "image" && model.enabled && model.bindings.some((binding) => binding.channelId === channelId && binding.enabled));
            assert.ok(logical, "SETUP: actual settings normalization must retain a usable logical image model");
            expect(logical.bindings).toHaveLength(1);
            expect(logical.bindings).toMatchObject([{ channelId, upstreamModel, enabled: true }]);
            imageModelId = logical.id;
            const fixture = pgFixture;
            fixture.installed = await database.withPostgresTransaction(async (executor) => {
                await database.createPostgresRepositories(executor).settings.lock();
                expect(await readSettings(executor), "SETUP: fixture settings changed before model pricing").toStrictEqual(fixture.installed);
                await writeSettings(executor, { ...fixture.installed, default_models: { ...configured.defaultModels, imageModel: imageModelId }, model_point_costs: { ...configured.modelPointCosts, [imageModelId]: 2 } });
                return readSettings(executor);
            });
            expect((await auth.getFreshAuthSettings()).defaultModels.imageModel).toBe(imageModelId);
        }

        async function restorePostgresFixture() {
            const fixture = pgFixture;
            assert.ok(fixture);
            await database.withPostgresTransaction(async (executor) => {
                await database.createPostgresRepositories(executor).settings.lock();
                expect(await readSettings(executor), "CLEANUP: fixture settings changed; refusing to overwrite another writer").toStrictEqual(fixture.installed);
                await writeSettings(executor, fixture.saved);
                const removed = await executor.query("DELETE FROM system_model_channels WHERE id=$1 AND api_key_ciphertext=$2 RETURNING id", [fixture.channelId, fixture.channelCiphertext]);
                expect(removed.rows).toStrictEqual([{ id: fixture.channelId }]);
                expect(await readSettings(executor)).toStrictEqual(fixture.saved);
            });
            await auth.getFreshAuthSettings();
            expect(await database.createPostgresRepositories().settings.getSystemModelChannelById(fixture.channelId)).toBeNull();
            pgFixture = undefined;
        }

        async function postgresAccountRows(executor: QueryExecutor) {
            return {
                users: (await executor.query<SqlRow>("SELECT * FROM users WHERE id=$1 ORDER BY id", [userId])).rows,
                sessions: (await executor.query<SqlRow>("SELECT * FROM sessions WHERE user_id=$1 ORDER BY id", [userId])).rows,
                pointRecords: (await executor.query<SqlRow>("SELECT * FROM point_records WHERE user_id=$1 ORDER BY id", [userId])).rows,
                quotaUsage: (await executor.query<SqlRow>("SELECT * FROM quota_usage WHERE user_id=$1 ORDER BY date, usage_kind", [userId])).rows,
                dailyWallets: (await executor.query<SqlRow>("SELECT * FROM daily_plan_point_wallets WHERE user_id=$1 ORDER BY date", [userId])).rows,
                planAssignments: (await executor.query<SqlRow>("SELECT * FROM user_plan_assignments WHERE user_id=$1 ORDER BY id", [userId])).rows,
                settings: await readSettings(executor),
            };
        }

        async function postgresAccountSnapshot() {
            return database.withPostgresTransaction(async (executor) => {
                await executor.query("SET TRANSACTION READ ONLY");
                return postgresAccountRows(executor);
            });
        }

        async function postgresRegistrations() {
            return (await database.postgresQuery<SqlRow>("SELECT * FROM local_media_assets WHERE owner_user_id=$1 ORDER BY storage_key", [userId])).rows;
        }

        async function drainLiveRequests(pending: Promise<unknown>, message: string) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    pending,
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error(message)), 15_000);
                    }),
                ]);
            } catch (error) {
                liveCleanupUnconfirmed = true;
                throw error;
            } finally {
                clearTimeout(timer);
            }
        }

        async function storedFiles(folder = directory): Promise<Array<{ path: string; bytes: Buffer }>> {
            const entries = await readdir(folder, { withFileTypes: true });
            const files = await Promise.all(
                entries
                    .toSorted((left, right) => left.name.localeCompare(right.name))
                    .map(async (entry) => {
                        const file = path.join(folder, entry.name);
                        return entry.isDirectory() ? storedFiles(file) : [{ path: path.relative(directory, file), bytes: await readFile(file) }];
                    }),
            );
            return files.flat();
        }

        async function ownedRows(conversationId: string) {
            if (provider === "postgres")
                return database.withPostgresTransaction(async (executor) => {
                    await executor.query("SET TRANSACTION READ ONLY");
                    return {
                        rows: (await executor.query<SqlRow>("SELECT * FROM generation_tasks WHERE user_id=$1 ORDER BY id", [userId])).rows,
                        registrations: (await executor.query<SqlRow>("SELECT * FROM local_media_assets WHERE owner_user_id=$1 ORDER BY storage_key", [userId])).rows,
                        logs: (await executor.query<SqlRow>("SELECT * FROM generation_logs WHERE user_id=$1 ORDER BY id", [userId])).rows,
                        logAssets: (
                            await executor.query<SqlRow>("SELECT asset.* FROM generation_log_assets AS asset JOIN generation_logs AS log ON log.id=asset.generation_log_id WHERE log.user_id=$1 ORDER BY asset.generation_log_id,asset.sort_order,asset.id", [
                                userId,
                            ])
                        ).rows,
                        assets: (await executor.query<SqlRow>("SELECT * FROM creative_assets WHERE user_id=$1 AND conversation_id=$2 ORDER BY ordinal,id", [userId, conversationId])).rows,
                        conversations: (await executor.query<SqlRow>("SELECT * FROM creative_conversations WHERE user_id=$1 AND id=$2 ORDER BY id", [userId, conversationId])).rows,
                        messages: (
                            await executor.query<SqlRow>(
                                "SELECT message.* FROM creative_messages AS message JOIN creative_conversations AS conversation ON conversation.id=message.conversation_id WHERE conversation.user_id=$1 AND conversation.id=$2 ORDER BY message.id",
                                [userId, conversationId],
                            )
                        ).rows,
                        runEvents: (
                            await executor.query<SqlRow>("SELECT event.* FROM creative_run_events AS event JOIN generation_tasks AS run ON run.id=event.run_id WHERE run.user_id=$1 AND run.conversation_id=$2 AND run.task_type='agent' ORDER BY event.id", [
                                userId,
                                conversationId,
                            ])
                        ).rows,
                        account: await postgresAccountRows(executor),
                        files: await storedFiles(),
                    };
                });
            return {
                rows: (await tasks.listStoredGenerationTaskRecords({ userId })).all.toSorted((left, right) => left.id.localeCompare(right.id)),
                registrations: (await registrations.listFileLocalMediaRegistrations()).filter((record) => record.ownerUserId === userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey)),
                logs: (await logs.listGenerationLogs({ userId })).items,
                assets: await creative.listAssetsForUser(userId, conversationId),
                authBytes: await readFile(path.join(directory, "auth.json")),
                files: await storedFiles(),
            };
        }

        function digest(bytes: Buffer) {
            return createHash("sha256").update(bytes).digest("hex");
        }

        function dataUrl(bytes: Buffer) {
            return `data:image/png;base64,${bytes.toString("base64")}`;
        }

        function solid(background: string) {
            return sharp({ create: { width: 12, height: 8, channels: 4, background } })
                .png()
                .toBuffer();
        }

        async function withImageRoutes<T>(
            run: AgentRun,
            task: AgentRunTask,
            action: (origin: string, created: Array<{ requestId: string; taskId: string }>) => Promise<T>,
            beforeFirstPostResponse?: (imageId: string, origin: string) => Promise<void>,
            postFault?: {
                beforeActualPost: (body: CreateImageTaskBody) => void;
                beforeRejectedPostRelay: (body: CreateImageTaskBody, result: Response, created: Array<{ requestId: string; taskId: string }>) => Promise<void>;
            },
        ) {
            const [{ POST }, detail, runDetail, reference, generationAsset] = await Promise.all([
                import("@/app/api/image-tasks/route"),
                import("@/app/api/image-tasks/[id]/route"),
                import("@/app/api/agent/runs/[id]/route"),
                import("@/app/api/reference-assets/[...path]/route"),
                import("@/app/api/generation-log-assets/[...path]/route"),
            ]);
            const created: Array<{ requestId: string; taskId: string }> = [];
            const firstPolled = Promise.withResolvers<void>();
            if (task.childTasks?.[0]?.status === "completed") firstPolled.resolve();
            const active = new Set<Promise<void>>();
            const failure = Promise.withResolvers<never>();
            let origin: string;
            const logicalAttempt = task.attempts + 1;
            const copy1RequestId = `${run.clientRequestId}:${task.id}:${logicalAttempt}:1`;

            async function relay(result: Response, response: ServerResponse) {
                const bytes = Buffer.from(await result.arrayBuffer());
                for (const [name, value] of result.headers) response.setHeader(name, value);
                response.writeHead(result.status);
                response.end(bytes);
            }

            async function handle(request: IncomingMessage, response: ServerResponse) {
                assert.ok(request.url);
                const url = new URL(request.url, origin);
                expect(request.headers.cookie).toBe(boundary.cookie);
                if (request.method === "GET" && url.pathname.startsWith("/api/reference-assets/")) {
                    await relay(await reference.GET(new Request(url, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ path: url.pathname.slice("/api/reference-assets/".length).split("/").map(decodeURIComponent) }) }), response);
                    return;
                }
                if (request.method === "GET" && url.pathname.startsWith("/api/generation-log-assets/")) {
                    await relay(
                        await generationAsset.GET(new Request(url, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ path: url.pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent) }) }),
                        response,
                    );
                    return;
                }
                if (url.pathname === "/api/image-tasks" && request.method === "POST") {
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const bytes = Buffer.concat(chunks);
                    const body: CreateImageTaskBody = JSON.parse(bytes.toString("utf8"));
                    const requestId = body.context?.clientRequestId;
                    assert.ok(requestId);
                    expect(body.context).toMatchObject({ runId: run.id, conversationId: run.conversationId, parentTaskId: task.id, attemptNo: logicalAttempt });
                    expect(body.config).toMatchObject({ model: imageModelId, size: task.ratio, quality: task.quality });
                    if (requestId !== copy1RequestId) await firstPolled.promise;
                    postFault?.beforeActualPost(body);
                    const result = await POST(new Request(url, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: new Uint8Array(bytes) }));
                    if (postFault) {
                        expect(result.status, "SETUP: stream-fault mode must relay the actual image POST rejection; response=" + (await result.clone().text())).toBe(409);
                        await postFault.beforeRejectedPostRelay(body, result, created);
                        await relay(result, response);
                        if (requestId === copy1RequestId) firstPolled.resolve();
                        return;
                    }
                    expect(result.status, "SETUP: actual image POST must pass authentication, config and concurrency validation; response=" + (await result.clone().text())).toBe(200);
                    const envelope: { task: { id: string } } = await result.clone().json();
                    assert.ok(envelope.task.id);
                    created.push({ requestId, taskId: envelope.task.id });
                    if (requestId === copy1RequestId) await beforeFirstPostResponse?.(envelope.task.id, origin);
                    await relay(result, response);
                    return;
                }
                const imageMatch = /^\/api\/image-tasks\/([^/]+)$/.exec(url.pathname);
                if (imageMatch && (request.method === "POST" || request.method === "PATCH")) {
                    const imageId = decodeURIComponent(imageMatch[1]);
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const routed = new Request(url, { method: request.method, headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: new Uint8Array(Buffer.concat(chunks)) });
                    await relay(await detail[request.method](routed, { params: Promise.resolve({ id: imageId }) }), response);
                    return;
                }
                if (imageMatch && request.method === "GET") {
                    const imageId = decodeURIComponent(imageMatch[1]);
                    const copy1 = created.find((item) => item.requestId === copy1RequestId);
                    if (copy1?.taskId === imageId) firstPolled.resolve();
                    const result = await detail.GET(new Request(url, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ id: imageId }) });
                    await r03ProjectionRead.afterImageGet?.(imageId);
                    await relay(result, response);
                    return;
                }
                expect(request.method).toBe("GET");
                expect(url.pathname).toBe(`/api/agent/runs/${run.id}`);
                await relay(await runDetail.GET(new Request(url, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ id: run.id }) }), response);
            }

            const server = createServer((request, response) => {
                const running = handle(request, response)
                    .catch((error: unknown) => {
                        failure.reject(error);
                        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
                        response.end(JSON.stringify({ code: 500, data: null, msg: "Run copy Route fixture rejected the request" }));
                    })
                    .finally(() => active.delete(running));
                active.add(running);
            });
            let actionPromise: Promise<T> | undefined;
            let actionError: unknown;
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", () => {
                        server.off("error", reject);
                        resolve();
                    });
                });
                server.on("error", (error) => failure.reject(error));
                const address = server.address();
                assert.ok(address !== null && typeof address !== "string");
                origin = `http://127.0.0.1:${address.port}`;
                actionPromise = action(origin, created);
                return await Promise.race([actionPromise, failure.promise]);
            } catch (error) {
                actionError = error;
                throw error;
            } finally {
                firstPolled.resolve();
                server.closeAllConnections();
                if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                const settledAction = actionPromise?.then(
                    () => undefined,
                    () => undefined,
                );
                if (actionError || liveCancellation || liveCleanupUnconfirmed) {
                    try {
                        await drainLiveRequests(
                            Promise.all([
                                ...active,
                                ...(settledAction ? [settledAction] : []),
                                ...(liveCancellation
                                    ? [
                                          liveCancellation.then(
                                              () => undefined,
                                              () => undefined,
                                          ),
                                      ]
                                    : []),
                            ]),
                            "CLEANUP: image Route Handler/action did not drain after TCP close",
                        );
                    } catch (error) {
                        if (actionError) throw new AggregateError([actionError, error], "Run copy action failed and its image Route cleanup remains unconfirmed");
                        throw error;
                    }
                } else await Promise.all([...active, ...(settledAction ? [settledAction] : [])]);
            }
        }

        async function readChildIdentity(pid: number): Promise<ChildIdentity> {
            const text = await readFile("/proc/" + pid + "/stat", "utf8");
            const end = text.lastIndexOf(")");
            assert.ok(text.startsWith(pid + " (") && end > 0, "SETUP: malformed owned child proc stat");
            const fields = text
                .slice(end + 2)
                .trim()
                .split(/\s+/);
            const state = fields[0];
            const parent = fields[1];
            const startTime = fields[19];
            assert.ok(state && parent && startTime, "SETUP: incomplete owned child proc stat");
            return { pid, parentPid: Number(parent), startTime, state };
        }

        function assertSameChild(current: ChildIdentity, captured: ChildIdentity) {
            assert.equal(current.pid, captured.pid, "SETUP: child PID changed");
            assert.equal(current.parentPid, captured.parentPid, "SETUP: child parent changed");
            assert.equal(current.startTime, captured.startTime, "SETUP: child starttime changed");
        }

        async function processWithWorker(jobId: string): Promise<CompleteWorker>;
        async function processWithWorker(jobId: string, cancelRun: () => Promise<void>): Promise<CancelledWorker>;
        async function processWithWorker(jobId: string, cancelRun?: () => Promise<void>): Promise<CompleteWorker | CancelledWorker> {
            if (cancelRun) assert.equal(process.platform, "linux", "SETUP: live native-child cancellation requires Linux procfs");
            const [claimRoute, inputRoute, heartbeatRoute, outputRoute, completeRoute] = await Promise.all([
                import("@/app/api/maintenance/image-processing/claim/route"),
                import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route"),
                import("@/app/api/maintenance/image-processing/[id]/heartbeat/route"),
                import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
                import("@/app/api/maintenance/image-processing/[id]/complete/route"),
            ]);
            const workerScript = fileURLToPath(new URL("../../../scripts/generation-worker.mjs", import.meta.url));
            const runtimeChild = fileURLToPath(new URL("../../../.image-processing-runtime/workers/image-processing-child.mjs", import.meta.url));
            const runtimeLane = fileURLToPath(new URL("../../../.image-processing-runtime/workers/image-processing-lane.mjs", import.meta.url));
            assert.ok((await stat(runtimeChild)).isFile(), "SETUP: build the actual image runtime before the result mode cases");
            assert.ok((await stat(runtimeLane)).isFile());
            const workerTemp = await mkdtemp(path.join(directory, "worker-temp-"));
            const launcherWorkerId = "fixture-result-mode-worker-" + randomUUID();
            const imageWorkerId = `${launcherWorkerId}:image-processing`;
            const uploads: Array<{ stored: StoredImageProcessingArtifact; bytes: Buffer }> = [];
            const completed = Promise.withResolvers<{ child: ClaimedImageProcessingTask; completion: CompleteImageProcessingInput; receipt: Awaited<ReturnType<typeof service.completeImageProcessingTask>> }>();
            const cancelled = Promise.withResolvers<{ input: CancellationInput; receipt: CancellationReceipt }>();
            const childStopped = Promise.withResolvers<ChildIdentity>();
            const cancellationHeartbeat = Promise.withResolvers<void>();
            const childObserverStop = new AbortController();
            const terminalSeen = Promise.withResolvers<void>();
            const failure = Promise.withResolvers<never>();
            const requests = new Set<Promise<void>>();
            let child: ClaimedImageProcessingTask | undefined;
            let origin: string;
            let stdout = "";
            let stderr = "";
            let workerPid: number | undefined;
            let completionSaved = false;
            let childObserver: Promise<void> | undefined;
            let capturedChild: ChildIdentity | undefined;
            let pendingTermination: { sigPnd: string; shdPnd: string } | undefined;
            const terminalCalls = { uploads: 0, completes: 0, failures: 0 };
            let cancellationHeartbeats = 0;
            let cancellationAcknowledgements = 0;
            let liveAction: Promise<CancelledWorker> | undefined;

            async function captureChild() {
                assert.ok(workerPid && child, "SETUP: owned Worker and claim must precede native capture");
                const parentPid = workerPid;
                const heapMiB = child.payload.resource.configuration.processHeapMb;
                try {
                    for (;;) {
                        childObserverStop.signal.throwIfAborted();
                        const text = (await readFile("/proc/" + parentPid + "/task/" + parentPid + "/children", "utf8")).trim();
                        if (!text) continue;
                        const ids = text.split(/\s+/);
                        assert.equal(ids.length, 1, "SETUP: expected one owned native child");
                        const pid = Number(ids[0]);
                        assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== parentPid && pid !== process.pid, "SETUP: invalid owned native PID");
                        const captured = await readChildIdentity(pid);
                        assert.equal(captured.parentPid, parentPid, "SETUP: native child belongs to another parent");
                        const args = (await readFile("/proc/" + pid + "/cmdline", "utf8")).split("\0");
                        assert.equal(args.pop(), "");
                        // A fork briefly exposes the supervisor argv before exec starts the native runtime.
                        if (args.length === 3 && args[0] === process.execPath && args[1] === "--max-old-space-size=64" && args[2] === workerScript) {
                            assertSameChild(await readChildIdentity(pid), captured);
                            continue;
                        }
                        assert.deepEqual(args, [process.execPath, "--max-old-space-size=" + heapMiB, runtimeChild], "SETUP: child is not the compiled native runtime");
                        assertSameChild(await readChildIdentity(pid), captured);
                        capturedChild = captured;
                        process.kill(pid, "SIGSTOP");
                        for (;;) {
                            childObserverStop.signal.throwIfAborted();
                            const current = await readChildIdentity(pid);
                            assertSameChild(current, captured);
                            if (current.state === "T") {
                                childStopped.resolve(current);
                                return;
                            }
                            assert.notEqual(current.state, "Z", "SETUP: native child closed before the STOP barrier");
                        }
                    }
                } catch (error) {
                    if (childObserverStop.signal.aborted) return;
                    throw new Error("SETUP: could not capture and STOP this owned native child", { cause: error });
                }
            }

            async function resumeCancelledChild() {
                assert.ok(capturedChild);
                const captured = capturedChild;
                for (;;) {
                    childObserverStop.signal.throwIfAborted();
                    const current = await readChildIdentity(captured.pid);
                    assertSameChild(current, captured);
                    assert.equal(current.state, "T", "Native child left STOP before pending SIGTERM evidence");
                    const status = await readFile("/proc/" + captured.pid + "/status", "utf8");
                    const sigPnd = /^SigPnd:\s*([0-9a-f]+)$/im.exec(status)?.[1];
                    const shdPnd = /^ShdPnd:\s*([0-9a-f]+)$/im.exec(status)?.[1];
                    assert.ok(sigPnd && shdPnd, "SETUP: owned native pending signals unavailable");
                    const pending = BigInt("0x" + sigPnd) | BigInt("0x" + shdPnd);
                    if ((pending & (BigInt(1) << BigInt(constants.signals.SIGTERM - 1))) === BigInt(0)) continue;
                    assertSameChild(await readChildIdentity(captured.pid), captured);
                    pendingTermination = { sigPnd, shdPnd };
                    process.kill(captured.pid, "SIGCONT");
                    return pendingTermination;
                }
            }

            async function restoreOwnedChild() {
                if (!capturedChild) return;
                let current: ChildIdentity;
                try {
                    current = await readChildIdentity(capturedChild.pid);
                } catch (error) {
                    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
                    throw error;
                }
                assertSameChild(current, capturedChild);
                try {
                    process.kill(current.pid, "SIGCONT");
                } catch (error) {
                    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
                    throw error;
                }
            }

            async function requestBytes(request: IncomingMessage) {
                const chunks: Buffer[] = [];
                for await (const chunk of request) {
                    assert.ok(Buffer.isBuffer(chunk));
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks);
            }

            async function relay(result: Response, response: ServerResponse) {
                const bytes = Buffer.from(await result.arrayBuffer());
                for (const [name, value] of result.headers) response.setHeader(name, value);
                response.writeHead(result.status);
                response.end(bytes);
            }

            async function bounded<T>(pending: Promise<T>, milliseconds: number, message: string): Promise<T> {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    return await Promise.race([
                        pending,
                        new Promise<never>((_resolve, reject) => {
                            timer = setTimeout(() => reject(new Error(message + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr)), milliseconds);
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                }
            }

            async function handle(request: IncomingMessage, response: ServerResponse) {
                assert.ok(request.url);
                const url = new URL(request.url, origin);
                const authorization = request.headers.authorization;
                assert.ok(typeof authorization === "string");
                expect(authorization).toBe("Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN);
                if (["/api/maintenance/generation-tasks/run", "/api/maintenance/billing-refunds/run", "/api/maintenance/generation-tasks/heartbeat"].includes(url.pathname)) {
                    expect(request.method).toBe("POST");
                    await requestBytes(request);
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(JSON.stringify({ code: 0, data: { claimed: 0 }, msg: "OK" }));
                    return;
                }
                if (url.pathname === "/api/maintenance/image-processing/claim") {
                    expect(request.method).toBe("POST");
                    const text = (await requestBytes(request)).toString("utf8");
                    if (cancelRun) expect(JSON.parse(text)).toMatchObject({ workerId: imageWorkerId });
                    const result = await claimRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }));
                    expect(result.status).toBe(200);
                    const envelope: { code: number; data: { tasks: ClaimedImageProcessingTask[] } } = await result.clone().json();
                    expect(envelope.code).toBe(0);
                    if (child) {
                        expect(completionSaved).toBe(true);
                        expect(envelope.data.tasks).toStrictEqual([]);
                        if (cancelRun) {
                            const claim: { availableMemoryBytes: number; slots: number } = JSON.parse(text);
                            expect(claim).toMatchObject({ availableMemoryBytes: 6144 * 1024 * 1024, slots: 1 });
                            expect(await readdir(workerTemp)).toStrictEqual([]);
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", jobId)).toMatchObject({ status: "cancelled", executionPhase: "completed" });
                        }
                        await relay(result, response);
                        terminalSeen.resolve();
                        return;
                    }
                    expect(envelope.data.tasks).toHaveLength(1);
                    child = envelope.data.tasks[0];
                    assert.ok(child);
                    expect(child.id).toBe(jobId);
                    await relay(result, response);
                    return;
                }
                assert.ok(child);
                const endpoint = `/api/maintenance/image-processing/${encodeURIComponent(jobId)}`;
                if (url.pathname.startsWith(endpoint + "/inputs/")) {
                    expect(request.method).toBe("GET");
                    const assetId = decodeURIComponent(url.pathname.slice((endpoint + "/inputs/").length));
                    const transportWorker = request.headers["x-vozeb-pro-worker-id"];
                    const executionId = request.headers["x-vozeb-pro-execution-id"];
                    assert.ok(typeof transportWorker === "string" && typeof executionId === "string");
                    expect(executionId).toBe(child.executionId);
                    if (cancelRun) expect(transportWorker).toBe(imageWorkerId);
                    const result = await inputRoute.GET(new Request(url, { headers: { authorization, "x-vozeb-pro-worker-id": transportWorker, "x-vozeb-pro-execution-id": executionId } }), { params: Promise.resolve({ id: jobId, assetId }) });
                    expect(result.status).toBe(200);
                    if (cancelRun) {
                        assert.equal(childObserver, undefined, "SETUP: live copy must have one frozen native input");
                        childObserver = captureChild().catch((error: unknown) => failure.reject(error));
                    }
                    await relay(result, response);
                    return;
                }
                if (url.pathname === endpoint + "/outputs/final") {
                    terminalCalls.uploads += 1;
                    if (cancelRun) throw new Error("Live native abort unexpectedly reached output upload");
                    expect(request.method).toBe("PUT");
                    const transportWorker = request.headers["x-vozeb-pro-worker-id"];
                    const executionId = request.headers["x-vozeb-pro-execution-id"];
                    const mimeType = request.headers["content-type"];
                    assert.ok(typeof transportWorker === "string" && typeof executionId === "string" && typeof mimeType === "string");
                    expect(executionId).toBe(child.executionId);
                    const bytes = await requestBytes(request);
                    const result = await outputRoute.PUT(
                        new Request(url, { method: "PUT", headers: { authorization, "content-type": mimeType, "x-vozeb-pro-worker-id": transportWorker, "x-vozeb-pro-execution-id": executionId }, body: new Uint8Array(bytes) }),
                        { params: Promise.resolve({ id: jobId, kind: "final" }) },
                    );
                    expect(result.status).toBe(201);
                    const envelope: { code: number; data: StoredImageProcessingArtifact } = await result.clone().json();
                    expect(envelope.code).toBe(0);
                    expect(envelope.data).toMatchObject({ sha256: digest(bytes), bytes: bytes.length, resultId: url.searchParams.get("resultId") });
                    uploads.push({ stored: envelope.data, bytes });
                    await relay(result, response);
                    return;
                }
                const text = (await requestBytes(request)).toString("utf8");
                const routeRequest = new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text });
                if (url.pathname === endpoint + "/heartbeat") {
                    const result = await heartbeatRoute.POST(routeRequest, { params: Promise.resolve({ id: jobId }) });
                    expect(result.status).toBe(200);
                    if (cancelRun) {
                        const body: Record<string, unknown> = JSON.parse(text);
                        if (Object.hasOwn(body, "closed")) {
                            cancellationAcknowledgements += 1;
                            expect(cancellationAcknowledgements).toBe(1);
                            const captured = capturedChild;
                            assert.ok(captured && pendingTermination);
                            const input: CancellationInput = JSON.parse(text);
                            expect(input).toMatchObject({ workerId: imageWorkerId, executionId: child.executionId, closed: { jobId, executionId: child.executionId, pid: captured.pid, status: "aborted" }, stopCause: "cancel_requested" });
                            expect(() => process.kill(captured.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
                            const receipt: { code: number; data: CancellationReceipt; msg: string } = await result.clone().json();
                            expect(receipt).toStrictEqual({ code: 0, data: { jobId, executionId: child.executionId, status: "cancelled", executionPhase: "completed" }, msg: "OK" });
                            completionSaved = true;
                            await relay(result, response);
                            cancelled.resolve({ input, receipt: receipt.data });
                            return;
                        }
                        expect(body).toStrictEqual({ workerId: imageWorkerId, executionId: child.executionId });
                        const renewal: { data: { cancelRequested: boolean } } = await result.clone().json();
                        if (renewal.data.cancelRequested) {
                            cancellationHeartbeats += 1;
                            expect(cancellationHeartbeats).toBe(1);
                            cancellationHeartbeat.resolve();
                        }
                    }
                    await relay(result, response);
                    return;
                }
                if (url.pathname === endpoint + "/fail") terminalCalls.failures += 1;
                expect(url.pathname).toBe(endpoint + "/complete");
                terminalCalls.completes += 1;
                if (cancelRun) throw new Error("Live native abort unexpectedly reached completion");
                expect(request.method).toBe("POST");
                const result = await completeRoute.POST(routeRequest, { params: Promise.resolve({ id: jobId }) });
                expect(result.status).toBe(200);
                // The actual Route validates this Worker DTO before the test reads its typed fields.
                const completion: CompleteImageProcessingInput = JSON.parse(text);
                expect(completion.executionId).toBe(child.executionId);
                expect(completion.metrics.pid).toBeGreaterThan(0);
                expect(completion.metrics.pid).not.toBe(workerPid);
                expect(completion.metrics.pid).not.toBe(process.pid);
                expect(() => process.kill(completion.metrics.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
                expect(completion.metrics.peakRssBytes).toBeGreaterThan(0);
                expect(completion.metrics.peakHeapUsedBytes).toBeGreaterThan(0);
                expect(completion.metrics.peakExternalBytes).toBeGreaterThan(0);
                const envelope: { code: number; data: Awaited<ReturnType<typeof service.completeImageProcessingTask>> } = await result.clone().json();
                expect(envelope.code).toBe(0);
                completionSaved = true;
                await relay(result, response);
                completed.resolve({ child, completion, receipt: envelope.data });
            }

            const server = createServer((request, response) => {
                const running = handle(request, response)
                    .catch((error: unknown) => {
                        failure.reject(error);
                        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
                        response.end(JSON.stringify({ code: 500, data: null, msg: "Result mode TCP fixture rejected the request" }));
                    })
                    .finally(() => requests.delete(running));
                requests.add(running);
            });
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", () => {
                        server.off("error", reject);
                        resolve();
                    });
                });
                server.on("error", (error) => failure.reject(error));
                const address = server.address();
                assert.ok(address !== null && typeof address !== "string");
                origin = `http://127.0.0.1:${address.port}`;
                const worker = spawn(process.execPath, ["--max-old-space-size=64", workerScript], {
                    cwd: path.dirname(path.dirname(workerScript)),
                    env: {
                        // Match the supervisor's runtime boundary; database credentials stay in this Web/Route process.
                        NODE_ENV: "production",
                        UV_THREADPOOL_SIZE: "2",
                        SystemRoot: process.env.SystemRoot,
                        WINDIR: process.env.WINDIR,
                        LANG: process.env.LANG,
                        LC_ALL: process.env.LC_ALL,
                        TZ: process.env.TZ,
                        TMPDIR: workerTemp,
                        TMP: workerTemp,
                        TEMP: workerTemp,
                        ...resourceEnvironment,
                        VOZEB_PRO_WORKER_TOKEN: workerToken,
                        VOZEB_PRO_WORKER_API_ORIGIN: origin,
                        VOZEB_PRO_GENERATION_WORKER_ID: launcherWorkerId,
                        VOZEB_PRO_GENERATION_WORKER_LANES: "1",
                        VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS: "5000",
                    },
                    stdio: "pipe",
                });
                const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
                    worker.once("error", reject);
                    worker.once("close", (code, signal) => resolve({ code, signal }));
                });
                workerPid = worker.pid;
                worker.stdin.end();
                worker.stdout.setEncoding("utf8");
                worker.stderr.setEncoding("utf8");
                worker.stdout.on("data", (chunk: string) => {
                    stdout += chunk;
                });
                worker.stderr.on("data", (chunk: string) => {
                    stderr += chunk;
                    failure.reject(new Error("Actual result Worker reported an error: " + stderr));
                });
                let scenarioError: unknown;
                try {
                    assert.ok(workerPid);
                    if (cancelRun) {
                        const unexpectedExit = closed.then((exit) => {
                            throw new Error("Actual live-copy Worker exited before cancellation: " + JSON.stringify(exit));
                        });
                        const wait = <T>(event: Promise<T>, milliseconds: number, message: string) => bounded(Promise.race([event, failure.promise, unexpectedExit]), milliseconds, message);
                        liveAction = (async (): Promise<CancelledWorker> => {
                            const captured = await wait(childStopped.promise, 30_000, "SETUP: actual native child was not held in state T");
                            expect(captured.state).toBe("T");
                            const held = await readChildIdentity(captured.pid);
                            assertSameChild(held, captured);
                            expect(held.state).toBe("T");
                            assert.ok(child);
                            const identity = { workerId: imageWorkerId, executionId: child.executionId };
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", jobId)).toMatchObject({ status: "running", workerId: imageWorkerId, executionPhase: "created", payload: { executionId: child.executionId } });
                            const accountBefore = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                            liveCancellation = cancelRun();
                            await wait(liveCancellation, 35_000, "Actual Run cancellation did not finish while the owned native child was stopped");
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", jobId)).toMatchObject({
                                status: "cancelled",
                                executionPhase: "cancel_requested",
                                workerId: imageWorkerId,
                                leaseUntil: expect.any(Number),
                                payload: { executionId: child.executionId },
                            });
                            await wait(cancellationHeartbeat.promise, 35_000, "Actual heartbeat did not report cancellation of the held native child");
                            const pending = await wait(resumeCancelledChild(), 10_000, "Actual SIGTERM was not pending on the same held native child");
                            const [observation] = await wait(Promise.all([cancelled.promise, terminalSeen.promise]), 10_000, "Actual native close/ACK did not return the full budget after TMP drain");
                            expect(terminalCalls).toStrictEqual({ uploads: 0, completes: 0, failures: 0 });
                            expect(cancellationHeartbeats).toBe(1);
                            expect(cancellationAcknowledgements).toBe(1);
                            const settled = await tasks.getStoredGenerationTaskRecord("image_processing", jobId);
                            expect(settled).toMatchObject({ status: "cancelled", executionPhase: "completed", resultPayload: { executionId: child.executionId, cancelClose: { ...observation.input, receipt: observation.receipt } } });
                            expect(settled?.workerId).toBeUndefined();
                            expect(settled?.leaseUntil).toBeUndefined();
                            const replay = await heartbeatRoute.POST(
                                new Request(`${origin}/api/maintenance/image-processing/${jobId}/heartbeat`, {
                                    method: "POST",
                                    headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" },
                                    body: JSON.stringify(observation.input),
                                }),
                                { params: Promise.resolve({ id: jobId }) },
                            );
                            expect(replay.status).toBe(200);
                            expect(await replay.json()).toStrictEqual({ code: 0, data: observation.receipt, msg: "OK" });
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", jobId)).toStrictEqual(settled);
                            expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(accountBefore);
                            expect(identity).toStrictEqual({ workerId: observation.input.workerId, executionId: observation.input.executionId });
                            return { child, captured, pending, ...observation };
                        })();
                        return await wait(liveAction, 30_000 + 35_000 + 35_000 + 10_000 + 10_000, "Live native lifecycle did not reach its validated ACK/replay before the bounded action deadline");
                    }
                    const [observed] = await bounded(
                        Promise.race([
                            Promise.all([completed.promise, terminalSeen.promise]),
                            failure.promise,
                            closed.then((exit) => {
                                throw new Error("Actual result Worker exited before completion: " + JSON.stringify(exit));
                            }),
                        ]),
                        30_000,
                        "Actual result Worker did not complete its claimed task",
                    );
                    return { ...observed, uploads };
                } catch (error) {
                    scenarioError = error;
                    throw error;
                } finally {
                    try {
                        childObserverStop.abort();
                        await childObserver;
                        let childCleanupError: unknown;
                        try {
                            await restoreOwnedChild();
                        } catch (error) {
                            childCleanupError = error;
                            if (cancelRun) liveCleanupUnconfirmed = true;
                        }
                        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
                        let workerCleanupError: unknown;
                        try {
                            expect(await bounded(closed, 15_000, "Actual result Worker did not drain on SIGTERM")).toStrictEqual({ code: 0, signal: null });
                        } catch (error) {
                            if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
                            if (cancelRun) {
                                workerCleanupError = error;
                                try {
                                    await bounded(closed, 15_000, "CLEANUP: live Worker did not close after forced termination");
                                } catch (closeError) {
                                    liveCleanupUnconfirmed = true;
                                    throw new AggregateError([error, closeError], "Live Worker close remains unconfirmed");
                                }
                            } else {
                                await closed;
                                throw error;
                            }
                        }
                        if (cancelRun) {
                            server.closeAllConnections();
                            await drainLiveRequests(
                                Promise.all([
                                    ...requests,
                                    ...(liveAction
                                        ? [
                                              liveAction.then(
                                                  () => undefined,
                                                  () => undefined,
                                              ),
                                          ]
                                        : []),
                                    ...(liveCancellation
                                        ? [
                                              liveCancellation.then(
                                                  () => undefined,
                                                  () => undefined,
                                              ),
                                          ]
                                        : []),
                                ]),
                                "CLEANUP: live maintenance/action/cancel Handler did not drain after TCP close",
                            );
                        } else await Promise.all([...requests]);
                        expect(stderr).toBe("");
                        expect(await readdir(workerTemp)).toStrictEqual([]);
                        if (workerCleanupError) throw workerCleanupError;
                        if (childCleanupError) {
                            throw childCleanupError;
                        }
                    } catch (cleanupError) {
                        if (cancelRun && scenarioError) throw new AggregateError([scenarioError, cleanupError], "Live cancellation failed and cleanup reported another failure");
                        throw cleanupError;
                    }
                }
            } finally {
                server.closeAllConnections();
                if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            }
        }

        async function prepareNativeCopy(imageId: string, native: Buffer, origin: string) {
            const original = await imageTasks.getImageTask(imageId);
            assert.ok(original);
            const claim = (await scheduler.claimDueGenerationTasks({ workerId: `fixture-original-image-${imageId}`, taskIds: [imageId], limit: 1 }))[0];
            assert.ok(claim, "SETUP: actual image scheduler must own the original copy");
            assert.ok(typeof claim.payload.executionId === "string");
            expect(await runtime.createImageTaskUpstreamStep(original, origin, origin, boundary.cookie)).toMatchObject({ state: "pending", upstream: { id: `fixture-upstream-${imageId}` } });
            const submitted = await imageTasks.getImageTask(imageId);
            assert.ok(submitted);
            expect(submitted.attempts).toHaveLength(1);
            const originalAttempt = submitted.attempts?.[0];
            assert.ok(originalAttempt);
            expect(submitted.attemptNo).toBe(1);
            expect(submitted.executionId).toBe(claim.payload.executionId);
            const charge = charges.get(imageId);
            assert.ok(charge);
            expect(submitted.billing).toMatchObject({ pointsCost: charge.cost, pointsRecordId: charge.recordId, refunded: false });
            providerResults.set(`fixture-upstream-${imageId}`, { dataUrl: dataUrl(native), results: [{ dataUrl: dataUrl(native) }] });
            const step = await runtime.queryImageTaskUpstreamStep(submitted, origin, boundary.cookie);
            expect(step).toMatchObject({ state: "result_ready" });
            assert.ok(step.state === "result_ready");
            const requested = await imageTasks.getImageTask(imageId);
            assert.ok(requested);
            return { submitted, originalAttempt, charge, requested, resultUrl: step.resultUrl, claim };
        }

        async function waitForCopy(imageId: string, native: Buffer, origin: string) {
            const { submitted, originalAttempt, charge, requested, resultUrl, claim } = await prepareNativeCopy(imageId, native, origin);
            // First product-behavior assertion: v297 instead takes the Run legacy Web path.
            expect(await runtime.persistImageTaskResult(requested, origin, resultUrl, boundary.cookie), "RED: a real dispatched Run copy must wait for its result Worker").toMatchObject({
                status: "running",
                resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) },
            });
            const waiting = await imageTasks.getImageTask(imageId);
            assert.ok(waiting?.nativeResults && waiting.resultProcessing);
            expect(waiting.result).toBeUndefined();
            expect(waiting.nativeResults.slots).toMatchObject([{ resultId: `${imageId}:1`, resultIndex: 1, status: "stored" }]);
            const nativeSlot = waiting.nativeResults.slots[0];
            assert.ok(nativeSlot.status === "stored");
            const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
            const nativePath = path.join(REFERENCE_MEDIA_ROOT, nativeSlot.storageKey);
            const nativeBytes = await readFile(nativePath);
            expect(nativeBytes).toEqual(native);
            expect(digest(nativeBytes)).toBe(nativeSlot.sha256);
            expect(nativeBytes).toHaveLength(nativeSlot.bytes);
            const nativeRegistration = await registrations.getLocalMediaRegistration(nativeSlot.storageKey);
            expect(nativeRegistration).toMatchObject({ ownerUserId: userId, taskId: imageId, type: "attachment", source: "image-task-native-result" });
            expect(nativeRegistration?.runId).toBeUndefined();
            const waitingRecord = await tasks.getStoredGenerationTaskRecord("image", imageId);
            assert.ok(waitingRecord);
            expect(waitingRecord).toMatchObject({ status: "running", executionPhase: "persisting", parentTaskId: waiting.runId, runId: waiting.runId });
            expect(waitingRecord.workerId).toBeUndefined();
            expect(waitingRecord.leaseUntil).toBeUndefined();
            assert.ok(typeof claim.payload.executionId === "string");
            expect(await processing.ensureImageTaskResultProcessing({ taskId: imageId, workerId: `fixture-original-image-${imageId}`, executionId: claim.payload.executionId })).toStrictEqual({ state: "ownership_lost" });
            const publicResponse = await fetch(`${origin}/api/image-tasks/${imageId}`, { headers: { cookie: boundary.cookie } });
            expect(publicResponse.status).toBe(200);
            const publicText = await publicResponse.text();
            expect(JSON.parse(publicText)).toMatchObject({ task: { id: imageId, status: "running", executionPhase: "persisting" } });
            expect(publicText).not.toContain(dataUrl(native));
            return { submitted, originalAttempt, charge, waiting, native, nativePath };
        }

        async function completeCopy(
            prepared: Awaited<ReturnType<typeof waitForCopy>>,
            run: AgentRun,
            origin: string,
            logicalAttempt = 1,
            expected: { size: { width: number; height: number }; options: { targetSize?: { width: number; height: number } } } = { size: { width: 12, height: 8 }, options: { targetSize: { width: 1024, height: 1024 } } },
        ) {
            const { waiting, charge, native } = prepared;
            assert.ok(waiting.resultProcessing && waiting.nativeResults);
            const worker = await processWithWorker(waiting.resultProcessing.jobId);
            const job = await tasks.getStoredGenerationTaskRecord("image_processing", worker.child.id);
            assert.ok(job);
            expect(job).toMatchObject({ status: "success", executionPhase: "completed", parentTaskId: waiting.id, runId: run.id, userId });
            expect(job.attemptNo).toBe(0);
            expect(job.clientRequestId).toBe(waiting.resultProcessing.inputDigest);
            const payload = worker.child.payload;
            assert.ok(payload.operation === "process_result");
            expect(payload.options).toMatchObject({ mode: "ordinary", results: [{ resultId: `${waiting.id}:1`, resultIndex: 1, inputIndex: 0 }], ...expected.options, transparentBackground: false });
            expect(payload.inputs).toHaveLength(1);
            expect(payload.resource.facts.decodedInputs).toStrictEqual([]);
            expect(payload.imageResultBinding).toMatchObject({ imageTaskId: waiting.id, userId, nativeResults: waiting.nativeResults });
            expect(worker.receipt).toMatchObject({ jobId: job.id, inputDigest: payload.inputDigest, executionId: worker.child.executionId, manifest: worker.completion.manifest, parentRescheduled: true });
            expect(worker.completion.manifest.results).toMatchObject([{ resultId: `${waiting.id}:1`, resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 }]);
            expect(worker.completion.manifest.artifacts).toHaveLength(1);
            expect(worker.uploads).toHaveLength(1);
            const final = worker.completion.manifest.artifacts[0];
            expect(final).toMatchObject({ kind: "final", resultId: `${waiting.id}:1`, resultIndex: 1, ...expected.size, mimeType: "image/png" });
            expect(worker.uploads[0].stored).toStrictEqual(final);
            expect(worker.uploads[0].bytes).toEqual(native);
            expect(final.sha256).toBe(digest(native));
            const saved = await references.readReferenceAsset(final.storageKey);
            assert.ok(saved);
            expect(await readFile(saved.filePath)).toEqual(native);
            const temporary = await registrations.getLocalMediaRegistration(final.storageKey);
            expect(temporary).toMatchObject({ storageKey: final.storageKey, ownerUserId: userId, taskId: job.id, runId: run.id, storageClass: "temporary", storageProvider: "local" });
            const beforeConsumption = await runs.getAgentRun(run.id);
            expect(beforeConsumption).toMatchObject({ status: "running", tasks: [{ status: "running", childTasks: expect.arrayContaining([{ id: waiting.id, status: "pending", attempt: logicalAttempt }]) }] });
            const authBefore = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
            const recoveryInput = { origin, cookie: boundary.cookie, workerId: `fixture-consumer-${waiting.id}`, taskIds: [waiting.id], limit: 1 };
            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
            const published = await imageTasks.getImageTask(waiting.id);
            assert.ok(published?.result?.results);
            expect(published).toMatchObject({
                id: waiting.id,
                runId: run.id,
                parentTaskId: run.id,
                conversationId: run.conversationId,
                clientRequestId: waiting.clientRequestId,
                status: "success",
                nativeResults: waiting.nativeResults,
                resultProcessing: waiting.resultProcessing,
                billing: { pointsCost: charge.cost, pointsRecordId: charge.recordId, refunded: false },
            });
            expect(published.generationLogId).toBeUndefined();
            expect(published.generationSlotId).toBeUndefined();
            expect(published.attemptNo).toBe(1);
            expect(published.attempts).toStrictEqual([{ ...prepared.originalAttempt, status: "succeeded", completedAt: expect.any(Number), pointsCost: charge.cost, pointsRecordId: charge.recordId }]);
            expect(published.result.results).toMatchObject([{ resultId: `${waiting.id}:1`, ...expected.size, serverUrl: `/api/reference-assets/${final.storageKey.split("/").map(encodeURIComponent).join("/")}` }]);
            const promoted = await registrations.getLocalMediaRegistration(final.storageKey);
            expect(promoted).toMatchObject({ storageKey: final.storageKey, ownerUserId: userId, taskId: job.id, runId: run.id, storageClass: "permanent", storageProvider: "local" });
            expect(promoted?.expiresAt).toBeUndefined();
            expect(await readFile(prepared.nativePath)).toEqual(native);
            if (provider === "file") {
                expect(await readFile(path.join(directory, "auth.json"))).toEqual(authBefore);
            } else expect(await postgresAccountSnapshot()).toStrictEqual(authBefore);
            const log = (await logs.listGenerationLogs({ userId })).items.find((item) => item.taskId === waiting.id);
            expect(log).toMatchObject({ id: `image-task:${waiting.id}`, taskId: waiting.id, userId, status: "success", count: 1, successCount: 1, failCount: 0, assets: [expected.size] });
            const asset = (await creative.listAssetsForUser(userId, run.conversationId)).find((item) => item.sourceTaskId === waiting.id);
            assert.ok(asset);
            expect(asset).toMatchObject({ userId, conversationId: run.conversationId, sourceRunId: run.id, sourceTaskId: waiting.id, ordinal: 0, status: "ready", serverUrl: published.result.results[0].serverUrl });
            expect(asset.messageId).toBeUndefined();
            return { worker, job, final, published, asset, recoveryInput };
        }

        async function withDispatchedCopies<T>(
            logicalAttempt: number,
            action: (run: AgentRun, task: AgentRunTask, executorId: string, origin: string, copies: Array<{ requestId: string; taskId: string }>) => Promise<T>,
            beforeFirstPostResponse?: (run: AgentRun, task: AgentRunTask, imageId: string, origin: string) => Promise<void>,
        ) {
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Run copy gate fixture" });
            const initial = (
                await runs.createAgentRun(userId, { clientRequestId: `fixture-run-copy-gate-${randomUUID()}`, conversationId: conversation.id, surface: "chat", prompt: "Generate two ordinary images", assetIds: [], skillIds: [], modelIds: [] })
            ).run;
            const task: AgentRunTask = {
                id: "declared-gated-copy-image",
                type: "image",
                title: "Two original copies",
                model: imageModelId,
                prompt: "Generate an ordinary image",
                count: 2,
                ratio: "1024x1024",
                quality: "low",
                dependencies: [],
                status: "ready",
                attempts: logicalAttempt - 1,
            };
            const executorId = "fixture-gated-agent-executor";
            const run = await runs.updateAgentRunById(initial.id, { status: "running", executionId: executorId, tasks: [task], reviewed: true });
            assert.ok(run);
            return withImageRoutes(
                run,
                task,
                async (origin, copies) => {
                    expect(await execution.runTaskWithRetry(run.id, task, origin, boundary.cookie, executorId)).toBe("deferred");
                    expect(copies).toHaveLength(2);
                    return action(run, task, executorId, origin, copies);
                },
                (imageId, origin) => beforeFirstPostResponse?.(run, task, imageId, origin) ?? Promise.resolve(),
            );
        }

        async function claimR03Child(jobId: string) {
            const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
            const configured = imageProcessingResourceConfig(process.env);
            const workerId = `fixture-r03-worker-${randomUUID()}`;
            const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const child = claimed.tasks[0];
            assert.ok(child);
            expect(child.id).toBe(jobId);
            return { child, workerId };
        }

        async function pauseR03Child(jobId: string) {
            const { child, workerId } = await claimR03Child(jobId);
            expect(
                await service.failImageProcessingTask(jobId, {
                    workerId,
                    executionId: child.executionId,
                    failure: { status: "resource_failure", jobId, executionId: child.executionId, pid: 4321, exitCode: 134, signal: null, stderr: "controlled R03 closed resource report", reason: "v8_heap_oom" },
                }),
            ).toStrictEqual({ jobId, status: "paused", executionPhase: "needs_review" });
            return child;
        }

        async function rejectR03Child(jobId: string) {
            const { child, workerId } = await claimR03Child(jobId);
            expect(
                await service.failImageProcessingTask(jobId, {
                    workerId,
                    executionId: child.executionId,
                    failure: {
                        status: "rejected",
                        jobId,
                        executionId: child.executionId,
                        pid: 4321,
                        exitCode: 1,
                        signal: null,
                        stderr: "controlled R03 closed rejection report",
                        error: { code: "image_decode_failed", message: "Controlled result decoding rejection" },
                    },
                }),
            ).toStrictEqual({ jobId, status: "error", executionPhase: "needs_review" });
            return child;
        }

        async function r03Receipts(runId: string) {
            const runtimeStore = await import("./creative-runtime-store");
            return (await runtimeStore.listCreativeRunEvents(runId)).filter((event) => Boolean((event.data as { imageProcessingProjectionKey?: string } | undefined)?.imageProcessingProjectionKey));
        }

        async function r03Get(runId: string, origin: string) {
            const detail = await import("@/app/api/agent/runs/[id]/route");
            return detail.GET(new Request(`${origin}/api/agent/runs/${runId}`, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ id: runId }) });
        }

        async function requestRunCancellation(run: AgentRun, origin: string) {
            const action = await import("@/app/api/agent/runs/[id]/[action]/route");
            const response = await action.POST(
                new Request(`${origin}/api/agent/runs/${run.id}/cancel`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ conversationId: run.conversationId }) }),
                { params: Promise.resolve({ id: run.id, action: "cancel" }) },
            );
            expect(response.status, "The actual Agent cancel action must include both result jobs").toBe(200);
            expect(await response.json()).toMatchObject({ code: 0, data: { run: { id: run.id, status: "cancelled" } } });
        }

        async function stageClosedCopy(prepared: Awaited<ReturnType<typeof waitForCopy>>) {
            assert.ok(prepared.waiting.resultProcessing);
            const record = await tasks.getStoredGenerationTaskRecord("image_processing", prepared.waiting.resultProcessing.jobId);
            assert.ok(record);
            const workerId = "fixture-run-copy-cancel-worker";
            const resource = record.payload.resource;
            assert.ok(resource && typeof resource === "object" && "profileVersion" in resource && typeof resource.profileVersion === "string");
            const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const child = claimed.tasks[0];
            expect(child.id).toBe(record.id);
            const payload = child.payload;
            assert.ok(payload.operation === "process_result");
            const identity = { workerId, executionId: child.executionId };
            const inputRoute = await import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");
            const response = await inputRoute.GET(
                new Request(`http://localhost/api/maintenance/image-processing/${child.id}/inputs/${payload.inputs[0].assetId}`, {
                    headers: { authorization: `Bearer ${workerToken}`, "x-vozeb-pro-worker-id": workerId, "x-vozeb-pro-execution-id": child.executionId },
                }),
                { params: Promise.resolve({ id: child.id, assetId: payload.inputs[0].assetId }) },
            );
            expect(response.status).toBe(200);
            const native = Buffer.from(await response.arrayBuffer());
            expect(native).toEqual(prepared.native);
            const taskDirectory = await mkdtemp(path.join(directory, "run-copy-closed-"));
            const filename = path.join(taskDirectory, "native.png");
            await writeFile(filename, native);
            const outputDirectory = await mkdtemp(path.join(taskDirectory, "output-"));
            const closed = await runImageProcessing(
                { version: "image-processing.v1", operation: "process_result", options: payload.options, jobId: child.id, executionId: child.executionId, inputs: [{ ...payload.inputs[0], path: filename }], outputDirectory },
                { taskDirectory, maxHeapMiB: payload.resource.configuration.processHeapMb },
            );
            expect(closed).toMatchObject({ status: "completed", jobId: child.id, executionId: child.executionId, exitCode: 0, signal: null });
            assert.ok(closed.status === "completed" && closed.pid);
            const pid = closed.pid;
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            const artifact = closed.result.artifacts[0];
            const bytes = await readFile(artifact.path);
            const stored = await service.writeImageProcessingOutput(child.id, "final", identity, { mimeType: artifact.mimeType, resultId: artifact.resultId, stream: new Response(new Uint8Array(bytes)).body! });
            const { metrics, ...manifest } = closed.result;
            const completion: CompleteImageProcessingInput = { ...identity, manifest: { ...manifest, artifacts: [stored] }, metrics };
            const report = { jobId: child.id, executionId: child.executionId, status: "completed" as const, pid, exitCode: closed.exitCode, signal: closed.signal, stderr: closed.stderr };
            return { child, identity, closed: report, completion, bytes, stored };
        }

        async function configureSceneRoute() {
            const upstreamModel = "gpt-image-2.5-flare";
            const { normalizeSystemChannelAdvancedConfig } = await import("@/lib/auth/store-normalizers");
            const advancedConfig = normalizeSystemChannelAdvancedConfig({ protocol: "openai", editPath: "/images/edits", referenceRule: "multipart", supportsReferenceImage: true });
            assert.ok(advancedConfig, "SETUP: the project normalizer must retain the supported scene edit configuration");
            const before = await auth.getFreshAuthSettings();
            const original = before.logicalModels.find((model) => model.id === imageModelId);
            assert.ok(original && original.bindings.length === 1);
            const channelId = original.bindings[0].channelId;
            const logicalModels = before.logicalModels.map((model) => (model.id === imageModelId ? { ...model, bindings: model.bindings.map((binding) => ({ ...binding, upstreamModel })) } : model));
            if (provider === "file") {
                await auth.setAuthSettings({
                    systemChannels: before.systemChannels.map((channel) => (channel.id === channelId ? { ...channel, models: [upstreamModel], advancedConfig } : channel)),
                    logicalModels,
                });
            } else {
                const fixture = pgFixture;
                assert.ok(fixture);
                expect(channelId).toBe(fixture.channelId);
                fixture.installed = await database.withPostgresTransaction(async (executor) => {
                    const repositories = database.createPostgresRepositories(executor);
                    await repositories.settings.lock();
                    expect(await readSettings(executor), "SETUP: owned settings changed before scene profile installation").toStrictEqual(fixture.installed);
                    const channel = await repositories.settings.getSystemModelChannelById(channelId);
                    assert.ok(channel);
                    expect(channel).toMatchObject({ id: fixture.channelId, apiKeyCiphertext: fixture.channelCiphertext, models: [original.bindings[0].upstreamModel] });
                    await repositories.settings.upsertSystemModelChannel({ ...channel, models: [upstreamModel], advancedConfig });
                    await writeSettings(executor, { ...fixture.installed, logical_models: logicalModels });
                    return readSettings(executor);
                });
            }
            const configured = await auth.getFreshAuthSettings();
            const logical = configured.logicalModels.find((model) => model.bindings.some((binding) => binding.channelId === channelId && binding.upstreamModel === upstreamModel && binding.enabled));
            assert.ok(logical, "SETUP: normalized settings must retain the owned supported scene route");
            imageModelId = logical.id;
            if (provider === "file") {
                await auth.setAuthSettings({ defaultModels: { ...configured.defaultModels, imageModel: imageModelId }, modelPointCosts: { ...configured.modelPointCosts, [imageModelId]: 2 } });
            } else {
                const fixture = pgFixture;
                assert.ok(fixture);
                fixture.installed = await database.withPostgresTransaction(async (executor) => {
                    await database.createPostgresRepositories(executor).settings.lock();
                    expect(await readSettings(executor), "SETUP: owned settings changed before scene pricing").toStrictEqual(fixture.installed);
                    await writeSettings(executor, { ...fixture.installed, default_models: { ...configured.defaultModels, imageModel: imageModelId }, model_point_costs: { ...configured.modelPointCosts, [imageModelId]: 2 } });
                    return readSettings(executor);
                });
            }
            const { resolveEcommerceRoleCandidates, routeEcommerceRole } = await import("./ecommerce-model-routing");
            const settings = await auth.getFreshAuthSettings();
            const candidate = resolveEcommerceRoleCandidates(settings, "image_generation", "image").find((route) => route.channelId === channelId && route.upstreamModel === upstreamModel);
            assert.ok(candidate, "SETUP: real routing must resolve the owned scene model");
            expect(candidate.snapshot).toMatchObject({ logicalModelId: imageModelId, channelId, upstreamModel, apiFormat: "openai", imageEdit: { protocol: "openai", editPath: "/images/edits", transport: "multipart", supportsIndependentMask: true } });
            expect(routeEcommerceRole(settings, "image_generation", candidate.snapshot)?.snapshot).toStrictEqual(candidate.snapshot);
            return candidate;
        }

        async function withSceneRoutes<T>(runId: string, action: (origin: string) => Promise<T>) {
            const [reference, image, runDetail, runAction] = await Promise.all([
                import("@/app/api/reference-assets/[...path]/route"),
                import("@/app/api/image-tasks/[id]/route"),
                import("@/app/api/agent/runs/[id]/route"),
                import("@/app/api/agent/runs/[id]/[action]/route"),
            ]);
            const failure = Promise.withResolvers<never>();
            const active = new Set<Promise<void>>();
            let origin: string;
            async function handle(request: IncomingMessage, response: ServerResponse) {
                assert.ok(request.url);
                const url = new URL(request.url, origin);
                expect(request.headers.cookie).toBe(boundary.cookie);
                let result: Response;
                if (request.method === "GET" && url.pathname.startsWith("/api/reference-assets/")) {
                    result = await reference.GET(new Request(url, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ path: url.pathname.slice("/api/reference-assets/".length).split("/").map(decodeURIComponent) }) });
                } else if (request.method === "GET" && url.pathname.startsWith("/api/image-tasks/")) {
                    result = await image.GET(new Request(url, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ id: decodeURIComponent(url.pathname.slice("/api/image-tasks/".length)) }) });
                } else if (request.method === "GET" && url.pathname === "/api/agent/runs/" + runId) {
                    result = await runDetail.GET(new Request(url, { headers: { cookie: boundary.cookie } }), { params: Promise.resolve({ id: runId }) });
                } else {
                    expect(request.method).toBe("POST");
                    expect(url.pathname).toBe("/api/agent/runs/" + runId + "/resume");
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    result = await runAction.POST(new Request(url, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: new Uint8Array(Buffer.concat(chunks)) }), {
                        params: Promise.resolve({ id: runId, action: "resume" }),
                    });
                }
                const bytes = Buffer.from(await result.arrayBuffer());
                for (const [name, value] of result.headers) response.setHeader(name, value);
                response.writeHead(result.status);
                response.end(bytes);
            }
            const server = createServer((request, response) => {
                const running = handle(request, response)
                    .catch((error: unknown) => {
                        failure.reject(error);
                        if (!response.headersSent) response.writeHead(500);
                        response.end();
                    })
                    .finally(() => active.delete(running));
                active.add(running);
            });
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", () => {
                        server.off("error", reject);
                        resolve();
                    });
                });
                server.on("error", (error) => failure.reject(error));
                const address = server.address();
                assert.ok(address !== null && typeof address !== "string");
                origin = "http://127.0.0.1:" + address.port;
                return await Promise.race([action(origin), failure.promise]);
            } finally {
                server.closeAllConnections();
                if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                await Promise.all([...active]);
            }
        }

        async function configureNativeScenePlanning(advisoryReview = false) {
            const imageRoute = await configureSceneRoute();
            const before = await auth.getFreshAuthSettings();
            const plannerId = "fixture-native-scene-planner-" + randomUUID();
            const plannerModel = "fixture-native-scene-text-" + randomUUID();
            const channelId = imageRoute.snapshot.channelId;
            const logicalModels = [
                ...before.logicalModels,
                { id: plannerId, name: "Owned native scene planner", capability: "text" as const, enabled: true, bindings: [{ id: plannerId + "-binding", channelId, upstreamModel: plannerModel, enabled: true, priority: 1 }] },
            ];
            const roles = { vision_analysis: [plannerId], edit_planning: [plannerId], image_generation: [imageModelId], quality_check: advisoryReview ? [plannerId] : [] };
            if (provider === "file") {
                await auth.setAuthSettings({
                    systemChannels: before.systemChannels.map((channel) => (channel.id === channelId ? { ...channel, models: [...channel.models, plannerModel] } : channel)),
                    logicalModels,
                    defaultModels: { ...before.defaultModels, textModel: plannerId },
                    ecommerceGenerationEnabled: true,
                    ecommerceVisualQualityCheckEnabled: advisoryReview,
                    ecommerceModelRoles: roles,
                });
            } else {
                const fixture = pgFixture;
                assert.ok(fixture);
                fixture.installed = await database.withPostgresTransaction(async (executor) => {
                    const repositories = database.createPostgresRepositories(executor);
                    await repositories.settings.lock();
                    expect(await readSettings(executor), "SETUP: owned settings changed before native planning installation").toStrictEqual(fixture.installed);
                    const channel = await repositories.settings.getSystemModelChannelById(channelId);
                    assert.ok(channel);
                    expect(channel).toMatchObject({ id: fixture.channelId, apiKeyCiphertext: fixture.channelCiphertext, models: [imageRoute.snapshot.upstreamModel] });
                    await repositories.settings.upsertSystemModelChannel({ ...channel, models: [imageRoute.snapshot.upstreamModel, plannerModel] });
                    await writeSettings(executor, {
                        ...fixture.installed,
                        logical_models: logicalModels,
                        default_models: { ...before.defaultModels, textModel: plannerId },
                        ecommerce_generation_enabled: true,
                        ecommerce_visual_quality_check_enabled: advisoryReview,
                        ecommerce_model_roles: roles,
                    });
                    return readSettings(executor);
                });
            }
            vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
            const configured = await auth.getFreshAuthSettings();
            const { routeEcommerceRole } = await import("./ecommerce-model-routing");
            expect(configured).toMatchObject({ ecommerceGenerationEnabled: true, ecommerceVisualQualityCheckEnabled: advisoryReview, ecommerceModelRoles: roles });
            expect(routeEcommerceRole(configured, "vision_analysis")?.snapshot).toMatchObject({ logicalModelId: plannerId, channelId, upstreamModel: plannerModel, capability: "text" });
            expect(routeEcommerceRole(configured, "edit_planning")?.snapshot).toMatchObject({ logicalModelId: plannerId, channelId, upstreamModel: plannerModel, capability: "text" });
            expect(routeEcommerceRole(configured, "image_generation")?.snapshot).toStrictEqual(imageRoute.snapshot);
            return imageRoute;
        }

        function installNativeProductPlanningReplies(assetId: string, visibleStructure: NonNullable<EcommerceEditPlan["visibleStructure"]> = []) {
            type PlannerMessage = {
                sources: EcommerceSources;
                requiredModelRoles: EcommerceEditPlan["modelRoles"];
                continuity: EcommerceEditPlan["continuity"];
                visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; productFacts: EcommerceEditPlan["baseline"]["productFacts"] }> };
            };
            const reply = (value: unknown) => ({ arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 });
            boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                if (request.tool.name === "analyze_ecommerce_references")
                    return reply({
                        analysisVersion: "ecommerce-visual-analysis.v4",
                        references: [
                            {
                                assetId,
                                contentType: "isolated_product",
                                confidence: "high",
                                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                                productFacts: { identity: "cabinet", outline: "rectangular cabinet", color: "oak", material: "wood", brandText: [], view: "front" },
                                sceneFacts: null,
                                productCore: { x: 0.34375, y: 0.3046875, width: 0.3125, height: 0.390625 },
                                fusionHalo: { x: 0.3, y: 0.25, width: 0.4, height: 0.5 },
                                editableTargets: [],
                                visibleStructure,
                                cues: [],
                            },
                        ],
                        purposeSuggestions: [],
                    });
                expect(request.tool.name).toBe("plan_ecommerce_edit");
                const message = request.messages.find((item) => item.role === "user");
                assert.ok(message && typeof message.content === "string");
                const input: PlannerMessage = JSON.parse(message.content);
                expect(input.sources).toMatchObject({ productAnchorId: assetId, currentSceneBaselineId: null, sceneReferenceIds: [] });
                const product = input.visualAnalysis.references.find((reference) => reference.assetId === assetId);
                assert.ok(product?.productFacts, "SETUP: the real product planner must receive its accepted product anchor");
                return reply({
                    planVersion: "ecommerce-edit.v6",
                    operation: "product_to_scene",
                    source: { productAnchorId: input.sources.productAnchorId, currentSceneBaselineId: input.sources.currentSceneBaselineId, sceneReferenceIds: input.sources.sceneReferenceIds },
                    baseline: { productFacts: product.productFacts, sceneFacts: null },
                    delta: { requestedChanges: ["Replace the background with a living room"], targetObjects: ["background-main"], targetRegions: [] },
                    preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
                    strategy: "strict_product",
                    modelRoles: input.requiredModelRoles,
                    continuity: input.continuity,
                    referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: [] })),
                    validation: { requiredChecks: ["product_identity"] },
                });
            });
        }

        function installNativeLocalProductPlanningReplies(productId: string, sceneId: string, styleId?: string) {
            type PlannerMessage = {
                sources: EcommerceSources;
                requiredModelRoles: EcommerceEditPlan["modelRoles"];
                continuity: EcommerceEditPlan["continuity"];
                visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; productFacts: EcommerceEditPlan["baseline"]["productFacts"]; sceneFacts: EcommerceEditPlan["baseline"]["sceneFacts"] }> };
            };
            const reply = (value: unknown) => ({ arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 });
            boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                if (request.tool.name === "analyze_ecommerce_references")
                    return reply({
                        analysisVersion: "ecommerce-visual-analysis.v4",
                        references: [
                            {
                                assetId: productId,
                                contentType: "isolated_product",
                                confidence: "high",
                                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                                productFacts: { identity: "cabinet", outline: "rectangular cabinet", color: "oak", material: "wood", brandText: [], view: "front" },
                                sceneFacts: null,
                                productCore: { x: 0.34375, y: 0.3046875, width: 0.3125, height: 0.390625 },
                                fusionHalo: { x: 0.3125, y: 0.2734375, width: 0.375, height: 0.453125 },
                                editableTargets: [],
                                visibleStructure: [],
                                cues: [],
                            },
                            {
                                assetId: sceneId,
                                contentType: "interior_scene",
                                confidence: "high",
                                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                                productFacts: null,
                                sceneFacts: { space: "living room", composition: "eye level cabinet with a vase on the left", lighting: "soft daylight" },
                                productCore: { x: 0.375, y: 0.25, width: 0.25, height: 0.5 },
                                fusionHalo: { x: 0.34375, y: 0.21875, width: 0.3125, height: 0.5625 },
                                editableTargets: [{ id: "left-vase", kind: "prop", label: "vase on the left", region: { x: 0.125, y: 0.375, width: 0.125, height: 0.1875 } }],
                                visibleStructure: [],
                                cues: [],
                            },
                            ...(styleId ? [nativeAuxiliaryStyleAnalysis(styleId)] : []),
                        ],
                        purposeSuggestions: [
                            { assetId: productId, purposes: ["product_identity"], confidence: "high" },
                            { assetId: sceneId, purposes: ["edit_target"], confidence: "high" },
                            ...(styleId ? [{ assetId: styleId, purposes: ["style"], confidence: "high" }] : []),
                        ],
                    });
                expect(request.tool.name).toBe("plan_ecommerce_edit");
                const message = request.messages.find((item) => item.role === "user");
                assert.ok(message && typeof message.content === "string");
                const input: PlannerMessage = JSON.parse(message.content);
                expect(input.sources).toMatchObject({ status: "resolved", productAnchorId: productId, currentSceneBaselineId: sceneId, sceneReferenceIds: styleId ? [styleId] : [] });
                const product = input.visualAnalysis.references.find((reference) => reference.assetId === productId);
                const scene = input.visualAnalysis.references.find((reference) => reference.assetId === sceneId);
                assert.ok(product?.productFacts && scene?.sceneFacts, "SETUP: the real local planner must receive both accepted source facts");
                return reply({
                    planVersion: "ecommerce-edit.v6",
                    operation: "local_edit",
                    source: { productAnchorId: input.sources.productAnchorId, currentSceneBaselineId: input.sources.currentSceneBaselineId, sceneReferenceIds: input.sources.sceneReferenceIds },
                    baseline: { productFacts: product.productFacts, sceneFacts: scene.sceneFacts },
                    delta: { requestedChanges: ["把左侧花瓶换成小盆绿植"], targetObjects: ["left-vase"], targetRegions: [] },
                    preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
                    strategy: "strict_product",
                    modelRoles: input.requiredModelRoles,
                    continuity: input.continuity,
                    referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: reference.assetId === styleId ? ["auxiliary-style-cue"] : [] })),
                    validation: { requiredChecks: ["product_identity"] },
                });
            });
        }

        function installNativeScenePlanningReplies(assetId: string, styleId?: string) {
            type PlannerMessage = {
                sources: EcommerceSources;
                requiredModelRoles: EcommerceEditPlan["modelRoles"];
                continuity: EcommerceEditPlan["continuity"];
                visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; sceneFacts: EcommerceEditPlan["baseline"]["sceneFacts"] }> };
            };
            const reply = (value: unknown) => ({ arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 });
            boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                if (request.tool.name === "analyze_ecommerce_references")
                    return reply({
                        analysisVersion: "ecommerce-visual-analysis.v4",
                        references: [
                            {
                                assetId,
                                contentType: "interior_scene",
                                confidence: "high",
                                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                                productFacts: null,
                                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                                productCore: null,
                                fusionHalo: null,
                                editableTargets: [],
                                visibleStructure: [],
                                cues: [],
                            },
                            ...(styleId ? [nativeAuxiliaryStyleAnalysis(styleId)] : []),
                        ],
                        purposeSuggestions: [{ assetId, purposes: ["edit_target"], confidence: "high" }, ...(styleId ? [{ assetId: styleId, purposes: ["style"], confidence: "high" }] : [])],
                    });
                expect(request.tool.name).toBe("plan_ecommerce_edit");
                const message = request.messages.find((item) => item.role === "user");
                assert.ok(message && typeof message.content === "string");
                const input: PlannerMessage = JSON.parse(message.content);
                expect(input.sources).toStrictEqual({
                    status: "resolved",
                    productAnchorId: null,
                    sceneRootAssetId: assetId,
                    currentSceneBaselineId: assetId,
                    sceneReferenceIds: styleId ? [styleId] : [],
                    parentResultId: null,
                    startsNewProductAnchor: false,
                    createsBranch: false,
                    ambiguityReason: null,
                    clarificationQuestion: null,
                });
                const baseline = input.visualAnalysis.references.find((reference) => reference.assetId === assetId);
                assert.ok(baseline?.sceneFacts);
                return reply({
                    planVersion: "ecommerce-edit.v6",
                    operation: "scene_edit",
                    source: input.sources,
                    baseline: { productFacts: null, sceneFacts: baseline.sceneFacts },
                    delta: { requestedChanges: ["在柜子上增加花瓶和接触阴影"], targetObjects: ["vase"], targetRegions: ["cabinet-top"] },
                    preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                    protection: { scope: "local", protectedObjectIds: [assetId], preserveOutsideMask: true, allowLightingChange: false },
                    strategy: "integrated_scene",
                    modelRoles: input.requiredModelRoles,
                    continuity: input.continuity,
                    referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: reference.assetId === styleId ? ["auxiliary-style-cue"] : [] })),
                    visibleStructure: [],
                    validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
                });
            });
        }

        function installNativeGlobalScenePlanningReplies(assetId: string) {
            type PlannerMessage = {
                sources: EcommerceSources;
                requiredModelRoles: EcommerceEditPlan["modelRoles"];
                continuity: EcommerceEditPlan["continuity"];
                visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; sceneFacts: EcommerceEditPlan["baseline"]["sceneFacts"] }> };
            };
            const reply = (value: unknown) => ({ arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 });
            boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                if (request.tool.name === "analyze_ecommerce_references")
                    return reply({
                        analysisVersion: "ecommerce-visual-analysis.v4",
                        references: [
                            {
                                assetId,
                                contentType: "interior_scene",
                                confidence: "high",
                                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                                productFacts: null,
                                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                                productCore: null,
                                fusionHalo: null,
                                editableTargets: [],
                                visibleStructure: [],
                                cues: [],
                            },
                        ],
                        purposeSuggestions: [{ assetId, purposes: ["edit_target"], confidence: "high" }],
                    });
                expect(request.tool.name).toBe("plan_ecommerce_edit");
                const message = request.messages.find((item) => item.role === "user");
                assert.ok(message && typeof message.content === "string");
                const input: PlannerMessage = JSON.parse(message.content);
                expect(input.sources).toStrictEqual({
                    status: "resolved",
                    productAnchorId: null,
                    sceneRootAssetId: assetId,
                    currentSceneBaselineId: assetId,
                    sceneReferenceIds: [],
                    parentResultId: null,
                    startsNewProductAnchor: false,
                    createsBranch: false,
                    ambiguityReason: null,
                    clarificationQuestion: null,
                });
                const baseline = input.visualAnalysis.references.find((reference) => reference.assetId === assetId);
                assert.ok(baseline?.sceneFacts);
                return reply({
                    planVersion: "ecommerce-edit.v6",
                    operation: "scene_edit",
                    source: input.sources,
                    baseline: { productFacts: null, sceneFacts: baseline.sceneFacts },
                    delta: { requestedChanges: ["全局调整光线为明亮自然日光"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
                    preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                    protection: { scope: "global", protectedObjectIds: [assetId], preserveOutsideMask: false, allowLightingChange: true },
                    strategy: "integrated_scene",
                    modelRoles: input.requiredModelRoles,
                    continuity: input.continuity,
                    referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: [] })),
                    visibleStructure: [],
                    validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
                });
            });
        }

        function installNativeGlobalScene4kPlanningReplies(assetId: string) {
            type PlannerMessage = {
                sources: EcommerceSources;
                requiredModelRoles: EcommerceEditPlan["modelRoles"];
                continuity: EcommerceEditPlan["continuity"];
                visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; sceneFacts: EcommerceEditPlan["baseline"]["sceneFacts"] }> };
            };
            const reply = (value: unknown) => ({ arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 });
            boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                if (request.tool.name === "analyze_ecommerce_references")
                    return reply({
                        analysisVersion: "ecommerce-visual-analysis.v4",
                        references: [
                            {
                                assetId,
                                contentType: "interior_scene",
                                confidence: "high",
                                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                                productFacts: null,
                                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                                productCore: null,
                                fusionHalo: null,
                                editableTargets: [],
                                visibleStructure: [],
                                cues: [],
                            },
                        ],
                        purposeSuggestions: [{ assetId, purposes: ["edit_target"], confidence: "high" }],
                    });
                expect(request.tool.name).toBe("plan_ecommerce_edit");
                const message = request.messages.find((item) => item.role === "user");
                assert.ok(message && typeof message.content === "string");
                const input: PlannerMessage = JSON.parse(message.content);
                expect(input.sources).toStrictEqual({
                    status: "resolved",
                    productAnchorId: null,
                    sceneRootAssetId: assetId,
                    currentSceneBaselineId: assetId,
                    sceneReferenceIds: [],
                    parentResultId: null,
                    startsNewProductAnchor: false,
                    createsBranch: false,
                    ambiguityReason: null,
                    clarificationQuestion: null,
                });
                const baseline = input.visualAnalysis.references.find((reference) => reference.assetId === assetId);
                assert.ok(baseline?.sceneFacts);
                return reply({
                    planVersion: "ecommerce-edit.v6",
                    operation: "scene_edit",
                    source: input.sources,
                    baseline: { productFacts: null, sceneFacts: baseline.sceneFacts },
                    delta: { requestedChanges: ["全局调整光线为明亮自然日光"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
                    preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                    protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true },
                    strategy: "integrated_scene",
                    modelRoles: input.requiredModelRoles,
                    continuity: input.continuity,
                    referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: [] })),
                    visibleStructure: [],
                    validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
                });
            });
        }

        async function claimNativeSceneRun(runId: string, workerId: string, origin: string) {
            const due = await tasks.getStoredGenerationTaskRecord("agent", runId);
            assert.ok(due);
            expect(due.workerId).toBeUndefined();
            expect(due.leaseUntil).toBeUndefined();
            expect(due.nextPollAt).toBeGreaterThan(0);
            expect(await scheduler.claimDueGenerationTasks({ workerId, taskIds: [runId], limit: 1 })).toMatchObject([{ id: runId, workerId }]);
            const current = await runs.getAgentRun(runId);
            assert.ok(current);
            const { executeAgentRun } = await import("./agent-run-executor");
            await executeAgentRun(current, origin, boundary.cookie);
            const saved = await runs.getAgentRun(runId);
            assert.ok(saved);
            return saved;
        }

        async function nativeSceneWaitingStage(runId: string, operation: "prepare_reference" | "build_protection", parentTaskId: string) {
            const run = await runs.getAgentRun(runId);
            const waiting = run?.ecommerceSnapshot?.processing?.waitingFor;
            assert.ok(waiting);
            const stage = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.jobId);
            assert.ok(stage);
            expect(stage).toMatchObject({ userId, runId, parentTaskId, status: "pending", payload: { operation, inputDigest: waiting.inputDigest } });
            const parent = await tasks.getStoredGenerationTaskRecord("agent", runId);
            expect(parent?.workerId).toBeUndefined();
            expect(parent?.leaseUntil).toBeUndefined();
            expect(parent?.nextPollAt).toBeUndefined();
            return stage;
        }

        async function completeNativeSceneStage(jobId: string) {
            const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
            const workerId = "fixture-native-scene-stage-" + randomUUID();
            const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 6144 * 1024 * 1024, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const child = claimed.tasks[0];
            assert.ok(child && (child.payload.operation === "prepare_reference" || child.payload.operation === "prepare_review" || child.payload.operation === "build_protection"));
            expect(child.id).toBe(jobId);
            const identity = { workerId, executionId: child.executionId };
            const taskDirectory = await mkdtemp(path.join(directory, "native-scene-stage-"));
            const filename = path.join(taskDirectory, "source.png");
            const input = await service.readImageProcessingInput(jobId, child.payload.inputs[0].assetId, identity);
            await pipeline(input.stream, createWriteStream(filename, { flags: "wx" }));
            const outputDirectory = path.join(taskDirectory, "outputs");
            await mkdir(outputDirectory);
            const operation =
                child.payload.operation === "build_protection"
                    ? { operation: "build_protection" as const, options: child.payload.options }
                    : child.payload.operation === "prepare_review"
                      ? { operation: "prepare_review" as const, options: child.payload.options }
                      : { operation: "prepare_reference" as const, options: {} };
            const closed = await runImageProcessing(
                { version: "image-processing.v1", ...operation, jobId, executionId: child.executionId, inputs: [{ ...child.payload.inputs[0], path: filename }], outputDirectory },
                { taskDirectory, maxHeapMiB: child.payload.resource.configuration.processHeapMb },
            );
            expect(closed).toMatchObject({ status: "completed", jobId, executionId: child.executionId, exitCode: 0, signal: null });
            assert.ok(closed.status === "completed" && closed.pid);
            const pid = closed.pid;
            expect(closed.result.metrics.pid).not.toBe(process.pid);
            expect(closed.result.metrics.peakRssBytes).toBeGreaterThan(0);
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            expect(closed.result.artifacts).toHaveLength(1);
            const artifact = closed.result.artifacts[0];
            assert.ok(artifact && (artifact.kind === "analysis" || artifact.kind === "mask"));
            expect(artifact.kind).toBe(child.payload.operation === "build_protection" ? "mask" : "analysis");
            const bytes = await readFile(artifact.path);
            const stored = await service.writeImageProcessingOutput(jobId, artifact.kind, identity, { mimeType: artifact.mimeType, stream: new Response(new Uint8Array(bytes)).body! });
            expect(stored).toMatchObject({ kind: artifact.kind, sha256: digest(bytes), bytes: bytes.length, width: artifact.width, height: artifact.height });
            const { metrics, ...manifest } = closed.result;
            const completion = { ...identity, manifest: { ...manifest, artifacts: [stored] }, metrics };
            const receipt = await service.completeImageProcessingTask(jobId, completion);
            expect(receipt).toMatchObject({ jobId, executionId: child.executionId, manifest: completion.manifest, parentRescheduled: true });
            return { child, completion, receipt, stored, bytes };
        }

        type NativeScenePrefix = {
            conversation: Awaited<ReturnType<typeof creative.createConversationForUser>>;
            source: Buffer;
            baseline: Awaited<ReturnType<typeof creative.uploadAssetForUser>>;
            registeredSource: NonNullable<Awaited<ReturnType<typeof references.readReferenceAsset>>>;
            initial: AgentRun;
            paused: AgentRun;
            plan: EcommerceEditPlan;
            receipt: NonNullable<NonNullable<NonNullable<AgentRun["ecommerceSnapshot"]>["processing"]>["sceneSelection"]>;
            prepareBefore: NonNullable<Awaited<ReturnType<typeof tasks.getStoredGenerationTaskRecord>>>;
            buildBefore: NonNullable<Awaited<ReturnType<typeof tasks.getStoredGenerationTaskRecord>>>;
            built: Awaited<ReturnType<typeof completeNativeSceneStage>>;
            registeredMask: NonNullable<Awaited<ReturnType<typeof references.readReferenceAsset>>>;
            originalMaskRegistration: Awaited<ReturnType<typeof registrations.getLocalMediaRegistration>>;
            maskUrl: string;
            imageOrigin: string;
            created: Array<{ requestId: string; taskId: string }>;
            dispatched: AgentRun;
            task: AgentRunTask;
            first: { requestId: string; taskId: string };
            second: { requestId: string; taskId: string };
            siblingRecord: NonNullable<Awaited<ReturnType<typeof tasks.getStoredGenerationTaskRecord>>>;
            submitted: ImageTask;
            charge: Awaited<ReturnType<typeof auth.consumeUserPoints>>;
            firstDebits: Awaited<ReturnType<typeof auth.listPointRecordsPage>>;
            native: Buffer;
            nativePath: string;
            sealed: ImageTask;
            imageClaim: { taskId: string; workerId: string; executionId: string };
            step: Extract<Awaited<ReturnType<typeof runtime.queryImageTaskUpstreamStep>>, { state: "result_ready" }>;
        };

        async function withNativeScenePrefix(action: (fixture: NativeScenePrefix) => Promise<void>) {
            const route = await configureNativeScenePlanning();
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Native prepared scene Run copies" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();
            const baseline = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "native-scene.png", { type: "image/png" }));
            assert.ok(baseline.storageKey && baseline.serverUrl);
            const registeredSource = await references.readReferenceAsset(baseline.storageKey);
            assert.ok(registeredSource);
            expect(await readFile(registeredSource.filePath)).toEqual(source);
            installNativeScenePlanningReplies(baseline.id);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-scene-result-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，在柜子上增加花瓶和接触阴影，只修改局部，保留其他区域和原图尺寸",
                    assetIds: [baseline.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 2, quality: "low", size: "1024x1024" } },
                })
            ).run;
            const noDebits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
            expect(noDebits.records).toStrictEqual([]);
            await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
            await withSceneRoutes(initial.id, async (sceneOrigin) => {
                await claimNativeSceneRun(initial.id, "fixture-native-result-prepare-parent", sceneOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                expect(prepare.payload.inputs).toMatchObject([{ assetId: baseline.id }]);
                const prepared = await completeNativeSceneStage(prepare.id);
                const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id);
                assert.ok(prepareBefore?.resultPayload?.manifestDigest);
                expect(prepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { executionId: prepared.child.executionId, manifest: prepared.completion.manifest } });
                const paused = await claimNativeSceneRun(initial.id, "fixture-native-result-planning-parent", sceneOrigin);
                expect(paused, JSON.stringify({ run: paused, modelCalls: boundary.model.mock.calls.map(([request]) => ({ tool: request.tool.name, messages: request.messages })) })).toMatchObject({
                    status: "paused",
                    tasks: [{ id: "ecommerce-scene-edit", type: "image", status: "needs_review", count: 2, attempts: 0 }],
                    ecommerceSnapshot: {
                        mode: "active",
                        qualityPolicy: "disabled",
                        fallback: { reason: "scene_selection_required" },
                        referenceCheckpoint: { state: "resolved", analysisStage: { state: "completed" } },
                        plan: { operation: "scene_edit", canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false }, protection: { scope: "local", preserveOutsideMask: true } },
                    },
                });
                expect(paused.tasks).toHaveLength(1);
                const originalTask = structuredClone(paused.tasks[0]);
                expect(originalTask.sceneProtection).toBeUndefined();
                expect(originalTask.childTasks).toBeUndefined();
                const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
                const profile = resolveEcommerceImageProviderProfile(route.snapshot);
                const snapshot = paused.ecommerceSnapshot;
                assert.ok(profile?.supportsIndependentMask && snapshot?.plan && snapshot.referenceCheckpoint);
                const plan = snapshot.plan;
                const referenceCheckpoint = snapshot.referenceCheckpoint;
                expect(compileEcommerceImageRequest(snapshot.plan, profile)).toStrictEqual(originalTask.ecommerceExecution);
                expect(snapshot.processing?.prepareReferences).toMatchObject([{ jobId: prepare.id, inputDigest: prepare.payload.inputDigest, assetId: baseline.id, manifest: prepared.completion.manifest }]);
                const response = await fetch(sceneOrigin + "/api/agent/runs/" + paused.id + "/resume", {
                    method: "POST",
                    headers: { cookie: boundary.cookie, "content-type": "application/json" },
                    body: JSON.stringify({ conversationId: conversation.id, sceneSelection: { baselineAssetId: baseline.id, region: { x: 256, y: 256, width: 256, height: 256 } } }),
                });
                expect(response.status, "SETUP: actual authenticated Action must persist the native selection receipt").toBe(200);
                const confirmed = await runs.getAgentRun(paused.id);
                const receipt = confirmed?.ecommerceSnapshot?.processing?.sceneSelection;
                assert.ok(confirmed && receipt);
                expect(confirmed.tasks).toStrictEqual(paused.tasks);
                expect(receipt).toMatchObject({
                    parentTaskId: originalTask.id,
                    confirmation: { actorUserId: userId },
                    baseline: { assetId: baseline.id, sha256: digest(source), width: 1024, height: 1024 },
                    region: { x: 256, y: 256, width: 256, height: 256 },
                    prepare: { jobId: prepare.id, inputDigest: prepare.payload.inputDigest, executionId: prepared.child.executionId, manifestDigest: prepareBefore.resultPayload.manifestDigest },
                });
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([paused.id], [userId])).filter((row) => row.type === "image_processing")).toStrictEqual([prepareBefore]);
                await claimNativeSceneRun(paused.id, "fixture-native-result-claim-a", sceneOrigin);
                const build = await nativeSceneWaitingStage(paused.id, "build_protection", originalTask.id);
                const built = await completeNativeSceneStage(build.id);
                const buildBefore = await tasks.getStoredGenerationTaskRecord("image_processing", build.id);
                assert.ok(buildBefore);
                expect(buildBefore).toMatchObject({
                    status: "success",
                    executionPhase: "completed",
                    resultPayload: { executionId: built.child.executionId, manifestDigest: service.imageProcessingManifestDigest(built.completion.manifest), manifest: built.completion.manifest },
                });
                expect(built.completion.manifest.sourceIdentities).toMatchObject([{ assetId: baseline.id, assetVersion: receipt.baseline.assetVersion, sha256: digest(source), bytes: source.length, width: 1024, height: 1024 }]);
                expect(built.completion.manifest.geometry.sceneProtection).toMatchObject({
                    sourceDigest: digest(source),
                    sourceSize: { width: 1024, height: 1024 },
                    maskDigest: digest(built.bytes),
                    targetRegion: receipt.region,
                    semantics: receipt.semantics,
                    selectionSource: "user_selection",
                    maskSemantics: "alpha_zero_edit",
                    method: "source_pixels_copy",
                });
                expect(built.completion.manifest.geometry.sceneProtection?.confirmation).toBeUndefined();
                const registeredMask = await references.readReferenceAsset(built.stored.storageKey);
                assert.ok(registeredMask);
                const originalMaskRegistration = registeredMask.registration;
                expect(registeredMask.registration).toMatchObject({
                    ownerUserId: userId,
                    source: "image-processing-mask",
                    scope: "reference",
                    type: "image",
                    taskId: build.id,
                    runId: paused.id,
                    storageClass: "temporary",
                    mimeType: "image/png",
                    bytes: built.bytes.length,
                });
                expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(noDebits);
                const maskUrl = "/api/reference-assets/" + built.stored.storageKey.split("/").map(encodeURIComponent).join("/");

                await withImageRoutes(confirmed, originalTask, async (imageOrigin, created) => {
                    const dispatched = await claimNativeSceneRun(paused.id, "fixture-native-result-claim-b", imageOrigin);
                    const task = dispatched.tasks[0];
                    assert.ok(dispatched.executionId && task.sceneProtection);
                    expect(dispatched).toMatchObject({ status: "running", tasks: [{ id: originalTask.id, count: 2, attempts: 1, status: "running" }] });
                    expect(created).toHaveLength(2);
                    const first = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + task.id + ":1:1");
                    const second = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + task.id + ":1:2");
                    assert.ok(first && second);
                    expect(first.taskId).not.toBe(second.taskId);
                    expect(task.taskIds).toEqual(expect.arrayContaining([first.taskId, second.taskId]));
                    expect(task.childTasks).toHaveLength(2);
                    expect(task.childTasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.taskId, status: "pending", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "pending", attempt: 1 })]));
                    expect(task.sceneProtection.mask).toMatchObject({ dataUrl: "", serverUrl: maskUrl, type: "image/png", width: 1024, height: 1024 });
                    expect(task.sceneProtection.confirmation).toStrictEqual(receipt.confirmation);
                    expect(dispatched.ecommerceSnapshot).toMatchObject({ plan: snapshot.plan, compilerVersion: snapshot.compilerVersion, modelRouteSnapshots: snapshot.modelRouteSnapshots, referenceCheckpoint: snapshot.referenceCheckpoint });
                    expect(dispatched.ecommerceSnapshot?.processing?.sceneSelection).toStrictEqual(receipt);
                    expect(dispatched.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
                    const { readCompletedEcommerceSceneProtection } = await import("./ecommerce-protection-preparation");
                    const evidence = await readCompletedEcommerceSceneProtection(dispatched);
                    expect(evidence.sceneProtection).toStrictEqual(task.sceneProtection);
                    expect(evidence.stage.id).toBe(build.id);
                    expect(evidence.maskRegistration).toStrictEqual({
                        ...registeredMask.registration,
                        conversationId: undefined,
                        externalObjectKey: undefined,
                        externalStorageId: undefined,
                        externalSyncedAt: undefined,
                        originalName: undefined,
                        projectId: undefined,
                    });
                    const firstBefore = await imageTasks.getImageTask(first.taskId);
                    const secondBefore = await imageTasks.getImageTask(second.taskId);
                    const siblingRecord = await tasks.getStoredGenerationTaskRecord("image", second.taskId);
                    assert.ok(firstBefore && secondBefore && siblingRecord);
                    expect(firstBefore).toMatchObject({
                        id: first.taskId,
                        runId: paused.id,
                        parentTaskId: paused.id,
                        userId,
                        conversationId: conversation.id,
                        clientRequestId: first.requestId,
                        status: "pending",
                        kind: "edit",
                        references: [{ id: baseline.id, ecommerceRole: "scene", url: baseline.serverUrl }],
                        ecommerceExecution: originalTask.ecommerceExecution,
                        sceneProtection: task.sceneProtection,
                        mask: task.sceneProtection.mask,
                        referenceDispatch: { copy: 1, inputId: referenceCheckpoint.inputId, decisionId: referenceCheckpoint.decisionId, analysisRequestId: referenceCheckpoint.analysisStage.requestId },
                    });
                    expect(secondBefore).toMatchObject({ id: second.taskId, status: "pending", clientRequestId: second.requestId, referenceDispatch: { copy: 2 }, sceneProtection: task.sceneProtection, mask: task.sceneProtection.mask });
                    expect(firstBefore.attempts).toBeUndefined();
                    expect(firstBefore.billing).toBeUndefined();
                    expect(firstBefore.upstream).toBeUndefined();
                    expect(secondBefore.attempts).toBeUndefined();
                    expect(secondBefore.billing).toBeUndefined();
                    expect(secondBefore.upstream).toBeUndefined();
                    expect(boundary.create).not.toHaveBeenCalled();
                    const [claim] = await scheduler.claimDueGenerationTasks({ workerId: "fixture-native-result-original-copy-one", taskIds: [first.taskId], limit: 1 });
                    assert.ok(claim && typeof claim.payload.executionId === "string");
                    const claimedImage = await imageTasks.getImageTask(first.taskId);
                    assert.ok(claimedImage);
                    expect(claimedImage.executionId).toBe(claim.payload.executionId);
                    expect(await runtime.createImageTaskUpstreamStep(claimedImage, imageOrigin, imageOrigin, boundary.cookie)).toMatchObject({ state: "pending", upstream: { id: "fixture-upstream-" + first.taskId } });
                    const submitted = await imageTasks.getImageTask(first.taskId);
                    const charge = charges.get(first.taskId);
                    assert.ok(submitted && charge);
                    expect(charge.cost).toBe(2);
                    expect(submitted).toMatchObject({
                        id: first.taskId,
                        executionId: claim.payload.executionId,
                        clientRequestId: first.requestId,
                        runId: paused.id,
                        attemptNo: 1,
                        upstream: { id: "fixture-upstream-" + first.taskId },
                        ecommerceCanvasRequest: { size: "1024x1024" },
                        billing: { pointsCost: 2, pointsRecordId: charge.recordId, refunded: false },
                        mask: task.sceneProtection.mask,
                        sceneProtection: task.sceneProtection,
                    });
                    expect(submitted.attempts).toHaveLength(1);
                    expect(submitted.attempts?.[0]).toMatchObject({ attemptNo: 1, status: "running" });
                    expect(await tasks.getStoredGenerationTaskRecord("image", first.taskId)).toMatchObject({
                        workerId: "fixture-native-result-original-copy-one",
                        upstreamTaskId: submitted.upstream?.id,
                        executionPhase: "submitted",
                        payload: { executionId: claim.payload.executionId },
                    });
                    expect(await tasks.getStoredGenerationTaskRecord("image", second.taskId)).toStrictEqual(siblingRecord);
                    expect(await imageTasks.getImageTask(second.taskId)).toStrictEqual(secondBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    expect(await registrations.getLocalMediaRegistration(built.stored.storageKey)).toStrictEqual(registeredMask.registration);
                    const firstDebits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                    expect(firstDebits.records).toHaveLength(1);
                    expect(firstDebits.records[0]).toMatchObject({ id: charge.recordId, userId, type: "consume", amount: -2, idempotencyKey: "fixture-run-copy:" + first.taskId });
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).not.toHaveBeenCalled();
                    const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                        .png()
                        .toBuffer();
                    providerResults.set(submitted.upstream!.id, { dataUrl: dataUrl(native), results: [{ dataUrl: dataUrl(native) }] });
                    const step = await runtime.queryImageTaskUpstreamStep(submitted, imageOrigin, boundary.cookie);
                    expect(step, "RED: a genuinely prepared native scene copy must capture its same-upstream original before result processing").toMatchObject({ state: "result_ready", status: "native_ready" });
                    assert.ok(step.state === "result_ready");

                    const sealed = await imageTasks.getImageTask(first.taskId);
                    assert.ok(sealed?.nativeResults);
                    expect(sealed.result).toBeUndefined();
                    const nativeSlot = sealed.nativeResults.slots[0];
                    assert.ok(nativeSlot.status === "stored");
                    expect(nativeSlot).toMatchObject({ resultId: first.taskId + ":1", resultIndex: 1, sha256: digest(native), bytes: native.length });
                    const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                    const nativePath = path.join(REFERENCE_MEDIA_ROOT, nativeSlot.storageKey);
                    expect(await readFile(nativePath)).toEqual(native);
                    expect(await registrations.getLocalMediaRegistration(nativeSlot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: first.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                    await action({
                        conversation,
                        source,
                        baseline,
                        registeredSource,
                        initial,
                        paused,
                        plan,
                        receipt,
                        prepareBefore,
                        buildBefore,
                        built,
                        registeredMask,
                        originalMaskRegistration,
                        maskUrl,
                        imageOrigin,
                        created,
                        dispatched,
                        task,
                        first,
                        second,
                        siblingRecord,
                        submitted,
                        charge,
                        firstDebits,
                        native,
                        nativePath,
                        sealed,
                        step,
                        imageClaim: { taskId: first.taskId, workerId: "fixture-native-result-original-copy-one", executionId: claim.payload.executionId },
                    });
                });
            });
        }

        function nativeAuxiliaryStyleAnalysis(assetId: string) {
            return {
                assetId,
                contentType: "interior_scene",
                confidence: "high",
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                productCore: null,
                fusionHalo: null,
                editableTargets: [],
                visibleStructure: [],
                cues: [{ id: "auxiliary-style-cue", facet: "style", description: "simple green ceramic styling", confidence: "high" }],
            };
        }

        async function prepareAuxiliaryReference(runId: string, assetId: string, origin: string) {
            await claimNativeSceneRun(runId, "fixture-aux-reference-prepare-" + assetId, origin);
            const stage = await nativeSceneWaitingStage(runId, "prepare_reference", runId);
            expect(stage.payload.inputs).toMatchObject([{ assetId }]);
            await completeNativeSceneStage(stage.id);
        }

        async function createAuxiliaryRun(conversationId: string, assetIds: string[], prompt: string) {
            const { run } = await runs.createAgentRun(userId, {
                clientRequestId: "fixture-aux-reference-" + randomUUID(),
                conversationId,
                surface: "chat",
                prompt,
                assetIds,
                skillIds: [],
                modelIds: [],
                preferences: { mode: "image", image: { count: 1, quality: "low", size: "1024x1024" } },
            });
            await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
            return run;
        }

        async function withAuxiliaryReferenceCopy(
            localProduct: boolean,
            action: (fixture: { run: AgentRun; image: ImageTask; origin: string; baselineId: string; styleId: string; source: Buffer; built: Awaited<ReturnType<typeof completeNativeSceneStage>>; native: Buffer }) => Promise<void>,
        ) {
            await configureNativeScenePlanning();
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Native auxiliary reference result" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#a0b0c0" } })
                .composite([
                    { input: { create: { width: 320, height: 576, channels: 3, background: "#929a9e" } }, left: 352, top: 224 },
                    { input: { create: { width: 256, height: 512, channels: 3, background: "#8a6243" } }, left: 384, top: 256 },
                    { input: { create: { width: 128, height: 192, channels: 3, background: "#436a9c" } }, left: 128, top: 384 },
                ])
                .png()
                .toBuffer();
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#a0b0c0" } })
                .composite([
                    { input: { create: { width: 320, height: 576, channels: 3, background: "#929a9e" } }, left: 352, top: 224 },
                    { input: { create: { width: 256, height: 512, channels: 3, background: "#8a6243" } }, left: 384, top: 256 },
                    { input: { create: { width: 128, height: 192, channels: 3, background: "#3b8a51" } }, left: 128, top: 384 },
                ])
                .png()
                .toBuffer();
            let productId: string | undefined;
            let baseline: Awaited<ReturnType<typeof creative.uploadAssetForUser>>;
            if (localProduct) {
                const productBytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
                    .composite([{ input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 }])
                    .png()
                    .toBuffer();
                const product = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(productBytes)], "aux-product.png", { type: "image/png" }));
                productId = product.id;
                installNativeProductPlanningReplies(product.id);
                const previous = await createAuxiliaryRun(conversation.id, [product.id], "修改图片1，把背景换成客厅场景，保持商品不变");
                const expected: AgentRunTask = { id: "ecommerce-product-scene", type: "image", title: "Product scene", prompt: "Route expectation", count: 1, quality: "low", ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
                const publication: { asset?: typeof baseline } = {};
                await withSceneRoutes(previous.id, async (referenceOrigin) => {
                    await prepareAuxiliaryReference(previous.id, product.id, referenceOrigin);
                    const planned = await claimNativeSceneRun(previous.id, "fixture-aux-prior-planning", referenceOrigin);
                    expect(planned.ecommerceSnapshot?.plan).toMatchObject({ planVersion: "ecommerce-edit.v6", operation: "product_to_scene" });
                    const build = await nativeSceneWaitingStage(previous.id, "build_protection", expected.id);
                    await completeNativeSceneStage(build.id);
                    await withImageRoutes(planned, expected, async (imageOrigin, created) => {
                        const dispatched = await claimNativeSceneRun(previous.id, "fixture-aux-prior-dispatch", imageOrigin);
                        assert.ok(dispatched.executionId);
                        expect(created).toHaveLength(1);
                        const prepared = await waitForCopy(created[0].taskId, source, imageOrigin);
                        const completed = await completeCopy(prepared, dispatched, imageOrigin, 1, { size: { width: 1024, height: 1024 }, options: {} });
                        await execution.executeTasks(previous.id, imageOrigin, boundary.cookie, dispatched.executionId);
                        expect(await runs.getAgentRun(previous.id)).toMatchObject({ status: "completed", assetIds: [completed.asset.id] });
                        const published = (await creative.listAssetsForUser(userId, conversation.id)).find((asset) => asset.id === completed.asset.id);
                        assert.ok(published);
                        expect(published).toMatchObject({ status: "ready", sourceRunId: previous.id, sourceTaskId: created[0].taskId, parentAssetId: product.id, messageId: previous.assistantMessageId });
                        publication.asset = published;
                    });
                });
                assert.ok(publication.asset, "SETUP: continuation must use an actual published prior Run asset");
                baseline = publication.asset;
            } else {
                baseline = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "aux-scene.png", { type: "image/png" }));
            }
            const style = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(native)], "aux-style.png", { type: "image/png" }));
            if (productId) installNativeLocalProductPlanningReplies(productId, baseline.id, style.id);
            else installNativeScenePlanningReplies(baseline.id, style.id);
            const initial = await createAuxiliaryRun(conversation.id, [baseline.id, style.id], "修改图片1，把左侧花瓶换成小盆绿植，只参考图片2的风格，仅修改局部，保留其他区域和原图尺寸");
            await withSceneRoutes(initial.id, async (referenceOrigin) => {
                await prepareAuxiliaryReference(initial.id, baseline.id, referenceOrigin);
                await prepareAuxiliaryReference(initial.id, style.id, referenceOrigin);
                if (productId) await prepareAuxiliaryReference(initial.id, productId, referenceOrigin);
                let planned = await claimNativeSceneRun(initial.id, "fixture-aux-planning", referenceOrigin);
                expect(planned.ecommerceSnapshot).toMatchObject({
                    referenceCheckpoint: { state: "resolved", analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                    plan: { planVersion: "ecommerce-edit.v6", source: { productAnchorId: productId || null, currentSceneBaselineId: baseline.id, sceneReferenceIds: [style.id] } },
                });
                if (!productId) {
                    expect(planned).toMatchObject({ status: "paused", ecommerceSnapshot: { fallback: { reason: "scene_selection_required" } } });
                    const response = await fetch(referenceOrigin + "/api/agent/runs/" + initial.id + "/resume", {
                        method: "POST",
                        headers: { cookie: boundary.cookie, "content-type": "application/json" },
                        body: JSON.stringify({ conversationId: conversation.id, sceneSelection: { baselineAssetId: baseline.id, region: { x: 128, y: 384, width: 128, height: 192 } } }),
                    });
                    expect(response.status, "SETUP: the public Action must accept the actual baseline selection").toBe(200);
                    await claimNativeSceneRun(initial.id, "fixture-aux-confirmed-selection", referenceOrigin);
                    const confirmed = await runs.getAgentRun(initial.id);
                    assert.ok(confirmed);
                    planned = confirmed;
                }
                const taskId = productId ? "ecommerce-local-edit" : "ecommerce-scene-edit";
                const build = await nativeSceneWaitingStage(initial.id, "build_protection", taskId);
                expect(build.payload.inputs).toMatchObject([{ assetId: baseline.id, expectedSha256: digest(source) }]);
                const built = await completeNativeSceneStage(build.id);
                const expected: AgentRunTask = { id: taskId, type: "image", title: "Auxiliary reference edit", prompt: "Route expectation", count: 1, quality: "low", ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
                await withImageRoutes(planned, expected, async (imageOrigin, created) => {
                    const dispatched = await claimNativeSceneRun(initial.id, "fixture-aux-dispatch", imageOrigin);
                    expect(dispatched).toMatchObject({ status: "running", tasks: [{ id: taskId, attempts: 1, status: "running" }] });
                    expect(created).toHaveLength(1);
                    const image = await imageTasks.getImageTask(created[0].taskId);
                    assert.ok(image);
                    const expectedRoles = [{ assetId: baseline.id, role: "scene" }, ...(productId ? [{ assetId: productId, role: "product" }] : []), { assetId: style.id, role: "scene" }];
                    expect(image.ecommerceExecution).toMatchObject({
                        state: "ready",
                        referenceRoles: expectedRoles,
                        referenceMapping: [{ assetId: baseline.id }, ...(productId ? [{ assetId: productId }] : []), { assetId: style.id, purposes: ["style"] }],
                    });
                    expect(image.references.map((reference) => reference.id)).toStrictEqual(expectedRoles.map((reference) => reference.assetId));
                    expect(image.mask).toMatchObject({ dataUrl: "", serverUrl: "/api/reference-assets/" + built.stored.storageKey.split("/").map(encodeURIComponent).join("/") });
                    expect(image.runId).toBe(initial.id);
                    expect(image.parentTaskId).toBe(initial.id);
                    await action({ run: dispatched, image, origin: imageOrigin, baselineId: baseline.id, styleId: style.id, source, built, native });
                });
            });
        }

        it.each([
            { label: "inherited local product with a new style", localProduct: true, mode: "ordinary", inputCount: 1 },
            { label: "confirmed local scene with a style", localProduct: false, mode: "scene_protection", inputCount: 3 },
        ] as const)(
            "routes $label through the original ImageTask result Worker",
            async ({ localProduct, mode, inputCount }) => {
                await withAuxiliaryReferenceCopy(localProduct, async ({ run, image, origin, baselineId, styleId, source, built, native }) => {
                    const [claim] = await scheduler.claimDueGenerationTasks({ workerId: "fixture-aux-original-image", taskIds: [image.id], limit: 1 });
                    assert.ok(claim && typeof claim.payload.executionId === "string");
                    const claimed = await imageTasks.getImageTask(image.id);
                    assert.ok(claimed);
                    expect(await runtime.createImageTaskUpstreamStep(claimed, origin, origin, boundary.cookie)).toMatchObject({ state: "pending", upstream: { id: "fixture-upstream-" + image.id } });
                    const submitted = await imageTasks.getImageTask(image.id);
                    assert.ok(submitted?.upstream);
                    providerResults.set(submitted.upstream.id, { dataUrl: dataUrl(native), results: [{ dataUrl: dataUrl(native) }] });
                    const query: { result?: Awaited<ReturnType<typeof runtime.queryImageTaskUpstreamStep>> } = {};
                    const webPixels = await observeNativeSceneQaPixels(async () => {
                        query.result = await runtime.queryImageTaskUpstreamStep(submitted, origin, boundary.cookie);
                    });
                    expect(query.result, "RED: a genuinely dispatched auxiliary-reference edit must retain its original provider result for the Worker").toMatchObject({ state: "result_ready", status: "native_ready" });
                    assert.ok(query.result?.state === "result_ready");
                    const sealed = await imageTasks.getImageTask(image.id);
                    assert.ok(sealed?.nativeResults);
                    expect(sealed.result).toBeUndefined();
                    expect(sealed.nativeResults.slots).toMatchObject([{ status: "stored", resultId: image.id + ":1", sha256: digest(native), bytes: native.length }]);
                    expect(webPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(await runtime.persistImageTaskResult(sealed, origin, query.result.resultUrl, boundary.cookie)).toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String) } });
                    const waiting = await imageTasks.getImageTask(image.id);
                    assert.ok(waiting?.resultProcessing);
                    expect(waiting.result).toBeUndefined();
                    expect(waiting.references).toStrictEqual(image.references);
                    const queued = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.resultProcessing.jobId);
                    assert.ok(queued?.payload.operation === "process_result");
                    expect(queued).toMatchObject({
                        parentTaskId: image.id,
                        runId: run.id,
                        userId,
                        payload: { operation: "process_result", options: { mode }, imageResultBinding: { imageTaskId: image.id, sourceIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } },
                    });
                    const worker = await processWithWorker(waiting.resultProcessing.jobId);
                    assert.ok(worker.child.payload.operation === "process_result");
                    expect(worker.child.payload.options.mode).toBe(mode);
                    expect(worker.child.payload.inputs).toHaveLength(inputCount);
                    expect(worker.child.payload.imageResultBinding).toStrictEqual(queued.payload.imageResultBinding);
                    expect(worker.completion.metrics.pid).not.toBe(process.pid);
                    expect(worker.receipt).toMatchObject({ jobId: queued.id, parentRescheduled: true });
                    expect(await recovery.runGenerationTaskRecoveryBatch({ origin, cookie: boundary.cookie, workerId: "fixture-aux-consumer", taskIds: [image.id], limit: 1 })).toMatchObject({ completed: 1, failed: 0 });
                    const published = await imageTasks.getImageTask(image.id);
                    expect(published).toMatchObject({ id: image.id, status: "success", runId: run.id, parentTaskId: run.id, references: image.references, mask: image.mask, nativeResults: sealed.nativeResults, billing: submitted.billing });
                    const final = published?.result?.results?.[0];
                    assert.ok(final?.serverUrl);
                    const publicResponse = await fetch(origin + "/api/image-tasks/" + image.id, { headers: { cookie: boundary.cookie } });
                    expect(publicResponse.status).toBe(200);
                    expect(await publicResponse.json()).toMatchObject({ task: { id: image.id, status: "success" } });
                    const bytes = await fetch(origin + final.serverUrl, { headers: { cookie: boundary.cookie } });
                    expect(bytes.status).toBe(200);
                    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(worker.uploads[0].bytes);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", built.child.id)).toMatchObject({ status: "success", resultPayload: { manifest: built.completion.manifest } });
                    expect(image.references.map((reference) => reference.id)).toEqual(expect.arrayContaining([baselineId, styleId]));
                    expect(built.completion.manifest.sourceIdentities).toMatchObject([{ assetId: baselineId, sha256: digest(source) }]);
                });
            },
            120_000,
        );

        async function closeNativeSceneResultBeforeUpload(fixture: NativeScenePrefix) {
            expect(await processing.ensureImageTaskResultProcessing(fixture.imageClaim)).toStrictEqual({ state: "waiting" });
            const waiting = await imageTasks.getImageTask(fixture.first.taskId);
            assert.ok(waiting?.resultProcessing);
            const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
            const workerId = "fixture-native-scene-upload-fault-worker";
            const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 6144 * 1024 * 1024, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const child = claimed.tasks[0];
            assert.ok(child && child.payload.operation === "process_result" && child.payload.options.mode === "scene_protection");
            expect(child.id).toBe(waiting.resultProcessing.jobId);
            const payload = child.payload;
            expect(payload.inputs).toHaveLength(3);
            expect(payload.options).toMatchObject({ sourceInputIndex: 1, maskInputIndex: 2, results: [{ resultId: fixture.first.taskId + ":1", resultIndex: 1, inputIndex: 0 }] });
            const identity = { workerId, executionId: child.executionId };
            const taskDirectory = await mkdtemp(path.join(directory, "native-scene-result-close-"));
            const inputRoute = await import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");
            const expectedInputs = [fixture.native, fixture.source, fixture.built.bytes];
            const inputs = await Promise.all(
                payload.inputs.map(async (input, index) => {
                    const response = await inputRoute.GET(
                        new Request(`${fixture.imageOrigin}/api/maintenance/image-processing/${child.id}/inputs/${encodeURIComponent(input.assetId)}`, {
                            headers: { authorization: `Bearer ${workerToken}`, "x-vozeb-pro-worker-id": workerId, "x-vozeb-pro-execution-id": child.executionId },
                        }),
                        { params: Promise.resolve({ id: child.id, assetId: input.assetId }) },
                    );
                    expect(response.status).toBe(200);
                    const bytes = Buffer.from(await response.arrayBuffer());
                    expect(bytes).toEqual(expectedInputs[index]);
                    expect(digest(bytes)).toBe(input.expectedSha256);
                    const filename = path.join(taskDirectory, `input-${index}.png`);
                    await writeFile(filename, bytes);
                    return { ...input, path: filename };
                }),
            );
            const outputDirectory = await mkdtemp(path.join(taskDirectory, "outputs-"));
            const closed = await runImageProcessing(
                { version: "image-processing.v1", operation: "process_result", options: payload.options, jobId: child.id, executionId: child.executionId, inputs, outputDirectory },
                { taskDirectory, maxHeapMiB: payload.resource.configuration.processHeapMb },
            );
            expect(closed).toMatchObject({ status: "completed", jobId: child.id, executionId: child.executionId, exitCode: 0, signal: null });
            assert.ok(closed.status === "completed" && closed.pid);
            const pid = closed.pid;
            expect(closed.result.metrics.pid).not.toBe(process.pid);
            expect(closed.result.metrics.peakRssBytes).toBeGreaterThan(0);
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            expect(closed.result.artifacts).toHaveLength(1);
            const artifact = closed.result.artifacts[0];
            assert.ok(artifact?.kind === "final" && artifact.resultId === fixture.first.taskId + ":1" && artifact.resultIndex === 1);
            const resultId = artifact.resultId;
            const bytes = await readFile(artifact.path);
            expect(artifact).toMatchObject({ mimeType: "image/png", width: 1024, height: 1024, bytes: bytes.length, sha256: digest(bytes) });
            expect(digest(bytes)).not.toBe(digest(fixture.native));
            expect(closed.result.results).toMatchObject([
                {
                    resultId: artifact.resultId,
                    nativeInputIndex: 0,
                    finalArtifactIndex: 0,
                    sceneProtectionEvidence: { nativeDigest: digest(fixture.native), maskDigest: digest(fixture.built.bytes), compositeDigest: digest(bytes), outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
                },
            ]);
            const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
            expect([...pixels.subarray(0, 4)]).toStrictEqual([18, 52, 86, 255]);
            expect([...pixels.subarray(1049600, 1049604)]).toStrictEqual([171, 205, 239, 255]);
            return { child, identity, closed, artifact, resultId, bytes };
        }

        async function uploadClosedNativeSceneFinal(fixture: NativeScenePrefix) {
            const current = await closeNativeSceneResultBeforeUpload(fixture);
            const outputRoute = await import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
            const response = await outputRoute.PUT(
                new Request(`${fixture.imageOrigin}/api/maintenance/image-processing/${current.child.id}/outputs/final?resultId=${encodeURIComponent(current.resultId)}`, {
                    method: "PUT",
                    headers: { authorization: `Bearer ${workerToken}`, "content-type": current.artifact.mimeType, "x-vozeb-pro-worker-id": current.identity.workerId, "x-vozeb-pro-execution-id": current.identity.executionId },
                    body: new Uint8Array(current.bytes),
                }),
                { params: Promise.resolve({ id: current.child.id, kind: "final" }) },
            );
            expect(response.status).toBe(201);
            const body: { code: number; data: StoredImageProcessingArtifact; msg: string } = await response.json();
            expect(body).toStrictEqual({ code: 0, data: body.data, msg: "OK" });
            const stored = body.data;
            expect(stored).toStrictEqual({ kind: "final", storageKey: expect.any(String), sha256: digest(current.bytes), mimeType: "image/png", bytes: current.bytes.length, width: 1024, height: 1024, resultId: current.resultId, resultIndex: 1 });
            const finalRegistration = await registrations.getLocalMediaRegistration(stored.storageKey);
            assert.ok(finalRegistration);
            expect(finalRegistration).toMatchObject({
                ownerUserId: userId,
                scope: "reference",
                storageClass: "temporary",
                type: "image",
                source: "image-processing-final",
                taskId: current.child.id,
                runId: fixture.paused.id,
                mimeType: stored.mimeType,
                bytes: current.bytes.length,
            });
            expect(finalRegistration.expiresAt).toBeTypeOf("string");
            const final = await references.readReferenceAsset(stored.storageKey);
            assert.ok(final);
            expect(await readFile(final.filePath)).toEqual(current.bytes);
            expect(await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey)).toStrictEqual(fixture.originalMaskRegistration);
            const staged = await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id);
            assert.ok(staged);
            expect(staged).toMatchObject({ status: "running", workerId: current.identity.workerId, payload: { executionId: current.identity.executionId } });
            expect(staged.resultPayload?.artifacts).toStrictEqual([stored]);
            expect(staged.resultPayload?.manifest).toBeUndefined();
            const image = await imageTasks.getImageTask(fixture.first.taskId);
            assert.ok(image);
            expect(image.status).toBe("running");
            expect(image.result).toBeUndefined();
            const { metrics, ...manifest } = current.closed.result;
            const completion: CompleteImageProcessingInput = { ...current.identity, manifest: { ...manifest, artifacts: [stored] }, metrics };
            return { ...current, stored, finalRegistration, finalPath: final.filePath, staged, completion };
        }

        async function nativeSceneControllerRows(controller: import("pg").Client, conversationId: string) {
            // This independent controller uses the same fixed physical prefix as the existing PG lock fixtures.
            const settings = await controller.query<SettingsRow>(
                "SELECT logical_models, default_models, model_point_costs, generation_concurrency, generation_defaults, ecommerce_generation_enabled, ecommerce_visual_quality_check_enabled, ecommerce_model_roles FROM vozeb_pro_app_settings WHERE id='default'",
            );
            expect(settings.rows).toHaveLength(1);
            return {
                rows: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_generation_tasks WHERE user_id=$1 ORDER BY id", [userId])).rows,
                registrations: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_local_media_assets WHERE owner_user_id=$1 ORDER BY storage_key", [userId])).rows,
                logs: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_generation_logs WHERE user_id=$1 ORDER BY id", [userId])).rows,
                logAssets: (
                    await controller.query<SqlRow>(
                        "SELECT asset.* FROM vozeb_pro_generation_log_assets AS asset JOIN vozeb_pro_generation_logs AS log ON log.id=asset.generation_log_id WHERE log.user_id=$1 ORDER BY asset.generation_log_id,asset.sort_order,asset.id",
                        [userId],
                    )
                ).rows,
                assets: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_creative_assets WHERE user_id=$1 AND conversation_id=$2 ORDER BY ordinal,id", [userId, conversationId])).rows,
                conversations: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_creative_conversations WHERE user_id=$1 AND id=$2 ORDER BY id", [userId, conversationId])).rows,
                messages: (
                    await controller.query<SqlRow>(
                        "SELECT message.* FROM vozeb_pro_creative_messages AS message JOIN vozeb_pro_creative_conversations AS conversation ON conversation.id=message.conversation_id WHERE conversation.user_id=$1 AND conversation.id=$2 ORDER BY message.id",
                        [userId, conversationId],
                    )
                ).rows,
                runEvents: (
                    await controller.query<SqlRow>(
                        "SELECT event.* FROM vozeb_pro_creative_run_events AS event JOIN vozeb_pro_generation_tasks AS run ON run.id=event.run_id WHERE run.user_id=$1 AND run.conversation_id=$2 AND run.task_type='agent' ORDER BY event.id",
                        [userId, conversationId],
                    )
                ).rows,
                account: {
                    users: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_users WHERE id=$1 ORDER BY id", [userId])).rows,
                    sessions: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_sessions WHERE user_id=$1 ORDER BY id", [userId])).rows,
                    pointRecords: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_point_records WHERE user_id=$1 ORDER BY id", [userId])).rows,
                    quotaUsage: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_quota_usage WHERE user_id=$1 ORDER BY date, usage_kind", [userId])).rows,
                    dailyWallets: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_daily_plan_point_wallets WHERE user_id=$1 ORDER BY date", [userId])).rows,
                    planAssignments: (await controller.query<SqlRow>("SELECT * FROM vozeb_pro_user_plan_assignments WHERE user_id=$1 ORDER BY id", [userId])).rows,
                    settings: settings.rows[0],
                },
                files: await storedFiles(),
            };
        }

        async function waitForNativeSceneRegistryBarrier(controller: import("pg").Client, appPid: number, controllerPid: number, identity: { taskId: string; workerId: string; executionId: string }, hasSettled: () => boolean) {
            for (;;) {
                await controller.query("SELECT pg_stat_clear_snapshot()");
                const observed = await controller.query<{ lockWait: boolean; controllerBlocks: boolean; registryQuery: boolean; leaseAlive: boolean; observedAt: Date; query: string }>(
                    `SELECT wait_event_type IS NOT DISTINCT FROM 'Lock' AS "lockWait",
                            $2::integer = ANY(pg_blocking_pids(pid)) AS "controllerBlocks",
                            query LIKE '%SELECT * FROM vozeb_pro_local_media_assets%' AND query LIKE '%storage_key = ANY(%' AND query LIKE '%FOR UPDATE%' AS "registryQuery",
                            EXISTS (SELECT 1 FROM vozeb_pro_generation_tasks AS task WHERE task.id=$3 AND task.user_id=$4 AND task.task_type='image' AND task.status='running' AND task.worker_id=$5 AND task.payload->>'executionId'=$6 AND task.lease_until>clock_timestamp() AND task.expires_at>clock_timestamp()) AS "leaseAlive",
                            clock_timestamp() AS "observedAt", query
                     FROM pg_stat_activity WHERE pid=$1`,
                    [appPid, controllerPid, identity.taskId, userId, identity.workerId, identity.executionId],
                );
                const state = observed.rows[0];
                assert.ok(state, "SETUP: application backend disappeared before the native mask registry barrier");
                if (hasSettled()) throw new Error("SETUP: native scene consumer settled before the real mask registry lock barrier");
                if (!state.leaseAlive) throw new Error("SETUP: current image claim expired before the native mask registry barrier");
                if (state.lockWait && state.controllerBlocks && state.registryQuery) return state;
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        }

        type SceneQaExpectation = { nativeSize: { width: number; height: number }; normalization: "none" | "uniform_scale"; insidePixel: number[] };

        async function completeNativeSceneQaCopy(fixture: NativeScenePrefix, copy: { requestId: string; taskId: string }, original: ImageTask, resultUrl: string, nativeBytes: Buffer, expected: SceneQaExpectation) {
            const sealed = await imageTasks.getImageTask(copy.taskId);
            assert.ok(sealed?.nativeResults);
            expect(sealed.result).toBeUndefined();
            const native = sealed.nativeResults.slots[0];
            assert.ok(native.status === "stored");
            const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
            const nativePath = path.join(REFERENCE_MEDIA_ROOT, native.storageKey);
            expect(await readFile(nativePath)).toEqual(nativeBytes);
            expect(native).toMatchObject({ resultId: copy.taskId + ":1", resultIndex: 1, sha256: digest(nativeBytes), bytes: nativeBytes.length });
            expect(await runtime.persistImageTaskResult(sealed, fixture.imageOrigin, resultUrl, boundary.cookie)).toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
            const waiting = await imageTasks.getImageTask(copy.taskId);
            assert.ok(waiting?.resultProcessing);
            const worker = await processWithWorker(waiting.resultProcessing.jobId);
            const payload = worker.child.payload;
            assert.ok(payload.operation === "process_result" && payload.options.mode === "scene_protection");
            assert.ok(fixture.task.sceneProtection);
            const { mask: _mask, ...protection } = fixture.task.sceneProtection;
            expect(payload.options).toStrictEqual({ mode: "scene_protection", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], sourceInputIndex: 1, maskInputIndex: 2, protection });
            expect(payload.sources.find((source) => source.inputIndex === 2)).toMatchObject({ scope: "reference", storageKey: fixture.built.stored.storageKey });
            expect(payload.parentMask).toStrictEqual({ inputIndex: 2, imageTaskId: copy.taskId });
            expect(worker.completion.manifest.results).toMatchObject([
                {
                    resultId: copy.taskId + ":1",
                    nativeInputIndex: 0,
                    finalArtifactIndex: 0,
                    sceneProtectionEvidence: {
                        ...protection,
                        nativeDigest: digest(nativeBytes),
                        maskDigest: digest(fixture.built.bytes),
                        nativeSize: expected.nativeSize,
                        normalization: expected.normalization,
                        outsidePixels: 983040,
                        compositeOutsideChangedPixels: 0,
                    },
                },
            ]);
            const final = worker.completion.manifest.artifacts[0];
            expect(final).toMatchObject({ kind: "final", resultId: copy.taskId + ":1", resultIndex: 1, width: 1024, height: 1024, mimeType: "image/png" });
            const saved = await references.readReferenceAsset(final.storageKey);
            assert.ok(saved);
            const finalBytes = await readFile(saved.filePath);
            expect(digest(finalBytes)).toBe(final.sha256);
            expect(finalBytes).toHaveLength(final.bytes);
            const pixels = await sharp(finalBytes).ensureAlpha().raw().toBuffer();
            expect([...pixels.subarray(0, 4)]).toStrictEqual([18, 52, 86, 255]);
            expect([...pixels.subarray(1049600, 1049604)]).toStrictEqual(expected.insidePixel);
            const recoveryInput = { origin: fixture.imageOrigin, cookie: boundary.cookie, workerId: "fixture-scene-qa-consumer-" + copy.taskId, taskIds: [copy.taskId], limit: 1 };
            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
            const published = await imageTasks.getImageTask(copy.taskId);
            assert.ok(published?.result?.results);
            expect(published).toMatchObject({
                id: copy.taskId,
                clientRequestId: copy.requestId,
                runId: fixture.paused.id,
                parentTaskId: fixture.paused.id,
                status: "success",
                billing: original.billing,
                attemptNo: original.attemptNo,
                upstream: original.upstream,
                nativeResults: sealed.nativeResults,
                resultProcessing: waiting.resultProcessing,
            });
            expect(published.attempts).toHaveLength(1);
            expect(published.result.results).toHaveLength(1);
            expect(published.result.results[0]).toMatchObject({
                resultId: copy.taskId + ":1",
                serverUrl: "/api/reference-assets/" + final.storageKey.split("/").map(encodeURIComponent).join("/"),
                canvasEvidence: { constraint: fixture.plan.canvas, nativeSize: expected.nativeSize, storedSize: { width: 1024, height: 1024 }, normalization: expected.normalization },
                sceneProtectionEvidence: { ...protection, nativeDigest: digest(nativeBytes), compositeDigest: final.sha256, outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
            });
            const finalRegistration = await registrations.getLocalMediaRegistration(final.storageKey);
            expect(finalRegistration).toMatchObject({ ownerUserId: userId, taskId: worker.child.id, runId: fixture.paused.id, storageClass: "permanent" });
            expect(finalRegistration?.expiresAt).toBeUndefined();
            const maskRegistration = await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey);
            expect(maskRegistration).toMatchObject({
                ownerUserId: userId,
                taskId: fixture.buildBefore.id,
                runId: fixture.paused.id,
                source: "image-processing-mask",
                scope: "reference",
                type: "image",
                storageClass: "permanent",
                bytes: fixture.built.bytes.length,
            });
            expect(maskRegistration?.expiresAt).toBeUndefined();
            const maskResponse = await fetch(fixture.imageOrigin + fixture.maskUrl, { headers: { cookie: boundary.cookie } });
            expect(maskResponse.status).toBe(200);
            expect(Buffer.from(await maskResponse.arrayBuffer())).toEqual(fixture.built.bytes);
            const asset = (await creative.listAssetsForUser(userId, fixture.conversation.id)).find((item) => item.sourceTaskId === copy.taskId);
            assert.ok(asset);
            return { worker, published, final, finalBytes, finalPath: saved.filePath, finalRegistration, nativePath, nativeBytes, recoveryInput, asset };
        }

        type SceneQaCopies = NativeScenePrefix & { firstResult: Awaited<ReturnType<typeof completeNativeSceneQaCopy>>; secondResult: Awaited<ReturnType<typeof completeNativeSceneQaCopy>> };

        async function withCompletedNativeSceneQaCopies(second: SceneQaExpectation, action: (fixture: SceneQaCopies) => Promise<void>) {
            await withNativeScenePrefix(async (fixture) => {
                assert.ok(fixture.dispatched.executionId);
                const firstResult = await completeNativeSceneQaCopy(fixture, fixture.first, fixture.submitted, fixture.step.resultUrl, fixture.native, {
                    nativeSize: { width: 1024, height: 1024 },
                    normalization: "none",
                    insidePixel: [171, 205, 239, 255],
                });
                await execution.executeTasks(fixture.paused.id, fixture.imageOrigin, boundary.cookie, fixture.dispatched.executionId);
                expect(await runs.getAgentRun(fixture.paused.id)).toMatchObject({
                    status: "running",
                    tasks: [
                        {
                            id: fixture.task.id,
                            status: "running",
                            childTasks: [expect.objectContaining({ id: fixture.first.taskId, status: "completed", attempt: 1 }), expect.objectContaining({ id: fixture.second.taskId, status: "pending", attempt: 1 })],
                        },
                    ],
                });
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(fixture.firstDebits);
                const [claim] = await scheduler.claimDueGenerationTasks({ workerId: "fixture-scene-qa-copy-two", taskIds: [fixture.second.taskId], limit: 1 });
                assert.ok(claim && typeof claim.payload.executionId === "string");
                const claimed = await imageTasks.getImageTask(fixture.second.taskId);
                assert.ok(claimed);
                expect(claimed.executionId).toBe(claim.payload.executionId);
                expect(await runtime.createImageTaskUpstreamStep(claimed, fixture.imageOrigin, fixture.imageOrigin, boundary.cookie)).toMatchObject({ state: "pending", upstream: { id: "fixture-upstream-" + fixture.second.taskId } });
                const submitted = await imageTasks.getImageTask(fixture.second.taskId);
                assert.ok(submitted?.upstream);
                const native = await sharp({ create: { ...second.nativeSize, channels: 3, background: "#fedcba" } })
                    .png()
                    .toBuffer();
                providerResults.set(submitted.upstream.id, { dataUrl: dataUrl(native), results: [{ dataUrl: dataUrl(native) }] });
                const step = await runtime.queryImageTaskUpstreamStep(submitted, fixture.imageOrigin, boundary.cookie);
                expect(step).toMatchObject({ state: "result_ready", status: "native_ready" });
                assert.ok(step.state === "result_ready");
                const secondResult = await completeNativeSceneQaCopy(fixture, fixture.second, submitted, step.resultUrl, native, second);
                expect(secondResult.worker.child.id).not.toBe(firstResult.worker.child.id);
                expect(secondResult.final.storageKey).not.toBe(firstResult.final.storageKey);
                expect(boundary.create).toHaveBeenCalledTimes(2);
                expect(boundary.poll).toHaveBeenCalledTimes(2);
                expect((await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).records).toHaveLength(2);
                await action({ ...fixture, firstResult, secondResult });
            });
        }

        async function observeNativeSceneQaPixels(action: () => Promise<void>) {
            const webSharp = (await import("sharp")).default;
            const spies = {
                raw: vi.spyOn(webSharp.prototype, "raw"),
                stats: vi.spyOn(webSharp.prototype, "stats"),
                resize: vi.spyOn(webSharp.prototype, "resize"),
                toBuffer: vi.spyOn(webSharp.prototype, "toBuffer"),
                toFile: vi.spyOn(webSharp.prototype, "toFile"),
            };
            try {
                await action();
                return { pid: process.pid, raw: spies.raw.mock.calls.length, stats: spies.stats.mock.calls.length, resize: spies.resize.mock.calls.length, toBuffer: spies.toBuffer.mock.calls.length, toFile: spies.toFile.mock.calls.length };
            } finally {
                spies.raw.mockRestore();
                spies.stats.mockRestore();
                spies.resize.mockRestore();
                spies.toBuffer.mockRestore();
                spies.toFile.mockRestore();
            }
        }

        function sceneQaImageWithoutTrace(image: ImageTask) {
            const { ecommerceTrace: _trace, updatedAt: _updatedAt, ...rest } = image;
            return rest;
        }

        function sceneQaLogWithoutTrace(log: Awaited<ReturnType<typeof logs.listGenerationLogs>>["items"][number]) {
            const { ecommerceTrace: _trace, updatedAt: _updatedAt, ...rest } = log;
            return rest;
        }

        async function replayNativeSceneQaCopies(fixture: SceneQaCopies) {
            const first = await imageTasks.getImageTask(fixture.first.taskId);
            const second = await imageTasks.getImageTask(fixture.second.taskId);
            const before = await ownedRows(fixture.conversation.id);
            expect(await service.completeImageProcessingTask(fixture.firstResult.worker.child.id, fixture.firstResult.worker.completion)).toStrictEqual(fixture.firstResult.worker.receipt);
            expect(await service.completeImageProcessingTask(fixture.secondResult.worker.child.id, fixture.secondResult.worker.completion)).toStrictEqual(fixture.secondResult.worker.receipt);
            expect(await recovery.runGenerationTaskRecoveryBatch(fixture.firstResult.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
            expect(await recovery.runGenerationTaskRecoveryBatch(fixture.secondResult.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
            expect(await runtime.persistImageTaskResult(fixture.firstResult.published, fixture.imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(first);
            expect(await runtime.persistImageTaskResult(fixture.secondResult.published, fixture.imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(second);
            expect(await ownedRows(fixture.conversation.id)).toStrictEqual(before);
        }

        it("blocks a same-length changed native scene final during Agent technical QA without Web pixels", async () => {
            await withCompletedNativeSceneQaCopies({ nativeSize: { width: 1024, height: 1024 }, normalization: "none", insidePixel: [254, 220, 186, 255] }, async (fixture) => {
                const executionId = fixture.dispatched.executionId;
                assert.ok(executionId);
                const firstImage = await imageTasks.getImageTask(fixture.first.taskId);
                const secondImage = await imageTasks.getImageTask(fixture.second.taskId);
                assert.ok(firstImage && secondImage);
                const prepare = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id);
                const build = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id);
                const firstStage = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.firstResult.worker.child.id);
                const secondStage = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.secondResult.worker.child.id);
                const maskRegistration = await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey);
                const firstRegistration = await registrations.getLocalMediaRegistration(fixture.firstResult.final.storageKey);
                const secondRegistration = await registrations.getLocalMediaRegistration(fixture.secondResult.final.storageKey);
                const assets = await creative.listAssetsForUser(userId, fixture.conversation.id);
                const priorLogs = (await logs.listGenerationLogs({ userId })).items;
                const account = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                const changed = Buffer.from(fixture.secondResult.finalBytes);
                changed[changed.length - 1] ^= 1;
                expect(changed).toHaveLength(fixture.secondResult.final.bytes);
                expect(digest(changed)).not.toBe(fixture.secondResult.final.sha256);
                let noWebPixels: Awaited<ReturnType<typeof observeNativeSceneQaPixels>>;
                await writeFile(fixture.secondResult.finalPath, changed);
                try {
                    expect(await readFile(fixture.secondResult.finalPath)).toEqual(changed);
                    expect(await registrations.getLocalMediaRegistration(fixture.secondResult.final.storageKey)).toStrictEqual(secondRegistration);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.secondResult.worker.child.id)).toStrictEqual(secondStage);
                    noWebPixels = await observeNativeSceneQaPixels(() => execution.executeTasks(fixture.paused.id, fixture.imageOrigin, boundary.cookie, executionId));
                    const refused = await runs.getAgentRun(fixture.paused.id);
                    expect(refused).toMatchObject({
                        status: "paused",
                        tasks: [{ id: fixture.task.id, status: "needs_review", count: 2, attempts: 1, assetIds: [], taskIds: [fixture.first.taskId, fixture.second.taskId] }],
                        ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "blocked", hardFailures: [{ resultId: fixture.second.taskId + ":1", key: "unmodified_region", status: "failed", reason: "参考原件内容已变化" }] } },
                    });
                    expect(refused?.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                    const firstAfter = await imageTasks.getImageTask(fixture.first.taskId);
                    const secondAfter = await imageTasks.getImageTask(fixture.second.taskId);
                    assert.ok(firstAfter && secondAfter);
                    expect(sceneQaImageWithoutTrace(firstAfter)).toStrictEqual(sceneQaImageWithoutTrace(firstImage));
                    expect(sceneQaImageWithoutTrace(secondAfter)).toStrictEqual(sceneQaImageWithoutTrace(secondImage));
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(prepare);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(build);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.firstResult.worker.child.id)).toStrictEqual(firstStage);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.secondResult.worker.child.id)).toStrictEqual(secondStage);
                    expect(await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey)).toStrictEqual(maskRegistration);
                    expect(await registrations.getLocalMediaRegistration(fixture.firstResult.final.storageKey)).toStrictEqual(firstRegistration);
                    expect(await registrations.getLocalMediaRegistration(fixture.secondResult.final.storageKey)).toStrictEqual(secondRegistration);
                    expect(await creative.listAssetsForUser(userId, fixture.conversation.id)).toStrictEqual(assets);
                    expect((await logs.listGenerationLogs({ userId })).items.map(sceneQaLogWithoutTrace)).toStrictEqual(priorLogs.map(sceneQaLogWithoutTrace));
                    expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(account);
                    expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(debits);
                    expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                    expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                    expect(await readFile(fixture.firstResult.nativePath)).toEqual(fixture.firstResult.nativeBytes);
                    expect(await readFile(fixture.secondResult.nativePath)).toEqual(fixture.secondResult.nativeBytes);
                    expect(await readFile(fixture.firstResult.finalPath)).toEqual(fixture.firstResult.finalBytes);
                    expect(await readFile(fixture.secondResult.finalPath)).toEqual(changed);
                    expect(boundary.create).toHaveBeenCalledTimes(2);
                    expect(boundary.poll).toHaveBeenCalledTimes(2);
                } finally {
                    await writeFile(fixture.secondResult.finalPath, fixture.secondResult.finalBytes);
                }
                expect(await readFile(fixture.secondResult.finalPath)).toEqual(fixture.secondResult.finalBytes);
                await replayNativeSceneQaCopies(fixture);
                expect(noWebPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
            });
        }, 120_000);

        it("adopts a uniform-scale native scene result through Agent technical QA without Web pixels", async () => {
            await withCompletedNativeSceneQaCopies({ nativeSize: { width: 512, height: 512 }, normalization: "uniform_scale", insidePixel: [254, 220, 186, 255] }, async (fixture) => {
                const executionId = fixture.dispatched.executionId;
                assert.ok(executionId);
                const firstImage = await imageTasks.getImageTask(fixture.first.taskId);
                const secondImage = await imageTasks.getImageTask(fixture.second.taskId);
                assert.ok(firstImage && secondImage);
                const firstStage = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.firstResult.worker.child.id);
                const secondStage = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.secondResult.worker.child.id);
                const maskRegistration = await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey);
                const firstRegistration = await registrations.getLocalMediaRegistration(fixture.firstResult.final.storageKey);
                const secondRegistration = await registrations.getLocalMediaRegistration(fixture.secondResult.final.storageKey);
                const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                const result = fixture.secondResult.worker.completion.manifest.results?.[0];
                assert.ok(result && !result.error);
                const scene = result.sceneProtectionEvidence;
                expect(scene).toMatchObject({
                    nativeSize: { width: 512, height: 512 },
                    sourceSize: { width: 1024, height: 1024 },
                    normalization: "uniform_scale",
                    outsidePixels: 983040,
                    mappedOutsideChangedPixels: 983040,
                    compositeOutsideChangedPixels: 0,
                });
                expect(scene?.nativeOutsideChangedPixels).toBeUndefined();
                const noWebPixels = await observeNativeSceneQaPixels(() => execution.executeTasks(fixture.paused.id, fixture.imageOrigin, boundary.cookie, executionId));
                const completed = await runs.getAgentRun(fixture.paused.id);
                expect(completed).toMatchObject({
                    status: "completed",
                    tasks: [{ id: fixture.task.id, status: "completed", count: 2, attempts: 1, taskIds: [fixture.first.taskId, fixture.second.taskId] }],
                    ecommerceSnapshot: {
                        qualityPolicy: "disabled",
                        technicalCheck: {
                            status: "passed",
                            hardFailures: [],
                            canvasEvidence: [
                                {
                                    resultId: fixture.first.taskId + ":1",
                                    nativeSize: { width: 1024, height: 1024 },
                                    storedSize: { width: 1024, height: 1024 },
                                    nativeMatches: true,
                                    storedMatches: true,
                                    normalization: "none",
                                    mappingVerified: false,
                                    hardFailures: [],
                                },
                                {
                                    resultId: fixture.second.taskId + ":1",
                                    nativeSize: { width: 512, height: 512 },
                                    storedSize: { width: 1024, height: 1024 },
                                    nativeStatus: "readable",
                                    storedStatus: "readable",
                                    nativeMatches: false,
                                    storedMatches: true,
                                    normalization: "uniform_scale",
                                    mappingVerified: true,
                                    hardFailures: [],
                                },
                            ],
                        },
                    },
                });
                expect(completed?.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                expect(completed?.ecommerceSnapshot?.technicalCheck?.checks).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ resultId: fixture.second.taskId + ":1", key: "unmodified_region", status: "passed", reason: "actualOutsidePixels=983040;actualChangedPixels=0;mappedChangedPixels=983040;normalization=uniform_scale" }),
                    ]),
                );
                expect(completed?.assetIds).toEqual(expect.arrayContaining([fixture.firstResult.asset.id, fixture.secondResult.asset.id]));
                const assets = await creative.listAssetsForUser(userId, fixture.conversation.id);
                expect(assets).toHaveLength(3);
                expect(assets.find((asset) => asset.id === fixture.secondResult.asset.id)).toMatchObject({
                    parentAssetId: fixture.baseline.id,
                    sourceRunId: fixture.paused.id,
                    sourceTaskId: fixture.second.taskId,
                    messageId: fixture.initial.assistantMessageId,
                    metadata: { agentTaskId: fixture.task.id },
                });
                const firstAfter = await imageTasks.getImageTask(fixture.first.taskId);
                const secondAfter = await imageTasks.getImageTask(fixture.second.taskId);
                assert.ok(firstAfter && secondAfter);
                expect(sceneQaImageWithoutTrace(firstAfter)).toStrictEqual(sceneQaImageWithoutTrace(firstImage));
                expect(sceneQaImageWithoutTrace(secondAfter)).toStrictEqual(sceneQaImageWithoutTrace(secondImage));
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.firstResult.worker.child.id)).toStrictEqual(firstStage);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.secondResult.worker.child.id)).toStrictEqual(secondStage);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
                expect(await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey)).toStrictEqual(maskRegistration);
                expect(await registrations.getLocalMediaRegistration(fixture.firstResult.final.storageKey)).toStrictEqual(firstRegistration);
                expect(await registrations.getLocalMediaRegistration(fixture.secondResult.final.storageKey)).toStrictEqual(secondRegistration);
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                expect(await readFile(fixture.firstResult.nativePath)).toEqual(fixture.firstResult.nativeBytes);
                expect(await readFile(fixture.secondResult.nativePath)).toEqual(fixture.secondResult.nativeBytes);
                expect(await readFile(fixture.firstResult.finalPath)).toEqual(fixture.firstResult.finalBytes);
                expect(await readFile(fixture.secondResult.finalPath)).toEqual(fixture.secondResult.finalBytes);
                expect((await logs.listGenerationLogs({ userId })).items).toHaveLength(2);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(debits);
                expect(boundary.create).toHaveBeenCalledTimes(2);
                expect(boundary.poll).toHaveBeenCalledTimes(2);
                await replayNativeSceneQaCopies(fixture);
                expect(noWebPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
            });
        }, 120_000);

        type NativeSceneLifecyclePrefix = Pick<
            NativeScenePrefix,
            | "conversation"
            | "source"
            | "baseline"
            | "registeredSource"
            | "paused"
            | "receipt"
            | "prepareBefore"
            | "buildBefore"
            | "built"
            | "registeredMask"
            | "originalMaskRegistration"
            | "maskUrl"
            | "imageOrigin"
            | "created"
            | "dispatched"
            | "task"
            | "first"
            | "second"
            | "siblingRecord"
        > & {
            firstBefore: ImageTask;
            secondBefore: ImageTask;
        };

        async function withNativeSceneLifecyclePrefix(action: (fixture: NativeSceneLifecyclePrefix) => Promise<void>) {
            const route = await configureNativeScenePlanning();
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Native prepared scene Run copies" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();
            const baseline = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "native-scene.png", { type: "image/png" }));
            assert.ok(baseline.storageKey && baseline.serverUrl);
            const registeredSource = await references.readReferenceAsset(baseline.storageKey);
            assert.ok(registeredSource);
            expect(await readFile(registeredSource.filePath)).toEqual(source);
            installNativeScenePlanningReplies(baseline.id);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-scene-result-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，在柜子上增加花瓶和接触阴影，只修改局部，保留其他区域和原图尺寸",
                    assetIds: [baseline.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 2, quality: "low", size: "1024x1024" } },
                })
            ).run;
            const noDebits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
            expect(noDebits.records).toStrictEqual([]);
            await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
            await withSceneRoutes(initial.id, async (sceneOrigin) => {
                await claimNativeSceneRun(initial.id, "fixture-native-result-prepare-parent", sceneOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                expect(prepare.payload.inputs).toMatchObject([{ assetId: baseline.id }]);
                const prepared = await completeNativeSceneStage(prepare.id);
                const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id);
                assert.ok(prepareBefore?.resultPayload?.manifestDigest);
                expect(prepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { executionId: prepared.child.executionId, manifest: prepared.completion.manifest } });
                const paused = await claimNativeSceneRun(initial.id, "fixture-native-result-planning-parent", sceneOrigin);
                expect(paused, JSON.stringify({ run: paused, modelCalls: boundary.model.mock.calls.map(([request]) => ({ tool: request.tool.name, messages: request.messages })) })).toMatchObject({
                    status: "paused",
                    tasks: [{ id: "ecommerce-scene-edit", type: "image", status: "needs_review", count: 2, attempts: 0 }],
                    ecommerceSnapshot: {
                        mode: "active",
                        qualityPolicy: "disabled",
                        fallback: { reason: "scene_selection_required" },
                        referenceCheckpoint: { state: "resolved", analysisStage: { state: "completed" } },
                        plan: { operation: "scene_edit", canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false }, protection: { scope: "local", preserveOutsideMask: true } },
                    },
                });
                expect(paused.tasks).toHaveLength(1);
                const originalTask = structuredClone(paused.tasks[0]);
                expect(originalTask.sceneProtection).toBeUndefined();
                expect(originalTask.childTasks).toBeUndefined();
                const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
                const profile = resolveEcommerceImageProviderProfile(route.snapshot);
                const snapshot = paused.ecommerceSnapshot;
                assert.ok(profile?.supportsIndependentMask && snapshot?.plan && snapshot.referenceCheckpoint);
                const plan = snapshot.plan;
                const referenceCheckpoint = snapshot.referenceCheckpoint;
                expect(compileEcommerceImageRequest(snapshot.plan, profile)).toStrictEqual(originalTask.ecommerceExecution);
                expect(snapshot.processing?.prepareReferences).toMatchObject([{ jobId: prepare.id, inputDigest: prepare.payload.inputDigest, assetId: baseline.id, manifest: prepared.completion.manifest }]);
                const response = await fetch(sceneOrigin + "/api/agent/runs/" + paused.id + "/resume", {
                    method: "POST",
                    headers: { cookie: boundary.cookie, "content-type": "application/json" },
                    body: JSON.stringify({ conversationId: conversation.id, sceneSelection: { baselineAssetId: baseline.id, region: { x: 256, y: 256, width: 256, height: 256 } } }),
                });
                expect(response.status, "SETUP: actual authenticated Action must persist the native selection receipt").toBe(200);
                const confirmed = await runs.getAgentRun(paused.id);
                const receipt = confirmed?.ecommerceSnapshot?.processing?.sceneSelection;
                assert.ok(confirmed && receipt);
                expect(confirmed.tasks).toStrictEqual(paused.tasks);
                expect(receipt).toMatchObject({
                    parentTaskId: originalTask.id,
                    confirmation: { actorUserId: userId },
                    baseline: { assetId: baseline.id, sha256: digest(source), width: 1024, height: 1024 },
                    region: { x: 256, y: 256, width: 256, height: 256 },
                    prepare: { jobId: prepare.id, inputDigest: prepare.payload.inputDigest, executionId: prepared.child.executionId, manifestDigest: prepareBefore.resultPayload.manifestDigest },
                });
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([paused.id], [userId])).filter((row) => row.type === "image_processing")).toStrictEqual([prepareBefore]);
                await claimNativeSceneRun(paused.id, "fixture-native-result-claim-a", sceneOrigin);
                const build = await nativeSceneWaitingStage(paused.id, "build_protection", originalTask.id);
                const built = await completeNativeSceneStage(build.id);
                const buildBefore = await tasks.getStoredGenerationTaskRecord("image_processing", build.id);
                assert.ok(buildBefore);
                expect(buildBefore).toMatchObject({
                    status: "success",
                    executionPhase: "completed",
                    resultPayload: { executionId: built.child.executionId, manifestDigest: service.imageProcessingManifestDigest(built.completion.manifest), manifest: built.completion.manifest },
                });
                expect(built.completion.manifest.sourceIdentities).toMatchObject([{ assetId: baseline.id, assetVersion: receipt.baseline.assetVersion, sha256: digest(source), bytes: source.length, width: 1024, height: 1024 }]);
                expect(built.completion.manifest.geometry.sceneProtection).toMatchObject({
                    sourceDigest: digest(source),
                    sourceSize: { width: 1024, height: 1024 },
                    maskDigest: digest(built.bytes),
                    targetRegion: receipt.region,
                    semantics: receipt.semantics,
                    selectionSource: "user_selection",
                    maskSemantics: "alpha_zero_edit",
                    method: "source_pixels_copy",
                });
                expect(built.completion.manifest.geometry.sceneProtection?.confirmation).toBeUndefined();
                const registeredMask = await references.readReferenceAsset(built.stored.storageKey);
                assert.ok(registeredMask);
                const originalMaskRegistration = registeredMask.registration;
                expect(registeredMask.registration).toMatchObject({
                    ownerUserId: userId,
                    source: "image-processing-mask",
                    scope: "reference",
                    type: "image",
                    taskId: build.id,
                    runId: paused.id,
                    storageClass: "temporary",
                    mimeType: "image/png",
                    bytes: built.bytes.length,
                });
                expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(noDebits);
                const maskUrl = "/api/reference-assets/" + built.stored.storageKey.split("/").map(encodeURIComponent).join("/");

                await withImageRoutes(confirmed, originalTask, async (imageOrigin, created) => {
                    const dispatched = await claimNativeSceneRun(paused.id, "fixture-native-result-claim-b", imageOrigin);
                    const task = dispatched.tasks[0];
                    assert.ok(dispatched.executionId && task.sceneProtection);
                    expect(dispatched).toMatchObject({ status: "running", tasks: [{ id: originalTask.id, count: 2, attempts: 1, status: "running" }] });
                    expect(created).toHaveLength(2);
                    const first = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + task.id + ":1:1");
                    const second = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + task.id + ":1:2");
                    assert.ok(first && second);
                    expect(first.taskId).not.toBe(second.taskId);
                    expect(task.taskIds).toEqual(expect.arrayContaining([first.taskId, second.taskId]));
                    expect(task.childTasks).toHaveLength(2);
                    expect(task.childTasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.taskId, status: "pending", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "pending", attempt: 1 })]));
                    expect(task.sceneProtection.mask).toMatchObject({ dataUrl: "", serverUrl: maskUrl, type: "image/png", width: 1024, height: 1024 });
                    expect(task.sceneProtection.confirmation).toStrictEqual(receipt.confirmation);
                    expect(dispatched.ecommerceSnapshot).toMatchObject({ plan: snapshot.plan, compilerVersion: snapshot.compilerVersion, modelRouteSnapshots: snapshot.modelRouteSnapshots, referenceCheckpoint: snapshot.referenceCheckpoint });
                    expect(dispatched.ecommerceSnapshot?.processing?.sceneSelection).toStrictEqual(receipt);
                    expect(dispatched.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
                    const { readCompletedEcommerceSceneProtection } = await import("./ecommerce-protection-preparation");
                    const evidence = await readCompletedEcommerceSceneProtection(dispatched);
                    expect(evidence.sceneProtection).toStrictEqual(task.sceneProtection);
                    expect(evidence.stage.id).toBe(build.id);
                    expect(evidence.maskRegistration).toStrictEqual({
                        ...registeredMask.registration,
                        conversationId: undefined,
                        externalObjectKey: undefined,
                        externalStorageId: undefined,
                        externalSyncedAt: undefined,
                        originalName: undefined,
                        projectId: undefined,
                    });
                    const firstBefore = await imageTasks.getImageTask(first.taskId);
                    const secondBefore = await imageTasks.getImageTask(second.taskId);
                    const siblingRecord = await tasks.getStoredGenerationTaskRecord("image", second.taskId);
                    assert.ok(firstBefore && secondBefore && siblingRecord);
                    expect(firstBefore).toMatchObject({
                        id: first.taskId,
                        runId: paused.id,
                        parentTaskId: paused.id,
                        userId,
                        conversationId: conversation.id,
                        clientRequestId: first.requestId,
                        status: "pending",
                        kind: "edit",
                        references: [{ id: baseline.id, ecommerceRole: "scene", url: baseline.serverUrl }],
                        ecommerceExecution: originalTask.ecommerceExecution,
                        sceneProtection: task.sceneProtection,
                        mask: task.sceneProtection.mask,
                        referenceDispatch: { copy: 1, inputId: referenceCheckpoint.inputId, decisionId: referenceCheckpoint.decisionId, analysisRequestId: referenceCheckpoint.analysisStage.requestId },
                    });
                    expect(secondBefore).toMatchObject({ id: second.taskId, status: "pending", clientRequestId: second.requestId, referenceDispatch: { copy: 2 }, sceneProtection: task.sceneProtection, mask: task.sceneProtection.mask });
                    expect(firstBefore.attempts).toBeUndefined();
                    expect(firstBefore.billing).toBeUndefined();
                    expect(firstBefore.upstream).toBeUndefined();
                    expect(secondBefore.attempts).toBeUndefined();
                    expect(secondBefore.billing).toBeUndefined();
                    expect(secondBefore.upstream).toBeUndefined();
                    expect(boundary.create).not.toHaveBeenCalled();
                    await action({
                        conversation,
                        source,
                        baseline,
                        registeredSource,
                        paused,
                        receipt,
                        prepareBefore,
                        buildBefore,
                        built,
                        registeredMask,
                        originalMaskRegistration,
                        maskUrl,
                        imageOrigin,
                        created,
                        dispatched,
                        task,
                        first,
                        second,
                        siblingRecord,
                        firstBefore,
                        secondBefore,
                    });
                });
            });
        }

        async function nativeSceneLifecyclePostgresRows(conversationId: string) {
            const snapshot = await ownedRows(conversationId);
            assert.ok("account" in snapshot);
            return snapshot;
        }

        async function expectNativeSceneLifecycleBindings(fixture: NativeSceneLifecyclePrefix, before: Awaited<ReturnType<typeof nativeSceneLifecyclePostgresRows>>, balance: 98 | 100) {
            const after = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
            assert.ok(before.account && after.account);
            expect(after.rows.filter((row) => row.id !== fixture.first.taskId)).toStrictEqual(before.rows.filter((row) => row.id !== fixture.first.taskId));
            expect({ registrations: after.registrations, logAssets: after.logAssets, assets: after.assets, conversations: after.conversations, messages: after.messages, runEvents: after.runEvents, files: after.files }).toStrictEqual({
                registrations: before.registrations,
                logAssets: before.logAssets,
                assets: before.assets,
                conversations: before.conversations,
                messages: before.messages,
                runEvents: before.runEvents,
                files: before.files,
            });
            expect({ ...after.account, users: before.account.users, pointRecords: before.account.pointRecords }).toStrictEqual(before.account);
            expect(before.account.users).toHaveLength(1);
            expect(after.account.users).toHaveLength(1);
            const originalUser = before.account.users[0];
            const currentUser = after.account.users[0];
            assert.ok(originalUser && currentUser);
            expect({ ...currentUser, points_balance: originalUser.points_balance, updated_at: originalUser.updated_at }).toStrictEqual(originalUser);
            expect(Number(currentUser.points_balance)).toBe(balance);
            expect(currentUser.updated_at).toBeInstanceOf(Date);
            const originalPoints = new Set(before.account.pointRecords.map((row) => row.id));
            expect(after.account.pointRecords.filter((row) => originalPoints.has(row.id))).toStrictEqual(before.account.pointRecords);
            const image = await imageTasks.getImageTask(fixture.first.taskId);
            assert.ok(image);
            const original = fixture.firstBefore;
            expect({
                id: image.id,
                userId: image.userId,
                runId: image.runId,
                parentTaskId: image.parentTaskId,
                clientRequestId: image.clientRequestId,
                conversationId: image.conversationId,
                surface: image.surface,
                projectId: image.projectId,
                config: image.config,
                references: image.references,
                referenceDispatch: image.referenceDispatch,
                ecommerceExecution: image.ecommerceExecution,
                sceneProtection: image.sceneProtection,
                mask: image.mask,
                createdAt: image.createdAt,
                generationLogId: image.generationLogId,
                generationSlotId: image.generationSlotId,
            }).toStrictEqual({
                id: original.id,
                userId: original.userId,
                runId: original.runId,
                parentTaskId: original.parentTaskId,
                clientRequestId: original.clientRequestId,
                conversationId: original.conversationId,
                surface: original.surface,
                projectId: original.projectId,
                config: original.config,
                references: original.references,
                referenceDispatch: original.referenceDispatch,
                ecommerceExecution: original.ecommerceExecution,
                sceneProtection: original.sceneProtection,
                mask: original.mask,
                createdAt: original.createdAt,
                generationLogId: original.generationLogId,
                generationSlotId: original.generationSlotId,
            });
            expect(fixture.created).toHaveLength(2);
            expect(await imageTasks.getImageTask(fixture.second.taskId)).toStrictEqual(fixture.secondBefore);
            expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
            expect(await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey)).toStrictEqual(fixture.originalMaskRegistration);
            expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
            expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
            return after;
        }

        async function withNativeSceneTerminalQueries(action: (origin: string, queries: string[]) => Promise<void>) {
            const queries: string[] = [];
            const failure = Promise.withResolvers<never>();
            const bodies = new Map([
                ["/native-lifecycle/attempt-1", { status: "failed", msg: "native lifecycle upstream one failed" }],
                ["/native-lifecycle/attempt-2", { status: "failed", msg: "native lifecycle upstream two failed" }],
            ]);
            const server = createServer((request, response) => {
                try {
                    expect(request.method).toBe("GET");
                    expect(request.headers.cookie).toBe(boundary.cookie);
                    assert.ok(request.url);
                    const body = bodies.get(request.url);
                    assert.ok(body, "SETUP: only the two declared original upstream query paths are accepted");
                    queries.push(request.url);
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(JSON.stringify(body));
                } catch (error) {
                    failure.reject(error);
                    response.writeHead(500);
                    response.end();
                }
            });
            let pending: Promise<void> | undefined;
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", () => {
                        server.off("error", reject);
                        resolve();
                    });
                });
                server.on("error", (error) => failure.reject(error));
                const address = server.address();
                assert.ok(address && typeof address !== "string");
                pending = action(`http://127.0.0.1:${address.port}`, queries);
                await Promise.race([pending, failure.promise]);
            } finally {
                server.closeAllConnections();
                try {
                    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                } finally {
                    if (pending)
                        await drainLiveRequests(
                            pending.then(
                                () => undefined,
                                () => undefined,
                            ),
                            "CLEANUP: native lifecycle query action did not drain after TCP close",
                        );
                }
            }
        }

        type NativeScene4kBuild = Pick<NativeScenePrefix, "conversation" | "source" | "baseline" | "registeredSource" | "initial" | "paused" | "receipt" | "prepareBefore" | "buildBefore" | "built" | "registeredMask"> & {
            sourceKey: string;
            sourceUrl: string;
            noDebits: Awaited<ReturnType<typeof auth.listPointRecordsPage>>;
            prepare: Awaited<ReturnType<typeof nativeSceneWaitingStage>>;
            build: Awaited<ReturnType<typeof nativeSceneWaitingStage>>;
            originalTask: AgentRunTask;
            snapshot: NonNullable<AgentRun["ecommerceSnapshot"]>;
            referenceCheckpoint: NonNullable<NonNullable<AgentRun["ecommerceSnapshot"]>["referenceCheckpoint"]>;
            confirmed: AgentRun;
            sourceRegistration: NonNullable<Awaited<ReturnType<typeof registrations.getLocalMediaRegistration>>>;
            maskRegistration: NonNullable<Awaited<ReturnType<typeof registrations.getLocalMediaRegistration>>>;
            maskUrl: string;
        };

        async function withNativeScene4kBuild(action: (fixture: NativeScene4kBuild) => Promise<void>) {
            await configureNativeScenePlanning();
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Native scene 4k baseline freeze" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();
            const baseline = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "native-scene-4k-baseline.png", { type: "image/png" }));
            assert.ok(baseline.storageKey && baseline.serverUrl);
            const sourceKey = baseline.storageKey;
            const sourceUrl = baseline.serverUrl;
            const registeredSource = await references.readReferenceAsset(sourceKey);
            assert.ok(registeredSource);
            installNativeScenePlanningReplies(baseline.id);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-scene-4k-freeze-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，在柜子上增加花瓶和接触阴影，只修改局部，保留其他区域和原图尺寸",
                    assetIds: [baseline.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 2, quality: "4k", size: "1024x1024" } },
                })
            ).run;
            const noDebits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
            expect(noDebits.records).toStrictEqual([]);
            await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
            await withSceneRoutes(initial.id, async (sceneOrigin) => {
                await claimNativeSceneRun(initial.id, "fixture-4k-freeze-prepare-parent", sceneOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                const prepared = await completeNativeSceneStage(prepare.id);
                const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id);
                assert.ok(prepareBefore?.resultPayload?.manifestDigest);
                expect(prepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { executionId: prepared.child.executionId, manifest: prepared.completion.manifest } });
                const paused = await claimNativeSceneRun(initial.id, "fixture-4k-freeze-planning-parent", sceneOrigin);
                expect(paused).toMatchObject({
                    status: "paused",
                    tasks: [{ id: "ecommerce-scene-edit", status: "needs_review", count: 2, attempts: 0, quality: "4k" }],
                    ecommerceSnapshot: {
                        mode: "active",
                        qualityPolicy: "disabled",
                        fallback: { reason: "scene_selection_required" },
                        plan: { operation: "scene_edit", canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false }, protection: { scope: "local", preserveOutsideMask: true } },
                    },
                });
                const originalTask = structuredClone(paused.tasks[0]);
                const snapshot = paused.ecommerceSnapshot;
                assert.ok(snapshot?.referenceCheckpoint);
                const referenceCheckpoint = snapshot.referenceCheckpoint;
                expect(originalTask.sceneProtection).toBeUndefined();
                const response = await fetch(sceneOrigin + "/api/agent/runs/" + paused.id + "/resume", {
                    method: "POST",
                    headers: { cookie: boundary.cookie, "content-type": "application/json" },
                    body: JSON.stringify({ conversationId: conversation.id, sceneSelection: { baselineAssetId: baseline.id, region: { x: 256, y: 256, width: 256, height: 256 } } }),
                });
                expect(response.status, "SETUP: actual authenticated Action must retain the original 4k Run and persist its selection receipt").toBe(200);
                const confirmed = await runs.getAgentRun(paused.id);
                const receipt = confirmed?.ecommerceSnapshot?.processing?.sceneSelection;
                assert.ok(confirmed && receipt);
                expect(confirmed.tasks).toStrictEqual(paused.tasks);
                expect(receipt).toMatchObject({
                    parentTaskId: originalTask.id,
                    confirmation: { actorUserId: userId },
                    baseline: { assetId: baseline.id, sha256: digest(source), bytes: source.length, width: 1024, height: 1024 },
                    region: { x: 256, y: 256, width: 256, height: 256 },
                    prepare: { jobId: prepare.id, inputDigest: prepare.payload.inputDigest, executionId: prepared.child.executionId, manifestDigest: prepareBefore.resultPayload.manifestDigest },
                });
                await claimNativeSceneRun(paused.id, "fixture-4k-freeze-build-parent", sceneOrigin);
                const build = await nativeSceneWaitingStage(paused.id, "build_protection", originalTask.id);
                const built = await completeNativeSceneStage(build.id);
                const buildBefore = await tasks.getStoredGenerationTaskRecord("image_processing", build.id);
                assert.ok(buildBefore);
                expect(buildBefore).toMatchObject({
                    status: "success",
                    executionPhase: "completed",
                    resultPayload: { executionId: built.child.executionId, manifestDigest: service.imageProcessingManifestDigest(built.completion.manifest), manifest: built.completion.manifest },
                });
                expect(built.completion.manifest.sourceIdentities).toMatchObject([{ assetId: baseline.id, assetVersion: receipt.baseline.assetVersion, sha256: digest(source), bytes: source.length, width: 1024, height: 1024 }]);
                expect(built.completion.manifest.geometry.sceneProtection).toMatchObject({
                    sourceDigest: digest(source),
                    sourceSize: { width: 1024, height: 1024 },
                    maskDigest: digest(built.bytes),
                    targetRegion: receipt.region,
                    semantics: receipt.semantics,
                    selectionSource: "user_selection",
                    maskSemantics: "alpha_zero_edit",
                    method: "source_pixels_copy",
                });
                expect(built.completion.manifest.geometry.sceneProtection?.confirmation).toBeUndefined();
                const registeredMask = await references.readReferenceAsset(built.stored.storageKey);
                const sourceRegistration = await registrations.getLocalMediaRegistration(sourceKey);
                const maskRegistration = await registrations.getLocalMediaRegistration(built.stored.storageKey);
                assert.ok(registeredMask && sourceRegistration && maskRegistration);
                expect(maskRegistration).toMatchObject({
                    ownerUserId: userId,
                    source: "image-processing-mask",
                    scope: "reference",
                    type: "image",
                    taskId: build.id,
                    runId: paused.id,
                    storageClass: "temporary",
                    mimeType: "image/png",
                    bytes: built.bytes.length,
                });
                const maskUrl = "/api/reference-assets/" + built.stored.storageKey.split("/").map(encodeURIComponent).join("/");
                await action({
                    conversation,
                    source,
                    baseline,
                    registeredSource,
                    initial,
                    paused,
                    receipt,
                    prepareBefore,
                    buildBefore,
                    built,
                    registeredMask,
                    sourceKey,
                    sourceUrl,
                    noDebits,
                    prepare,
                    build,
                    originalTask,
                    snapshot,
                    referenceCheckpoint,
                    confirmed,
                    sourceRegistration,
                    maskRegistration,
                    maskUrl,
                });
            });
        }

        async function withNativeScene4kPostStreamFault(firstError: string, mutate: (fixture: NativeScene4kBuild, runBefore: AgentRun, before: Awaited<ReturnType<typeof ownedRows>>, setRollback: (rollback: () => Promise<void>) => void) => Promise<void>) {
            await withNativeScene4kBuild(async (fixture) => {
                const originalRun = await runs.getAgentRun(fixture.paused.id);
                assert.ok(originalRun);
                const frozen = await service.readCompletedEcommerceSceneProtection(originalRun);
                expect(frozen.enhancementBaseline).toMatchObject({ status: "qualified", scope: "local_edit", normalization: "srgb-upright-v1", baseline: { sha256: digest(fixture.source), byteLength: fixture.source.length, width: 1024, height: 1024 } });
                const { listCreativeRunEvents } = await import("./creative-runtime-store");
                const firstRequestId = fixture.paused.clientRequestId + ":" + fixture.originalTask.id + ":1:1";
                const secondRequestId = fixture.paused.clientRequestId + ":" + fixture.originalTask.id + ":1:2";
                const entered = Promise.withResolvers<{ originalStream: ReturnType<OriginalReadStream>; firstChunk: Buffer }>();
                const release = Promise.withResolvers<void>();
                const streamDrains: Array<Promise<PromiseSettledResult<void>[]>> = [];
                const factsReads: Array<{ registration: Parameters<typeof service.readImageProcessingMediaFacts>[0]; pending: ReturnType<typeof service.readImageProcessingMediaFacts>; settled: boolean }> = [];
                const actualRequests: string[] = [];
                const rejections: Array<{ requestId: string; status: number; body: unknown }> = [];
                let armed = false;
                let intercepted = false;
                let rollback: (() => Promise<void>) | undefined;
                let faultSnapshot: Awaited<ReturnType<typeof ownedRows>> | undefined;
                let actorFailure: { error: unknown } | undefined;
                assert.equal(postOriginalStreamBoundary.wrap, undefined, "SETUP: previous original-stream fixture must be fully restored");
                const originalFacts = service.readImageProcessingMediaFacts;
                const factsSpy = vi.spyOn(service, "readImageProcessingMediaFacts").mockImplementation((registration, expected) => {
                    const pending = originalFacts(registration, expected);
                    if (armed) {
                        const read = { registration, pending, settled: false };
                        factsReads.push(read);
                        void pending.then(
                            () => {
                                read.settled = true;
                            },
                            () => {
                                read.settled = true;
                            },
                        );
                    }
                    return pending;
                });
                postOriginalStreamBoundary.wrap = (original, [filePath, options]) => {
                    if (!armed || intercepted || filePath !== fixture.registeredSource.filePath) return original(filePath, options);
                    assert.ok(options && typeof options === "object", "SETUP: actual registeredOriginalStream must supply its original options");
                    intercepted = true;
                    const originalStream = original(filePath, { ...options, highWaterMark: 1 });
                    let firstChunk = true;
                    const transform = new Transform({
                        writableHighWaterMark: 1,
                        readableHighWaterMark: 1,
                        transform(chunk: Buffer, _encoding, callback) {
                            if (!firstChunk) return callback(null, chunk);
                            firstChunk = false;
                            entered.resolve({ originalStream, firstChunk: Buffer.from(chunk) });
                            void release.promise.then(() => callback(null, chunk));
                        },
                    });
                    streamDrains.push(Promise.allSettled([finished(originalStream, { cleanup: true }), finished(transform, { cleanup: true }), pipeline(originalStream, transform)]));
                    return transform;
                };
                const drainOriginalReads = () => Promise.all([Promise.allSettled(factsReads.map((read) => read.pending)), ...streamDrains]);
                try {
                    const pixels = await observeNativeSceneQaPixels(async () => {
                        await withImageRoutes(
                            fixture.confirmed,
                            fixture.originalTask,
                            async (imageOrigin, created) => {
                                const pendingDispatch = claimNativeSceneRun(fixture.paused.id, "fixture-4k-post-stream-fault-parent", imageOrigin);
                                let dispatchSettled = false;
                                const dispatchDrain = Promise.allSettled([pendingDispatch]).then((results) => {
                                    dispatchSettled = true;
                                    return results;
                                });
                                liveCancellation = dispatchDrain.then(() => undefined);
                                try {
                                    const held = await Promise.race([
                                        entered.promise,
                                        pendingDispatch.then(() => {
                                            throw new Error("SETUP: claim B settled before the first actual POST original chunk was held");
                                        }),
                                    ]);
                                    expect(actualRequests).toStrictEqual([firstRequestId]);
                                    expect(intercepted).toBe(true);
                                    expect(held.firstChunk).toEqual(fixture.source.subarray(0, 1));
                                    expect(held.firstChunk).toHaveLength(1);
                                    expect(held.originalStream.bytesRead).toBeLessThan(fixture.source.length);
                                    expect(factsReads.map((read) => read.registration.storageKey)).toStrictEqual([fixture.sourceKey, fixture.built.stored.storageKey]);
                                    expect(factsReads[0].settled).toBe(false);
                                    expect(dispatchSettled).toBe(false);
                                    expect(created).toStrictEqual([]);
                                    const before = await ownedRows(fixture.conversation.id);
                                    const beforeEvents = await listCreativeRunEvents(fixture.paused.id);
                                    const runBefore = await runs.getAgentRun(fixture.paused.id);
                                    assert.ok(runBefore?.executionId);
                                    expect(runBefore).toMatchObject({ status: "running", tasks: [{ id: fixture.originalTask.id, status: "running", count: 2, attempts: 1 }] });
                                    await mutate(fixture, runBefore, before, (restore) => {
                                        rollback = restore;
                                    });
                                    faultSnapshot = await ownedRows(fixture.conversation.id);
                                    expect(held.originalStream.bytesRead).toBeLessThan(fixture.source.length);
                                    expect(factsReads[0].settled).toBe(false);
                                    expect(dispatchSettled).toBe(false);
                                    release.resolve();
                                    const dispatched = await pendingDispatch;
                                    const expected = faultSnapshot;
                                    assert.ok(expected);
                                    expect(actualRequests).toStrictEqual([firstRequestId, secondRequestId]);
                                    expect(rejections.map(({ requestId, status }) => ({ requestId, status }))).toStrictEqual([
                                        { requestId: firstRequestId, status: 409 },
                                        { requestId: secondRequestId, status: 409 },
                                    ]);
                                    expect(rejections[0].body).toStrictEqual({ error: firstError });
                                    expect(created).toStrictEqual([]);
                                    expect(dispatched).toMatchObject({ status: "failed", failureStage: "task_execution", tasks: [{ id: fixture.originalTask.id, status: "failed", count: 2, attempts: 1 }] });
                                    const taskBefore = runBefore.tasks[0];
                                    const taskAfter = dispatched.tasks[0];
                                    assert.ok(taskBefore && taskAfter);
                                    expect({ taskId: taskAfter.taskId, taskIds: taskAfter.taskIds, childTasks: taskAfter.childTasks, assetIds: taskAfter.assetIds, result: taskAfter.result }).toStrictEqual({
                                        taskId: taskBefore.taskId,
                                        taskIds: taskBefore.taskIds,
                                        childTasks: taskBefore.childTasks,
                                        assetIds: taskBefore.assetIds,
                                        result: taskBefore.result,
                                    });
                                    expect(dispatched.assetIds).toStrictEqual(runBefore.assetIds);
                                    const afterEvents = await listCreativeRunEvents(fixture.paused.id);
                                    expect(afterEvents.slice(0, beforeEvents.length)).toStrictEqual(beforeEvents);
                                    expect(afterEvents.slice(beforeEvents.length).map((event) => event.type)).toStrictEqual(["task.failed", "run.failed"]);
                                    const after = await ownedRows(fixture.conversation.id);
                                    expect(after.rows).toHaveLength(expected.rows.length);
                                    expect(after.rows.filter((row) => row.id !== fixture.paused.id)).toStrictEqual(expected.rows.filter((row) => row.id !== fixture.paused.id));
                                    expect({ registrations: after.registrations, logs: after.logs, assets: after.assets }).toStrictEqual({ registrations: expected.registrations, logs: expected.logs, assets: expected.assets });
                                    // Only the parent's failure/message/event persistence may differ after both 409s are relayed.
                                    expect(after.files.filter((file) => file.path !== tasks.GENERATION_TASK_FILE && file.path !== "creative-runtime.json")).toStrictEqual(
                                        expected.files.filter((file) => file.path !== tasks.GENERATION_TASK_FILE && file.path !== "creative-runtime.json"),
                                    );
                                    if ("account" in expected) {
                                        assert.ok("account" in after);
                                        expect(after.account).toStrictEqual(expected.account);
                                        expect(after.logAssets).toStrictEqual(expected.logAssets);
                                    } else {
                                        assert.ok("authBytes" in after);
                                        expect(after.authBytes).toEqual(expected.authBytes);
                                    }
                                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepare.id)).toStrictEqual(fixture.prepareBefore);
                                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.build.id)).toStrictEqual(fixture.buildBefore);
                                    expect(await registrations.getLocalMediaRegistration(fixture.sourceKey)).toStrictEqual(fixture.sourceRegistration);
                                    expect(await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey)).toStrictEqual(fixture.maskRegistration);
                                    expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                                    expect(boundary.create).not.toHaveBeenCalled();
                                    expect(boundary.poll).not.toHaveBeenCalled();
                                    expect(charges.size).toBe(0);
                                } catch (error) {
                                    actorFailure = { error };
                                    throw error;
                                } finally {
                                    release.resolve();
                                    await drainLiveRequests(Promise.all([dispatchDrain, drainOriginalReads()]), "CLEANUP: actual POST dispatch, both facts reads or original streams did not drain");
                                    liveCancellation = undefined;
                                }
                            },
                            undefined,
                            {
                                beforeActualPost(body) {
                                    assert.ok(body.context?.clientRequestId && body.references?.length === 1);
                                    expect(body.kind).toBe("edit");
                                    expect(body.references[0]).toMatchObject({ id: fixture.baseline.id, dataUrl: "", url: fixture.sourceUrl, ecommerceRole: "scene" });
                                    const reference = body.references[0];
                                    expect(reference.serverUrl || reference.dataUrl || reference.url || reference.remoteUrl).toBe(fixture.sourceUrl);
                                    expect(body.sceneProtection).toStrictEqual(frozen.sceneProtection);
                                    expect(body.ecommerceExecution).toStrictEqual(frozen.execution);
                                    const requestId = body.context.clientRequestId;
                                    actualRequests.push(requestId);
                                    if (requestId === firstRequestId) {
                                        expect(armed).toBe(false);
                                        armed = true;
                                    } else expect(requestId).toBe(secondRequestId);
                                },
                                async beforeRejectedPostRelay(body, result, created) {
                                    assert.ok(body.context?.clientRequestId);
                                    const expected = faultSnapshot;
                                    if (actorFailure) throw actorFailure.error;
                                    assert.ok(expected, "SETUP: an early preflight/setup rejection is not a streaming-fault qualification");
                                    await drainLiveRequests(drainOriginalReads(), "CLEANUP: both POST facts operations and original stream/Transform must drain before conservation");
                                    expect(factsReads.slice(0, 2).map((read) => read.settled)).toStrictEqual([true, true]);
                                    expect(await Promise.all(streamDrains)).toStrictEqual([
                                        [
                                            { status: "fulfilled", value: undefined },
                                            { status: "fulfilled", value: undefined },
                                            { status: "fulfilled", value: undefined },
                                        ],
                                    ]);
                                    expect(created).toStrictEqual([]);
                                    expect(await ownedRows(fixture.conversation.id), "actual 409 must precede any task association, result, media, retention or financial write").toStrictEqual(expected);
                                    const payload: unknown = await result.clone().json();
                                    rejections.push({ requestId: body.context.clientRequestId, status: result.status, body: payload });
                                },
                            },
                        );
                    });
                    expect(pixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                } finally {
                    release.resolve();
                    if (!liveCleanupUnconfirmed) {
                        // withImageRoutes has already drained its POST/relay/handlers; Promise.all rejection alone is insufficient.
                        await drainLiveRequests(drainOriginalReads(), "CLEANUP: retain stream-fault fixture until both original facts, ReadStream and Transform are closed");
                        postOriginalStreamBoundary.wrap = undefined;
                        factsSpy.mockRestore();
                        if (rollback) await rollback();
                    }
                }
            });
        }

        it("rejects the actual native scene 4k POST when the original source changes after its first disk chunk", async () => {
            await withNativeScene4kPostStreamFault("参考原件内容已变化", async (fixture, _runBefore, before, setRollback) => {
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                const lastByte = fixture.source.subarray(-1);
                const changedByte = Buffer.from([lastByte.readUInt8(0) ^ 1]);
                setRollback(async () => {
                    const original = await open(fixture.registeredSource.filePath, "r+");
                    try {
                        expect((await original.write(lastByte, 0, 1, fixture.source.length - 1)).bytesWritten).toBe(1);
                    } finally {
                        await original.close();
                    }
                    expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                });
                const original = await open(fixture.registeredSource.filePath, "r+");
                try {
                    expect((await original.write(changedByte, 0, 1, fixture.source.length - 1)).bytesWritten).toBe(1);
                } finally {
                    await original.close();
                }
                expect((await stat(fixture.registeredSource.filePath)).size).toBe(fixture.source.length);
                const after = await ownedRows(fixture.conversation.id);
                const sourcePath = path.relative(directory, fixture.registeredSource.filePath);
                const sourceFile = after.files.find((file) => file.path === sourcePath);
                assert.ok(sourceFile);
                expect(sourceFile.bytes.subarray(0, -1)).toEqual(fixture.source.subarray(0, -1));
                expect(sourceFile.bytes.subarray(-1)).toEqual(changedByte);
                expect(after.files.filter((file) => file.path !== sourcePath)).toStrictEqual(before.files.filter((file) => file.path !== sourcePath));
                expect({ ...after, files: before.files }).toStrictEqual(before);
            });
        }, 120_000);

        it("rejects the actual native scene 4k POST after unchanged original reads when receipt confirmation changes", async () => {
            await withNativeScene4kPostStreamFault("场景增强基线在原件读取期间已变化", async (fixture, runBefore, before, setRollback) => {
                const snapshot = runBefore.ecommerceSnapshot;
                const processingBefore = snapshot?.processing;
                assert.ok(snapshot && processingBefore?.sceneSelection);
                const receiptBefore = processingBefore.sceneSelection;
                const originalEvidence = await service.readCompletedEcommerceSceneProtection(runBefore);
                const changedReceipt = { ...receiptBefore, confirmation: { ...receiptBefore.confirmation, confirmedAt: receiptBefore.confirmation.confirmedAt + 1 } };
                const expectedSnapshot = { ...snapshot, processing: { ...processingBefore, sceneSelection: changedReceipt } };
                setRollback(async () => {
                    const current = await runs.getAgentRun(runBefore.id);
                    const currentSnapshot = current?.ecommerceSnapshot;
                    const currentProcessing = currentSnapshot?.processing;
                    assert.ok(current && currentSnapshot && currentProcessing?.sceneSelection);
                    expect(currentProcessing.sceneSelection).toStrictEqual(changedReceipt);
                    assert.ok(await runs.updateAgentRunById(current.id, { ecommerceSnapshot: { ...currentSnapshot, processing: { ...currentProcessing, sceneSelection: receiptBefore } } }, undefined, [current.status], current.executionId));
                    expect((await runs.getAgentRun(current.id))?.ecommerceSnapshot?.processing?.sceneSelection).toStrictEqual(receiptBefore);
                });
                const changed = await runs.updateAgentRunById(runBefore.id, { ecommerceSnapshot: expectedSnapshot }, undefined, ["running"], runBefore.executionId);
                assert.ok(changed);
                const current = await service.readCompletedEcommerceSceneProtection(changed);
                expect(current.state.receipt).toStrictEqual(changedReceipt);
                expect(current.stage).toStrictEqual(originalEvidence.stage);
                expect(current.enhancementBaseline).toStrictEqual(originalEvidence.enhancementBaseline);
                expect(current.sceneProtection).toStrictEqual({ ...originalEvidence.sceneProtection, confirmation: changedReceipt.confirmation });
                const after = await ownedRows(fixture.conversation.id);
                const originalRunRow = before.rows.find((row) => row.id === runBefore.id);
                assert.ok(originalRunRow && originalRunRow.payload && typeof originalRunRow.payload === "object");
                const expectedPayload = { ...originalRunRow.payload, ecommerceSnapshot: expectedSnapshot, updatedAt: changed.updatedAt };
                expect(changed).toStrictEqual(expectedPayload);
                expect(after.rows.find((row) => row.id === runBefore.id)).toStrictEqual(
                    provider === "file"
                        ? { ...originalRunRow, payload: expectedPayload, updatedAt: changed.updatedAt, expiresAt: changed.updatedAt + runs.AGENT_RUN_TTL_MS }
                        : { ...originalRunRow, payload: expectedPayload, updated_at: new Date(changed.updatedAt), expires_at: new Date(changed.updatedAt + runs.AGENT_RUN_TTL_MS) },
                );
                expect(after.rows.filter((row) => row.id !== runBefore.id)).toStrictEqual(before.rows.filter((row) => row.id !== runBefore.id));
                expect({ ...after, rows: before.rows, files: before.files }).toStrictEqual(before);
                expect(after.files.filter((file) => file.path !== tasks.GENERATION_TASK_FILE)).toStrictEqual(before.files.filter((file) => file.path !== tasks.GENERATION_TASK_FILE));
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
            });
        }, 120_000);

        it("freezes a real native scene 4k delivery from its original Worker baseline without Web pixels", async () => {
            await withNativeScene4kBuild(
                async ({
                    conversation,
                    source,
                    baseline,
                    registeredSource,
                    paused,
                    receipt,
                    prepareBefore,
                    buildBefore,
                    built,
                    registeredMask,
                    sourceKey,
                    sourceUrl,
                    noDebits,
                    prepare,
                    build,
                    originalTask,
                    snapshot,
                    referenceCheckpoint,
                    confirmed,
                    sourceRegistration,
                    maskRegistration,
                    maskUrl,
                }) => {
                    await withImageRoutes(confirmed, originalTask, async (imageOrigin, created) => {
                        const dispatch: { run?: AgentRun } = {};
                        // The wider window also covers claim B's source/mask verification and pending GETs.
                        // All fixture pixels and both native stages finished before observation starts.
                        const dispatchAndPostPixels = await observeNativeSceneQaPixels(async () => {
                            dispatch.run = await claimNativeSceneRun(paused.id, "fixture-4k-freeze-dispatch-parent", imageOrigin);
                        });
                        const dispatched = dispatch.run;
                        assert.ok(dispatched?.executionId);
                        const task = dispatched.tasks[0];
                        const first = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + originalTask.id + ":1:1");
                        const second = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + originalTask.id + ":1:2");
                        assert.ok(first && second && task.sceneProtection);
                        const firstImage = await imageTasks.getImageTask(first.taskId);
                        const secondImage = await imageTasks.getImageTask(second.taskId);
                        assert.ok(firstImage && secondImage);
                        const after = {
                            prepare: await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id),
                            build: await tasks.getStoredGenerationTaskRecord("image_processing", build.id),
                            stages: (await tasks.listStoredGenerationTaskRecordsByRunIds([paused.id], [userId])).filter((record) => record.type === "image_processing"),
                            sourceRegistration: await registrations.getLocalMediaRegistration(sourceKey),
                            maskRegistration: await registrations.getLocalMediaRegistration(built.stored.storageKey),
                            sourceBytes: await readFile(registeredSource.filePath),
                            maskBytes: await readFile(registeredMask.filePath),
                            debits: await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" }),
                        };
                        const qualified = built.completion.manifest.geometry.enhancementBaseline;
                        expect(created).toHaveLength(2);
                        expect(first.taskId).not.toBe(second.taskId);
                        expect(dispatched).toMatchObject({ status: "running", tasks: [{ id: originalTask.id, count: 2, attempts: 1, status: "running", quality: "4k" }] });
                        expect(task.taskIds).toEqual(expect.arrayContaining([first.taskId, second.taskId]));
                        expect(task.childTasks).toHaveLength(2);
                        expect(task.childTasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.taskId, status: "pending", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "pending", attempt: 1 })]));
                        expect(task.sceneProtection.mask).toMatchObject({ dataUrl: "", serverUrl: maskUrl, type: "image/png", width: 1024, height: 1024 });
                        expect(task.sceneProtection.confirmation).toStrictEqual(receipt.confirmation);
                        expect(dispatched.ecommerceSnapshot?.processing?.sceneSelection).toStrictEqual(receipt);
                        expect(dispatched.ecommerceSnapshot?.plan).toStrictEqual(snapshot.plan);
                        expect(dispatched.ecommerceSnapshot?.referenceCheckpoint).toStrictEqual(referenceCheckpoint);
                        expect(dispatched.ecommerceSnapshot?.modelRouteSnapshots).toStrictEqual(snapshot.modelRouteSnapshots);
                        expect(firstImage).toMatchObject({
                            id: first.taskId,
                            runId: paused.id,
                            parentTaskId: paused.id,
                            userId,
                            conversationId: conversation.id,
                            clientRequestId: first.requestId,
                            status: "pending",
                            kind: "edit",
                            config: { quality: "4k", size: "1024x1024" },
                            references: [{ id: baseline.id, ecommerceRole: "scene", url: sourceUrl }],
                            mask: task.sceneProtection.mask,
                            sceneProtection: task.sceneProtection,
                            ecommerceExecution: originalTask.ecommerceExecution,
                            referenceDispatch: { executionId: dispatched.executionId, copy: 1, inputId: referenceCheckpoint.inputId, decisionId: referenceCheckpoint.decisionId, analysisRequestId: referenceCheckpoint.analysisStage.requestId },
                        });
                        expect(secondImage).toMatchObject({
                            id: second.taskId,
                            runId: paused.id,
                            parentTaskId: paused.id,
                            userId,
                            conversationId: conversation.id,
                            clientRequestId: second.requestId,
                            status: "pending",
                            kind: "edit",
                            config: { quality: "4k", size: "1024x1024" },
                            references: firstImage.references,
                            mask: firstImage.mask,
                            sceneProtection: firstImage.sceneProtection,
                            ecommerceExecution: firstImage.ecommerceExecution,
                            referenceDispatch: { executionId: dispatched.executionId, copy: 2, inputId: referenceCheckpoint.inputId, decisionId: referenceCheckpoint.decisionId, analysisRequestId: referenceCheckpoint.analysisStage.requestId },
                        });
                        expect([
                            firstImage.attempts,
                            firstImage.billing,
                            firstImage.upstream,
                            firstImage.nativeAcquisition,
                            firstImage.nativeResults,
                            firstImage.resultProcessing,
                            firstImage.result,
                            secondImage.attempts,
                            secondImage.billing,
                            secondImage.upstream,
                            secondImage.nativeAcquisition,
                            secondImage.nativeResults,
                            secondImage.resultProcessing,
                            secondImage.result,
                        ]).toStrictEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
                        expect(boundary.create).not.toHaveBeenCalled();
                        expect(boundary.poll).not.toHaveBeenCalled();
                        expect(charges.size).toBe(0);
                        expect(after.debits).toStrictEqual(noDebits);
                        expect(after.prepare).toStrictEqual(prepareBefore);
                        expect(after.build).toStrictEqual(buildBefore);
                        expect(after.stages).toHaveLength(2);
                        expect(after.stages).toEqual(expect.arrayContaining([prepareBefore, buildBefore]));
                        expect(after.sourceRegistration).toStrictEqual(sourceRegistration);
                        expect(after.maskRegistration).toStrictEqual(maskRegistration);
                        expect(after.sourceBytes).toEqual(source);
                        expect(after.maskBytes).toEqual(built.bytes);
                        expect(qualified, "4k producer must qualify its baseline in the original native build before actual POST freezes either child delivery").toMatchObject({
                            status: "qualified",
                            scope: "local_edit",
                            normalization: "srgb-upright-v1",
                            hasAlpha: false,
                            baseline: { sha256: digest(source), byteLength: source.length, width: 1024, height: 1024, normalizedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
                        });
                        assert.ok(qualified?.status === "qualified" && qualified.scope === "local_edit");
                        const expectedDelivery = {
                            version: "ecommerce-delivery.v2",
                            scope: "local_edit",
                            canvas: task.ecommerceExecution?.canvas,
                            protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene: task.sceneProtection },
                            baseline: { url: sourceUrl, ...qualified.baseline },
                        };
                        expect([firstImage.enhancementDelivery, secondImage.enhancementDelivery], "both actual POST children must retain the original Worker baseline and owned scene mask").toStrictEqual([expectedDelivery, expectedDelivery]);
                        expect(dispatchAndPostPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    });
                },
            );
        }, 120_000);

        it("keeps the same two native scene 4k copies on their frozen baseline through result Workers and Agent adoption", async () => {
            await withNativeScene4kBuild(async ({ conversation, source, baseline, initial, paused, confirmed, originalTask, snapshot, receipt, prepareBefore, buildBefore, built, registeredSource, registeredMask, maskUrl, sourceUrl }) => {
                const firstNative = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                    .png()
                    .toBuffer();
                const secondNative = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#fedcba" } })
                    .png()
                    .toBuffer();
                await withImageRoutes(confirmed, originalTask, async (imageOrigin, created) => {
                    const dispatch: { run?: AgentRun } = {};
                    const dispatchPixels = await observeNativeSceneQaPixels(async () => {
                        dispatch.run = await claimNativeSceneRun(paused.id, "fixture-4k-result-dispatch-parent", imageOrigin);
                    });
                    const dispatched = dispatch.run;
                    assert.ok(dispatched?.executionId);
                    const parentExecutionId = dispatched.executionId;
                    const task = dispatched.tasks[0];
                    assert.ok(task.sceneProtection && snapshot.plan);
                    const first = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + originalTask.id + ":1:1");
                    const second = created.find((copy) => copy.requestId === paused.clientRequestId + ":" + originalTask.id + ":1:2");
                    assert.ok(first && second);
                    expect(created).toHaveLength(2);
                    expect(first.taskId).not.toBe(second.taskId);
                    expect(dispatched).toMatchObject({ status: "running", tasks: [{ id: task.id, quality: "4k", attempts: 1, count: 2, status: "running", taskIds: expect.arrayContaining([first.taskId, second.taskId]) }] });
                    expect(dispatched.ecommerceSnapshot?.processing?.sceneSelection).toStrictEqual(receipt);
                    const firstBefore = await imageTasks.getImageTask(first.taskId);
                    const secondBefore = await imageTasks.getImageTask(second.taskId);
                    const siblingRecord = await tasks.getStoredGenerationTaskRecord("image", second.taskId);
                    assert.ok(firstBefore && secondBefore && siblingRecord);
                    const qualified = built.completion.manifest.geometry.enhancementBaseline;
                    expect(qualified, "SETUP: actual 4k build must qualify the original source before result handoff").toMatchObject({
                        status: "qualified",
                        scope: "local_edit",
                        normalization: "srgb-upright-v1",
                        baseline: { sha256: digest(source), byteLength: source.length, width: 1024, height: 1024 },
                    });
                    assert.ok(qualified?.status === "qualified" && qualified.scope === "local_edit");
                    const frozenBaseline = qualified.baseline;
                    const expectedDelivery = {
                        version: "ecommerce-delivery.v2",
                        scope: "local_edit",
                        canvas: task.ecommerceExecution?.canvas,
                        protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene: task.sceneProtection },
                        baseline: { url: sourceUrl, ...frozenBaseline },
                    };
                    expect([firstBefore.enhancementDelivery, secondBefore.enhancementDelivery], "SETUP: both real POST children must carry the exact original Worker baseline").toStrictEqual([expectedDelivery, expectedDelivery]);
                    expect(firstBefore.enhancementPolicy).toMatchObject({ enabled: false, connection: null });
                    expect(secondBefore.enhancementPolicy).toStrictEqual(firstBefore.enhancementPolicy);
                    expect([firstBefore.status, secondBefore.status]).toStrictEqual(["pending", "pending"]);
                    expect([firstBefore.upstream, secondBefore.upstream, firstBefore.nativeResults, secondBefore.nativeResults, firstBefore.resultProcessing, secondBefore.resultProcessing, firstBefore.result, secondBefore.result]).toStrictEqual([
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                    ]);
                    expect(boundary.create).not.toHaveBeenCalled();
                    expect(boundary.poll).not.toHaveBeenCalled();
                    expect((await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).records).toStrictEqual([]);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", buildBefore.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    expect(dispatchPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });

                    async function finishCopy(copy: { requestId: string; taskId: string }, original: ImageTask, nativeBytes: Buffer, insidePixel: number[]) {
                        const [claim] = await scheduler.claimDueGenerationTasks({ workerId: "fixture-4k-scene-result-" + copy.taskId, taskIds: [copy.taskId], limit: 1 });
                        assert.ok(claim && typeof claim.payload.executionId === "string");
                        const claimed = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(claimed);
                        expect(claimed).toMatchObject({ id: original.id, clientRequestId: copy.requestId, executionId: claim.payload.executionId, config: { quality: "4k" }, enhancementDelivery: expectedDelivery, sceneProtection: task.sceneProtection });
                        expect(await runtime.createImageTaskUpstreamStep(claimed, imageOrigin, imageOrigin, boundary.cookie)).toMatchObject({ state: "pending", upstream: { id: "fixture-upstream-" + copy.taskId } });
                        const submitted = await imageTasks.getImageTask(copy.taskId);
                        const charge = charges.get(copy.taskId);
                        assert.ok(submitted?.upstream && charge);
                        expect(charge.cost).toBe(2);
                        expect(submitted.attempts).toHaveLength(1);
                        expect(submitted).toMatchObject({ attemptNo: 1, billing: { pointsCost: 2, pointsRecordId: charge.recordId, refunded: false }, enhancementDelivery: expectedDelivery, enhancementPolicy: original.enhancementPolicy });
                        providerResults.set(submitted.upstream.id, { dataUrl: dataUrl(nativeBytes), results: [{ dataUrl: dataUrl(nativeBytes) }] });
                        const query: { step?: Awaited<ReturnType<typeof runtime.queryImageTaskUpstreamStep>> } = {};
                        const queryPixels = await observeNativeSceneQaPixels(async () => {
                            query.step = await runtime.queryImageTaskUpstreamStep(submitted, imageOrigin, boundary.cookie);
                        });
                        // First behavior gate: v506's selector instead enters legacy Web result preparation inside query.
                        expect(query.step, "RED: the original 4k scene query must retain provider native bytes for its result Worker").toMatchObject({ state: "result_ready", status: "native_ready" });
                        const step = query.step;
                        assert.ok(step?.state === "result_ready");
                        // UNREACHED after the query RED until Root records actual execution on a later reviewed tree.
                        const sealed = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(sealed?.nativeResults);
                        expect(sealed.result).toBeUndefined();
                        const slot = sealed.nativeResults.slots[0];
                        assert.ok(slot.status === "stored");
                        expect(slot).toMatchObject({ resultId: copy.taskId + ":1", resultIndex: 1, sha256: digest(nativeBytes), bytes: nativeBytes.length });
                        const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                        expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(nativeBytes);
                        expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                        const persistence: { image?: Awaited<ReturnType<typeof runtime.persistImageTaskResult>> } = {};
                        const persistPixels = await observeNativeSceneQaPixels(async () => {
                            persistence.image = await runtime.persistImageTaskResult(sealed, imageOrigin, step.resultUrl, boundary.cookie);
                        });
                        expect(persistence.image, "RED: original 4k scene result must wait for its bound CPU Worker").toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
                        const waiting = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(waiting?.resultProcessing);
                        expect(waiting.result).toBeUndefined();
                        const worker = await processWithWorker(waiting.resultProcessing.jobId);
                        const payload = worker.child.payload;
                        assert.ok(payload.operation === "process_result" && payload.options.mode === "scene_protection");
                        const { mask: _mask, ...protection } = task.sceneProtection!;
                        expect(payload.options).toStrictEqual({ mode: "scene_protection", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], sourceInputIndex: 1, maskInputIndex: 2, protection, baseline: frozenBaseline });
                        expect(payload.inputs).toHaveLength(3);
                        expect(payload.inputs[1]).toMatchObject({ assetId: baseline.id, expectedSha256: digest(source) });
                        expect(payload.inputs[2]).toMatchObject({ assetId: task.sceneProtection!.mask.id, expectedSha256: digest(built.bytes) });
                        expect(payload.sources.find((input) => input.inputIndex === 2)).toMatchObject({ scope: "reference", storageKey: built.stored.storageKey });
                        expect(payload.parentMask).toStrictEqual({ inputIndex: 2, imageTaskId: copy.taskId });
                        expect(payload.imageResultBinding).toMatchObject({ imageTaskId: copy.taskId, userId, nativeResults: sealed.nativeResults, run: { runId: paused.id, agentTaskId: task.id, agentAttempt: 1 } });
                        expect(worker.completion.manifest.results).toMatchObject([
                            {
                                resultId: copy.taskId + ":1",
                                nativeInputIndex: 0,
                                finalArtifactIndex: 0,
                                baselineValidated: true,
                                sceneProtectionEvidence: { sourceDigest: digest(source), maskDigest: digest(built.bytes), nativeDigest: digest(nativeBytes), normalization: "none", outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
                            },
                        ]);
                        expect(worker.uploads).toHaveLength(1);
                        expect(worker.completion.manifest.artifacts).toHaveLength(1);
                        const final = worker.completion.manifest.artifacts[0];
                        expect(final).toMatchObject({ kind: "final", resultId: copy.taskId + ":1", resultIndex: 1, width: 1024, height: 1024, mimeType: "image/png" });
                        expect(worker.uploads[0].stored).toStrictEqual(final);
                        expect(digest(worker.uploads[0].bytes)).toBe(final.sha256);
                        expect(final.sha256).not.toBe(digest(nativeBytes));
                        const pixels = await sharp(worker.uploads[0].bytes).ensureAlpha().raw().toBuffer();
                        expect([...pixels.subarray(0, 4)]).toStrictEqual([18, 52, 86, 255]);
                        expect([...pixels.subarray(1049600, 1049604)]).toStrictEqual(insidePixel);
                        const debitsBeforeConsume = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                        const recoveryInput = { origin: imageOrigin, cookie: boundary.cookie, workerId: "fixture-4k-result-consumer-" + copy.taskId, taskIds: [copy.taskId], limit: 1 };
                        const consumption: { outcome?: Awaited<ReturnType<typeof recovery.runGenerationTaskRecoveryBatch>> } = {};
                        const consumePixels = await observeNativeSceneQaPixels(async () => {
                            consumption.outcome = await recovery.runGenerationTaskRecoveryBatch(recoveryInput);
                        });
                        expect(consumption.outcome).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
                        const published = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(published?.result?.results);
                        expect(published).toMatchObject({
                            id: copy.taskId,
                            runId: paused.id,
                            parentTaskId: paused.id,
                            clientRequestId: copy.requestId,
                            status: "success",
                            attemptNo: submitted.attemptNo,
                            upstream: submitted.upstream,
                            billing: submitted.billing,
                            enhancementDelivery: expectedDelivery,
                            enhancementPolicy: original.enhancementPolicy,
                            nativeResults: sealed.nativeResults,
                            resultProcessing: waiting.resultProcessing,
                        });
                        expect(published.result.results).toHaveLength(1);
                        const delivered = published.result.results[0];
                        const nativeUrl = "/api/reference-assets/" + slot.storageKey.split("/").map(encodeURIComponent).join("/");
                        expect(delivered).toMatchObject({
                            resultId: copy.taskId + ":1",
                            width: 1024,
                            height: 1024,
                            mimeType: "image/png",
                            enhancementId: "enhancement:" + copy.taskId + ":1",
                            nativeSource: { url: nativeUrl, sha256: digest(nativeBytes), width: 1024, height: 1024, byteLength: nativeBytes.length, provenance: "provider_native" },
                            sceneProtectionEvidence: { ...protection, nativeUrl, maskUrl, compositeUrl: delivered.serverUrl, compositeDigest: final.sha256, outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
                            canvasEvidence: { constraint: snapshot.plan!.canvas, nativeSize: { width: 1024, height: 1024 }, storedSize: { width: 1024, height: 1024 }, normalization: "none" },
                        });
                        const { listEnhancementJobsForTask } = await import("./database/image-enhancement-job-repository");
                        const enhancementJobs = await listEnhancementJobsForTask(copy.taskId, userId);
                        expect(enhancementJobs).toHaveLength(1);
                        expect(enhancementJobs[0]).toMatchObject({ imageTaskId: copy.taskId, status: "skipped", reason: "disabled", phase: "completed", workerId: null, leaseToken: null, leaseUntil: null });
                        expect(enhancementJobs[0].remoteJobId).toBeUndefined();
                        expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(debitsBeforeConsume);
                        expect(await registrations.getLocalMediaRegistration(built.stored.storageKey)).toMatchObject({ taskId: buildBefore.id, runId: paused.id, source: "image-processing-mask", storageClass: "permanent" });
                        expect((await registrations.getLocalMediaRegistration(built.stored.storageKey))?.expiresAt).toBeUndefined();
                        expect(await registrations.getLocalMediaRegistration(final.storageKey)).toMatchObject({ taskId: worker.child.id, runId: paused.id, storageClass: "permanent" });
                        const asset = (await creative.listAssetsForUser(userId, conversation.id)).find((item) => item.sourceTaskId === copy.taskId);
                        assert.ok(asset);
                        expect(asset).toMatchObject({ sourceTaskId: copy.taskId, sourceRunId: paused.id, serverUrl: delivered.serverUrl, status: "ready" });
                        expect(queryPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(persistPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(consumePixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        return { published, worker, final, asset, recoveryInput, charge };
                    }

                    const firstResult = await finishCopy(first, firstBefore, firstNative, [171, 205, 239, 255]);
                    const partialAgentPixels = await observeNativeSceneQaPixels(async () => {
                        await execution.executeTasks(paused.id, imageOrigin, boundary.cookie, parentExecutionId);
                    });
                    expect(await runs.getAgentRun(paused.id)).toMatchObject({
                        status: "running",
                        tasks: [{ id: task.id, count: 2, attempts: 1, childTasks: [expect.objectContaining({ id: first.taskId, status: "completed", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "pending", attempt: 1 })] }],
                    });
                    expect(await imageTasks.getImageTask(second.taskId)).toStrictEqual(secondBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image", second.taskId)).toStrictEqual(siblingRecord);
                    const settledFirst = await imageTasks.getImageTask(first.taskId);
                    const secondResult = await finishCopy(second, secondBefore, secondNative, [254, 220, 186, 255]);
                    expect(secondResult.worker.child.id).not.toBe(firstResult.worker.child.id);
                    expect(secondResult.final.storageKey).not.toBe(firstResult.final.storageKey);
                    expect(secondResult.charge.recordId).not.toBe(firstResult.charge.recordId);
                    expect(await imageTasks.getImageTask(first.taskId)).toStrictEqual(settledFirst);
                    const finalAgentPixels = await observeNativeSceneQaPixels(async () => {
                        await execution.executeTasks(paused.id, imageOrigin, boundary.cookie, parentExecutionId);
                    });
                    const completed = await runs.getAgentRun(paused.id);
                    expect(completed).toMatchObject({
                        status: "completed",
                        tasks: [
                            {
                                id: task.id,
                                count: 2,
                                attempts: 1,
                                quality: "4k",
                                status: "completed",
                                taskIds: [first.taskId, second.taskId],
                                childTasks: [expect.objectContaining({ id: first.taskId, status: "completed", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "completed", attempt: 1 })],
                            },
                        ],
                        ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" } },
                    });
                    expect(completed?.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                    expect(completed?.assetIds).toEqual(expect.arrayContaining([firstResult.asset.id, secondResult.asset.id]));
                    const assets = await creative.listAssetsForUser(userId, conversation.id);
                    expect(assets).toHaveLength(3);
                    expect(assets.find((item) => item.id === firstResult.asset.id)).toMatchObject({
                        parentAssetId: baseline.id,
                        sourceTaskId: first.taskId,
                        sourceRunId: paused.id,
                        messageId: initial.assistantMessageId,
                        metadata: { agentTaskId: task.id },
                    });
                    expect(assets.find((item) => item.id === secondResult.asset.id)).toMatchObject({
                        parentAssetId: baseline.id,
                        sourceTaskId: second.taskId,
                        sourceRunId: paused.id,
                        messageId: initial.assistantMessageId,
                        metadata: { agentTaskId: task.id },
                    });
                    const finalDebits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                    expect(finalDebits.records).toHaveLength(2);
                    expect(finalDebits.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: firstResult.charge.recordId, amount: -2 }), expect.objectContaining({ id: secondResult.charge.recordId, amount: -2 })]));
                    expect((await logs.listGenerationLogs({ userId })).items).toEqual(
                        expect.arrayContaining([expect.objectContaining({ id: "image-task:" + first.taskId, status: "success" }), expect.objectContaining({ id: "image-task:" + second.taskId, status: "success" })]),
                    );
                    expect(boundary.create).toHaveBeenCalledTimes(2);
                    expect(boundary.poll).toHaveBeenCalledTimes(2);
                    expect(created).toHaveLength(2);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", buildBefore.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    const finalFirst = await imageTasks.getImageTask(first.taskId);
                    const finalSecond = await imageTasks.getImageTask(second.taskId);
                    const settled = await ownedRows(conversation.id);
                    expect(await service.completeImageProcessingTask(firstResult.worker.child.id, firstResult.worker.completion)).toStrictEqual(firstResult.worker.receipt);
                    expect(await service.completeImageProcessingTask(secondResult.worker.child.id, secondResult.worker.completion)).toStrictEqual(secondResult.worker.receipt);
                    expect(await recovery.runGenerationTaskRecoveryBatch(firstResult.recoveryInput)).toMatchObject({ claimed: 0 });
                    expect(await recovery.runGenerationTaskRecoveryBatch(secondResult.recoveryInput)).toMatchObject({ claimed: 0 });
                    expect(await runtime.persistImageTaskResult(firstResult.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalFirst);
                    expect(await runtime.persistImageTaskResult(secondResult.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalSecond);
                    expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                    expect(partialAgentPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(finalAgentPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                });
            });
        }, 120_000);

        it("captures one native global scene 4k full image Run copy before result processing", async () => {
            const route = await configureNativeScenePlanning();
            const { readImageEnhancementSettings } = await import("./database/image-enhancement-repository");
            const enhancementSettings = await readImageEnhancementSettings();
            expect(enhancementSettings.enabled, "SETUP: this first native gate requires the existing enhancement policy to be disabled").toBe(false);
            const { listEnhancementJobsForTask } = await import("./database/image-enhancement-job-repository");
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "One native global scene 4k full image Run" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                .png()
                .toBuffer();
            const baseline = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "native-global-scene-4k.png", { type: "image/png" }));
            assert.ok(baseline.storageKey && baseline.serverUrl);
            const registeredSource = await references.readReferenceAsset(baseline.storageKey);
            assert.ok(registeredSource);
            expect(await readFile(registeredSource.filePath)).toEqual(source);
            installNativeGlobalScene4kPlanningReplies(baseline.id);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-global-scene-4k-result-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，全局调整光线为明亮自然日光，允许整张场景中的物体统一参与改光，不设置局部像素保护，保留原机位、布局和原图尺寸",
                    assetIds: [baseline.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 1, quality: "4k", size: "1024x1024" } },
                })
            ).run;
            // This value only supplies HTTP expectations; executeAgentRun creates the persisted task.
            const expectedTask: AgentRunTask = { id: "ecommerce-scene-edit", type: "image", title: "Global scene 4k", prompt: "Route expectation", count: 1, quality: "4k", ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
            await withImageRoutes(initial, expectedTask, async (imageOrigin, created) => {
                await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
                await claimNativeSceneRun(initial.id, "fixture-native-global-scene-4k-prepare-parent", imageOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                expect(prepare.payload.inputs).toMatchObject([{ assetId: baseline.id }]);
                expect(boundary.model).not.toHaveBeenCalled();
                const prepared = await completeNativeSceneStage(prepare.id);
                const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id);
                assert.ok(prepareBefore?.resultPayload?.manifestDigest);
                expect(prepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { executionId: prepared.child.executionId, manifest: prepared.completion.manifest } });
                const dispatch: { run?: AgentRun } = {};
                const planningAndDispatchPixels = await observeNativeSceneQaPixels(async () => {
                    dispatch.run = await claimNativeSceneRun(initial.id, "fixture-native-global-scene-4k-planning-parent", imageOrigin);
                });
                const dispatched = dispatch.run;
                assert.ok(dispatched?.executionId, "SETUP: real global scene 4k planning must retain the parent execution" + " " + JSON.stringify({ run: dispatched, tools: boundary.model.mock.calls.map(([request]) => request.tool.name) }));
                const snapshot = dispatched.ecommerceSnapshot;
                const qualification = JSON.stringify({ status: dispatched.status, failure: dispatched.failure, snapshot, tasks: dispatched.tasks, tools: boundary.model.mock.calls.map(([request]) => request.tool.name) });
                expect(snapshot, "SETUP: actual global scene 4k planning and dispatch must precede the native result gate: " + qualification).toMatchObject({
                    mode: "active",
                    qualityPolicy: "disabled",
                    referenceCheckpoint: { state: "resolved", analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                    plan: {
                        planVersion: "ecommerce-edit.v6",
                        operation: "scene_edit",
                        strategy: "integrated_scene",
                        source: { productAnchorId: null, currentSceneBaselineId: baseline.id, sceneReferenceIds: [] },
                        canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false },
                        protection: { scope: "global", preserveOutsideMask: false, allowLightingChange: true },
                    },
                });
                assert.ok(snapshot?.plan && snapshot.referenceCheckpoint);
                const plan = snapshot.plan;
                expect(plan.protection).toStrictEqual({ scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true });
                const referenceCheckpoint = snapshot.referenceCheckpoint;
                expect(snapshot.modelRouteSnapshots?.image_generation).toStrictEqual(route.snapshot);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                expect(dispatched).toMatchObject({ status: "running", tasks: [{ id: "ecommerce-scene-edit", type: "image", status: "running", attempts: 1, count: 1, quality: "4k", ratio: "1024x1024" }] });
                expect(dispatched.tasks).toHaveLength(1);
                const task = dispatched.tasks[0];
                assert.ok(task);
                const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
                const profile = resolveEcommerceImageProviderProfile(route.snapshot);
                assert.ok(profile);
                expect(task.ecommerceExecution).toStrictEqual(compileEcommerceImageRequest(plan, profile));
                expect(task.ecommerceExecution).toMatchObject({ state: "ready", canvas: { mode: "exact", size: { width: 1024, height: 1024 } }, protection: { scope: "global", preserveOutsideMask: false, allowLightingChange: true } });
                expect(task.ecommerceExecution?.mask).toBeUndefined();
                expect(task.sceneProtection).toBeUndefined();
                expect(task.productProtectionRegions).toBeUndefined();
                expect(snapshot.processing?.prepareReferences).toMatchObject([{ jobId: prepare.id, inputDigest: prepare.payload.inputDigest, assetId: baseline.id, manifest: prepared.completion.manifest }]);
                expect(snapshot.processing?.sceneSelection).toBeUndefined();
                expect(snapshot.processing?.protection).toBeUndefined();
                expect(snapshot.processing?.waitingFor).toBeUndefined();
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((row) => row.type === "image_processing")).toStrictEqual([prepareBefore]);
                expect(created).toHaveLength(1);
                const copy = created[0];
                assert.ok(copy);
                expect(copy.requestId).toBe(initial.clientRequestId + ":ecommerce-scene-edit:1:1");
                expect(task.taskIds).toStrictEqual([copy.taskId]);
                expect(task.childTasks).toHaveLength(1);
                expect(task.childTasks).toMatchObject([{ id: copy.taskId, status: "pending", attempt: 1 }]);
                const original = await imageTasks.getImageTask(copy.taskId);
                assert.ok(original);
                expect(original).toMatchObject({
                    id: copy.taskId,
                    runId: initial.id,
                    parentTaskId: initial.id,
                    userId,
                    conversationId: conversation.id,
                    clientRequestId: copy.requestId,
                    status: "pending",
                    kind: "edit",
                    config: { quality: "4k", size: "1024x1024" },
                    references: [{ id: baseline.id, ecommerceRole: "scene", url: baseline.serverUrl }],
                    referenceDispatch: { copy: 1, inputId: referenceCheckpoint.inputId, decisionId: referenceCheckpoint.decisionId, analysisRequestId: referenceCheckpoint.analysisStage.requestId },
                });
                expect(original.ecommerceExecution).toStrictEqual(task.ecommerceExecution);
                expect(original.sceneProtection).toBeUndefined();
                expect(original.productProtection).toBeUndefined();
                expect(original.mask).toBeUndefined();
                expect(original.enhancementDelivery).toStrictEqual({ version: "ecommerce-delivery.v2", scope: "full_image", canvas: plan.canvas });
                expect(original.enhancementPolicy).toStrictEqual({ revision: enhancementSettings.revision, enabled: false, connection: null });
                expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual([]);
                expect(original.upstream).toBeUndefined();
                expect(original.nativeResults).toBeUndefined();
                expect(original.result).toBeUndefined();
                expect(boundary.create).not.toHaveBeenCalled();
                expect(boundary.poll).not.toHaveBeenCalled();
                expect(charges.size).toBe(0);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                const queried: { copy?: Awaited<ReturnType<typeof prepareNativeCopy>> } = {};
                // The helper's actual query/state assertion can fail first; it remains part of this gate.
                const createAndQueryPixels = await observeNativeSceneQaPixels(async () => {
                    queried.copy = await prepareNativeCopy(copy.taskId, native, imageOrigin);
                });
                const captured = queried.copy;
                assert.ok(captured, "SETUP: the original create/query must return its actual copy");
                assert.ok(captured.requested.nativeResults, "RED: if the original query passed its result_ready gate, this genuine global scene 4k full image copy must retain its provider native bytes before publication");
                const sealed = captured.requested;
                const nativeResults = captured.requested.nativeResults;
                expect(nativeResults.slots).toHaveLength(1);
                const slot = nativeResults.slots[0];
                assert.ok(slot.status === "stored");
                expect(slot).toMatchObject({ resultId: copy.taskId + ":1", resultIndex: 1, sha256: digest(native), bytes: native.length });
                expect(sealed.result).toBeUndefined();
                expect(sealed.enhancementDelivery).toStrictEqual(original.enhancementDelivery);
                expect(sealed.enhancementPolicy).toStrictEqual(original.enhancementPolicy);
                expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual([]);
                expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(native);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
                expect(charges.size).toBe(1);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((row) => row.type === "image_processing")).toStrictEqual([prepareBefore]);
                expect(await readFile(registeredSource.filePath)).toEqual(source);
                expect(planningAndDispatchPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(createAndQueryPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                // Root47645 reached the original 4k native gate; each successor below remains a separate gate.
                const parentExecutionId = dispatched.executionId;
                const chargedAccount = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                const persistence: { image?: Awaited<ReturnType<typeof runtime.persistImageTaskResult>> } = {};
                const persistPixels = await observeNativeSceneQaPixels(async () => {
                    persistence.image = await runtime.persistImageTaskResult(sealed, imageOrigin, captured.resultUrl, boundary.cookie);
                });
                expect(persistence.image, "RED: the original global scene 4k full image result must wait for its ordinary CPU Worker").toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
                const waiting = await imageTasks.getImageTask(copy.taskId);
                assert.ok(waiting?.nativeResults && waiting.resultProcessing);
                expect(waiting.nativeResults).toStrictEqual(sealed.nativeResults);
                expect(waiting.result).toBeUndefined();
                expect(waiting.enhancementDelivery).toStrictEqual(original.enhancementDelivery);
                expect(waiting.enhancementPolicy).toStrictEqual(original.enhancementPolicy);
                expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual([]);
                const resultJobId = waiting.resultProcessing.jobId;
                const expectedOptions = { mode: "ordinary", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false };
                const queued = await tasks.getStoredGenerationTaskRecord("image_processing", resultJobId);
                assert.ok(queued?.payload.operation === "process_result");
                expect(queued.payload.options, "Global 4k full image results must omit targetSize and all protection options").toStrictEqual(expectedOptions);
                expect(queued.payload.inputs).toHaveLength(1);
                expect(queued.payload).toMatchObject({ resource: { facts: { decodedInputs: [] } } });
                const waitingRecord = await tasks.getStoredGenerationTaskRecord("image", copy.taskId);
                expect(waitingRecord).toMatchObject({ status: "running", executionPhase: "persisting", runId: initial.id, parentTaskId: initial.id });
                expect(waitingRecord?.workerId).toBeUndefined();
                expect(waitingRecord?.leaseUntil).toBeUndefined();
                assert.ok(captured.claim.workerId && typeof captured.claim.payload.executionId === "string");
                expect(await processing.ensureImageTaskResultProcessing({ taskId: copy.taskId, workerId: captured.claim.workerId, executionId: captured.claim.payload.executionId })).toStrictEqual({ state: "ownership_lost" });
                const nativePath = path.join(REFERENCE_MEDIA_ROOT, slot.storageKey);
                const completion: { result?: Awaited<ReturnType<typeof completeCopy>> } = {};
                const workerAndConsumePixels = await observeNativeSceneQaPixels(async () => {
                    completion.result = await completeCopy({ submitted: captured.submitted, originalAttempt: captured.originalAttempt, charge: captured.charge, waiting, native, nativePath }, dispatched, imageOrigin, 1, {
                        size: { width: 1024, height: 1024 },
                        options: {},
                    });
                });
                const result = completion.result;
                assert.ok(result);
                const wire = result.worker.child.payload;
                assert.ok(wire.operation === "process_result");
                expect(wire.options, "The actual global 4k full image Worker wire contract must omit targetSize").toStrictEqual(expectedOptions);
                expect(wire.inputs).toHaveLength(1);
                expect(wire.inputs[0]).toMatchObject({ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 });
                expect(wire.resource.facts.decodedInputs).toStrictEqual([]);
                expect(wire.imageResultBinding?.run).toStrictEqual({ runId: initial.id, agentTaskId: task.id, agentAttempt: 1 });
                expect(result.worker.completion.metrics.pid).not.toBe(process.pid);
                expect(result.worker.completion.metrics.peakRssBytes).toBeGreaterThan(0);
                expect(result.worker.uploads[0].bytes).toEqual(native);
                expect(result.final).toMatchObject({ sha256: digest(native), bytes: native.length, width: 1024, height: 1024, mimeType: "image/png" });
                expect(result.final.sha256).not.toBe(digest(source));
                expect(await readFile(nativePath)).toEqual(native);
                expect(result.asset).toMatchObject({ status: "ready", sourceRunId: initial.id, sourceTaskId: copy.taskId });
                expect(result.asset.messageId).toBeUndefined();
                assert.ok(result.published.result?.results);
                expect(result.published.result.results).toHaveLength(1);
                const delivered = result.published.result.results[0];
                const nativeUrl = delivered.serverUrl;
                expect(delivered).toMatchObject({ resultId: copy.taskId + ":1", width: 1024, height: 1024, bytes: native.length, mimeType: "image/png" });
                expect(delivered.canvasEvidence).toStrictEqual({ constraint: plan.canvas, nativeSize: { width: 1024, height: 1024 }, storedSize: { width: 1024, height: 1024 }, nativeUrl, normalization: "none" });
                expect(result.published.result.batchEvidence).toStrictEqual([
                    { resultId: copy.taskId + ":1", resultIndex: 1, nativeStatus: "readable", nativeSize: { width: 1024, height: 1024 }, storageStatus: "stored", storedUrl: delivered.serverUrl, storedSize: { width: 1024, height: 1024 } },
                ]);
                expect(delivered.enhancementId).toBe("enhancement:" + copy.taskId + ":1");
                expect(delivered.nativeSource).toStrictEqual({ url: delivered.serverUrl, sha256: digest(native), byteLength: native.length, width: 1024, height: 1024, format: "png", hasAlpha: false, provenance: "provider_native" });
                expect(delivered.enhancementSource).toStrictEqual({ url: delivered.serverUrl, sha256: digest(native), byteLength: native.length, width: 1024, height: 1024, format: "png", hasAlpha: false, provenance: "generation_final" });
                expect(result.published.result.enhancementSource).toStrictEqual(delivered.enhancementSource);
                expect(delivered.enhancementSkip).toStrictEqual({ status: "skipped", reason: "disabled" });
                expect(result.published.result.enhancementSkip).toStrictEqual({ status: "skipped", reason: "disabled" });
                expect(delivered.sceneProtectionEvidence).toBeUndefined();
                expect(delivered.productEnhancementEvidence).toBeUndefined();
                expect(result.published.upstream).toStrictEqual(captured.submitted.upstream);
                expect(result.published.billing).toStrictEqual(captured.submitted.billing);
                expect(result.published.ecommerceExecution).toStrictEqual(original.ecommerceExecution);
                expect(result.published.references).toStrictEqual(original.references);
                expect(result.published.enhancementDelivery).toStrictEqual(original.enhancementDelivery);
                expect(result.published.enhancementPolicy).toStrictEqual(original.enhancementPolicy);
                const enhancementJobs = await listEnhancementJobsForTask(copy.taskId, userId);
                expect(enhancementJobs).toHaveLength(1);
                expect(enhancementJobs[0]).toMatchObject({
                    id: "enhancement:" + copy.taskId + ":1",
                    imageTaskId: copy.taskId,
                    resultId: copy.taskId + ":1",
                    status: "skipped",
                    phase: "completed",
                    reason: "disabled",
                    decision: { status: "skipped", reason: "disabled", source: delivered.enhancementSource, target: { width: 1024, height: 1024 } },
                    nextPollAt: null,
                    workerId: null,
                    leaseToken: null,
                    leaseUntil: null,
                });
                expect(enhancementJobs[0].decision).not.toHaveProperty("delivery");
                expect(enhancementJobs[0].remoteJobId).toBeUndefined();
                expect(enhancementJobs[0].submittedAt).toBeUndefined();
                expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                const agentPixels = await observeNativeSceneQaPixels(async () => {
                    await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                });
                const completed = await runs.getAgentRun(initial.id);
                expect(completed).toMatchObject({
                    id: initial.id,
                    conversationId: conversation.id,
                    inputMessageId: initial.inputMessageId,
                    assistantMessageId: initial.assistantMessageId,
                    status: "completed",
                    tasks: [{ id: task.id, count: 1, attempts: 1, status: "completed", taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "completed", attempt: 1 }] }],
                    ecommerceSnapshot: {
                        qualityPolicy: "disabled",
                        technicalCheck: {
                            status: "passed",
                            canvasEvidence: [
                                {
                                    resultId: copy.taskId + ":1",
                                    resultIndex: 1,
                                    storageStatus: "stored",
                                    nativeSize: { width: 1024, height: 1024 },
                                    storedSize: { width: 1024, height: 1024 },
                                    nativeStatus: "readable",
                                    storedStatus: "readable",
                                    nativeMatches: true,
                                    storedMatches: true,
                                    normalization: "none",
                                    mappingVerified: false,
                                    hardFailures: [],
                                },
                            ],
                        },
                    },
                });
                assert.ok(completed?.ecommerceSnapshot?.technicalCheck);
                expect(completed.executionId).toBeUndefined();
                expect(completed.ecommerceSnapshot.plan).toStrictEqual(plan);
                expect(completed.ecommerceSnapshot.technicalCheck.checks).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ resultId: copy.taskId + ":1", key: "canvas_geometry", source: "media", status: "passed" }),
                        expect.objectContaining({ resultId: copy.taskId + ":1", key: "unmodified_region", source: "protection", status: "not_applicable", reason: "当前全局编辑没有局部选区外像素不变承诺" }),
                    ]),
                );
                expect(completed.ecommerceSnapshot.qualityCheck).toBeUndefined();
                expect(completed.assetIds).toStrictEqual([result.asset.id]);
                expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual(enhancementJobs);
                const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                expect(parentRecord).toMatchObject({ status: "success", payload: { status: "completed" } });
                const assets = await creative.listAssetsForUser(userId, conversation.id);
                expect(assets).toHaveLength(2);
                expect(assets.find((asset) => asset.id === result.asset.id)).toMatchObject({
                    parentAssetId: baseline.id,
                    sourceRunId: initial.id,
                    sourceTaskId: copy.taskId,
                    messageId: initial.assistantMessageId,
                    serverUrl: delivered.serverUrl,
                    metadata: { agentTaskId: task.id, parentAssetIds: [baseline.id] },
                });
                const messages = await creative.listMessagesForUser(userId, conversation.id, 0, 100);
                expect(messages).toHaveLength(2);
                expect(messages.find((message) => message.id === initial.inputMessageId)).toMatchObject({ conversationId: conversation.id, role: "user", status: "completed", content: initial.prompt });
                expect(messages.find((message) => message.id === initial.assistantMessageId)).toMatchObject({ conversationId: conversation.id, role: "assistant", status: "completed", metadata: { assetIds: [result.asset.id], taskIds: [copy.taskId] } });
                const successfulLogs = (await logs.listGenerationLogs({ userId })).items;
                expect(successfulLogs).toHaveLength(1);
                expect(successfulLogs[0]).toMatchObject({ id: "image-task:" + copy.taskId, taskId: copy.taskId, status: "success", count: 1, successCount: 1, failCount: 0, assets: [{ serverUrl: delivered.serverUrl, width: 1024, height: 1024 }] });
                expect(captured.charge.cost).toBe(2);
                const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                expect(debits.records).toHaveLength(1);
                expect(debits.records[0]).toMatchObject({ id: captured.charge.recordId, userId, type: "consume", amount: -2, idempotencyKey: "fixture-run-copy:" + copy.taskId });
                expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                const stages = (await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((record) => record.type === "image_processing");
                expect(stages).toHaveLength(2);
                expect(stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([prepare.id, resultJobId]));
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                expect(await readFile(registeredSource.filePath)).toEqual(source);
                const finalImage = await imageTasks.getImageTask(copy.taskId);
                expect(finalImage).toMatchObject({
                    id: copy.taskId,
                    runId: initial.id,
                    parentTaskId: initial.id,
                    conversationId: conversation.id,
                    clientRequestId: copy.requestId,
                    status: "success",
                    ecommerceTrace: { runId: initial.id, agentTaskId: task.id, imageTaskIds: [copy.taskId], finalStatus: "completed" },
                });
                expect(finalImage?.enhancementDelivery).toStrictEqual(original.enhancementDelivery);
                expect(finalImage?.enhancementPolicy).toStrictEqual(original.enhancementPolicy);
                expect(finalImage?.nativeResults).toStrictEqual(sealed.nativeResults);
                expect(finalImage?.result).toStrictEqual(result.published.result);
                const settled = await ownedRows(conversation.id);
                const replayPixels = await observeNativeSceneQaPixels(async () => {
                    expect(await service.completeImageProcessingTask(result.worker.child.id, result.worker.completion)).toStrictEqual(result.worker.receipt);
                    expect(await recovery.runGenerationTaskRecoveryBatch(result.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                    expect(await runtime.persistImageTaskResult(result.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalImage);
                    await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                });
                expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual(enhancementJobs);
                expect(await imageTasks.getImageTask(copy.taskId)).toStrictEqual(finalImage);
                expect(await readFile(registeredSource.filePath)).toEqual(source);
                expect(await creative.listMessagesForUser(userId, conversation.id, 0, 100)).toStrictEqual(messages);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(debits);
                expect(await readFile(nativePath)).toEqual(native);
                expect(created).toHaveLength(1);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
                expect(charges.size).toBe(1);
                expect(persistPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(workerAndConsumePixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(agentPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(replayPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
            });
        }, 120_000);

        it("captures one native global scene Canvas Run copy before result processing", async () => {
            const route = await configureNativeScenePlanning();
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "One native global scene Run" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                .png()
                .toBuffer();
            const baseline = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "native-global-scene.png", { type: "image/png" }));
            assert.ok(baseline.storageKey && baseline.serverUrl);
            const registeredSource = await references.readReferenceAsset(baseline.storageKey);
            assert.ok(registeredSource);
            expect(await readFile(registeredSource.filePath)).toEqual(source);
            installNativeGlobalScenePlanningReplies(baseline.id);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-global-scene-result-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，全局调整光线为明亮自然日光，保留原机位、布局和原图尺寸",
                    assetIds: [baseline.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 1, quality: "low", size: "1024x1024" } },
                })
            ).run;
            // This value only supplies HTTP expectations; executeAgentRun creates the persisted task.
            const expectedTask: AgentRunTask = { id: "ecommerce-scene-edit", type: "image", title: "Global scene", prompt: "Route expectation", count: 1, quality: "low", ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
            await withImageRoutes(initial, expectedTask, async (imageOrigin, created) => {
                await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
                await claimNativeSceneRun(initial.id, "fixture-native-global-scene-prepare-parent", imageOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                expect(prepare.payload.inputs).toMatchObject([{ assetId: baseline.id }]);
                expect(boundary.model).not.toHaveBeenCalled();
                const prepared = await completeNativeSceneStage(prepare.id);
                const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id);
                assert.ok(prepareBefore?.resultPayload?.manifestDigest);
                expect(prepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { executionId: prepared.child.executionId, manifest: prepared.completion.manifest } });
                const dispatch: { run?: AgentRun } = {};
                const planningAndDispatchPixels = await observeNativeSceneQaPixels(async () => {
                    dispatch.run = await claimNativeSceneRun(initial.id, "fixture-native-global-scene-planning-parent", imageOrigin);
                });
                const dispatched = dispatch.run;
                assert.ok(dispatched?.executionId, "SETUP: real global scene planning must retain the parent execution" + " " + JSON.stringify({ run: dispatched, tools: boundary.model.mock.calls.map(([request]) => request.tool.name) }));
                const snapshot = dispatched.ecommerceSnapshot;
                const qualification = JSON.stringify({ status: dispatched.status, failure: dispatched.failure, snapshot, tasks: dispatched.tasks, tools: boundary.model.mock.calls.map(([request]) => request.tool.name) });
                expect(snapshot, "SETUP: actual global scene planning and dispatch must precede the native result gate: " + qualification).toMatchObject({
                    mode: "active",
                    qualityPolicy: "disabled",
                    referenceCheckpoint: { state: "resolved", analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                    plan: {
                        planVersion: "ecommerce-edit.v6",
                        operation: "scene_edit",
                        strategy: "integrated_scene",
                        source: { productAnchorId: null, currentSceneBaselineId: baseline.id, sceneReferenceIds: [] },
                        canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false },
                        protection: { scope: "global", preserveOutsideMask: false, allowLightingChange: true },
                    },
                });
                assert.ok(snapshot?.plan && snapshot.referenceCheckpoint);
                const plan = snapshot.plan;
                const referenceCheckpoint = snapshot.referenceCheckpoint;
                expect(snapshot.modelRouteSnapshots?.image_generation).toStrictEqual(route.snapshot);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                expect(dispatched).toMatchObject({ status: "running", tasks: [{ id: "ecommerce-scene-edit", type: "image", status: "running", attempts: 1, count: 1, quality: "low", ratio: "1024x1024" }] });
                expect(dispatched.tasks).toHaveLength(1);
                const task = dispatched.tasks[0];
                assert.ok(task);
                const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
                const profile = resolveEcommerceImageProviderProfile(route.snapshot);
                assert.ok(profile);
                expect(task.ecommerceExecution).toStrictEqual(compileEcommerceImageRequest(plan, profile));
                expect(task.ecommerceExecution).toMatchObject({ state: "ready", canvas: { mode: "exact", size: { width: 1024, height: 1024 } }, protection: { scope: "global", preserveOutsideMask: false, allowLightingChange: true } });
                expect(task.ecommerceExecution?.mask).toBeUndefined();
                expect(task.sceneProtection).toBeUndefined();
                expect(task.productProtectionRegions).toBeUndefined();
                expect(snapshot.processing?.prepareReferences).toMatchObject([{ jobId: prepare.id, inputDigest: prepare.payload.inputDigest, assetId: baseline.id, manifest: prepared.completion.manifest }]);
                expect(snapshot.processing?.sceneSelection).toBeUndefined();
                expect(snapshot.processing?.protection).toBeUndefined();
                expect(snapshot.processing?.waitingFor).toBeUndefined();
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((row) => row.type === "image_processing")).toStrictEqual([prepareBefore]);
                expect(created).toHaveLength(1);
                const copy = created[0];
                assert.ok(copy);
                expect(copy.requestId).toBe(initial.clientRequestId + ":ecommerce-scene-edit:1:1");
                expect(task.taskIds).toStrictEqual([copy.taskId]);
                expect(task.childTasks).toHaveLength(1);
                expect(task.childTasks).toMatchObject([{ id: copy.taskId, status: "pending", attempt: 1 }]);
                const original = await imageTasks.getImageTask(copy.taskId);
                assert.ok(original);
                expect(original).toMatchObject({
                    id: copy.taskId,
                    runId: initial.id,
                    parentTaskId: initial.id,
                    userId,
                    conversationId: conversation.id,
                    clientRequestId: copy.requestId,
                    status: "pending",
                    kind: "edit",
                    config: { quality: "low", size: "1024x1024" },
                    references: [{ id: baseline.id, ecommerceRole: "scene", url: baseline.serverUrl }],
                    referenceDispatch: { copy: 1, inputId: referenceCheckpoint.inputId, decisionId: referenceCheckpoint.decisionId, analysisRequestId: referenceCheckpoint.analysisStage.requestId },
                });
                expect(original.ecommerceExecution).toStrictEqual(task.ecommerceExecution);
                expect(original.sceneProtection).toBeUndefined();
                expect(original.productProtection).toBeUndefined();
                expect(original.mask).toBeUndefined();
                expect(original.enhancementDelivery).toBeUndefined();
                expect(original.upstream).toBeUndefined();
                expect(original.nativeResults).toBeUndefined();
                expect(original.result).toBeUndefined();
                expect(boundary.create).not.toHaveBeenCalled();
                expect(boundary.poll).not.toHaveBeenCalled();
                expect(charges.size).toBe(0);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                const queried: { copy?: Awaited<ReturnType<typeof prepareNativeCopy>> } = {};
                // The helper's actual query/state assertion can fail first; it remains part of this gate.
                const createAndQueryPixels = await observeNativeSceneQaPixels(async () => {
                    queried.copy = await prepareNativeCopy(copy.taskId, native, imageOrigin);
                });
                const captured = queried.copy;
                assert.ok(captured, "SETUP: the original create/query must return its actual copy");
                assert.ok(captured.requested.nativeResults, "RED: if the original query passed its result_ready gate, this genuine global scene Canvas copy must retain its provider native bytes before publication");
                const sealed = captured.requested;
                const nativeResults = captured.requested.nativeResults;
                expect(nativeResults.slots).toHaveLength(1);
                const slot = nativeResults.slots[0];
                assert.ok(slot.status === "stored");
                expect(slot).toMatchObject({ resultId: copy.taskId + ":1", resultIndex: 1, sha256: digest(native), bytes: native.length });
                expect(sealed.result).toBeUndefined();
                expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(native);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
                expect(charges.size).toBe(1);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((row) => row.type === "image_processing")).toStrictEqual([prepareBefore]);
                expect(await readFile(registeredSource.filePath)).toEqual(source);
                expect(planningAndDispatchPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(createAndQueryPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                // Root92096 reached the original native gate; each successor below remains a separate gate.
                const parentExecutionId = dispatched.executionId;
                const chargedAccount = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                const persistence: { image?: Awaited<ReturnType<typeof runtime.persistImageTaskResult>> } = {};
                const persistPixels = await observeNativeSceneQaPixels(async () => {
                    persistence.image = await runtime.persistImageTaskResult(sealed, imageOrigin, captured.resultUrl, boundary.cookie);
                });
                expect(persistence.image, "RED: the original global scene result must wait for its ordinary CPU Worker").toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
                const waiting = await imageTasks.getImageTask(copy.taskId);
                assert.ok(waiting?.nativeResults && waiting.resultProcessing);
                expect(waiting.nativeResults).toStrictEqual(sealed.nativeResults);
                expect(waiting.result).toBeUndefined();
                const resultJobId = waiting.resultProcessing.jobId;
                const expectedOptions = { mode: "ordinary", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false };
                const queued = await tasks.getStoredGenerationTaskRecord("image_processing", resultJobId);
                assert.ok(queued?.payload.operation === "process_result");
                expect(queued.payload.options, "Global Canvas results must omit targetSize and all protection options").toStrictEqual(expectedOptions);
                expect(queued.payload.inputs).toHaveLength(1);
                expect(queued.payload).toMatchObject({ resource: { facts: { decodedInputs: [] } } });
                const waitingRecord = await tasks.getStoredGenerationTaskRecord("image", copy.taskId);
                expect(waitingRecord).toMatchObject({ status: "running", executionPhase: "persisting", runId: initial.id, parentTaskId: initial.id });
                expect(waitingRecord?.workerId).toBeUndefined();
                expect(waitingRecord?.leaseUntil).toBeUndefined();
                assert.ok(captured.claim.workerId && typeof captured.claim.payload.executionId === "string");
                expect(await processing.ensureImageTaskResultProcessing({ taskId: copy.taskId, workerId: captured.claim.workerId, executionId: captured.claim.payload.executionId })).toStrictEqual({ state: "ownership_lost" });
                const nativePath = path.join(REFERENCE_MEDIA_ROOT, slot.storageKey);
                const completion: { result?: Awaited<ReturnType<typeof completeCopy>> } = {};
                const workerAndConsumePixels = await observeNativeSceneQaPixels(async () => {
                    completion.result = await completeCopy({ submitted: captured.submitted, originalAttempt: captured.originalAttempt, charge: captured.charge, waiting, native, nativePath }, dispatched, imageOrigin, 1, {
                        size: { width: 1024, height: 1024 },
                        options: {},
                    });
                });
                const result = completion.result;
                assert.ok(result);
                const wire = result.worker.child.payload;
                assert.ok(wire.operation === "process_result");
                expect(wire.options, "The actual global Worker wire contract must omit targetSize").toStrictEqual(expectedOptions);
                expect(wire.inputs).toHaveLength(1);
                expect(wire.inputs[0]).toMatchObject({ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 });
                expect(wire.resource.facts.decodedInputs).toStrictEqual([]);
                expect(wire.imageResultBinding?.run).toStrictEqual({ runId: initial.id, agentTaskId: task.id, agentAttempt: 1 });
                expect(result.worker.completion.metrics.pid).not.toBe(process.pid);
                expect(result.worker.completion.metrics.peakRssBytes).toBeGreaterThan(0);
                expect(result.worker.uploads[0].bytes).toEqual(native);
                expect(result.final).toMatchObject({ sha256: digest(native), bytes: native.length, width: 1024, height: 1024, mimeType: "image/png" });
                expect(result.final.sha256).not.toBe(digest(source));
                expect(await readFile(nativePath)).toEqual(native);
                expect(result.asset).toMatchObject({ status: "ready", sourceRunId: initial.id, sourceTaskId: copy.taskId });
                expect(result.asset.messageId).toBeUndefined();
                assert.ok(result.published.result?.results);
                expect(result.published.result.results).toHaveLength(1);
                const delivered = result.published.result.results[0];
                const nativeUrl = "/api/reference-assets/" + slot.storageKey.split("/").map(encodeURIComponent).join("/");
                expect(delivered).toMatchObject({ resultId: copy.taskId + ":1", width: 1024, height: 1024, bytes: native.length, mimeType: "image/png" });
                expect(delivered.canvasEvidence).toStrictEqual({ constraint: plan.canvas, nativeSize: { width: 1024, height: 1024 }, storedSize: { width: 1024, height: 1024 }, nativeUrl, normalization: "none" });
                expect(result.published.result.batchEvidence).toStrictEqual([
                    { resultId: copy.taskId + ":1", resultIndex: 1, nativeStatus: "readable", nativeSize: { width: 1024, height: 1024 }, storageStatus: "stored", storedUrl: delivered.serverUrl, storedSize: { width: 1024, height: 1024 } },
                ]);
                expect(delivered.sceneProtectionEvidence).toBeUndefined();
                expect(delivered.productEnhancementEvidence).toBeUndefined();
                expect(result.published.upstream).toStrictEqual(captured.submitted.upstream);
                expect(result.published.billing).toStrictEqual(captured.submitted.billing);
                expect(result.published.ecommerceExecution).toStrictEqual(original.ecommerceExecution);
                expect(result.published.references).toStrictEqual(original.references);
                expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                const agentPixels = await observeNativeSceneQaPixels(async () => {
                    await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                });
                const completed = await runs.getAgentRun(initial.id);
                expect(completed).toMatchObject({
                    id: initial.id,
                    conversationId: conversation.id,
                    inputMessageId: initial.inputMessageId,
                    assistantMessageId: initial.assistantMessageId,
                    status: "completed",
                    tasks: [{ id: task.id, count: 1, attempts: 1, status: "completed", taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "completed", attempt: 1 }] }],
                    ecommerceSnapshot: {
                        qualityPolicy: "disabled",
                        technicalCheck: {
                            status: "passed",
                            canvasEvidence: [
                                {
                                    resultId: copy.taskId + ":1",
                                    resultIndex: 1,
                                    storageStatus: "stored",
                                    nativeSize: { width: 1024, height: 1024 },
                                    storedSize: { width: 1024, height: 1024 },
                                    nativeStatus: "readable",
                                    storedStatus: "readable",
                                    nativeMatches: true,
                                    storedMatches: true,
                                    normalization: "none",
                                    mappingVerified: false,
                                    hardFailures: [],
                                },
                            ],
                        },
                    },
                });
                assert.ok(completed?.ecommerceSnapshot?.technicalCheck);
                expect(completed.executionId).toBeUndefined();
                expect(completed.ecommerceSnapshot.plan).toStrictEqual(plan);
                expect(completed.ecommerceSnapshot.technicalCheck.checks).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ resultId: copy.taskId + ":1", key: "canvas_geometry", source: "media", status: "passed" }),
                        expect.objectContaining({ resultId: copy.taskId + ":1", key: "unmodified_region", source: "protection", status: "not_applicable", reason: "当前全局编辑没有局部选区外像素不变承诺" }),
                    ]),
                );
                expect(completed.ecommerceSnapshot.qualityCheck).toBeUndefined();
                expect(completed.assetIds).toStrictEqual([result.asset.id]);
                const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                expect(parentRecord).toMatchObject({ status: "success", payload: { status: "completed" } });
                const assets = await creative.listAssetsForUser(userId, conversation.id);
                expect(assets).toHaveLength(2);
                expect(assets.find((asset) => asset.id === result.asset.id)).toMatchObject({
                    parentAssetId: baseline.id,
                    sourceRunId: initial.id,
                    sourceTaskId: copy.taskId,
                    messageId: initial.assistantMessageId,
                    serverUrl: delivered.serverUrl,
                    metadata: { agentTaskId: task.id, parentAssetIds: [baseline.id] },
                });
                const messages = await creative.listMessagesForUser(userId, conversation.id, 0, 100);
                expect(messages).toHaveLength(2);
                expect(messages.find((message) => message.id === initial.inputMessageId)).toMatchObject({ conversationId: conversation.id, role: "user", status: "completed", content: initial.prompt });
                expect(messages.find((message) => message.id === initial.assistantMessageId)).toMatchObject({ conversationId: conversation.id, role: "assistant", status: "completed", metadata: { assetIds: [result.asset.id], taskIds: [copy.taskId] } });
                const successfulLogs = (await logs.listGenerationLogs({ userId })).items;
                expect(successfulLogs).toHaveLength(1);
                expect(successfulLogs[0]).toMatchObject({ id: "image-task:" + copy.taskId, taskId: copy.taskId, status: "success", count: 1, successCount: 1, failCount: 0, assets: [{ serverUrl: delivered.serverUrl, width: 1024, height: 1024 }] });
                expect(captured.charge.cost).toBe(2);
                const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                expect(debits.records).toHaveLength(1);
                expect(debits.records[0]).toMatchObject({ id: captured.charge.recordId, userId, type: "consume", amount: -2, idempotencyKey: "fixture-run-copy:" + copy.taskId });
                expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                const stages = (await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((record) => record.type === "image_processing");
                expect(stages).toHaveLength(2);
                expect(stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([prepare.id, resultJobId]));
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                expect(await readFile(registeredSource.filePath)).toEqual(source);
                const finalImage = await imageTasks.getImageTask(copy.taskId);
                expect(finalImage).toMatchObject({
                    id: copy.taskId,
                    runId: initial.id,
                    parentTaskId: initial.id,
                    conversationId: conversation.id,
                    clientRequestId: copy.requestId,
                    status: "success",
                    ecommerceTrace: { runId: initial.id, agentTaskId: task.id, imageTaskIds: [copy.taskId], finalStatus: "completed" },
                });
                const settled = await ownedRows(conversation.id);
                const replayPixels = await observeNativeSceneQaPixels(async () => {
                    expect(await service.completeImageProcessingTask(result.worker.child.id, result.worker.completion)).toStrictEqual(result.worker.receipt);
                    expect(await recovery.runGenerationTaskRecoveryBatch(result.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                    expect(await runtime.persistImageTaskResult(result.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalImage);
                    await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                });
                expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                expect(await creative.listMessagesForUser(userId, conversation.id, 0, 100)).toStrictEqual(messages);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(debits);
                expect(await readFile(nativePath)).toEqual(native);
                expect(created).toHaveLength(1);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
                expect(charges.size).toBe(1);
                expect(persistPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(workerAndConsumePixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(agentPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                expect(replayPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
            });
        }, 120_000);

        it.each([
            ["captures one native local product edit Run copy before result processing", "low", undefined, async () => {}],
            [
                "captures one native 4k local product edit Run copy before result processing",
                "4k",
                { status: "skipped", reason: "disabled" },
                async () => {
                    const { readImageEnhancementSettings } = await import("./database/image-enhancement-repository");
                    const enhancementSettings = await readImageEnhancementSettings();
                    expect(enhancementSettings.enabled, "SETUP: this 4k local product profile requires the existing enhancement policy to be disabled").toBe(false);
                },
            ],
        ] as const)(
            "%s",
            async (_title, quality, enhancementSkip, setup) => {
                await setup();
                const route = await configureNativeScenePlanning();
                const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "One native local product edit Run" });
                const productBytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
                    .composite([
                        { input: { create: { width: 384, height: 464, channels: 3, background: "#e6e1da" } }, left: 320, top: 280 },
                        { input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 },
                    ])
                    .png()
                    .toBuffer();
                const sceneBytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#a0b0c0" } })
                    .composite([
                        { input: { create: { width: 320, height: 576, channels: 3, background: "#929a9e" } }, left: 352, top: 224 },
                        { input: { create: { width: 256, height: 512, channels: 3, background: "#8a6243" } }, left: 384, top: 256 },
                        { input: { create: { width: 128, height: 192, channels: 3, background: "#436a9c" } }, left: 128, top: 384 },
                    ])
                    .png()
                    .toBuffer();
                const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#a0b0c0" } })
                    .composite([
                        { input: { create: { width: 320, height: 576, channels: 3, background: "#929a9e" } }, left: 352, top: 224 },
                        { input: { create: { width: 256, height: 512, channels: 3, background: "#8a6243" } }, left: 384, top: 256 },
                        { input: { create: { width: 128, height: 192, channels: 3, background: "#3b8a51" } }, left: 128, top: 384 },
                    ])
                    .png()
                    .toBuffer();
                const product = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(productBytes)], "local-product-anchor.png", { type: "image/png" }));
                const scene = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(sceneBytes)], "local-product-scene.png", { type: "image/png" }));
                assert.ok(product.storageKey && product.serverUrl && scene.storageKey && scene.serverUrl);
                expect(scene.id).not.toBe(product.id);
                const registeredProduct = await references.readReferenceAsset(product.storageKey);
                const registeredScene = await references.readReferenceAsset(scene.storageKey);
                assert.ok(registeredProduct && registeredScene);
                expect(await readFile(registeredProduct.filePath)).toEqual(productBytes);
                expect(await readFile(registeredScene.filePath)).toEqual(sceneBytes);
                installNativeLocalProductPlanningReplies(product.id, scene.id);
                const initial = (
                    await runs.createAgentRun(userId, {
                        clientRequestId: "fixture-native-local-product-result-" + randomUUID(),
                        conversationId: conversation.id,
                        surface: "chat",
                        prompt: "参考图片1的商品身份，把图片2左侧花瓶换成小盆绿植，保留柜体外观、原机位和光线，保留原图尺寸",
                        assetIds: [product.id, scene.id],
                        skillIds: [],
                        modelIds: [],
                        preferences: { mode: "image", image: { count: 1, quality, size: "1024x1024" } },
                    })
                ).run;
                await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
                await withSceneRoutes(initial.id, async (referenceOrigin) => {
                    await claimNativeSceneRun(initial.id, "fixture-native-local-product-prepare-anchor", referenceOrigin);
                    const productPrepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                    expect(productPrepare.payload.inputs).toMatchObject([{ assetId: product.id }]);
                    expect(boundary.model).not.toHaveBeenCalled();
                    const preparedProduct = await completeNativeSceneStage(productPrepare.id);
                    const productPrepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", productPrepare.id);
                    expect(productPrepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: preparedProduct.completion.manifest } });
                    await claimNativeSceneRun(initial.id, "fixture-native-local-product-prepare-scene", referenceOrigin);
                    const scenePrepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                    expect(scenePrepare.payload.inputs).toMatchObject([{ assetId: scene.id }]);
                    expect(scenePrepare.id).not.toBe(productPrepare.id);
                    expect(boundary.model).not.toHaveBeenCalled();
                    const preparedScene = await completeNativeSceneStage(scenePrepare.id);
                    const scenePrepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", scenePrepare.id);
                    expect(scenePrepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: preparedScene.completion.manifest } });
                    const planning: { run?: AgentRun } = {};
                    const planningPixels = await observeNativeSceneQaPixels(async () => {
                        planning.run = await claimNativeSceneRun(initial.id, "fixture-native-local-product-planning", referenceOrigin);
                    });
                    const planned = planning.run;
                    assert.ok(planned);
                    const snapshot = planned.ecommerceSnapshot;
                    const qualification = JSON.stringify({ status: planned.status, failure: planned.failure, snapshot, tasks: planned.tasks, tools: boundary.model.mock.calls.map(([request]) => request.tool.name) });
                    expect(snapshot, "SETUP: actual dual-source local planning must precede the native result gate: " + qualification).toMatchObject({
                        mode: "active",
                        qualityPolicy: "disabled",
                        referenceCheckpoint: { state: "resolved", analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                        plan: {
                            planVersion: "ecommerce-edit.v6",
                            operation: "local_edit",
                            strategy: "strict_product",
                            source: { productAnchorId: product.id, currentSceneBaselineId: scene.id, sceneReferenceIds: [] },
                            delta: { targetObjects: ["left-vase"], targetRegions: [] },
                            protection: { scope: "local", protectedObjectIds: [product.id], preserveOutsideMask: false, allowLightingChange: false },
                            canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false },
                        },
                    });
                    assert.ok(snapshot?.plan && snapshot.referenceCheckpoint);
                    const plan = snapshot.plan;
                    expect(snapshot.modelRouteSnapshots?.image_generation).toStrictEqual(route.snapshot);
                    expect(snapshot.processing?.prepareReferences).toMatchObject([
                        { jobId: productPrepare.id, assetId: product.id },
                        { jobId: scenePrepare.id, assetId: scene.id },
                    ]);
                    expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                    expect(planned.tasks).toStrictEqual([]);
                    const build = await nativeSceneWaitingStage(initial.id, "build_protection", "ecommerce-local-edit");
                    expect(build.payload.inputs).toMatchObject([{ assetId: scene.id, expectedSha256: digest(sceneBytes) }]);
                    assert.ok(build.payload.operation === "build_protection");
                    expect(build.payload.options).toStrictEqual({
                        mode: "local_edit",
                        targetRegion: { x: 0.125, y: 0.375, width: 0.125, height: 0.1875 },
                        protectedRectangles: [
                            { x: 384, y: 256, width: 256, height: 512 },
                            { x: 352, y: 224, width: 320, height: 32 },
                            { x: 352, y: 256, width: 32, height: 512 },
                            { x: 640, y: 256, width: 32, height: 512 },
                            { x: 352, y: 768, width: 320, height: 32 },
                        ],
                    });
                    const built = await completeNativeSceneStage(build.id);
                    expect(built.completion.manifest.sourceIdentities).toMatchObject([{ assetId: scene.id, sha256: digest(sceneBytes), width: 1024, height: 1024 }]);
                    expect(built.stored).toMatchObject({ kind: "mask", width: 1024, height: 1024 });
                    const buildBefore = await tasks.getStoredGenerationTaskRecord("image_processing", build.id);
                    expect(buildBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: built.completion.manifest } });
                    const registeredMask = await references.readReferenceAsset(built.stored.storageKey);
                    assert.ok(registeredMask);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    const maskUrl = "/api/reference-assets/" + built.stored.storageKey.split("/").map(encodeURIComponent).join("/");
                    // Only HTTP expectations use this value; the real producer creates and persists the task.
                    const expectedTask: AgentRunTask = { id: "ecommerce-local-edit", type: "image", title: "Local product edit", prompt: "Route expectation", count: 1, quality, ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
                    await withImageRoutes(planned, expectedTask, async (imageOrigin, created) => {
                        const dispatch: { run?: AgentRun } = {};
                        const dispatchPixels = await observeNativeSceneQaPixels(async () => {
                            dispatch.run = await claimNativeSceneRun(initial.id, "fixture-native-local-product-dispatch", imageOrigin);
                        });
                        const dispatched = dispatch.run;
                        assert.ok(dispatched?.executionId, "SETUP: actual local product dispatch must retain its parent execution");
                        const task = dispatched.tasks[0];
                        assert.ok(task?.productProtectionRegions);
                        expect(task).toMatchObject({ id: "ecommerce-local-edit", status: "running", attempts: 1, count: 1, quality, ecommerceExecution: { state: "ready", mask: { mode: "independent", required: true } } });
                        expect(task.productProtectionRegions).toMatchObject({
                            productAnchorId: product.id,
                            sourceAssetId: scene.id,
                            sourceSize: { width: 1024, height: 1024 },
                            editableBackground: { mask: { trust: "trusted", provider: "local-edit-target.v1" } },
                        });
                        expect(task.productProtectionRegions.editableBackground.mask?.reference).toMatchObject({ dataUrl: "", serverUrl: maskUrl, width: 1024, height: 1024 });
                        expect(task.sceneProtection).toBeUndefined();
                        const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
                        const profile = resolveEcommerceImageProviderProfile(route.snapshot);
                        assert.ok(profile);
                        expect(task.ecommerceExecution).toStrictEqual(compileEcommerceImageRequest(plan, profile));
                        expect(dispatched.ecommerceSnapshot?.plan).toStrictEqual(plan);
                        expect(dispatched.ecommerceSnapshot?.processing?.protection).toMatchObject({ jobId: build.id, inputDigest: build.payload.inputDigest, manifest: built.completion.manifest });
                        expect(created).toHaveLength(1);
                        const copy = created[0];
                        assert.ok(copy);
                        expect(copy.requestId).toBe(initial.clientRequestId + ":ecommerce-local-edit:1:1");
                        expect(task.taskIds).toStrictEqual([copy.taskId]);
                        expect(task.childTasks).toMatchObject([{ id: copy.taskId, status: "pending", attempt: 1 }]);
                        const original = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(original);
                        expect(original).toMatchObject({
                            id: copy.taskId,
                            runId: initial.id,
                            parentTaskId: initial.id,
                            conversationId: conversation.id,
                            clientRequestId: copy.requestId,
                            status: "pending",
                            kind: "edit",
                            config: { quality, size: "1024x1024" },
                            references: [
                                { id: scene.id, ecommerceRole: "scene", url: scene.serverUrl },
                                { id: product.id, ecommerceRole: "product", url: product.serverUrl },
                            ],
                            productProtection: { state: "ready", productAnchorId: product.id, sourceAssetId: scene.id, sourceSize: { width: 1024, height: 1024 }, maskProvider: "local-edit-target.v1" },
                        });
                        expect(original.ecommerceExecution).toStrictEqual(task.ecommerceExecution);
                        expect(original.mask).toStrictEqual(task.productProtectionRegions.editableBackground.mask?.reference);
                        expect(original.sceneProtection).toBeUndefined();
                        expect(original.enhancementDelivery).toBeUndefined();
                        expect(original.upstream).toBeUndefined();
                        expect(original.nativeResults).toBeUndefined();
                        expect(original.resultProcessing).toBeUndefined();
                        expect(original.result).toBeUndefined();
                        expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual([]);
                        expect(boundary.create).not.toHaveBeenCalled();
                        expect(boundary.poll).not.toHaveBeenCalled();
                        expect(charges.size).toBe(0);
                        const queried: { copy?: Awaited<ReturnType<typeof prepareNativeCopy>> } = {};
                        const queryPixels = await observeNativeSceneQaPixels(async () => {
                            queried.copy = await prepareNativeCopy(copy.taskId, native, imageOrigin);
                        });
                        const captured = queried.copy;
                        assert.ok(captured, "SETUP: the original local product create/query must return its actual copy");
                        const sealed = captured.requested;
                        assert.ok(sealed.nativeResults, "RED: after the original result_ready gate, this genuine local product edit copy must retain its provider native bytes before publication");
                        expect(sealed.nativeResults.slots).toHaveLength(1);
                        const slot = sealed.nativeResults.slots[0];
                        assert.ok(slot.status === "stored");
                        expect(slot).toMatchObject({ resultId: copy.taskId + ":1", resultIndex: 1, sha256: digest(native), bytes: native.length });
                        expect(sealed.resultProcessing).toBeUndefined();
                        expect(sealed.result).toBeUndefined();
                        expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual([]);
                        expect(sealed.sceneProtection).toBeUndefined();
                        expect(sealed.productProtection).toStrictEqual(original.productProtection);
                        expect(sealed.mask).toStrictEqual(original.mask);
                        expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                        const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                        expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(native);
                        expect(boundary.create).toHaveBeenCalledTimes(1);
                        expect(boundary.poll).toHaveBeenCalledTimes(1);
                        expect(charges.size).toBe(1);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", productPrepare.id)).toStrictEqual(productPrepareBefore);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", scenePrepare.id)).toStrictEqual(scenePrepareBefore);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                        expect((await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((row) => row.type === "image_processing" && row.payload.operation === "process_result")).toStrictEqual([]);
                        expect(await readFile(registeredProduct.filePath)).toEqual(productBytes);
                        expect(await readFile(registeredScene.filePath)).toEqual(sceneBytes);
                        expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                        expect(planningPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(dispatchPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(queryPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        // The original native RED and each successor below remain separate gates.
                        const parentExecutionId = dispatched.executionId;
                        const chargedAccount = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                        const persistence: { image?: Awaited<ReturnType<typeof runtime.persistImageTaskResult>> } = {};
                        const persistPixels = await observeNativeSceneQaPixels(async () => {
                            persistence.image = await runtime.persistImageTaskResult(sealed, imageOrigin, captured.resultUrl, boundary.cookie);
                        });
                        expect(persistence.image, "RED: the original local product result must wait for its ordinary CPU Worker").toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
                        const waiting = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(waiting?.nativeResults && waiting.resultProcessing);
                        expect(waiting.nativeResults).toStrictEqual(sealed.nativeResults);
                        expect(waiting.result).toBeUndefined();
                        expect(waiting.productProtection).toStrictEqual(original.productProtection);
                        expect(waiting.mask).toStrictEqual(original.mask);
                        expect(waiting.references).toStrictEqual(original.references);
                        const resultJobId = waiting.resultProcessing.jobId;
                        const expectedOptions = { mode: "ordinary", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false };
                        const queued = await tasks.getStoredGenerationTaskRecord("image_processing", resultJobId);
                        assert.ok(queued?.payload.operation === "process_result");
                        expect(queued.payload.options, "Local product Canvas processing must omit targetSize and all protection inputs").toStrictEqual(expectedOptions);
                        expect(queued.payload.inputs).toHaveLength(1);
                        expect(queued.payload.sources).toHaveLength(1);
                        expect(queued.payload.parentMask).toBeUndefined();
                        expect(queued.payload.imageResultBinding).toMatchObject({ sourceIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
                        const waitingRecord = await tasks.getStoredGenerationTaskRecord("image", copy.taskId);
                        expect(waitingRecord).toMatchObject({ status: "running", executionPhase: "persisting", runId: initial.id, parentTaskId: initial.id });
                        expect(waitingRecord?.workerId).toBeUndefined();
                        expect(waitingRecord?.leaseUntil).toBeUndefined();
                        const nativePath = path.join(REFERENCE_MEDIA_ROOT, slot.storageKey);
                        const completion: { result?: Awaited<ReturnType<typeof completeCopy>> } = {};
                        // Pixel work remains in the real Worker; this window observes the Web process.
                        const workerAndConsumePixels = await observeNativeSceneQaPixels(async () => {
                            completion.result = await completeCopy({ submitted: captured.submitted, originalAttempt: captured.originalAttempt, charge: captured.charge, waiting, native, nativePath }, dispatched, imageOrigin, 1, {
                                size: { width: 1024, height: 1024 },
                                options: {},
                            });
                        });
                        const result = completion.result;
                        assert.ok(result);
                        const wire = result.worker.child.payload;
                        assert.ok(wire.operation === "process_result");
                        expect(wire.options, "The actual local product Worker wire contract must omit targetSize").toStrictEqual(expectedOptions);
                        expect(wire.inputs).toHaveLength(1);
                        expect(wire.inputs[0]).toMatchObject({ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 });
                        expect(wire.sources).toHaveLength(1);
                        expect(wire.sources[0]).toMatchObject({ inputIndex: 0, scope: slot.scope, storageKey: slot.storageKey, storageProvider: slot.storageProvider });
                        expect(wire.parentMask).toBeUndefined();
                        expect(wire.resource.facts.decodedInputs).toStrictEqual([]);
                        expect(wire.imageResultBinding).toStrictEqual(queued.payload.imageResultBinding);
                        expect(wire.imageResultBinding?.run).toStrictEqual({ runId: initial.id, agentTaskId: task.id, agentAttempt: 1 });
                        expect(result.worker.completion.metrics.pid).not.toBe(process.pid);
                        expect(result.worker.completion.metrics.peakRssBytes).toBeGreaterThan(0);
                        expect(result.worker.uploads[0].bytes).toEqual(native);
                        expect(result.final).toMatchObject({ sha256: digest(native), bytes: native.length, width: 1024, height: 1024, mimeType: "image/png" });
                        expect(result.final.sha256).not.toBe(digest(sceneBytes));
                        expect(result.final.sha256).not.toBe(digest(productBytes));
                        expect(await readFile(nativePath)).toEqual(native);
                        expect(result.asset).toMatchObject({ status: "ready", sourceRunId: initial.id, sourceTaskId: copy.taskId });
                        expect(result.asset.messageId).toBeUndefined();
                        assert.ok(result.published.result?.results);
                        expect(result.published.result.results).toHaveLength(1);
                        const delivered = result.published.result.results[0];
                        const nativeUrl = {
                            low: "/api/reference-assets/" + slot.storageKey.split("/").map(encodeURIComponent).join("/"),
                            "4k": delivered.serverUrl,
                        }[quality];
                        expect(delivered).toMatchObject({
                            resultId: copy.taskId + ":1",
                            width: 1024,
                            height: 1024,
                            bytes: native.length,
                            mimeType: "image/png",
                            canvasEvidence: { constraint: plan.canvas, nativeSize: { width: 1024, height: 1024 }, storedSize: { width: 1024, height: 1024 }, nativeUrl, normalization: "none" },
                        });
                        expect(result.published.result.batchEvidence).toStrictEqual([
                            { resultId: copy.taskId + ":1", resultIndex: 1, nativeStatus: "readable", nativeSize: { width: 1024, height: 1024 }, storageStatus: "stored", storedUrl: delivered.serverUrl, storedSize: { width: 1024, height: 1024 } },
                        ]);
                        expect(delivered.sceneProtectionEvidence).toBeUndefined();
                        expect(delivered.productEnhancementEvidence).toBeUndefined();
                        expect(result.published.enhancementDelivery).toBeUndefined();
                        const expectedEnhancement = {
                            low: { enhancementId: undefined, nativeSource: undefined, enhancementSource: undefined },
                            "4k": {
                                enhancementId: "enhancement:" + copy.taskId + ":1",
                                nativeSource: { url: delivered.serverUrl, sha256: digest(native), byteLength: native.length, width: 1024, height: 1024, format: "png", hasAlpha: false, provenance: "provider_native" },
                                enhancementSource: { url: delivered.serverUrl, sha256: digest(native), byteLength: native.length, width: 1024, height: 1024, format: "png", hasAlpha: false, provenance: "generation_final" },
                            },
                        }[quality];
                        expect(delivered.enhancementId).toBe(expectedEnhancement.enhancementId);
                        expect(delivered.nativeSource).toStrictEqual(expectedEnhancement.nativeSource);
                        expect(delivered.enhancementSource).toStrictEqual(expectedEnhancement.enhancementSource);
                        expect(delivered.enhancementSkip).toStrictEqual(enhancementSkip);
                        expect(result.published.result.enhancementId).toBe(expectedEnhancement.enhancementId);
                        expect(result.published.result.nativeSource).toStrictEqual(expectedEnhancement.nativeSource);
                        expect(result.published.result.enhancementSource).toStrictEqual(expectedEnhancement.enhancementSource);
                        expect(result.published.result.enhancementSkip).toStrictEqual(enhancementSkip);
                        const { listEnhancementJobsForTask } = await import("./database/image-enhancement-job-repository");
                        const enhancementJobs = await listEnhancementJobsForTask(copy.taskId, userId);
                        expect(enhancementJobs).toMatchObject(
                            {
                                low: [],
                                "4k": [
                                    {
                                        id: expectedEnhancement.enhancementId,
                                        imageTaskId: copy.taskId,
                                        resultId: copy.taskId + ":1",
                                        status: "skipped",
                                        phase: "completed",
                                        reason: "disabled",
                                        decision: { status: "skipped", reason: "disabled", source: expectedEnhancement.enhancementSource, target: { width: 1024, height: 1024 } },
                                        nextPollAt: null,
                                        workerId: null,
                                        leaseToken: null,
                                        leaseUntil: null,
                                    },
                                ],
                            }[quality],
                        );
                        expect(result.published.sceneProtection).toBeUndefined();
                        expect(result.published.productProtection).toStrictEqual(original.productProtection);
                        expect(result.published.mask).toStrictEqual(original.mask);
                        expect(result.published.references).toStrictEqual(original.references);
                        expect(result.published.ecommerceExecution).toStrictEqual(original.ecommerceExecution);
                        expect(result.published.upstream).toStrictEqual(captured.submitted.upstream);
                        expect(result.published.billing).toStrictEqual(captured.submitted.billing);
                        const retainedMask = await registrations.getLocalMediaRegistration(built.stored.storageKey);
                        expect(retainedMask).toMatchObject({ ownerUserId: userId, taskId: build.id, runId: initial.id, source: "image-processing-mask", storageClass: "permanent" });
                        expect(retainedMask?.expiresAt).toBeUndefined();
                        expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                        const agentPixels = await observeNativeSceneQaPixels(async () => {
                            await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                        });
                        const completed = await runs.getAgentRun(initial.id);
                        expect(completed).toMatchObject({
                            id: initial.id,
                            conversationId: conversation.id,
                            inputMessageId: initial.inputMessageId,
                            assistantMessageId: initial.assistantMessageId,
                            status: "completed",
                            tasks: [{ id: task.id, count: 1, attempts: 1, status: "completed", taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "completed", attempt: 1 }] }],
                            ecommerceSnapshot: {
                                qualityPolicy: "disabled",
                                technicalCheck: {
                                    status: "passed",
                                    canvasEvidence: [
                                        {
                                            resultId: copy.taskId + ":1",
                                            resultIndex: 1,
                                            storageStatus: "stored",
                                            nativeSize: { width: 1024, height: 1024 },
                                            storedSize: { width: 1024, height: 1024 },
                                            nativeStatus: "readable",
                                            storedStatus: "readable",
                                            nativeMatches: true,
                                            storedMatches: true,
                                            normalization: "none",
                                            mappingVerified: false,
                                            hardFailures: [],
                                        },
                                    ],
                                },
                            },
                        });
                        assert.ok(completed?.ecommerceSnapshot?.technicalCheck);
                        expect(completed.executionId).toBeUndefined();
                        expect(completed.ecommerceSnapshot.plan).toStrictEqual(plan);
                        expect(completed.ecommerceSnapshot.technicalCheck.checks).toEqual(
                            expect.arrayContaining([
                                expect.objectContaining({ resultId: copy.taskId + ":1", key: "canvas_geometry", source: "media", status: "passed" }),
                                expect.objectContaining({ resultId: copy.taskId + ":1", key: "unmodified_region", source: "protection", status: "not_applicable", reason: "缺少真实选区外合成证据，不能宣称像素保持" }),
                            ]),
                        );
                        expect(completed.ecommerceSnapshot.qualityCheck).toBeUndefined();
                        expect(completed.assetIds).toStrictEqual([result.asset.id]);
                        const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                        expect(parentRecord).toMatchObject({ status: "success", payload: { status: "completed" } });
                        const assets = await creative.listAssetsForUser(userId, conversation.id);
                        expect(assets).toHaveLength(3);
                        expect(assets.find((asset) => asset.id === result.asset.id)).toMatchObject({
                            parentAssetId: product.id,
                            sourceRunId: initial.id,
                            sourceTaskId: copy.taskId,
                            messageId: initial.assistantMessageId,
                            serverUrl: delivered.serverUrl,
                            metadata: { agentTaskId: "ecommerce-local-edit", parentAssetIds: [product.id, scene.id] },
                        });
                        const messages = await creative.listMessagesForUser(userId, conversation.id, 0, 100);
                        expect(messages).toHaveLength(2);
                        expect(messages.find((message) => message.id === initial.inputMessageId)).toMatchObject({ conversationId: conversation.id, role: "user", status: "completed", content: initial.prompt });
                        expect(messages.find((message) => message.id === initial.assistantMessageId)).toMatchObject({
                            conversationId: conversation.id,
                            role: "assistant",
                            status: "completed",
                            metadata: { assetIds: [result.asset.id], taskIds: [copy.taskId] },
                        });
                        const successfulLogs = (await logs.listGenerationLogs({ userId })).items;
                        expect(successfulLogs).toHaveLength(1);
                        expect(successfulLogs[0]).toMatchObject({ id: "image-task:" + copy.taskId, taskId: copy.taskId, status: "success", count: 1, successCount: 1, failCount: 0, assets: [{ serverUrl: delivered.serverUrl, width: 1024, height: 1024 }] });
                        expect(successfulLogs[0].assets[0].enhancementSkip).toStrictEqual(enhancementSkip);
                        expect(successfulLogs[0].assets[0].enhancementId).toBe(expectedEnhancement.enhancementId);
                        expect(successfulLogs[0].assets[0].nativeSource).toStrictEqual(expectedEnhancement.nativeSource);
                        expect(captured.charge.cost).toBe(2);
                        const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                        expect(debits.records).toHaveLength(1);
                        expect(debits.records[0]).toMatchObject({ id: captured.charge.recordId, userId, type: "consume", amount: -2, idempotencyKey: "fixture-run-copy:" + copy.taskId });
                        expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                        const stages = (await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((record) => record.type === "image_processing");
                        expect(stages).toHaveLength(4);
                        expect(stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([productPrepare.id, scenePrepare.id, build.id, resultJobId]));
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", productPrepare.id)).toStrictEqual(productPrepareBefore);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", scenePrepare.id)).toStrictEqual(scenePrepareBefore);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                        expect(await readFile(registeredProduct.filePath)).toEqual(productBytes);
                        expect(await readFile(registeredScene.filePath)).toEqual(sceneBytes);
                        expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                        const finalImage = await imageTasks.getImageTask(copy.taskId);
                        expect(finalImage).toMatchObject({
                            id: copy.taskId,
                            runId: initial.id,
                            parentTaskId: initial.id,
                            conversationId: conversation.id,
                            clientRequestId: copy.requestId,
                            status: "success",
                            ecommerceTrace: { runId: initial.id, agentTaskId: task.id, imageTaskIds: [copy.taskId], finalStatus: "completed" },
                        });
                        const settled = await ownedRows(conversation.id);
                        const replayPixels = await observeNativeSceneQaPixels(async () => {
                            expect(await service.completeImageProcessingTask(result.worker.child.id, result.worker.completion)).toStrictEqual(result.worker.receipt);
                            expect(await recovery.runGenerationTaskRecoveryBatch(result.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                            expect(await runtime.persistImageTaskResult(result.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalImage);
                            await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                        });
                        expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                        expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual(enhancementJobs);
                        expect(await creative.listMessagesForUser(userId, conversation.id, 0, 100)).toStrictEqual(messages);
                        expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(debits);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", productPrepare.id)).toStrictEqual(productPrepareBefore);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", scenePrepare.id)).toStrictEqual(scenePrepareBefore);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                        expect(await readFile(nativePath)).toEqual(native);
                        expect(await readFile(registeredProduct.filePath)).toEqual(productBytes);
                        expect(await readFile(registeredScene.filePath)).toEqual(sceneBytes);
                        expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                        expect(created).toHaveLength(1);
                        expect(boundary.create).toHaveBeenCalledTimes(1);
                        expect(boundary.poll).toHaveBeenCalledTimes(1);
                        expect(charges.size).toBe(1);
                        expect(persistPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(workerAndConsumePixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(agentPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(replayPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    });
                });
            },
            120_000,
        );

        it("captures one native 4k strict product Run copy before result processing", async () => {
            const route = await configureNativeScenePlanning();
            const { readImageEnhancementSettings } = await import("./database/image-enhancement-repository");
            const enhancementSettings = await readImageEnhancementSettings();
            expect(enhancementSettings.enabled, "SETUP: this 4k native gate requires the existing enhancement policy to be disabled").toBe(false);
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "One native 4k strict product Run" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
                .composite([{ input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 }])
                .png()
                .toBuffer();
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                .composite([{ input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 }])
                .png()
                .toBuffer();
            const product = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "native-product.png", { type: "image/png" }));
            assert.ok(product.storageKey && product.serverUrl);
            const registeredSource = await references.readReferenceAsset(product.storageKey);
            assert.ok(registeredSource);
            expect(await readFile(registeredSource.filePath)).toEqual(source);
            installNativeProductPlanningReplies(product.id);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-product-result-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，把背景换成客厅场景，保持商品不变",
                    assetIds: [product.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 1, quality: "4k", size: "1024x1024" } },
                })
            ).run;
            await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
            await withSceneRoutes(initial.id, async (referenceOrigin) => {
                await claimNativeSceneRun(initial.id, "fixture-native-product-prepare-parent", referenceOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                expect(prepare.payload.inputs).toMatchObject([{ assetId: product.id }]);
                expect(boundary.model).not.toHaveBeenCalled();
                const prepared = await completeNativeSceneStage(prepare.id);
                const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id);
                expect(prepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: prepared.completion.manifest } });
                const planned = await claimNativeSceneRun(initial.id, "fixture-native-product-planning-parent", referenceOrigin);
                const snapshot = planned.ecommerceSnapshot;
                const qualification = JSON.stringify({ status: planned.status, failure: planned.failure, snapshot, tasks: planned.tasks, tools: boundary.model.mock.calls.map(([request]) => request.tool.name) });
                expect(snapshot, "SETUP: accepted strict product planning must precede the result RED: " + qualification).toMatchObject({
                    mode: "active",
                    qualityPolicy: "disabled",
                    referenceCheckpoint: { analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                    plan: { planVersion: "ecommerce-edit.v6", operation: "product_to_scene", strategy: "strict_product", canvas: { mode: "exact", size: { width: 1024, height: 1024 } } },
                });
                assert.ok(snapshot?.plan && snapshot.referenceCheckpoint);
                const plan = snapshot.plan;
                expect(snapshot.modelRouteSnapshots?.image_generation).toStrictEqual(route.snapshot);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                expect(planned.tasks).toStrictEqual([]);
                const build = await nativeSceneWaitingStage(initial.id, "build_protection", "ecommerce-product-scene");
                expect(build.payload).toMatchObject({ inputs: [{ assetId: product.id, expectedSha256: digest(source) }], options: { transparentBackground: false } });
                const built = await completeNativeSceneStage(build.id);
                expect(built.completion.manifest.sourceIdentities).toMatchObject([{ assetId: product.id, sha256: digest(source), width: 1024, height: 1024 }]);
                expect(built.stored).toMatchObject({ kind: "mask", width: 1024, height: 1024 });
                const buildBefore = await tasks.getStoredGenerationTaskRecord("image_processing", build.id);
                expect(buildBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: built.completion.manifest } });
                const registeredMask = await references.readReferenceAsset(built.stored.storageKey);
                assert.ok(registeredMask);
                expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                const maskUrl = "/api/reference-assets/" + built.stored.storageKey.split("/").map(encodeURIComponent).join("/");
                // This value only supplies HTTP expectations; executeAgentRun creates the persisted task.
                const expectedTask: AgentRunTask = { id: "ecommerce-product-scene", type: "image", title: "Product scene", prompt: "Route expectation", count: 1, quality: "4k", ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
                await withImageRoutes(planned, expectedTask, async (imageOrigin, created) => {
                    const dispatch: { run?: AgentRun } = {};
                    const dispatchPixels = await observeNativeSceneQaPixels(async () => {
                        dispatch.run = await claimNativeSceneRun(initial.id, "fixture-native-product-dispatch-parent", imageOrigin);
                    });
                    const dispatched = dispatch.run;
                    assert.ok(dispatched?.executionId, "SETUP: real strict product execution must retain the parent execution");
                    const task = dispatched.tasks[0];
                    assert.ok(task?.productProtectionRegions);
                    expect(task).toMatchObject({ id: "ecommerce-product-scene", status: "running", attempts: 1, count: 1, quality: "4k", ecommerceExecution: { state: "ready", canvas: { mode: "exact", size: { width: 1024, height: 1024 } } } });
                    expect(task.productProtectionRegions.editableBackground.mask?.reference).toMatchObject({ dataUrl: "", serverUrl: maskUrl, width: 1024, height: 1024 });
                    expect(dispatched.ecommerceSnapshot?.plan).toStrictEqual(snapshot.plan);
                    expect(dispatched.ecommerceSnapshot?.processing?.protection).toMatchObject({ jobId: build.id, inputDigest: build.payload.inputDigest, manifest: built.completion.manifest });
                    expect(created).toHaveLength(1);
                    const copy = created[0];
                    assert.ok(copy);
                    expect(copy.requestId).toBe(initial.clientRequestId + ":ecommerce-product-scene:1:1");
                    const original = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(original);
                    expect(original).toMatchObject({
                        id: copy.taskId,
                        runId: initial.id,
                        parentTaskId: initial.id,
                        conversationId: conversation.id,
                        clientRequestId: copy.requestId,
                        status: "pending",
                        kind: "edit",
                        config: { quality: "4k", size: "1024x1024" },
                        references: [{ id: product.id, ecommerceRole: "product", url: product.serverUrl }],
                        productProtection: { state: "ready", productAnchorId: product.id, sourceAssetId: product.id, sourceSize: { width: 1024, height: 1024 } },
                    });
                    expect(original.ecommerceExecution).toStrictEqual(task.ecommerceExecution);
                    expect(original.mask).toStrictEqual(task.productProtectionRegions.editableBackground.mask?.reference);
                    expect(original.sceneProtection).toBeUndefined();
                    expect(original.enhancementDelivery).toBeUndefined();
                    expect(original.enhancementPolicy).toMatchObject({ enabled: false });
                    expect(original.upstream).toBeUndefined();
                    expect(original.nativeResults).toBeUndefined();
                    expect(original.result).toBeUndefined();
                    expect(boundary.create).not.toHaveBeenCalled();
                    expect(boundary.poll).not.toHaveBeenCalled();
                    expect(charges.size).toBe(0);
                    const queried: { copy?: Awaited<ReturnType<typeof prepareNativeCopy>> } = {};
                    // The helper's actual query/state assertion can fail first; it is part of the business RED.
                    const queryPixels = await observeNativeSceneQaPixels(async () => {
                        queried.copy = await prepareNativeCopy(copy.taskId, native, imageOrigin);
                    });
                    const captured = queried.copy;
                    assert.ok(captured);
                    const sealed = captured.requested;
                    assert.ok(sealed.nativeResults, "RED: if the original query passed its result_ready gate, this genuine 4k strict product copy must retain its provider native bytes before publication");
                    expect(sealed.nativeResults.slots).toHaveLength(1);
                    const slot = sealed.nativeResults.slots[0];
                    assert.ok(slot.status === "stored");
                    expect(slot).toMatchObject({ resultId: copy.taskId + ":1", resultIndex: 1, sha256: digest(native), bytes: native.length });
                    expect(sealed.result).toBeUndefined();
                    expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                    const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                    expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(native);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    expect(dispatchPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(queryPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    const parentExecutionId = dispatched.executionId;
                    const chargedAccount = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                    const persistence: { image?: Awaited<ReturnType<typeof runtime.persistImageTaskResult>> } = {};
                    const persistPixels = await observeNativeSceneQaPixels(async () => {
                        persistence.image = await runtime.persistImageTaskResult(sealed, imageOrigin, captured.resultUrl, boundary.cookie);
                    });
                    expect(persistence.image, "RED: the original strict product result must wait for its ordinary CPU Worker").toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
                    const waiting = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(waiting?.nativeResults && waiting.resultProcessing);
                    expect(waiting.nativeResults).toStrictEqual(sealed.nativeResults);
                    expect(waiting.result).toBeUndefined();
                    const resultJobId = waiting.resultProcessing.jobId;
                    const expectedOptions = { mode: "ordinary", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false };
                    const queued = await tasks.getStoredGenerationTaskRecord("image_processing", resultJobId);
                    assert.ok(queued?.payload.operation === "process_result");
                    expect(queued.payload.options, "The 4k strict product Canvas result must preserve its actual native frame without targetSize").toStrictEqual(expectedOptions);
                    const waitingRecord = await tasks.getStoredGenerationTaskRecord("image", copy.taskId);
                    expect(waitingRecord).toMatchObject({ status: "running", executionPhase: "persisting", runId: initial.id, parentTaskId: initial.id });
                    expect(waitingRecord?.workerId).toBeUndefined();
                    expect(waitingRecord?.leaseUntil).toBeUndefined();
                    const nativePath = path.join(REFERENCE_MEDIA_ROOT, slot.storageKey);
                    const completion: { result?: Awaited<ReturnType<typeof completeCopy>> } = {};
                    // The reused Worker fixture performs no Web pixel construction; pixel assertions stay outside this window.
                    const workerAndConsumePixels = await observeNativeSceneQaPixels(async () => {
                        completion.result = await completeCopy({ submitted: captured.submitted, originalAttempt: captured.originalAttempt, charge: captured.charge, waiting, native, nativePath }, dispatched, imageOrigin, 1, {
                            size: { width: 1024, height: 1024 },
                            options: {},
                        });
                    });
                    const result = completion.result;
                    assert.ok(result);
                    const wire = result.worker.child.payload;
                    assert.ok(wire.operation === "process_result");
                    expect(wire.options, "The actual Worker wire contract must omit targetSize, not merely match an empty options subset").toStrictEqual(expectedOptions);
                    expect(wire.inputs).toHaveLength(1);
                    expect(wire.inputs[0]).toMatchObject({ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 });
                    expect(result.worker.completion.metrics.pid).not.toBe(process.pid);
                    expect(result.worker.completion.metrics.peakRssBytes).toBeGreaterThan(0);
                    expect(result.worker.uploads[0].bytes).toEqual(native);
                    expect(result.final.sha256).toBe(digest(native));
                    expect(result.final.sha256).not.toBe(digest(source));
                    const pixels = await sharp(result.worker.uploads[0].bytes).ensureAlpha().raw().toBuffer();
                    expect([...pixels.subarray(0, 4)]).toStrictEqual([171, 205, 239, 255]);
                    expect([...pixels.subarray(2099200, 2099204)]).toStrictEqual([138, 98, 67, 255]);
                    expect(result.asset).toMatchObject({ status: "ready", sourceRunId: initial.id, sourceTaskId: copy.taskId });
                    expect(result.asset.messageId).toBeUndefined();
                    assert.ok(result.published.result?.results);
                    const delivered = result.published.result.results[0];
                    expect(delivered).toMatchObject({
                        resultId: copy.taskId + ":1",
                        width: 1024,
                        height: 1024,
                        canvasEvidence: { constraint: plan.canvas, nativeSize: { width: 1024, height: 1024 }, storedSize: { width: 1024, height: 1024 }, normalization: "none" },
                    });
                    expect(delivered.sceneProtectionEvidence).toBeUndefined();
                    expect(delivered.productEnhancementEvidence).toBeUndefined();
                    expect(result.published.enhancementDelivery).toBeUndefined();
                    expect(delivered.enhancementId).toBe("enhancement:" + copy.taskId + ":1");
                    expect(delivered.nativeSource).toStrictEqual({ url: delivered.serverUrl, sha256: digest(native), byteLength: native.length, width: 1024, height: 1024, format: "png", hasAlpha: false, provenance: "provider_native" });
                    expect(delivered.enhancementSource).toStrictEqual({ url: delivered.serverUrl, sha256: digest(native), byteLength: native.length, width: 1024, height: 1024, format: "png", hasAlpha: false, provenance: "generation_final" });
                    expect(delivered.enhancementSkip).toStrictEqual({ status: "skipped", reason: "disabled" });
                    expect(result.published.result.enhancementId).toBe("enhancement:" + copy.taskId + ":1");
                    expect(result.published.result.nativeSource).toStrictEqual(delivered.nativeSource);
                    expect(result.published.result.enhancementSource).toStrictEqual(delivered.enhancementSource);
                    expect(result.published.result.enhancementSkip).toStrictEqual({ status: "skipped", reason: "disabled" });
                    expect(result.published.result.batchEvidence).toStrictEqual([
                        { resultId: copy.taskId + ":1", resultIndex: 1, nativeStatus: "readable", nativeSize: { width: 1024, height: 1024 }, storageStatus: "stored", storedUrl: delivered.serverUrl, storedSize: { width: 1024, height: 1024 } },
                    ]);
                    const { listEnhancementJobsForTask } = await import("./database/image-enhancement-job-repository");
                    const enhancementJobs = await listEnhancementJobsForTask(copy.taskId, userId);
                    expect(enhancementJobs).toHaveLength(1);
                    expect(enhancementJobs[0]).toMatchObject({
                        id: "enhancement:" + copy.taskId + ":1",
                        imageTaskId: copy.taskId,
                        resultId: copy.taskId + ":1",
                        status: "skipped",
                        phase: "completed",
                        reason: "disabled",
                        decision: { status: "skipped", reason: "disabled", source: delivered.enhancementSource, target: { width: 1024, height: 1024 } },
                        nextPollAt: null,
                        workerId: null,
                        leaseToken: null,
                        leaseUntil: null,
                    });
                    expect(enhancementJobs[0].decision).not.toHaveProperty("delivery");
                    expect(enhancementJobs[0].remoteJobId).toBeUndefined();
                    expect(enhancementJobs[0].submittedAt).toBeUndefined();
                    expect(result.published.upstream).toStrictEqual(captured.submitted.upstream);
                    expect(result.published.billing).toStrictEqual(captured.submitted.billing);
                    expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                    const agentPixels = await observeNativeSceneQaPixels(async () => {
                        await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                    });
                    const completed = await runs.getAgentRun(initial.id);
                    expect(completed).toMatchObject({
                        id: initial.id,
                        conversationId: conversation.id,
                        inputMessageId: initial.inputMessageId,
                        assistantMessageId: initial.assistantMessageId,
                        status: "completed",
                        tasks: [{ id: task.id, count: 1, attempts: 1, status: "completed", taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "completed", attempt: 1 }] }],
                        ecommerceSnapshot: {
                            qualityPolicy: "disabled",
                            technicalCheck: {
                                status: "passed",
                                canvasEvidence: [
                                    {
                                        resultId: copy.taskId + ":1",
                                        nativeSize: { width: 1024, height: 1024 },
                                        storedSize: { width: 1024, height: 1024 },
                                        nativeStatus: "readable",
                                        storedStatus: "readable",
                                        nativeMatches: true,
                                        storedMatches: true,
                                        normalization: "none",
                                        mappingVerified: false,
                                        hardFailures: [],
                                    },
                                ],
                            },
                        },
                    });
                    assert.ok(completed?.ecommerceSnapshot?.technicalCheck);
                    expect(completed.ecommerceSnapshot.technicalCheck.checks).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ resultId: copy.taskId + ":1", key: "canvas_geometry", source: "media", status: "passed" }),
                            expect.objectContaining({ resultId: copy.taskId + ":1", key: "unmodified_region", source: "protection", status: "not_applicable" }),
                        ]),
                    );
                    expect(completed.ecommerceSnapshot.qualityCheck).toBeUndefined();
                    expect(completed.assetIds).toContain(result.asset.id);
                    const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                    expect(parentRecord).toMatchObject({ status: "success" });
                    const assets = await creative.listAssetsForUser(userId, conversation.id);
                    expect(assets).toHaveLength(2);
                    expect(assets.find((asset) => asset.id === result.asset.id)).toMatchObject({
                        parentAssetId: product.id,
                        sourceRunId: initial.id,
                        sourceTaskId: copy.taskId,
                        messageId: initial.assistantMessageId,
                        serverUrl: delivered.serverUrl,
                        metadata: { agentTaskId: "ecommerce-product-scene" },
                    });
                    expect(captured.charge.cost).toBe(2);
                    const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                    expect(debits.records).toHaveLength(1);
                    expect(debits.records[0]).toMatchObject({ id: captured.charge.recordId, userId, type: "consume", amount: -2, idempotencyKey: "fixture-run-copy:" + copy.taskId });
                    expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                    expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                    const stages = (await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((record) => record.type === "image_processing");
                    expect(stages).toHaveLength(3);
                    expect(stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([prepare.id, build.id, resultJobId]));
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    const finalImage = await imageTasks.getImageTask(copy.taskId);
                    const settled = await ownedRows(conversation.id);
                    const replayPixels = await observeNativeSceneQaPixels(async () => {
                        expect(await service.completeImageProcessingTask(result.worker.child.id, result.worker.completion)).toStrictEqual(result.worker.receipt);
                        expect(await recovery.runGenerationTaskRecoveryBatch(result.recoveryInput)).toMatchObject({ claimed: 0 });
                        expect(await runtime.persistImageTaskResult(result.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalImage);
                        await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                    });
                    expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                    expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual(enhancementJobs);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    expect(await readFile(nativePath)).toEqual(native);
                    expect(created).toHaveLength(1);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                    expect(charges.size).toBe(1);
                    expect(persistPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(workerAndConsumePixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(agentPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(replayPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                });
            });
        }, 120_000);

        it("queues original full and crop preparation after real native advisory delivery", async () => {
            const route = await configureNativeScenePlanning(true);
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Native advisory preparation" });
            const structure = { objectId: "cabinet", feature: "doors" as const, count: 1, certainty: "confirmed" as const, evidenceRegion: { x: 352, y: 312, width: 320, height: 400 } };
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
                .composite([{ input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 }])
                .png()
                .toBuffer();
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                .composite([{ input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 }])
                .png()
                .toBuffer();
            const product = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "advisory-product.png", { type: "image/png" }));
            assert.ok(product.storageKey && product.serverUrl);
            const registeredSource = await references.readReferenceAsset(product.storageKey);
            assert.ok(registeredSource);
            installNativeProductPlanningReplies(product.id, [structure]);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-advisory-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，把背景换成客厅场景，保持商品不变，并保持原图尺寸",
                    assetIds: [product.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 1, quality: "low", size: "1024x1024" } },
                })
            ).run;
            await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
            await withSceneRoutes(initial.id, async (referenceOrigin) => {
                await claimNativeSceneRun(initial.id, "fixture-advisory-prepare-parent", referenceOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                await completeNativeSceneStage(prepare.id);
                const planned = await claimNativeSceneRun(initial.id, "fixture-advisory-planning-parent", referenceOrigin);
                expect(planned.ecommerceSnapshot, "SETUP: enable advisory before the real plan freezes").toMatchObject({
                    mode: "active",
                    qualityPolicy: "advisory",
                    plan: { planVersion: "ecommerce-edit.v6", operation: "product_to_scene", strategy: "strict_product", visibleStructure: [structure], canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false } },
                });
                expect(planned.ecommerceSnapshot?.modelRouteSnapshots?.image_generation).toStrictEqual(route.snapshot);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                const build = await nativeSceneWaitingStage(initial.id, "build_protection", "ecommerce-product-scene");
                await completeNativeSceneStage(build.id);
                const expectedTask: AgentRunTask = { id: "ecommerce-product-scene", type: "image", title: "Product scene", prompt: "Route expectation", count: 1, quality: "low", ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
                await withImageRoutes(planned, expectedTask, async (imageOrigin, created) => {
                    const deliveryWorkerId = "fixture-advisory-dispatch-parent";
                    const dispatched = await claimNativeSceneRun(initial.id, deliveryWorkerId, imageOrigin);
                    assert.ok(dispatched.executionId, "SETUP: retain the real delivery execution tuple");
                    const deliveryExecutionId = dispatched.executionId;
                    expect(created).toHaveLength(1);
                    const copy = created[0];
                    assert.ok(copy);
                    const captured = await prepareNativeCopy(copy.taskId, native, imageOrigin);
                    await runtime.persistImageTaskResult(captured.requested, imageOrigin, captured.resultUrl, boundary.cookie);
                    const waiting = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(waiting?.nativeResults && waiting.resultProcessing);
                    const slot = waiting.nativeResults.slots[0];
                    assert.ok(slot.status === "stored");
                    const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                    const nativePath = path.join(REFERENCE_MEDIA_ROOT, slot.storageKey);
                    const result = await completeCopy({ submitted: captured.submitted, originalAttempt: captured.originalAttempt, charge: captured.charge, waiting, native, nativePath }, dispatched, imageOrigin, 1, {
                        size: { width: 1024, height: 1024 },
                        options: {},
                    });
                    await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, deliveryExecutionId);
                    const completed = await runs.getAgentRun(initial.id);
                    expect(completed, "SETUP: real CPU result consumption and executeTasks must deliver before review").toMatchObject({
                        status: "completed",
                        reviewed: false,
                        reviewStatus: "review_pending",
                        tasks: [{ status: "completed", taskIds: [copy.taskId] }],
                        ecommerceSnapshot: { qualityPolicy: "advisory", technicalCheck: { status: "passed" } },
                    });
                    assert.ok(completed?.ecommerceSnapshot?.technicalCheck);
                    expect(completed.assetIds).toContain(result.asset.id);
                    const deliveryAssets = await creative.listAssetsForUser(userId, conversation.id);
                    const deliveryMessages = await creative.listMessagesForUser(userId, conversation.id, 0, 50);
                    const deliveryImage = await imageTasks.getImageTask(copy.taskId);
                    const deliveryAccount = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                    const deliveryRow = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                    expect(deliveryRow).toMatchObject({ status: "success", executionPhase: "review_pending", workerId: deliveryWorkerId });
                    expect(deliveryRow?.leaseUntil).toBeGreaterThan(Date.now());
                    expect(
                        await scheduler.releaseGenerationTaskLease("agent", initial.id, deliveryWorkerId, { executionPhase: "review_pending", nextPollAt: Date.now(), lastUpstreamStatus: "review_pending" }, { executionId: deliveryExecutionId }),
                    ).toMatchObject({ id: initial.id, executionPhase: "review_pending" });
                    const qaArguments = JSON.stringify({
                        baselineObservation: { readable: true, logo: "absent", packagingText: "absent", visibleStructure: [structure] },
                        results: [
                            {
                                resultId: copy.taskId + ":1",
                                observation: { readable: true, logo: "absent", packagingText: "absent", visibleStructure: [structure] },
                                checks: [
                                    { key: "product_identity", status: "passed", reason: "Same cabinet" },
                                    { key: "product_silhouette", status: "passed", reason: "Same outline" },
                                    { key: "product_color_material", status: "passed", reason: "Same oak material" },
                                    { key: "product_proportions_view", status: "passed", reason: "Same front view" },
                                    { key: "brand_logo", status: "not_applicable", reason: "No logo" },
                                    { key: "packaging_text", status: "not_applicable", reason: "No packaging text" },
                                    { key: "scene_intent", status: "passed", reason: "Background changed" },
                                    { key: "composition_lighting", status: "passed", reason: "Cabinet remains visible" },
                                    { key: "protected_structure", status: "passed", reason: "One cabinet door" },
                                    { key: "protected_material", status: "passed", reason: "Same wood color" },
                                    { key: "unmodified_region", status: "not_applicable", reason: "Global product scene" },
                                ],
                            },
                        ],
                    });
                    const qaValidations: unknown[] = [];
                    boundary.model.mockReset();
                    boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                        qaValidations.push(request.validateArguments?.(qaArguments));
                        return { arguments: qaArguments, headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 };
                    });
                    let recovered: Awaited<ReturnType<typeof recovery.runGenerationTaskRecoveryBatch>> | undefined;
                    const reviewPixels = await observeNativeSceneQaPixels(async () => {
                        recovered = await recovery.runGenerationTaskRecoveryBatch({ origin: imageOrigin, cookie: boundary.cookie, workerId: "fixture-advisory-review-parent", taskIds: [initial.id], limit: 1 });
                    });
                    expect(recovered, "SETUP: the actual completed-review recovery batch must acquire its own claim").toMatchObject({ claimed: 1 });
                    expect(
                        boundary.model.mock.calls.map(([request]) => request.tool.name),
                        "SETUP: any current-path QA call must reach the real QA tool",
                    ).toStrictEqual(qaValidations.map(() => "check_ecommerce_results"));
                    expect(qaValidations, "SETUP: the current QA path must accept the valid reply instead of producing an artificial unavailable review").toStrictEqual(qaValidations.map(() => true));
                    expect((await runs.getAgentRun(initial.id))?.reviewStatus, "SETUP: an unavailable review is not the intended CPU handoff RED").not.toBe("review_unavailable");
                    const reviewJobs = (await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((record) => record.type === "image_processing" && record.payload.operation === "prepare_review");
                    expect(reviewJobs, "RED: completed advisory review must durably wait for four original full/crop CPU preparation jobs before calling QA").toHaveLength(4);
                    expect(reviewJobs).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                userId,
                                runId: initial.id,
                                status: "pending",
                                payload: expect.objectContaining({ inputs: [expect.objectContaining({ expectedSha256: digest(source) })], sources: [expect.objectContaining({ inputIndex: 0, storageKey: product.storageKey })], options: {} }),
                            }),
                            expect.objectContaining({
                                userId,
                                runId: initial.id,
                                status: "pending",
                                payload: expect.objectContaining({
                                    inputs: [expect.objectContaining({ expectedSha256: digest(source) })],
                                    sources: [expect.objectContaining({ inputIndex: 0, storageKey: product.storageKey })],
                                    options: { region: structure.evidenceRegion },
                                }),
                            }),
                            expect.objectContaining({
                                userId,
                                runId: initial.id,
                                status: "pending",
                                payload: expect.objectContaining({ inputs: [expect.objectContaining({ expectedSha256: digest(native) })], sources: [expect.objectContaining({ inputIndex: 0, storageKey: result.final.storageKey })], options: {} }),
                            }),
                            expect.objectContaining({
                                userId,
                                runId: initial.id,
                                status: "pending",
                                payload: expect.objectContaining({
                                    inputs: [expect.objectContaining({ expectedSha256: digest(native) })],
                                    sources: [expect.objectContaining({ inputIndex: 0, storageKey: result.final.storageKey })],
                                    options: { region: structure.evidenceRegion },
                                }),
                            }),
                        ]),
                    );
                    expect(boundary.model).not.toHaveBeenCalled();
                    const reviewing = await runs.getAgentRun(initial.id);
                    expect(reviewing).toMatchObject({ status: "completed", reviewed: false });
                    assert.ok(reviewing?.ecommerceSnapshot);
                    expect(reviewing.executionId).not.toBe(deliveryExecutionId);
                    expect(reviewing.tasks).toStrictEqual(completed.tasks);
                    expect(reviewing.assetIds).toStrictEqual(completed.assetIds);
                    expect(reviewing.ecommerceSnapshot.plan).toStrictEqual(completed.ecommerceSnapshot.plan);
                    expect(reviewing.ecommerceSnapshot.technicalCheck).toStrictEqual(completed.ecommerceSnapshot.technicalCheck);
                    expect(await imageTasks.getImageTask(copy.taskId)).toStrictEqual(deliveryImage);
                    expect(await creative.listAssetsForUser(userId, conversation.id)).toStrictEqual(deliveryAssets);
                    expect(await creative.listMessagesForUser(userId, conversation.id, 0, 50)).toStrictEqual(deliveryMessages);
                    expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(deliveryAccount);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    const registeredResult = await references.readReferenceAsset(result.final.storageKey);
                    assert.ok(registeredResult);
                    expect(await readFile(registeredResult.filePath)).toEqual(native);
                    expect(reviewPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(reviewing.ecommerceSnapshot.visualReview).toMatchObject({
                        attempt: 1,
                        submission: { state: "not_submitted" },
                        sources: [expect.objectContaining({ source: "baseline" }), expect.objectContaining({ source: "result:" + copy.taskId + ":1" })],
                    });
                    const released = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                    expect(released).toMatchObject({ executionPhase: "review_pending" });
                    expect(released?.workerId).toBeUndefined();
                    expect(released?.leaseUntil).toBeUndefined();
                    expect(released?.nextPollAt).toBeUndefined();
                    const pendingLog = (await logs.listGenerationLogs({ userId, includeEcommerceTrace: true })).items.find((entry) => entry.taskId === copy.taskId);
                    expect(pendingLog?.ecommerceTrace?.stages.find((entry) => entry.key === "quality_check")).toMatchObject({ status: "not_run", output: { policy: "advisory" } });
                    const orderedJobs = reviewJobs.toSorted((left, right) => left.id.localeCompare(right.id));
                    const firstPrepared = await completeNativeSceneStage(orderedJobs[0].id);
                    const [successorLease] = await scheduler.claimDueGenerationTasks({ workerId: "fixture-advisory-review-parent", taskIds: [initial.id], limit: 1 });
                    assert.ok(successorLease?.executionId);
                    expect(successorLease.executionId).not.toBe(reviewing.executionId);
                    expect(await scheduler.renewGenerationTaskLeases("fixture-advisory-review-parent", [{ ...successorLease, executionId: reviewing.executionId }])).toBe(0);
                    expect(await scheduler.releaseGenerationTaskLease("agent", initial.id, "fixture-advisory-review-parent", { executionPhase: "completed", nextPollAt: undefined }, { executionId: reviewing.executionId })).toBeNull();
                    const secondPrepared = await completeNativeSceneStage(orderedJobs[1].id);
                    const thirdPrepared = await completeNativeSceneStage(orderedJobs[2].id);
                    const fourthPrepared = await completeNativeSceneStage(orderedJobs[3].id);
                    const awake = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                    expect(awake).toMatchObject({ executionPhase: "review_pending", workerId: successorLease.workerId, leaseUntil: successorLease.leaseUntil, payload: { executionId: successorLease.executionId } });
                    expect(awake?.nextPollAt).toBeGreaterThan(0);
                    expect(await scheduler.releaseGenerationTaskLease("agent", initial.id, "fixture-advisory-review-parent", { executionPhase: "review_pending", nextPollAt: awake?.nextPollAt }, { executionId: successorLease.executionId })).toMatchObject({
                        id: initial.id,
                    });
                    const ready = await runs.getAgentRun(initial.id);
                    assert.ok(ready?.ecommerceSnapshot?.visualReview);
                    const checkpoint = ready.ecommerceSnapshot.visualReview;
                    expect(checkpoint).toMatchObject({ attempt: 1, submission: { state: "not_submitted" } });
                    expect(checkpoint.views).toHaveLength(4);
                    expect(checkpoint.views.map((view) => ({ source: checkpoint.sources[view.sourceIndex].source, region: view.region }))).toStrictEqual([
                        { source: "baseline", region: undefined },
                        { source: "baseline", region: structure.evidenceRegion },
                        { source: "result:" + copy.taskId + ":1", region: undefined },
                        { source: "result:" + copy.taskId + ":1", region: structure.evidenceRegion },
                    ]);
                    const workers = [firstPrepared, secondPrepared, thirdPrepared, fourthPrepared];
                    expect(checkpoint.views.map((view) => Boolean(view.receipt))).toStrictEqual([true, true, true, true]);
                    expect(new Set(workers.map((worker) => worker.child.executionId)).size).toBe(4);
                    expect(workers.map((worker) => worker.receipt.manifest.geometry.sourceSize)).toStrictEqual([
                        { width: 1024, height: 1024 },
                        { width: 1024, height: 1024 },
                        { width: 1024, height: 1024 },
                        { width: 1024, height: 1024 },
                    ]);
                    expect(await service.completeImageProcessingTask(firstPrepared.child.id, firstPrepared.completion)).toStrictEqual(firstPrepared.receipt);
                    expect((await runs.getAgentRun(initial.id))?.ecommerceSnapshot?.visualReview).toStrictEqual(checkpoint);
                    const protocolBodies: Array<{ raw: Buffer; body: { messages: Array<{ role: string; content: string | Array<{ type: string; image_url?: { url: string }; text?: string }> }> } }> = [];
                    const modelFailure = Promise.withResolvers<never>();
                    const modelServer = createServer((request, response) => {
                        void (async () => {
                            expect(request.method).toBe("POST");
                            expect(request.url).toContain("/api/ai/system/");
                            const chunks: Buffer[] = [];
                            for await (const chunk of request) chunks.push(Buffer.from(chunk));
                            const raw = Buffer.concat(chunks);
                            const body = JSON.parse(raw.toString("utf8"));
                            const marked = await runs.getAgentRun(initial.id);
                            expect(marked?.ecommerceSnapshot?.visualReview?.submission).toMatchObject({ state: "started", requestDigest: digest(raw), variant: "tool" });
                            expect(marked?.reviewed).toBe(false);
                            protocolBodies.push({ raw, body });
                            response.writeHead(200, { "content-type": "application/json" });
                            response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "check_ecommerce_results", arguments: qaArguments } }] } }] }));
                        })().catch((error: unknown) => {
                            modelFailure.reject(error);
                            response.writeHead(500);
                            response.end();
                        });
                    });
                    const projection = vi.spyOn(service, "projectEcommerceReviewTrace").mockRejectedValueOnce(new Error("fixture: final QA committed before trace projection interruption"));
                    try {
                        await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
                        const address = modelServer.address();
                        assert.ok(address && typeof address !== "string");
                        const modelOrigin = "http://127.0.0.1:" + address.port;
                        boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                            expect(request.tool.name).toBe("check_ecommerce_results");
                            qaValidations.push(request.validateArguments?.(qaArguments));
                            assert.ok(textPlanningActual.module);
                            return textPlanningActual.module.requestStructuredText({ ...request, origin: modelOrigin });
                        });
                        const successorPixels = await observeNativeSceneQaPixels(async () => {
                            await Promise.race([recovery.runGenerationTaskRecoveryBatch({ origin: imageOrigin, cookie: boundary.cookie, workerId: "fixture-advisory-review-completion", taskIds: [initial.id], limit: 1 }), modelFailure.promise]);
                        });
                        expect(successorPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                        expect(projection).toHaveBeenCalledTimes(1);
                    } finally {
                        projection.mockRestore();
                        modelServer.closeAllConnections();
                        if (modelServer.listening) await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
                    }
                    expect(qaValidations).toStrictEqual([true]);
                    expect(protocolBodies).toHaveLength(1);
                    const sentImages = protocolBodies[0].body.messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content.flatMap((part) => (part.image_url ? [part.image_url.url] : []))));
                    expect(sentImages.map((url) => digest(Buffer.from(url.slice(url.indexOf(",") + 1), "base64")))).toStrictEqual(checkpoint.views.map((view) => workers.find((worker) => worker.child.id === view.jobId)!.stored.sha256));
                    const reviewed = await runs.getAgentRun(initial.id);
                    expect(reviewed).toMatchObject({
                        status: "completed",
                        reviewed: true,
                        reviewStatus: "review_completed",
                        reviewAttempts: 1,
                        ecommerceSnapshot: {
                            qualityCheck: {
                                status: "passed",
                                visionEvidence: {
                                    imageCount: 4,
                                    images: [
                                        { source: "baseline", size: { width: 1024, height: 1024 } },
                                        { source: "baseline", size: { width: 1024, height: 1024 }, region: structure.evidenceRegion },
                                        { source: "result:" + copy.taskId + ":1", size: { width: 1024, height: 1024 } },
                                        { source: "result:" + copy.taskId + ":1", size: { width: 1024, height: 1024 }, region: structure.evidenceRegion },
                                    ],
                                },
                            },
                            visualReview: { attempt: 1, submission: { state: "completed", requestDigest: digest(protocolBodies[0].raw) } },
                        },
                    });
                    expect(reviewed?.executionId).not.toBe(successorLease.executionId);
                    expect(reviewed?.tasks).toStrictEqual(completed.tasks);
                    expect(reviewed?.assetIds).toStrictEqual(completed.assetIds);
                    expect(reviewed?.ecommerceSnapshot?.technicalCheck).toStrictEqual(completed.ecommerceSnapshot.technicalCheck);
                    expect(await creative.listAssetsForUser(userId, conversation.id)).toStrictEqual(deliveryAssets);
                    expect(await creative.listMessagesForUser(userId, conversation.id, 0, 50)).toStrictEqual(deliveryMessages);
                    expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(deliveryAccount);
                    expect((await imageTasks.getImageTask(copy.taskId))?.ecommerceTrace?.stages.find((entry) => entry.key === "quality_check")).toMatchObject({ status: "not_run" });
                    const repaired = (await logs.listGenerationLogs({ userId, includeEcommerceTrace: true })).items.find((entry) => entry.taskId === copy.taskId);
                    expect(repaired?.ecommerceTrace).toMatchObject({ runId: initial.id, agentTaskId: completed.tasks[0].id, imageTaskIds: [copy.taskId], finalStatus: "completed" });
                    expect(repaired?.ecommerceTrace?.stages.find((entry) => entry.key === "quality_check")).toMatchObject({ status: "passed", output: { policy: "advisory", status: "passed" } });
                    expect(await recovery.runGenerationTaskRecoveryBatch({ origin: imageOrigin, cookie: boundary.cookie, workerId: "fixture-advisory-review-replay", taskIds: [initial.id], limit: 1 })).toMatchObject({ claimed: 0 });
                    expect(boundary.model).toHaveBeenCalledTimes(1);
                    expect((await runs.getAgentRun(initial.id))?.ecommerceSnapshot?.qualityCheck).toStrictEqual(reviewed?.ecommerceSnapshot?.qualityCheck);
                });
            });
        }, 120_000);

        it("captures one native strict product Run copy before result processing", async () => {
            const route = await configureNativeScenePlanning();
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "One native strict product Run" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
                .composite([{ input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 }])
                .png()
                .toBuffer();
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                .composite([{ input: { create: { width: 320, height: 400, channels: 3, background: "#8a6243" } }, left: 352, top: 312 }])
                .png()
                .toBuffer();
            const product = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "native-product.png", { type: "image/png" }));
            assert.ok(product.storageKey && product.serverUrl);
            const registeredSource = await references.readReferenceAsset(product.storageKey);
            assert.ok(registeredSource);
            expect(await readFile(registeredSource.filePath)).toEqual(source);
            installNativeProductPlanningReplies(product.id);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-native-product-result-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "修改图片1，把背景换成客厅场景，保持商品不变",
                    assetIds: [product.id],
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", image: { count: 1, quality: "low", size: "1024x1024" } },
                })
            ).run;
            await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
            await withSceneRoutes(initial.id, async (referenceOrigin) => {
                await claimNativeSceneRun(initial.id, "fixture-native-product-prepare-parent", referenceOrigin);
                const prepare = await nativeSceneWaitingStage(initial.id, "prepare_reference", initial.id);
                expect(prepare.payload.inputs).toMatchObject([{ assetId: product.id }]);
                expect(boundary.model).not.toHaveBeenCalled();
                const prepared = await completeNativeSceneStage(prepare.id);
                const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id);
                expect(prepareBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: prepared.completion.manifest } });
                const planned = await claimNativeSceneRun(initial.id, "fixture-native-product-planning-parent", referenceOrigin);
                const snapshot = planned.ecommerceSnapshot;
                const qualification = JSON.stringify({ status: planned.status, failure: planned.failure, snapshot, tasks: planned.tasks, tools: boundary.model.mock.calls.map(([request]) => request.tool.name) });
                expect(snapshot, "SETUP: accepted strict product planning must precede the result RED: " + qualification).toMatchObject({
                    mode: "active",
                    qualityPolicy: "disabled",
                    referenceCheckpoint: { analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                    plan: { planVersion: "ecommerce-edit.v6", operation: "product_to_scene", strategy: "strict_product", canvas: { mode: "exact", size: { width: 1024, height: 1024 } } },
                });
                assert.ok(snapshot?.plan && snapshot.referenceCheckpoint);
                const plan = snapshot.plan;
                expect(snapshot.modelRouteSnapshots?.image_generation).toStrictEqual(route.snapshot);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                expect(planned.tasks).toStrictEqual([]);
                const build = await nativeSceneWaitingStage(initial.id, "build_protection", "ecommerce-product-scene");
                expect(build.payload).toMatchObject({ inputs: [{ assetId: product.id, expectedSha256: digest(source) }], options: { transparentBackground: false } });
                const built = await completeNativeSceneStage(build.id);
                expect(built.completion.manifest.sourceIdentities).toMatchObject([{ assetId: product.id, sha256: digest(source), width: 1024, height: 1024 }]);
                expect(built.stored).toMatchObject({ kind: "mask", width: 1024, height: 1024 });
                const buildBefore = await tasks.getStoredGenerationTaskRecord("image_processing", build.id);
                expect(buildBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: built.completion.manifest } });
                const registeredMask = await references.readReferenceAsset(built.stored.storageKey);
                assert.ok(registeredMask);
                expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                const maskUrl = "/api/reference-assets/" + built.stored.storageKey.split("/").map(encodeURIComponent).join("/");
                // This value only supplies HTTP expectations; executeAgentRun creates the persisted task.
                const expectedTask: AgentRunTask = { id: "ecommerce-product-scene", type: "image", title: "Product scene", prompt: "Route expectation", count: 1, quality: "low", ratio: "1024x1024", dependencies: [], status: "ready", attempts: 0 };
                await withImageRoutes(planned, expectedTask, async (imageOrigin, created) => {
                    const dispatch: { run?: AgentRun } = {};
                    const dispatchPixels = await observeNativeSceneQaPixels(async () => {
                        dispatch.run = await claimNativeSceneRun(initial.id, "fixture-native-product-dispatch-parent", imageOrigin);
                    });
                    const dispatched = dispatch.run;
                    assert.ok(dispatched?.executionId, "SETUP: real strict product execution must retain the parent execution");
                    const task = dispatched.tasks[0];
                    assert.ok(task?.productProtectionRegions);
                    expect(task).toMatchObject({ id: "ecommerce-product-scene", status: "running", attempts: 1, count: 1, quality: "low", ecommerceExecution: { state: "ready", canvas: { mode: "exact", size: { width: 1024, height: 1024 } } } });
                    expect(task.productProtectionRegions.editableBackground.mask?.reference).toMatchObject({ dataUrl: "", serverUrl: maskUrl, width: 1024, height: 1024 });
                    expect(dispatched.ecommerceSnapshot?.plan).toStrictEqual(snapshot.plan);
                    expect(dispatched.ecommerceSnapshot?.processing?.protection).toMatchObject({ jobId: build.id, inputDigest: build.payload.inputDigest, manifest: built.completion.manifest });
                    expect(created).toHaveLength(1);
                    const copy = created[0];
                    assert.ok(copy);
                    expect(copy.requestId).toBe(initial.clientRequestId + ":ecommerce-product-scene:1:1");
                    const original = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(original);
                    expect(original).toMatchObject({
                        id: copy.taskId,
                        runId: initial.id,
                        parentTaskId: initial.id,
                        conversationId: conversation.id,
                        clientRequestId: copy.requestId,
                        status: "pending",
                        kind: "edit",
                        config: { quality: "low", size: "1024x1024" },
                        references: [{ id: product.id, ecommerceRole: "product", url: product.serverUrl }],
                        productProtection: { state: "ready", productAnchorId: product.id, sourceAssetId: product.id, sourceSize: { width: 1024, height: 1024 } },
                    });
                    expect(original.ecommerceExecution).toStrictEqual(task.ecommerceExecution);
                    expect(original.mask).toStrictEqual(task.productProtectionRegions.editableBackground.mask?.reference);
                    expect(original.sceneProtection).toBeUndefined();
                    expect(original.enhancementDelivery).toBeUndefined();
                    expect(original.upstream).toBeUndefined();
                    expect(original.nativeResults).toBeUndefined();
                    expect(original.result).toBeUndefined();
                    expect(boundary.create).not.toHaveBeenCalled();
                    expect(boundary.poll).not.toHaveBeenCalled();
                    expect(charges.size).toBe(0);
                    const queried: { copy?: Awaited<ReturnType<typeof prepareNativeCopy>> } = {};
                    // The helper's actual query/state assertion can fail first; it is part of the business RED.
                    const queryPixels = await observeNativeSceneQaPixels(async () => {
                        queried.copy = await prepareNativeCopy(copy.taskId, native, imageOrigin);
                    });
                    const captured = queried.copy;
                    assert.ok(captured);
                    const sealed = captured.requested;
                    assert.ok(sealed.nativeResults, "RED: if the original query passed its result_ready gate, this genuine strict product copy must retain its provider native bytes before publication");
                    expect(sealed.nativeResults.slots).toHaveLength(1);
                    const slot = sealed.nativeResults.slots[0];
                    assert.ok(slot.status === "stored");
                    expect(slot).toMatchObject({ resultId: copy.taskId + ":1", resultIndex: 1, sha256: digest(native), bytes: native.length });
                    expect(sealed.result).toBeUndefined();
                    expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                    const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                    expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(native);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    expect(dispatchPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(queryPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    // Root43216 stopped at the original native gate above; these successor gates remain separate evidence.
                    const parentExecutionId = dispatched.executionId;
                    const chargedAccount = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                    const persistence: { image?: Awaited<ReturnType<typeof runtime.persistImageTaskResult>> } = {};
                    const persistPixels = await observeNativeSceneQaPixels(async () => {
                        persistence.image = await runtime.persistImageTaskResult(sealed, imageOrigin, captured.resultUrl, boundary.cookie);
                    });
                    expect(persistence.image, "RED: the original strict product result must wait for its ordinary CPU Worker").toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
                    const waiting = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(waiting?.nativeResults && waiting.resultProcessing);
                    expect(waiting.nativeResults).toStrictEqual(sealed.nativeResults);
                    expect(waiting.result).toBeUndefined();
                    const resultJobId = waiting.resultProcessing.jobId;
                    const expectedOptions = { mode: "ordinary", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false };
                    const queued = await tasks.getStoredGenerationTaskRecord("image_processing", resultJobId);
                    assert.ok(queued?.payload.operation === "process_result");
                    expect(queued.payload.options, "Canvas normalization must not silently inherit the ordinary low-resolution targetSize").toStrictEqual(expectedOptions);
                    const waitingRecord = await tasks.getStoredGenerationTaskRecord("image", copy.taskId);
                    expect(waitingRecord).toMatchObject({ status: "running", executionPhase: "persisting", runId: initial.id, parentTaskId: initial.id });
                    expect(waitingRecord?.workerId).toBeUndefined();
                    expect(waitingRecord?.leaseUntil).toBeUndefined();
                    const nativePath = path.join(REFERENCE_MEDIA_ROOT, slot.storageKey);
                    const completion: { result?: Awaited<ReturnType<typeof completeCopy>> } = {};
                    // The reused Worker fixture performs no Web pixel construction; pixel assertions stay outside this window.
                    const workerAndConsumePixels = await observeNativeSceneQaPixels(async () => {
                        completion.result = await completeCopy({ submitted: captured.submitted, originalAttempt: captured.originalAttempt, charge: captured.charge, waiting, native, nativePath }, dispatched, imageOrigin, 1, {
                            size: { width: 1024, height: 1024 },
                            options: {},
                        });
                    });
                    const result = completion.result;
                    assert.ok(result);
                    const wire = result.worker.child.payload;
                    assert.ok(wire.operation === "process_result");
                    expect(wire.options, "The actual Worker wire contract must omit targetSize, not merely match an empty options subset").toStrictEqual(expectedOptions);
                    expect(wire.inputs).toHaveLength(1);
                    expect(wire.inputs[0]).toMatchObject({ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 });
                    expect(result.worker.completion.metrics.pid).not.toBe(process.pid);
                    expect(result.worker.completion.metrics.peakRssBytes).toBeGreaterThan(0);
                    expect(result.worker.uploads[0].bytes).toEqual(native);
                    expect(result.final.sha256).toBe(digest(native));
                    expect(result.final.sha256).not.toBe(digest(source));
                    const pixels = await sharp(result.worker.uploads[0].bytes).ensureAlpha().raw().toBuffer();
                    expect([...pixels.subarray(0, 4)]).toStrictEqual([171, 205, 239, 255]);
                    expect([...pixels.subarray(2099200, 2099204)]).toStrictEqual([138, 98, 67, 255]);
                    expect(result.asset).toMatchObject({ status: "ready", sourceRunId: initial.id, sourceTaskId: copy.taskId });
                    expect(result.asset.messageId).toBeUndefined();
                    assert.ok(result.published.result?.results);
                    const delivered = result.published.result.results[0];
                    expect(delivered).toMatchObject({
                        resultId: copy.taskId + ":1",
                        width: 1024,
                        height: 1024,
                        canvasEvidence: { constraint: plan.canvas, nativeSize: { width: 1024, height: 1024 }, storedSize: { width: 1024, height: 1024 }, normalization: "none" },
                    });
                    expect(delivered.sceneProtectionEvidence).toBeUndefined();
                    expect(delivered.productEnhancementEvidence).toBeUndefined();
                    expect(result.published.upstream).toStrictEqual(captured.submitted.upstream);
                    expect(result.published.billing).toStrictEqual(captured.submitted.billing);
                    expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                    const agentPixels = await observeNativeSceneQaPixels(async () => {
                        await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                    });
                    const completed = await runs.getAgentRun(initial.id);
                    expect(completed).toMatchObject({
                        id: initial.id,
                        conversationId: conversation.id,
                        inputMessageId: initial.inputMessageId,
                        assistantMessageId: initial.assistantMessageId,
                        status: "completed",
                        tasks: [{ id: task.id, count: 1, attempts: 1, status: "completed", taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "completed", attempt: 1 }] }],
                        ecommerceSnapshot: {
                            qualityPolicy: "disabled",
                            technicalCheck: {
                                status: "passed",
                                canvasEvidence: [
                                    {
                                        resultId: copy.taskId + ":1",
                                        nativeSize: { width: 1024, height: 1024 },
                                        storedSize: { width: 1024, height: 1024 },
                                        nativeStatus: "readable",
                                        storedStatus: "readable",
                                        nativeMatches: true,
                                        storedMatches: true,
                                        normalization: "none",
                                        mappingVerified: false,
                                        hardFailures: [],
                                    },
                                ],
                            },
                        },
                    });
                    assert.ok(completed?.ecommerceSnapshot?.technicalCheck);
                    expect(completed.ecommerceSnapshot.technicalCheck.checks).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ resultId: copy.taskId + ":1", key: "canvas_geometry", source: "media", status: "passed" }),
                            expect.objectContaining({ resultId: copy.taskId + ":1", key: "unmodified_region", source: "protection", status: "not_applicable" }),
                        ]),
                    );
                    expect(completed.ecommerceSnapshot.qualityCheck).toBeUndefined();
                    expect(completed.assetIds).toContain(result.asset.id);
                    const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", initial.id);
                    expect(parentRecord).toMatchObject({ status: "success" });
                    const assets = await creative.listAssetsForUser(userId, conversation.id);
                    expect(assets).toHaveLength(2);
                    expect(assets.find((asset) => asset.id === result.asset.id)).toMatchObject({
                        parentAssetId: product.id,
                        sourceRunId: initial.id,
                        sourceTaskId: copy.taskId,
                        messageId: initial.assistantMessageId,
                        serverUrl: delivered.serverUrl,
                        metadata: { agentTaskId: "ecommerce-product-scene" },
                    });
                    expect(captured.charge.cost).toBe(2);
                    const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                    expect(debits.records).toHaveLength(1);
                    expect(debits.records[0]).toMatchObject({ id: captured.charge.recordId, userId, type: "consume", amount: -2, idempotencyKey: "fixture-run-copy:" + copy.taskId });
                    expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(chargedAccount);
                    expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toStrictEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                    const stages = (await tasks.listStoredGenerationTaskRecordsByRunIds([initial.id], [userId])).filter((record) => record.type === "image_processing");
                    expect(stages).toHaveLength(3);
                    expect(stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([prepare.id, build.id, resultJobId]));
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toStrictEqual(prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
                    expect(await readFile(registeredSource.filePath)).toEqual(source);
                    expect(await readFile(registeredMask.filePath)).toEqual(built.bytes);
                    const finalImage = await imageTasks.getImageTask(copy.taskId);
                    const settled = await ownedRows(conversation.id);
                    const replayPixels = await observeNativeSceneQaPixels(async () => {
                        expect(await service.completeImageProcessingTask(result.worker.child.id, result.worker.completion)).toStrictEqual(result.worker.receipt);
                        expect(await recovery.runGenerationTaskRecoveryBatch(result.recoveryInput)).toMatchObject({ claimed: 0 });
                        expect(await runtime.persistImageTaskResult(result.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalImage);
                        await execution.executeTasks(initial.id, imageOrigin, boundary.cookie, parentExecutionId);
                    });
                    expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                    expect(created).toHaveLength(1);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                    expect(charges.size).toBe(1);
                    expect(persistPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(workerAndConsumePixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(agentPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                    expect(replayPixels).toStrictEqual({ pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
                });
            });
        }, 120_000);

        async function nativeSceneQuotaRows(planId: string) {
            return database.withPostgresTransaction(async (executor) => {
                await executor.query("SET TRANSACTION READ ONLY");
                return {
                    users: (await executor.query<SqlRow>("SELECT * FROM users WHERE id=$1 ORDER BY id", [userId])).rows,
                    points: (await executor.query<SqlRow>("SELECT * FROM point_records WHERE user_id=$1 ORDER BY id", [userId])).rows,
                    quota: (await executor.query<SqlRow>("SELECT *,date::text AS quota_date FROM quota_usage WHERE user_id=$1 ORDER BY date,usage_kind", [userId])).rows,
                    wallets: (await executor.query<SqlRow>("SELECT * FROM daily_plan_point_wallets WHERE user_id=$1 ORDER BY date", [userId])).rows,
                    assignments: (await executor.query<SqlRow>("SELECT * FROM user_plan_assignments WHERE user_id=$1 ORDER BY id", [userId])).rows,
                    plan: (await executor.query<SqlRow>("SELECT * FROM entitlement_plans WHERE id=$1 ORDER BY id", [planId])).rows,
                    reservations: (await executor.query<SqlRow>("SELECT * FROM generation_concurrency_reservations WHERE user_id=$1 ORDER BY task_type,request_id", [userId])).rows,
                    settings: (await executor.query<{ entitlements_enabled: boolean }>("SELECT entitlements_enabled FROM app_settings WHERE id='default'")).rows,
                };
            });
        }

        type NativeSceneQuotaScope = { planId: string; assignmentId: string; date: string; initial: Awaited<ReturnType<typeof nativeSceneQuotaRows>>; priceChanged: boolean };
        type NativeSceneQuotaPrice = { label: "paid2" | "zero0"; pointsCost: 2 | 0; debitAmount: -2 | 0; chargedBalance: 98 | 100 };

        function nativeSceneQuotaStableSettings(row: SqlRow) {
            const stable = { ...row };
            delete stable.logical_models;
            delete stable.default_models;
            delete stable.model_point_costs;
            delete stable.generation_concurrency;
            delete stable.generation_defaults;
            delete stable.ecommerce_generation_enabled;
            delete stable.ecommerce_visual_quality_check_enabled;
            delete stable.ecommerce_model_roles;
            delete stable.entitlements_enabled;
            delete stable.updated_at;
            return stable;
        }

        async function withNativeSceneUserQuota(action: (scope: NativeSceneQuotaScope) => Promise<void>) {
            const fixture = pgFixture;
            assert.ok(fixture);
            const savedCosts = fixture.installed.model_point_costs;
            const planId = "fixture-native-quota-plan-" + randomUUID();
            const assignmentId = "fixture-native-quota-assignment-" + randomUUID();
            const sourceId = "fixture-native-quota-source-" + randomUUID();
            const saved = await database.withPostgresTransaction(async (executor) => {
                const repositories = database.createPostgresRepositories(executor);
                await repositories.settings.lock();
                expect(await readSettings(executor)).toStrictEqual(fixture.installed);
                const walletSettings = await repositories.settings.getWalletSettings();
                assert.ok(walletSettings.settings);
                expect(walletSettings.settings.entitlementsEnabled).toBe(false);
                const settings = (await executor.query<SqlRow>("SELECT * FROM app_settings WHERE id='default'")).rows[0];
                assert.ok(settings);
                const plans = (await executor.query<SqlRow>("SELECT * FROM entitlement_plans ORDER BY id")).rows;
                expect(plans.find((row) => row.id === planId)).toBeUndefined();
                expect((await executor.query("SELECT id FROM user_plan_assignments WHERE user_id=$1 OR id=$2 OR (source='system' AND source_id=$3)", [userId, assignmentId, sourceId])).rows).toStrictEqual([]);
                await repositories.settings.upsertEntitlementPlan({
                    id: planId,
                    name: "Owned native quota fixture",
                    enabled: true,
                    dailyPoints: 0,
                    limits: { dailyPointSpend: 0, dailyApiCalls: 0, dailyImages: 1, dailyVideos: 0, dailyAudio: 0, dailyText: 0 },
                    features: ["system-api", "points-wallet"],
                    sortOrder: 1000,
                });
                const now = new Date().toISOString();
                await repositories.billing.createPlanAssignment({ id: assignmentId, userId, planId, status: "active", source: "system", sourceId, startsAt: now, metadata: {}, createdAt: now, updatedAt: now });
                await repositories.settings.updateSettings({ entitlementsEnabled: true });
                const plan = (await executor.query<SqlRow>("SELECT * FROM entitlement_plans WHERE id=$1", [planId])).rows[0];
                const assignment = (await executor.query<SqlRow>("SELECT * FROM user_plan_assignments WHERE id=$1 AND user_id=$2", [assignmentId, userId])).rows[0];
                assert.ok(plan && assignment);
                return { settings, plans, plan, assignment, entitlementsEnabled: walletSettings.settings.entitlementsEnabled };
            });
            let scope: NativeSceneQuotaScope | undefined;
            try {
                const settings = await auth.getFreshAuthSettings();
                expect(settings.entitlements.enabled).toBe(true);
                expect(settings.generationCostControl).toStrictEqual({ maxPointsPerTask: 0, dailyUserPointSpend: 0, dailyTotalPointSpend: 0 });
                const { imageUnits } = await import("@/app/api/image-tasks/image-task-support");
                expect(imageUnits("low", settings.generationPointMultipliers.imageQuality)).toBe(1);
                expect(await database.createPostgresRepositories().billing.getActivePlanAssignment(userId)).toMatchObject({ id: assignmentId, userId, planId, status: "active", source: "system", sourceId });
                const { getPointsWalletSnapshot } = await import("./points-wallet-service");
                const wallet = await getPointsWalletSnapshot(userId);
                expect(wallet).toMatchObject({ permanentPoints: 100, dailyPoints: 0, activePlanId: planId, assignmentId });
                const initial = await nativeSceneQuotaRows(planId);
                expect(initial.quota).toStrictEqual([]);
                expect(initial.wallets).toStrictEqual([]);
                expect(initial.reservations).toStrictEqual([]);
                expect(initial.plan).toStrictEqual([saved.plan]);
                expect(initial.assignments).toStrictEqual([saved.assignment]);
                expect(initial.settings).toStrictEqual([{ entitlements_enabled: true }]);
                scope = { planId, assignmentId, date: wallet.dailyDate, initial, priceChanged: false };
                await action(scope);
            } finally {
                if (liveCleanupUnconfirmed) throw new Error(`CLEANUP: retain native quota fixture plan=${planId} assignment=${assignmentId}; live work is unconfirmed`);
                try {
                    fixture.installed = await database.withPostgresTransaction(async (executor) => {
                        const repositories = database.createPostgresRepositories(executor);
                        await repositories.settings.lock();
                        expect(await readSettings(executor)).toStrictEqual(fixture.installed);
                        const current = (await executor.query<SqlRow>("SELECT * FROM app_settings WHERE id='default'")).rows[0];
                        assert.ok(current);
                        expect(current.entitlements_enabled).toBe(true);
                        expect(nativeSceneQuotaStableSettings(current)).toStrictEqual(nativeSceneQuotaStableSettings(saved.settings));
                        expect((await executor.query("SELECT * FROM generation_concurrency_reservations WHERE user_id=$1", [userId])).rows).toStrictEqual([]);
                        expect((await executor.query("SELECT * FROM daily_plan_point_wallets WHERE user_id=$1", [userId])).rows).toStrictEqual([]);
                        expect((await executor.query<SqlRow>("SELECT * FROM user_plan_assignments WHERE user_id=$1 ORDER BY id", [userId])).rows).toStrictEqual([saved.assignment]);
                        expect((await executor.query<SqlRow>("DELETE FROM user_plan_assignments WHERE id=$1 AND user_id=$2 AND plan_id=$3 AND source='system' AND source_id=$4 RETURNING *", [assignmentId, userId, planId, sourceId])).rows).toStrictEqual([
                            saved.assignment,
                        ]);
                        expect((await executor.query("SELECT id FROM user_plan_assignments WHERE user_id=$1 OR id=$2 OR (source='system' AND source_id=$3)", [userId, assignmentId, sourceId])).rows).toStrictEqual([]);
                        expect((await executor.query<SqlRow>("DELETE FROM entitlement_plans WHERE id=$1 RETURNING *", [planId])).rows).toStrictEqual([saved.plan]);
                        expect((await executor.query<SqlRow>("SELECT * FROM entitlement_plans ORDER BY id")).rows).toStrictEqual(saved.plans);
                        const restoredSettings = scope?.priceChanged ? { ...fixture.installed, model_point_costs: savedCosts } : fixture.installed;
                        if (scope?.priceChanged) {
                            await writeSettings(executor, restoredSettings);
                        }
                        await repositories.settings.updateSettings({ entitlementsEnabled: saved.entitlementsEnabled });
                        expect(await readSettings(executor)).toStrictEqual(restoredSettings);
                        const restored = (await executor.query<SqlRow>("SELECT * FROM app_settings WHERE id='default'")).rows[0];
                        assert.ok(restored);
                        expect({ ...restored, updated_at: saved.settings.updated_at }).toStrictEqual({ ...saved.settings, ...restoredSettings });
                        expect(restored.updated_at).toBeInstanceOf(Date);
                        return readSettings(executor);
                    });
                    expect((await auth.getFreshAuthSettings()).entitlements.enabled).toBe(saved.entitlementsEnabled);
                } catch (error) {
                    liveCleanupUnconfirmed = true;
                    throw error;
                }
            }
        }

        async function installNativeSceneQuotaPrice(scope: NativeSceneQuotaScope, pointsCost: 2 | 0) {
            const fixture = pgFixture;
            assert.ok(fixture);
            const settings = await auth.getFreshAuthSettings();
            expect(settings.modelPointCosts[imageModelId]).toBe(2);
            if (pointsCost === 0) {
                fixture.installed = await database.withPostgresTransaction(async (executor) => {
                    await database.createPostgresRepositories(executor).settings.lock();
                    expect(await readSettings(executor)).toStrictEqual(fixture.installed);
                    await writeSettings(executor, { ...fixture.installed, model_point_costs: { ...settings.modelPointCosts, [imageModelId]: 0 } });
                    return readSettings(executor);
                });
                scope.priceChanged = true;
            }
            expect((await auth.getFreshAuthSettings()).modelPointCosts[imageModelId]).toBe(pointsCost);
        }

        async function expectNativeSceneQuotaMoney(scope: NativeSceneQuotaScope, units: 0 | 1, pointsSpent: 0 | 2, balance: 98 | 100) {
            const current = await nativeSceneQuotaRows(scope.planId);
            expect(current.plan).toStrictEqual(scope.initial.plan);
            expect(current.assignments).toStrictEqual(scope.initial.assignments);
            expect(current.wallets).toStrictEqual([]);
            expect(current.reservations).toStrictEqual([]);
            expect(current.settings).toStrictEqual([{ entitlements_enabled: true }]);
            expect(current.users).toHaveLength(1);
            const user = current.users[0];
            const originalUser = scope.initial.users[0];
            assert.ok(user && originalUser);
            expect({ ...user, points_balance: originalUser.points_balance, updated_at: originalUser.updated_at }).toStrictEqual(originalUser);
            expect(Number(user.points_balance)).toBe(balance);
            const oldIds = new Set(scope.initial.points.map((row) => row.id));
            expect(current.points.filter((row) => oldIds.has(row.id))).toStrictEqual(scope.initial.points);
            expect(current.quota).toHaveLength(1);
            const quota = current.quota[0];
            assert.ok(quota);
            expect(quota).toMatchObject({ user_id: userId, quota_date: scope.date, usage_kind: "image" });
            expect(Number(quota.units)).toBe(units);
            expect(Number(quota.points_spent)).toBe(pointsSpent);
            expect(quota.updated_at).toBeInstanceOf(Date);
            return current;
        }

        async function refuseNativeSceneQuotaOverrun(scope: NativeSceneQuotaScope) {
            const before = await nativeSceneQuotaRows(scope.planId);
            await expect(auth.consumeUserPoints(userId, imageModelId, 1, "image", "fixture-native-quota-probe:" + scope.assignmentId)).rejects.toThrow("今日图片生成次数不足");
            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(before);
        }

        async function submitNativeSceneQuotaAttempt(submission: ImageTask, origin: string, cookie: string, pointsCost: 2 | 0) {
            const actual = imageTaskSupportActual.module;
            assert.ok(actual);
            expect(cookie).toBe(boundary.cookie);
            const { recordEcommerceCanvasRequest, resolveCanvasRequestSize } = await import("@/app/api/image-tasks/image-task-size");
            const quality = actual.normalizeQuality(submission.config.quality || "");
            const form = await actual.buildImageEditFormData(submission, quality, resolveCanvasRequestSize(submission, quality), origin, cookie, "url", false);
            expect(form.get("size")).toBe("1024x1024");
            expect(form.getAll("image")).toHaveLength(1);
            expect(form.get("mask")).toBeInstanceOf(File);
            await recordEcommerceCanvasRequest(submission, { size: String(form.get("size") || "") }, "OpenAI multipart");
            const charge = await auth.consumeUserPoints(userId, imageModelId, 1, "image", actual.imagePointsIdempotencyKey(submission));
            expect(charge).toMatchObject({ cost: pointsCost, units: 1 });
            return charge;
        }

        async function expectNativeSceneQuotaBindings(fixture: NativeSceneLifecyclePrefix, before: Awaited<ReturnType<typeof nativeSceneLifecyclePostgresRows>>, balance: 98 | 100) {
            const after = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
            assert.ok(before.account && after.account);
            expect(after.rows.filter((row) => row.id !== fixture.first.taskId)).toStrictEqual(before.rows.filter((row) => row.id !== fixture.first.taskId));
            expect({ registrations: after.registrations, logAssets: after.logAssets, assets: after.assets, conversations: after.conversations, messages: after.messages, runEvents: after.runEvents, files: after.files }).toStrictEqual({
                registrations: before.registrations,
                logAssets: before.logAssets,
                assets: before.assets,
                conversations: before.conversations,
                messages: before.messages,
                runEvents: before.runEvents,
                files: before.files,
            });
            expect({ ...after.account, users: before.account.users, pointRecords: before.account.pointRecords, quotaUsage: before.account.quotaUsage }).toStrictEqual(before.account);
            expect(before.account.users).toHaveLength(1);
            expect(after.account.users).toHaveLength(1);
            const originalUser = before.account.users[0];
            const currentUser = after.account.users[0];
            assert.ok(originalUser && currentUser);
            expect({ ...currentUser, points_balance: originalUser.points_balance, updated_at: originalUser.updated_at }).toStrictEqual(originalUser);
            expect(Number(currentUser.points_balance)).toBe(balance);
            expect(currentUser.updated_at).toBeInstanceOf(Date);
            const originalPoints = new Set(before.account.pointRecords.map((row) => row.id));
            expect(after.account.pointRecords.filter((row) => originalPoints.has(row.id))).toStrictEqual(before.account.pointRecords);
            const image = await imageTasks.getImageTask(fixture.first.taskId);
            assert.ok(image);
            const original = fixture.firstBefore;
            expect({
                id: image.id,
                userId: image.userId,
                runId: image.runId,
                parentTaskId: image.parentTaskId,
                clientRequestId: image.clientRequestId,
                conversationId: image.conversationId,
                surface: image.surface,
                projectId: image.projectId,
                config: image.config,
                references: image.references,
                referenceDispatch: image.referenceDispatch,
                ecommerceExecution: image.ecommerceExecution,
                sceneProtection: image.sceneProtection,
                mask: image.mask,
                createdAt: image.createdAt,
                generationLogId: image.generationLogId,
                generationSlotId: image.generationSlotId,
            }).toStrictEqual({
                id: original.id,
                userId: original.userId,
                runId: original.runId,
                parentTaskId: original.parentTaskId,
                clientRequestId: original.clientRequestId,
                conversationId: original.conversationId,
                surface: original.surface,
                projectId: original.projectId,
                config: original.config,
                references: original.references,
                referenceDispatch: original.referenceDispatch,
                ecommerceExecution: original.ecommerceExecution,
                sceneProtection: original.sceneProtection,
                mask: original.mask,
                createdAt: original.createdAt,
                generationLogId: original.generationLogId,
                generationSlotId: original.generationSlotId,
            });
            expect(fixture.created).toHaveLength(2);
            expect(await imageTasks.getImageTask(fixture.second.taskId)).toStrictEqual(fixture.secondBefore);
            expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
            expect(await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey)).toStrictEqual(fixture.originalMaskRegistration);
            expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
            expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
            return after;
        }

        async function runNativeSceneUnknownCreate(fixture: NativeSceneLifecyclePrefix, scope: NativeSceneQuotaScope) {
            const actual = imageTaskSupportActual.module;
            assert.ok(actual);
            const headersObserved = Promise.withResolvers<void>();
            const teardown = Promise.withResolvers<void>();
            const failure = Promise.withResolvers<never>();
            const submissionAbort = new AbortController();
            const active = new Set<Promise<void>>();
            const closed: Promise<void>[] = [];
            const phases: string[] = [];
            const observed = {
                requests: 0,
                requestComplete: false,
                multipartVerified: false,
                headersFlushed: false,
                clientHeadersObserved: false,
                jsonStarted: false,
                jsonSettled: false,
                responseClosed: false,
                socketClosed: false,
                chargedWrapperEntered: false,
            };
            const captured: { charge?: Awaited<ReturnType<typeof auth.consumeUserPoints>>; debited?: Awaited<ReturnType<typeof nativeSceneQuotaRows>>; submission?: ImageTask } = {};
            const attemptKey = "image-task:" + fixture.first.taskId + ":attempt:1";

            async function handle(request: IncomingMessage, response: ServerResponse) {
                closed.push(
                    new Promise<void>((resolve) =>
                        response.once("close", () => {
                            observed.responseClosed = true;
                            resolve();
                        }),
                    ),
                );
                closed.push(
                    new Promise<void>((resolve) =>
                        request.socket.once("close", () => {
                            observed.socketClosed = true;
                            resolve();
                        }),
                    ),
                );
                response.once("error", (error) => failure.reject(error));
                observed.requests += 1;
                expect(observed.requests).toBe(1);
                expect(request.method).toBe("POST");
                expect(request.url).toBe("/native-scene/create-unknown");
                expect(request.headers.cookie).toBe(boundary.cookie);
                const requestKey = request.headers["idempotency-key"];
                assert.ok(typeof requestKey === "string");
                expect(requestKey).toBe(attemptKey);
                expect(request.headers["x-client-request-id"]).toBe(attemptKey);
                expect(request.headers["x-vozeb-pro-logical-model"]).toBe(imageModelId);
                expect(request.headers["x-vozeb-pro-upstream-model"]).toBe(fixture.firstBefore.config.model);
                const contentType = request.headers["content-type"];
                assert.ok(contentType && contentType.startsWith("multipart/form-data; boundary="));
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                expect(request.complete).toBe(true);
                observed.requestComplete = true;
                phases.push("request_complete");
                const received = await new Request("http://localhost/native-scene/create-unknown", { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(Buffer.concat(chunks)) }).formData();
                expect(received.get("model")).toBe(fixture.firstBefore.config.model);
                expect(received.get("size")).toBe("1024x1024");
                expect(received.get("n")).toBe("1");
                expect(received.getAll("image")).toHaveLength(1);
                expect(received.getAll("mask")).toHaveLength(1);
                const image = received.get("image");
                const mask = received.get("mask");
                assert.ok(image instanceof File && mask instanceof File);
                expect(Buffer.from(await image.arrayBuffer())).toEqual(fixture.source);
                expect(Buffer.from(await mask.arrayBuffer())).toEqual(fixture.built.bytes);
                observed.multipartVerified = true;
                phases.push("multipart_verified");
                const charge = await auth.consumeUserPoints(userId, imageModelId, 1, "image", requestKey);
                expect(charge).toMatchObject({ cost: 2, units: 1, remaining: 98, permanentRemaining: 98, dailyRemaining: 0, planId: scope.planId, idempotencyKey: attemptKey });
                captured.charge = charge;
                captured.debited = await expectNativeSceneQuotaMoney(scope, 1, 2, 98);
                phases.push("charged");
                response.writeHead(200, {
                    "content-type": "application/json",
                    "content-length": "64",
                    "x-vozeb-pro-points-cost": String(charge.cost),
                    "x-vozeb-pro-points-record-id": charge.recordId,
                    "x-vozeb-pro-points-remaining": String(charge.remaining),
                });
                response.flushHeaders();
                response.write('{"data":[');
                observed.headersFlushed = true;
                phases.push("headers_flushed");
                await Promise.race([headersObserved.promise, teardown.promise]);
                phases.push("response_destroyed");
                response.destroy();
            }

            const server = createServer((request, response) => {
                const running = handle(request, response)
                    .catch((error: unknown) => {
                        failure.reject(error);
                        response.destroy();
                    })
                    .finally(() => active.delete(running));
                active.add(running);
            });
            let pending: ReturnType<typeof recovery.runGenerationTaskRecoveryBatch> | undefined;
            let actionError: unknown;
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", () => {
                        server.off("error", reject);
                        resolve();
                    });
                });
                server.on("error", (error) => failure.reject(error));
                const address = server.address();
                assert.ok(address && typeof address !== "string");
                const providerOrigin = "http://127.0.0.1:" + address.port;
                boundary.create.mockImplementation(async (submission: ImageTask, origin: string, _publicOrigin: string, cookie: string): Promise<ImageTaskRunResult> => {
                    expect(submission.id).toBe(fixture.first.taskId);
                    expect(submission.attemptNo).toBe(1);
                    expect(submission.config).toStrictEqual(fixture.firstBefore.config);
                    expect(submission.config.baseUrl.startsWith("/")).toBe(true);
                    expect(cookie).toBe(boundary.cookie);
                    captured.submission = submission;
                    const { recordEcommerceCanvasRequest, resolveCanvasRequestSize } = await import("@/app/api/image-tasks/image-task-size");
                    const quality = actual.normalizeQuality(submission.config.quality || "");
                    const form = await actual.buildImageEditFormData(submission, quality, resolveCanvasRequestSize(submission, quality), origin, cookie, "url", false);
                    await recordEcommerceCanvasRequest(submission, { size: String(form.get("size") || "") }, "OpenAI multipart");
                    const url = providerOrigin + "/native-scene/create-unknown";
                    const response = await actual.imageSubmissionFetch(submission.config, url, {
                        method: "POST",
                        headers: actual.taskHeaders(submission.config, cookie, actual.imagePointsIdempotencyKey(submission)),
                        body: form,
                        cache: "no-store",
                        signal: submissionAbort.signal,
                    });
                    expect(response.status).toBe(200);
                    assert.ok(captured.charge);
                    expect(actual.readBilling(response.headers)).toStrictEqual({ pointsRemaining: captured.charge.remaining, pointsCost: captured.charge.cost, pointsRecordId: captured.charge.recordId });
                    observed.clientHeadersObserved = true;
                    phases.push("client_headers_observed");
                    const parsing = actual.parseImageSubmissionJson<Parameters<typeof actual.parseImagePayloadOrPoll>[1]>(submission, response);
                    observed.jsonStarted = true;
                    phases.push("json_started");
                    headersObserved.resolve();
                    const payload = await parsing.finally(() => {
                        observed.jsonSettled = true;
                        phases.push("json_settled");
                    });
                    // Preserve the actual OpenAI call order: body failure stops before this wrapper.
                    observed.chargedWrapperEntered = true;
                    return actual.parseChargedImageResponse(submission, response, () => actual.parseImagePayloadOrPoll(submission.config, payload, providerOrigin, cookie, url, true));
                });
                pending = recovery.runGenerationTaskRecoveryBatch({ origin: fixture.imageOrigin, publicOrigin: fixture.imageOrigin, cookie: boundary.cookie, workerId: "fixture-native-pg-create-unknown", taskIds: [fixture.first.taskId], limit: 1 });
                await drainLiveRequests(Promise.race([pending, failure.promise]), "SETUP: original native create did not settle after the observed-header body interruption");
                const batch = await pending;
                assert.ok(captured.charge && captured.debited && captured.submission);
                await drainLiveRequests(Promise.all([...active, ...closed]), "CLEANUP: native create request/response/socket did not close after the body interruption");
                return { batch, charge: captured.charge, debited: captured.debited, submission: captured.submission, observed, phases };
            } catch (error) {
                actionError = error;
                throw error;
            } finally {
                teardown.resolve();
                submissionAbort.abort();
                const stopped = server.listening ? new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) : Promise.resolve();
                server.closeAllConnections();
                try {
                    await drainLiveRequests(
                        Promise.all([
                            stopped,
                            ...active,
                            ...closed,
                            ...(pending
                                ? [
                                      pending.then(
                                          () => undefined,
                                          () => undefined,
                                      ),
                                  ]
                                : []),
                        ]),
                        "CLEANUP: original native Unknown create I/O remains live after TCP teardown",
                    );
                } catch (error) {
                    if (actionError) throw new AggregateError([actionError, error], "Native Unknown create failed and its live I/O cleanup is unconfirmed");
                    throw error;
                }
            }
        }

        it("keeps two genuinely prepared native scene Run copies on their original protected results through the CPU Worker and Agent adoption", async () => {
            await withNativeScenePrefix(
                async ({ conversation, source, baseline, initial, paused, plan, built, originalMaskRegistration, maskUrl, imageOrigin, created, dispatched, task, first, second, siblingRecord, submitted, charge, firstDebits, native, step }) => {
                    assert.ok(dispatched.executionId);
                    // UNREACHED on the admitted v444 production baseline; Root must record actual execution separately.
                    async function finishNativeResult(copy: { requestId: string; taskId: string }, original: ImageTask, resultUrl: string, nativeBytes: Buffer, insidePixel: number[]) {
                        const queried = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(queried?.nativeResults);
                        expect(queried.result).toBeUndefined();
                        const slot = queried.nativeResults.slots[0];
                        assert.ok(slot.status === "stored");
                        const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                        expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(nativeBytes);
                        expect(slot).toMatchObject({ sha256: digest(nativeBytes), bytes: nativeBytes.length, resultId: copy.taskId + ":1", resultIndex: 1 });
                        expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, type: "attachment", source: "image-task-native-result", storageClass: "permanent" });
                        expect(await runtime.persistImageTaskResult(queried, imageOrigin, resultUrl, boundary.cookie)).toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
                        const waiting = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(waiting?.resultProcessing);
                        expect(waiting.result).toBeUndefined();
                        const waitingRecord = await tasks.getStoredGenerationTaskRecord("image", copy.taskId);
                        expect(waitingRecord).toMatchObject({ executionPhase: "persisting", parentTaskId: paused.id, runId: paused.id });
                        expect(waitingRecord?.workerId).toBeUndefined();
                        expect(waitingRecord?.leaseUntil).toBeUndefined();
                        const worker = await processWithWorker(waiting.resultProcessing.jobId);
                        const payload = worker.child.payload;
                        assert.ok(payload.operation === "process_result" && payload.options.mode === "scene_protection");
                        const { mask, ...protection } = task.sceneProtection!;
                        expect(mask.serverUrl).toBe(maskUrl);
                        expect(payload.options).toStrictEqual({ mode: "scene_protection", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], sourceInputIndex: 1, maskInputIndex: 2, protection });
                        expect(payload.inputs).toHaveLength(3);
                        expect(payload.inputs[1]).toMatchObject({ assetId: baseline.id, assetVersion: digest(source), expectedSha256: digest(source) });
                        expect(payload.inputs[2]).toMatchObject({ assetId: task.sceneProtection!.mask.id, assetVersion: digest(built.bytes), expectedSha256: digest(built.bytes) });
                        expect(payload.sources.find((input) => input.inputIndex === 2)).toMatchObject({ scope: "reference", storageKey: built.stored.storageKey });
                        expect(payload.parentMask).toStrictEqual({ inputIndex: 2, imageTaskId: copy.taskId });
                        expect(payload.imageResultBinding).toMatchObject({
                            imageTaskId: copy.taskId,
                            userId,
                            nativeResults: queried.nativeResults,
                            sourceIdentityDigest: expect.any(String),
                            run: { runId: paused.id, agentTaskId: task.id, agentAttempt: 1 },
                        });
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", worker.child.id)).toMatchObject({ status: "success", executionPhase: "completed", parentTaskId: copy.taskId, runId: paused.id, userId });
                        expect(worker.receipt).toMatchObject({ jobId: worker.child.id, inputDigest: payload.inputDigest, executionId: worker.child.executionId, manifest: worker.completion.manifest, parentRescheduled: true });
                        expect(worker.completion.manifest.results).toMatchObject([
                            {
                                resultId: copy.taskId + ":1",
                                nativeInputIndex: 0,
                                finalArtifactIndex: 0,
                                sceneProtectionEvidence: { sourceDigest: digest(source), maskDigest: digest(built.bytes), nativeDigest: digest(nativeBytes), normalization: "none", outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
                            },
                        ]);
                        expect(worker.uploads).toHaveLength(1);
                        expect(worker.completion.manifest.artifacts).toHaveLength(1);
                        const final = worker.completion.manifest.artifacts[0];
                        expect(final).toMatchObject({ kind: "final", resultId: copy.taskId + ":1", resultIndex: 1, width: 1024, height: 1024, mimeType: "image/png" });
                        expect(worker.uploads[0].stored).toStrictEqual(final);
                        expect(digest(worker.uploads[0].bytes)).toBe(final.sha256);
                        expect(final.sha256).not.toBe(digest(nativeBytes));
                        const pixels = await sharp(worker.uploads[0].bytes).ensureAlpha().raw().toBuffer();
                        expect([...pixels.subarray(0, 4)]).toStrictEqual([18, 52, 86, 255]);
                        expect([...pixels.subarray(1049600, 1049604)]).toStrictEqual(insidePixel);
                        const debits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                        const recoveryInput = { origin: imageOrigin, cookie: boundary.cookie, workerId: "fixture-native-scene-consumer-" + copy.taskId, taskIds: [copy.taskId], limit: 1 };
                        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
                        const published = await imageTasks.getImageTask(copy.taskId);
                        assert.ok(published?.result?.results);
                        expect(published).toMatchObject({
                            id: copy.taskId,
                            clientRequestId: copy.requestId,
                            runId: paused.id,
                            parentTaskId: paused.id,
                            status: "success",
                            billing: original.billing,
                            attemptNo: original.attemptNo,
                            upstream: original.upstream,
                            nativeResults: queried.nativeResults,
                            resultProcessing: waiting.resultProcessing,
                        });
                        expect(published.attempts).toHaveLength(1);
                        expect(published.result.results).toHaveLength(1);
                        const delivered = published.result.results[0];
                        expect(delivered).toMatchObject({
                            width: 1024,
                            height: 1024,
                            mimeType: "image/png",
                            canvasEvidence: {
                                constraint: plan.canvas,
                                providerRequest: published.ecommerceCanvasRequest,
                                requestedSize: { width: 1024, height: 1024 },
                                nativeSize: { width: 1024, height: 1024 },
                                storedSize: { width: 1024, height: 1024 },
                                normalization: "none",
                            },
                            sceneProtectionEvidence: { ...protection, maskUrl, nativeDigest: digest(nativeBytes), compositeDigest: final.sha256, outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
                        });
                        const nativeUrl = "/api/reference-assets/" + slot.storageKey.split("/").map(encodeURIComponent).join("/");
                        expect(delivered.canvasEvidence?.nativeUrl).toBe(nativeUrl);
                        expect(delivered.sceneProtectionEvidence?.nativeUrl).toBe(nativeUrl);
                        expect(delivered.sceneProtectionEvidence?.compositeUrl).toBe(delivered.serverUrl);
                        const retainedMask = await registrations.getLocalMediaRegistration(built.stored.storageKey);
                        const expectedMaskRegistration = { ...originalMaskRegistration, storageClass: "permanent" };
                        delete expectedMaskRegistration.expiresAt;
                        expect(retainedMask).toStrictEqual(provider === "file" ? expectedMaskRegistration : { ...expectedMaskRegistration, expiresAt: undefined });
                        expect(retainedMask?.storageClass).toBe("permanent");
                        expect(retainedMask?.expiresAt).toBeUndefined();
                        const maskResponse = await fetch(imageOrigin + maskUrl, { headers: { cookie: boundary.cookie } });
                        expect(maskResponse.status).toBe(200);
                        expect(Buffer.from(await maskResponse.arrayBuffer())).toEqual(built.bytes);
                        const retainedFinal = await registrations.getLocalMediaRegistration(final.storageKey);
                        expect(retainedFinal).toMatchObject({ ownerUserId: userId, taskId: worker.child.id, runId: paused.id, storageClass: "permanent" });
                        expect(retainedFinal?.expiresAt).toBeUndefined();
                        expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(debits);
                        const asset = (await creative.listAssetsForUser(userId, conversation.id)).find((item) => item.sourceTaskId === copy.taskId);
                        assert.ok(asset);
                        expect(asset).toMatchObject({ sourceTaskId: copy.taskId, sourceRunId: paused.id, serverUrl: delivered.serverUrl, status: "ready" });
                        return { published, worker, recoveryInput, asset, final };
                    }
                    const firstResult = await finishNativeResult(first, submitted, step.resultUrl, native, [171, 205, 239, 255]);
                    await execution.executeTasks(paused.id, imageOrigin, boundary.cookie, dispatched.executionId);
                    expect(await runs.getAgentRun(paused.id)).toMatchObject({
                        status: "running",
                        tasks: [
                            {
                                id: task.id,
                                count: 2,
                                attempts: 1,
                                status: "running",
                                childTasks: [expect.objectContaining({ id: first.taskId, status: "completed", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "pending", attempt: 1 })],
                            },
                        ],
                    });
                    expect(await tasks.getStoredGenerationTaskRecord("image", second.taskId)).toStrictEqual(siblingRecord);
                    expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(firstDebits);
                    const settledFirst = await imageTasks.getImageTask(first.taskId);
                    const [secondClaim] = await scheduler.claimDueGenerationTasks({ workerId: "fixture-native-result-original-copy-two", taskIds: [second.taskId], limit: 1 });
                    assert.ok(secondClaim && typeof secondClaim.payload.executionId === "string");
                    const claimedSecond = await imageTasks.getImageTask(second.taskId);
                    assert.ok(claimedSecond);
                    expect(claimedSecond.executionId).toBe(secondClaim.payload.executionId);
                    expect(await runtime.createImageTaskUpstreamStep(claimedSecond, imageOrigin, imageOrigin, boundary.cookie)).toMatchObject({ state: "pending", upstream: { id: "fixture-upstream-" + second.taskId } });
                    const secondSubmitted = await imageTasks.getImageTask(second.taskId);
                    const secondCharge = charges.get(second.taskId);
                    assert.ok(secondSubmitted?.upstream && secondCharge);
                    expect(secondCharge.cost).toBe(2);
                    expect(secondCharge.recordId).not.toBe(charge.recordId);
                    const secondNative = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#fedcba" } })
                        .png()
                        .toBuffer();
                    providerResults.set(secondSubmitted.upstream.id, { dataUrl: dataUrl(secondNative), results: [{ dataUrl: dataUrl(secondNative) }] });
                    const secondStep = await runtime.queryImageTaskUpstreamStep(secondSubmitted, imageOrigin, boundary.cookie);
                    expect(secondStep).toMatchObject({ state: "result_ready", status: "native_ready" });
                    assert.ok(secondStep.state === "result_ready");
                    const secondResult = await finishNativeResult(second, secondSubmitted, secondStep.resultUrl, secondNative, [254, 220, 186, 255]);
                    expect(secondResult.worker.child.id).not.toBe(firstResult.worker.child.id);
                    expect(secondResult.final.storageKey).not.toBe(firstResult.final.storageKey);
                    expect(await imageTasks.getImageTask(first.taskId)).toStrictEqual(settledFirst);
                    // Observe only Agent adoption; both real Workers and fixture pixel checks have finished.
                    const webSharp = (await import("sharp")).default;
                    const pixelSpies = {
                        raw: vi.spyOn(webSharp.prototype, "raw"),
                        stats: vi.spyOn(webSharp.prototype, "stats"),
                        resize: vi.spyOn(webSharp.prototype, "resize"),
                        toBuffer: vi.spyOn(webSharp.prototype, "toBuffer"),
                        toFile: vi.spyOn(webSharp.prototype, "toFile"),
                    };
                    let noWebPixels: { pid: number; raw: number; stats: number; resize: number; toBuffer: number; toFile: number };
                    try {
                        await execution.executeTasks(paused.id, imageOrigin, boundary.cookie, dispatched.executionId);
                        noWebPixels = {
                            pid: process.pid,
                            raw: pixelSpies.raw.mock.calls.length,
                            stats: pixelSpies.stats.mock.calls.length,
                            resize: pixelSpies.resize.mock.calls.length,
                            toBuffer: pixelSpies.toBuffer.mock.calls.length,
                            toFile: pixelSpies.toFile.mock.calls.length,
                        };
                    } finally {
                        pixelSpies.raw.mockRestore();
                        pixelSpies.stats.mockRestore();
                        pixelSpies.resize.mockRestore();
                        pixelSpies.toBuffer.mockRestore();
                        pixelSpies.toFile.mockRestore();
                    }
                    const completed = await runs.getAgentRun(paused.id);
                    expect(completed).toMatchObject({
                        status: "completed",
                        tasks: [
                            {
                                id: task.id,
                                count: 2,
                                attempts: 1,
                                status: "completed",
                                taskIds: [first.taskId, second.taskId],
                                childTasks: [expect.objectContaining({ id: first.taskId, status: "completed", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "completed", attempt: 1 })],
                            },
                        ],
                        ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" } },
                    });
                    expect(completed?.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                    expect(completed?.assetIds).toEqual(expect.arrayContaining([firstResult.asset.id, secondResult.asset.id]));
                    const assets = await creative.listAssetsForUser(userId, conversation.id);
                    expect(assets).toHaveLength(3);
                    expect(assets.find((asset) => asset.id === firstResult.asset.id)).toMatchObject({
                        parentAssetId: baseline.id,
                        sourceTaskId: first.taskId,
                        sourceRunId: paused.id,
                        messageId: initial.assistantMessageId,
                        metadata: { agentTaskId: task.id },
                    });
                    expect(assets.find((asset) => asset.id === secondResult.asset.id)).toMatchObject({
                        parentAssetId: baseline.id,
                        sourceTaskId: second.taskId,
                        sourceRunId: paused.id,
                        messageId: initial.assistantMessageId,
                        metadata: { agentTaskId: task.id },
                    });
                    const successfulLogs = (await logs.listGenerationLogs({ userId })).items;
                    expect(successfulLogs).toHaveLength(2);
                    expect(successfulLogs).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ id: "image-task:" + first.taskId, taskId: first.taskId, status: "success", count: 1, successCount: 1 }),
                            expect.objectContaining({ id: "image-task:" + second.taskId, taskId: second.taskId, status: "success", count: 1, successCount: 1 }),
                        ]),
                    );
                    const finalDebits = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                    expect(finalDebits.records).toHaveLength(2);
                    expect(finalDebits.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: charge.recordId, amount: -2 }), expect.objectContaining({ id: secondCharge.recordId, amount: -2 })]));
                    expect(boundary.create).toHaveBeenCalledTimes(2);
                    expect(boundary.poll).toHaveBeenCalledTimes(2);
                    expect(created).toHaveLength(2);
                    const finalFirst = await imageTasks.getImageTask(first.taskId);
                    const finalSecond = await imageTasks.getImageTask(second.taskId);
                    const settled = await ownedRows(conversation.id);
                    expect(await service.completeImageProcessingTask(firstResult.worker.child.id, firstResult.worker.completion)).toStrictEqual(firstResult.worker.receipt);
                    expect(await service.completeImageProcessingTask(secondResult.worker.child.id, secondResult.worker.completion)).toStrictEqual(secondResult.worker.receipt);
                    expect(await recovery.runGenerationTaskRecoveryBatch(firstResult.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                    expect(await recovery.runGenerationTaskRecoveryBatch(secondResult.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                    expect(await runtime.persistImageTaskResult(firstResult.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalFirst);
                    expect(await runtime.persistImageTaskResult(secondResult.published, imageOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(finalSecond);
                    expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                    expect(noWebPixels, "RED: native scene technical QA must adopt the original Worker results without Web pixel processing").toStrictEqual({
                        pid: process.pid,
                        raw: 0,
                        stats: 0,
                        resize: 0,
                        toBuffer: 0,
                        toFile: 0,
                    });
                },
            );
        }, 120_000);

        it("refuses native scene result enqueue after the original receipt changes without yielding or writing", async () => {
            await withNativeScenePrefix(async (fixture) => {
                const runBefore = await runs.getAgentRun(fixture.paused.id);
                assert.ok(runBefore?.executionId && runBefore.ecommerceSnapshot?.processing?.sceneSelection);
                const snapshot = runBefore.ecommerceSnapshot;
                const processingBefore = snapshot.processing;
                assert.ok(processingBefore?.sceneSelection);
                const receiptBefore = processingBefore.sceneSelection;
                expect(receiptBefore).toStrictEqual(fixture.receipt);
                const s0 = await ownedRows(fixture.conversation.id);
                const changedReceipt = { ...receiptBefore, confirmation: { ...receiptBefore.confirmation, confirmedAt: receiptBefore.confirmation.confirmedAt + 1 } };
                const expectedSnapshot = { ...snapshot, processing: { ...processingBefore, sceneSelection: changedReceipt } };
                const changed = await runs.updateAgentRunById(runBefore.id, { ecommerceSnapshot: expectedSnapshot }, undefined, ["running"], runBefore.executionId);
                assert.ok(changed);
                const runAfterFault = await runs.getAgentRun(runBefore.id);
                assert.ok(runAfterFault);
                expect(runAfterFault).toStrictEqual({ ...runBefore, ecommerceSnapshot: expectedSnapshot, updatedAt: runAfterFault.updatedAt });
                const s1 = await ownedRows(fixture.conversation.id);
                const { rows: beforeRows, files: beforeFiles, ...beforeOther } = s0;
                const { rows: faultRows, files: faultFiles, ...faultOther } = s1;
                const originalRunRow = beforeRows.find((row) => row.id === runBefore.id);
                assert.ok(originalRunRow && originalRunRow.payload && typeof originalRunRow.payload === "object");
                const expectedRunPayload = { ...originalRunRow.payload, ecommerceSnapshot: expectedSnapshot, updatedAt: runAfterFault.updatedAt };
                expect(faultRows.find((row) => row.id === runBefore.id)).toStrictEqual(
                    provider === "file"
                        ? { ...originalRunRow, payload: expectedRunPayload, updatedAt: runAfterFault.updatedAt, expiresAt: runAfterFault.updatedAt + runs.AGENT_RUN_TTL_MS }
                        : { ...originalRunRow, payload: expectedRunPayload, updated_at: new Date(runAfterFault.updatedAt), expires_at: new Date(runAfterFault.updatedAt + runs.AGENT_RUN_TTL_MS) },
                );
                expect(faultRows.filter((row) => row.id !== runBefore.id)).toStrictEqual(beforeRows.filter((row) => row.id !== runBefore.id));
                expect(faultOther).toStrictEqual(beforeOther);
                expect(faultFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE)).toStrictEqual(beforeFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE));
                const refused = processing.ensureImageTaskResultProcessing(fixture.imageClaim);
                await expect(refused).rejects.toBeInstanceOf(service.ImageProcessingInputError);
                await expect(refused).rejects.toMatchObject({ status: 409, message: "原生场景结果与当前确认和build不一致" });
                expect(await ownedRows(fixture.conversation.id)).toStrictEqual(s1);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                expect(await readFile(fixture.nativePath)).toEqual(fixture.native);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(fixture.firstDebits);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
            });
        }, 120_000);

        it("refuses native scene mask input after the original prepare completion digest changes without writing", async () => {
            await withNativeScenePrefix(async (fixture) => {
                expect(await processing.ensureImageTaskResultProcessing(fixture.imageClaim)).toStrictEqual({ state: "waiting" });
                const waiting = await imageTasks.getImageTask(fixture.first.taskId);
                assert.ok(waiting?.resultProcessing);
                const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
                const workerId = "fixture-native-scene-input-fault-worker";
                const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 6144 * 1024 * 1024, slots: 1 });
                expect(claimed.tasks).toHaveLength(1);
                const child = claimed.tasks[0];
                assert.ok(child && child.payload.operation === "process_result" && child.payload.options.mode === "scene_protection");
                expect(child.id).toBe(waiting.resultProcessing.jobId);
                const maskInput = child.payload.inputs[child.payload.options.maskInputIndex];
                assert.ok(maskInput);
                expect(maskInput.expectedSha256).toBe(digest(fixture.built.bytes));
                const inputRoute = await import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");
                const request = () =>
                    new Request(`${fixture.imageOrigin}/api/maintenance/image-processing/${child.id}/inputs/${encodeURIComponent(maskInput.assetId)}`, {
                        headers: { authorization: `Bearer ${workerToken}`, "x-vozeb-pro-worker-id": workerId, "x-vozeb-pro-execution-id": child.executionId },
                    });
                const context = { params: Promise.resolve({ id: child.id, assetId: maskInput.assetId }) };
                const valid = await inputRoute.GET(request(), context);
                expect(valid.status).toBe(200);
                expect(Buffer.from(await valid.arrayBuffer())).toEqual(fixture.built.bytes);
                const prepareBeforeFault = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id);
                assert.ok(prepareBeforeFault?.resultPayload && typeof prepareBeforeFault.resultPayload.manifestDigest === "string");
                expect(prepareBeforeFault).toStrictEqual(fixture.prepareBefore);
                const badDigest = "0000000000000000000000000000000000000000000000000000000000000000";
                expect(prepareBeforeFault.resultPayload.manifestDigest).not.toBe(badDigest);
                const changedResult = { ...prepareBeforeFault.resultPayload, manifestDigest: badDigest };
                const s0 = await ownedRows(fixture.conversation.id);
                if (provider === "file") {
                    await tasks.withGenerationTaskFileMutation(async (records) => {
                        const original = records.find((record) => record.type === "image_processing" && record.id === prepareBeforeFault.id && record.userId === userId);
                        expect(original).toStrictEqual(prepareBeforeFault);
                        return { tasks: records.map((record) => (record === original ? { ...record, resultPayload: changedResult } : record)), result: undefined };
                    });
                } else {
                    await database.withPostgresTransaction(async (executor) => {
                        const original = await tasks.getStoredGenerationTaskRecord("image_processing", prepareBeforeFault.id, executor, true);
                        expect(original).toStrictEqual(prepareBeforeFault);
                        const updated = await executor.query<{ id: string }>(
                            "UPDATE generation_tasks SET result_payload=$3::jsonb WHERE id=$1 AND user_id=$2 AND task_type='image_processing' AND status='success' AND execution_phase='completed' AND result_payload=$4::jsonb AND payload=$5::jsonb AND run_id=$6 AND parent_task_id=$6 RETURNING id",
                            [prepareBeforeFault.id, userId, JSON.stringify(changedResult), JSON.stringify(prepareBeforeFault.resultPayload), JSON.stringify(prepareBeforeFault.payload), fixture.paused.id],
                        );
                        expect(updated.rows).toStrictEqual([{ id: prepareBeforeFault.id }]);
                    });
                }
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBeforeFault.id)).toStrictEqual({ ...prepareBeforeFault, resultPayload: changedResult });
                const s1 = await ownedRows(fixture.conversation.id);
                const { rows: beforeRows, files: beforeFiles, ...beforeOther } = s0;
                const { rows: faultRows, files: faultFiles, ...faultOther } = s1;
                const originalPrepareRow = beforeRows.find((row) => row.id === prepareBeforeFault.id);
                assert.ok(originalPrepareRow);
                expect(faultRows.find((row) => row.id === prepareBeforeFault.id)).toStrictEqual(provider === "file" ? { ...originalPrepareRow, resultPayload: changedResult } : { ...originalPrepareRow, result_payload: changedResult });
                expect(faultRows.filter((row) => row.id !== prepareBeforeFault.id)).toStrictEqual(beforeRows.filter((row) => row.id !== prepareBeforeFault.id));
                expect(faultOther).toStrictEqual(beforeOther);
                expect(faultFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE)).toStrictEqual(beforeFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE));
                const refused = await inputRoute.GET(request(), context);
                expect(refused.status).toBe(409);
                expect(await refused.json()).toStrictEqual({ code: 409, data: null, msg: "保护阶段参考原件与实际成功的预处理阶段不符" });
                expect(await ownedRows(fixture.conversation.id)).toStrictEqual(s1);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                expect(await readFile(fixture.nativePath)).toEqual(fixture.native);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(fixture.firstDebits);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
            });
        }, 120_000);

        it("refuses native scene final upload after the original build completion changes during real body I/O without associating or publishing it", async () => {
            await withNativeScenePrefix(async (fixture) => {
                const current = await closeNativeSceneResultBeforeUpload(fixture);
                const resultBefore = await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id);
                assert.ok(resultBefore);
                expect(resultBefore.resultPayload?.artifacts).toBeUndefined();
                expect(resultBefore.resultPayload?.manifest).toBeUndefined();
                const started = Promise.withResolvers<void>();
                const release = Promise.withResolvers<void>();
                const stream = new ReadableStream<Uint8Array>(
                    {
                        async pull(controller) {
                            controller.enqueue(new Uint8Array(current.bytes));
                            started.resolve();
                            await release.promise;
                            controller.close();
                        },
                    },
                    { highWaterMark: 0 },
                );
                const outputRoute = await import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
                const requestInit = {
                    method: "PUT",
                    headers: { authorization: `Bearer ${workerToken}`, "content-type": current.artifact.mimeType, "x-vozeb-pro-worker-id": current.identity.workerId, "x-vozeb-pro-execution-id": current.identity.executionId },
                    body: stream,
                    duplex: "half",
                };
                const request = new Request(`${fixture.imageOrigin}/api/maintenance/image-processing/${current.child.id}/outputs/final?resultId=${encodeURIComponent(current.resultId)}`, requestInit);
                expect(request.bodyUsed).toBe(false);
                expect(stream.locked).toBe(false);
                const pending = outputRoute.PUT(request, { params: Promise.resolve({ id: current.child.id, kind: "final" }) });
                try {
                    await Promise.race([
                        started.promise,
                        pending.then((response) => {
                            throw new Error(`SETUP: final upload settled with HTTP ${response.status} before held body EOF`);
                        }),
                    ]);
                    expect(request.bodyUsed).toBe(true);
                    expect(stream.locked).toBe(true);
                    const buildBeforeFault = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id);
                    assert.ok(buildBeforeFault?.resultPayload && typeof buildBeforeFault.resultPayload.manifestDigest === "string");
                    expect(buildBeforeFault).toStrictEqual(fixture.buildBefore);
                    const badDigest = "0000000000000000000000000000000000000000000000000000000000000000";
                    expect(buildBeforeFault.resultPayload.manifestDigest).not.toBe(badDigest);
                    const changedResult = { ...buildBeforeFault.resultPayload, manifestDigest: badDigest };
                    const s0 = await ownedRows(fixture.conversation.id);
                    if (provider === "file") {
                        await tasks.withGenerationTaskFileMutation(async (records) => {
                            const original = records.find((record) => record.type === "image_processing" && record.id === buildBeforeFault.id && record.userId === userId);
                            expect(original).toStrictEqual(buildBeforeFault);
                            return { tasks: records.map((record) => (record === original ? { ...record, resultPayload: changedResult } : record)), result: undefined };
                        });
                    } else {
                        await database.withPostgresTransaction(async (executor) => {
                            const original = await tasks.getStoredGenerationTaskRecord("image_processing", buildBeforeFault.id, executor, true);
                            expect(original).toStrictEqual(buildBeforeFault);
                            const updated = await executor.query<{ id: string }>(
                                "UPDATE generation_tasks SET result_payload=$3::jsonb WHERE id=$1 AND user_id=$2 AND task_type='image_processing' AND status='success' AND execution_phase='completed' AND result_payload=$4::jsonb AND payload=$5::jsonb AND run_id=$6 AND parent_task_id=$7 RETURNING id",
                                [buildBeforeFault.id, userId, JSON.stringify(changedResult), JSON.stringify(buildBeforeFault.resultPayload), JSON.stringify(buildBeforeFault.payload), fixture.paused.id, fixture.task.id],
                            );
                            expect(updated.rows).toStrictEqual([{ id: buildBeforeFault.id }]);
                        });
                    }
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", buildBeforeFault.id)).toStrictEqual({ ...buildBeforeFault, resultPayload: changedResult });
                    const s1 = await ownedRows(fixture.conversation.id);
                    const { rows: beforeRows, files: beforeFiles, ...beforeOther } = s0;
                    const { rows: faultRows, files: faultFiles, ...faultOther } = s1;
                    const originalBuildRow = beforeRows.find((row) => row.id === buildBeforeFault.id);
                    assert.ok(originalBuildRow);
                    expect(faultRows.find((row) => row.id === buildBeforeFault.id)).toStrictEqual(provider === "file" ? { ...originalBuildRow, resultPayload: changedResult } : { ...originalBuildRow, result_payload: changedResult });
                    expect(faultRows.filter((row) => row.id !== buildBeforeFault.id)).toStrictEqual(beforeRows.filter((row) => row.id !== buildBeforeFault.id));
                    expect(faultOther).toStrictEqual(beforeOther);
                    expect(faultFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE)).toStrictEqual(beforeFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE));
                    const allFileRegistrations = provider === "file" ? await registrations.listFileLocalMediaRegistrations() : undefined;
                    release.resolve();
                    const refused = await pending;
                    expect(refused.status).toBe(409);
                    expect(await refused.json()).toStrictEqual({ code: 409, data: null, msg: "场景保护产物与真实完成阶段或确认选区不一致" });
                    const after = await ownedRows(fixture.conversation.id);
                    const { registrations: priorRegistrations, files: priorFiles, ...priorBusiness } = s1;
                    const { registrations: afterRegistrations, files: afterFiles, ...afterBusiness } = after;
                    expect(afterBusiness).toStrictEqual(priorBusiness);
                    const registrationKey = (row: (typeof priorRegistrations)[number]) => String("storageKey" in row ? row.storageKey : row.storage_key);
                    const priorKeys = new Set(priorRegistrations.map(registrationKey));
                    expect(afterRegistrations.filter((row) => priorKeys.has(registrationKey(row)))).toStrictEqual(priorRegistrations);
                    const orphanKeys = afterRegistrations.filter((row) => !priorKeys.has(registrationKey(row))).map(registrationKey);
                    expect(orphanKeys.length).toBeLessThanOrEqual(1);
                    const orphanKeySet = new Set(orphanKeys);
                    const orphanRegistrations = await registrations.getLocalMediaRegistrations(orphanKeys, { ownerUserId: userId });
                    expect(orphanRegistrations.map((registration) => registration.storageKey).toSorted()).toStrictEqual(orphanKeys.toSorted());
                    const { REFERENCE_MEDIA_ROOT, TEMPORARY_MEDIA_TTL_MS } = await import("./local-media-storage");
                    await Promise.all(
                        orphanRegistrations.map(async (registration) => {
                            expect(registration).toMatchObject({
                                ownerUserId: userId,
                                scope: "reference",
                                storageClass: "temporary",
                                type: "image",
                                source: "image-processing-final",
                                taskId: current.child.id,
                                runId: fixture.paused.id,
                                mimeType: current.artifact.mimeType,
                                bytes: current.bytes.length,
                                storageProvider: "local",
                            });
                            expect(registration.conversationId).toBeUndefined();
                            expect(registration.projectId).toBeUndefined();
                            expect(registration.externalStorageId).toBeUndefined();
                            expect(registration.externalObjectKey).toBeUndefined();
                            assert.ok(registration.expiresAt);
                            expect(Date.parse(registration.expiresAt) - Date.parse(registration.createdAt)).toBe(TEMPORARY_MEDIA_TTL_MS);
                            const original = await references.readReferenceAsset(registration.storageKey);
                            assert.ok(original);
                            expect(await readFile(original.filePath)).toEqual(current.bytes);
                        }),
                    );
                    if (provider === "file") expect((await registrations.listFileLocalMediaRegistrations()).filter((registration) => !orphanKeySet.has(registration.storageKey))).toStrictEqual(allFileRegistrations);
                    const priorPaths = new Set(priorFiles.map((file) => file.path));
                    const orphanFiles = afterFiles.filter((file) => !priorPaths.has(file.path));
                    expect(orphanFiles.map((file) => file.path).toSorted()).toStrictEqual(orphanRegistrations.map((registration) => path.relative(directory, path.join(REFERENCE_MEDIA_ROOT, registration.storageKey))).toSorted());
                    expect(orphanFiles.map((file) => ({ bytes: file.bytes.length, sha256: digest(file.bytes) }))).toStrictEqual(orphanRegistrations.map(() => ({ bytes: current.bytes.length, sha256: digest(current.bytes) })));
                    const registryChanged = provider === "file" && orphanKeys.length === 1;
                    expect(afterFiles.filter((file) => priorPaths.has(file.path) && (!registryChanged || file.path !== "local-media-assets.json"))).toStrictEqual(priorFiles.filter((file) => !registryChanged || file.path !== "local-media-assets.json"));
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toStrictEqual(resultBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual({ ...fixture.buildBefore, resultPayload: changedResult });
                    expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                    expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                    expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                    expect(await readFile(fixture.nativePath)).toEqual(fixture.native);
                    expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(fixture.firstDebits);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                    console.info("Native scene final upload provenance fault inventory", {
                        temporaryOrphanRegistrations: orphanKeys.length,
                        temporaryOrphanFiles: orphanFiles.length,
                        closedFinalBytes: current.bytes.length,
                        closedFinalSha256: digest(current.bytes),
                    });
                } finally {
                    release.resolve();
                    await pending;
                }
            });
        }, 120_000);

        it("refuses native scene result completion after the original mask registration changes without closing or publishing", async () => {
            await withNativeScenePrefix(async (fixture) => {
                const current = await uploadClosedNativeSceneFinal(fixture);
                const maskBefore = await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey);
                assert.ok(maskBefore);
                expect(maskBefore).toStrictEqual(fixture.originalMaskRegistration);
                expect(maskBefore.taskId).toBe(fixture.buildBefore.id);
                expect(maskBefore.storageClass).toBe("temporary");
                expect(maskBefore.expiresAt).toBeTypeOf("string");
                const s0 = await ownedRows(fixture.conversation.id);
                const changedMask = { ...maskBefore, taskId: fixture.prepareBefore.id };
                await registrations.registerLocalMediaAsset(changedMask);
                expect(await registrations.getLocalMediaRegistration(maskBefore.storageKey)).toStrictEqual(changedMask);
                const s1 = await ownedRows(fixture.conversation.id);
                const { registrations: beforeRegistrations, files: beforeFiles, ...beforeOther } = s0;
                const { registrations: faultRegistrations, files: faultFiles, ...faultOther } = s1;
                expect(faultOther).toStrictEqual(beforeOther);
                expect(faultRegistrations).toStrictEqual(
                    beforeRegistrations.map((row) => {
                        const key = String("storageKey" in row ? row.storageKey : row.storage_key);
                        return key === maskBefore.storageKey ? (provider === "file" ? { ...row, taskId: fixture.prepareBefore.id } : { ...row, task_id: fixture.prepareBefore.id }) : row;
                    }),
                );
                expect(faultFiles.filter((file) => file.path !== "local-media-assets.json")).toStrictEqual(beforeFiles.filter((file) => file.path !== "local-media-assets.json"));
                if (provider === "file") {
                    const beforeRegistryFile = beforeFiles.find((file) => file.path === "local-media-assets.json");
                    const faultRegistryFile = faultFiles.find((file) => file.path === "local-media-assets.json");
                    assert.ok(beforeRegistryFile && faultRegistryFile);
                    const beforeRegistry: { version: 1; assets: Awaited<ReturnType<typeof registrations.listFileLocalMediaRegistrations>> } = JSON.parse(beforeRegistryFile.bytes.toString("utf8"));
                    const faultRegistry: typeof beforeRegistry = JSON.parse(faultRegistryFile.bytes.toString("utf8"));
                    expect(faultRegistry).toStrictEqual({ ...beforeRegistry, assets: [changedMask, ...beforeRegistry.assets.filter((registration) => registration.storageKey !== maskBefore.storageKey)] });
                }
                const completeRoute = await import("@/app/api/maintenance/image-processing/[id]/complete/route");
                const refused = await completeRoute.POST(
                    new Request(`${fixture.imageOrigin}/api/maintenance/image-processing/${current.child.id}/complete`, {
                        method: "POST",
                        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                        body: JSON.stringify(current.completion),
                    }),
                    { params: Promise.resolve({ id: current.child.id }) },
                );
                expect(refused.status).toBe(409);
                expect(await refused.json()).toStrictEqual({ code: 409, data: null, msg: "场景保护蒙版登记已变化或失效" });
                expect(await ownedRows(fixture.conversation.id)).toStrictEqual(s1);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toStrictEqual(current.staged);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                expect(await registrations.getLocalMediaRegistration(maskBefore.storageKey)).toStrictEqual(changedMask);
                expect(await registrations.getLocalMediaRegistration(current.stored.storageKey)).toStrictEqual(current.finalRegistration);
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                expect(await readFile(fixture.nativePath)).toEqual(fixture.native);
                expect(await readFile(current.finalPath)).toEqual(current.bytes);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(fixture.firstDebits);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
            });
        }, 120_000);

        it("refuses native scene result consumption after the original receipt changes without retaining or publishing either protected artifact", async () => {
            await withNativeScenePrefix(async (fixture) => {
                const current = await uploadClosedNativeSceneFinal(fixture);
                const completeRoute = await import("@/app/api/maintenance/image-processing/[id]/complete/route");
                const completionBody = JSON.stringify(current.completion);
                const posted: CompleteImageProcessingInput = JSON.parse(completionBody);
                const completed = await completeRoute.POST(
                    new Request(`${fixture.imageOrigin}/api/maintenance/image-processing/${current.child.id}/complete`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: completionBody }),
                    { params: Promise.resolve({ id: current.child.id }) },
                );
                expect(completed.status).toBe(200);
                const receipt: { code: number; data: Awaited<ReturnType<typeof service.completeImageProcessingTask>>; msg: string } = await completed.json();
                expect(receipt).toStrictEqual({ code: 0, data: { jobId: current.child.id, inputDigest: current.child.payload.inputDigest, executionId: current.identity.executionId, manifest: posted.manifest, parentRescheduled: true }, msg: "OK" });
                const completedStage = await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id);
                assert.ok(completedStage);
                expect(completedStage).toMatchObject({ status: "success", executionPhase: "completed" });
                expect(completedStage.workerId).toBeUndefined();
                expect(completedStage.leaseUntil).toBeUndefined();
                expect(completedStage.resultPayload).toStrictEqual({
                    executionId: current.identity.executionId,
                    workerId: current.identity.workerId,
                    manifest: posted.manifest,
                    manifestDigest: service.imageProcessingManifestDigest(posted.manifest),
                    metrics: posted.metrics,
                    parentRescheduled: true,
                });
                const workerId = "fixture-native-scene-provenance-consumer";
                const claims = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [fixture.first.taskId], limit: 1 });
                expect(claims).toHaveLength(1);
                const claim = claims[0];
                assert.ok(claim && typeof claim.payload.executionId === "string");
                expect(claim.id).toBe(fixture.first.taskId);
                expect(claim.workerId).toBe(workerId);
                expect(claim.payload.executionId).not.toBe(fixture.imageClaim.executionId);
                const consumerIdentity = { taskId: fixture.first.taskId, workerId, executionId: claim.payload.executionId };
                expect(await processing.ensureImageTaskResultProcessing(consumerIdentity)).toStrictEqual({ state: "ready" });
                const claimedImage = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                assert.ok(claimedImage?.leaseUntil);
                expect(claimedImage).toMatchObject({ status: "running", workerId, payload: { executionId: consumerIdentity.executionId, resultProcessing: { jobId: current.child.id, inputDigest: current.child.payload.inputDigest } } });
                expect(claimedImage.leaseUntil).toBeGreaterThan(Date.now());
                expect(claimedImage.payload.result).toBeUndefined();
                const maskBefore = await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey);
                assert.ok(maskBefore);
                expect(maskBefore).toStrictEqual(fixture.originalMaskRegistration);
                expect(maskBefore.storageClass).toBe("temporary");
                expect(maskBefore.expiresAt).toBeTypeOf("string");
                expect(await registrations.getLocalMediaRegistration(current.stored.storageKey)).toStrictEqual(current.finalRegistration);
                expect(current.finalRegistration.storageClass).toBe("temporary");
                const runBefore = await runs.getAgentRun(fixture.paused.id);
                assert.ok(runBefore?.executionId && runBefore.ecommerceSnapshot?.processing?.sceneSelection);
                const snapshot = runBefore.ecommerceSnapshot;
                const processingBefore = snapshot.processing;
                assert.ok(processingBefore?.sceneSelection);
                const receiptBefore = processingBefore.sceneSelection;
                expect(receiptBefore).toStrictEqual(fixture.receipt);
                const s0 = await ownedRows(fixture.conversation.id);
                const changedReceipt = { ...receiptBefore, confirmation: { ...receiptBefore.confirmation, confirmedAt: receiptBefore.confirmation.confirmedAt + 1 } };
                const expectedSnapshot = { ...snapshot, processing: { ...processingBefore, sceneSelection: changedReceipt } };
                const changed = await runs.updateAgentRunById(runBefore.id, { ecommerceSnapshot: expectedSnapshot }, undefined, ["running"], runBefore.executionId);
                assert.ok(changed);
                const runAfterFault = await runs.getAgentRun(runBefore.id);
                assert.ok(runAfterFault);
                expect(runAfterFault).toStrictEqual({ ...runBefore, ecommerceSnapshot: expectedSnapshot, updatedAt: runAfterFault.updatedAt });
                const s1 = await ownedRows(fixture.conversation.id);
                const { rows: beforeRows, files: beforeFiles, ...beforeOther } = s0;
                const { rows: faultRows, files: faultFiles, ...faultOther } = s1;
                const originalRunRow = beforeRows.find((row) => row.id === runBefore.id);
                assert.ok(originalRunRow && originalRunRow.payload && typeof originalRunRow.payload === "object");
                const expectedRunPayload = { ...originalRunRow.payload, ecommerceSnapshot: expectedSnapshot, updatedAt: runAfterFault.updatedAt };
                expect(faultRows.find((row) => row.id === runBefore.id)).toStrictEqual(
                    provider === "file"
                        ? { ...originalRunRow, payload: expectedRunPayload, updatedAt: runAfterFault.updatedAt, expiresAt: runAfterFault.updatedAt + runs.AGENT_RUN_TTL_MS }
                        : { ...originalRunRow, payload: expectedRunPayload, updated_at: new Date(runAfterFault.updatedAt), expires_at: new Date(runAfterFault.updatedAt + runs.AGENT_RUN_TTL_MS) },
                );
                expect(faultRows.filter((row) => row.id !== runBefore.id)).toStrictEqual(beforeRows.filter((row) => row.id !== runBefore.id));
                expect(faultOther).toStrictEqual(beforeOther);
                expect(faultFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE)).toStrictEqual(beforeFiles.filter((file) => file.path !== tasks.GENERATION_TASK_FILE));
                const refused = processing.consumeCompletedImageTaskResultProcessing(consumerIdentity);
                await expect(refused).rejects.toBeInstanceOf(service.ImageProcessingInputError);
                await expect(refused).rejects.toMatchObject({ status: 409, message: "原生场景结果与当前确认和build不一致" });
                expect(await ownedRows(fixture.conversation.id)).toStrictEqual(s1);
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId)).toStrictEqual(claimedImage);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toStrictEqual(completedStage);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                expect(await registrations.getLocalMediaRegistration(maskBefore.storageKey)).toStrictEqual(maskBefore);
                expect(await registrations.getLocalMediaRegistration(current.stored.storageKey)).toStrictEqual(current.finalRegistration);
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                expect(await readFile(fixture.nativePath)).toEqual(fixture.native);
                expect(await readFile(current.finalPath)).toEqual(current.bytes);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(fixture.firstDebits);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
            });
        }, 120_000);

        if (provider === "postgres") {
            it("refuses native scene result consumption after the original mask registration changes across its real PostgreSQL registry lock", async () => {
                await withNativeScenePrefix(async (fixture) => {
                    const current = await uploadClosedNativeSceneFinal(fixture);
                    const completeRoute = await import("@/app/api/maintenance/image-processing/[id]/complete/route");
                    const completionBody = JSON.stringify(current.completion);
                    const posted: CompleteImageProcessingInput = JSON.parse(completionBody);
                    const completed = await completeRoute.POST(
                        new Request(`${fixture.imageOrigin}/api/maintenance/image-processing/${current.child.id}/complete`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: completionBody }),
                        { params: Promise.resolve({ id: current.child.id }) },
                    );
                    expect(completed.status).toBe(200);
                    const receipt: { code: number; data: Awaited<ReturnType<typeof service.completeImageProcessingTask>>; msg: string } = await completed.json();
                    expect(receipt).toStrictEqual({ code: 0, data: { jobId: current.child.id, inputDigest: current.child.payload.inputDigest, executionId: current.identity.executionId, manifest: posted.manifest, parentRescheduled: true }, msg: "OK" });
                    const completedStage = await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id);
                    assert.ok(completedStage);
                    expect(completedStage).toMatchObject({ status: "success", executionPhase: "completed" });
                    expect(completedStage.resultPayload).toStrictEqual({
                        executionId: current.identity.executionId,
                        workerId: current.identity.workerId,
                        manifest: posted.manifest,
                        manifestDigest: service.imageProcessingManifestDigest(posted.manifest),
                        metrics: posted.metrics,
                        parentRescheduled: true,
                    });
                    const workerId = "fixture-native-scene-mask-lock-consumer";
                    const claims = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [fixture.first.taskId], limit: 1 });
                    expect(claims).toHaveLength(1);
                    const claim = claims[0];
                    assert.ok(claim && typeof claim.payload.executionId === "string");
                    expect(claim.id).toBe(fixture.first.taskId);
                    expect(claim.workerId).toBe(workerId);
                    expect(claim.payload.executionId).not.toBe(fixture.imageClaim.executionId);
                    const identity = { taskId: fixture.first.taskId, workerId, executionId: claim.payload.executionId };
                    expect(await processing.ensureImageTaskResultProcessing(identity)).toStrictEqual({ state: "ready" });
                    const claimedImage = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                    assert.ok(claimedImage?.leaseUntil);
                    expect(claimedImage).toMatchObject({ status: "running", workerId, payload: { executionId: identity.executionId, resultProcessing: { jobId: current.child.id, inputDigest: current.child.payload.inputDigest } } });
                    expect(claimedImage.leaseUntil).toBeGreaterThan(Date.now());
                    expect(claimedImage.payload.result).toBeUndefined();
                    const maskBefore = await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey);
                    assert.ok(maskBefore);
                    expect(maskBefore).toStrictEqual(fixture.originalMaskRegistration);
                    expect(maskBefore.storageClass).toBe("temporary");
                    expect(maskBefore.expiresAt).toBeTypeOf("string");
                    expect(current.finalRegistration.storageClass).toBe("temporary");
                    expect(current.finalRegistration.expiresAt).toBeTypeOf("string");
                    expect(await registrations.getLocalMediaRegistration(current.stored.storageKey)).toStrictEqual(current.finalRegistration);
                    const before = await ownedRows(fixture.conversation.id);
                    const originalMaskRow = before.registrations.find((row) => "storage_key" in row && row.storage_key === maskBefore.storageKey);
                    assert.ok(originalMaskRow);
                    const application = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                    const appPid = application.rows[0]?.pid;
                    assert.ok(appPid);
                    const { Client } = await import("pg");
                    const controller = new Client({ connectionString: database.getPostgresConnectionString() });
                    type ConsumerResult = Awaited<ReturnType<typeof processing.consumeCompletedImageTaskResultProcessing>>;
                    let pending: Promise<PromiseSettledResult<ConsumerResult>> | undefined;
                    let hasSettled = false;
                    let transactionOpen = false;
                    let s1: Awaited<ReturnType<typeof nativeSceneControllerRows>> | undefined;
                    try {
                        await controller.connect();
                        const backend = await controller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                        const controllerPid = backend.rows[0]?.pid;
                        assert.ok(controllerPid);
                        expect(controllerPid).not.toBe(appPid);
                        await controller.query("BEGIN ISOLATION LEVEL READ COMMITTED");
                        transactionOpen = true;
                        const locked = await controller.query<SqlRow>("SELECT * FROM vozeb_pro_local_media_assets WHERE storage_key=$1 AND owner_user_id=$2 AND task_id=$3 AND run_id=$4 FOR UPDATE", [
                            maskBefore.storageKey,
                            userId,
                            fixture.buildBefore.id,
                            fixture.paused.id,
                        ]);
                        expect(locked.rows).toStrictEqual([originalMaskRow]);
                        pending = processing.consumeCompletedImageTaskResultProcessing(identity).then(
                            (value): PromiseSettledResult<ConsumerResult> => {
                                hasSettled = true;
                                return { status: "fulfilled", value };
                            },
                            (reason: unknown): PromiseSettledResult<ConsumerResult> => {
                                hasSettled = true;
                                return { status: "rejected", reason };
                            },
                        );
                        const barrier = await waitForNativeSceneRegistryBarrier(controller, appPid, controllerPid, identity, () => hasSettled);
                        expect(barrier).toMatchObject({ lockWait: true, controllerBlocks: true, registryQuery: true, leaseAlive: true });
                        const s0 = await nativeSceneControllerRows(controller, fixture.conversation.id);
                        expect(s0).toStrictEqual(before);
                        expect(hasSettled).toBe(false);
                        const changedMaskRow = { ...originalMaskRow, task_id: fixture.prepareBefore.id };
                        const changed = await controller.query<SqlRow>(
                            "UPDATE vozeb_pro_local_media_assets SET task_id=$4 WHERE storage_key=$1 AND owner_user_id=$2 AND task_id=$3 AND run_id=$5 AND source='image-processing-mask' AND scope='reference' AND type='image' AND storage_class='temporary' RETURNING *",
                            [maskBefore.storageKey, userId, fixture.buildBefore.id, fixture.prepareBefore.id, fixture.paused.id],
                        );
                        expect(changed.rows).toStrictEqual([changedMaskRow]);
                        s1 = await nativeSceneControllerRows(controller, fixture.conversation.id);
                        expect(s1).toStrictEqual({ ...s0, registrations: s0.registrations.map((row) => (row.storage_key === maskBefore.storageKey ? { ...row, task_id: fixture.prepareBefore.id } : row)) });
                        const beforeCommit = await waitForNativeSceneRegistryBarrier(controller, appPid, controllerPid, identity, () => hasSettled);
                        expect(beforeCommit).toMatchObject({ lockWait: true, controllerBlocks: true, registryQuery: true, leaseAlive: true });
                        await controller.query("COMMIT");
                        transactionOpen = false;
                        await drainLiveRequests(pending, "Native scene mask-lock consumer did not drain after controller commit");
                        const settled = await pending;
                        assert.ok(settled.status === "rejected");
                        expect(settled.reason).toBeInstanceOf(service.ImageProcessingInputError);
                        expect(settled.reason).toMatchObject({ status: 409, message: "场景保护蒙版登记已变化或失效" });
                        console.info("Native scene consumer original mask registry lock barrier", {
                            appPid,
                            controllerPid,
                            barrier,
                            beforeCommit,
                            fault: "original mask task_id build -> existing prepare",
                            outcome: { status: 409, message: "场景保护蒙版登记已变化或失效" },
                        });
                    } finally {
                        try {
                            if (transactionOpen) await controller.query("ROLLBACK");
                        } finally {
                            try {
                                if (pending) await drainLiveRequests(pending, "Native scene mask-lock consumer cleanup did not drain after controller release");
                            } finally {
                                await controller.end();
                            }
                        }
                    }
                    assert.ok(s1);
                    expect(await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId)).toStrictEqual(claimedImage);
                    expect(await ownedRows(fixture.conversation.id)).toStrictEqual(s1);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toStrictEqual(completedStage);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
                    expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                    expect(await registrations.getLocalMediaRegistration(maskBefore.storageKey)).toStrictEqual({ ...maskBefore, taskId: fixture.prepareBefore.id });
                    expect(await registrations.getLocalMediaRegistration(current.stored.storageKey)).toStrictEqual(current.finalRegistration);
                    const unpublished = await imageTasks.getImageTask(fixture.first.taskId);
                    assert.ok(unpublished);
                    expect(unpublished.status).toBe("running");
                    expect(unpublished.result).toBeUndefined();
                    expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                    expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                    expect(await readFile(fixture.nativePath)).toEqual(fixture.native);
                    expect(await readFile(current.finalPath)).toEqual(current.bytes);
                    expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(fixture.firstDebits);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                });
            }, 120_000);
        }

        if (provider === "postgres") {
            it("recovers the same native scene PostgreSQL ImageTask after real mask review through the authenticated user POST", async () => {
                await withNativeSceneLifecyclePrefix(async (fixture) => {
                    const settings = await auth.getFreshAuthSettings();
                    expect(settings.entitlements.enabled).toBe(false);
                    expect(settings.generationCostControl).toStrictEqual({ maxPointsPerTask: 0, dailyUserPointSpend: 0, dailyTotalPointSpend: 0 });
                    const wallet = await import("./points-wallet-service");
                    expect(await wallet.getPointsWalletSnapshot(userId)).toMatchObject({ permanentPoints: 100, dailyPoints: 0 });
                    const before = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
                    assert.ok(before.account);
                    const changed = Buffer.from(fixture.built.bytes);
                    changed[changed.length - 1] ^= 1;
                    expect(changed.length).toBe(fixture.built.bytes.length);
                    expect(digest(changed)).not.toBe(digest(fixture.built.bytes));
                    try {
                        await writeFile(fixture.registeredMask.filePath, changed);
                        expect(await readFile(fixture.registeredMask.filePath)).toEqual(changed);
                        expect(
                            await recovery.runGenerationTaskRecoveryBatch({ origin: fixture.imageOrigin, publicOrigin: fixture.imageOrigin, cookie: boundary.cookie, workerId: "fixture-native-pg-mask-review", limit: 1, taskIds: [fixture.first.taskId] }),
                        ).toMatchObject({ claimed: 1, pending: 0, needsReview: 1, failed: 0, completed: 0 });
                    } finally {
                        await writeFile(fixture.registeredMask.filePath, fixture.built.bytes);
                    }
                    const review = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                    const reviewedImage = await imageTasks.getImageTask(fixture.first.taskId);
                    assert.ok(review && reviewedImage);
                    expect(review).toMatchObject({
                        status: "running",
                        executionPhase: "needs_review",
                        lastUpstreamStatus: "scene_mask_review_required:参考图片内容已变化，请重新提供原图。",
                        resultPayload: { reviewReason: "参考图片内容已变化，请重新提供原图。" },
                    });
                    expect({ worker: review.workerId, lease: review.leaseUntil, due: review.nextPollAt, submitted: review.submittedAt, upstream: review.upstreamTaskId }).toStrictEqual({
                        worker: undefined,
                        lease: undefined,
                        due: undefined,
                        submitted: undefined,
                        upstream: undefined,
                    });
                    expect(reviewedImage).toMatchObject({
                        id: fixture.first.taskId,
                        runId: fixture.paused.id,
                        clientRequestId: fixture.first.requestId,
                        referenceDispatch: fixture.firstBefore.referenceDispatch,
                        mask: fixture.task.sceneProtection?.mask,
                        sceneProtection: fixture.task.sceneProtection,
                    });
                    expect({
                        attempts: reviewedImage.attempts,
                        billing: reviewedImage.billing,
                        upstream: reviewedImage.upstream,
                        result: reviewedImage.result,
                        acquisition: reviewedImage.nativeAcquisition,
                        native: reviewedImage.nativeResults,
                        processing: reviewedImage.resultProcessing,
                    }).toStrictEqual({ attempts: undefined, billing: undefined, upstream: undefined, result: undefined, acquisition: undefined, native: undefined, processing: undefined });
                    expect(boundary.create).not.toHaveBeenCalled();
                    expect(boundary.poll).not.toHaveBeenCalled();
                    const uncharged = await expectNativeSceneLifecycleBindings(fixture, before, 100);
                    expect(uncharged.account).toStrictEqual(before.account);
                    expect(uncharged.logs).toStrictEqual(before.logs);
                    const response = await fetch(`${fixture.imageOrigin}/api/image-tasks/${fixture.first.taskId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) });
                    expect(response.status, await response.clone().text()).toBe(200);
                    expect(await response.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "running", executionPhase: "polling", needsReview: false } });
                    const submitted = await imageTasks.getImageTask(fixture.first.taskId);
                    const schedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                    const charge = charges.get(fixture.first.taskId);
                    assert.ok(submitted && schedule && charge);
                    expect(charge).toMatchObject({ cost: 2, idempotencyKey: "fixture-run-copy:" + fixture.first.taskId });
                    expect(submitted).toMatchObject({
                        id: fixture.first.taskId,
                        runId: fixture.paused.id,
                        clientRequestId: fixture.first.requestId,
                        referenceDispatch: fixture.firstBefore.referenceDispatch,
                        attemptNo: 1,
                        upstream: { id: "fixture-upstream-" + fixture.first.taskId },
                        billing: { pointsCost: 2, pointsRecordId: charge.recordId, refunded: false },
                        ecommerceCanvasRequest: { size: "1024x1024" },
                        mask: fixture.task.sceneProtection?.mask,
                        sceneProtection: fixture.task.sceneProtection,
                    });
                    expect(submitted.attempts).toMatchObject([{ attemptNo: 1, status: "running" }]);
                    expect(schedule).toMatchObject({ executionPhase: "polling", upstreamTaskId: "fixture-upstream-" + fixture.first.taskId });
                    expect(schedule.workerId).toBeUndefined();
                    expect(schedule.leaseUntil).toBeUndefined();
                    expect(schedule.payload.executionId).toBe(submitted.executionId);
                    expect(submitted.executionId).not.toBe(reviewedImage.executionId);
                    const after = await expectNativeSceneLifecycleBindings(fixture, before, 98);
                    assert.ok(after.account);
                    expect(after.logs).toStrictEqual(before.logs);
                    expect(after.account.pointRecords).toHaveLength(before.account.pointRecords.length + 1);
                    const debit = after.account.pointRecords.find((row) => row.id === charge.recordId);
                    expect(debit).toMatchObject({ user_id: userId, type: "consume", idempotency_key: "fixture-run-copy:" + fixture.first.taskId, model: imageModelId });
                    assert.ok(debit);
                    expect(Number(debit.amount)).toBe(-2);
                    expect(Number(debit.permanent_amount)).toBe(-2);
                    expect(Number(debit.daily_amount)).toBe(0);
                    expect(Number(debit.balance_after)).toBe(98);
                    expect(boundary.create).toHaveBeenCalledOnce();
                    expect(boundary.poll).not.toHaveBeenCalled();
                });
            }, 120_000);

            it("terminates the same native scene PostgreSQL ImageTask after exactly two queried upstream failures and source-linked refunds", async () => {
                await withNativeSceneLifecyclePrefix(async (fixture) => {
                    const settings = await auth.getFreshAuthSettings();
                    expect(settings.entitlements.enabled).toBe(false);
                    expect(settings.generationCostControl).toStrictEqual({ maxPointsPerTask: 0, dailyUserPointSpend: 0, dailyTotalPointSpend: 0 });
                    const wallet = await import("./points-wallet-service");
                    const walletBefore = await wallet.getPointsWalletSnapshot(userId);
                    expect(walletBefore).toMatchObject({ permanentPoints: 100, dailyPoints: 0 });
                    const before = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
                    assert.ok(before.account);
                    const actual = imageTaskSupportActual.module;
                    assert.ok(actual, "SETUP: the support mock factory must retain the actual parser module it exports");
                    const submittedCharges: Array<Awaited<ReturnType<typeof auth.consumeUserPoints>>> = [];
                    boundary.poll.mockImplementation(actual.pollOpenAiImageTask);
                    await withNativeSceneTerminalQueries(async (queryOrigin, queries) => {
                        boundary.create.mockImplementation(async (submission: ImageTask, origin: string, _publicOrigin: string, cookie: string): Promise<ImageTaskRunResult> => {
                            expect(submission.id).toBe(fixture.first.taskId);
                            expect([1, 2]).toContain(submission.attemptNo);
                            expect(submission.config.baseUrl.startsWith("/")).toBe(true);
                            expect(cookie).toBe(boundary.cookie);
                            const { recordEcommerceCanvasRequest, resolveCanvasRequestSize } = await import("@/app/api/image-tasks/image-task-size");
                            const quality = actual.normalizeQuality(submission.config.quality || "");
                            const form = await actual.buildImageEditFormData(submission, quality, resolveCanvasRequestSize(submission, quality), origin, cookie, "url", false);
                            expect(form.get("size")).toBe("1024x1024");
                            expect(form.getAll("image")).toHaveLength(1);
                            expect(form.get("mask")).toBeInstanceOf(File);
                            await recordEcommerceCanvasRequest(submission, { size: String(form.get("size") || "") }, "OpenAI multipart");
                            const charge = await auth.consumeUserPoints(userId, imageModelId, 1, "image", actual.imagePointsIdempotencyKey(submission));
                            submittedCharges.push(charge);
                            return {
                                dataUrl: "",
                                pending: { id: "native-lifecycle-upstream-" + submission.attemptNo, mediaBaseUrl: queryOrigin, pollBaseUrl: queryOrigin, explicitPollUrl: queryOrigin + "/native-lifecycle/attempt-" + submission.attemptNo },
                                pointsCost: charge.cost,
                                pointsRecordId: charge.recordId,
                                pointsRemaining: charge.remaining,
                            };
                        });
                        expect(
                            await recovery.runGenerationTaskRecoveryBatch({ origin: fixture.imageOrigin, publicOrigin: fixture.imageOrigin, cookie: boundary.cookie, workerId: "fixture-native-pg-attempt-one", limit: 1, taskIds: [fixture.first.taskId] }),
                        ).toMatchObject({ claimed: 1, pending: 1, needsReview: 0, failed: 0 });
                        expect(submittedCharges).toHaveLength(1);
                        const firstCharge = submittedCharges[0];
                        assert.ok(firstCharge);
                        expect(firstCharge).toMatchObject({ cost: 2, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:1" });
                        const first = await imageTasks.getImageTask(fixture.first.taskId);
                        const firstSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                        assert.ok(first && firstSchedule);
                        expect(first).toMatchObject({
                            id: fixture.first.taskId,
                            attemptNo: 1,
                            upstream: { id: "native-lifecycle-upstream-1", explicitPollUrl: queryOrigin + "/native-lifecycle/attempt-1" },
                            billing: { pointsCost: 2, pointsRecordId: firstCharge.recordId, refunded: false },
                        });
                        expect(first.attempts).toMatchObject([{ attemptNo: 1, status: "running" }]);
                        expect(firstSchedule).toMatchObject({ executionPhase: "polling", upstreamTaskId: "native-lifecycle-upstream-1" });
                        expect(firstSchedule.workerId).toBeUndefined();
                        expect(firstSchedule.leaseUntil).toBeUndefined();
                        const chargedOnce = await expectNativeSceneLifecycleBindings(fixture, before, 98);
                        assert.ok(chargedOnce.account);
                        expect(chargedOnce.logs).toStrictEqual(before.logs);
                        expect(chargedOnce.account.pointRecords).toHaveLength(before.account.pointRecords.length + 1);
                        const firstDebit = chargedOnce.account.pointRecords.find((row) => row.id === firstCharge.recordId);
                        assert.ok(firstDebit);
                        expect(firstDebit).toMatchObject({ user_id: userId, model: imageModelId, type: "consume", idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:1" });
                        expect(Number(firstDebit.amount)).toBe(-2);
                        expect(Number(firstDebit.permanent_amount)).toBe(-2);
                        expect(Number(firstDebit.daily_amount)).toBe(0);
                        expect(Number(firstDebit.balance_after)).toBe(98);
                        expect(queries).toStrictEqual([]);
                        expect(boundary.create).toHaveBeenCalledOnce();
                        expect(boundary.poll).not.toHaveBeenCalled();
                        const firstFailure = await fetch(`${fixture.imageOrigin}/api/image-tasks/${fixture.first.taskId}`, {
                            method: "POST",
                            headers: { cookie: boundary.cookie, "content-type": "application/json" },
                            body: JSON.stringify({ action: "recover" }),
                        });
                        expect(firstFailure.status, await firstFailure.clone().text()).toBe(200);
                        expect(await firstFailure.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "running", executionPhase: "created", needsReview: false } });
                        expect(queries).toStrictEqual(["/native-lifecycle/attempt-1"]);
                        const rearmed = await imageTasks.getImageTask(fixture.first.taskId);
                        const retrySchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                        assert.ok(rearmed && retrySchedule);
                        expect(rearmed).toMatchObject({
                            id: fixture.first.taskId,
                            runId: fixture.paused.id,
                            clientRequestId: fixture.first.requestId,
                            referenceDispatch: fixture.firstBefore.referenceDispatch,
                            attemptNo: 1,
                            status: "running",
                            retryable: false,
                            candidateConfigs: [],
                            mask: fixture.task.sceneProtection?.mask,
                            sceneProtection: fixture.task.sceneProtection,
                        });
                        expect(rearmed.attempts).toMatchObject([{ attemptNo: 1, status: "failed", error: "native lifecycle upstream one failed", pointsCost: 2, pointsRecordId: firstCharge.recordId }]);
                        expect(rearmed.attempts?.[0].completedAt).toBeGreaterThan(0);
                        expect({ upstream: rearmed.upstream, billing: rearmed.billing, result: rearmed.result, acquisition: rearmed.nativeAcquisition, native: rearmed.nativeResults, processing: rearmed.resultProcessing }).toStrictEqual({
                            upstream: undefined,
                            billing: undefined,
                            result: undefined,
                            acquisition: undefined,
                            native: undefined,
                            processing: undefined,
                        });
                        expect(retrySchedule).toMatchObject({ executionPhase: "created", lastUpstreamStatus: "automatic_retry_after_upstream_failure" });
                        expect({
                            worker: retrySchedule.workerId,
                            lease: retrySchedule.leaseUntil,
                            submitted: retrySchedule.submittedAt,
                            upstream: retrySchedule.upstreamTaskId,
                            query: retrySchedule.queryPath,
                            result: retrySchedule.resultPayload,
                        }).toStrictEqual({ worker: undefined, lease: undefined, submitted: undefined, upstream: undefined, query: undefined, result: {} });
                        expect(retrySchedule.nextPollAt).toBeGreaterThan(0);
                        expect(retrySchedule.nextPollAt).toBeLessThanOrEqual(Date.now());
                        const refundedOnce = await expectNativeSceneLifecycleBindings(fixture, before, 100);
                        assert.ok(refundedOnce.account);
                        expect(refundedOnce.logs).toStrictEqual(before.logs);
                        expect(refundedOnce.account.pointRecords).toHaveLength(before.account.pointRecords.length + 2);
                        expect(refundedOnce.account.pointRecords.find((row) => row.id === firstCharge.recordId)).toStrictEqual(firstDebit);
                        const firstRefund = refundedOnce.account.pointRecords.find((row) => row.source_record_id === firstCharge.recordId);
                        assert.ok(firstRefund);
                        expect(firstRefund).toMatchObject({
                            user_id: userId,
                            model: imageModelId,
                            type: "refund",
                            idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:1:refund",
                            source_record_id: firstCharge.recordId,
                            source_date: firstDebit.source_date,
                        });
                        expect(Number(firstRefund.amount)).toBe(2);
                        expect(Number(firstRefund.permanent_amount)).toBe(2);
                        expect(Number(firstRefund.daily_amount)).toBe(0);
                        expect(Number(firstRefund.balance_after)).toBe(100);
                        expect(await wallet.getPointsWalletSnapshot(userId)).toStrictEqual(walletBefore);
                        expect(boundary.create).toHaveBeenCalledOnce();
                        expect(boundary.poll).toHaveBeenCalledOnce();
                        expect(
                            await recovery.runGenerationTaskRecoveryBatch({ origin: fixture.imageOrigin, publicOrigin: fixture.imageOrigin, cookie: boundary.cookie, workerId: "fixture-native-pg-attempt-two", limit: 1, taskIds: [fixture.first.taskId] }),
                        ).toMatchObject({ claimed: 1, pending: 1, needsReview: 0, failed: 0 });
                        expect(submittedCharges).toHaveLength(2);
                        const secondCharge = submittedCharges[1];
                        assert.ok(secondCharge);
                        expect(secondCharge.recordId).not.toBe(firstCharge.recordId);
                        expect(secondCharge).toMatchObject({ cost: 2, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:2" });
                        const second = await imageTasks.getImageTask(fixture.first.taskId);
                        const secondSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                        assert.ok(second && secondSchedule);
                        expect(second).toMatchObject({
                            id: fixture.first.taskId,
                            runId: fixture.paused.id,
                            clientRequestId: fixture.first.requestId,
                            referenceDispatch: fixture.firstBefore.referenceDispatch,
                            attemptNo: 2,
                            upstream: { id: "native-lifecycle-upstream-2", explicitPollUrl: queryOrigin + "/native-lifecycle/attempt-2" },
                            billing: { pointsCost: 2, pointsRecordId: secondCharge.recordId, refunded: false },
                            mask: fixture.task.sceneProtection?.mask,
                            sceneProtection: fixture.task.sceneProtection,
                        });
                        expect(second.attempts).toMatchObject([
                            { attemptNo: 1, status: "failed" },
                            { attemptNo: 2, status: "running" },
                        ]);
                        expect(second.attempts?.[0]).toStrictEqual(rearmed.attempts?.[0]);
                        expect(secondSchedule).toMatchObject({ executionPhase: "polling", upstreamTaskId: "native-lifecycle-upstream-2", queryPath: queryOrigin + "/native-lifecycle/attempt-2" });
                        expect(second.executionId).not.toBe(rearmed.executionId);
                        expect(secondSchedule.workerId).toBeUndefined();
                        expect(secondSchedule.leaseUntil).toBeUndefined();
                        const chargedTwice = await expectNativeSceneLifecycleBindings(fixture, before, 98);
                        assert.ok(chargedTwice.account);
                        expect(chargedTwice.logs).toStrictEqual(before.logs);
                        expect(chargedTwice.account.pointRecords).toHaveLength(before.account.pointRecords.length + 3);
                        expect(chargedTwice.account.pointRecords.find((row) => row.id === firstCharge.recordId)).toStrictEqual(firstDebit);
                        expect(chargedTwice.account.pointRecords.find((row) => row.id === firstRefund.id)).toStrictEqual(firstRefund);
                        const secondDebit = chargedTwice.account.pointRecords.find((row) => row.id === secondCharge.recordId);
                        assert.ok(secondDebit);
                        expect(secondDebit).toMatchObject({ user_id: userId, model: imageModelId, type: "consume", idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:2" });
                        expect(Number(secondDebit.amount)).toBe(-2);
                        expect(Number(secondDebit.permanent_amount)).toBe(-2);
                        expect(Number(secondDebit.daily_amount)).toBe(0);
                        expect(Number(secondDebit.balance_after)).toBe(98);
                        expect(queries).toStrictEqual(["/native-lifecycle/attempt-1"]);
                        expect(boundary.create).toHaveBeenCalledTimes(2);
                        expect(boundary.poll).toHaveBeenCalledOnce();
                        const secondFailure = await fetch(`${fixture.imageOrigin}/api/image-tasks/${fixture.first.taskId}`, {
                            method: "POST",
                            headers: { cookie: boundary.cookie, "content-type": "application/json" },
                            body: JSON.stringify({ action: "recover" }),
                        });
                        expect(secondFailure.status, await secondFailure.clone().text()).toBe(200);
                        expect(await secondFailure.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "error", executionPhase: "completed" } });
                        const failed = await imageTasks.getImageTask(fixture.first.taskId);
                        const failedSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                        assert.ok(failed && failedSchedule);
                        expect(failed).toMatchObject({
                            id: fixture.first.taskId,
                            runId: fixture.paused.id,
                            clientRequestId: fixture.first.requestId,
                            referenceDispatch: fixture.firstBefore.referenceDispatch,
                            status: "error",
                            attemptNo: 2,
                            error: "native lifecycle upstream two failed",
                            billing: { pointsCost: 2, pointsRecordId: secondCharge.recordId, refunded: true },
                            mask: fixture.task.sceneProtection?.mask,
                            sceneProtection: fixture.task.sceneProtection,
                        });
                        expect(failed.attempts).toMatchObject([
                            { attemptNo: 1, status: "failed", pointsRecordId: firstCharge.recordId },
                            { attemptNo: 2, status: "failed", error: "native lifecycle upstream two failed", pointsRecordId: secondCharge.recordId },
                        ]);
                        expect(failed.attempts?.[0]).toStrictEqual(rearmed.attempts?.[0]);
                        expect(failed.attempts?.[1].completedAt).toBeGreaterThan(0);
                        expect(failedSchedule.executionPhase).toBe("completed");
                        expect({ due: failedSchedule.nextPollAt, worker: failedSchedule.workerId, lease: failedSchedule.leaseUntil }).toStrictEqual({ due: undefined, worker: undefined, lease: undefined });
                        expect(failed.nativeResults).toBeUndefined();
                        expect(failed.resultProcessing).toBeUndefined();
                        expect(failed.result).toBeUndefined();
                        const terminal = await expectNativeSceneLifecycleBindings(fixture, before, 100);
                        assert.ok(terminal.account);
                        expect(terminal.account.pointRecords).toHaveLength(before.account.pointRecords.length + 4);
                        expect(terminal.account.pointRecords.find((row) => row.id === firstCharge.recordId)).toStrictEqual(firstDebit);
                        expect(terminal.account.pointRecords.find((row) => row.id === firstRefund.id)).toStrictEqual(firstRefund);
                        expect(terminal.account.pointRecords.find((row) => row.id === secondCharge.recordId)).toStrictEqual(secondDebit);
                        const secondRefund = terminal.account.pointRecords.find((row) => row.source_record_id === secondCharge.recordId);
                        assert.ok(secondRefund);
                        expect(secondRefund).toMatchObject({
                            user_id: userId,
                            model: imageModelId,
                            type: "refund",
                            idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:2:refund",
                            source_record_id: secondCharge.recordId,
                            source_date: secondDebit.source_date,
                        });
                        expect(Number(secondRefund.amount)).toBe(2);
                        expect(Number(secondRefund.permanent_amount)).toBe(2);
                        expect(Number(secondRefund.daily_amount)).toBe(0);
                        expect(Number(secondRefund.balance_after)).toBe(100);
                        expect(await wallet.getPointsWalletSnapshot(userId)).toStrictEqual(walletBefore);
                        expect(fixture.firstBefore.generationLogId).toBeUndefined();
                        expect(terminal.logs.filter((row) => row.id !== "image-task:" + fixture.first.taskId)).toStrictEqual(before.logs);
                        expect(terminal.logs).toHaveLength(before.logs.length + 1);
                        expect(terminal.logs.find((row) => row.id === "image-task:" + fixture.first.taskId)).toMatchObject({
                            user_id: userId,
                            task_id: fixture.first.taskId,
                            status: "failed",
                            count: 1,
                            success_count: 0,
                            fail_count: 1,
                            error: "native lifecycle upstream two failed",
                        });
                        expect(
                            await recovery.runGenerationTaskRecoveryBatch({
                                origin: fixture.imageOrigin,
                                publicOrigin: fixture.imageOrigin,
                                cookie: boundary.cookie,
                                workerId: "fixture-native-pg-no-third-attempt",
                                limit: 1,
                                taskIds: [fixture.first.taskId],
                            }),
                        ).toMatchObject({ claimed: 0 });
                        const replay = await fetch(`${fixture.imageOrigin}/api/image-tasks/${fixture.first.taskId}`, {
                            method: "POST",
                            headers: { cookie: boundary.cookie, "content-type": "application/json" },
                            body: JSON.stringify({ action: "recover" }),
                        });
                        expect(replay.status).toBe(409);
                        expect(await replay.json()).toStrictEqual({ error: "当前图片任务无法继续检查" });
                        expect(await nativeSceneLifecyclePostgresRows(fixture.conversation.id)).toStrictEqual(terminal);
                        expect(queries).toStrictEqual(["/native-lifecycle/attempt-1", "/native-lifecycle/attempt-2"]);
                        expect(submittedCharges).toHaveLength(2);
                        expect(boundary.create).toHaveBeenCalledTimes(2);
                        expect(boundary.poll).toHaveBeenCalledTimes(2);
                    });
                });
            }, 120_000);
        }

        if (provider === "postgres") {
            const nativeSceneQuotaPrices: NativeSceneQuotaPrice[] = [
                { label: "paid2", pointsCost: 2, debitAmount: -2, chargedBalance: 98 },
                { label: "zero0", pointsCost: 0, debitAmount: 0, chargedBalance: 100 },
            ];

            it.each(nativeSceneQuotaPrices)(
                "counts enabled native image quota once through real result consumption and replay ($label)",
                async (price) => {
                    await withNativeSceneUserQuota(async (scope) => {
                        await withNativeSceneLifecyclePrefix(async (fixture) => {
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(scope.initial);
                            await installNativeSceneQuotaPrice(scope, price.pointsCost);
                            const before = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
                            const submittedCharges: Array<Awaited<ReturnType<typeof auth.consumeUserPoints>>> = [];
                            boundary.create.mockImplementation(async (submission: ImageTask, origin: string, _publicOrigin: string, cookie: string): Promise<ImageTaskRunResult> => {
                                expect(submission.id).toBe(fixture.first.taskId);
                                expect(submission.attemptNo).toBe(1);
                                const charge = await submitNativeSceneQuotaAttempt(submission, origin, cookie, price.pointsCost);
                                submittedCharges.push(charge);
                                return {
                                    dataUrl: "",
                                    pending: { id: "fixture-native-quota-success:" + submission.id, mediaBaseUrl: "https://fixture.invalid", pollBaseUrl: "https://fixture.invalid/v1" },
                                    pointsCost: charge.cost,
                                    pointsRecordId: charge.recordId,
                                    pointsRemaining: charge.remaining,
                                };
                            });
                            const workerId = "fixture-native-quota-original-image";
                            const [claim] = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [fixture.first.taskId], limit: 1 });
                            assert.ok(claim && typeof claim.payload.executionId === "string");
                            const image = await imageTasks.getImageTask(fixture.first.taskId);
                            assert.ok(image);
                            expect(await runtime.createImageTaskUpstreamStep(image, fixture.imageOrigin, fixture.imageOrigin, boundary.cookie)).toMatchObject({ state: "pending", upstream: { id: "fixture-native-quota-success:" + fixture.first.taskId } });
                            expect(submittedCharges).toHaveLength(1);
                            const charge = submittedCharges[0];
                            const submitted = await imageTasks.getImageTask(fixture.first.taskId);
                            assert.ok(charge && submitted?.upstream);
                            expect(charge).toMatchObject({ cost: price.pointsCost, units: 1, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:1" });
                            expect(submitted).toMatchObject({
                                id: fixture.first.taskId,
                                runId: fixture.paused.id,
                                clientRequestId: fixture.first.requestId,
                                attemptNo: 1,
                                billing: { pointsCost: price.pointsCost, pointsRecordId: charge.recordId, refunded: false },
                            });
                            const debited = await expectNativeSceneQuotaMoney(scope, 1, price.pointsCost, price.chargedBalance);
                            expect(debited.points).toHaveLength(scope.initial.points.length + 1);
                            const debit = debited.points.find((row) => row.id === charge.recordId);
                            assert.ok(debit);
                            expect(debit).toMatchObject({ user_id: userId, model: imageModelId, type: "consume", idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:1" });
                            expect(Number(debit.amount)).toBe(price.debitAmount);
                            expect(Number(debit.permanent_amount)).toBe(price.debitAmount);
                            expect(Number(debit.daily_amount)).toBe(0);
                            await refuseNativeSceneQuotaOverrun(scope);
                            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                                .png()
                                .toBuffer();
                            const resultUrl = dataUrl(native);
                            providerResults.set(submitted.upstream.id, { dataUrl: resultUrl, results: [{ dataUrl: resultUrl }] });
                            expect(await runtime.queryImageTaskUpstreamStep(submitted, fixture.imageOrigin, boundary.cookie)).toMatchObject({ state: "result_ready", status: "native_ready" });
                            const sealed = await imageTasks.getImageTask(fixture.first.taskId);
                            assert.ok(sealed?.nativeResults);
                            expect(sealed.result).toBeUndefined();
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(debited);
                            expect(await runtime.persistImageTaskResult(sealed, fixture.imageOrigin, resultUrl, boundary.cookie)).toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String) } });
                            const waiting = await imageTasks.getImageTask(fixture.first.taskId);
                            assert.ok(waiting?.resultProcessing);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(debited);
                            const worker = await processWithWorker(waiting.resultProcessing.jobId);
                            expect(worker.child.payload.operation).toBe("process_result");
                            expect(worker.child.payload.inputs).toHaveLength(3);
                            expect(worker.completion.manifest.results).toMatchObject([
                                { resultId: fixture.first.taskId + ":1", sceneProtectionEvidence: { maskDigest: digest(fixture.built.bytes), nativeDigest: digest(native), outsidePixels: 983040, compositeOutsideChangedPixels: 0 } },
                            ]);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(debited);
                            const recoveryInput = { origin: fixture.imageOrigin, publicOrigin: fixture.imageOrigin, cookie: boundary.cookie, workerId: "fixture-native-quota-result-consumer", taskIds: [fixture.first.taskId], limit: 1 };
                            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
                            const published = await imageTasks.getImageTask(fixture.first.taskId);
                            assert.ok(published?.result?.results);
                            expect(published).toMatchObject({
                                id: fixture.first.taskId,
                                runId: fixture.paused.id,
                                clientRequestId: fixture.first.requestId,
                                referenceDispatch: fixture.firstBefore.referenceDispatch,
                                status: "success",
                                attemptNo: 1,
                                billing: { pointsCost: price.pointsCost, pointsRecordId: charge.recordId, refunded: false },
                                nativeResults: sealed.nativeResults,
                                resultProcessing: waiting.resultProcessing,
                            });
                            expect(published.result.results).toHaveLength(1);
                            const final = worker.completion.manifest.artifacts[0];
                            assert.ok(final);
                            expect(published.result.results[0]).toMatchObject({
                                resultId: fixture.first.taskId + ":1",
                                serverUrl: "/api/reference-assets/" + final.storageKey.split("/").map(encodeURIComponent).join("/"),
                                sceneProtectionEvidence: { nativeDigest: digest(native), maskDigest: digest(fixture.built.bytes), compositeDigest: final.sha256, compositeOutsideChangedPixels: 0 },
                            });
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(debited);
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", worker.child.id)).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: worker.completion.manifest } });
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.buildBefore.id)).toStrictEqual(fixture.buildBefore);
                            expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingRecord);
                            expect(await imageTasks.getImageTask(fixture.second.taskId)).toStrictEqual(fixture.secondBefore);
                            expect(fixture.created).toHaveLength(2);
                            expect(await readFile(fixture.registeredSource.filePath)).toEqual(fixture.source);
                            expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.built.bytes);
                            const saved = await references.readReferenceAsset(final.storageKey);
                            assert.ok(saved);
                            expect(digest(await readFile(saved.filePath))).toBe(final.sha256);
                            expect(await registrations.getLocalMediaRegistration(final.storageKey)).toMatchObject({ ownerUserId: userId, taskId: worker.child.id, runId: fixture.paused.id, storageClass: "permanent" });
                            expect(await registrations.getLocalMediaRegistration(fixture.built.stored.storageKey)).toMatchObject({ ownerUserId: userId, taskId: fixture.buildBefore.id, runId: fixture.paused.id, storageClass: "permanent" });
                            const settled = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
                            const originalTaskIds = new Set(before.rows.map((row) => row.id));
                            expect(settled.rows.filter((row) => originalTaskIds.has(row.id) && row.id !== fixture.first.taskId)).toStrictEqual(before.rows.filter((row) => row.id !== fixture.first.taskId));
                            expect(settled.rows).toHaveLength(before.rows.length + 1);
                            expect(settled.logs.filter((row) => row.id !== "image-task:" + fixture.first.taskId)).toStrictEqual(before.logs);
                            expect(settled.logs).toHaveLength(before.logs.length + 1);
                            expect(settled.logs.find((row) => row.id === "image-task:" + fixture.first.taskId)).toMatchObject({ user_id: userId, task_id: fixture.first.taskId, status: "success", count: 1, success_count: 1, fail_count: 0 });
                            const originalAssets = new Set(before.assets.map((row) => row.id));
                            expect(settled.assets.filter((row) => originalAssets.has(row.id))).toStrictEqual(before.assets);
                            expect(settled.assets).toHaveLength(before.assets.length + 1);
                            expect(settled.assets.find((row) => row.source_task_id === fixture.first.taskId)).toMatchObject({
                                user_id: userId,
                                conversation_id: fixture.conversation.id,
                                source_run_id: fixture.paused.id,
                                source_task_id: fixture.first.taskId,
                                ordinal: 0,
                                type: "image",
                                status: "ready",
                                server_url: published.result.results[0].serverUrl,
                            });
                            const originalFiles = new Set(before.files.map((file) => file.path));
                            expect(settled.files.filter((file) => originalFiles.has(file.path))).toStrictEqual(before.files);
                            expect(settled.conversations).toStrictEqual(before.conversations);
                            expect(settled.messages).toStrictEqual(before.messages);
                            expect(settled.runEvents).toStrictEqual(before.runEvents);
                            expect(await service.completeImageProcessingTask(worker.child.id, worker.completion)).toStrictEqual(worker.receipt);
                            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                            expect(await runtime.persistImageTaskResult(published, fixture.imageOrigin, resultUrl, boundary.cookie)).toStrictEqual(published);
                            expect(await nativeSceneLifecyclePostgresRows(fixture.conversation.id)).toStrictEqual(settled);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(debited);
                            expect(submittedCharges).toHaveLength(1);
                            expect(boundary.create).toHaveBeenCalledOnce();
                            expect(boundary.poll).toHaveBeenCalledOnce();
                        });
                    });
                },
                120_000,
            );

            it.each(nativeSceneQuotaPrices)(
                "refunds enabled native image quota across exactly two failed attempts and terminal replay ($label)",
                async (price) => {
                    await withNativeSceneUserQuota(async (scope) => {
                        await withNativeSceneLifecyclePrefix(async (fixture) => {
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(scope.initial);
                            await installNativeSceneQuotaPrice(scope, price.pointsCost);
                            const settings = await auth.getFreshAuthSettings();
                            expect(settings.entitlements.enabled).toBe(true);
                            expect(settings.generationCostControl).toStrictEqual({ maxPointsPerTask: 0, dailyUserPointSpend: 0, dailyTotalPointSpend: 0 });
                            const wallet = await import("./points-wallet-service");
                            const walletBefore = await wallet.getPointsWalletSnapshot(userId);
                            expect(walletBefore).toMatchObject({ permanentPoints: 100, dailyPoints: 0 });
                            const before = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
                            assert.ok(before.account);
                            const actual = imageTaskSupportActual.module;
                            assert.ok(actual, "SETUP: the support mock factory must retain the actual parser module it exports");
                            const submittedCharges: Array<Awaited<ReturnType<typeof auth.consumeUserPoints>>> = [];
                            boundary.poll.mockImplementation(actual.pollOpenAiImageTask);
                            await withNativeSceneTerminalQueries(async (queryOrigin, queries) => {
                                boundary.create.mockImplementation(async (submission: ImageTask, origin: string, _publicOrigin: string, cookie: string): Promise<ImageTaskRunResult> => {
                                    expect(submission.id).toBe(fixture.first.taskId);
                                    expect([1, 2]).toContain(submission.attemptNo);
                                    expect(submission.config.baseUrl.startsWith("/")).toBe(true);
                                    expect(cookie).toBe(boundary.cookie);
                                    const charge = await submitNativeSceneQuotaAttempt(submission, origin, cookie, price.pointsCost);
                                    submittedCharges.push(charge);
                                    return {
                                        dataUrl: "",
                                        pending: { id: "native-lifecycle-upstream-" + submission.attemptNo, mediaBaseUrl: queryOrigin, pollBaseUrl: queryOrigin, explicitPollUrl: queryOrigin + "/native-lifecycle/attempt-" + submission.attemptNo },
                                        pointsCost: charge.cost,
                                        pointsRecordId: charge.recordId,
                                        pointsRemaining: charge.remaining,
                                    };
                                });
                                expect(
                                    await recovery.runGenerationTaskRecoveryBatch({
                                        origin: fixture.imageOrigin,
                                        publicOrigin: fixture.imageOrigin,
                                        cookie: boundary.cookie,
                                        workerId: "fixture-native-pg-attempt-one",
                                        limit: 1,
                                        taskIds: [fixture.first.taskId],
                                    }),
                                ).toMatchObject({ claimed: 1, pending: 1, needsReview: 0, failed: 0 });
                                expect(submittedCharges).toHaveLength(1);
                                const firstCharge = submittedCharges[0];
                                assert.ok(firstCharge);
                                expect(firstCharge).toMatchObject({ cost: price.pointsCost, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:1" });
                                const first = await imageTasks.getImageTask(fixture.first.taskId);
                                const firstSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                                assert.ok(first && firstSchedule);
                                expect(first).toMatchObject({
                                    id: fixture.first.taskId,
                                    attemptNo: 1,
                                    upstream: { id: "native-lifecycle-upstream-1", explicitPollUrl: queryOrigin + "/native-lifecycle/attempt-1" },
                                    billing: { pointsCost: price.pointsCost, pointsRecordId: firstCharge.recordId, refunded: false },
                                });
                                expect(first.attempts).toMatchObject([{ attemptNo: 1, status: "running" }]);
                                expect(firstSchedule).toMatchObject({ executionPhase: "polling", upstreamTaskId: "native-lifecycle-upstream-1" });
                                expect(firstSchedule.workerId).toBeUndefined();
                                expect(firstSchedule.leaseUntil).toBeUndefined();
                                const chargedOnce = await expectNativeSceneQuotaBindings(fixture, before, price.chargedBalance);
                                assert.ok(chargedOnce.account);
                                await expectNativeSceneQuotaMoney(scope, 1, price.pointsCost, price.chargedBalance);
                                await refuseNativeSceneQuotaOverrun(scope);
                                expect(chargedOnce.logs).toStrictEqual(before.logs);
                                expect(chargedOnce.account.pointRecords).toHaveLength(before.account.pointRecords.length + 1);
                                const firstDebit = chargedOnce.account.pointRecords.find((row) => row.id === firstCharge.recordId);
                                assert.ok(firstDebit);
                                expect(firstDebit).toMatchObject({ user_id: userId, model: imageModelId, type: "consume", idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:1" });
                                expect(Number(firstDebit.amount)).toBe(price.debitAmount);
                                expect(Number(firstDebit.permanent_amount)).toBe(price.debitAmount);
                                expect(Number(firstDebit.daily_amount)).toBe(0);
                                expect(Number(firstDebit.balance_after)).toBe(price.chargedBalance);
                                expect(queries).toStrictEqual([]);
                                expect(boundary.create).toHaveBeenCalledOnce();
                                expect(boundary.poll).not.toHaveBeenCalled();
                                const firstFailure = await fetch(`${fixture.imageOrigin}/api/image-tasks/${fixture.first.taskId}`, {
                                    method: "POST",
                                    headers: { cookie: boundary.cookie, "content-type": "application/json" },
                                    body: JSON.stringify({ action: "recover" }),
                                });
                                expect(firstFailure.status, await firstFailure.clone().text()).toBe(200);
                                expect(await firstFailure.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "running", executionPhase: "created", needsReview: false } });
                                expect(queries).toStrictEqual(["/native-lifecycle/attempt-1"]);
                                const rearmed = await imageTasks.getImageTask(fixture.first.taskId);
                                const retrySchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                                assert.ok(rearmed && retrySchedule);
                                expect(rearmed).toMatchObject({
                                    id: fixture.first.taskId,
                                    runId: fixture.paused.id,
                                    clientRequestId: fixture.first.requestId,
                                    referenceDispatch: fixture.firstBefore.referenceDispatch,
                                    attemptNo: 1,
                                    status: "running",
                                    retryable: false,
                                    candidateConfigs: [],
                                    mask: fixture.task.sceneProtection?.mask,
                                    sceneProtection: fixture.task.sceneProtection,
                                });
                                expect(rearmed.attempts).toMatchObject([{ attemptNo: 1, status: "failed", error: "native lifecycle upstream one failed", pointsCost: price.pointsCost, pointsRecordId: firstCharge.recordId }]);
                                expect(rearmed.attempts?.[0].completedAt).toBeGreaterThan(0);
                                expect({ upstream: rearmed.upstream, billing: rearmed.billing, result: rearmed.result, acquisition: rearmed.nativeAcquisition, native: rearmed.nativeResults, processing: rearmed.resultProcessing }).toStrictEqual({
                                    upstream: undefined,
                                    billing: undefined,
                                    result: undefined,
                                    acquisition: undefined,
                                    native: undefined,
                                    processing: undefined,
                                });
                                expect(retrySchedule).toMatchObject({ executionPhase: "created", lastUpstreamStatus: "automatic_retry_after_upstream_failure" });
                                expect({
                                    worker: retrySchedule.workerId,
                                    lease: retrySchedule.leaseUntil,
                                    submitted: retrySchedule.submittedAt,
                                    upstream: retrySchedule.upstreamTaskId,
                                    query: retrySchedule.queryPath,
                                    result: retrySchedule.resultPayload,
                                }).toStrictEqual({ worker: undefined, lease: undefined, submitted: undefined, upstream: undefined, query: undefined, result: {} });
                                expect(retrySchedule.nextPollAt).toBeGreaterThan(0);
                                expect(retrySchedule.nextPollAt).toBeLessThanOrEqual(Date.now());
                                const refundedOnce = await expectNativeSceneQuotaBindings(fixture, before, 100);
                                assert.ok(refundedOnce.account);
                                await expectNativeSceneQuotaMoney(scope, 0, 0, 100);
                                expect(refundedOnce.logs).toStrictEqual(before.logs);
                                expect(refundedOnce.account.pointRecords).toHaveLength(before.account.pointRecords.length + 2);
                                expect(refundedOnce.account.pointRecords.find((row) => row.id === firstCharge.recordId)).toStrictEqual(firstDebit);
                                const firstRefund = refundedOnce.account.pointRecords.find((row) => row.source_record_id === firstCharge.recordId);
                                assert.ok(firstRefund);
                                expect(firstRefund).toMatchObject({
                                    user_id: userId,
                                    model: imageModelId,
                                    type: "refund",
                                    idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:1:refund",
                                    source_record_id: firstCharge.recordId,
                                    source_date: firstDebit.source_date,
                                });
                                expect(Number(firstRefund.amount)).toBe(price.pointsCost);
                                expect(Number(firstRefund.permanent_amount)).toBe(price.pointsCost);
                                expect(Number(firstRefund.daily_amount)).toBe(0);
                                expect(Number(firstRefund.balance_after)).toBe(100);
                                expect(await wallet.getPointsWalletSnapshot(userId)).toStrictEqual(walletBefore);
                                expect(boundary.create).toHaveBeenCalledOnce();
                                expect(boundary.poll).toHaveBeenCalledOnce();
                                expect(
                                    await recovery.runGenerationTaskRecoveryBatch({
                                        origin: fixture.imageOrigin,
                                        publicOrigin: fixture.imageOrigin,
                                        cookie: boundary.cookie,
                                        workerId: "fixture-native-pg-attempt-two",
                                        limit: 1,
                                        taskIds: [fixture.first.taskId],
                                    }),
                                ).toMatchObject({ claimed: 1, pending: 1, needsReview: 0, failed: 0 });
                                expect(submittedCharges).toHaveLength(2);
                                const secondCharge = submittedCharges[1];
                                assert.ok(secondCharge);
                                expect(secondCharge.recordId).not.toBe(firstCharge.recordId);
                                expect(secondCharge).toMatchObject({ cost: price.pointsCost, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:2" });
                                const second = await imageTasks.getImageTask(fixture.first.taskId);
                                const secondSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                                assert.ok(second && secondSchedule);
                                expect(second).toMatchObject({
                                    id: fixture.first.taskId,
                                    runId: fixture.paused.id,
                                    clientRequestId: fixture.first.requestId,
                                    referenceDispatch: fixture.firstBefore.referenceDispatch,
                                    attemptNo: 2,
                                    upstream: { id: "native-lifecycle-upstream-2", explicitPollUrl: queryOrigin + "/native-lifecycle/attempt-2" },
                                    billing: { pointsCost: price.pointsCost, pointsRecordId: secondCharge.recordId, refunded: false },
                                    mask: fixture.task.sceneProtection?.mask,
                                    sceneProtection: fixture.task.sceneProtection,
                                });
                                expect(second.attempts).toMatchObject([
                                    { attemptNo: 1, status: "failed" },
                                    { attemptNo: 2, status: "running" },
                                ]);
                                expect(second.attempts?.[0]).toStrictEqual(rearmed.attempts?.[0]);
                                expect(secondSchedule).toMatchObject({ executionPhase: "polling", upstreamTaskId: "native-lifecycle-upstream-2", queryPath: queryOrigin + "/native-lifecycle/attempt-2" });
                                expect(second.executionId).not.toBe(rearmed.executionId);
                                expect(secondSchedule.workerId).toBeUndefined();
                                expect(secondSchedule.leaseUntil).toBeUndefined();
                                const chargedTwice = await expectNativeSceneQuotaBindings(fixture, before, price.chargedBalance);
                                assert.ok(chargedTwice.account);
                                await expectNativeSceneQuotaMoney(scope, 1, price.pointsCost, price.chargedBalance);
                                expect(chargedTwice.logs).toStrictEqual(before.logs);
                                expect(chargedTwice.account.pointRecords).toHaveLength(before.account.pointRecords.length + 3);
                                expect(chargedTwice.account.pointRecords.find((row) => row.id === firstCharge.recordId)).toStrictEqual(firstDebit);
                                expect(chargedTwice.account.pointRecords.find((row) => row.id === firstRefund.id)).toStrictEqual(firstRefund);
                                const secondDebit = chargedTwice.account.pointRecords.find((row) => row.id === secondCharge.recordId);
                                assert.ok(secondDebit);
                                expect(secondDebit).toMatchObject({ user_id: userId, model: imageModelId, type: "consume", idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:2" });
                                expect(Number(secondDebit.amount)).toBe(price.debitAmount);
                                expect(Number(secondDebit.permanent_amount)).toBe(price.debitAmount);
                                expect(Number(secondDebit.daily_amount)).toBe(0);
                                expect(Number(secondDebit.balance_after)).toBe(price.chargedBalance);
                                expect(queries).toStrictEqual(["/native-lifecycle/attempt-1"]);
                                expect(boundary.create).toHaveBeenCalledTimes(2);
                                expect(boundary.poll).toHaveBeenCalledOnce();
                                const secondFailure = await fetch(`${fixture.imageOrigin}/api/image-tasks/${fixture.first.taskId}`, {
                                    method: "POST",
                                    headers: { cookie: boundary.cookie, "content-type": "application/json" },
                                    body: JSON.stringify({ action: "recover" }),
                                });
                                expect(secondFailure.status, await secondFailure.clone().text()).toBe(200);
                                expect(await secondFailure.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "error", executionPhase: "completed" } });
                                const failed = await imageTasks.getImageTask(fixture.first.taskId);
                                const failedSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                                assert.ok(failed && failedSchedule);
                                expect(failed).toMatchObject({
                                    id: fixture.first.taskId,
                                    runId: fixture.paused.id,
                                    clientRequestId: fixture.first.requestId,
                                    referenceDispatch: fixture.firstBefore.referenceDispatch,
                                    status: "error",
                                    attemptNo: 2,
                                    error: "native lifecycle upstream two failed",
                                    billing: { pointsCost: price.pointsCost, pointsRecordId: secondCharge.recordId, refunded: true },
                                    mask: fixture.task.sceneProtection?.mask,
                                    sceneProtection: fixture.task.sceneProtection,
                                });
                                expect(failed.attempts).toMatchObject([
                                    { attemptNo: 1, status: "failed", pointsRecordId: firstCharge.recordId },
                                    { attemptNo: 2, status: "failed", error: "native lifecycle upstream two failed", pointsRecordId: secondCharge.recordId },
                                ]);
                                expect(failed.attempts?.[0]).toStrictEqual(rearmed.attempts?.[0]);
                                expect(failed.attempts?.[1].completedAt).toBeGreaterThan(0);
                                expect(failedSchedule.executionPhase).toBe("completed");
                                expect({ due: failedSchedule.nextPollAt, worker: failedSchedule.workerId, lease: failedSchedule.leaseUntil }).toStrictEqual({ due: undefined, worker: undefined, lease: undefined });
                                expect(failed.nativeResults).toBeUndefined();
                                expect(failed.resultProcessing).toBeUndefined();
                                expect(failed.result).toBeUndefined();
                                const terminal = await expectNativeSceneQuotaBindings(fixture, before, 100);
                                assert.ok(terminal.account);
                                const terminalQuota = await expectNativeSceneQuotaMoney(scope, 0, 0, 100);
                                expect(terminal.account.pointRecords).toHaveLength(before.account.pointRecords.length + 4);
                                expect(terminal.account.pointRecords.find((row) => row.id === firstCharge.recordId)).toStrictEqual(firstDebit);
                                expect(terminal.account.pointRecords.find((row) => row.id === firstRefund.id)).toStrictEqual(firstRefund);
                                expect(terminal.account.pointRecords.find((row) => row.id === secondCharge.recordId)).toStrictEqual(secondDebit);
                                const secondRefund = terminal.account.pointRecords.find((row) => row.source_record_id === secondCharge.recordId);
                                assert.ok(secondRefund);
                                expect(secondRefund).toMatchObject({
                                    user_id: userId,
                                    model: imageModelId,
                                    type: "refund",
                                    idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:2:refund",
                                    source_record_id: secondCharge.recordId,
                                    source_date: secondDebit.source_date,
                                });
                                expect(Number(secondRefund.amount)).toBe(price.pointsCost);
                                expect(Number(secondRefund.permanent_amount)).toBe(price.pointsCost);
                                expect(Number(secondRefund.daily_amount)).toBe(0);
                                expect(Number(secondRefund.balance_after)).toBe(100);
                                expect(await wallet.getPointsWalletSnapshot(userId)).toStrictEqual(walletBefore);
                                expect(fixture.firstBefore.generationLogId).toBeUndefined();
                                expect(terminal.logs.filter((row) => row.id !== "image-task:" + fixture.first.taskId)).toStrictEqual(before.logs);
                                expect(terminal.logs).toHaveLength(before.logs.length + 1);
                                expect(terminal.logs.find((row) => row.id === "image-task:" + fixture.first.taskId)).toMatchObject({
                                    user_id: userId,
                                    task_id: fixture.first.taskId,
                                    status: "failed",
                                    count: 1,
                                    success_count: 0,
                                    fail_count: 1,
                                    error: "native lifecycle upstream two failed",
                                });
                                expect(
                                    await recovery.runGenerationTaskRecoveryBatch({
                                        origin: fixture.imageOrigin,
                                        publicOrigin: fixture.imageOrigin,
                                        cookie: boundary.cookie,
                                        workerId: "fixture-native-pg-no-third-attempt",
                                        limit: 1,
                                        taskIds: [fixture.first.taskId],
                                    }),
                                ).toMatchObject({ claimed: 0 });
                                const replay = await fetch(`${fixture.imageOrigin}/api/image-tasks/${fixture.first.taskId}`, {
                                    method: "POST",
                                    headers: { cookie: boundary.cookie, "content-type": "application/json" },
                                    body: JSON.stringify({ action: "recover" }),
                                });
                                expect(replay.status).toBe(409);
                                expect(await replay.json()).toStrictEqual({ error: "当前图片任务无法继续检查" });
                                expect(await nativeSceneLifecyclePostgresRows(fixture.conversation.id)).toStrictEqual(terminal);
                                expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(terminalQuota);
                                expect(queries).toStrictEqual(["/native-lifecycle/attempt-1", "/native-lifecycle/attempt-2"]);
                                expect(submittedCharges).toHaveLength(2);
                                expect(boundary.create).toHaveBeenCalledTimes(2);
                                expect(boundary.poll).toHaveBeenCalledTimes(2);
                            });
                        });
                    });
                },
                120_000,
            );
        }

        if (provider === "postgres") {
            it(
                "retains the original native scene image and paid quota after an observed charged create response body is interrupted",
                async () => {
                    await withNativeSceneUserQuota(async (scope) => {
                        await withNativeSceneLifecyclePrefix(async (fixture) => {
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(scope.initial);
                            const before = await nativeSceneLifecyclePostgresRows(fixture.conversation.id);
                            assert.ok(before.account);
                            const exchange = await runNativeSceneUnknownCreate(fixture, scope);
                            expect(exchange.batch).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 1, deferred: 0 });
                            expect(exchange.observed).toStrictEqual({
                                requests: 1,
                                requestComplete: true,
                                multipartVerified: true,
                                headersFlushed: true,
                                clientHeadersObserved: true,
                                jsonStarted: true,
                                jsonSettled: true,
                                responseClosed: true,
                                socketClosed: true,
                                chargedWrapperEntered: false,
                            });
                            expect(exchange.phases).toStrictEqual(["request_complete", "multipart_verified", "charged", "headers_flushed", "client_headers_observed", "json_started", "response_destroyed", "json_settled"]);
                            const reviewReason = "上游提交结果不确定，未取得可查询的任务 ID；为避免重复生成和扣费，系统已停止自动重试。";
                            const image = await imageTasks.getImageTask(fixture.first.taskId);
                            const schedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
                            assert.ok(image && schedule);
                            expect(image).toMatchObject({
                                id: fixture.first.taskId,
                                runId: fixture.paused.id,
                                clientRequestId: fixture.first.requestId,
                                status: "running",
                                attemptNo: 1,
                                executionPhase: "needs_review",
                                lastUpstreamStatus: "submission_outcome_unknown",
                                reviewReason,
                                billing: { pointsCost: 2, pointsRecordId: exchange.charge.recordId, refunded: false },
                            });
                            expect(image.attempts).toHaveLength(1);
                            expect(image.attempts).toStrictEqual(exchange.submission.attempts);
                            expect(image.attempts).toMatchObject([{ attemptNo: 1, status: "running" }]);
                            expect(image.retryable).toBe(fixture.firstBefore.retryable);
                            expect(image.candidateConfigs).toStrictEqual(fixture.firstBefore.candidateConfigs);
                            expect({ upstream: image.upstream, result: image.result, native: image.nativeResults, acquisition: image.nativeAcquisition, processing: image.resultProcessing, error: image.error }).toStrictEqual({
                                upstream: undefined,
                                result: undefined,
                                native: undefined,
                                acquisition: undefined,
                                processing: undefined,
                                error: undefined,
                            });
                            expect(schedule).toMatchObject({ executionPhase: "needs_review", lastUpstreamStatus: "submission_outcome_unknown", resultPayload: { reviewReason } });
                            expect(schedule.resultPayload).toStrictEqual({ reviewReason });
                            expect({ worker: schedule.workerId, lease: schedule.leaseUntil, due: schedule.nextPollAt, upstream: schedule.upstreamTaskId, query: schedule.queryPath }).toStrictEqual({
                                worker: undefined,
                                lease: undefined,
                                due: undefined,
                                upstream: undefined,
                                query: undefined,
                            });
                            expect(schedule.submittedAt).toBeGreaterThan(0);
                            const unknown = await expectNativeSceneQuotaBindings(fixture, before, 98);
                            assert.ok(unknown.account);
                            expect(unknown.rows).toHaveLength(before.rows.length);
                            expect(unknown.logs).toStrictEqual(before.logs);
                            expect(unknown.account.pointRecords).toHaveLength(before.account.pointRecords.length + 1);
                            const debit = unknown.account.pointRecords.find((row) => row.id === exchange.charge.recordId);
                            assert.ok(debit);
                            expect(debit).toMatchObject({ user_id: userId, model: imageModelId, type: "consume", idempotency_key: "image-task:" + fixture.first.taskId + ":attempt:1" });
                            expect(Number(debit.amount)).toBe(-2);
                            expect(Number(debit.permanent_amount)).toBe(-2);
                            expect(Number(debit.daily_amount)).toBe(0);
                            expect(Number(debit.balance_after)).toBe(98);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(exchange.debited);
                            expect(boundary.create).toHaveBeenCalledOnce();
                            expect(boundary.poll).not.toHaveBeenCalled();
                            expect(
                                await recovery.runGenerationTaskRecoveryBatch({
                                    origin: fixture.imageOrigin,
                                    publicOrigin: fixture.imageOrigin,
                                    cookie: boundary.cookie,
                                    workerId: "fixture-native-pg-no-recreate-unknown",
                                    taskIds: [fixture.first.taskId],
                                    limit: 1,
                                }),
                            ).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                            expect(await nativeSceneLifecyclePostgresRows(fixture.conversation.id)).toStrictEqual(unknown);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(exchange.debited);
                            const detail = await fetch(fixture.imageOrigin + "/api/image-tasks/" + fixture.first.taskId, { headers: { cookie: boundary.cookie } });
                            expect(detail.status).toBe(200);
                            expect(detail.headers.get("x-vozeb-pro-points-remaining")).toBe("98");
                            expect(await detail.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "running", needsReview: true, reviewReason, executionPhase: "needs_review", canRetry: false } });
                            expect(await nativeSceneLifecyclePostgresRows(fixture.conversation.id)).toStrictEqual(unknown);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(exchange.debited);
                            const recover = await fetch(fixture.imageOrigin + "/api/image-tasks/" + fixture.first.taskId, {
                                method: "POST",
                                headers: { cookie: boundary.cookie, "content-type": "application/json" },
                                body: JSON.stringify({ action: "recover" }),
                            });
                            expect(recover.status).toBe(409);
                            expect(await recover.json()).toStrictEqual({ error: "原任务没有保存上游任务 ID，无法安全追回结果" });
                            expect(await nativeSceneLifecyclePostgresRows(fixture.conversation.id)).toStrictEqual(unknown);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(exchange.debited);
                            // The existing TCP wrapper does not forward create-key headers; invoke the actual authenticated Route with the original key.
                            const { POST } = await import("@/app/api/image-tasks/route");
                            const replay = await POST(
                                new Request(fixture.imageOrigin + "/api/image-tasks", {
                                    method: "POST",
                                    headers: { cookie: boundary.cookie, "content-type": "application/json", "x-vozeb-pro-client-request-id": fixture.first.requestId, "x-vozeb-pro-attempt-no": "1" },
                                    body: JSON.stringify({}),
                                }),
                            );
                            expect(replay.status).toBe(200);
                            expect(await replay.json()).toMatchObject({ task: { id: fixture.first.taskId, kind: "edit", status: "running", model: imageModelId } });
                            expect(await nativeSceneLifecyclePostgresRows(fixture.conversation.id)).toStrictEqual(unknown);
                            expect(await nativeSceneQuotaRows(scope.planId)).toStrictEqual(exchange.debited);
                            expect(await imageTasks.getImageTask(fixture.first.taskId)).toStrictEqual(image);
                            expect(fixture.created).toHaveLength(2);
                            expect(exchange.observed.requests).toBe(1);
                            expect(boundary.create).toHaveBeenCalledOnce();
                            expect(boundary.poll).not.toHaveBeenCalled();
                        });
                    });
                },
                120_000 + 3 * 15_000,
            );
        }

        it("keeps a local scene Run copy with an inline mask on its original protected result through the CPU Worker and Agent adoption", async () => {
            const route = await configureSceneRoute();
            const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
            const { executeImageProcessing } = await import("@/lib/image-processing/operations");
            const { createEcommerceSceneEditTask } = await import("./ecommerce-generation-service");
            const { usesImageTaskResultProcessing, isNativeSceneImageTaskResult } = await import("./image-task-result-contract");
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Confirmed local scene Run" });
            const source = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();
            const baseline = await creative.uploadAssetForUser(userId, conversation.id, new File([new Uint8Array(source)], "scene-baseline.png", { type: "image/png" }));
            assert.ok(baseline.storageKey && baseline.serverUrl);
            const storedBaseline = await references.readReferenceAsset(baseline.storageKey);
            assert.ok(storedBaseline);
            expect(await readFile(storedBaseline.filePath)).toEqual(source);
            const initial = (
                await runs.createAgentRun(userId, {
                    clientRequestId: "fixture-run-scene-" + randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: "Replace the selected prop while preserving the rest of this scene",
                    assetIds: [baseline.id],
                    skillIds: [],
                    modelIds: [imageModelId],
                    preferences: { mode: "image", image: { count: 1, quality: "low", size: "1024x1024" } },
                })
            ).run;
            const plan: import("./ecommerce-edit-plan").EcommerceEditPlan = {
                planVersion: "ecommerce-edit.v6",
                operation: "scene_edit",
                source: { productAnchorId: null, currentSceneBaselineId: baseline.id, sceneReferenceIds: [] },
                baseline: { productFacts: null, sceneFacts: { space: "room", composition: "front view", lighting: "soft daylight" } },
                delta: { requestedChanges: ["replace the selected prop"], targetObjects: ["selected-prop"], targetRegions: ["user-selection"] },
                preserve: { productCore: [], sceneElements: ["outside-selection"] },
                strategy: "integrated_scene",
                modelRoles: { visionAnalysis: "fixture-scene-vision", editPlanning: "fixture-scene-planning", generation: imageModelId, qualityCheck: "fixture-scene-quality" },
                continuity: { parentResultId: null, branchId: initial.id },
                validation: { requiredChecks: ["scene_preservation"] },
                canvas: { mode: "exact", size: { width: 1024, height: 1024 }, source: "baseline", allowReframe: false },
                protection: { scope: "local", protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false },
                referenceUses: [{ assetId: baseline.id, alias: null, purposes: ["edit_target"], usedCueIds: [] }],
            };
            const profile = resolveEcommerceImageProviderProfile(route.snapshot);
            assert.ok(profile && profile.supportsIndependentMask);
            const compiled = compileEcommerceImageRequest(plan, profile);
            expect(compiled).toMatchObject({ state: "ready", compilerVersion: "ecommerce-openai-image-2.5.v4", providerProfileId: "gpt-image-2.5-flare", mask: { mode: "independent", required: true }, modelSnapshot: route.snapshot });
            const buildDirectory = await mkdtemp(path.join(directory, "inline-scene-mask-"));
            const built = await executeImageProcessing(
                {
                    version: "image-processing.v1",
                    jobId: "fixture-inline-scene-build",
                    executionId: "fixture-inline-scene-build-execution",
                    operation: "build_protection",
                    inputs: [{ path: storedBaseline.filePath, assetId: baseline.id, assetVersion: "fixture-inline-scene-source-v1", expectedSha256: digest(source) }],
                    outputDirectory: buildDirectory,
                    options: { mode: "scene_selection", region: { x: 256, y: 256, width: 256, height: 256 }, semantics: plan.delta.requestedChanges, selectionSource: "user_selection" },
                },
                () => {},
            );
            const builtProtection = built.geometry.sceneProtection;
            assert.ok(builtProtection);
            const builtMaskBytes = await readFile(built.artifacts[0].path);
            const reviewTask = createEcommerceSceneEditTask(initial, plan, [baseline], compiled, {
                ...builtProtection,
                mask: { id: baseline.id + "-scene-edit-mask", name: "scene-edit-mask.png", type: "image/png", ...builtProtection.maskSize, dataUrl: dataUrl(builtMaskBytes) },
                confirmation: { actorUserId: userId, confirmedAt: Date.now() },
            });
            const inlineRun = await runs.updateAgentRunById(initial.id, {
                status: "running",
                tasks: [reviewTask],
                reviewed: true,
                ecommerceSnapshot: {
                    runId: initial.id,
                    userId,
                    version: "ecommerce-generation.v1",
                    mode: "active",
                    input: { userRequest: initial.prompt, assetIds: [baseline.id], conversationId: conversation.id, surface: "chat" },
                    plan,
                    qualityPolicy: "disabled",
                    modelRouteSnapshots: { image_generation: route.snapshot },
                    compilerVersion: compiled.compilerVersion,
                    createdAt: Date.now(),
                },
            });
            assert.ok(inlineRun);
            await withSceneRoutes(initial.id, async (sceneOrigin) => {
                const executorId = "fixture-original-scene-agent-executor";
                const run = await runs.updateAgentRunById(initial.id, { executionId: executorId });
                assert.ok(run && run.tasks.length === 1);
                const task = run.tasks[0];
                assert.ok(task.sceneProtection);
                const { mask, ...protection } = task.sceneProtection;
                const maskBytes = Buffer.from(mask.dataUrl.split(",")[1], "base64");
                expect(mask.dataUrl).toBe(dataUrl(builtMaskBytes));
                expect(mask.serverUrl).toBeUndefined();
                expect(mask.url).toBeUndefined();
                expect(mask.remoteUrl).toBeUndefined();
                expect(task).toMatchObject({
                    id: reviewTask.id,
                    type: "image",
                    status: "ready",
                    attempts: 0,
                    count: 1,
                    ecommerceExecution: compiled,
                    references: [{ assetId: baseline.id, ecommerceRole: "scene", url: baseline.serverUrl }],
                    sceneProtection: { sourceAssetId: baseline.id, sourceSize: { width: 1024, height: 1024 }, sourceDigest: digest(source), maskDigest: digest(maskBytes), confirmation: { actorUserId: userId, confirmedAt: expect.any(Number) } },
                });
                const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#abcdef" } })
                    .png()
                    .toBuffer();
                await withImageRoutes(run, task, async (imageOrigin, created) => {
                    expect(await execution.runTaskWithRetry(run.id, task, imageOrigin, boundary.cookie, executorId)).toBe("deferred");
                    expect(created).toHaveLength(1);
                    const copy = created[0];
                    assert.ok(copy);
                    expect(copy.requestId).toBe(run.clientRequestId + ":" + task.id + ":1:1");
                    const original = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(original);
                    expect(original).toMatchObject({
                        id: copy.taskId,
                        runId: run.id,
                        parentTaskId: run.id,
                        conversationId: conversation.id,
                        clientRequestId: copy.requestId,
                        status: "pending",
                        attemptNo: 1,
                        kind: "edit",
                        config: { quality: "low", size: "1024x1024" },
                        references: [{ id: baseline.id, ecommerceRole: "scene", url: baseline.serverUrl }],
                        ecommerceExecution: compiled,
                        sceneProtection: task.sceneProtection,
                        mask,
                    });
                    expect(await runs.getAgentRun(run.id)).toMatchObject({ status: "running", tasks: [{ id: task.id, status: "running", count: 1, attempts: 1, taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "pending", attempt: 1 }] }] });
                    expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual([]);
                    // This uses the original RED gate after the real charge and same-upstream query.
                    const prepared = await waitForCopy(copy.taskId, native, sceneOrigin);
                    assert.ok(prepared.waiting.resultProcessing && prepared.waiting.nativeResults);
                    expect(usesImageTaskResultProcessing(prepared.waiting)).toBe(true);
                    expect(isNativeSceneImageTaskResult(prepared.waiting)).toBe(false);
                    const worker = await processWithWorker(prepared.waiting.resultProcessing.jobId);
                    const payload = worker.child.payload;
                    assert.ok(payload.operation === "process_result" && payload.options.mode === "scene_protection");
                    expect(payload.options).toStrictEqual({ mode: "scene_protection", results: [{ resultId: copy.taskId + ":1", resultIndex: 1, inputIndex: 0 }], sourceInputIndex: 1, maskInputIndex: 2, protection });
                    expect(payload.inputs).toHaveLength(3);
                    expect(payload.inputs[1]).toMatchObject({ assetId: baseline.id, assetVersion: digest(source), expectedSha256: digest(source) });
                    expect(payload.inputs[2]).toMatchObject({ assetId: mask.id, assetVersion: digest(maskBytes), expectedSha256: digest(maskBytes) });
                    expect(payload.parentMask).toStrictEqual({ inputIndex: 2, imageTaskId: copy.taskId });
                    expect(payload.resource.facts.decodedInputs).toStrictEqual([]);
                    expect(payload.imageResultBinding).toMatchObject({
                        imageTaskId: copy.taskId,
                        userId,
                        nativeResults: prepared.waiting.nativeResults,
                        sourceIdentityDigest: expect.any(String),
                        run: { runId: run.id, agentTaskId: task.id, agentAttempt: 1 },
                    });
                    const job = await tasks.getStoredGenerationTaskRecord("image_processing", worker.child.id);
                    expect(job).toMatchObject({ id: worker.child.id, status: "success", executionPhase: "completed", parentTaskId: copy.taskId, runId: run.id, userId, attemptNo: 0, clientRequestId: prepared.waiting.resultProcessing.inputDigest });
                    expect(worker.receipt).toMatchObject({ jobId: worker.child.id, inputDigest: payload.inputDigest, executionId: worker.child.executionId, manifest: worker.completion.manifest, parentRescheduled: true });
                    expect(worker.completion.manifest.results).toMatchObject([
                        {
                            resultId: copy.taskId + ":1",
                            resultIndex: 1,
                            nativeInputIndex: 0,
                            finalArtifactIndex: 0,
                            sceneProtectionEvidence: { sourceDigest: digest(source), maskDigest: digest(maskBytes), nativeDigest: digest(native), normalization: "none", outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
                        },
                    ]);
                    expect(worker.uploads).toHaveLength(1);
                    expect(worker.completion.manifest.artifacts).toHaveLength(1);
                    const final = worker.completion.manifest.artifacts[0];
                    expect(final).toMatchObject({ kind: "final", resultId: copy.taskId + ":1", resultIndex: 1, width: 1024, height: 1024, mimeType: "image/png" });
                    expect(worker.uploads[0].stored).toStrictEqual(final);
                    expect(digest(worker.uploads[0].bytes)).toBe(final.sha256);
                    expect(final.sha256).not.toBe(digest(native));
                    const pixels = await sharp(worker.uploads[0].bytes).ensureAlpha().raw().toBuffer();
                    expect([...pixels.subarray(0, 4)]).toStrictEqual([18, 52, 86, 255]);
                    expect([...pixels.subarray(1049600, 1049604)]).toStrictEqual([171, 205, 239, 255]);
                    const financial = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                    expect(financial.records).toHaveLength(1);
                    const recoveryInput = { origin: sceneOrigin, cookie: boundary.cookie, workerId: "fixture-scene-consumer-" + copy.taskId, taskIds: [copy.taskId], limit: 1 };
                    expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
                    const published = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(published?.result?.results);
                    expect(published).toMatchObject({
                        id: copy.taskId,
                        runId: run.id,
                        parentTaskId: run.id,
                        conversationId: conversation.id,
                        clientRequestId: copy.requestId,
                        status: "success",
                        nativeResults: prepared.waiting.nativeResults,
                        resultProcessing: prepared.waiting.resultProcessing,
                        billing: { pointsCost: prepared.charge.cost, pointsRecordId: prepared.charge.recordId, refunded: false },
                    });
                    expect(published.generationLogId).toBeUndefined();
                    expect(published.generationSlotId).toBeUndefined();
                    expect(published.result.results).toHaveLength(1);
                    const delivered = published.result.results[0];
                    expect(delivered).toMatchObject({
                        resultId: copy.taskId + ":1",
                        width: 1024,
                        height: 1024,
                        bytes: final.bytes,
                        mimeType: "image/png",
                        serverUrl: "/api/reference-assets/" + final.storageKey.split("/").map(encodeURIComponent).join("/"),
                        canvasEvidence: {
                            constraint: plan.canvas,
                            providerRequest: published.ecommerceCanvasRequest,
                            requestedSize: { width: 1024, height: 1024 },
                            nativeSize: { width: 1024, height: 1024 },
                            storedSize: { width: 1024, height: 1024 },
                            normalization: "none",
                        },
                        sceneProtectionEvidence: { ...protection, nativeDigest: digest(native), compositeDigest: final.sha256, outsidePixels: 983040, compositeOutsideChangedPixels: 0 },
                    });
                    const slot = prepared.waiting.nativeResults.slots[0];
                    assert.ok(slot.status === "stored" && delivered.canvasEvidence && delivered.sceneProtectionEvidence?.maskUrl);
                    const nativeUrl = "/api/reference-assets/" + slot.storageKey.split("/").map(encodeURIComponent).join("/");
                    expect(delivered.canvasEvidence.nativeUrl).toBe(nativeUrl);
                    expect(delivered.sceneProtectionEvidence.nativeUrl).toBe(nativeUrl);
                    expect(delivered.sceneProtectionEvidence.compositeUrl).toBe(delivered.serverUrl);
                    expect(await readFile(prepared.nativePath)).toEqual(native);
                    expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: copy.taskId, storageClass: "permanent", type: "attachment" });
                    const maskResponse = await fetch(sceneOrigin + delivered.sceneProtectionEvidence.maskUrl, { headers: { cookie: boundary.cookie } });
                    expect(maskResponse.status).toBe(200);
                    expect(Buffer.from(await maskResponse.arrayBuffer())).toEqual(maskBytes);
                    const maskKey = new URL(delivered.sceneProtectionEvidence.maskUrl, sceneOrigin).pathname.slice("/api/reference-assets/".length).split("/").map(decodeURIComponent).join("/");
                    expect(await registrations.getLocalMediaRegistration(maskKey)).toMatchObject({ ownerUserId: userId, storageClass: "permanent" });
                    expect(await registrations.getLocalMediaRegistration(final.storageKey)).toMatchObject({ ownerUserId: userId, taskId: worker.child.id, runId: run.id, storageClass: "permanent", storageProvider: "local" });
                    const asset = (await creative.listAssetsForUser(userId, conversation.id)).find((item) => item.sourceTaskId === copy.taskId);
                    assert.ok(asset);
                    expect(asset).toMatchObject({ sourceRunId: run.id, sourceTaskId: copy.taskId, ordinal: 0, serverUrl: delivered.serverUrl, status: "ready" });
                    await execution.executeTasks(run.id, sceneOrigin, boundary.cookie, executorId);
                    const completedRun = await runs.getAgentRun(run.id);
                    expect(completedRun).toMatchObject({
                        id: run.id,
                        status: "completed",
                        tasks: [{ id: task.id, status: "completed", attempts: 1, taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "completed", attempt: 1 }], assetIds: [asset.id] }],
                        assetIds: [asset.id],
                        ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" } },
                    });
                    expect(completedRun?.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                    const assets = await creative.listAssetsForUser(userId, conversation.id);
                    expect(assets).toHaveLength(2);
                    expect(assets.find((item) => item.id === asset.id)).toMatchObject({
                        id: asset.id,
                        sourceTaskId: copy.taskId,
                        sourceRunId: run.id,
                        messageId: run.assistantMessageId,
                        parentAssetId: baseline.id,
                        metadata: { agentTaskId: task.id },
                        serverUrl: delivered.serverUrl,
                    });
                    const successfulLogs = (await logs.listGenerationLogs({ userId })).items;
                    expect(successfulLogs).toHaveLength(1);
                    expect(successfulLogs[0]).toMatchObject({ id: "image-task:" + copy.taskId, taskId: copy.taskId, status: "success", count: 1, successCount: 1, assets: [{ serverUrl: delivered.serverUrl, width: 1024, height: 1024 }] });
                    expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(financial);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                    expect(created).toHaveLength(1);
                    const settledImage = await imageTasks.getImageTask(copy.taskId);
                    assert.ok(settledImage);
                    expect(settledImage.ecommerceTrace).toMatchObject({ runId: run.id, agentTaskId: task.id, imageTaskIds: [copy.taskId], finalStatus: "completed" });
                    const settled = await ownedRows(conversation.id);
                    expect(await service.completeImageProcessingTask(worker.child.id, worker.completion)).toStrictEqual(worker.receipt);
                    expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                    expect(await runtime.persistImageTaskResult(published, sceneOrigin, "inline://image-task-result", boundary.cookie)).toStrictEqual(settledImage);
                    expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                });
            });
        }, 120_000);

        it("keeps a dispatched ordinary 4k Run copy on its original native bytes through the CPU Worker and original log", async () => {
            const { readImageEnhancementSettings } = await import("./database/image-enhancement-repository");
            const enhancementSettings = await readImageEnhancementSettings();
            expect(enhancementSettings.enabled, "SETUP: this slice requires the existing enhancement policy to be disabled").toBe(false);
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Ordinary 4k Run copy" });
            const initial = (await runs.createAgentRun(userId, { clientRequestId: "fixture-run-4k-" + randomUUID(), conversationId: conversation.id, surface: "chat", prompt: "Generate one ordinary 4k image", assetIds: [], skillIds: [], modelIds: [] }))
                .run;
            const task: AgentRunTask = {
                id: "declared-ordinary-4k-image",
                type: "image",
                title: "Original 4k copy",
                model: imageModelId,
                prompt: "Generate an ordinary image",
                count: 1,
                ratio: "1:1",
                quality: "4k",
                dependencies: [],
                status: "ready",
                attempts: 0,
            };
            const executorId = "fixture-original-4k-agent-executor";
            const run = await runs.updateAgentRunById(initial.id, { status: "running", executionId: executorId, tasks: [task], reviewed: true });
            assert.ok(run);
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();

            await withImageRoutes(run, task, async (origin, created) => {
                expect(await execution.runTaskWithRetry(run.id, task, origin, boundary.cookie, executorId)).toBe("deferred");
                expect(created).toHaveLength(1);
                const copy = created[0];
                assert.ok(copy);
                expect(copy.requestId).toBe(run.clientRequestId + ":" + task.id + ":1:1");
                const original = await imageTasks.getImageTask(copy.taskId);
                assert.ok(original);
                expect(original).toMatchObject({
                    id: copy.taskId,
                    runId: run.id,
                    parentTaskId: run.id,
                    conversationId: conversation.id,
                    clientRequestId: copy.requestId,
                    status: "pending",
                    attemptNo: 1,
                    config: { quality: "4k", size: "1:1" },
                    enhancementPolicy: { revision: enhancementSettings.revision, enabled: false, connection: null },
                });
                expect(await runs.getAgentRun(run.id)).toMatchObject({ status: "running", tasks: [{ id: task.id, status: "running", count: 1, attempts: 1, taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "pending", attempt: 1 }] }] });
                expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual([]);

                // Current Run 4k selection takes the legacy Web path instead of waiting for the result child.
                const prepared = await waitForCopy(copy.taskId, native, origin);
                expect(prepared.waiting.enhancementPolicy).toStrictEqual(original.enhancementPolicy);
                const completed = await completeCopy(prepared, run, origin, 1, { size: { width: 1024, height: 1024 }, options: {} });
                assert.ok(completed.worker.child.payload.operation === "process_result");
                expect(completed.worker.child.payload.options).not.toHaveProperty("targetSize");
                expect(completed.worker.child.payload.imageResultBinding?.run).toStrictEqual({ runId: run.id, agentTaskId: task.id, agentAttempt: 1 });
                expect(completed.published.enhancementPolicy).toStrictEqual(original.enhancementPolicy);
                const delivered = completed.published.result?.results?.[0];
                assert.ok(delivered);
                expect(delivered).toMatchObject({
                    resultId: copy.taskId + ":1",
                    width: 1024,
                    height: 1024,
                    bytes: native.length,
                    mimeType: "image/png",
                    enhancementId: "enhancement:" + copy.taskId + ":1",
                    nativeSource: { url: delivered.serverUrl, sha256: digest(native), byteLength: native.length, width: 1024, height: 1024, format: "png", hasAlpha: false, provenance: "provider_native" },
                });
                const { listEnhancementJobsForTask } = await import("./database/image-enhancement-job-repository");
                const enhancementJobs = await listEnhancementJobsForTask(copy.taskId, userId);
                expect(enhancementJobs).toHaveLength(1);
                expect(enhancementJobs[0]).toMatchObject({
                    id: "enhancement:" + copy.taskId + ":1",
                    imageTaskId: copy.taskId,
                    resultId: copy.taskId + ":1",
                    status: "skipped",
                    phase: "completed",
                    reason: "disabled",
                    workerId: null,
                    leaseToken: null,
                    leaseUntil: null,
                });
                expect(enhancementJobs[0].remoteJobId).toBeUndefined();
                expect(enhancementJobs[0].submittedAt).toBeUndefined();

                const financial = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                expect(financial.records).toHaveLength(1);
                await execution.executeTasks(run.id, origin, boundary.cookie, executorId);
                const completedRun = await runs.getAgentRun(run.id);
                expect(completedRun).toMatchObject({
                    id: run.id,
                    status: "completed",
                    tasks: [{ id: task.id, status: "completed", attempts: 1, taskIds: [copy.taskId], childTasks: [{ id: copy.taskId, status: "completed", attempt: 1 }] }],
                    assetIds: [completed.asset.id],
                });
                const assets = await creative.listAssetsForUser(userId, conversation.id);
                expect(assets).toHaveLength(1);
                expect(assets[0]).toMatchObject({ id: completed.asset.id, sourceRunId: run.id, sourceTaskId: copy.taskId, ordinal: 0, messageId: run.assistantMessageId, metadata: { agentTaskId: task.id }, serverUrl: delivered.serverUrl });
                const successfulLogs = (await logs.listGenerationLogs({ userId })).items;
                expect(successfulLogs).toHaveLength(1);
                expect(successfulLogs[0]).toMatchObject({ id: "image-task:" + copy.taskId, taskId: copy.taskId, status: "success", count: 1, successCount: 1, assets: [{ serverUrl: delivered.serverUrl, width: 1024, height: 1024 }] });
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(financial);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
                expect(created).toHaveLength(1);

                const settled = await ownedRows(conversation.id);
                expect(await service.completeImageProcessingTask(completed.job.id, completed.worker.completion)).toStrictEqual(completed.worker.receipt);
                expect(await recovery.runGenerationTaskRecoveryBatch(completed.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                expect(await runtime.persistImageTaskResult(completed.published, origin, "inline://image-task-result", boundary.cookie)).toStrictEqual(completed.published);
                expect(await ownedRows(conversation.id)).toStrictEqual(settled);
                expect(await listEnhancementJobsForTask(copy.taskId, userId)).toStrictEqual(enhancementJobs);
            });
        }, 120_000);

        it("keeps two ordinary Run copies on their original ImageTasks through real Worker processing and Agent asset adoption", async () => {
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Two ordinary Run copies" });
            const initial = (
                await runs.createAgentRun(userId, { clientRequestId: `fixture-run-copy-${randomUUID()}`, conversationId: conversation.id, surface: "chat", prompt: "Generate two distinct ordinary images", assetIds: [], skillIds: [], modelIds: [] })
            ).run;
            const task: AgentRunTask = {
                id: "declared-two-copy-image",
                type: "image",
                title: "Two original copies",
                model: imageModelId,
                prompt: "Generate an ordinary image",
                count: 2,
                ratio: "1024x1024",
                quality: "low",
                dependencies: [],
                status: "ready",
                attempts: 0,
            };
            const executorId = "fixture-original-agent-executor";
            const run = await runs.updateAgentRunById(initial.id, { status: "running", executionId: executorId, tasks: [task], reviewed: true });
            assert.ok(run);
            const native1 = await solid("#abcdef");
            const native2 = await solid("#123456");
            await withImageRoutes(run, task, async (origin, created) => {
                expect(await execution.runTaskWithRetry(run.id, task, origin, boundary.cookie, executorId)).toBe("deferred");
                expect(created).toHaveLength(2);
                const copy1 = created.find((item) => item.requestId === `${run.clientRequestId}:${task.id}:1:1`);
                const copy2 = created.find((item) => item.requestId === `${run.clientRequestId}:${task.id}:1:2`);
                assert.ok(copy1 && copy2);
                expect(copy1.taskId).not.toBe(copy2.taskId);
                const linked = await runs.getAgentRun(run.id);
                expect(linked).toMatchObject({
                    status: "running",
                    executionId: executorId,
                    tasks: [
                        {
                            id: task.id,
                            status: "running",
                            count: 2,
                            attempts: 1,
                            taskIds: [copy1.taskId, copy2.taskId],
                            childTasks: [
                                { id: copy1.taskId, status: "pending", attempt: 1 },
                                { id: copy2.taskId, status: "pending", attempt: 1 },
                            ],
                        },
                    ],
                });
                expect(await imageTasks.getImageTask(copy1.taskId)).toMatchObject({ id: copy1.taskId, parentTaskId: run.id, runId: run.id, clientRequestId: copy1.requestId, attemptNo: 1 });
                expect(await imageTasks.getImageTask(copy2.taskId)).toMatchObject({ id: copy2.taskId, parentTaskId: run.id, runId: run.id, clientRequestId: copy2.requestId, attemptNo: 1 });
                expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual([]);

                // Complete the second dispatched copy first; the first remains its original pending ImageTask.
                const prepared2 = await waitForCopy(copy2.taskId, native2, origin);
                const completed2 = await completeCopy(prepared2, run, origin);
                expect(await imageTasks.getImageTask(copy1.taskId)).toMatchObject({ id: copy1.taskId, status: "pending" });
                const pendingProjection = await runs.getAgentRun(run.id);
                assert.ok(pendingProjection);
                expect(await execution.runTaskWithRetry(run.id, pendingProjection.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                const partial = await runs.getAgentRun(run.id);
                expect(partial).toMatchObject({
                    status: "running",
                    tasks: [
                        {
                            id: task.id,
                            status: "running",
                            attempts: 1,
                            childTasks: [
                                { id: copy1.taskId, status: "pending", attempt: 1 },
                                { id: copy2.taskId, status: "completed", attempt: 1 },
                            ],
                        },
                    ],
                });
                const adopted2 = (await creative.listAssetsForUser(userId, conversation.id)).find((item) => item.id === completed2.asset.id);
                expect(adopted2).toMatchObject({ id: completed2.asset.id, sourceRunId: run.id, sourceTaskId: copy2.taskId, ordinal: 0, messageId: run.assistantMessageId, metadata: { agentTaskId: task.id } });
                const partialResponse = await fetch(`${origin}/api/agent/runs/${run.id}`, { headers: { cookie: boundary.cookie } });
                expect(partialResponse.status).toBe(200);
                expect(await partialResponse.json()).toMatchObject({ code: 0, data: { run: { id: run.id, status: "running", tasks: [{ id: task.id, status: "running" }] } } });

                const prepared1 = await waitForCopy(copy1.taskId, native1, origin);
                const completed1 = await completeCopy(prepared1, run, origin);
                expect(completed1.job.id).not.toBe(completed2.job.id);
                expect(completed1.final.storageKey).not.toBe(completed2.final.storageKey);
                const financial = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                expect(financial.records).toHaveLength(2);
                expect(charges.get(copy1.taskId)?.recordId).not.toBe(charges.get(copy2.taskId)?.recordId);
                const chargedAuth = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                await execution.executeTasks(run.id, origin, boundary.cookie, executorId);
                const completedRun = await runs.getAgentRun(run.id);
                assert.ok(completedRun);
                expect(completedRun).toMatchObject({
                    id: run.id,
                    status: "completed",
                    tasks: [
                        {
                            id: task.id,
                            status: "completed",
                            attempts: 1,
                            taskIds: [copy1.taskId, copy2.taskId],
                            childTasks: [
                                { id: copy1.taskId, status: "completed", attempt: 1 },
                                { id: copy2.taskId, status: "completed", attempt: 1 },
                            ],
                        },
                    ],
                });
                const { agentTaskResultItems } = await import("./agent-run-result-items");
                expect(agentTaskResultItems(completedRun.tasks[0].result).map((result) => result.resultId)).toStrictEqual([`${copy1.taskId}:1`, `${copy2.taskId}:1`]);
                const assets = await creative.listAssetsForUser(userId, conversation.id);
                expect(assets).toHaveLength(2);
                expect(assets.find((asset) => asset.sourceTaskId === copy1.taskId)).toMatchObject({
                    id: completed1.asset.id,
                    sourceRunId: run.id,
                    sourceTaskId: copy1.taskId,
                    ordinal: 0,
                    messageId: run.assistantMessageId,
                    metadata: { agentTaskId: task.id },
                });
                expect(assets.find((asset) => asset.sourceTaskId === copy2.taskId)).toMatchObject({
                    id: completed2.asset.id,
                    sourceRunId: run.id,
                    sourceTaskId: copy2.taskId,
                    ordinal: 0,
                    messageId: run.assistantMessageId,
                    metadata: { agentTaskId: task.id },
                });
                expect(completedRun.assetIds.toSorted()).toStrictEqual([completed1.asset.id, completed2.asset.id].toSorted());
                const successfulLogs = (await logs.listGenerationLogs({ userId })).items;
                expect(successfulLogs.map((log) => log.id).toSorted()).toStrictEqual([`image-task:${copy1.taskId}`, `image-task:${copy2.taskId}`].toSorted());
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(financial);
                if (provider === "file") {
                    expect(await readFile(path.join(directory, "auth.json"))).toEqual(chargedAuth);
                } else expect(await postgresAccountSnapshot()).toStrictEqual(chargedAuth);
                expect(created).toHaveLength(2);
                const settled = await ownedRows(conversation.id);
                expect(settled.rows).toHaveLength(5);
                const finalResponse = await fetch(`${origin}/api/agent/runs/${run.id}`, { headers: { cookie: boundary.cookie } });
                expect(finalResponse.status).toBe(200);
                const finalText = await finalResponse.text();
                expect(JSON.parse(finalText)).toMatchObject({ code: 0, data: { run: { id: run.id, status: "completed", tasks: [{ id: task.id, status: "completed" }] } } });
                expect(finalText).not.toContain(dataUrl(native1));
                expect(finalText).not.toContain(dataUrl(native2));
                expect(await service.completeImageProcessingTask(completed1.job.id, completed1.worker.completion)).toStrictEqual(completed1.worker.receipt);
                expect(await service.completeImageProcessingTask(completed2.job.id, completed2.worker.completion)).toStrictEqual(completed2.worker.receipt);
                expect(await recovery.runGenerationTaskRecoveryBatch(completed1.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                expect(await recovery.runGenerationTaskRecoveryBatch(completed2.recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                expect(await runtime.persistImageTaskResult(completed1.published, origin, "inline://image-task-result", boundary.cookie)).toStrictEqual(completed1.published);
                expect(await runtime.persistImageTaskResult(completed2.published, origin, "inline://image-task-result", boundary.cookie)).toStrictEqual(completed2.published);
                expect(await ownedRows(conversation.id)).toStrictEqual(settled);
            });
        }, 120_000);

        if (provider === "file")
            it("R03 repairs one linked result copy after task truth commits and its actor exits before runtime projection", async () => {
                const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Result fact projection gap" });
                const initial = (await runs.createAgentRun(userId, { clientRequestId: `fixture-r03-${randomUUID()}`, conversationId: conversation.id, surface: "chat", prompt: "Generate one ordinary image", assetIds: [], skillIds: [], modelIds: [] })).run;
                const task: AgentRunTask = {
                    id: "declared-r03-image",
                    type: "image",
                    title: "Original result copy",
                    model: imageModelId,
                    prompt: "Generate an ordinary image",
                    count: 1,
                    ratio: "1024x1024",
                    quality: "low",
                    dependencies: [],
                    status: "ready",
                    attempts: 0,
                };
                const executorId = "fixture-r03-original-agent-executor";
                const run = await runs.updateAgentRunById(initial.id, { status: "running", executionId: executorId, tasks: [task], reviewed: true });
                assert.ok(run);
                await withImageRoutes(run, task, async (origin, created) => {
                    expect(await execution.runTaskWithRetry(run.id, task, origin, boundary.cookie, executorId)).toBe("deferred");
                    expect(created).toHaveLength(1);
                    const copy = created[0];
                    assert.ok(copy);
                    const native = await solid("#abcdef");
                    const prepared = await waitForCopy(copy.taskId, native, origin);
                    assert.ok(prepared.waiting.resultProcessing);
                    const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
                    const configured = imageProcessingResourceConfig(process.env);
                    const workerId = "fixture-r03-closed-result-worker";
                    const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
                    expect(claimed.tasks).toHaveLength(1);
                    const child = claimed.tasks[0];
                    assert.ok(child);
                    expect(child.id).toBe(prepared.waiting.resultProcessing.jobId);
                    // A controlled closed report supplies the durable fact; this is not an actual OOM test.
                    expect(
                        await service.failImageProcessingTask(child.id, {
                            workerId,
                            executionId: child.executionId,
                            failure: { status: "resource_failure", jobId: child.id, executionId: child.executionId, pid: 4321, exitCode: 134, signal: null, stderr: "controlled R03 closed Worker report", reason: "v8_heap_oom" },
                        }),
                    ).toStrictEqual({ jobId: child.id, status: "paused", executionPhase: "needs_review" });
                    const sourceImage = await imageTasks.getImageTask(copy.taskId);
                    const sourceChild = await tasks.getStoredGenerationTaskRecord("image_processing", child.id);
                    const beforeRuntimeBytes = await readFile(path.join(directory, "creative-runtime.json"));
                    const beforeRuntime = JSON.parse(beforeRuntimeBytes.toString("utf8")) as RuntimeFileDatabase;
                    const beforeAuth = await readFile(path.join(directory, "auth.json"));

                    async function actor(command: "project_result_copy" | "public_read") {
                        const resultKey = randomUUID();
                        const input = { command, provider, fixtureDirectory: directory, origin, cookie: boundary.cookie.slice("vozeb_pro_session=".length), resultKey, runId: initial.id, conversationId: conversation.id, logicalTaskId: task.id };
                        const processActor = spawn(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "src/lib/server/ecommerce-process-fixture.test.ts", "--no-file-parallelism", "--reporter=dot"], {
                            cwd: process.cwd(),
                            env: { ...process.env, VOZEB_PRO_ECOMMERCE_PROCESS_INPUT: JSON.stringify(input) },
                            stdio: ["ignore", "pipe", "pipe"],
                        });
                        let output = "";
                        processActor.stdout.on("data", (chunk) => (output += chunk));
                        processActor.stderr.on("data", (chunk) => (output += chunk));
                        const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
                            processActor.once("error", reject);
                            processActor.once("close", (code, signal) => resolve({ code, signal }));
                        });
                        if (command === "project_result_copy") {
                            expect(closed.code).not.toBe(0);
                            const boundaryEvidence = JSON.parse(await readFile(path.join(directory, `r03-${resultKey}-boundary.json`), "utf8")) as { pid: number; nextRuntime: RuntimeFileDatabase };
                            expect(boundaryEvidence.pid).not.toBe(process.pid);
                            return { resultKey, pid: boundaryEvidence.pid };
                        }
                        expect(closed.code, output.replaceAll(input.cookie, "[redacted]")).toBe(0);
                        const read = JSON.parse(await readFile(path.join(directory, `r03-${resultKey}.json`), "utf8")) as { pid: number; outcome: { status: number; body: unknown }; publicEvents: CreativeRunEvent[] };
                        return { resultKey, pid: read.pid, read };
                    }

                    const interrupted = await actor("project_result_copy");
                    const applied = await runs.getAgentRun(run.id);
                    // First product assertion: the current generic updater writes runtime before task truth.
                    expect(applied?.tasks[0], "RED: task truth and its actual copy fact must survive the pre-runtime actor exit").toMatchObject({
                        id: task.id,
                        status: "needs_review",
                        attempts: 1,
                        taskIds: [copy.taskId],
                        childTasks: [
                            { id: copy.taskId, status: "needs_review", attempt: 1, imageProcessingFact: { jobId: child.id, inputDigest: prepared.waiting.resultProcessing.inputDigest, factIdentity: expect.any(String), eventType: "task.needs_review" } },
                        ],
                    });
                    assert.ok(applied);
                    expect(await readFile(path.join(directory, "creative-runtime.json"))).toEqual(beforeRuntimeBytes);
                    const truthBeforeGet = await readFile(path.join(directory, tasks.GENERATION_TASK_FILE));
                    expect(await imageTasks.getImageTask(copy.taskId)).toStrictEqual(sourceImage);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", child.id)).toStrictEqual(sourceChild);

                    const runtimeLock = await stat(path.join(directory, "creative-runtime.json.lock"));
                    // Wait for the existing production stale window; the new actor recovers the real lock.
                    const staleLockWaitMs = Math.min(60_000, Math.max(0, runtimeLock.mtimeMs + 60_000 - Date.now()));
                    await new Promise((resolve) => setTimeout(resolve, staleLockWaitMs));
                    const first = await actor("public_read");
                    assert.ok(first.read);
                    expect(first.pid).not.toBe(interrupted.pid);
                    expect(first.read.outcome.status).toBe(200);
                    expect(first.read.outcome.body).toMatchObject({
                        code: 0,
                        data: { run: { id: run.id, conversationId: conversation.id, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, tasks: [{ id: task.id, status: "needs_review" }] } },
                    });
                    expect(JSON.stringify(first.read.outcome.body)).not.toContain("imageProcessingFact");
                    expect(JSON.stringify(first.read.publicEvents)).not.toContain("imageProcessingProjectionKey");
                    const repairedRuntimeBytes = await readFile(path.join(directory, "creative-runtime.json"));
                    const repairedRuntime = JSON.parse(repairedRuntimeBytes.toString("utf8")) as RuntimeFileDatabase;
                    expect(repairedRuntime.events).toHaveLength(beforeRuntime.events.length + 1);
                    expect(repairedRuntime.events.at(-1)).toMatchObject({ runId: run.id, type: "task.needs_review", data: { taskId: task.id, imageProcessingProjectionKey: expect.any(String) } });
                    expect(repairedRuntime.messages.map((message) => message.id)).toStrictEqual(beforeRuntime.messages.map((message) => message.id));
                    expect(repairedRuntime.messages.find((message) => message.id === run.inputMessageId)).toStrictEqual(beforeRuntime.messages.find((message) => message.id === run.inputMessageId));
                    expect(repairedRuntime.messages.find((message) => message.id === run.assistantMessageId)).toMatchObject({ id: run.assistantMessageId, role: "assistant", runId: run.id, content: applied.tasks[0].error, status: "running" });
                    expect(await readFile(path.join(directory, tasks.GENERATION_TASK_FILE))).toEqual(truthBeforeGet);

                    const second = await actor("public_read");
                    assert.ok(second.read);
                    expect(second.pid).not.toBe(first.pid);
                    expect(second.read.outcome).toStrictEqual(first.read.outcome);
                    expect(second.read.publicEvents).toStrictEqual(first.read.publicEvents);
                    expect(await readFile(path.join(directory, "creative-runtime.json"))).toEqual(repairedRuntimeBytes);
                    expect(await readFile(path.join(directory, tasks.GENERATION_TASK_FILE))).toEqual(truthBeforeGet);
                    expect(await readFile(path.join(directory, "auth.json"))).toEqual(beforeAuth);
                    expect(await readFile(prepared.nativePath)).toEqual(native);
                    expect(created).toHaveLength(1);
                });
            }, 120_000);

        it("S4 projects and explicitly resumes an unclaimed PNG admission pause on the same result job", async () => {
            await withDispatchedCopies(1, async (run, task, executorId, origin, copies) => {
                const copy = copies[1];
                const native = await solid("#aabbcc");
                const prepared = await prepareNativeCopy(copy.taskId, native, origin);
                assert.ok(prepared.requested.nativeResults);
                const nativeSlot = prepared.requested.nativeResults.slots[0];
                assert.ok(nativeSlot.status === "stored");
                const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                const nativePath = path.join(REFERENCE_MEDIA_ROOT, nativeSlot.storageKey);
                expect(await readFile(nativePath)).toEqual(native);
                const nativeRegistration = await registrations.getLocalMediaRegistration(nativeSlot.storageKey);
                const sibling = await imageTasks.getImageTask(copies[0].taskId);
                const financial = await auth.listPointRecordsPage(userId, { pageSize: 50 });

                vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "64");
                const [admission] = await Promise.allSettled([runtime.persistImageTaskResult(prepared.requested, origin, prepared.resultUrl, boundary.cookie)]);
                const stages = await tasks.queryStoredGenerationTasks("image_processing", { userId });
                expect(stages, "RED: a naturally over-budget PNG result must commit one unclaimed paused job").toHaveLength(1);
                const image = await imageTasks.getImageTask(copy.taskId);
                assert.ok(image?.nativeResults && image.resultProcessing);
                const paused = await tasks.getStoredGenerationTaskRecord("image_processing", image.resultProcessing.jobId);
                assert.ok(paused);
                expect(admission).toMatchObject({ status: "fulfilled", value: { id: copy.taskId, status: "running" } });
                expect(paused).toMatchObject({
                    id: image.resultProcessing.jobId,
                    parentTaskId: copy.taskId,
                    runId: run.id,
                    status: "paused",
                    executionPhase: "needs_review",
                    payload: {
                        operation: "process_result",
                        inputDigest: image.resultProcessing.inputDigest,
                        imageResultBinding: { imageTaskId: copy.taskId, nativeResults: image.nativeResults, run: { runId: run.id, agentTaskId: task.id, agentAttempt: 1 } },
                        resource: { configuration: { budgetBytes: 67108864 }, unavailable: { code: "image_processing_resource_unavailable", reason: "exceeds_total_budget" } },
                    },
                });
                expect(paused.id).toBe(`image-process-${image.resultProcessing.inputDigest}`);
                expect(paused.payload.executionId).toBeUndefined();
                expect(paused.workerId).toBeUndefined();
                expect(paused.leaseUntil).toBeUndefined();
                expect(paused.nextPollAt).toBeUndefined();
                expect(image).toMatchObject({
                    id: copy.taskId,
                    status: "running",
                    nativeResults: prepared.requested.nativeResults,
                    upstream: prepared.requested.upstream,
                    attemptNo: 1,
                    attempts: prepared.requested.attempts,
                    billing: prepared.requested.billing,
                });
                expect(image.result).toBeUndefined();
                const imageRecord = await tasks.getStoredGenerationTaskRecord("image", copy.taskId);
                expect(imageRecord).toMatchObject({ status: "running", executionPhase: "needs_review", resultPayload: { reviewReason: expect.any(String) } });
                expect(imageRecord?.payload.executionId).toBeUndefined();
                expect(imageRecord?.workerId).toBeUndefined();
                expect(imageRecord?.leaseUntil).toBeUndefined();
                expect(imageRecord?.nextPollAt).toBeUndefined();
                const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
                const refusedResource = imageProcessingResourceConfig(process.env);
                expect(await service.claimImageProcessingTasks({ workerId: "fixture-unclaimed-budget", profileVersion: refusedResource.profileVersion, availableMemoryBytes: refusedResource.budgetBytes, slots: 1 })).toStrictEqual({ tasks: [] });

                const pending = await runs.getAgentRun(run.id);
                assert.ok(pending);
                expect(await execution.runTaskWithRetry(run.id, pending.tasks[0], origin, boundary.cookie, executorId)).toBe("needs_review");
                const applied = await runs.getAgentRun(run.id);
                assert.ok(applied);
                expect(applied.tasks[0]).toMatchObject({
                    id: task.id,
                    attempts: 1,
                    status: "needs_review",
                    childTasks: [
                        { id: copies[0].taskId, status: "pending", attempt: 1 },
                        { id: copy.taskId, status: "needs_review", attempt: 1, imageProcessingFact: { jobId: paused.id, inputDigest: image.resultProcessing.inputDigest, factIdentity: expect.any(String), eventType: "task.needs_review" } },
                    ],
                });
                expect(applied.tasks[0].childTasks?.[0].imageProcessingFact).toBeUndefined();
                const fact = applied.tasks[0].childTasks?.[1].imageProcessingFact;
                assert.ok(fact);
                const receipts = await r03Receipts(run.id);
                expect(receipts).toHaveLength(1);
                const publicRun = await r03Get(run.id, origin);
                expect(publicRun.status).toBe(200);
                const publicBody = await publicRun.json();
                expect(publicBody).toMatchObject({ code: 0, data: { run: { id: run.id, tasks: [{ id: task.id, status: "needs_review" }] } } });
                expect(JSON.stringify(publicBody)).not.toContain("imageProcessingFact");
                const { publicAgentRunEvent } = await import("./agent-run-public");
                const publicEvent = publicAgentRunEvent(receipts[0]);
                expect(publicEvent).toMatchObject({ id: receipts[0].id, runId: run.id, type: "task.needs_review", data: { taskId: task.id } });
                expect(JSON.stringify(publicEvent)).not.toMatch(/imageProcessingProjectionKey|imageProcessingFact|exceeds_total_budget/);

                const beforeCheck = await ownedRows(run.conversationId);
                const sameConfiguration = await fetch(`${origin}/api/image-tasks/${copy.taskId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) });
                expect(sameConfiguration.status).toBe(409);
                expect(await ownedRows(run.conversationId)).toStrictEqual(beforeCheck);
                expect(await r03Receipts(run.id)).toStrictEqual(receipts);

                vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
                const recovered = await fetch(`${origin}/api/image-tasks/${copy.taskId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) });
                expect(recovered.status).toBe(200);
                expect(await imageTasks.getImageTask(copy.taskId)).toMatchObject({
                    id: copy.taskId,
                    status: "running",
                    resultProcessing: image.resultProcessing,
                    nativeResults: image.nativeResults,
                    upstream: image.upstream,
                    attemptNo: 1,
                    attempts: image.attempts,
                    billing: image.billing,
                });
                const admittedResource = imageProcessingResourceConfig(process.env);
                const queued = await tasks.getStoredGenerationTaskRecord("image_processing", paused.id);
                expect(queued).toMatchObject({
                    id: paused.id,
                    status: "pending",
                    executionPhase: "created",
                    payload: { inputDigest: image.resultProcessing.inputDigest, resource: { profileVersion: admittedResource.profileVersion, configuration: { budgetBytes: 6442450944 } } },
                });
                expect(queued?.payload.executionId).toBeUndefined();
                expect(queued?.workerId).toBeUndefined();
                expect(queued?.leaseUntil).toBeUndefined();
                const firstClaim = await claimR03Child(paused.id);
                expect(firstClaim.child.executionId).toEqual(expect.any(String));
                expect(firstClaim.child.payload.executionId).toBe(firstClaim.child.executionId);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", paused.id)).toMatchObject({ status: "running", workerId: firstClaim.workerId, payload: { executionId: firstClaim.child.executionId } });
                expect(await readFile(nativePath)).toEqual(native);
                expect(await registrations.getLocalMediaRegistration(nativeSlot.storageKey)).toStrictEqual(nativeRegistration);
                expect(await imageTasks.getImageTask(copies[0].taskId)).toStrictEqual(sibling);
                expect(await r03Receipts(run.id)).toStrictEqual(receipts);
                expect((await runs.getAgentRun(run.id))?.tasks[0].childTasks?.[1].imageProcessingFact).toStrictEqual(fact);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50 })).toStrictEqual(financial);
                expect(charges.size).toBe(1);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
                expect(boundary.model).not.toHaveBeenCalled();
                expect(copies).toHaveLength(2);
            });
        }, 120_000);

        it("R03 projects only the observed copy and gives its explicit local retry a new fact on the same job", async () => {
            await withDispatchedCopies(1, async (run, task, executorId, origin, copies) => {
                const copy = copies[1];
                const prepared = await waitForCopy(copy.taskId, await solid("#aabbcc"), origin);
                assert.ok(prepared.waiting.resultProcessing);
                const firstChild = await pauseR03Child(prepared.waiting.resultProcessing.jobId);
                const unapplied = await ownedRows(run.conversationId);
                expect((await r03Get(run.id, origin)).status).toBe(200);
                expect(await ownedRows(run.conversationId)).toStrictEqual(unapplied);
                expect(await r03Receipts(run.id)).toStrictEqual([]);

                const pending = await runs.getAgentRun(run.id);
                assert.ok(pending);
                expect(await execution.runTaskWithRetry(run.id, pending.tasks[0], origin, boundary.cookie, executorId)).toBe("needs_review");
                const first = await runs.getAgentRun(run.id);
                assert.ok(first);
                expect(first.tasks[0]).toMatchObject({
                    attempts: 1,
                    status: "needs_review",
                    childTasks: [
                        { id: copies[0].taskId, status: "pending", attempt: 1 },
                        { id: copy.taskId, status: "needs_review", attempt: 1, imageProcessingFact: { jobId: firstChild.id, eventType: "task.needs_review" } },
                    ],
                });
                expect(first.tasks[0].childTasks?.[0].imageProcessingFact).toBeUndefined();
                const firstFact = first.tasks[0].childTasks?.[1].imageProcessingFact;
                assert.ok(firstFact);
                const firstReceipts = await r03Receipts(run.id);
                expect(firstReceipts).toHaveLength(1);
                const finance = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });

                vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
                const recoveryResponse = await fetch(`${origin}/api/image-tasks/${copy.taskId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) });
                expect(recoveryResponse.status).toBe(200);
                const secondChild = await pauseR03Child(firstChild.id);
                expect(secondChild.executionId).not.toBe(firstChild.executionId);
                const newUnapplied = await ownedRows(run.conversationId);
                expect((await r03Get(run.id, origin)).status).toBe(200);
                expect(await ownedRows(run.conversationId)).toStrictEqual(newUnapplied);
                expect(await r03Receipts(run.id)).toStrictEqual(firstReceipts);

                const retrying = await runs.getAgentRun(run.id);
                assert.ok(retrying);
                expect(await execution.runTaskWithRetry(run.id, retrying.tasks[0], origin, boundary.cookie, executorId)).toBe("needs_review");
                const second = await runs.getAgentRun(run.id);
                assert.ok(second);
                expect(second.tasks[0]).toMatchObject({
                    id: task.id,
                    attempts: 1,
                    status: "needs_review",
                    childTasks: [
                        { id: copies[0].taskId, status: "pending", attempt: 1 },
                        { id: copy.taskId, status: "needs_review", attempt: 1, imageProcessingFact: { jobId: firstFact.jobId, inputDigest: firstFact.inputDigest, eventType: "task.needs_review" } },
                    ],
                });
                expect(second.tasks[0].childTasks?.[1].imageProcessingFact?.factIdentity).not.toBe(firstFact.factIdentity);
                expect(await r03Receipts(run.id)).toHaveLength(2);
                const settled = await ownedRows(run.conversationId);
                expect((await r03Get(run.id, origin)).status).toBe(200);
                expect((await r03Get(run.id, origin)).status).toBe(200);
                expect(await ownedRows(run.conversationId)).toStrictEqual(settled);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(finance);
                expect(copies).toHaveLength(2);
            });
        }, 120_000);

        if (provider === "postgres")
            it("R03 rolls back the Run pointer, receipt and original assistant together when its real PostgreSQL receipt insert fails", async () => {
                await withDispatchedCopies(1, async (run, _task, executorId, origin, copies) => {
                    const prepared = await waitForCopy(copies[1].taskId, await solid("#223344"), origin);
                    assert.ok(prepared.waiting.resultProcessing);
                    await pauseR03Child(prepared.waiting.resultProcessing.jobId);
                    const before = await ownedRows(run.conversationId);
                    const name = `fixture_r03_${randomUUID().replaceAll("-", "")}`;
                    await database.postgresQuery(
                        `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = TG_ARGV[0] AND NEW.data ? 'imageProcessingProjectionKey' THEN RAISE EXCEPTION 'controlled R03 receipt failure'; END IF; RETURN NEW; END; $$`,
                    );
                    try {
                        await database.postgresQuery(`CREATE TRIGGER "${name}" BEFORE INSERT ON creative_run_events FOR EACH ROW EXECUTE FUNCTION "${name}"('${run.id}')`);
                        try {
                            const current = await runs.getAgentRun(run.id);
                            assert.ok(current);
                            expect(await execution.runTaskWithRetry(run.id, current.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                            expect(await ownedRows(run.conversationId)).toStrictEqual(before);
                        } finally {
                            await database.postgresQuery(`DROP TRIGGER "${name}" ON creative_run_events`);
                        }
                    } finally {
                        await database.postgresQuery(`DROP FUNCTION "${name}"()`);
                    }
                    const retry = await runs.getAgentRun(run.id);
                    assert.ok(retry);
                    expect(await execution.runTaskWithRetry(run.id, retry.tasks[0], origin, boundary.cookie, executorId)).toBe("needs_review");
                    expect(await r03Receipts(run.id)).toHaveLength(1);
                    const runtimeStore = await import("./creative-runtime-store");
                    const applied = await runs.getAgentRun(run.id);
                    expect((await runtimeStore.listCreativeMessages(run.conversationId)).find((message) => message.id === run.assistantMessageId)).toMatchObject({ id: run.assistantMessageId, content: applied?.tasks[0].error });
                    const settled = await ownedRows(run.conversationId);
                    expect((await r03Get(run.id, origin)).status).toBe(200);
                    expect(await ownedRows(run.conversationId)).toStrictEqual(settled);
                });
            }, 120_000);

        if (provider === "file") {
            it("R03 defers a copy fact replaced after the real image GET read and applies only a later observed fact", async () => {
                await withDispatchedCopies(1, async (run, _task, executorId, origin, copies) => {
                    const prepared = await waitForCopy(copies[1].taskId, await solid("#123abc"), origin);
                    assert.ok(prepared.waiting.resultProcessing);
                    const first = await pauseR03Child(prepared.waiting.resultProcessing.jobId);
                    r03ProjectionRead.afterImageGet = async (imageId) => {
                        if (imageId !== copies[1].taskId) return;
                        r03ProjectionRead.afterImageGet = undefined;
                        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
                        const detail = await import("@/app/api/image-tasks/[id]/route");
                        const recovered = await detail.POST(new Request(`${origin}/api/image-tasks/${imageId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
                            params: Promise.resolve({ id: imageId }),
                        });
                        expect(recovered.status).toBe(200);
                        const second = await pauseR03Child(first.id);
                        expect(second.executionId).not.toBe(first.executionId);
                    };
                    const pending = await runs.getAgentRun(run.id);
                    assert.ok(pending);
                    expect(await execution.runTaskWithRetry(run.id, pending.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                    const deferred = await runs.getAgentRun(run.id);
                    assert.ok(deferred);
                    expect(deferred.tasks[0]).toMatchObject({
                        status: "running",
                        attempts: 1,
                        childTasks: [
                            { id: copies[0].taskId, status: "pending" },
                            { id: copies[1].taskId, status: "pending" },
                        ],
                    });
                    expect(deferred.tasks[0].childTasks?.[1].imageProcessingFact).toBeUndefined();
                    expect(await r03Receipts(run.id)).toStrictEqual([]);
                    expect(await execution.runTaskWithRetry(run.id, deferred.tasks[0], origin, boundary.cookie, executorId)).toBe("needs_review");
                    expect(await r03Receipts(run.id)).toHaveLength(1);
                    expect((await runs.getAgentRun(run.id))?.tasks[0].childTasks?.[1]).toMatchObject({ status: "needs_review", imageProcessingFact: { jobId: first.id } });
                });
            }, 120_000);

            it("R03 repairs the saved copy through its authenticated action only after permission and conversation checks", async () => {
                await withDispatchedCopies(1, async (run, _task, executorId, origin, copies) => {
                    const prepared = await waitForCopy(copies[1].taskId, await solid("#334455"), origin);
                    assert.ok(prepared.waiting.resultProcessing);
                    await pauseR03Child(prepared.waiting.resultProcessing.jobId);
                    r03ProjectionWrite.runId = run.id;
                    const pending = await runs.getAgentRun(run.id);
                    assert.ok(pending);
                    expect(await execution.runTaskWithRetry(run.id, pending.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                    const applied = await runs.getAgentRun(run.id);
                    expect(applied?.tasks[0].childTasks?.[1]).toMatchObject({ id: copies[1].taskId, status: "needs_review", imageProcessingFact: { eventType: "task.needs_review" } });
                    expect(await r03Receipts(run.id)).toStrictEqual([]);
                    const before = await ownedRows(run.conversationId);
                    const cookie = boundary.cookie;
                    boundary.cookie = "";
                    try {
                        expect((await r03Get(run.id, origin)).status).toBe(401);
                    } finally {
                        boundary.cookie = cookie;
                    }
                    const action = await import("@/app/api/agent/runs/[id]/[action]/route");
                    const mismatch = await action.POST(
                        new Request(`${origin}/api/agent/runs/${run.id}/pause`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ conversationId: "different-conversation" }) }),
                        { params: Promise.resolve({ id: run.id, action: "pause" }) },
                    );
                    expect(mismatch.status).toBe(409);
                    expect(await ownedRows(run.conversationId)).toStrictEqual(before);
                    const paused = await action.POST(new Request(`${origin}/api/agent/runs/${run.id}/pause`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ conversationId: run.conversationId }) }), {
                        params: Promise.resolve({ id: run.id, action: "pause" }),
                    });
                    expect(paused.status).toBe(200);
                    expect(await paused.json()).toMatchObject({ code: 0, data: { run: { id: run.id, status: "paused", inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId } } });
                    expect(await r03Receipts(run.id)).toHaveLength(1);
                    const settled = await ownedRows(run.conversationId);
                    expect((await r03Get(run.id, origin)).status).toBe(200);
                    expect(await ownedRows(run.conversationId)).toStrictEqual(settled);
                });
            }, 120_000);

            it("R03 leaves a missing copy receipt untouched after the real Run cancellation transition", async () => {
                await withDispatchedCopies(1, async (run, _task, executorId, origin, copies) => {
                    const prepared = await waitForCopy(copies[1].taskId, await solid("#445566"), origin);
                    assert.ok(prepared.waiting.resultProcessing);
                    await pauseR03Child(prepared.waiting.resultProcessing.jobId);
                    r03ProjectionWrite.runId = run.id;
                    const pending = await runs.getAgentRun(run.id);
                    assert.ok(pending);
                    expect(await execution.runTaskWithRetry(run.id, pending.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                    const current = await runs.getAgentRun(run.id);
                    assert.ok(current);
                    expect(await runs.setAgentRunStatus(current, "cancelled")).toMatchObject({ status: "cancelled" });
                    const cancelled = await ownedRows(run.conversationId);
                    expect((await r03Get(run.id, origin)).status).toBe(200);
                    expect(await r03Receipts(run.id)).toStrictEqual([]);
                    expect(await ownedRows(run.conversationId)).toStrictEqual(cancelled);
                });
            }, 120_000);

            it("R03 does not repair a failed copy after the authenticated task retry removes its old membership", async () => {
                await withDispatchedCopies(1, async (run, task, executorId, origin, copies) => {
                    const prepared = await waitForCopy(copies[1].taskId, await solid("#556677"), origin);
                    assert.ok(prepared.waiting.resultProcessing);
                    await rejectR03Child(prepared.waiting.resultProcessing.jobId);
                    r03ProjectionWrite.runId = run.id;
                    const pending = await runs.getAgentRun(run.id);
                    assert.ok(pending);
                    expect(await execution.runTaskWithRetry(run.id, pending.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                    expect((await runs.getAgentRun(run.id))?.tasks[0]).toMatchObject({
                        status: "failed",
                        childTasks: [
                            { id: copies[0].taskId, status: "pending" },
                            { id: copies[1].taskId, status: "failed", imageProcessingFact: { eventType: "task.child.failed" } },
                        ],
                    });
                    const retry = await import("@/app/api/agent/runs/[id]/tasks/[taskId]/retry/route");
                    const response = await retry.POST(
                        new Request(`${origin}/api/agent/runs/${run.id}/tasks/${task.id}/retry`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ conversationId: run.conversationId }) }),
                        { params: Promise.resolve({ id: run.id, taskId: task.id }) },
                    );
                    expect(response.status).toBe(200);
                    expect((await runs.getAgentRun(run.id))?.tasks[0]).toMatchObject({ status: "ready", attempts: 1 });
                    const retried = await ownedRows(run.conversationId);
                    expect((await r03Get(run.id, origin)).status).toBe(200);
                    expect(await r03Receipts(run.id)).toStrictEqual([]);
                    expect(await ownedRows(run.conversationId)).toStrictEqual(retried);
                });
            }, 120_000);

            it("R03 repairs an applied completion after natural Run completion and filters its receipt from the real SSE", async () => {
                const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Completed result receipt" });
                const initial = (
                    await runs.createAgentRun(userId, { clientRequestId: `fixture-r03-completion-${randomUUID()}`, conversationId: conversation.id, surface: "chat", prompt: "Generate one ordinary image", assetIds: [], skillIds: [], modelIds: [] })
                ).run;
                const task: AgentRunTask = {
                    id: "r03-completion-image",
                    type: "image",
                    title: "Completion copy",
                    model: imageModelId,
                    prompt: "Generate an ordinary image",
                    count: 1,
                    ratio: "1024x1024",
                    quality: "low",
                    dependencies: [],
                    status: "ready",
                    attempts: 0,
                };
                const executorId = "fixture-r03-completion-executor";
                const run = await runs.updateAgentRunById(initial.id, { status: "running", executionId: executorId, tasks: [task], reviewed: true });
                assert.ok(run);
                await withImageRoutes(run, task, async (origin, created) => {
                    expect(await execution.runTaskWithRetry(run.id, task, origin, boundary.cookie, executorId)).toBe("deferred");
                    expect(created).toHaveLength(1);
                    const prepared = await waitForCopy(created[0].taskId, await solid("#667788"), origin);
                    const completed = await completeCopy(prepared, run, origin);
                    r03ProjectionWrite.runId = run.id;
                    const pending = await runs.getAgentRun(run.id);
                    assert.ok(pending);
                    expect(await execution.runTaskWithRetry(run.id, pending.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                    expect((await runs.getAgentRun(run.id))?.tasks[0]).toMatchObject({
                        attempts: 1,
                        childTasks: [{ id: created[0].taskId, status: "completed", attempt: 1, imageProcessingFact: { jobId: completed.job.id, eventType: "task.child.completed" } }],
                    });
                    expect(await r03Receipts(run.id)).toStrictEqual([]);
                    await execution.executeTasks(run.id, origin, boundary.cookie, executorId);
                    const natural = await runs.getAgentRun(run.id);
                    expect(natural).toMatchObject({ status: "completed", inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, tasks: [{ id: task.id, status: "completed", attempts: 1 }] });
                    const runtimeStore = await import("./creative-runtime-store");
                    const originalAssistant = (await runtimeStore.listCreativeMessages(run.conversationId)).find((message) => message.id === run.assistantMessageId);
                    assert.ok(originalAssistant);
                    expect(originalAssistant.metadata).toMatchObject({ assetIds: [completed.asset.id], taskIds: [created[0].taskId] });
                    expect(await r03Receipts(run.id)).toStrictEqual([]);
                    const truth = await readFile(path.join(directory, tasks.GENERATION_TASK_FILE));
                    const response = await r03Get(run.id, origin);
                    expect(response.status).toBe(200);
                    expect(await response.json()).toMatchObject({ code: 0, data: { run: { id: run.id, status: "completed" } } });
                    const receipts = await r03Receipts(run.id);
                    expect(receipts).toHaveLength(1);
                    const repairedAssistant = (await runtimeStore.listCreativeMessages(run.conversationId)).find((message) => message.id === run.assistantMessageId);
                    expect(repairedAssistant?.content).toBe(originalAssistant.content);
                    expect(repairedAssistant?.metadata).toStrictEqual(originalAssistant.metadata);
                    expect(await readFile(path.join(directory, tasks.GENERATION_TASK_FILE))).toEqual(truth);
                    const events = await import("@/app/api/agent/runs/[id]/events/route");
                    const stream = await events.GET(new Request(`${origin}/api/agent/runs/${run.id}/events`), { params: Promise.resolve({ id: run.id }) });
                    const text = await stream.text();
                    expect(text).toContain("event: task.child.completed");
                    expect(text).not.toContain("imageProcessingProjectionKey");
                    expect(text).not.toContain("imageProcessingFact");
                    const reconnect = await events.GET(new Request(`${origin}/api/agent/runs/${run.id}/events`, { headers: { "last-event-id": receipts[0].id } }), { params: Promise.resolve({ id: run.id }) });
                    expect(await reconnect.text()).not.toContain("event: task.child.completed");
                    const settled = await ownedRows(run.conversationId);
                    expect((await r03Get(run.id, origin)).status).toBe(200);
                    expect(await ownedRows(run.conversationId)).toStrictEqual(settled);
                    expect(created).toHaveLength(1);
                });
            }, 120_000);
        }

        it("cancels pending and claimed original-copy result jobs through the actual Agent action and accepts the real closed Worker acknowledgement", async () => {
            await withDispatchedCopies(1, async (run, _task, _executorId, origin, copies) => {
                const prepared1 = await waitForCopy(copies[0].taskId, await solid("#112233"), origin);
                const current = await stageClosedCopy(prepared1);
                const prepared2 = await waitForCopy(copies[1].taskId, await solid("#445566"), origin);
                assert.ok(prepared2.waiting.resultProcessing);
                const financial = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                await requestRunCancellation(run, origin);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toMatchObject({
                    status: "cancelled",
                    executionPhase: "cancel_requested",
                    workerId: current.identity.workerId,
                    payload: { executionId: current.identity.executionId },
                });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepared2.waiting.resultProcessing.jobId)).toMatchObject({ status: "cancelled", executionPhase: "completed" });
                expect(await service.claimImageProcessingTasks({ workerId: "fixture-after-cancel", profileVersion: current.child.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 })).toStrictEqual({ tasks: [] });
                const heartbeat = await import("@/app/api/maintenance/image-processing/[id]/heartbeat/route");
                const postHeartbeat = (body: unknown) =>
                    heartbeat.POST(
                        new Request(`http://localhost/api/maintenance/image-processing/${current.child.id}/heartbeat`, {
                            method: "POST",
                            headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                            body: JSON.stringify(body),
                        }),
                        { params: Promise.resolve({ id: current.child.id }) },
                    );
                const stopping = await postHeartbeat(current.identity);
                expect(stopping.status).toBe(200);
                expect(await stopping.json()).toMatchObject({ code: 0, data: { cancelRequested: true } });
                const beforeLate = await ownedRows(run.conversationId);
                await expect(
                    service.writeImageProcessingOutput(current.child.id, "final", current.identity, { mimeType: "image/png", resultId: `${prepared1.waiting.id}:1`, stream: new Response(new Uint8Array(current.bytes)).body! }),
                ).rejects.toMatchObject({
                    status: 409,
                });
                await expect(service.completeImageProcessingTask(current.child.id, current.completion)).rejects.toMatchObject({ status: 409 });
                expect(await ownedRows(run.conversationId)).toStrictEqual(beforeLate);
                const closing = { ...current.identity, closed: current.closed, stopCause: null };
                const acknowledged = await postHeartbeat(closing);
                expect(acknowledged.status).toBe(200);
                const receipt = { code: 0, data: { jobId: current.child.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" }, msg: "OK" };
                expect(await acknowledged.json()).toStrictEqual(receipt);
                const settled = await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id);
                expect(settled).toMatchObject({ status: "cancelled", executionPhase: "completed", resultPayload: { cancelClose: { closed: current.closed, stopCause: null } } });
                expect(settled?.workerId).toBeUndefined();
                expect(settled?.leaseUntil).toBeUndefined();
                expect(await (await postHeartbeat(closing)).json()).toStrictEqual(receipt);
                expect(await registrations.getLocalMediaRegistration(current.stored.storageKey)).toMatchObject({ storageClass: "temporary", taskId: current.child.id, runId: run.id });
                expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual([]);
                expect(await creative.listAssetsForUser(userId, run.conversationId)).toStrictEqual([]);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(financial);
                expect(await imageTasks.getImageTask(prepared1.waiting.id)).toMatchObject({ status: "cancelled", nativeResults: prepared1.waiting.nativeResults, billing: prepared1.waiting.billing, attempts: prepared1.waiting.attempts });
                expect(await imageTasks.getImageTask(prepared2.waiting.id)).toMatchObject({ status: "cancelled", nativeResults: prepared2.waiting.nativeResults, billing: prepared2.waiting.billing, attempts: prepared2.waiting.attempts });
            });
        }, 120_000);

        it("defers a sealed native from the real POST-before-link window and recovers the same submission after actual membership is visible", async () => {
            const native = await solid("#778899");
            let original: Awaited<ReturnType<typeof prepareNativeCopy>> | undefined;
            await withDispatchedCopies(
                1,
                async (run, task, _executorId, origin, copies) => {
                    assert.ok(original);
                    const before = await imageTasks.getImageTask(copies[0].taskId);
                    assert.ok(before?.nativeResults);
                    expect(before).toMatchObject({ runId: run.id, parentTaskId: run.id, status: "running", nativeResults: original.requested.nativeResults, billing: original.submitted.billing, attempts: original.submitted.attempts });
                    const linked = await runs.getAgentRun(run.id);
                    expect(linked).toMatchObject({ tasks: [{ id: task.id, childTasks: expect.arrayContaining([{ id: before.id, status: "pending", attempt: 1 }]) }] });
                    const detail = await import("@/app/api/image-tasks/[id]/route");
                    const recovered = await detail.POST(new Request(`${origin}/api/image-tasks/${before.id}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
                        params: Promise.resolve({ id: before.id }),
                    });
                    expect(recovered.status).toBe(200);
                    const waiting = await imageTasks.getImageTask(before.id);
                    assert.ok(waiting?.resultProcessing);
                    expect(waiting).toMatchObject({ id: before.id, nativeResults: before.nativeResults, upstream: before.upstream, billing: before.billing, attempts: before.attempts, clientRequestId: before.clientRequestId });
                    const job = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.resultProcessing.jobId);
                    expect(job).toMatchObject({ parentTaskId: before.id, runId: run.id, payload: { imageResultBinding: { run: { runId: run.id, agentTaskId: task.id, agentAttempt: 1 } } } });
                    expect(charges.size).toBe(1);
                    expect(copies).toHaveLength(2);
                    expect((await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).records).toHaveLength(1);
                    const completed = await processWithWorker(waiting.resultProcessing.jobId);
                    expect(completed.receipt.parentRescheduled).toBe(true);
                    expect(await recovery.runGenerationTaskRecoveryBatch({ origin, cookie: boundary.cookie, workerId: "fixture-window-consumer", taskIds: [before.id], limit: 1 })).toMatchObject({ completed: 1, failed: 0 });
                    expect(await imageTasks.getImageTask(before.id)).toMatchObject({ status: "success", nativeResults: before.nativeResults, billing: before.billing, clientRequestId: before.clientRequestId });
                },
                async (run, task, imageId, origin) => {
                    expect(await imageTasks.getImageTask(imageId)).toMatchObject({ parentTaskId: task.id, runId: run.id });
                    original = await prepareNativeCopy(imageId, native, origin);
                    expect(await runtime.persistImageTaskResult(original.requested, origin, original.resultUrl, boundary.cookie), "A real POST result must defer until link and task.created become visible").toMatchObject({
                        status: "running",
                        nativeResults: original.requested.nativeResults,
                    });
                    const deferred = await tasks.getStoredGenerationTaskRecord("image", imageId);
                    expect(deferred).toMatchObject({ status: "running", executionPhase: "persisting", lastUpstreamStatus: "image_processing_run_link_waiting", nextPollAt: expect.any(Number) });
                    expect(deferred?.workerId).toBeUndefined();
                    expect(deferred?.leaseUntil).toBeUndefined();
                    expect(deferred?.payload.resultProcessing).toBeUndefined();
                    expect((await tasks.listStoredGenerationTaskRecords({ userId })).all.filter((record) => record.type === "image_processing")).toStrictEqual([]);
                    expect((await runs.getAgentRun(run.id))?.tasks[0].childTasks).toBeUndefined();
                    const unlinked = await ownedRows(run.conversationId);
                    expect((await r03Get(run.id, origin)).status).toBe(200);
                    expect(await r03Receipts(run.id)).toStrictEqual([]);
                    expect(await ownedRows(run.conversationId)).toStrictEqual(unlinked);
                },
            );
        }, 120_000);

        it("keeps logical retry attempt two distinct from native attempt one while a new Agent execution adopts the same Worker result", async () => {
            await withDispatchedCopies(2, async (run, task, executorId, origin, copies) => {
                const prepared = await waitForCopy(copies[0].taskId, await solid("#aabbcc"), origin);
                assert.ok(prepared.waiting.resultProcessing);
                expect(prepared.waiting.nativeResults).toMatchObject({ attemptNo: 1 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepared.waiting.resultProcessing.jobId)).toMatchObject({
                    parentTaskId: prepared.waiting.id,
                    runId: run.id,
                    payload: { imageResultBinding: { run: { runId: run.id, agentTaskId: task.id, agentAttempt: 2 } } },
                });
                const replacementId = "fixture-replacement-agent-executor";
                const replaced = await runs.updateAgentRunById(run.id, { executionId: replacementId }, undefined, ["running"], executorId);
                assert.ok(replaced);
                expect(await execution.patchTask(run.id, task.id, { status: "completed" }, "task.completed", executorId)).toBeNull();
                const completed = await completeCopy(prepared, run, origin, 2);
                const current = await runs.getAgentRun(run.id);
                assert.ok(current);
                expect(await execution.runTaskWithRetry(run.id, current.tasks[0], origin, boundary.cookie, replacementId)).toBe("deferred");
                expect(await runs.getAgentRun(run.id)).toMatchObject({
                    status: "running",
                    executionId: replacementId,
                    tasks: [
                        {
                            attempts: 2,
                            childTasks: [
                                { id: copies[0].taskId, status: "completed", attempt: 2, imageProcessingFact: { jobId: completed.job.id, inputDigest: prepared.waiting.resultProcessing.inputDigest, eventType: "task.child.completed" } },
                                { id: copies[1].taskId, status: "pending", attempt: 2 },
                            ],
                        },
                    ],
                });
                expect((await creative.listAssetsForUser(userId, run.conversationId)).find((asset) => asset.id === completed.asset.id)).toMatchObject({
                    messageId: run.assistantMessageId,
                    sourceTaskId: prepared.waiting.id,
                    metadata: { agentTaskId: task.id },
                });
                expect(charges.size).toBe(1);
                expect(copies).toHaveLength(2);
            });
        }, 120_000);

        it("refuses a frozen logical-attempt replacement after upload input I/O without registering or publishing a new result", async () => {
            await withDispatchedCopies(1, async (run, _task, executorId, origin, copies) => {
                const prepared = await waitForCopy(copies[0].taskId, await solid("#667788"), origin);
                const current = await stageClosedCopy(prepared);
                const linked = await runs.getAgentRun(run.id);
                assert.ok(linked?.tasks[0].childTasks);
                const originalTask = linked.tasks[0];
                const children = originalTask.childTasks;
                assert.ok(children);
                const imageBefore = await tasks.getStoredGenerationTaskRecord("image", prepared.waiting.id);
                const jobBefore = await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id);
                const registrationsBefore = provider === "file" ? await registrations.listFileLocalMediaRegistrations() : await postgresRegistrations();
                const financial = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                const stream = new ReadableStream<Uint8Array>(
                    {
                        async pull(controller) {
                            controller.enqueue(new Uint8Array(current.bytes));
                            const changed = await runs.updateAgentRunById(run.id, { tasks: [{ ...originalTask, attempts: 2, childTasks: [{ ...children[0], attempt: 2 }, children[1]] }] }, { type: "task.retry.requested" }, ["running"], executorId);
                            assert.ok(changed);
                            controller.close();
                        },
                    },
                    { highWaterMark: 0 },
                );
                await expect(service.writeImageProcessingOutput(current.child.id, "final", current.identity, { mimeType: "image/png", resultId: `${prepared.waiting.id}:1`, stream })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("image", prepared.waiting.id)).toStrictEqual(imageBefore);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toStrictEqual(jobBefore);
                if (provider === "file") {
                    expect(await registrations.listFileLocalMediaRegistrations()).toStrictEqual(registrationsBefore);
                } else expect(await postgresRegistrations()).toStrictEqual(registrationsBefore);
                expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual([]);
                expect(await creative.listAssetsForUser(userId, run.conversationId)).toStrictEqual([]);
                expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(financial);
                expect(await imageTasks.getImageTask(copies[1].taskId)).toMatchObject({ id: copies[1].taskId, status: "pending" });
            });
        }, 120_000);

        it("refuses completed-copy consumption after the real Run cancellation state changes without promoting or publishing the late result", async () => {
            await withDispatchedCopies(1, async (run, _task, executorId, origin, copies) => {
                const prepared = await waitForCopy(copies[0].taskId, await solid("#ddeeff"), origin);
                assert.ok(prepared.waiting.resultProcessing);
                const completed = await processWithWorker(prepared.waiting.resultProcessing.jobId);
                const consumerId = "fixture-late-copy-consumer";
                const claim = (await scheduler.claimDueGenerationTasks({ workerId: consumerId, taskIds: [prepared.waiting.id], limit: 1 }))[0];
                assert.ok(claim && typeof claim.payload.executionId === "string");
                const stopping = await runs.updateAgentRunById(
                    run.id,
                    { status: "paused", executionId: undefined, cancellation: { requestedAt: Date.now(), pendingChildTaskIds: [prepared.waiting.id] } },
                    { type: "run.cancel.requested" },
                    ["running"],
                    executorId,
                );
                assert.ok(stopping);
                const before = await ownedRows(run.conversationId);
                expect(await processing.consumeCompletedImageTaskResultProcessing({ taskId: prepared.waiting.id, workerId: consumerId, executionId: claim.payload.executionId })).toStrictEqual({ state: "ownership_lost" });
                expect(await ownedRows(run.conversationId)).toStrictEqual(before);
                expect(await registrations.getLocalMediaRegistration(completed.completion.manifest.artifacts[0].storageKey)).toMatchObject({ storageClass: "temporary", taskId: completed.child.id });
                expect(await service.completeImageProcessingTask(completed.child.id, completed.completion)).toStrictEqual(completed.receipt);
                expect(await ownedRows(run.conversationId)).toStrictEqual(before);
            });
        }, 120_000);

        it("cancels the current retry copy while preserving the retained successful Worker result from the prior logical attempt", async () => {
            await cancelHistoricalCopy(false);
        }, 120_000);

        // Let the action and all bounded cleanup waits finish before Vitest starts afterEach.
        if (provider === "postgres")
            it(
                "aborts the uniquely captured live native child of the retry copy while retaining the prior successful copy",
                async () => {
                    await cancelHistoricalCopy(true);
                },
                120_000 + 30_000 + 35_000 + 35_000 + 10_000 + 10_000 + 5 * 15_000,
            );

        it.runIf(process.platform === "linux")(
            "aborts the uniquely captured live native child of an ImageTask without a Run through the authenticated public cancel Route",
            async () => {
                const origin = "http://localhost";
                const createOriginal = () =>
                    imageTasks.createImageTask({
                        userId,
                        username: "fixture-no-run-cancel",
                        displayName: "Isolated workbench cancellation fixture",
                        kind: "generation",
                        source: "image-workbench",
                        config: { baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", apiFormat: "openai", model: imageModelId, outputBackground: "opaque" },
                        prompt: "Keep the original sealed image when its result Worker is cancelled",
                        references: [],
                        attemptNo: 1,
                        attempts: [],
                    });
                const original = await createOriginal();
                const charge = await auth.consumeUserPoints(userId, imageModelId, 1, "image", `fixture-run-copy:${original.id}`);
                const billed = await imageTasks.updateImageTask(original.id, { billing: { pointsCost: charge.cost, pointsRecordId: charge.recordId, refunded: false } });
                assert.ok(billed);
                assert.ok(await imageTasks.transitionImageTask(billed, ["pending"], { status: "running" }));
                await scheduler.scheduleGenerationTask("image", original.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
                const workerId = "fixture-no-run-original-" + randomUUID();
                const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [original.id], limit: 1 });
                expect(claimed).toHaveLength(1);
                const lease = claimed[0];
                assert.ok(lease.executionId);
                const native = await solid("#235789");
                const capture = await import("./image-task-native-capture");
                expect(
                    await capture.captureImageTaskNativeResults({ taskId: original.id, workerId, executionId: lease.executionId, attemptNo: 1, upstreamTaskId: null, result: { dataUrl: dataUrl(native) }, origin, authContext: boundary.cookie }),
                ).toMatchObject({ state: "native_ready" });
                expect(await processing.ensureImageTaskResultProcessing({ taskId: original.id, workerId, executionId: lease.executionId })).toStrictEqual({ state: "waiting" });
                const waiting = await imageTasks.getImageTask(original.id);
                assert.ok(waiting?.nativeResults && waiting.resultProcessing);
                expect(waiting.runId).toBeUndefined();
                expect(waiting.parentTaskId).toBeUndefined();
                expect(waiting.upstream).toBeUndefined();
                expect(waiting.result).toBeUndefined();
                expect(waiting.nativeResults).toMatchObject({ attemptNo: 1, upstreamTaskId: null });
                expect(waiting.nativeResults.slots).toHaveLength(1);
                const nativeSlot = waiting.nativeResults.slots[0];
                assert.ok(nativeSlot.status === "stored");
                expect(nativeSlot).toMatchObject({ resultId: `${original.id}:1`, sha256: digest(native), bytes: native.length });
                const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
                const nativePath = path.join(REFERENCE_MEDIA_ROOT, nativeSlot.storageKey);
                expect(await readFile(nativePath)).toEqual(native);
                const job = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.resultProcessing.jobId);
                assert.ok(job);
                expect(job).toMatchObject({ status: "pending", parentTaskId: original.id, userId, payload: { operation: "process_result", imageResultBinding: { imageTaskId: original.id, userId, nativeResults: waiting.nativeResults } } });
                expect(job.runId).toBeUndefined();
                expect(job.payload.imageResultBinding).not.toHaveProperty("run");
                const unrelated = await createOriginal();
                const unrelatedBefore = await tasks.getStoredGenerationTaskRecord("image", unrelated.id);
                const registrationsBefore = provider === "file" ? await registrations.listFileLocalMediaRegistrations() : await postgresRegistrations();
                const accountBefore = provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot();
                const filesBefore = provider === "file" ? await storedFiles(REFERENCE_MEDIA_ROOT) : await storedFiles();
                const detail = await import("@/app/api/image-tasks/[id]/route");
                const onNativeRunning = async () => {
                    const response = await detail.PATCH(
                        new Request(`${origin}/api/image-tasks/${original.id}`, { method: "PATCH", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }),
                        { params: Promise.resolve({ id: original.id }) },
                    );
                    expect(response.status, "The actual authenticated workbench cancel Route must cancel its original ImageTask").toBe(200);
                    expect(await response.json()).toMatchObject({ task: { id: original.id, kind: "generation", status: "cancelled", model: imageModelId } });
                    expect(await imageTasks.getImageTask(original.id)).toMatchObject({ status: "cancelled", nativeResults: waiting.nativeResults, resultProcessing: waiting.resultProcessing, billing: waiting.billing, attempts: waiting.attempts });
                    expect(await tasks.getStoredGenerationTaskRecord("image", unrelated.id)).toStrictEqual(unrelatedBefore);
                };
                const observed = await processWithWorker(job.id, onNativeRunning);
                expect(observed.input.closed.pid).toBe(observed.captured.pid);
                expect(observed.captured.state).toBe("T");
                expect(observed.receipt).toStrictEqual({ jobId: job.id, executionId: observed.child.executionId, status: "cancelled", executionPhase: "completed" });
                expect(await imageTasks.getImageTask(original.id)).toStrictEqual({
                    ...waiting,
                    status: "cancelled",
                    error: "任务已取消",
                    retryable: false,
                    executionPhase: "cancel_requested",
                    lastUpstreamStatus: "cancel_requested_without_upstream_id",
                    updatedAt: expect.any(Number),
                });
                const settled = await tasks.getStoredGenerationTaskRecord("image_processing", job.id);
                expect(settled).toMatchObject({ id: job.id, userId, parentTaskId: original.id, status: "cancelled", executionPhase: "completed" });
                expect(settled?.payload).toStrictEqual(observed.child.payload);
                expect(settled?.runId).toBeUndefined();
                expect(await tasks.getStoredGenerationTaskRecord("image", unrelated.id)).toStrictEqual(unrelatedBefore);
                const remaining = (await tasks.listStoredGenerationTaskRecords({ userId })).items;
                expect(remaining).toHaveLength(3);
                expect(remaining.map((record) => record.id)).toEqual(expect.arrayContaining([original.id, unrelated.id, job.id]));
                expect(await readFile(nativePath)).toEqual(native);
                expect(provider === "file" ? await registrations.listFileLocalMediaRegistrations() : await postgresRegistrations()).toStrictEqual(registrationsBefore);
                expect(provider === "file" ? await readFile(path.join(directory, "auth.json")) : await postgresAccountSnapshot()).toStrictEqual(accountBefore);
                expect(provider === "file" ? await storedFiles(REFERENCE_MEDIA_ROOT) : await storedFiles()).toStrictEqual(filesBefore);
                expect(boundary.create).not.toHaveBeenCalled();
                expect(boundary.poll).not.toHaveBeenCalled();
                console.info("No-Run workbench live native cancellation evidence", {
                    imageTaskId: original.id,
                    jobId: job.id,
                    captured: observed.captured,
                    pending: observed.pending,
                    closed: observed.input.closed,
                    stopCause: observed.input.stopCause,
                    receipt: observed.receipt,
                });
            },
            120_000 + 30_000 + 35_000 + 35_000 + 10_000 + 10_000 + 5 * 15_000,
        );

        async function cancelHistoricalCopy(liveAbort: boolean) {
            await withDispatchedCopies(1, async (run, task, executorId, origin, copies) => {
                const prepared = await waitForCopy(copies[0].taskId, await solid("#4378ab"), origin);
                const completed = await completeCopy(prepared, run, origin);
                const afterConsumption = await runs.getAgentRun(run.id);
                assert.ok(afterConsumption);
                expect(await execution.runTaskWithRetry(run.id, afterConsumption.tasks[0], origin, boundary.cookie, executorId)).toBe("deferred");
                expect(await runs.getAgentRun(run.id)).toMatchObject({
                    status: "running",
                    tasks: [
                        {
                            id: task.id,
                            attempts: 1,
                            childTasks: [
                                { id: copies[0].taskId, status: "completed", attempt: 1 },
                                { id: copies[1].taskId, status: "pending", attempt: 1 },
                            ],
                        },
                    ],
                });

                // The existing failure owner establishes a real terminal ImageTask; Agent poll owns its logical failure projection.
                const originalFailedCopy = await imageTasks.getImageTask(copies[1].taskId);
                assert.ok(originalFailedCopy);
                expect(await runtime.markImageTaskFailed(originalFailedCopy, "Fixture definitive generation failure")).toMatchObject({ id: originalFailedCopy.id, status: "error" });
                const beforeFailurePoll = await runs.getAgentRun(run.id);
                assert.ok(beforeFailurePoll);
                expect(await execution.runTaskWithRetry(run.id, beforeFailurePoll.tasks[0], origin, boundary.cookie, executorId)).toBe("failed");
                const failedRun = await runs.getAgentRun(run.id);
                assert.ok(failedRun);
                expect(failedRun.tasks[0]).toMatchObject({
                    id: task.id,
                    status: "failed",
                    attempts: 1,
                    childTasks: [
                        { id: copies[0].taskId, status: "completed", attempt: 1 },
                        { id: copies[1].taskId, status: "failed", attempt: 1 },
                    ],
                });

                const retryRoute = await import("@/app/api/agent/runs/[id]/tasks/[taskId]/retry/route");
                const retry = await retryRoute.POST(
                    new Request(`${origin}/api/agent/runs/${run.id}/tasks/${task.id}/retry`, {
                        method: "POST",
                        headers: { cookie: boundary.cookie, "content-type": "application/json" },
                        body: JSON.stringify({ conversationId: run.conversationId }),
                    }),
                    { params: Promise.resolve({ id: run.id, taskId: task.id }) },
                );
                expect(retry.status, "SETUP: the actual failed-task retry Route must preserve the completed original copy").toBe(200);
                expect(await retry.json()).toMatchObject({ code: 0, data: { run: { id: run.id, status: "running" } } });
                const retried = await runs.getAgentRun(run.id);
                assert.ok(retried);
                const retriedTask = retried.tasks[0];
                expect(retried).toMatchObject({ executionId: executorId });
                expect(retriedTask).toMatchObject({ id: task.id, status: "ready", attempts: 1, taskIds: [completed.published.id], childTasks: [{ id: completed.published.id, status: "completed", attempt: 1 }] });

                await withImageRoutes(retried, retriedTask, async (retryOrigin, replacements) => {
                    expect(await execution.runTaskWithRetry(run.id, retriedTask, retryOrigin, boundary.cookie, executorId)).toBe("deferred");
                    expect(replacements).toHaveLength(1);
                    const replacementId = replacements[0].taskId;
                    expect(replacements[0].requestId).toBe(`${run.clientRequestId}:${task.id}:2:2`);
                    const current = await waitForCopy(replacementId, await solid("#ca863f"), retryOrigin);
                    assert.ok(current.waiting.resultProcessing);
                    const originalStage = await tasks.getStoredGenerationTaskRecord("image_processing", completed.job.id);
                    const oldImage = await tasks.getStoredGenerationTaskRecord("image", completed.published.id);
                    const oldFailedImage = await tasks.getStoredGenerationTaskRecord("image", originalFailedCopy.id);
                    const activeStage = await tasks.getStoredGenerationTaskRecord("image_processing", current.waiting.resultProcessing.jobId);
                    assert.ok(originalStage && oldImage && oldFailedImage && activeStage);
                    expect(originalStage).toMatchObject({ status: "success", executionPhase: "completed", payload: { imageResultBinding: { run: { runId: run.id, agentTaskId: task.id, agentAttempt: 1 } } } });
                    expect(activeStage).toMatchObject({ status: "pending", parentTaskId: replacementId, runId: run.id, payload: { imageResultBinding: { run: { runId: run.id, agentTaskId: task.id, agentAttempt: 2 } } } });
                    expect(await runs.getAgentRun(run.id)).toMatchObject({
                        status: "running",
                        tasks: [
                            {
                                id: task.id,
                                status: "running",
                                attempts: 2,
                                childTasks: [
                                    { id: completed.published.id, status: "completed", attempt: 1 },
                                    { id: replacementId, status: "pending", attempt: 2 },
                                ],
                            },
                        ],
                    });
                    const assetsBefore = await creative.listAssetsForUser(userId, run.conversationId);
                    const logsBefore = (await logs.listGenerationLogs({ userId })).items;
                    const registrationsBefore = provider === "file" ? await registrations.listFileLocalMediaRegistrations() : await postgresRegistrations();
                    const financialBefore = await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" });
                    const accountBefore = provider === "postgres" ? await postgresAccountSnapshot() : undefined;
                    const pollsBefore = boundary.poll.mock.calls.length;
                    expect(financialBefore.records).toHaveLength(2);
                    expect(charges.size).toBe(2);
                    async function cancelRun() {
                        const action = await import("@/app/api/agent/runs/[id]/[action]/route");
                        const cancellation = action.POST(
                            new Request(`${retryOrigin}/api/agent/runs/${run.id}/cancel`, {
                                method: "POST",
                                headers: { cookie: boundary.cookie, "content-type": "application/json" },
                                body: JSON.stringify({ conversationId: run.conversationId }),
                            }),
                            { params: Promise.resolve({ id: run.id, action: "cancel" }) },
                        );

                        await expect(cancellation, "A retained successful attempt-1 result must not block cancelling the current attempt-2 copy").resolves.toMatchObject({ status: 200 });
                        expect(await (await cancellation).json()).toMatchObject({ code: 0, data: { run: { id: run.id, status: "cancelled" } } });
                    }
                    if (liveAbort) {
                        const observed = await processWithWorker(activeStage.id, cancelRun);
                        expect(observed.input.closed.pid).toBe(observed.captured.pid);
                        expect(observed.captured.state).toBe("T");
                        expect(observed.receipt).toStrictEqual({ jobId: activeStage.id, executionId: observed.child.executionId, status: "cancelled", executionPhase: "completed" });
                        expect(await readFile(current.nativePath)).toEqual(current.native);
                        console.info("Run copy live native cancellation evidence", {
                            jobId: activeStage.id,
                            captured: observed.captured,
                            pending: observed.pending,
                            closed: observed.input.closed,
                            stopCause: observed.input.stopCause,
                            receipt: observed.receipt,
                        });
                    } else await cancelRun();
                    expect(await tasks.getStoredGenerationTaskRecord("image", replacementId)).toMatchObject({
                        status: "cancelled",
                        payload: { status: "cancelled", nativeResults: current.waiting.nativeResults, billing: current.waiting.billing, attempts: current.waiting.attempts },
                    });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", activeStage.id)).toMatchObject({ status: "cancelled", executionPhase: "completed" });
                    expect(await runs.getAgentRun(run.id)).toMatchObject({
                        status: "cancelled",
                        tasks: [
                            {
                                id: task.id,
                                status: "cancelled",
                                attempts: 2,
                                childTasks: [
                                    { id: completed.published.id, status: "completed", attempt: 1 },
                                    { id: replacementId, status: "cancelled", attempt: 2 },
                                ],
                            },
                        ],
                    });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", completed.job.id)).toStrictEqual(originalStage);
                    expect(await tasks.getStoredGenerationTaskRecord("image", completed.published.id)).toStrictEqual(oldImage);
                    expect(await tasks.getStoredGenerationTaskRecord("image", originalFailedCopy.id)).toStrictEqual(oldFailedImage);
                    expect(await creative.listAssetsForUser(userId, run.conversationId)).toStrictEqual(assetsBefore);
                    expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual(logsBefore);
                    if (provider === "file") {
                        expect(await registrations.listFileLocalMediaRegistrations()).toStrictEqual(registrationsBefore);
                    } else expect(await postgresRegistrations()).toStrictEqual(registrationsBefore);
                    expect(await auth.listPointRecordsPage(userId, { pageSize: 50, direction: "debit" })).toStrictEqual(financialBefore);
                    if (provider === "postgres") expect(await postgresAccountSnapshot()).toStrictEqual(accountBefore);
                    if (provider === "postgres") expect(await tasks.getStoredGenerationTaskRecord("image", replacementId)).toMatchObject({ upstreamTaskId: `fixture-upstream-${replacementId}`, payload: { upstream: current.waiting.upstream } });
                    expect(charges.size).toBe(2);
                    expect(boundary.create).toHaveBeenCalledTimes(2);
                    expect(boundary.poll).toHaveBeenCalledTimes(pollsBefore);
                    expect(replacements).toHaveLength(1);
                    expect(copies).toHaveLength(2);
                });
            });
        }
    });
}
