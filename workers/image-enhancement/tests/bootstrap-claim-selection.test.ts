import { once } from "node:events";
import { request, type Server } from "node:http";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startWindowsWorker } from "../src/bootstrap.js";
import * as httpModule from "../src/http.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import * as adapterModule from "../src/windows-execution-adapter.js";
import type { WindowsExecutionAdapter } from "../src/windows-execution-adapter.js";
import { configInput } from "./fixtures.js";
import {
  boundary,
  multipart,
  transportLimits,
  uploadParts,
} from "./http-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import { recoveryExecutor } from "./recovery-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function configuration(storeDirectory: string, operatorClientId: string) {
  return {
    storeDirectory,
    operatorClientId,
    selfTestModelId: "standard-4x",
    port: 0,
    workerConfig: configInput(),
    submissionLimits: { ...submissionLimits },
    runnerLimits: { ...runnerLimits },
    transportLimits: { ...transportLimits },
    execution: {
      installationRoot: runnerAdapterOptions.bridge.installationRoot,
      recordsRoot: runnerAdapterOptions.bridge.recordsRoot,
      expectedManifestSha256:
        runnerAdapterOptions.bridge.expectedManifestSha256,
      bridgeLimits: { ...runnerAdapterOptions.bridge.limits },
      journalLimits: { ...runnerAdapterOptions.journalLimits },
    },
  };
}

type Body = {
  code?: string;
  data?: {
    ready?: boolean;
    replayed?: boolean;
    applied?: boolean;
    job?: { jobId?: string; status?: string; cancelRequested?: boolean };
    [name: string]: unknown;
  };
};

function call(
  server: Server,
  authorization: string,
  method: string,
  path: string,
  body?: Buffer,
  headers: Readonly<Record<string, string>> = {},
) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("controlled listener is unavailable");
  return new Promise<{ status: number; body: Body; serialized: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          method,
          path,
          agent: false,
          headers: {
            authorization,
            ...(body ? { "content-length": body.length } : {}),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", () =>
            reject(new Error("controlled response failed")),
          );
          response.once("end", () => {
            try {
              const serialized = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode!,
                body: JSON.parse(serialized) as Body,
                serialized,
              });
            } catch {
              reject(new Error("unexpected controlled response"));
            }
          });
        },
      );
      req.once("error", () => reject(new Error("controlled request failed")));
      req.end(body);
    },
  );
}

describe.skipIf(process.platform !== "win32")(
  "bootstrap fixed none selection",
  () => {
    it("keeps persisted queued jobs unclaimed through startup, HTTP replay and exact cancellation", async () => {
      const storage = await storageFixture();
      cleanups.push(() => storage.cleanup());
      storage.setNow(Date.now());
      const bytes = await sourceImage();
      const first = await storage
        .service()
        .submit(storage.principal(), submission(bytes, "persisted-replay"));
      const second = await storage
        .service()
        .submit(storage.principal(), submission(bytes, "persisted-waiting"));
      const executor = recoveryExecutor();
      let sealed = false;
      const closeAdapter = vi.fn(async () => {
        sealed = true;
        return "closed" as const;
      });
      const adapter: WindowsExecutionAdapter = {
        ...executor.adapter,
        kind: "windows",
        pendingWork() {
          throw new Error("legacy fixture cannot observe pending work");
        },
        status: (): adapterModule.WindowsExecutionStatus =>
          Object.freeze({
            sealed,
            activity: executor.activeCount() === 0 ? "idle" : "busy",
            close: sealed ? "closed" : "not_requested",
          }),
        close: closeAdapter,
        interrupt: closeAdapter,
      };
      vi.spyOn(adapterModule, "createWindowsExecutionAdapter").mockReturnValue(
        adapter,
      );
      const originalOpen = storeModule.openStore;
      let beginCalls = 0;
      vi.spyOn(storeModule, "openStore").mockImplementation((options) => {
        const opened = originalOpen(options);
        storage.setStore(opened);
        const begin = opened.beginRecovery.bind(opened);
        vi.spyOn(opened, "beginRecovery").mockImplementation((...args) => {
          beginCalls++;
          return begin(...args);
        });
        return opened;
      });
      let listening: Server | undefined;
      const listen = httpModule.listenEnhancementServer;
      const listenSpy = vi
        .spyOn(httpModule, "listenEnhancementServer")
        .mockImplementation(async (...args) => {
          const actual = await listen(...args);
          listening = actual;
          return actual;
        });
      const create = runnerModule.createRunner;
      let recovery: Promise<void> | undefined;
      let recoverCalls = 0;
      let wakeCalls = 0;
      vi.spyOn(runnerModule, "createRunner").mockImplementation((options) => {
        const actual = create(options);
        return Object.freeze({
          ...actual,
          recover() {
            recoverCalls++;
            expect(
              listening?.listening,
              "listen precedes the sole startup recovery",
            ).toBe(true);
            recovery = actual.recover();
            return recovery;
          },
          wake() {
            wakeCalls++;
            return actual.wake();
          },
        });
      });
      storage.store.close();
      const runtime = await startWindowsWorker(
        configuration(
          storage.directory,
          storage.initialized.credential.clientId,
        ),
        {
          appDirectory: "Z:\\contract-only\\payload\\app",
          signal: new AbortController().signal,
        },
      );
      cleanups.push(async () => {
        if (runtime.server.listening) {
          const closed = once(runtime.server, "close");
          runtime.close();
          await closed;
        } else runtime.close();
      });
      expect(recovery !== undefined).toBe(true);
      await recovery;
      const counts = () =>
        snapshot(storage, (db) => ({
          attempts: (
            db.prepare("SELECT COUNT(*) AS count FROM attempts").get() as {
              count: number;
            }
          ).count,
          slots: (
            db
              .prepare("SELECT COUNT(*) AS count FROM execution_slot")
              .get() as { count: number }
          ).count,
        }));
      expect(counts().attempts).toBe(0);
      expect(counts().slots).toBe(0);
      expect(executor.prepareCalls.length).toBe(0);
      expect(executor.authorizeCalls.length).toBe(0);
      expect(beginCalls).toBe(1);
      expect(recoverCalls).toBe(1);
      const authorization = `Bearer ${storage.initialized.credential.key}`;
      expect(
        (await call(runtime.server, authorization, "GET", "/healthz")).status,
      ).toBe(200);
      const capabilities = await call(
        runtime.server,
        authorization,
        "GET",
        "/v1/capabilities",
      );
      expect(capabilities.status).toBe(200);
      expect(capabilities.body.data?.ready).toBe(false);
      expect(
        isDeepStrictEqual(
          Object.keys(capabilities.body.data ?? {}).sort(),
          [
            "serviceId",
            "protocolVersion",
            "normalizationProfile",
            "models",
            "budgets",
            "ready",
            "reason",
          ].sort(),
        ),
        "original public capability field whitelist",
      ).toBe(true);
      for (const privateValue of [
        storage.directory,
        storage.initialized.credential.key,
        "ownerInstanceId",
        "launchTicket",
        "claimSelection",
        "recoveryState",
      ])
        expect(
          capabilities.serialized.includes(privateValue),
          "no private capability value",
        ).toBe(false);
      const queried = await call(
        runtime.server,
        authorization,
        "GET",
        `/v1/enhancement-jobs/${first.job.jobId}`,
      );
      expect(queried.status).toBe(200);
      expect(queried.body.data?.job?.jobId === first.job.jobId).toBe(true);
      expect(queried.body.data?.job?.status).toBe("queued");
      const replay = await call(
        runtime.server,
        authorization,
        "POST",
        "/v1/enhancement-jobs",
        multipart(uploadParts(bytes)),
        {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "idempotency-key": "persisted-replay",
        },
      );
      expect(replay.status).toBe(202);
      expect(replay.body.data?.replayed).toBe(true);
      expect(replay.body.data?.job?.jobId === first.job.jobId).toBe(true);
      expect(replay.body.data?.job?.status).toBe("queued");
      const beforeCancelWake = wakeCalls;
      const cancelled = await call(
        runtime.server,
        authorization,
        "DELETE",
        `/v1/enhancement-jobs/${first.job.jobId}`,
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data?.applied).toBe(true);
      expect(cancelled.body.data?.job?.status).toBe("cancelled");
      expect(wakeCalls).toBe(beforeCancelWake + 1);
      expect(
        storage.service().get(storage.principal(), second.job.jobId).status,
      ).toBe("queued");
      expect(counts().attempts).toBe(0);
      expect(counts().slots).toBe(0);
      expect(executor.prepareCalls.length).toBe(0);
      expect(executor.authorizeCalls.length).toBe(0);
      expect(recoverCalls).toBe(1);
      expect(beginCalls).toBe(1);
      expect(listenSpy.mock.calls[0]![0].ready?.()).toBe(false);
      const beforeCloseWake = wakeCalls;
      const closed = once(runtime.server, "close");
      expect(runtime.close()).toBeUndefined();
      expect(sealed, "close seals the controlled adapter synchronously").toBe(
        true,
      );
      await listenSpy.mock.calls[0]![0].onJobCommitted?.();
      expect(wakeCalls).toBe(beforeCloseWake);
      await closed;
      expect(closeAdapter.mock.calls.length).toBe(1);
    }, 15_000);
  },
);
