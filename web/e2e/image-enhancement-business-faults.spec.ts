import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import { emptyAdvancedConfig } from "../src/lib/channel-protocol-registry";
import type { CreativeAsset } from "../src/lib/creative-runtime-contract";
import type { EnhancementModel, ImageEnhancementSettings, PublicImageEnhancement } from "../src/lib/image-enhancement-contract";
import { armDeliveryWrite, createBusinessFaultFixture, fixtureModel, mediaSnapshot, ownedDataDirectory, readOwnedJob, readPreloadRecords, readWriteFault, sha256 } from "./image-enhancement-business-faults.fixture.mjs";
import { bootFacts, proveOldOwnerFence, restartSourceHashes, sanitizeRestartEvidence, startOwnedWeb, stopOwnedWeb, untilObserved } from "./image-enhancement-restart.lifecycle.mjs";
import { E2E_ADMIN, e2eSettingsPatch } from "./support";

const MODEL = "m5-controlled-native-image";
const syntheticModelB = {
    ...fixtureModel,
    id: "m5-business-fixture-b",
    binaryVersion: "synthetic-v2",
    binarySha256: "d".repeat(64),
    modelVersion: "synthetic-v2",
    modelSha256: "e".repeat(64),
    nativeScale: 4 as const,
    tta: false as const,
} satisfies EnhancementModel;
const timeoutMs = Number(process.env.VOZEB_PRO_M5_BUSINESS_TIMEOUT_MS || 10_000);
type Fixture = Awaited<ReturnType<typeof createBusinessFaultFixture>>;
type Run = { id: string; conversationId: string; status: string; reviewed?: boolean; reviewStatus?: string };
type SubmitRequestOutcome = { kind: "response" | "error"; message?: string; observedAt: number };
type SubmitCapture = { workerId: string; accepted: () => boolean; pending?: Promise<SubmitRequestOutcome>; outcome?: SubmitRequestOutcome; stop: boolean };
type NativeTask = { id: string; status: string; result: unknown };
type GenerationLog = { id: string; status: string; assets: Array<{ enhancementId?: string; enhancement?: PublicImageEnhancement }> };
type Counts = ReturnType<Fixture["counts"]>;
type Case = {
    fixture: Fixture;
    root: string;
    run: Run;
    native: CreativeAsset;
    id: string;
    initial: PublicImageEnhancement;
    baselineOwned: Awaited<ReturnType<typeof readOwnedJob>>;
    baselineTask: NativeTask;
    baselineMedia: Awaited<ReturnType<typeof mediaSnapshot>>;
    baselineLog: GenerationLog;
    generationBefore: Counts;
    generationDelta: Counts["counts"];
    before: Counts;
    browserWorkerRequests: string[];
};
const cases = [
    { id: "connection-refused", reason: "connection_failed", stage: "query", text: /无法连接|连接失败|连接.*中断|服务.*断开/ },
    { id: "authentication", reason: "authentication_failed", stage: "query", text: /访问密钥|认证|鉴权/ },
    { id: "engine-failed", reason: "engine_failed", stage: "query", text: /引擎.*失败|GPU.*失败/ },
    { id: "timeout", reason: "timeout", stage: "query", text: /超时/ },
    { id: "corrupt", reason: "output_invalid", stage: "result", text: /摘要|解码|校验|产物.*损坏|内容.*无效|结果.*无效/ },
    { id: "incomplete-transfer", reason: "connection_failed", stage: "result", text: /传输|下载|连接.*中断|连接失败|无法连接/ },
    { id: "sha-only", reason: "output_invalid", stage: "result", text: /摘要|校验/ },
];

test.skip(process.env.VOZEB_PRO_M5_BUSINESS_FAULTS !== "1", "Requires an owned isolated application with the M5 test preload and local synthetic Worker.");

for (const fault of cases)
    test(`SR-M5-03/06 ${fault.id}: real enhancement HTTP failure preserves the persisted normal native`, async ({ page, request }, info) => {
        const current = await beginCase(page, request, info, fault.id);
        try {
            if (fault.id === "connection-refused") await current.fixture.refuseConnections();
            else await current.fixture.setFault(fault.id);
            const failed = await drive(request, current.id, (job) => job.status === "failed", info);
            expect(failed).toMatchObject({ status: "failed", phase: fault.stage === "query" ? "poll" : "download", reason: fault.reason, attempt: 1 });
            const preserved = await assertOriginal(page, request, current, failed, fault.text);
            await page.screenshot({ path: info.outputPath("native-preserved-after-http-fault.png"), fullPage: true });
            const ledger = await current.fixture.snapshot();
            expect(ledger.fixtureError).toBeUndefined();
            expect(ledger.jobs).toHaveLength(1);
            expect(ledger.jobs[0].executionCount).toBe(1);
            expect(ledger.acceptedReceipts).toEqual([]);
            expect(ledger.receiptRequests).toEqual([]);
            const owned = await readOwnedJob(current.root, current.id);
            expect(owned).not.toHaveProperty("publication");
            expect(owned.staged || {}).toEqual({});
            expect(await mediaSnapshot(current.root, current.id)).toEqual([]);
            const businessId = ledger.jobs[0].jobId;
            const resultCalls = ledger.calls.filter((call: { path: string; role: string }) => call.path === `/v1/enhancement-jobs/${businessId}/result` && call.role === "application");
            if (fault.stage === "result") expect(resultCalls).toHaveLength(1);
            else expect(resultCalls).toHaveLength(0);
            if (fault.id === "incomplete-transfer") {
                expect(resultCalls[0]).toMatchObject({ declaredBytes: current.fixture.ai.length, bodyBytes: current.fixture.ai.length - 24 });
                expect(resultCalls[0].bodyBytes).toBeLessThan(resultCalls[0].declaredBytes);
            }
            if (fault.id === "sha-only") {
                const bytes = current.fixture.wrongShaPng;
                expect(bytes.length).toBe(current.fixture.expected.byteLength);
                expect(await decoded(bytes)).toMatchObject({ width: 5016, height: 5016, format: "png", opaque: true });
                expect(sha256(bytes)).not.toBe(current.fixture.expected.sha256);
                expect(resultCalls[0]).toMatchObject({ declaredBytes: bytes.length, bodyBytes: bytes.length });
            }
            if (fault.id === "timeout") {
                const call = ledger.calls.find((entry: { path: string; responseStatus: number | null }) => entry.path === `/v1/enhancement-jobs/${businessId}` && entry.responseStatus === null);
                expect(owned.decision.connection.timeoutMs).toBe(timeoutMs);
                expect(call).toMatchObject({ responseStatus: null, bodyBytes: null, closedAt: expect.any(Number) });
                expect(call!.closedAt).toBeGreaterThan(call!.receivedAt);
            }
            await evidence(info, "fault", { kind: "synthetic-HTTP-business-fault; not GPU inference or AI-quality acceptance", fault, injectedAfter: current.before, failed, preserved, owned, ledger });
            if (fault.stage === "result") {
                await current.fixture.setFault("ready");
                await retryFromDesktop(page, current.id);
                const recovered = await drive(request, current.id, (job) => job.status === "succeeded" && job.phase === "completed", info);
                const after = await current.fixture.snapshot();
                expect(recovered).toMatchObject({ attempt: 1, native: { sha256: sha256(current.fixture.native) } });
                expect(after.jobs.map((job: { jobId: string }) => job.jobId)).toEqual([businessId]);
                expect(after.jobs[0].executionCount).toBe(1);
                expect(after.calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toHaveLength(1);
                expect((await readOwnedJob(current.root, current.id)).remoteResult).toEqual(owned.remoteResult);
                expect(current.fixture.counts()).toEqual(current.before);
                expect(await nativeTask(request, current.id)).toEqual(current.baselineTask);
                expect((await assets(request, current.run.conversationId)).filter((asset) => asset.metadata?.enhancementId === current.id && asset.metadata?.provenance === "ai_enhanced")).toHaveLength(1);
                await evidence(info, "same-result-recovery", { recovered, ledger: after, upstream: current.fixture.counts() });
            }
        } finally {
            await finishCase(request, current, info);
        }
    });

test("SR-M5-06 final permanent write failure resumes staged AI, then durable receipt response loss only retries the same confirmation", async ({ page, request }, info) => {
    const current = await beginCase(page, request, info, "permanent-write-and-receipt-loss");
    try {
        const proof = await armDeliveryWrite(current.root, current.fixture.delivery, info.testId);
        await current.fixture.setFault("write-delivery");
        const failed = await drive(request, current.id, (job) => job.status === "failed", info);
        expect(failed).toMatchObject({ status: "failed", phase: "download", reason: "output_storage_invalid", attempt: 1 });
        const preserved = await assertOriginal(page, request, current, failed, /保存|存储|写入/);
        await page.screenshot({ path: info.outputPath("native-preserved-after-permanent-write-fault.png"), fullPage: true });
        const writeFault = await readWriteFault(current.root);
        expect(writeFault).toMatchObject({ caseId: info.testId, code: "EIO", restored: true, sha256: sha256(current.fixture.delivery), byteLength: current.fixture.delivery.length });
        expect((await readPreloadRecords(current.root)).some((record) => record.pid === writeFault.pid)).toBe(true);
        await expect(stat(writeFault.path)).rejects.toMatchObject({ code: "ENOENT" });
        const missingUrl = `/api/generation-log-assets/${writeFault.storageKey.split("/").map(encodeURIComponent).join("/")}`;
        expect((await request.get(missingUrl)).status()).toBe(404);
        const staged = await readOwnedJob(current.root, current.id);
        expect(staged).not.toHaveProperty("publication");
        expect(staged.staged).not.toHaveProperty("delivered");
        expect(staged.staged.ai).toMatchObject(current.fixture.expected);
        const stagedMedia = await mediaSnapshot(current.root, current.id);
        expect(stagedMedia).toHaveLength(1);
        expect(stagedMedia[0]).toMatchObject({
            sha256: current.fixture.expected.sha256,
            registration: { ownerUserId: staged.userId, taskId: current.id, conversationId: current.run.conversationId, scope: "generation", storageClass: "permanent", originalName: "完整AI增强.png" },
        });
        const registry = JSON.parse(await readFile(path.join(current.root, "local-media-assets.json"), "utf8"));
        expect(registry.assets.some((asset: { storageKey: string }) => asset.storageKey === writeFault.storageKey)).toBe(false);
        const stagedDownload = await request.get(staged.staged.ai.url);
        expect(stagedDownload.ok()).toBe(true);
        expect(sha256(await stagedDownload.body())).toBe(current.fixture.expected.sha256);
        let beforeAcceptance: Record<string, unknown> | undefined;
        current.fixture.beforeReceipt(async (boundary: { job: { jobId: string; retained: boolean }; receipt: unknown; acceptedReceipts: unknown[] }) => {
            expect(boundary.acceptedReceipts).toEqual([]);
            expect(boundary.job.retained).toBe(true);
            const published = await enhancement(request, current.id);
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt" });
            const permanent = await readOwnedJob(current.root, current.id);
            const children = (await assets(request, current.run.conversationId)).filter((asset) => asset.metadata?.enhancementId === current.id && asset.metadata?.provenance === "ai_enhanced");
            expect(children).toHaveLength(1);
            expect(children[0].id).toBe(published.enhanced!.assetId);
            const saved = await request.get(published.enhanced!.url);
            expect(saved.ok()).toBe(true);
            expect(await decoded(await saved.body())).toMatchObject({ width: 4096, height: 4096, sha256: published.enhanced!.sha256 });
            const retained = await request.get(`${current.fixture.endpoint}/v1/enhancement-jobs/${boundary.job.jobId}/result`, { headers: { authorization: `Bearer ${current.fixture.token}`, "x-m5-fixture-observer": "1" } });
            expect(retained.ok()).toBe(true);
            expect(sha256(await retained.body())).toBe(current.fixture.expected.sha256);
            beforeAcceptance = {
                boundary,
                publicEnhancement: published,
                publication: permanent.publication,
                assets: children,
                media: await mediaSnapshot(current.root, current.id),
                retainedRemoteSha256: current.fixture.expected.sha256,
                observedAt: Date.now(),
            };
            await evidence(info, "before-receipt-acceptance", beforeAcceptance);
        });
        const beforeResume = await current.fixture.snapshot();
        expect(beforeResume.receiptRequests).toEqual([]);
        expect(beforeResume.acceptedReceipts).toEqual([]);
        expect(beforeResume.jobs[0]).toMatchObject({ retained: true, executionCount: 1, result: current.fixture.expected });
        await current.fixture.setFault("receipt-loss");
        await retryFromDesktop(page, current.id);
        const deferred = await drive(request, current.id, (job) => job.status === "succeeded" && job.phase === "receipt" && job.events.some((event) => event.stage === "receipt_deferred"), info);
        expect(beforeAcceptance).toBeDefined();
        expect(deferred.events.filter((event) => event.stage === "published")).toHaveLength(1);
        const published = await readOwnedJob(current.root, current.id);
        expect(published).toMatchObject({
            status: "succeeded",
            phase: "receipt",
            remoteJobId: staged.remoteJobId,
            remoteResult: staged.remoteResult,
            remoteKey: staged.remoteKey,
            receiptId: staged.receiptId,
            attempt: staged.attempt,
            staged: { ai: staged.staged.ai },
        });
        const publishedMedia = await mediaSnapshot(current.root, current.id);
        expect(publishedMedia).toHaveLength(2);
        expect(publishedMedia.find((asset) => asset.sha256 === current.fixture.expected.sha256)).toEqual(stagedMedia[0]);
        const acceptedWithoutResponse = await current.fixture.snapshot();
        expect(acceptedWithoutResponse.acceptedReceipts).toHaveLength(1);
        expect(acceptedWithoutResponse.receiptRequests).toHaveLength(1);
        expect(acceptedWithoutResponse.receiptRequests[0]).toMatchObject({ receipt: { receiptId: staged.receiptId }, responseLost: true, replayed: false });
        const durable = JSON.parse(await readFile(current.fixture.ledgerPath, "utf8"));
        expect(durable.acceptedReceipts).toEqual(acceptedWithoutResponse.acceptedReceipts);
        const completed = await drive(request, current.id, (job) => job.status === "succeeded" && job.phase === "completed", info);
        const confirmed = await readOwnedJob(current.root, current.id);
        const finalLedger = await current.fixture.snapshot();
        expect(confirmed.publication).toEqual(published.publication);
        expect(confirmed.receiptId).toBe(staged.receiptId);
        expect(confirmed.remoteJobId).toBe(staged.remoteJobId);
        expect(confirmed.remoteResult).toEqual(staged.remoteResult);
        expect(confirmed.events.filter((event: { stage: string }) => event.stage === "published")).toHaveLength(1);
        expect(completed.events.filter((event) => event.stage === "receipt_confirmed")).toHaveLength(1);
        expect(await mediaSnapshot(current.root, current.id)).toEqual(publishedMedia);
        expect(finalLedger.fixtureError).toBeUndefined();
        expect(finalLedger.acceptedReceipts).toEqual(acceptedWithoutResponse.acceptedReceipts);
        expect(finalLedger.receiptRequests).toHaveLength(2);
        expect(finalLedger.receiptRequests[1]).toMatchObject({ receipt: finalLedger.receiptRequests[0].receipt, replayed: true, responseLost: false });
        expect(finalLedger.jobs).toHaveLength(1);
        expect(finalLedger.jobs[0].executionCount).toBe(1);
        const appCalls = finalLedger.calls.filter((call: { role: string }) => call.role === "application");
        expect(appCalls.filter((call: { path: string; method: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toHaveLength(1);
        expect(appCalls.filter((call: { path: string }) => call.path === `/v1/enhancement-jobs/${staged.remoteJobId}/result`)).toHaveLength(1);
        expect(current.fixture.counts()).toEqual(current.before);
        expect(await nativeTask(request, current.id)).toEqual(current.baselineTask);
        expect(await mediaSnapshot(current.root, completed.imageTaskId)).toEqual(current.baselineMedia);
        const listed = await assets(request, current.run.conversationId);
        expect(listed.filter((asset) => asset.metadata?.enhancementId === current.id && asset.metadata?.provenance === "ai_enhanced")).toHaveLength(1);
        expect(listed.find((asset) => asset.id === completed.enhanced!.assetId)).toMatchObject({ parentAssetId: current.native.id, width: 4096, height: 4096 });
        await page.reload({ waitUntil: "domcontentloaded" });
        const round = page.getByTestId("creative-media-result");
        await expect(round.getByRole("status")).toContainText("AI增强已完成");
        await round.getByRole("button", { name: "原图", exact: true }).click();
        expect(await decoded(await downloadOriginal(page, round.getByLabel("本轮创作操作", { exact: true })))).toMatchObject({ width: 1254, height: 1254, sha256: sha256(current.fixture.native) });
        await round.getByRole("button", { name: "AI增强", exact: true }).click();
        expect(await decoded(await downloadOriginal(page, round.getByLabel("本轮创作操作", { exact: true })))).toMatchObject({ width: 4096, height: 4096, sha256: completed.enhanced!.sha256 });
        expect(await generationLog(request, current.id)).toMatchObject({ status: "success" });
        expect(current.fixture.counts()).toEqual(current.before);
        expect(current.browserWorkerRequests).toEqual([]);
        await page.screenshot({ path: info.outputPath("same-result-and-receipt-recovered.png"), fullPage: true });
        await evidence(info, "permanent-write-and-receipt-recovery", {
            kind: "synthetic-protocol result; not GPU acceptance",
            preserved,
            proof,
            writeFault,
            staged,
            stagedMedia,
            beforeResume,
            deferred,
            published,
            publishedMedia,
            acceptedWithoutResponse,
            completed,
            confirmed,
            finalLedger,
            before: current.before,
            after: current.fixture.counts(),
        });
    } finally {
        await finishCase(request, current, info);
    }
});

test("SR-M5-04/08 frozen configuration timeline: A retry stays on old verified service/model, B takes new defaults, C skips and explicit cancel is independent", async ({ page, request }, info) => {
    const a = await beginCase(page, request, info, "A");
    let serviceB: Fixture | undefined;
    const family: Array<{ owner: string; current: Case }> = [{ owner: "A", current: a }];
    const timeline: unknown[] = [];
    const controls: unknown[] = [];
    const checkpoint = async (phase: string) => {
        const settings = await adminSettings(request);
        const rows = await Promise.all(
            family.map(async ({ owner, current }) => {
                const task = await nativeTask(request, current.id);
                const log = await generationLog(request, current.id);
                return {
                    owner,
                    runId: current.run.id,
                    conversationId: current.run.conversationId,
                    observedAt: Date.now(),
                    public: await enhancement(request, current.id),
                    owned: await readOwnedJob(current.root, current.id),
                    originalNativeAsset: { id: current.native.id, url: current.native.serverUrl, width: current.native.width, height: current.native.height },
                    originalNativeTask: { id: current.baselineTask.id, status: current.baselineTask.status, resultSha256: sha256(Buffer.from(JSON.stringify(current.baselineTask.result))) },
                    currentNativeTask: { id: task.id, status: task.status, resultSha256: sha256(Buffer.from(JSON.stringify(task.result))) },
                    originalNativeLog: { id: current.baselineLog.id, status: current.baselineLog.status, nativeFactsSha256: sha256(Buffer.from(JSON.stringify(nativeLogFacts(current.baselineLog)))) },
                    currentNativeLog: { id: log.id, status: log.status, nativeFactsSha256: sha256(Buffer.from(JSON.stringify(nativeLogFacts(log)))) },
                    originalNativeMedia: current.baselineMedia,
                    currentNativeMedia: await mediaSnapshot(current.root, current.initial.imageTaskId),
                    ordinaryCalls: { before: current.generationBefore, after: current.before, delta: current.generationDelta },
                };
            }),
        );
        timeline.push({
            phase,
            observedAt: Date.now(),
            configuration: configurationFacts(settings),
            rows,
            controls: structuredClone(controls),
            upstream: { A: a.fixture.counts(), ...(serviceB ? { B: serviceB.counts() } : {}) },
            protocol: { A: await a.fixture.snapshot(), ...(serviceB ? { B: await serviceB.snapshot() } : {}) },
        });
        const content = JSON.stringify(timeline);
        for (const fixture of [a.fixture, ...(serviceB ? [serviceB] : [])]) {
            expect(content).not.toContain(fixture.endpoint);
            expect(content).not.toContain(fixture.upstreamEndpoint);
            expect(content).not.toContain(fixture.token);
        }
        await evidence(info, "configuration-lifecycle-timeline", { kind: "synthetic calibration/model descriptors and protocol execution counts; not GPU or AI-quality evidence", timeline });
    };
    try {
        expect(a.baselineOwned.decision.connection).toMatchObject({ serviceId: a.fixture.serviceId, model: fixtureModel });
        await checkpoint("A accepted under original verified configuration");
        const cancellable = await createNativeCase(page, request, info, a.fixture, "A-cancel", 2);
        family.push({ owner: "A-cancel", current: cancellable });
        expect(cancellable.baselineOwned.decision.connection).toEqual(a.baselineOwned.decision.connection);
        expect(cancellable.baselineOwned.remoteJobId).not.toBe(a.baselineOwned.remoteJobId);
        expect(cancellable.id).not.toBe(a.id);
        await checkpoint("independent cancellable A-family native and remote accepted before change");

        serviceB = await createBusinessFaultFixture({ root: a.root, caseId: "B", imagePath: process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE!, model: syntheticModelB });
        const beforeQualification = { A: a.fixture.counts(), B: serviceB.counts() };
        await qualify(request, serviceB);
        await configureNormalGeneration(request, serviceB);
        expect({ A: a.fixture.counts(), B: serviceB.counts() }).toEqual(beforeQualification);
        expect(serviceB.serviceId).not.toBe(a.fixture.serviceId);
        expect(serviceB.model.binaryVersion).not.toBe(a.fixture.model.binaryVersion);
        expect(serviceB.model.binarySha256).not.toBe(a.fixture.model.binarySha256);
        expect(serviceB.model.modelVersion).not.toBe(a.fixture.model.modelVersion);
        expect(serviceB.model.modelSha256).not.toBe(a.fixture.model.modelSha256);
        const b = await createNativeCase(page, request, info, serviceB, "B");
        family.push({ owner: "B", current: b });
        expect(b.baselineOwned.decision.connection).toMatchObject({ serviceId: serviceB.serviceId, model: syntheticModelB });
        expect(b.baselineOwned.decision.connection.credentialRef).not.toBe(a.baselineOwned.decision.connection.credentialRef);
        expect(b.baselineOwned.decision.connection.revision).not.toBe(a.baselineOwned.decision.connection.revision);
        expect(a.fixture.isListening()).toBe(true);
        expect(serviceB.isListening()).toBe(true);
        await checkpoint("B accepted after actual administrator connection/sample checks for new service and descriptor");

        const beforeRetry = { A: a.fixture.counts(), B: serviceB.counts() };
        await a.fixture.setJobFault(a.baselineOwned.remoteJobId, "engine-failed");
        const failed = await drive(request, a.id, (job) => job.status === "failed", info);
        expect(failed).toMatchObject({ status: "failed", phase: "poll", reason: "engine_failed", attempt: 1 });
        await assertNativePreserved(request, a);
        expect(await enhancement(request, b.id)).toMatchObject({ status: "running", attempt: 1 });
        expect(await enhancement(request, cancellable.id)).toMatchObject({ status: "running", attempt: 1 });
        await checkpoint("only original A remote explicitly engine_failed while B defaults are current");
        await page.goto(`/create?conversationId=${encodeURIComponent(a.run.conversationId)}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("creative-media-result").getByRole("status")).toContainText("AI增强失败");
        await retryFromDesktop(page, a.id, 2);
        const duplicate = await request.post(`/api/image-enhancements/${encodeURIComponent(a.id)}`, { data: { action: "retry" } });
        expect(duplicate.status()).toBe(409);
        controls.push({ action: "desktop enhancement retry followed by duplicate API retry", id: a.id, acceptedAttempt: 2, duplicateStatus: duplicate.status(), observedAt: Date.now() });
        const retried = await drive(request, a.id, (job) => job.status === "running" && job.phase === "poll" && job.attempt === 2, info);
        const attempt2 = await readOwnedJob(a.root, a.id);
        expect(retried.native).toEqual(a.initial.native);
        expect(retried.target).toEqual(a.initial.target);
        expect(attempt2.decision).toEqual(a.baselineOwned.decision);
        expect(attempt2.remotePlan).toEqual(a.baselineOwned.remotePlan);
        expect(attempt2.remoteKey).toBe(`${a.id}:2`);
        expect(attempt2.remoteKey).not.toBe(a.baselineOwned.remoteKey);
        expect(attempt2.remoteJobId).not.toBe(a.baselineOwned.remoteJobId);
        expect(attempt2.receiptId).not.toBe(a.baselineOwned.receiptId);
        expect(attempt2.events.filter((event: { stage: string }) => event.stage === "prepared")).toHaveLength(1);
        expect(attempt2.events.filter((event: { stage: string; attempt: number }) => event.stage === "retry_requested" && event.attempt === 2)).toHaveLength(1);
        const afterDuplicate = await a.fixture.snapshot();
        expect(afterDuplicate.jobs.filter((job: { key: string }) => job.key.startsWith(`${a.id}:`))).toHaveLength(2);
        expect(afterDuplicate.jobs.filter((job: { key: string; status: string }) => job.key.startsWith(`${a.id}:`) && ["queued", "running"].includes(job.status))).toHaveLength(1);
        expect(afterDuplicate.calls.filter((call: { key?: string; method: string }) => call.key === attempt2.remoteKey && call.method === "POST")).toHaveLength(1);
        expect({ A: a.fixture.counts(), B: serviceB.counts() }).toEqual(beforeRetry);
        await checkpoint("actual desktop enhancement-only retry accepted once as A attempt2; duplicate API retry rejected");

        const disabled = await setEnhancementEnabled(request, false);
        controls.push({ action: "disable pending A2/B", ...disabled });
        for (const current of [a, b, cancellable]) {
            expect(await enhancement(request, current.id)).toMatchObject({ status: "running" });
            expect((await readOwnedJob(a.root, current.id)).events.some((event: { stage: string }) => event.stage === "cancel_requested")).toBe(false);
            await assertNativePreserved(request, current);
        }
        expect((await a.fixture.snapshot()).cancelRequests).toEqual([]);
        expect((await serviceB.snapshot()).cancelRequests).toEqual([]);
        expect({ A: a.fixture.counts(), B: serviceB.counts() }).toEqual(beforeRetry);
        await checkpoint("real admin disable leaves A2, B and independent A-family enhancement active");
        const protocolBeforeC = { A: (await a.fixture.snapshot()).jobs, B: (await serviceB.snapshot()).jobs };
        const c = await createNativeCase(page, request, info, serviceB, "C", 2, true);
        family.push({ owner: "C", current: c });
        expect(c.initial).toMatchObject({ status: "skipped", reason: "disabled", target: { width: 4096, height: 4096 } });
        expect(c.baselineOwned).not.toHaveProperty("decision.connection");
        expect(c.baselineOwned).not.toHaveProperty("submittedAt");
        expect(c.baselineOwned).not.toHaveProperty("publication");
        expect(c.generationDelta.generation).toBe(1);
        expect(c.generationDelta.planning).toBeGreaterThan(0);
        expect((await adminSettings(request)).enabled).toBe(false);
        await expect(page.getByTestId("creative-media-result").getByRole("status")).toContainText("未启用AI增强");
        const protocolAfterC = { A: (await a.fixture.snapshot()).jobs, B: (await serviceB.snapshot()).jobs };
        expect(protocolAfterC).toEqual(protocolBeforeC);
        await checkpoint("C ordinary 4K native persisted with disabled skipped job; legitimate C upstream calls counted separately");
        const beforeEnhancementOnly = { A: a.fixture.counts(), B: serviceB.counts() };

        await a.fixture.setJobFault(attempt2.remoteJobId, "ready");
        await serviceB.setJobFault(b.baselineOwned.remoteJobId, "ready");
        const completedA = await drive(request, a.id, (job) => job.status === "succeeded" && job.phase === "completed", info);
        const completedB = await drive(request, b.id, (job) => job.status === "succeeded" && job.phase === "completed", info);
        expect(completedA.attempt).toBe(2);
        expect(completedB.attempt).toBe(1);
        expect(completedA.enhanced!.assetId).not.toBe(completedB.enhanced!.assetId);
        for (const current of [a, b]) {
            const owned = await readOwnedJob(a.root, current.id);
            expect(owned.decision).toEqual(current.baselineOwned.decision);
            expect(owned.remotePlan).toEqual(current.baselineOwned.remotePlan);
            expect(owned.events.filter((event: { stage: string }) => event.stage === "published")).toHaveLength(1);
            expect(owned.events.filter((event: { stage: string }) => event.stage === "receipt_confirmed")).toHaveLength(1);
            const children = (await assets(request, current.run.conversationId)).filter((asset) => asset.metadata?.enhancementId === current.id && asset.metadata?.provenance === "ai_enhanced");
            expect(children).toHaveLength(1);
            expect(children[0]).toMatchObject({ id: owned.publication.assetId, parentAssetId: current.native.id, width: 4096, height: 4096 });
            await assertDeliveredFromDesktop(page, request, current);
        }
        expect(await enhancement(request, cancellable.id)).toMatchObject({ status: "running", attempt: 1 });
        expect((await adminSettings(request)).enabled).toBe(false);
        await checkpoint("A2 and B independently published and receipts confirmed while enhancement remains disabled");

        const deliveredBeforeDisable = await Promise.all([readOwnedJob(a.root, a.id), readOwnedJob(a.root, b.id)]);
        // A second actual off transition observes already delivered images without another native generation.
        const deliveredEnable = await setEnhancementEnabled(request, true);
        controls.push({ action: "enable only for subsequent delivered-image off transition", ...deliveredEnable });
        const deliveredDisable = await setEnhancementEnabled(request, false);
        controls.push({ action: "disable already delivered A2/B", ...deliveredDisable });
        expect(await Promise.all([readOwnedJob(a.root, a.id), readOwnedJob(a.root, b.id)])).toEqual(deliveredBeforeDisable);
        for (const current of [a, b]) await assertDeliveredFromDesktop(page, request, current);
        expect({ A: a.fixture.counts(), B: serviceB.counts() }).toEqual(beforeEnhancementOnly);
        await checkpoint("actual disable transition retains both already delivered images and original downloads");

        const othersBeforeCancel = await Promise.all([a, b, c].map((current) => readOwnedJob(a.root, current.id)));
        await page.goto(`/create?conversationId=${encodeURIComponent(cancellable.run.conversationId)}`, { waitUntil: "domcontentloaded" });
        const cancelResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/image-enhancements/${encodeURIComponent(cancellable.id)}`);
        const clickedAt = Date.now();
        await page.getByTestId("creative-media-result").getByRole("button", { name: "取消增强", exact: true }).click();
        const cancellation = await cancelResponse;
        expect(cancellation.ok()).toBe(true);
        const cancelled = await drive(request, cancellable.id, (job) => job.status === "cancelled", info);
        const cancelEvent = cancelled.events.find((event) => event.stage === "cancel_requested")!;
        controls.push({ action: "desktop explicit cancel", id: cancellable.id, clickedAt, responseStatus: cancellation.status(), cancelEvent, observedAt: Date.now() });
        expect(cancelEvent.at).toBeGreaterThanOrEqual(clickedAt);
        expect(cancelEvent.at).toBeGreaterThan(deliveredDisable.completedAt);
        expect(cancelEvent.at).toBeGreaterThan(disabled.completedAt);
        await assertNativePreserved(request, cancellable);
        expect(await Promise.all([a, b, c].map((current) => readOwnedJob(a.root, current.id)))).toEqual(othersBeforeCancel);
        const aLedger = await a.fixture.snapshot();
        const bLedger = await serviceB.snapshot();
        expect(aLedger.cancelRequests).toEqual([{ owner: "A", jobId: cancellable.baselineOwned.remoteJobId, previousStatus: "running", at: expect.any(Number) }]);
        expect(aLedger.cancelRequests[0].at).toBeGreaterThanOrEqual(cancelEvent.at);
        expect(bLedger.cancelRequests).toEqual([]);
        expect(aLedger.jobs.find((job: { jobId: string }) => job.jobId === cancellable.baselineOwned.remoteJobId)).toMatchObject({ status: "cancelled", executionCount: 1 });
        await checkpoint("only separate A-family enhancement explicitly cancelled on original service after disable");

        const beforeRefresh = { A: await a.fixture.snapshot(), B: await serviceB.snapshot() };
        for (const { current } of family) {
            await page.goto(`/create?conversationId=${encodeURIComponent(current.run.conversationId)}`, { waitUntil: "domcontentloaded" });
            for (let refresh = 0; refresh < 2; refresh++) {
                await page.reload({ waitUntil: "domcontentloaded" });
                await expect(page.getByTestId("creative-media-result")).toHaveCount(1);
                await enhancement(request, current.id);
                await generationLog(request, current.id);
                await assertNativePreserved(request, current);
            }
        }
        for (const current of [a, b]) await assertDeliveredFromDesktop(page, request, current);
        const finalA = await a.fixture.snapshot();
        const finalB = await serviceB.snapshot();
        expect({ A: finalA, B: finalB }).toEqual(beforeRefresh);
        expect({ A: a.fixture.counts(), B: serviceB.counts() }).toEqual(beforeEnhancementOnly);
        expect(countDelta(beforeEnhancementOnly.A, a.fixture.counts())).toEqual({ generation: 0, analysis: 0, planning: 0, otherText: 0, otherPost: 0 });
        expect(countDelta(beforeEnhancementOnly.B, serviceB.counts())).toEqual({ generation: 0, analysis: 0, planning: 0, otherText: 0, otherPost: 0 });
        expect(a.fixture.counts().counts.generation + serviceB.counts().counts.generation).toBe(4);
        expect(finalA.fixtureError).toBeUndefined();
        expect(finalB.fixtureError).toBeUndefined();
        expect(finalA.jobs).toHaveLength(3);
        expect(finalB.jobs).toHaveLength(1);
        expect(finalA.calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toHaveLength(3);
        expect(finalB.calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toHaveLength(1);
        expect(finalA.jobs.find((job: { jobId: string }) => job.jobId === a.baselineOwned.remoteJobId)).toMatchObject({ status: "failed", reason: "engine_failed", key: a.baselineOwned.remoteKey });
        expect(finalA.calls.filter((call: { path: string }) => call.path === `/v1/enhancement-jobs/${attempt2.remoteJobId}/result`)).toHaveLength(1);
        expect(finalB.calls.filter((call: { path: string }) => call.path === `/v1/enhancement-jobs/${b.baselineOwned.remoteJobId}/result`)).toHaveLength(1);
        for (const job of finalA.jobs) {
            expect(job.executionCount).toBe(1);
            expect(finalB.calls.some((call: { path: string; key?: string }) => call.path.includes(job.jobId) || call.key === job.key)).toBe(false);
        }
        expect(finalB.jobs[0]).toMatchObject({ jobId: b.baselineOwned.remoteJobId, key: b.baselineOwned.remoteKey, executionCount: 1 });
        expect(finalA.acceptedReceipts).toHaveLength(1);
        expect(finalA.receiptRequests).toHaveLength(1);
        expect(finalA.acceptedReceipts[0]).toMatchObject({ jobId: attempt2.remoteJobId, receipt: { receiptId: attempt2.receiptId } });
        expect(finalB.acceptedReceipts).toHaveLength(1);
        expect(finalB.receiptRequests).toHaveLength(1);
        expect(finalB.acceptedReceipts[0]).toMatchObject({ jobId: b.baselineOwned.remoteJobId, receipt: { receiptId: b.baselineOwned.receiptId } });
        for (const fixture of [a.fixture, serviceB]) {
            const ledger = await fixture.snapshot();
            expect(ledger.jobs.some((job: { key: string }) => job.key === c.baselineOwned.remoteKey)).toBe(false);
            expect(fixture.isListening()).toBe(true);
        }
        expect(await enhancement(request, c.id)).toMatchObject({ status: "skipped", reason: "disabled", attempt: 1 });
        expect(await enhancement(request, cancellable.id)).toMatchObject({ status: "cancelled", attempt: 1 });
        await checkpoint("repeated actual browser/public/log reads preserve all jobs, publications and ordinary upstream counts");
        await page.screenshot({ path: info.outputPath("configuration-lifecycle-final.png"), fullPage: true });
    } finally {
        try {
            await checkpoint("final observation; no pass inferred from this checkpoint");
        } finally {
            try {
                await finishCase(request, a, info);
            } finally {
                await serviceB?.close();
            }
        }
    }
});

test("SR-M5-05 actual owned Web exit: new application PID reclaims the naturally expired lease and maps the same durable remote job", async ({ page, request }, info) => {
    test.skip(process.env.VOZEB_PRO_M5_RESTART_REENTRY !== "1", "Run only with the private owned-process restart config after other Next runs finish.");
    const root = ownedDataDirectory();
    const timeline: unknown[] = [];
    let sourceHashes: Awaited<ReturnType<typeof restartSourceHashes>> = [];
    const cleanupFailures: Array<{ operation: string; message: string }> = [];
    let stage = "source provenance";
    let primary: unknown;
    let current: Case | undefined;
    let fixture: Fixture | undefined;
    let boot1: Awaited<ReturnType<typeof startOwnedWeb>> | undefined;
    let boot2: Awaited<ReturnType<typeof startOwnedWeb>> | undefined;
    let releaseFirst = () => {};
    let releaseReplay = () => {};
    let submitCapture: SubmitCapture | undefined;
    const checkpoint = async (name: string, value: unknown) => {
        stage = name;
        timeline.push({ stage: name, observedAt: Date.now(), value });
        await evidence(info, "restart-timeline", { kind: "actual owned Next process restart and controlled synthetic protocol/executor; not Native/GPU/AI quality acceptance", runId: process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID, sourceHashes, timeline });
    };
    try {
        sourceHashes = await restartSourceHashes();
        const { default: applicationConfig } = await import("../playwright.config");
        const servers = applicationConfig.webServer as Array<{ env: Record<string, string> }>;
        const applicationEnv = servers.at(-1)!.env;
        stage = "boot1 and ordinary Route bootstrap";
        boot1 = await startOwnedWeb({ root, bootId: "restart-boot1", applicationEnv });
        const installation = await request.get("/api/install/status");
        expect(installation.ok()).toBe(true);
        if ((await installation.json()).install.database?.schemaReady === false) {
            expect((await request.post("/api/install/initialize", { data: { installToken: E2E_ADMIN.installToken } })).ok()).toBe(true);
        }
        expect((await request.post("/api/auth/register", { data: E2E_ADMIN })).ok()).toBe(true);
        expect((await request.patch("/api/admin/settings", { data: e2eSettingsPatch() })).ok()).toBe(true);
        await page.context().addCookies((await request.storageState()).cookies);
        await checkpoint("boot1 actual CLI and socket-owning preloaded application identities", bootFacts(boot1));
        fixture = await createBusinessFaultFixture({ root, caseId: "restart-reentry", imagePath: process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE!, controlledExecutor: true });
        await qualify(request, fixture);
        await configureNormalGeneration(request, fixture);
        type Boundary = { job: { jobId: string; key: string; executor: { pid: number; startTicks: string; executionId: string } }; replayed: boolean; durableAt: number };
        let firstBoundary: Boundary | undefined;
        let replayBoundary: Boundary | undefined;
        const firstBarrier = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const replayBarrier = new Promise<void>((resolve) => {
            releaseReplay = resolve;
        });
        fixture.beforeSubmitReply(async (boundary: Boundary) => {
            if (boundary.replayed) {
                replayBoundary = boundary;
                await replayBarrier;
            } else {
                firstBoundary = boundary;
                await firstBarrier;
            }
        });
        const owner1 = `m5-restart-boot1:${boot1.service!.pid}`;
        submitCapture = { workerId: owner1, accepted: () => Boolean(firstBoundary), stop: false };
        stage = "actual native creation with first durable submit response already held by fixture";
        current = await createNativeCase(page, request, info, fixture, "restart-reentry", 1, false, submitCapture);
        const settingsBefore = await adminSettings(request);
        expect(firstBoundary).toBeDefined();
        expect(submitCapture.outcome).toBeUndefined();
        const first = firstBoundary!;
        const oldRequest = submitCapture.pending!;
        expect(current.baselineOwned.phase).toBe("submit");
        expect(current.baselineOwned.submittedAt).toEqual(expect.any(Number));
        expect(current.baselineOwned).not.toHaveProperty("remoteJobId");
        await checkpoint("original native/Agent/first-review finalization is durable while first remote response remains held; ordinary generation window closes before Web exit", {
            first,
            current: {
                run: await runState(request, current.run.id),
                native: current.native,
                owned: current.baselineOwned,
                nativeTask: current.baselineTask,
                nativeMedia: current.baselineMedia,
                nativeLog: current.baselineLog,
                ordinaryGenerationDelta: current.generationDelta,
                beforeEnhancementOnly: current.before,
            },
            configuration: configurationFacts(settingsBefore),
        });
        stage = "durable first remote acceptance and original actual lease before Web exit";
        const leased = await readOwnedJob(root, current.id);
        expect(leased).toMatchObject({
            status: "running",
            phase: "submit",
            workerId: owner1,
            leaseToken: expect.any(String),
            leaseUntil: expect.any(Number),
            submittedAt: expect.any(Number),
            remoteKey: current.baselineOwned.remoteKey,
            receiptId: current.baselineOwned.receiptId,
            attempt: 1,
        });
        expect(leased).not.toHaveProperty("remoteJobId");
        expect(leased.leaseUntil).toBeGreaterThan(Date.now());
        expect(leased.leaseUntil - Date.now()).toBeLessThanOrEqual(90_000);
        const durableFirst = JSON.parse(await readFile(fixture.ledgerPath, "utf8"));
        expect(durableFirst.protocolProcess.pid).toBe(process.pid);
        expect(durableFirst.protocolProcess.pid).not.toBe(boot1.service!.pid);
        expect(durableFirst.jobs).toHaveLength(1);
        expect(durableFirst.jobs[0]).toMatchObject({ key: leased.remoteKey, jobId: first.job.jobId, executor: first.job.executor });
        expect(durableFirst.calls.filter((call: { path: string; method: string }) => call.path === "/v1/enhancement-jobs" && call.method === "POST")).toEqual([
            expect.objectContaining({ key: leased.remoteKey, responseHeldAt: expect.any(Number), responseStatus: null, closedAt: null }),
        ]);
        const executorBefore = await fixture.observeExecutor(first.job.jobId, "before-original-Web-exit");
        expect(executorBefore.identity!.pgrp).not.toBe(boot1.cli!.pid);
        await checkpoint("remote job fsynced before response; real executor bound and live; original actual Web owns the submit lease", { first, leased, durableFirst, executorBefore });

        stage = "actual boot1 service and CLI exit";
        const stopped1 = await stopOwnedWeb(boot1);
        expect(stopped1.cliGone).toBe(true);
        expect(stopped1.serviceGone).toBe(true);
        releaseFirst();
        const lost = await untilObserved(
            () => fixture!.snapshot(),
            (ledger) => ledger.calls.some((call: { key?: string; responseLost?: boolean }) => call.key === leased.remoteKey && call.responseLost === true),
            "remote observed response loss caused by original Web exit",
        );
        const lostCall = lost.calls.find((call: { key?: string; responseLost?: boolean }) => call.key === leased.remoteKey && call.responseLost);
        expect(lostCall).toMatchObject({ responseStatus: null, lostAfterAcceptance: true, closedAt: expect.any(Number) });
        expect(lostCall.closedAt).toBeGreaterThanOrEqual(stopped1.signalAt);
        expect(lostCall.responseHeldAt).toBeLessThanOrEqual(stopped1.signalAt);
        expect(stopped1.signalAt - lostCall.receivedAt).toBeLessThan(timeoutMs);
        expect((await oldRequest).kind).toBe("error");
        const abandoned = await readOwnedJob(root, current.id);
        expect(abandoned.workerId).toBe(owner1);
        expect(abandoned.leaseToken).toBe(leased.leaseToken);
        expect(abandoned.remotePlan).toEqual(current.baselineOwned.remotePlan);
        expect(abandoned).not.toHaveProperty("remoteJobId");
        const executorWithoutWeb = await fixture.observeExecutor(first.job.jobId, "after-original-Web-and-CLI-exit");
        expect(executorWithoutWeb.identity!.pid).toBe(executorBefore.identity!.pid);
        expect(executorWithoutWeb.identity!.startTicks).toBe(executorBefore.identity!.startTicks);
        await checkpoint("boot1 exact PIDs are gone; creating response lost after durable acceptance; same executor survives", { stopped1, lostCall, abandoned, executorWithoutWeb, oldRequest: await oldRequest });

        stage = "boot2 reopens same data and legal frozen configuration";
        boot2 = await startOwnedWeb({ root, bootId: "restart-boot2", applicationEnv });
        expect(boot2.cli!.pid).not.toBe(boot1.cli!.pid);
        expect(boot2.service!.pid).not.toBe(boot1.service!.pid);
        expect(boot2.service!.startTicks).not.toBe(boot1.service!.startTicks);
        expect(boot2.startedAt).toBeGreaterThanOrEqual(stopped1.serviceGoneObservedAt);
        expect(await adminSettings(request)).toEqual(settingsBefore);
        expect(await readOwnedJob(root, current.id)).toEqual(abandoned);
        await assertNativePreserved(request, current);
        const executorAfterBoot = await fixture.observeExecutor(first.job.jobId, "new-Web-ready-before-lease-reclaim");
        expect(executorAfterBoot.identity!.pgrp).not.toBe(boot2.cli!.pid);
        expect(executorAfterBoot.identity!.pid).toBe(executorBefore.identity!.pid);
        expect(executorAfterBoot.identity!.startTicks).toBe(executorBefore.identity!.startTicks);
        expect((await fixture.snapshot()).calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toHaveLength(1);
        expect(fixture.counts()).toEqual(current.before);
        const expiryWaitStartedAt = Date.now();
        await untilObserved(
            async () => Date.now(),
            (now) => now >= abandoned.leaseUntil,
            "original unmodified ninety-second lease expiration",
            135_000,
        );
        const expiryObservedAt = Date.now();
        expect(await readOwnedJob(root, current.id)).toEqual(abandoned);
        await checkpoint("different actual Web PID reads identical case/config/native; original lease expires using wall time without JSON or clock edits", {
            boot2: bootFacts(boot2),
            oldLease: { workerId: abandoned.workerId, leaseTokenSha256: sha256(Buffer.from(abandoned.leaseToken)), leaseUntil: abandoned.leaseUntil },
            expiryWaitStartedAt,
            expiryObservedAt,
            executorAfterBoot,
            enhancementOnlyDelta: countDelta(current.before, fixture.counts()),
        });

        stage = "boot2 actual maintenance claim and same-key replay held before reply";
        const owner2 = `m5-restart-boot2:${boot2.service!.pid}`;
        let replayOutcome: string | undefined;
        const newRequest = advanceWorker(request, owner2, timeoutMs + 45_000).then(
            (data) => {
                replayOutcome = "response";
                return { kind: "response" as const, data };
            },
            (error: Error) => {
                replayOutcome = "error";
                return { kind: "error" as const, message: error.message };
            },
        );
        const replay = await untilObserved(
            async () => {
                if (replayOutcome) throw new Error(`Recovery submit finished before replay barrier: ${replayOutcome}`);
                return replayBoundary;
            },
            Boolean,
            "same durable job replay under boot2 actual lease",
        );
        expect(replay).toMatchObject({ replayed: true, job: { jobId: first.job.jobId, key: first.job.key, executor: first.job.executor } });
        const next = await readOwnedJob(root, current.id);
        expect(next).toMatchObject({
            workerId: owner2,
            status: "running",
            phase: "submit",
            remoteKey: abandoned.remoteKey,
            receiptId: abandoned.receiptId,
            attempt: abandoned.attempt,
            remotePlan: abandoned.remotePlan,
            decision: abandoned.decision,
            submittedAt: abandoned.submittedAt,
        });
        expect(next.leaseToken).not.toBe(abandoned.leaseToken);
        expect(next.leaseUntil).toBeGreaterThan(Date.now());
        expect(replay.durableAt).toBeGreaterThanOrEqual(abandoned.leaseUntil);
        const fence = await proveOldOwnerFence({ root, old: abandoned, next });
        expect(fence).toMatchObject({ returnedNull: true, callbackInvocations: 0, entireRowUnchanged: true });
        expect(fence.beforeRowSha256).toBe(fence.afterRowSha256);
        const executorDuringReplay = await fixture.observeExecutor(first.job.jobId, "same-key-replay-while-new-owner-holds-real-lease");
        expect(executorDuringReplay.identity!.pid).toBe(executorBefore.identity!.pid);
        expect(executorDuringReplay.identity!.startTicks).toBe(executorBefore.identity!.startTicks);
        expect(executorDuringReplay.reply.sequence).toBeGreaterThan(executorBefore.reply.sequence);
        const replayLedger = await fixture.snapshot();
        expect(replayLedger.jobs).toHaveLength(1);
        expect(replayLedger.executorRuns).toHaveLength(1);
        expect(replayLedger.maxConcurrentExecutors).toBe(1);
        await checkpoint("new actual Web owner reclaims same key/job; old-owner actual repository guard rejects without invoking mutation callback; one original executor remains live", { replay, next, fence, executorDuringReplay, replayLedger });
        releaseReplay();
        const resumedRequest = await newRequest;
        expect(resumedRequest.kind).toBe("response");
        if (resumedRequest.kind !== "response") throw new Error("New owner maintenance request failed");
        expect(resumedRequest.data.enhancement.claimed).toBe(1);
        const mapped = await readOwnedJob(root, current.id);
        expect(mapped).toMatchObject({ remoteJobId: first.job.jobId, remoteKey: abandoned.remoteKey, receiptId: abandoned.receiptId, attempt: 1, phase: "poll" });
        expect(mapped.events.filter((event: { stage: string }) => event.stage === "prepared")).toHaveLength(1);
        expect(mapped.events.filter((event: { stage: string }) => event.stage === "retry_requested")).toEqual([]);
        const executorCompletion = await fixture.completeExecutor(first.job.jobId);
        await checkpoint("same remote mapping restored; original controlled executor completed and cleanly exited before remote success becomes visible", { mapped, executorCompletion });

        let beforeReceipt: unknown;
        let beforeReceiptFailure: unknown;
        fixture.beforeReceipt(async (boundary: { job: { jobId: string; retained: boolean }; receipt: unknown; acceptedReceipts: unknown[] }) => {
            try {
                expect(boundary.job).toMatchObject({ jobId: first.job.jobId, retained: true });
                expect(boundary.acceptedReceipts).toEqual([]);
                const publication = await readOwnedJob(root, current!.id);
                const media = await mediaSnapshot(root, current!.id);
                const children = (await assets(request, current!.run.conversationId)).filter((asset) => asset.metadata?.enhancementId === current!.id && asset.metadata?.provenance === "ai_enhanced");
                expect(media).toHaveLength(2);
                expect(children).toHaveLength(1);
                expect(publication).toMatchObject({ status: "succeeded", phase: "receipt", remoteJobId: first.job.jobId, receiptId: abandoned.receiptId });
                const saved = await request.get(publication.publication.delivered.url);
                expect(saved.ok()).toBe(true);
                expect(await decoded(await saved.body())).toMatchObject({ width: 4096, height: 4096, sha256: publication.publication.delivered.sha256 });
                beforeReceipt = { boundary, publication, media, children, observedAt: Date.now() };
                await evidence(info, "restart-permanent-publication-before-receipt", beforeReceipt);
            } catch (error) {
                beforeReceiptFailure = error;
                throw error;
            }
        });
        stage = "actual AI/final media, independent asset registration and receipt";
        const completed = await drive(
            request,
            current.id,
            (job) => {
                if (beforeReceiptFailure) throw beforeReceiptFailure;
                expect(job.status, `Actual restart recovery failed during ${job.phase}: ${job.reason}`).not.toBe("failed");
                return job.status === "succeeded" && job.phase === "completed";
            },
            info,
        );
        expect(beforeReceipt).toBeDefined();
        const confirmed = await readOwnedJob(root, current.id);
        expect(confirmed).toMatchObject({
            remoteKey: abandoned.remoteKey,
            remoteJobId: first.job.jobId,
            receiptId: abandoned.receiptId,
            attempt: abandoned.attempt,
            remotePlan: abandoned.remotePlan,
            decision: abandoned.decision,
            remoteResult: fixture.expected,
        });
        expect(confirmed.events.filter((event: { stage: string }) => event.stage === "published")).toHaveLength(1);
        expect(confirmed.events.filter((event: { stage: string }) => event.stage === "receipt_confirmed")).toHaveLength(1);
        expect(confirmed.workerId).toBeNull();
        expect(confirmed.leaseToken).toBeNull();
        const permanent = await mediaSnapshot(root, current.id);
        expect(permanent).toHaveLength(2);
        expect(permanent.find((asset) => asset.sha256 === fixture!.expected.sha256)).toBeDefined();
        expect(permanent.find((asset) => asset.sha256 === completed.enhanced!.sha256)).toBeDefined();
        const fullAi = await request.get(confirmed.publication.ai.url);
        expect(fullAi.ok()).toBe(true);
        expect(await decoded(await fullAi.body())).toMatchObject({ width: 5016, height: 5016, byteLength: fixture.expected.byteLength, sha256: fixture.expected.sha256 });
        await assertDeliveredFromDesktop(page, request, current);
        const afterDelivery = await fixture.snapshot();
        const businessCalls = afterDelivery.calls.filter((call: { role: string; path: string }) => call.role === "application" && call.path.includes(first.job.jobId));
        const submits = afterDelivery.calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs");
        expect(submits).toHaveLength(2);
        expect(submits[0]).toMatchObject({ key: abandoned.remoteKey, jobId: first.job.jobId, replayed: false, responseLost: true, responseStatus: null });
        expect(submits[1]).toMatchObject({ key: abandoned.remoteKey, jobId: first.job.jobId, replayed: true, responseLost: false, responseStatus: 200 });
        expect(afterDelivery.jobs).toHaveLength(1);
        expect(afterDelivery.executorRuns).toHaveLength(1);
        expect(afterDelivery.executorRuns[0]).toMatchObject({ pid: executorBefore.identity!.pid, exit: { code: 0, signal: null } });
        expect(afterDelivery.maxConcurrentExecutors).toBe(1);
        expect(afterDelivery.executorObservations.every((entry: { activePids: number[] }) => entry.activePids.length <= 1)).toBe(true);
        expect(afterDelivery.receiptRequests).toHaveLength(1);
        expect(afterDelivery.acceptedReceipts).toHaveLength(1);
        expect(afterDelivery.acceptedReceipts[0]).toMatchObject({ jobId: first.job.jobId, receipt: { receiptId: abandoned.receiptId, result: fixture.expected } });
        expect(businessCalls.filter((call: { path: string }) => call.path === `/v1/enhancement-jobs/${first.job.jobId}/result`)).toHaveLength(1);
        expect(afterDelivery.fixtureError).toBeUndefined();
        await checkpoint("one complete AI plus delivered permanent registration, one child/publication/receipt and actual original/enhanced desktop downloads", {
            completed,
            confirmed,
            permanent,
            ledger: afterDelivery,
            ordinaryBefore: current.before,
            ordinaryAfter: fixture.counts(),
            enhancementOnlyDelta: countDelta(current.before, fixture.counts()),
        });

        stage = "fresh browser, public and log reads must not resubmit or execute again";
        for (let refresh = 0; refresh < 2; refresh++) {
            await page.reload({ waitUntil: "domcontentloaded" });
            await expect(page.getByTestId("creative-media-result")).toHaveCount(1);
            await enhancement(request, current.id);
            await generationLog(request, current.id);
            await assertNativePreserved(request, current);
        }
        await assertDeliveredFromDesktop(page, request, current);
        const afterReads = await fixture.snapshot();
        expect(afterReads).toEqual(afterDelivery);
        expect(await readOwnedJob(root, current.id)).toEqual(confirmed);
        expect(await mediaSnapshot(root, current.id)).toEqual(permanent);
        expect(fixture.counts()).toEqual(current.before);
        expect(countDelta(current.before, fixture.counts())).toEqual({ generation: 0, analysis: 0, planning: 0, otherText: 0, otherPost: 0 });
        expect(current.browserWorkerRequests).toEqual([]);
        expect(await restartSourceHashes()).toEqual(sourceHashes);
        const children = (await assets(request, current.run.conversationId)).filter((asset) => asset.metadata?.enhancementId === current!.id && asset.metadata?.provenance === "ai_enhanced");
        expect(children).toEqual([expect.objectContaining({ id: confirmed.publication.assetId, parentAssetId: current.native.id, width: 4096, height: 4096 })]);
        await page.screenshot({ path: info.outputPath("restart-same-job-final.png"), fullPage: true });
        await checkpoint("repeated fresh/log/download reads add zero submit, execution, publication or ordinary generation/analysis/planning/other calls", {
            ledger: afterReads,
            confirmed,
            children,
            generationWindow: current.generationDelta,
            enhancementOnlyDelta: countDelta(current.before, fixture.counts()),
        });
    } catch (error) {
        primary = error;
        if (error instanceof Error && "cleanupError" in error) cleanupFailures.push({ operation: "startup owned-process containment", message: String(error.cleanupError) });
        timeline.push({ stage: "first failure", failedDuring: stage, observedAt: Date.now(), error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
    } finally {
        if (submitCapture) submitCapture.stop = true;
        releaseFirst();
        releaseReplay();
        const cleanup = async (operation: string, action: () => Promise<unknown>) => {
            try {
                const result = await action();
                timeline.push({ stage: "cleanup", operation, observedAt: Date.now(), result });
            } catch (error) {
                cleanupFailures.push({ operation, message: error instanceof Error ? error.message : String(error) });
            }
        };
        if (fixture) await cleanup("capture final remote ledger before cleanup", async () => evidence(info, "restart-final-worker-ledger", await fixture!.snapshot()));
        if (boot2) await cleanup("stop only boot2 owned application and CLI", () => stopOwnedWeb(boot2!));
        if (boot1 && !boot1.stopped) await cleanup("contain only boot1 owned application and CLI", () => stopOwnedWeb(boot1!));
        if (fixture)
            await cleanup("stop only the case protocol servers and any still owned executor", async () => {
                await fixture!.close();
                return fixture!.snapshot();
            });
        await cleanup("write first failure and cleanup outcomes separately", () => evidence(info, "restart-outcome", { primaryFailure: primary ? { failed: true } : null, cleanupFailures, timeline }));
    }
    if (primary) throw primary;
    if (cleanupFailures.length) throw new Error(`Owned restart cleanup failed: ${cleanupFailures.map((failure) => `${failure.operation}: ${failure.message}`).join("; ")}`);
});

async function beginCase(page: Page, request: APIRequestContext, info: TestInfo, caseId: string): Promise<Case> {
    const root = ownedDataDirectory();
    const fixture = await createBusinessFaultFixture({ root, caseId, imagePath: process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE! });
    try {
        await qualify(request, fixture);
        await configureNormalGeneration(request, fixture);
        return await createNativeCase(page, request, info, fixture, caseId);
    } catch (error) {
        try {
            await evidence(info, "setup-worker-ledger", await fixture.snapshot());
        } finally {
            await fixture.close();
        }
        throw error;
    }
}

async function configureNormalGeneration(request: APIRequestContext, fixture: Fixture) {
    const base = e2eSettingsPatch();
    const operation = {
        capability: "image" as const,
        source: "manual" as const,
        protocol: "custom" as const,
        apiFormat: "openai" as const,
        createPath: "/custom/images",
        editPath: "/custom/images",
        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}","quality":"{{quality}}","references":"{{images}}"}',
        resultField: "data.image_url",
        referenceRule: "base64 inline image references",
        supportsReferenceImage: true,
    };
    const channels = base.systemChannels.map((channel) => ({
        ...channel,
        baseUrl: `${fixture.upstreamEndpoint}/v1`,
        models: channel.models.filter((model) => !model.includes("image")),
        advancedConfig: {
            ...channel.advancedConfig,
            modelCapabilities: Object.fromEntries(Object.entries(channel.advancedConfig.modelCapabilities).filter(([, capability]) => capability !== "image")),
            modelConfigs: Object.fromEntries(Object.entries(channel.advancedConfig.modelConfigs).filter(([model]) => !model.includes("image"))),
        },
    }));
    const configured = await request.patch("/api/admin/settings", {
        data: {
            ...base,
            ecommerceGenerationEnabled: false,
            systemChannels: [
                ...channels,
                {
                    id: "m5-local-native",
                    name: "M5 controlled native fixture",
                    baseUrl: fixture.upstreamEndpoint,
                    apiKey: "m5-local-native-test-token",
                    apiFormat: "openai",
                    models: [MODEL],
                    enabled: true,
                    advancedConfig: { ...emptyAdvancedConfig(), ...operation, modelCapabilities: { [MODEL]: "image" }, modelConfigs: { [MODEL]: operation }, operationConfigs: { image: operation } },
                },
            ],
            logicalModels: base.logicalModels.filter((model) => model.capability !== "image"),
            defaultModels: { ...base.defaultModels, imageModel: MODEL },
            ecommerceModelRoles: { ...base.ecommerceModelRoles, image_generation: [] },
            modelPointCosts: { ...base.modelPointCosts, [MODEL]: 0 },
        },
    });
    expect(configured.ok()).toBe(true);
}

async function createNativeCase(page: Page, request: APIRequestContext, info: TestInfo, fixture: Fixture, caseId: string, generationCount = 1, skipped = false, submitCapture?: SubmitCapture): Promise<Case> {
    expect(Number.isSafeInteger(timeoutMs) && timeoutMs > 0).toBe(true);
    const root = ownedDataDirectory();
    const proof = await readPreloadRecords(root);
    const session = await request.get("/api/auth/session");
    expect(session.ok()).toBe(true);
    expect((await session.json()).user).toMatchObject({ role: "admin" });
    const browserWorkerRequests: string[] = [];
    page.on("request", (entry) => {
        if (new URL(entry.url()).origin === fixture.endpoint) browserWorkerRequests.push(entry.url());
    });
    const generationBefore = fixture.counts();
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    const preferences = page.locator("[data-creative-generation-preferences]");
    await preferences.getByRole("tab", { name: "输出", exact: true }).click();
    await preferences.getByRole("button", { name: /高画质/ }).click();
    await preferences.getByRole("tab", { name: "画面", exact: true }).click();
    await preferences.getByRole("button", { name: "打开图片自定义像素尺寸", exact: true }).click();
    await page.getByRole("textbox", { name: "自定义图片宽度", exact: true }).fill("4096");
    await page.getByRole("textbox", { name: "自定义图片高度", exact: true }).fill("4096");
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    await page.getByRole("textbox", { name: "描述你想生成或修改的图片" }).fill(`生成商品摄影测试图 ${caseId}`);
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await created;
    expect(response.ok()).toBe(true);
    const run = (await response.json()).data.run as Run;
    if (submitCapture) {
        // The actual first submission can occur inside the maintenance call that finishes the native run.
        let requestFailed = false;
        let requestFailure: unknown;
        submitCapture.pending = expect
            .poll(
                async () => {
                    if (submitCapture.stop) return true;
                    try {
                        await advanceWorker(request, submitCapture.workerId, timeoutMs + 45_000);
                    } catch (error) {
                        requestFailed = true;
                        requestFailure = error;
                        return true;
                    }
                    return submitCapture.accepted();
                },
                { timeout: info.timeout },
            )
            .toBe(true)
            .then(
                () => (submitCapture.outcome = { kind: requestFailed ? "error" : "response", ...(requestFailed ? { message: requestFailure instanceof Error ? requestFailure.message : String(requestFailure) } : {}), observedAt: Date.now() }),
                (error: Error) => (submitCapture.outcome = { kind: "error", message: error.message, observedAt: Date.now() }),
            );
        await untilObserved(
            async () => {
                if (submitCapture.outcome) throw new Error(`First native-driving request finished before owned Web exit: ${submitCapture.outcome.kind}`);
                return submitCapture.accepted();
            },
            Boolean,
            "first fsynced acceptance with its actual request still pending",
            info.timeout,
        );
        const acceptedJob = (await fixture.snapshot()).jobs[0];
        expect(acceptedJob).toBeDefined();
        const matching = (JSON.parse(await readFile(path.join(root, "image-enhancement-jobs.json"), "utf8")) as Array<{ id: string; remoteKey: string }>).find((job) => job.remoteKey === acceptedJob.key);
        expect(matching).toBeDefined();
        const acceptedOwned = await readOwnedJob(root, matching!.id);
        expect(acceptedOwned).toMatchObject({ status: "running", phase: "submit", workerId: submitCapture.workerId, leaseToken: expect.any(String), submittedAt: expect.any(Number) });
        expect(acceptedOwned).not.toHaveProperty("remoteJobId");
        const firstNative = await enhancement(request, acceptedOwned.id);
        const firstNativeTask = await nativeTask(request, acceptedOwned.id);
        expect(firstNativeTask.status).toBe("success");
        const firstNativeMedia = await mediaSnapshot(root, firstNative.imageTaskId);
        expect(firstNativeMedia.some((item) => item.sha256 === sha256(fixture.native))).toBe(true);
        const firstOriginal = await request.get(firstNative.native.url);
        expect(firstOriginal.ok()).toBe(true);
        const firstDecoded = await decoded(await firstOriginal.body());
        expect(firstDecoded).toMatchObject({ width: 1254, height: 1254, sha256: sha256(fixture.native), byteLength: fixture.native.length });
        const readOriginalRunFinalization = async () => {
            const publicState = await runState(request, run.id);
            const records = JSON.parse(await readFile(path.join(root, "generation-tasks.json"), "utf8")) as Array<{ id: string; type: string; userId: string; payload: Run }>;
            const record = records.find((task) => task.type === "agent" && task.id === run.id && task.userId === acceptedOwned.userId);
            expect(record, "The actual owned file-provider agent payload must exist").toBeDefined();
            expect(publicState).toMatchObject({ id: record!.payload.id, conversationId: record!.payload.conversationId });
            return { ...publicState, status: record!.payload.status, reviewed: record!.payload.reviewed, reviewStatus: record!.payload.reviewStatus };
        };
        const finalizationStoreSourceSha256 = sha256(await readFile(path.resolve("src/lib/server/generation-task-store.ts")));
        const beforeFinalization = fixture.counts();
        const stateBeforeFinalization = await readOriginalRunFinalization();
        const finalizeWorkerId = `${submitCapture.workerId}:native-finalize`;
        const finalizationBatches: unknown[] = [];
        let finalizationFailed = false;
        let finalizationFailure: unknown;
        await expect
            .poll(
                async () => {
                    try {
                        if (submitCapture.outcome) throw new Error(`First held submit ended during native finalization: ${submitCapture.outcome.kind}`);
                        let state = await readOriginalRunFinalization();
                        if (state.status !== "completed" || ["review_pending", "reviewing"].includes(state.reviewStatus || "")) {
                            const data = await advanceWorker(request, finalizeWorkerId, timeoutMs + 45_000);
                            expect(data.enhancement.claimed).toBe(0);
                            finalizationBatches.push({ workerId: finalizeWorkerId, observedAt: Date.now(), data });
                            state = await readOriginalRunFinalization();
                        }
                        expect(["failed", "cancelled", "paused"]).not.toContain(state.status);
                        return state.status === "completed" && !["review_pending", "reviewing"].includes(state.reviewStatus || "");
                    } catch (error) {
                        finalizationFailed = true;
                        finalizationFailure = error;
                        return true;
                    }
                },
                { timeout: info.timeout },
            )
            .toBe(true);
        if (finalizationFailed) throw finalizationFailure;
        const afterFinalization = fixture.counts();
        const finalizationDelta = countDelta(beforeFinalization, afterFinalization);
        expect(finalizationDelta).toMatchObject({ generation: 0, analysis: 0, planning: 0, otherPost: 0 });
        if (finalizationDelta.otherText) {
            expect(stateBeforeFinalization.reviewed).not.toBe(true);
            expect((await readOriginalRunFinalization()).reviewed).toBe(true);
            expect(afterFinalization.calls.slice(beforeFinalization.calls.length).every((call: { kind: string; tool: string }) => call.kind === "otherText" && call.tool === "review_creative_outputs")).toBe(true);
        }
        expect(await nativeTask(request, acceptedOwned.id)).toEqual(firstNativeTask);
        expect((await enhancement(request, acceptedOwned.id)).native).toEqual(firstNative.native);
        expect(await mediaSnapshot(root, firstNative.imageTaskId)).toEqual(firstNativeMedia);
        const afterOwner = await readOwnedJob(root, acceptedOwned.id);
        expect(afterOwner).toMatchObject({
            workerId: acceptedOwned.workerId,
            leaseToken: acceptedOwned.leaseToken,
            remoteKey: acceptedOwned.remoteKey,
            remotePlan: acceptedOwned.remotePlan,
            receiptId: acceptedOwned.receiptId,
            submittedAt: acceptedOwned.submittedAt,
        });
        expect(afterOwner).not.toHaveProperty("remoteJobId");
        const heldLedger = await fixture.snapshot();
        expect(heldLedger.jobs).toHaveLength(1);
        expect(heldLedger.jobs[0].jobId).toBe(acceptedJob.jobId);
        expect(heldLedger.calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toEqual([expect.objectContaining({ jobId: acceptedJob.jobId, responseStatus: null, closedAt: null })]);
        expect(sha256(await readFile(path.resolve("src/lib/server/generation-task-store.ts")))).toBe(finalizationStoreSourceSha256);
        await evidence(info, "restart-original-native-finalization-window", {
            runId: run.id,
            finalizationStoreSourceSha256,
            firstRemoteJob: acceptedJob,
            firstAcceptedNative: { public: firstNative, task: firstNativeTask, media: firstNativeMedia, decoded: firstDecoded, owner: acceptedOwned },
            ownerAfterFinalization: afterOwner,
            stateBeforeFinalization,
            stateAfterFinalization: await readOriginalRunFinalization(),
            beforeFinalization,
            afterFinalization,
            finalizationDelta,
            finalizationBatches,
            scope: "original native run and its first review finish under the first submit's still-live lease; subsequent restart/enhancement windows require all upstream categories to stay zero",
        });
    } else
        await expect
            .poll(
                async () => {
                    await advanceWorker(request);
                    return (await runState(request, run.id)).status;
                },
                { timeout: info.timeout },
            )
            .toBe("completed");
    let native: CreativeAsset | undefined;
    await expect
        .poll(
            async () => {
                native = (await assets(request, run.conversationId)).find((asset) => asset.sourceRunId === run.id && asset.metadata?.enhancementId && asset.metadata?.provenance !== "ai_enhanced");
                return Boolean(native);
            },
            { timeout: info.timeout },
        )
        .toBe(true);
    expect(native).toMatchObject({ width: 1254, height: 1254, metadata: { nativeSource: { width: 1254, height: 1254, sha256: sha256(fixture.native), byteLength: fixture.native.length, provenance: "provider_native" } } });
    const id = String(native!.metadata.enhancementId);
    const initial = skipped || submitCapture ? await enhancement(request, id) : await drive(request, id, (job) => job.status === "running" && job.phase === "poll", info);
    const owned = await readOwnedJob(root, id);
    if (skipped) {
        expect(initial).toMatchObject({ status: "skipped", phase: "completed", reason: "disabled", attempt: 1, canRetry: false, canCancel: false });
        expect(owned).toMatchObject({ status: "skipped", reason: "disabled", decision: { status: "skipped", reason: "disabled" } });
        expect(owned).not.toHaveProperty("remoteJobId");
        expect(owned).not.toHaveProperty("remotePlan");
    } else if (submitCapture) {
        expect(owned).toMatchObject({
            status: "running",
            phase: "submit",
            remotePlan: expect.any(Object),
            submittedAt: expect.any(Number),
            workerId: submitCapture.workerId,
            leaseToken: expect.any(String),
            attempt: 1,
            decision: { connection: { timeoutMs } },
        });
        expect(owned).not.toHaveProperty("remoteJobId");
    } else expect(owned).toMatchObject({ remoteJobId: expect.any(String), remoteStatus: "running", attempt: 1, decision: { connection: { timeoutMs } } });
    const baselineTask = await nativeTask(request, id);
    expect(baselineTask.status).toBe("success");
    const baselineMedia = await mediaSnapshot(root, initial.imageTaskId);
    expect(baselineMedia.some((item) => item.sha256 === sha256(fixture.native))).toBe(true);
    expect((await request.get(initial.native.url)).ok()).toBe(true);
    expect(initial.native.url).toMatch(/^\/api\/generation-log-assets\/permanent\//);
    const original = await request.get(initial.native.url);
    expect(await decoded(await original.body())).toMatchObject({ width: 1254, height: 1254, sha256: sha256(fixture.native) });
    const baselineLog = await generationLog(request, id);
    expect(baselineLog.status).toBe("success");
    const before = fixture.counts();
    expect(before.counts.generation).toBe(generationCount);
    expect(before.counts.planning).toBeGreaterThan(0);
    const generationDelta = countDelta(generationBefore, before);
    expect(generationDelta.generation).toBe(1);
    expect(generationDelta.planning).toBeGreaterThan(0);
    await page.goto(`/create?conversationId=${encodeURIComponent(run.conversationId)}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("creative-media-result")).toHaveCount(1);
    await page.getByTestId("creative-media-result").getByRole("button", { name: "原图", exact: true }).click();
    await evidence(info, `persisted-native-before-fault-${caseId}`, {
        kind: "qualified original byte reuse with controlled normal generation; synthetic enhancement protocol only",
        caseId,
        proof,
        run,
        native,
        initial,
        baselineTask,
        baselineMedia,
        baselineLog,
        generationBefore,
        generationDelta,
        upstream: before,
        remote: await fixture.snapshot(),
    });
    return { fixture, root, run, native: native!, id, initial, baselineOwned: owned, baselineTask, baselineMedia, baselineLog, generationBefore, generationDelta, before, browserWorkerRequests };
}

function configurationFacts(settings: ImageEnhancementSettings) {
    return { revision: settings.revision, enabled: settings.enabled, mode: settings.mode, modelId: settings.modelId, models: settings.models, ready: settings.ready, timeoutMs: settings.timeoutMs, check: settings.check };
}

function nativeLogFacts(log: GenerationLog) {
    return { id: log.id, status: log.status, assets: log.assets.map((asset) => Object.fromEntries(Object.entries(asset).filter(([key]) => key !== "enhancement"))) };
}

async function setEnhancementEnabled(request: APIRequestContext, enabled: boolean) {
    const settings = await adminSettings(request);
    const startedAt = Date.now();
    const response = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled } });
    expect(response.ok()).toBe(true);
    const changed = (await response.json()).data as ImageEnhancementSettings;
    expect(changed).toMatchObject({ enabled, ready: true });
    expect(changed.revision).not.toBe(settings.revision);
    return { startedAt, completedAt: Date.now(), configuration: configurationFacts(changed) };
}

async function assertNativePreserved(request: APIRequestContext, current: Case) {
    const state = await enhancement(request, current.id);
    expect(state.native).toEqual(current.initial.native);
    expect(state.target).toEqual(current.initial.target);
    expect((await readOwnedJob(current.root, current.id)).decision).toEqual(current.baselineOwned.decision);
    expect(await nativeTask(request, current.id)).toEqual(current.baselineTask);
    expect((await runState(request, current.run.id)).status).toBe("completed");
    expect((await assets(request, current.run.conversationId)).find((asset) => asset.id === current.native.id)).toEqual(current.native);
    expect(nativeLogFacts(await generationLog(request, current.id))).toEqual(nativeLogFacts(current.baselineLog));
    expect(await mediaSnapshot(current.root, current.initial.imageTaskId)).toEqual(current.baselineMedia);
    const response = await request.get(state.native.url);
    expect(response.ok()).toBe(true);
    expect(await decoded(await response.body())).toMatchObject({ width: 1254, height: 1254, byteLength: current.fixture.native.length, sha256: sha256(current.fixture.native) });
    expect(current.browserWorkerRequests).toEqual([]);
}

async function assertDeliveredFromDesktop(page: Page, request: APIRequestContext, current: Case) {
    await assertNativePreserved(request, current);
    const state = await enhancement(request, current.id);
    expect(state).toMatchObject({ status: "succeeded", phase: "completed", enhanced: { width: 4096, height: 4096, assetId: expect.any(String) } });
    const response = await request.get(state.enhanced!.url);
    expect(response.ok()).toBe(true);
    const saved = await decoded(await response.body());
    expect(saved).toMatchObject({ width: 4096, height: 4096, byteLength: state.enhanced!.byteLength, sha256: state.enhanced!.sha256 });
    await page.goto(`/create?conversationId=${encodeURIComponent(current.run.conversationId)}`, { waitUntil: "domcontentloaded" });
    const round = page.getByTestId("creative-media-result");
    await expect(round).toHaveCount(1);
    await expect(round.getByRole("status")).toContainText("AI增强已完成");
    await round.getByRole("button", { name: "原图", exact: true }).click();
    expect(await decoded(await downloadOriginal(page, round.getByLabel("本轮创作操作", { exact: true })))).toMatchObject({ width: 1254, height: 1254, byteLength: current.fixture.native.length, sha256: sha256(current.fixture.native) });
    await round.getByRole("button", { name: "AI增强", exact: true }).click();
    expect(await decoded(await downloadOriginal(page, round.getByLabel("本轮创作操作", { exact: true })))).toEqual(saved);
}

async function assertOriginal(page: Page, request: APIRequestContext, current: Case, failed: PublicImageEnhancement, reason: RegExp) {
    expect(await nativeTask(request, current.id)).toEqual(current.baselineTask);
    expect((await runState(request, current.run.id)).status).toBe("completed");
    const listed = await assets(request, current.run.conversationId);
    expect(listed.find((asset) => asset.id === current.native.id)).toEqual(current.native);
    expect(listed.filter((asset) => asset.metadata?.enhancementId === current.id && asset.metadata?.provenance === "ai_enhanced")).toEqual([]);
    const log = await generationLog(request, current.id);
    expect(log).toMatchObject({ status: "success" });
    expect(log.assets.find((asset) => asset.enhancementId === current.id)?.enhancement).toMatchObject({ status: "failed", reason: failed.reason, native: { width: 1254, height: 1254, sha256: sha256(current.fixture.native) } });
    await page.reload({ waitUntil: "domcontentloaded" });
    const round = page.getByTestId("creative-media-result");
    await expect(round.getByRole("status")).toContainText("AI增强失败");
    await expect(round.getByRole("status")).toContainText("原图仍可用");
    await expect(round.getByRole("button", { name: "原图", exact: true })).toBeEnabled();
    await expect(round.getByRole("button", { name: "AI增强", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "直接重试", exact: true })).toHaveCount(0);
    await round.getByRole("button", { name: "原图", exact: true }).click();
    await expect(round.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", current.native.id);
    const downloaded = await decoded(await downloadOriginal(page, round.getByLabel("本轮创作操作", { exact: true })));
    expect(downloaded).toMatchObject({ width: 1254, height: 1254, byteLength: current.fixture.native.length, sha256: sha256(current.fixture.native) });
    const route = await request.get(failed.native.url);
    expect(route.ok()).toBe(true);
    expect(await decoded(await route.body())).toEqual(downloaded);
    expect(await mediaSnapshot(current.root, failed.imageTaskId)).toEqual(current.baselineMedia);
    const after = current.fixture.counts();
    expect(after).toEqual(current.before);
    const deltas = Object.fromEntries(Object.entries(after.counts).map(([kind, count]) => [kind, Number(count) - Number(current.before.counts[kind as keyof typeof current.before.counts])]));
    expect(deltas).toEqual({ generation: 0, analysis: 0, planning: 0, otherText: 0, otherPost: 0 });
    expect(current.browserWorkerRequests).toEqual([]);
    // Keep the required concrete desktop reason visible as a RED until the actual UI implements it.
    await expect.soft(round.getByRole("status"), `The desktop must identify independent enhancement reason ${failed.reason}`).toContainText(reason);
    return { publicEnhancement: await enhancement(request, current.id), nativeTask: await nativeTask(request, current.id), log, assets: listed, downloaded, before: current.before, after, deltas };
}

async function qualify(request: APIRequestContext, fixture: Fixture) {
    let settings = await adminSettings(request);
    let response = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled: false, endpoint: fixture.endpoint, token: fixture.token, timeoutMs } });
    expect(response.ok()).toBe(true);
    settings = (await response.json()).data;
    response = await request.post("/api/admin/image-enhancement", { data: { revision: settings.revision, action: "connection" } });
    expect(response.ok()).toBe(true);
    settings = (await response.json()).data;
    response = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, modelId: fixture.model.id } });
    expect(response.ok()).toBe(true);
    settings = (await response.json()).data;
    response = await request.post("/api/admin/image-enhancement", { data: { revision: settings.revision, action: "sample" } });
    expect(response.ok()).toBe(true);
    settings = (await response.json()).data;
    expect(settings).toMatchObject({ ready: true, timeoutMs, check: { state: "ready", serviceId: fixture.serviceId } });
    expect(settings.models.find((model) => model.id === fixture.model.id)).toEqual(fixture.model);
    response = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled: true } });
    expect(response.ok()).toBe(true);
    expect((await response.json()).data).toMatchObject({ enabled: true, ready: true });
}

async function drive(request: APIRequestContext, id: string, accepts: (job: PublicImageEnhancement) => boolean, info: TestInfo) {
    let job = await enhancement(request, id);
    await expect
        .poll(
            async () => {
                if (!accepts(job)) {
                    await advanceWorker(request);
                    job = await enhancement(request, id);
                }
                return accepts(job);
            },
            { timeout: info.timeout },
        )
        .toBe(true);
    return job;
}
async function enhancement(request: APIRequestContext, id: string): Promise<PublicImageEnhancement> {
    const reply = await request.get(`/api/image-enhancements/${encodeURIComponent(id)}`);
    expect(reply.ok()).toBe(true);
    return (await reply.json()).data;
}
async function nativeTask(request: APIRequestContext, id: string): Promise<NativeTask> {
    const job = await enhancement(request, id);
    const reply = await request.get(`/api/image-tasks/${encodeURIComponent(job.imageTaskId)}`);
    expect(reply.ok()).toBe(true);
    return (await reply.json()).task;
}
async function runState(request: APIRequestContext, id: string): Promise<Run> {
    const reply = await request.get(`/api/agent/runs/${encodeURIComponent(id)}`);
    expect(reply.ok()).toBe(true);
    return (await reply.json()).data.run;
}
async function assets(request: APIRequestContext, conversationId: string): Promise<CreativeAsset[]> {
    const reply = await request.get(`/api/creative/conversations/${encodeURIComponent(conversationId)}/assets`);
    expect(reply.ok()).toBe(true);
    return (await reply.json()).data.assets;
}
async function generationLog(request: APIRequestContext, id: string): Promise<GenerationLog> {
    const reply = await request.get("/api/admin/generation-logs?pageSize=100");
    expect(reply.ok()).toBe(true);
    const log = ((await reply.json()).logs as GenerationLog[]).find((entry) => entry.assets.some((asset) => asset.enhancementId === id));
    expect(log, "The actual native generation log must retain its linked enhancement").toBeDefined();
    return log!;
}
async function adminSettings(request: APIRequestContext): Promise<ImageEnhancementSettings> {
    const reply = await request.get("/api/admin/image-enhancement");
    expect(reply.ok()).toBe(true);
    return (await reply.json()).data;
}
async function advanceWorker(request: APIRequestContext, workerId = "m5-business-fault-acceptance", requestTimeout?: number) {
    const reply = await request.post("/api/maintenance/generation-tasks/run", {
        headers: { authorization: "Bearer vozeb-pro-e2e-worker-token-separate-32chars", "x-vozeb-pro-worker-id": workerId },
        ...(requestTimeout === undefined ? {} : { timeout: requestTimeout }),
    });
    expect(reply.ok()).toBe(true);
    return (await reply.json()).data;
}
async function retryFromDesktop(page: Page, id: string, attempt = 1) {
    const changed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/image-enhancements/${encodeURIComponent(id)}`);
    await page.getByTestId("creative-media-result").getByRole("button", { name: "重试增强", exact: true }).click();
    const response = await changed;
    expect(response.ok()).toBe(true);
    expect((await response.json()).data).toMatchObject({ id, status: "queued", attempt });
}
function countDelta(before: Counts, after: Counts): Counts["counts"] {
    return Object.fromEntries(Object.entries(after.counts).map(([kind, count]) => [kind, Number(count) - Number(before.counts[kind as keyof Counts["counts"]])])) as Counts["counts"];
}
async function decoded(bytes: Buffer) {
    const image = sharp(bytes, { failOn: "warning" });
    const [metadata, pixels, statistics] = await Promise.all([image.metadata(), image.clone().raw().toBuffer({ resolveWithObject: true }), image.clone().stats()]);
    return { width: pixels.info.width, height: pixels.info.height, format: metadata.format, opaque: statistics.isOpaque, byteLength: bytes.length, sha256: sha256(bytes) };
}
async function downloadOriginal(page: Page, actions: Locator) {
    const pending = page.waitForEvent("download");
    await actions.getByRole("button", { name: "下载", exact: true }).click();
    const item = page.getByRole("menuitem", { name: "下载当前结果", exact: true });
    if (await item.isVisible()) await item.click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const url = new URL(download.url());
    expect(url.pathname).toMatch(/^\/api\/generation-log-assets\/permanent\//);
    expect(url.searchParams.get("download")).toBe("original");
    expect(url.searchParams.has("width")).toBe(false);
    expect(url.searchParams.has("format")).toBe(false);
    return readFile((await download.path())!);
}
async function evidence(info: TestInfo, name: string, value: unknown) {
    const file = info.outputPath(`${name}.json`);
    await writeFile(file, JSON.stringify(process.env.VOZEB_PRO_M5_RESTART_REENTRY === "1" ? sanitizeRestartEvidence(value) : value, null, 2));
    await info.attach(name, { path: file, contentType: "application/json" });
}
async function finishCase(request: APIRequestContext, current: Case, info: TestInfo) {
    try {
        await evidence(info, "final-synthetic-worker-ledger", await current.fixture.snapshot());
        const settings = await adminSettings(request);
        const disabled = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled: false } });
        expect(disabled.ok()).toBe(true);
    } finally {
        await current.fixture.close();
    }
}
