import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createProtocolFixtureServer } from "../scripts/protocol-fixture-server.mjs";
import { linuxIdentity, untilObserved } from "./image-enhancement-restart.lifecycle.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fixtureModel = { id: "m5-business-fixture", binaryVersion: "synthetic-v1", binarySha256: "b".repeat(64), modelVersion: "synthetic-v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 };
const within = (root, file) => {
    const relative = path.relative(root, file);
    return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};
const controlDirectory = (root) => path.join(root, ".m5-business-faults");

export function ownedDataDirectory() {
    const root = path.resolve(process.env.VOZEB_PRO_M5_BUSINESS_DATA_DIR || "");
    assert.ok(path.isAbsolute(process.env.VOZEB_PRO_M5_BUSINESS_DATA_DIR || ""), "Supply the absolute, freshly owned fixture data directory");
    assert.ok(path.basename(root).startsWith("vozeb-m5-business-"), "The owned test directory must use the vozeb-m5-business- prefix");
    assert.match(process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID || "", /^[a-f0-9-]{36}$/i, "Supply a unique fixture run UUID");
    return root;
}

// Preload only in the owned application process; the Playwright process imports the exports normally.
if (process.env.VOZEB_PRO_M5_BUSINESS_PRELOAD === "1") installOneWriteFault();

function installOneWriteFault() {
    const root = ownedDataDirectory();
    assert.equal(path.resolve(process.env.VOZEB_PRO_DATA_DIR || ""), root);
    assert.equal(process.env.VOZEB_PRO_DATABASE_PROVIDER, "file");
    const directory = controlDirectory(root);
    const mediaRoot = path.join(root, "generation-assets");
    fs.mkdirSync(directory, { recursive: true });
    const restartBootId = process.env.VOZEB_PRO_M5_RESTART_BOOT_ID;
    const processFields = restartBootId ? fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").at(-1).trim().split(/\s+/) : null;
    fs.writeFileSync(
        path.join(directory, `preload-${process.pid}.json`),
        JSON.stringify({
            pid: process.pid,
            runId: process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID,
            dataDir: root,
            mediaRoot,
            loadedAt: Date.now(),
            ...(restartBootId ? { restartBootId, parentPid: process.ppid, processGroup: Number(processFields[2]), processStartTicks: processFields[19] } : {}),
        }),
        { flag: "wx" },
    );
    const original = fs.promises.writeFile;
    const restore = () => {
        fs.promises.writeFile = original;
        syncBuiltinESMExports();
    };
    fs.promises.writeFile = async function (target, bytes, ...options) {
        const file = typeof target === "string" ? path.resolve(target) : "";
        if (!within(mediaRoot, file) || !Buffer.isBuffer(bytes) || !file.endsWith(".png")) return original.call(this, target, bytes, ...options);
        const marker = path.join(directory, "arm.json");
        let armed;
        try {
            armed = JSON.parse(fs.readFileSync(marker, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            if (fs.existsSync(path.join(directory, "consumed.json"))) restore();
            return original.call(this, target, bytes, ...options);
        }
        assert.equal(armed.runId, process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID);
        if (bytes.length !== armed.byteLength || sha256(bytes) !== armed.sha256) return original.call(this, target, bytes, ...options);
        let exclusive;
        try {
            exclusive = fs.openSync(path.join(directory, "consumed.json"), "wx");
        } catch (error) {
            if (error.code === "EEXIST") {
                restore();
                return original.call(this, target, bytes, ...options);
            }
            throw error;
        }
        // The native and full AI have different hashes. Restore before throwing the one owned EIO.
        restore();
        const evidence = { ...armed, pid: process.pid, path: file, storageKey: path.relative(mediaRoot, file).split(path.sep).join("/"), failedAt: Date.now(), code: "EIO", restored: true };
        try {
            fs.writeFileSync(exclusive, JSON.stringify(evidence));
            fs.fsyncSync(exclusive);
        } finally {
            fs.closeSync(exclusive);
        }
        fs.unlinkSync(marker);
        throw Object.assign(new Error("owned M5 delivery write failed"), { code: "EIO" });
    };
    syncBuiltinESMExports();
}

export async function armDeliveryWrite(root, output, caseId) {
    const records = await readPreloadRecords(root);
    await writeFile(path.join(controlDirectory(root), "arm.json"), JSON.stringify({ runId: process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID, caseId, sha256: sha256(output), byteLength: output.length }), { flag: "wx" });
    return records;
}

export async function readPreloadRecords(root) {
    const names = (await readdir(controlDirectory(root))).filter((name) => /^preload-\d+\.json$/.test(name)).sort();
    assert.ok(names.length, "The owned application must load the test preload");
    return Promise.all(
        names.map(async (name) => {
            const record = JSON.parse(await readFile(path.join(controlDirectory(root), name), "utf8"));
            assert.equal(record.runId, process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID);
            assert.equal(record.dataDir, root);
            assert.notEqual(record.pid, process.pid, "Only application processes may load the preload");
            return record;
        }),
    );
}

export async function readWriteFault(root) {
    return JSON.parse(await readFile(path.join(controlDirectory(root), "consumed.json"), "utf8"));
}

export async function readOwnedJob(root, id) {
    const jobs = JSON.parse(await readFile(path.join(root, "image-enhancement-jobs.json"), "utf8"));
    const job = jobs.find((candidate) => candidate.id === id);
    assert.ok(job, `Missing owned enhancement ${id}`);
    return job;
}

export async function mediaSnapshot(root, taskId) {
    const registry = JSON.parse(await readFile(path.join(root, "local-media-assets.json"), "utf8"));
    const registrations = registry.assets.filter((asset) => asset.taskId === taskId).sort((a, b) => a.storageKey.localeCompare(b.storageKey));
    return Promise.all(
        registrations.map(async (registration) => {
            assert.equal(registration.scope, "generation");
            assert.equal(registration.storageClass, "permanent");
            assert.notEqual(registration.storageProvider, "object");
            const file = path.resolve(root, "generation-assets", registration.storageKey);
            assert.ok(within(path.join(root, "generation-assets"), file));
            const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
            assert.equal(bytes.length, registration.bytes);
            return { registration, sha256: sha256(bytes), size: metadata.size, mtimeMs: metadata.mtimeMs, birthtimeMs: metadata.birthtimeMs };
        }),
    );
}

export function upstreamCounts(requests) {
    const counts = { generation: 0, analysis: 0, planning: 0, otherText: 0, otherPost: 0 };
    const calls = [];
    for (const entry of requests.filter((request) => request.method === "POST")) {
        const pathname = entry.path.replace(/^\/v1(?=\/)/, "");
        let payload = {};
        try {
            payload = JSON.parse(entry.body.toString("utf8"));
        } catch {
            /* The fixture also records multipart requests. */
        }
        const tool =
            payload.tool_choice?.name ||
            payload.tool_choice?.function?.name ||
            payload.tools?.[0]?.name ||
            payload.tools?.[0]?.function?.name ||
            ["create_agent_plan", "plan_workbench_action", "analyze_ecommerce_references", "plan_ecommerce_edit", "make_plan"].find((name) => JSON.stringify(payload).includes(name)) ||
            "";
        const model = payload.model || "";
        const kind = ["/custom/images", "/images/generations", "/images/edits"].includes(pathname)
            ? "generation"
            : tool === "analyze_ecommerce_references" || /vision/.test(model)
              ? "analysis"
              : ["create_agent_plan", "plan_workbench_action", "plan_ecommerce_edit", "make_plan"].includes(tool) || /planner/.test(model) || pathname.startsWith("/planner/")
                ? "planning"
                : ["/chat/completions", "/responses", "/messages"].includes(pathname)
                  ? "otherText"
                  : "otherPost";
        counts[kind] += 1;
        calls.push({ path: entry.path, model, tool, kind });
    }
    return { counts, calls };
}

export async function createBusinessFaultFixture({ root, caseId, imagePath, model = fixtureModel, owner = caseId, controlledExecutor = false, sceneOutputs = false, native4xDelivery = false, protectedBaselineInput = false }) {
    const directory = path.join(controlDirectory(root), caseId);
    await mkdir(directory, { recursive: false });
    assert.equal(typeof imagePath, "string", "Supply the staged native PNG path");
    assert.ok(within(root, path.resolve(imagePath)), "Use an owned copy of the qualified original, outside the real GPU data directory");
    const native = await readFile(imagePath);
    const nativeImage = sharp(native, { failOn: "warning" });
    assert.deepEqual((await nativeImage.metadata()).width, 1254);
    assert.deepEqual((await nativeImage.metadata()).height, 1254);
    assert.equal((await nativeImage.metadata()).format, "png");
    assert.equal((await nativeImage.stats()).isOpaque, true);
    assert.equal(sha256(native), process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SHA256, "The staged qualified native must retain its recorded SHA");
    // These are deterministic opaque protocol bytes, not GPU inference or AI quality evidence.
    const ai = await sharp({ create: { width: 5016, height: 5016, channels: 3, background: "#51869d" } })
        .png({ palette: true, colours: 2 })
        .toBuffer();
    const wrongShaPng = await sharp({ create: { width: 5016, height: 5016, channels: 3, background: "#9d6851" } })
        .png({ palette: true, colours: 2 })
        .toBuffer();
    assert.equal(wrongShaPng.length, ai.length, "The SHA-only body must have exactly the declared length");
    assert.notEqual(sha256(wrongShaPng), sha256(ai));
    assert.equal((await sharp(wrongShaPng, { failOn: "warning" }).stats()).isOpaque, true);
    const delivery = await sharp(ai, { failOn: "warning" }).resize(4096, 4096, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const calibration = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#eee6de" } })
        .png()
        .toBuffer();
    const artifact = (bytes, width, height) => ({ width, height, format: "png", byteLength: bytes.length, sha256: sha256(bytes) });
    const expected = artifact(ai, 5016, 5016);
    const workerTarget = native4xDelivery ? { width: 5016, height: 5016, format: "png" } : { width: 4096, height: 4096, format: "png" };
    const budgets = {
        input: { maxBytes: protectedBaselineInput ? Math.max(native.length, delivery.length, ai.length) : native.length, maxPixels: 1254 ** 2 },
        ai: { maxBytes: ai.length, maxPixels: 5016 ** 2 },
        delivery: { maxBytes: Math.max(delivery.length, native4xDelivery ? ai.length : 0), maxPixels: workerTarget.width * workerTarget.height },
    };
    const token = "m5-local-business-fixture-token";
    const serviceId = randomUUID();
    const calibrationId = randomUUID();
    const calibrationOutput = artifact(calibration, 32, 32);
    const ledger = {
        kind: "synthetic-protocol-business-fault",
        runId: process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID,
        caseId,
        owner,
        serviceId,
        model,
        fault: "hold",
        jobs: [],
        calls: [],
        injections: [],
        receiptRequests: [],
        acceptedReceipts: [],
        cancelRequests: [],
    };
    if (controlledExecutor) Object.assign(ledger, { protocolProcess: await linuxIdentity(process.pid), executorKind: "independent controlled synthetic PNG process; not Native/GPU", executorRuns: [], executorObservations: [], maxConcurrentExecutors: 0 });
    const ledgerPath = path.join(directory, "worker-ledger.json");
    let queue = Promise.resolve();
    const persist = () => {
        const content = JSON.stringify(ledger, null, 2);
        queue = queue.then(async () => {
            const temporary = `${ledgerPath}.next`;
            const handle = await open(temporary, "w");
            try {
                await handle.writeFile(content);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporary, ledgerPath);
        });
        return queue;
    };
    let beforeReceipt;
    let beforeSubmitReply;
    const executors = new Map();
    const launchExecutor = (job) => {
        if (executors.has(job.jobId)) return executors.get(job.jobId).ready;
        const child = spawn(process.execPath, [fileURLToPath(new URL("./image-enhancement-restart.executor.mjs", import.meta.url))], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env } });
        const state = { child, executionId: randomUUID(), messages: [], terminal: null, ready: null };
        executors.set(job.jobId, state);
        state.exit = new Promise((resolve) => {
            child.once("error", (error) => {
                state.error = error.message;
                state.terminal = { error: error.message, observedAt: Date.now() };
                resolve(state.terminal);
            });
            child.once("exit", (code, signal) => {
                state.terminal = { code, signal, observedAt: Date.now() };
                const run = ledger.executorRuns.find((entry) => entry.executionId === state.executionId);
                if (run) run.exit = state.terminal;
                void persist();
                resolve(state.terminal);
            });
        });
        child.on("message", (message) => {
            state.messages.push(message);
            if (message.kind === "error") state.error = message.error;
        });
        state.ready = (async () => {
            const identity = await untilObserved(() => linuxIdentity(child.pid), Boolean, "controlled executor PID");
            const run = { executionId: state.executionId, jobId: job.jobId, key: job.key, pid: child.pid, identity, spawnedAt: Date.now() };
            ledger.executorRuns.push(run);
            const active = await Promise.all([...executors.values()].filter((entry) => !entry.terminal).map((entry) => linuxIdentity(entry.child.pid)));
            const activePids = active.filter((entry) => entry && entry.state !== "Z" && entry.state !== "X").map((entry) => entry.pid);
            ledger.maxConcurrentExecutors = Math.max(ledger.maxConcurrentExecutors, activePids.length);
            ledger.executorObservations.push({ stage: "spawn", at: Date.now(), activePids });
            await persist();
            child.send({ kind: "bind", root, directory, nativePath: imagePath, nativeSha256: sha256(native), expected, executionId: state.executionId, runId: ledger.runId, jobId: job.jobId, key: job.key });
            const started = await untilObserved(
                async () => {
                    if (state.error || state.terminal) throw new Error(state.error || "Controlled executor exited before binding");
                    return state.messages.find((message) => message.kind === "started");
                },
                Boolean,
                "fsynced controlled executor start",
            );
            assert.equal(started.pid, identity.pid);
            assert.equal(started.parentPid, process.pid);
            assert.equal(started.startTicks, identity.startTicks);
            assert.equal(started.executionId, state.executionId);
            assert.equal(started.jobId, job.jobId);
            assert.equal(started.key, job.key);
            assert.deepEqual(JSON.parse(await readFile(path.join(directory, "executor-start.json"), "utf8")), started);
            Object.assign(run, { started });
            job.executor = { pid: started.pid, startTicks: started.startTicks, executionId: state.executionId };
            job.executionCount = ledger.executorRuns.filter((entry) => entry.jobId === job.jobId).length;
            await persist();
            return started;
        })();
        return state.ready;
    };
    const observeExecutor = async (jobId, stage) => {
        const state = executors.get(jobId);
        assert.ok(state, "Only inspect the executor belonging to this durable remote job");
        const started = await state.ready;
        assert.equal(state.terminal, null);
        const challenge = randomUUID();
        state.child.send({ kind: "probe", challenge });
        const reply = await untilObserved(
            async () => {
                if (state.error || state.terminal) throw new Error(state.error || "Controlled executor exited before observation");
                return state.messages.find((message) => message.kind === "probe" && message.challenge === challenge);
            },
            Boolean,
            "live controlled executor IPC reply",
        );
        const identity = await linuxIdentity(state.child.pid);
        assert.equal(identity?.startTicks, started.startTicks);
        assert.equal(reply.startTicks, started.startTicks);
        assert.equal(reply.pid, state.child.pid);
        assert.equal(reply.executionId, started.executionId);
        assert.equal(reply.jobId, jobId);
        assert.equal(reply.key, started.key);
        const active = await Promise.all([...executors.values()].filter((entry) => !entry.terminal).map((entry) => linuxIdentity(entry.child.pid)));
        const activePids = active.filter((entry) => entry && entry.state !== "Z" && entry.state !== "X").map((entry) => entry.pid);
        ledger.maxConcurrentExecutors = Math.max(ledger.maxConcurrentExecutors, activePids.length);
        const observation = { stage, at: Date.now(), identity, reply, activePids };
        ledger.executorObservations.push(observation);
        await persist();
        return observation;
    };
    const completeExecutor = async (jobId) => {
        const state = executors.get(jobId);
        assert.ok(state);
        await observeExecutor(jobId, "before-controlled-completion");
        state.child.send({ kind: "complete", executionId: state.executionId });
        const terminal = await untilObserved(async () => state.terminal, Boolean, "original controlled executor terminal event");
        assert.deepEqual({ code: terminal.code, signal: terminal.signal }, { code: 0, signal: null });
        const completed = JSON.parse(await readFile(path.join(directory, "executor-completed.json"), "utf8"));
        assert.equal(completed.executionId, state.executionId);
        assert.equal(completed.pid, state.child.pid);
        assert.equal(completed.jobId, jobId);
        assert.equal(completed.key, (await state.ready).key);
        assert.equal(completed.startTicks, (await state.ready).startTicks);
        const bytes = await readFile(path.join(directory, "executor-output.png"));
        assert.equal(sha256(bytes), expected.sha256);
        assert.equal(bytes.length, expected.byteLength);
        assert.deepEqual(completed.result, expected);
        assert.equal(await linuxIdentity(state.child.pid), null, "Observe original executor exit before offering a successful result");
        const job = ledger.jobs.find((entry) => entry.jobId === jobId);
        assert.ok(job);
        Object.assign(job, { status: "succeeded", result: expected, completedAt: completed.completedAt });
        ledger.executorObservations.push({ stage: "clean-exit-before-success", at: Date.now(), terminal, completed, activePids: [] });
        await persist();
        return { completed, terminal, outputSha256: sha256(bytes) };
    };
    const worker = createServer(async (request, response) => {
        const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
        const call = {
            owner,
            method: request.method,
            path: pathname,
            role: request.headers["x-m5-fixture-observer"] === "1" ? "observer" : "application",
            receivedAt: Date.now(),
            responseStatus: null,
            declaredBytes: null,
            bodyBytes: null,
            closedAt: null,
        };
        ledger.calls.push(call);
        response.on("close", () => {
            call.closedAt = Date.now();
            void persist();
        });
        const json = (status, data) => {
            call.responseStatus = status;
            response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ code: status < 400 ? "ok" : "fixture_error", data, msg: "fixture" }));
        };
        const png = (bytes, declared = bytes.length) => {
            call.responseStatus = 200;
            call.declaredBytes = declared;
            call.bodyBytes = bytes.length;
            response.writeHead(200, { "content-type": "image/png", "content-length": String(declared), connection: "close" }).end(bytes);
        };
        try {
            if (request.headers.authorization !== `Bearer ${token}`) return json(401, null);
            if (pathname === "/v1/capabilities") return json(200, { serviceId, protocolVersion: "image-enhancement.v1", normalizationProfile: "srgb-upright-v1", features: { expectedStrategyFingerprint: true }, models: [model], budgets, ready: true });
            if (pathname === "/v1/self-test")
                return json(200, { bootId: `synthetic-${serviceId}`, assetId: "zeb-enhancement-calibration-v1", phase: "output_verified", qualification: "qualified", jobId: calibrationId, reason: null, output: calibrationOutput });
            if (pathname === `/v1/enhancement-jobs/${calibrationId}/result`) return png(calibration);
            if (pathname === `/v1/enhancement-jobs/${calibrationId}`)
                return json(200, {
                    job: {
                        serviceId,
                        jobId: calibrationId,
                        status: "succeeded",
                        source: { width: 8, height: 8 },
                        engineInput: { width: 8, height: 8 },
                        result: calibrationOutput,
                        plan: { engine: { ...model, modelId: model.id, tile: model.defaultTile } },
                    },
                });
            if (pathname === "/v1/enhancement-jobs" && request.method === "POST") {
                const chunks = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const body = Buffer.concat(chunks);
                const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData();
                const submitted = JSON.parse(String(form.get("plan")));
                const input = Buffer.from(await form.get("image").arrayBuffer());
                const inputSha256 = sha256(input);
                let inputSize = { width: 1254, height: 1254 };
                if (protectedBaselineInput) {
                    const image = sharp(input, { failOn: "warning", limitInputPixels: budgets.input.maxPixels });
                    const [metadata, pixels, statistics] = await Promise.all([image.metadata(), image.clone().raw().toBuffer({ resolveWithObject: true }), image.clone().stats()]);
                    assert.equal(metadata.format, "png");
                    assert.equal(statistics.isOpaque, true);
                    inputSize = { width: pixels.info.width, height: pixels.info.height };
                    assert.deepEqual(inputSize, { width: 1254, height: 1254 });
                    assert.ok(input.length <= budgets.input.maxBytes);
                } else assert.equal(inputSha256, sha256(native));
                assert.equal(submitted.sourceSha256, inputSha256);
                assert.deepEqual(submitted.target, workerTarget);
                assert.equal(submitted.modelId, model.id);
                const engine = {
                    modelId: model.id,
                    binaryVersion: model.binaryVersion,
                    binarySha256: model.binarySha256,
                    modelVersion: model.modelVersion,
                    modelSha256: model.modelSha256,
                    nativeScale: model.nativeScale,
                    tile: model.defaultTile,
                    tta: model.tta,
                    gpuId: model.gpuId,
                };
                const strategy = { protocolVersion: "image-enhancement.v1", scope: "full_image", target: submitted.target, normalizationProfile: "srgb-upright-v1", engine, budgets };
                assert.equal(submitted.expectedStrategyFingerprint, sha256(Buffer.from(JSON.stringify(strategy))));
                const key = String(request.headers["idempotency-key"] || "");
                assert.ok(key);
                let job = ledger.jobs.find((candidate) => candidate.key === key);
                const replayed = Boolean(job);
                if (!job) {
                    job = {
                        key,
                        serviceId,
                        jobId: randomUUID(),
                        status: "running",
                        reason: null,
                        source: { ...inputSize, sha256: inputSha256 },
                        engineInput: { ...inputSize },
                        plan: { ...strategy, sourceSha256: inputSha256, strategyFingerprint: submitted.expectedStrategyFingerprint, planFingerprint: sha256(Buffer.from(JSON.stringify({ sourceSha256: inputSha256, ...strategy }))) },
                        result: null,
                        createdAt: Date.now(),
                        completedAt: null,
                        executionCount: controlledExecutor ? 0 : 1,
                        retained: true,
                    };
                    if (protectedBaselineInput) {
                        const file = path.join(directory, `${job.jobId}-input.png`);
                        await writeFile(file, input, { flag: "wx" });
                        job.input = { file, ...inputSize, format: "png", byteLength: input.length, sha256: inputSha256 };
                        job.engineInput.sha256 = inputSha256;
                    }
                    ledger.jobs.push(job);
                }
                assert.equal(job.source.sha256, inputSha256, "An idempotent replay must retain its original input");
                if (protectedBaselineInput) assert.equal((await readFile(job.input.file)).equals(input), true);
                Object.assign(call, { jobId: job.jobId, key, modelId: model.id, strategyFingerprint: submitted.expectedStrategyFingerprint });
                if (protectedBaselineInput) Object.assign(call, { input: job.input });
                await persist();
                if (controlledExecutor) await launchExecutor(job);
                if (beforeSubmitReply) {
                    Object.assign(call, { replayed, responseHeldAt: Date.now(), durableAcceptanceObservedAt: Date.now() });
                    await persist();
                    await beforeSubmitReply(structuredClone({ job, call, replayed, ledgerPath, durableAt: Date.now() }));
                    if (response.destroyed || request.socket.destroyed) {
                        Object.assign(call, { responseLost: true, lostAfterAcceptance: true, responseStatus: null, lostObservedAt: Date.now() });
                        await persist();
                        return;
                    }
                    call.responseLost = false;
                }
                return json(200, { job, replayed });
            }
            const match = pathname.match(/^\/v1\/enhancement-jobs\/([a-f0-9-]+)(?:\/(result|receipt))?$/i);
            if (match) call.jobId = match[1];
            const job = match && ledger.jobs.find((candidate) => candidate.jobId === match[1]);
            if (!job) return json(404, null);
            const fault = job.fault || ledger.fault;
            if (!match[2] && request.method === "DELETE") {
                ledger.cancelRequests.push({ owner, jobId: job.jobId, previousStatus: job.status, at: Date.now() });
                if (["queued", "running"].includes(job.status)) {
                    job.status = "cancelled";
                    job.reason = "cancelled";
                    job.completedAt = Date.now();
                }
                await persist();
                return json(200, { job });
            }
            if (!match[2] && request.method === "GET") {
                if (fault === "authentication") {
                    ledger.injections.push({ stage: "query", fault, jobId: job.jobId, at: Date.now() });
                    await persist();
                    return json(401, null);
                }
                if (fault === "timeout") {
                    ledger.injections.push({ stage: "query", fault, jobId: job.jobId, at: Date.now() });
                    await persist();
                    return;
                }
                if (fault === "engine-failed") {
                    job.status = "failed";
                    job.reason = "engine_failed";
                    job.completedAt = Date.now();
                } else if (!controlledExecutor && fault !== "hold" && job.status !== "cancelled") {
                    job.status = "succeeded";
                    job.result = expected;
                    job.completedAt ||= Date.now();
                }
                if (fault === "engine-failed") ledger.injections.push({ stage: "query", fault, jobId: job.jobId, at: Date.now() });
                await persist();
                return json(200, { job });
            }
            if (match[2] === "result" && request.method === "GET") {
                assert.equal(job.status, "succeeded");
                assert.equal(job.retained, true);
                const body = call.role === "observer" ? ai : fault === "corrupt" ? Buffer.from("corrupt AI PNG") : fault === "incomplete-transfer" ? ai.subarray(0, ai.length - 24) : fault === "sha-only" ? wrongShaPng : ai;
                if (call.role === "application" && ["corrupt", "incomplete-transfer", "sha-only"].includes(fault))
                    ledger.injections.push({ stage: "result", fault, jobId: job.jobId, expected, actual: { byteLength: body.length, sha256: sha256(body) }, at: Date.now() });
                await persist();
                return png(body, fault === "incomplete-transfer" && call.role === "application" ? ai.length : body.length);
            }
            if (match[2] === "receipt" && request.method === "POST") {
                const chunks = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                assert.equal(receipt.serviceId, serviceId);
                assert.deepEqual(receipt.result, expected);
                const accepted = ledger.acceptedReceipts.find((candidate) => candidate.jobId === job.jobId);
                if (accepted) assert.deepEqual(accepted.receipt, receipt);
                if (!accepted) await beforeReceipt?.(structuredClone({ job, receipt, acceptedReceipts: ledger.acceptedReceipts }));
                const lost = fault === "receipt-loss" && !accepted;
                ledger.receiptRequests.push({ jobId: job.jobId, receipt, replayed: Boolean(accepted), responseLost: lost, at: Date.now() });
                if (!accepted) ledger.acceptedReceipts.push({ jobId: job.jobId, receipt, acceptedAt: Date.now() });
                // Persist and fsync acceptance before deliberately destroying the first response.
                await persist();
                if (lost) {
                    request.socket.destroy();
                    return;
                }
                return json(200, { accepted: true });
            }
            return json(404, null);
        } catch (error) {
            ledger.fixtureError ||= error instanceof Error ? error.message : String(error);
            await persist();
            if (!response.headersSent) json(500, null);
            else response.destroy();
        }
    });
    const upstreamOptions = { imagePath };
    const upstream = createProtocolFixtureServer(upstreamOptions);
    const listen = async (server) => {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        return `http://127.0.0.1:${server.address().port}`;
    };
    const endpoint = await listen(worker);
    const upstreamEndpoint = await listen(upstream.server);
    await persist();
    const stop = async (server) => {
        if (!server.listening) return;
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    };
    return {
        endpoint,
        upstreamEndpoint,
        token,
        native,
        ai,
        delivery,
        wrongShaPng,
        expected,
        ledgerPath,
        serviceId,
        model,
        owner,
        counts: () => upstreamCounts(upstream.requests),
        upstreamRequests: () => upstream.requests.slice(),
        setSceneOutput: async (name, bytes, size) => {
            assert.equal(sceneOutputs, true, "Only the explicit F13 fixture may switch controlled upstream bytes");
            assert.match(name, /^[a-z][a-z0-9-]*$/);
            const image = sharp(bytes, { failOn: "warning" });
            const [metadata, pixels, statistics] = await Promise.all([image.metadata(), image.clone().raw().toBuffer({ resolveWithObject: true }), image.clone().stats()]);
            assert.deepEqual({ width: pixels.info.width, height: pixels.info.height }, size);
            assert.equal(metadata.format, "png");
            assert.equal(statistics.isOpaque, true);
            const file = path.join(directory, `${name}.png`);
            await writeFile(file, bytes, { flag: "wx" });
            upstreamOptions.imagePath = file;
            const output = { name, ...size, sha256: sha256(bytes), byteLength: bytes.length, kind: "controlled image upstream transport bytes; not GPU/quality evidence" };
            (ledger.sceneOutputs ||= []).push(output);
            await persist();
            return output;
        },
        isListening: () => worker.listening,
        setFault: async (fault) => {
            ledger.fault = fault;
            ledger.injections.push({ fault, stage: "armed-after-native", at: Date.now() });
            await persist();
        },
        setJobFault: async (jobId, fault) => {
            const job = ledger.jobs.find((candidate) => candidate.jobId === jobId);
            assert.ok(job, "Arm only an existing owned remote job");
            job.fault = fault;
            ledger.injections.push({ owner, jobId, fault, stage: "armed-for-job", at: Date.now() });
            await persist();
        },
        refuseConnections: async () => {
            ledger.fault = "connection-refused";
            ledger.injections.push({ fault: "connection-refused", stage: "query", endpoint, at: Date.now() });
            await persist();
            await stop(worker);
        },
        beforeReceipt: (callback) => {
            beforeReceipt = callback;
        },
        beforeSubmitReply: (callback) => {
            beforeSubmitReply = callback;
        },
        observeExecutor,
        completeExecutor,
        snapshot: async () => {
            await persist();
            return JSON.parse(await readFile(ledgerPath, "utf8"));
        },
        close: async () => {
            const cleanupErrors = [];
            for (const state of executors.values())
                if (!state.terminal) {
                    try {
                        state.child.kill("SIGKILL");
                        const terminal = await untilObserved(async () => state.terminal, Boolean, "owned executor cleanup terminal event");
                        ledger.executorObservations.push({ stage: "cleanup-only-forced-exit", executionId: state.executionId, terminal, at: Date.now() });
                    } catch (error) {
                        cleanupErrors.push(error);
                    }
                }
            for (const server of [worker, upstream.server])
                try {
                    await stop(server);
                } catch (error) {
                    cleanupErrors.push(error);
                }
            await persist();
            if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Owned protocol fixture cleanup failed");
        },
    };
}
