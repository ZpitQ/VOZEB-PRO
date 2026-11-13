import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
            boundary.create.mockImplementation(async (submission: ImageTask): Promise<ImageTaskRunResult> => {
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
                        ...Object.fromEntries(Object.keys(resourceEnvironment).map((key) => [key, process.env[key]])),
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
                    planVersion: "ecommerce-edit.v7",
                    operation: "scene_edit",
                    source: input.sources,
                    baseline: { productFacts: null, sceneFacts: baseline.sceneFacts },
                    delta: { requestedChanges: ["全局调整光线为明亮自然日光"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
                    preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                    strategy: "full_image",
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
                    planVersion: "ecommerce-edit.v7",
                    operation: "scene_edit",
                    source: input.sources,
                    baseline: { productFacts: null, sceneFacts: baseline.sceneFacts },
                    delta: { requestedChanges: ["全局调整光线为明亮自然日光"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
                    preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                    strategy: "full_image",
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
                        planVersion: "ecommerce-edit.v7",
                        operation: "scene_edit",
                        strategy: "full_image",
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
                        planVersion: "ecommerce-edit.v7",
                        operation: "scene_edit",
                        strategy: "full_image",
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
                        const processActor = spawn(
                            process.execPath,
                            [path.resolve("node_modules/vitest/vitest.mjs"), "run", "src/lib/server/ecommerce-process-fixture.test.ts", "--pool=threads", "--maxWorkers=1", "--no-file-parallelism", "--reporter=dot"],
                            {
                                cwd: process.cwd(),
                                env: { ...process.env, VOZEB_PRO_ECOMMERCE_PROCESS_INPUT: JSON.stringify(input) },
                                stdio: ["ignore", "pipe", "pipe"],
                            },
                        );
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

                    const lockPath = path.join(directory, "creative-runtime.json.lock");
                    const runtimeLock = await stat(lockPath);
                    // The actor has exited; age its orphaned lock to exercise real stale-lock recovery.
                    await utimes(lockPath, runtimeLock.atime, new Date(0));
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
