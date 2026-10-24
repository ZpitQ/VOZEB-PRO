import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = resolve(tmpdir(), `vozeb-pro-generation-log-task-${process.pid}-${Date.now()}`);
const previousDataDir = process.env.VOZEB_PRO_DATA_DIR;
const previousProvider = process.env.VOZEB_PRO_DATABASE_PROVIDER;

let service: typeof import("./generation-log-task-service");
let store: typeof import("./generation-log-store");

describe("generation log task service", () => {
    beforeAll(async () => {
        process.env.VOZEB_PRO_DATA_DIR = dataDir;
        process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
        vi.resetModules();
        service = await import("./generation-log-task-service");
        store = await import("./generation-log-store");
    });

    beforeEach(async () => {
        await rm(dataDir, { recursive: true, force: true });
        await mkdir(dataDir, { recursive: true });
    });

    afterAll(async () => {
        if (previousDataDir === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
        else process.env.VOZEB_PRO_DATA_DIR = previousDataDir;
        if (previousProvider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
        else process.env.VOZEB_PRO_DATABASE_PROVIDER = previousProvider;
        await rm(dataDir, { recursive: true, force: true });
    });

    it("does not reset successful or non-retryable failed slots to pending", async () => {
        await createDraft("log-protected", ["success-slot", "failed-slot", "retry-slot"]);
        await recordResult("log-protected", "success-slot", "task-success", "success", false, assetUrl("success"));
        await recordResult("log-protected", "failed-slot", "task-failed", "failed", false);
        await recordResult("log-protected", "retry-slot", "task-retry", "failed", true);

        const log = await createDraft("log-protected", ["success-slot", "failed-slot", "retry-slot"]);
        const states = Object.fromEntries(log?.requestSnapshot?.slots.map((slot) => [slot.id, slot.status]) || []);

        expect(states).toEqual({ "success-slot": "success", "failed-slot": "failed", "retry-slot": "pending" });
    });

    it("keeps concurrent task results and their asset indexes isolated", async () => {
        await createDraft("log-concurrent", ["slot-a", "slot-b"]);

        await Promise.all([recordResult("log-concurrent", "slot-a", "task-a", "success", false, assetUrl("a")), recordResult("log-concurrent", "slot-b", "task-b", "success", false, assetUrl("b"))]);

        const log = await getLog("log-concurrent");
        expect(log?.assets).toHaveLength(2);
        expect(Object.fromEntries(log?.requestSnapshot?.slots.map((slot) => [slot.id, slot.assetIndex === undefined ? undefined : log.assets[slot.assetIndex]?.url]) || [])).toEqual({
            "slot-a": assetUrl("a"),
            "slot-b": assetUrl("b"),
        });
    });

    it("reindexes remaining assets and ignores a late result for a deleted slot", async () => {
        await createDraft("log-delete", ["slot-a", "slot-b", "slot-c"]);
        await recordResult("log-delete", "slot-a", "task-a", "success", false, assetUrl("a"));
        await recordResult("log-delete", "slot-b", "task-b", "success", false, assetUrl("b"));
        await recordResult("log-delete", "slot-c", "task-c", "success", false, assetUrl("c"));

        const deleted = await service.deleteGenerationLogResultsForUser("user-one", "log-delete", ["slot-b"]);
        expect(deleted?.assets.map((asset) => asset.url)).toEqual([assetUrl("a"), assetUrl("c")]);
        expect(deleted?.requestSnapshot?.slots.map((slot) => [slot.id, slot.assetIndex])).toEqual([
            ["slot-a", 0],
            ["slot-c", 1],
        ]);

        const late = await recordResult("log-delete", "slot-b", "task-b-late", "success", false, assetUrl("late"));
        expect(late.log?.requestSnapshot?.slots.map((slot) => slot.id)).toEqual(["slot-a", "slot-c"]);
        expect(late.log?.assets.map((asset) => asset.url)).toEqual([assetUrl("a"), assetUrl("c")]);
    });

    it("replays the same completed server task without duplicating assets", async () => {
        await createDraft("log-idempotent", ["slot-a"]);
        const first = await recordResult("log-idempotent", "slot-a", "task-a", "success", false, assetUrl("a"));
        const replay = await recordResult("log-idempotent", "slot-a", "task-a", "success", false, assetUrl("a"));

        expect(first.log?.assets).toHaveLength(1);
        expect(replay.log?.assets).toHaveLength(1);
        expect(replay.asset).toEqual(first.asset);
    });

    it("stores every output returned by one image task in the original record", async () => {
        await createDraft("log-multiple", ["slot-a"]);

        const result = await service.recordGenerationTaskLogResult({
            logId: "log-multiple",
            slotId: "slot-a",
            clientRequestId: "request-slot-a",
            taskId: "task-a",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "image",
            source: "image-workbench",
            status: "success",
            title: "测试记录",
            prompt: "执行提示词",
            model: "image-model",
            summary: "图片生成完成",
            durationMs: 100,
            assets: [
                { type: "image", url: assetUrl("first") },
                { type: "image", url: assetUrl("second") },
            ],
            taskKind: "generation",
            createdAt: Date.now(),
        });

        expect(result.log?.assets.map((asset) => asset.url)).toEqual([assetUrl("first"), assetUrl("second")]);
        expect(result.log?.requestSnapshot?.slots.map((slot) => [slot.id, slot.assetIndex])).toEqual([
            ["slot-a", 0],
            ["slot-a:output:2", 1],
        ]);
        expect(result.log).toMatchObject({ count: 2, successCount: 2, failCount: 0, status: "success" });
    });

    it("round-trips long public and execution prompts through the file store", async () => {
        const publicPrompt = "原".repeat(4000);
        const executionPrompt = "执".repeat(5000);
        await service.recordGenerationLogDraft({
            id: "log-long-prompts",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "image",
            source: "image-workbench",
            status: "pending",
            title: "长提示词记录",
            prompt: executionPrompt,
            requestSnapshot: {
                version: 1,
                userPrompt: publicPrompt,
                parameters: {},
                references: [],
                slots: [{ id: "slot-long", index: 0, status: "pending", prompt: executionPrompt, clientRequestId: "request-slot-long" }],
            },
        });

        const log = await getLog("log-long-prompts");
        expect(log?.prompt).toBe(executionPrompt);
        expect(log?.requestSnapshot?.userPrompt).toBe(publicPrompt);
        expect(log?.requestSnapshot?.slots[0]?.prompt).toBe(executionPrompt);
    });

    it("round-trips independent enhancement identities and safe native facts through the actual task log file", async () => {
        await createDraft("log-enhancement", ["slot-a"]);
        const nativeSource = { url: assetUrl("native"), width: 1254, height: 1254, byteLength: 1200, sha256: "a".repeat(64), format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const assets = [
            { type: "image" as const, url: assetUrl("native"), resultId: "task-a:result-one", enhancementId: "enhancement-one", nativeSource: { ...nativeSource, evidencePath: "private-native-path" }, enhancement: { token: "private-stale-summary" } },
            { type: "image" as const, url: assetUrl("second"), resultId: "task-a:result-two", enhancementSkip: { status: "skipped" as const, reason: "protected_contract" as const, raw: "private-skip" } },
        ];
        await service.recordGenerationTaskLogResult({
            logId: "log-enhancement",
            slotId: "slot-a",
            clientRequestId: "request-slot-a",
            taskId: "task-a",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "image",
            source: "image-workbench",
            status: "success",
            title: "增强记录",
            prompt: "公开需求",
            model: "image-model",
            summary: "完成",
            durationMs: 100,
            assets: assets as unknown as Parameters<typeof service.recordGenerationTaskLogResult>[0]["assets"],
            taskKind: "generation",
            createdAt: Date.now(),
        });

        const raw = await readFile(resolve(dataDir, "generation-logs.json"), "utf8");
        expect(raw).not.toContain("private-");
        expect(raw).not.toContain('"enhancement":');
        vi.resetModules();
        const reloadedStore = await import("./generation-log-store");
        const log = (await reloadedStore.listGenerationLogs({ userId: "user-one" })).items[0];
        expect(log).toMatchObject({ status: "success", successCount: 2, failCount: 0 });
        expect(log?.assets).toMatchObject([
            { resultId: "task-a:result-one", enhancementId: "enhancement-one", nativeSource },
            { resultId: "task-a:result-two", enhancementSkip: { status: "skipped", reason: "protected_contract" } },
        ]);
    });

    it("keeps distinct original result identities when a provider reuses a permanent media URL", async () => {
        await createDraft("log-shared-url", ["slot-a"]);
        const assets = [
            { type: "image" as const, url: assetUrl("shared-native"), resultId: "task-a:result-one", enhancementId: "enhancement-one" },
            { type: "image" as const, url: assetUrl("shared-native"), resultId: "task-a:result-two", enhancementId: "enhancement-two" },
        ];
        await service.recordGenerationTaskLogResult({
            logId: "log-shared-url",
            slotId: "slot-a",
            clientRequestId: "request-slot-a",
            taskId: "task-a",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "image",
            source: "image-workbench",
            status: "success",
            title: "独立原结果",
            prompt: "公开需求",
            model: "image-model",
            summary: "完成",
            durationMs: 100,
            assets,
            taskKind: "generation",
            createdAt: Date.now(),
        });

        const log = await getLog("log-shared-url");
        expect(log?.assets).toMatchObject([
            { resultId: "task-a:result-one", enhancementId: "enhancement-one" },
            { resultId: "task-a:result-two", enhancementId: "enhancement-two" },
        ]);
        expect(log?.requestSnapshot?.slots.map((slot) => slot.assetIndex)).toEqual([0, 1]);
    });

    it("rejects mutations when the record belongs to another user", async () => {
        await createDraft("log-owned", ["slot-a"]);

        await expect(service.renameGenerationLogForUser("user-two", "log-owned", "越权标题")).rejects.toBeInstanceOf(service.GenerationLogOwnershipError);
        await expect(recordResult("log-owned", "slot-a", "task-two", "failed", false, undefined, "user-two")).rejects.toBeInstanceOf(service.GenerationLogOwnershipError);
    });
});

function createDraft(id: string, slotIds: string[]) {
    return service.recordGenerationLogDraft({
        id,
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind: "image",
        source: "image-workbench",
        status: "pending",
        title: "测试记录",
        prompt: "用户原文",
        requestSnapshot: {
            version: 1,
            userPrompt: "用户原文",
            parameters: {},
            references: [],
            slots: slotIds.map((slotId, index) => ({ id: slotId, index, status: "pending" as const, clientRequestId: `request-${slotId}` })),
        },
    });
}

function recordResult(logId: string, slotId: string, taskId: string, status: "success" | "failed", canRetry: boolean, url?: string, userId = "user-one") {
    return service.recordGenerationTaskLogResult({
        logId,
        slotId,
        clientRequestId: `request-${slotId}`,
        taskId,
        userId,
        username: "user",
        displayName: "User",
        kind: "image",
        source: "image-workbench",
        status,
        title: "测试记录",
        prompt: "执行提示词",
        model: "image-model",
        summary: status === "success" ? "图片生成完成" : "图片生成失败",
        durationMs: 100,
        asset: url ? { type: "image", url } : undefined,
        error: status === "failed" ? "上游明确失败" : undefined,
        canRetry,
        taskKind: "generation",
        createdAt: Date.now(),
    });
}

async function getLog(id: string) {
    return (await store.listGenerationLogs({ userId: "user-one", pageSize: 100 })).items.find((log) => log.id === id);
}

function assetUrl(name: string) {
    return `/api/generation-log-assets/permanent/test/${name}.png`;
}
