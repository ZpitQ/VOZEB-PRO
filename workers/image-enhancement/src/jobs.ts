import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  createRunnerLimits,
  createSubmissionLimits,
  createWorkerConfig,
  type RunnerLimits,
  type SubmissionLimits,
  type WorkerConfig,
} from "./config.js";
import {
  EnhancementError,
  INTERNAL_SELF_TEST_KEY_PREFIX,
  isInternalSelfTestKey,
  normalizePlan,
  parsePlanRequest,
} from "./contracts.js";
import { prepareEngineInput } from "./image-io.js";
import { freezeExecutionPolicy } from "./execution.js";
import type {
  AcceptedJob,
  AuthenticatedClient,
  EnhancementStore,
  JobDto,
} from "./store.js";

export const localInputFiles = Object.freeze({
  async mkdir(path: string) {
    await mkdir(path, { mode: 0o700 });
  },
  async write(path: string, bytes: Buffer) {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  },
  async syncDirectory(path: string) {
    const directory = await open(
      path,
      process.platform === "win32" ? "r+" : "r",
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
  rename,
  async remove(path: string) {
    await rm(path, { recursive: true, force: true });
  },
});

type JobServiceOptions = Readonly<{
  store: EnhancementStore;
  config: () => WorkerConfig;
  ready: () => boolean;
  limits: SubmissionLimits;
  runnerLimits: RunnerLimits;
  files?: typeof localInputFiles;
  internalIdempotencyKey?: string;
}>;

function parseSubmission(value: unknown, limits: SubmissionLimits) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 3 ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !["idempotencyKey", "sourceBytes", "plan"].includes(key),
    )
  )
    throw new EnhancementError("invalid_request");
  const input = value as Record<string, unknown>;
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length > limits.maxIdempotencyKeyLength ||
    !/^[\x21-\x7e]+$/.test(input.idempotencyKey) ||
    !Buffer.isBuffer(input.sourceBytes)
  )
    throw new EnhancementError("invalid_request");
  const request = parsePlanRequest(input.plan);
  const sourceBytes = Buffer.from(input.sourceBytes);
  if (
    createHash("sha256").update(sourceBytes).digest("hex") !==
    request.sourceSha256
  )
    throw new EnhancementError("input_digest_mismatch");
  return { idempotencyKey: input.idempotencyKey, sourceBytes, request };
}

export function createJobService(options: JobServiceOptions) {
  const { store } = options;
  const limits = createSubmissionLimits(options.limits);
  const internalIdempotencyKey = options.internalIdempotencyKey;
  if (
    internalIdempotencyKey !== undefined &&
    (!isInternalSelfTestKey(internalIdempotencyKey) ||
      internalIdempotencyKey.length > limits.maxIdempotencyKeyLength)
  )
    throw new EnhancementError("configuration_invalid");
  const runnerLimits = createRunnerLimits(options.runnerLimits);
  const files = options.files ?? localInputFiles;
  return Object.freeze({
    async submit(
      principal: AuthenticatedClient,
      value: unknown,
      signal?: AbortSignal,
    ): Promise<AcceptedJob> {
      if (signal?.aborted) throw new EnhancementError("invalid_request");
      store.assertPrincipal(principal);
      const { idempotencyKey, sourceBytes, request } = parseSubmission(
        value,
        limits,
      );
      if (
        internalIdempotencyKey === undefined
          ? idempotencyKey.startsWith(INTERNAL_SELF_TEST_KEY_PREFIX)
          : idempotencyKey !== internalIdempotencyKey
      )
        throw new EnhancementError("invalid_request");
      const existing = store.findByKey(principal, idempotencyKey);
      if (existing) return store.matchReplay(existing, request);

      const config = createWorkerConfig(options.config());
      const plan = normalizePlan(request, config);
      const executionPolicy = freezeExecutionPolicy(
        runnerLimits,
        config.models.find((model) => model.id === plan.engine.modelId)!
          .allowedTiles,
      );
      const prepared = await prepareEngineInput(sourceBytes, plan);
      const jobId = randomUUID();
      const pendingDirectory = join(store.inputDirectory, `.pending-${jobId}`);
      const finalDirectory = join(store.inputDirectory, jobId);
      let ownedDirectory: string | undefined;
      try {
        await files.mkdir(pendingDirectory);
        ownedDirectory = pendingDirectory;
        await files.write(
          join(pendingDirectory, `original.${prepared.source.format}`),
          prepared.source.bytes,
        );
        await files.write(
          join(pendingDirectory, "engine.png"),
          prepared.engineInput.bytes,
        );
        await files.syncDirectory(pendingDirectory);
        await files.rename(pendingDirectory, finalDirectory);
        ownedDirectory = finalDirectory;
        await files.syncDirectory(store.inputDirectory);

        const createdAt = store.now();
        const queueDeadlineAt = createdAt + limits.queueTimeoutMs;
        if (!Number.isSafeInteger(queueDeadlineAt))
          throw new EnhancementError("configuration_invalid");
        const { bytes: _sourceBytes, ...source } = prepared.source;
        const { bytes: _engineBytes, ...engineInput } = prepared.engineInput;
        const candidate: JobDto = Object.freeze({
          serviceId: store.identity.serviceId,
          jobId,
          clientId: principal.clientId,
          status: "queued" as const,
          reason: null,
          result: null,
          cancelRequested: false,
          createdAt,
          queueDeadlineAt,
          completedAt: null,
          source: Object.freeze(source),
          engineInput: Object.freeze(engineInput),
          plan,
        });
        const isReady = options.ready() === true;
        // From this check through COMMIT, keep acceptance synchronous.
        if (signal?.aborted) throw new EnhancementError("invalid_request");
        const accepted = store.acceptQueued(
          principal,
          idempotencyKey,
          request,
          candidate,
          executionPolicy,
          limits,
          isReady,
        );
        if (accepted.replayed) {
          await files.remove(finalDirectory);
          await files.syncDirectory(store.inputDirectory);
        }
        return accepted;
      } catch (error) {
        if (ownedDirectory) {
          // A failed/ambiguous DB read must preserve files rather than risk deleting a committed job.
          let registered = true;
          try {
            registered = store.hasRegisteredInput(jobId);
          } catch {
            /* preserve */
          }
          if (!registered) {
            try {
              await files.remove(ownedDirectory);
              await files.syncDirectory(store.inputDirectory);
            } catch {
              /* No job was accepted; orphan cleanup remains separate. */
            }
          }
        }
        if (error instanceof EnhancementError) throw error;
        throw new EnhancementError("internal_error");
      }
    },
    get(principal: AuthenticatedClient, jobId: string) {
      return store.getOwned(principal, jobId);
    },
    cancel(principal: AuthenticatedClient, jobId: string) {
      return store.requestCancel(principal, jobId);
    },
  });
}
