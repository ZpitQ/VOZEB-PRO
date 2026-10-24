import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkerConfig,
  type RunnerLimits,
  type WorkerConfig,
} from "../src/config.js";
import {
  EnhancementError,
  normalizePlan,
  parsePlanRequest,
  requestFingerprint,
  toErrorResponse,
  type EnhancementErrorCode,
  type EnhancementPlanRequest,
  type FrozenEnhancementPlan,
} from "../src/contracts.js";
import {
  authenticate,
  createClient,
  revokeCredential,
  rotateCredential,
} from "../src/credentials.js";
import {
  freezeExecutionPolicy,
  type ExecutionPolicy,
} from "../src/execution.js";
import { prepareEngineInput } from "../src/image-io.js";
import { createJobService } from "../src/jobs.js";
import {
  openStore,
  type AuthenticatedClient,
  type EnhancementStore,
  type JobDto,
  type SourceManifest,
} from "../src/store.js";
import { artifactFixture } from "./artifact-fixtures.js";
import { publishedArtifactControl } from "./artifact-fault-fixtures.js";
import { configInput, planInput } from "./fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  recursiveFiles,
  runnerLimits,
  sha256,
  sourceImage,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";

const prefix = "vozeb:self-test:v1:";
type Storage = Awaited<ReturnType<typeof storageFixture>>;
type Expected = Readonly<{
  request: EnhancementPlanRequest;
  plan: FrozenEnhancementPlan;
  executionPolicy: ExecutionPolicy;
  source: SourceManifest;
}>;
type Inspection = Readonly<
  | { kind: "absent" }
  | { kind: "reusable"; idempotencyKey: string; job: JobDto }
  | { kind: "blocked"; jobId: string }
>;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const storage = await storageFixture();
  cleanups.push(() => storage.cleanup());
  return storage;
}

function inspector(store: EnhancementStore) {
  const method: unknown = Reflect.get(store, "inspectQueuedSelfTest");
  expect(typeof method, "Store exposes inspectQueuedSelfTest").toBe("function");
  return (principal: AuthenticatedClient, expected: unknown) =>
    Reflect.apply(method as (...args: unknown[]) => unknown, store, [
      principal,
      expected,
    ]) as Inspection;
}

async function expectedIdentity(
  bytes: Buffer,
  input: unknown = planInput(sha256(bytes)),
  config: WorkerConfig = createWorkerConfig(configInput()),
  limits: RunnerLimits = runnerLimits,
): Promise<Expected> {
  const request = parsePlanRequest(input);
  const plan = normalizePlan(request, config);
  const prepared = await prepareEngineInput(bytes, plan);
  const { bytes: _bytes, ...source } = prepared.source;
  return {
    request,
    plan,
    executionPolicy: freezeExecutionPolicy(
      limits,
      config.models.find((model) => model.id === plan.engine.modelId)!
        .allowedTiles,
    ),
    source: Object.freeze(source),
  };
}

async function queued(
  storage: Storage,
  key = `${prefix}${randomUUID()}`,
  bytes?: Buffer,
  principal = storage.principal(),
) {
  const sourceBytes = bytes ?? (await sourceImage());
  const expected = await expectedIdentity(sourceBytes);
  const options = {
    store: storage.store,
    config: () => createWorkerConfig(configInput()),
    ready: () => true,
    limits: submissionLimits,
    runnerLimits,
    internalIdempotencyKey: key,
  };
  const accepted = await createJobService(options).submit(principal, {
    idempotencyKey: key,
    sourceBytes,
    plan: expected.request,
  });
  return { key, bytes: sourceBytes, expected, accepted };
}

function facts(storage: Storage) {
  const tables = [
    "jobs",
    "attempts",
    "execution_slot",
    "artifact_candidates",
    "artifact_references",
    "artifact_observations",
    "result_receipts",
    "recovery_controls",
    "recovery_events",
    "store_incarnations",
  ] as const;
  return snapshot(storage, (db) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );
}

async function inputs(storage: Storage) {
  return Promise.all(
    (await recursiveFiles(storage.store.inputDirectory))
      .sort()
      .map(async (path) => [path, sha256(await readFile(path))] as const),
  );
}

function reopen(storage: Storage, clock = storage.clock) {
  storage.store.close();
  const store = openStore({ directory: storage.directory, clock });
  storage.setStore(store);
  return store;
}

// Same real-connection observation used by the existing retention tests.
function reopenWithConnection(storage: Storage, clock = storage.clock) {
  storage.store.close();
  const path = join(storage.directory, "worker.sqlite");
  const prepare = Database.prototype.prepare;
  let connection: Database.Database | undefined;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name === path) connection = this;
    return prepare.call(this, sql);
  } as typeof prepare;
  try {
    const store = openStore({ directory: storage.directory, clock });
    storage.setStore(store);
    expect(connection !== undefined, "real Store database connection").toBe(
      true,
    );
    return { store, db: connection! };
  } finally {
    Database.prototype.prepare = prepare;
  }
}

function editDatabase(storage: Storage, edit: (db: Database.Database) => void) {
  storage.store.close();
  const db = new Database(join(storage.directory, "worker.sqlite"));
  try {
    db.pragma("foreign_keys = ON");
    edit(db);
  } finally {
    db.close();
    storage.setStore(
      openStore({ directory: storage.directory, clock: storage.clock }),
    );
  }
}

function rejected(
  action: () => unknown,
  code: EnhancementErrorCode,
  privateValues: readonly string[] = [],
) {
  let returned = false;
  let failure: unknown;
  try {
    action();
    returned = true;
  } catch (error) {
    failure = error;
  }
  expect(returned, "inspection exposes no result on failure").toBe(false);
  expect(
    failure instanceof EnhancementError && failure.code === code,
    `inspection reports ${code}`,
  ).toBe(true);
  const rendered =
    String(failure) +
    JSON.stringify(failure) +
    JSON.stringify(toErrorResponse(failure, "self-test-identity-fixture"));
  expect(
    privateValues.every((value) => !rendered.includes(value)),
    "sanitized inspection failure",
  ).toBe(true);
}

function blocked(result: Inspection, jobId: string) {
  expect(result.kind).toBe("blocked");
  expect(result.kind === "blocked" && result.jobId === jobId).toBe(true);
  expect(
    isDeepStrictEqual(Reflect.ownKeys(result).sort(), ["jobId", "kind"]),
  ).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
}

describe("Store read-only queued self-test identity inspection", () => {
  it("limits absent to the authenticated client, including when another real client owns a matching queued job", async () => {
    const storage = await fixture();
    const bytes = await sourceImage();
    const expected = await expectedIdentity(bytes);
    const inspect = inspector(storage.store);
    const principal = storage.principal();
    const empty = inspect(principal, expected);
    expect(isDeepStrictEqual(empty, { kind: "absent" })).toBe(true);
    expect(Object.isFrozen(empty)).toBe(true);
    await storage.service().submit(principal, {
      idempotencyKey: "ordinary-identity-noise",
      sourceBytes: bytes,
      plan: expected.request,
    });
    expect(
      isDeepStrictEqual(inspect(principal, expected), { kind: "absent" }),
    ).toBe(true);
    const other = createClient(storage.store);
    const otherPrincipal = authenticate(storage.store, `Bearer ${other.key}`);
    const accepted = await queued(
      storage,
      undefined,
      undefined,
      otherPrincipal,
    );
    const before = facts(storage);
    const files = await inputs(storage);
    const result = inspect(principal, expected);
    expect(isDeepStrictEqual(result, { kind: "absent" })).toBe(true);
    const text = JSON.stringify(result);
    expect(
      [
        accepted.key,
        accepted.accepted.job.jobId,
        other.clientId,
        other.key,
      ].every((value) => !text.includes(value)),
    ).toBe(true);
    const owned = inspect(otherPrincipal, accepted.expected);
    expect(
      owned.kind === "reusable" && owned.idempotencyKey === accepted.key,
    ).toBe(true);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    expect(isDeepStrictEqual(await inputs(storage), files)).toBe(true);
  });

  it("rejects forged, revoked and different-Store principals without returning candidate information", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    const foreign = await fixture();
    const inspect = inspector(storage.store);
    const principal = storage.principal();
    const before = facts(storage);
    const privateValues = [
      storage.directory,
      storage.initialized.credential.key,
      candidate.key,
      candidate.accepted.job.jobId,
      principal.clientId,
    ];
    for (const invalid of [{ ...principal }, foreign.principal()]) {
      rejected(
        () => inspect(invalid, candidate.expected),
        "authentication_failed",
        privateValues,
      );
    }
    revokeCredential(storage.store, principal.credentialId);
    rejected(
      () => inspect(principal, candidate.expected),
      "authentication_failed",
      privateValues,
    );
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it("reopens a unique never-claimed queued identity as fresh frozen data without changing rows, input files or caller data", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    let observeClock = false;
    const clockTransactions: boolean[] = [];
    let active: Database.Database | undefined;
    const { store, db } = reopenWithConnection(storage, () => {
      if (observeClock) clockTransactions.push(active!.inTransaction);
      return storage.clock();
    });
    active = db;
    const inspect = inspector(store);
    const principal = storage.principal();
    const expected = structuredClone(candidate.expected);
    const originalExpected = structuredClone(expected);
    const callerObjects = [
      expected,
      expected.request,
      expected.request.target,
      expected.plan,
      expected.plan.target,
      expected.plan.engine,
      expected.plan.budgets,
      expected.plan.budgets.input,
      expected.plan.budgets.ai,
      expected.plan.budgets.delivery,
      expected.executionPolicy,
      expected.executionPolicy.limits,
      expected.executionPolicy.allowedTiles,
      expected.source,
    ];
    expect(callerObjects.every((value) => !Object.isFrozen(value))).toBe(true);
    const before = facts(storage);
    const files = await inputs(storage);
    const changes = db.prepare("SELECT total_changes() AS count").get();
    observeClock = true;
    const result = inspect(principal, expected);
    const again = inspect(principal, expected);
    observeClock = false;
    expect(result.kind).toBe("reusable");
    expect(
      result.kind === "reusable" && result.idempotencyKey === candidate.key,
    ).toBe(true);
    expect(
      result.kind === "reusable" &&
        isDeepStrictEqual(result.job, candidate.accepted.job),
    ).toBe(true);
    expect(
      result.kind === "reusable" && result.job !== candidate.accepted.job,
    ).toBe(true);
    expect(isDeepStrictEqual(result, again) && result !== again).toBe(true);
    if (result.kind !== "reusable") return;
    expect(
      isDeepStrictEqual(Reflect.ownKeys(result).sort(), [
        "idempotencyKey",
        "job",
        "kind",
      ]),
    ).toBe(true);
    expect(
      [
        result,
        result.job,
        result.job.source,
        result.job.engineInput,
        result.job.plan,
        result.job.plan.target,
        result.job.plan.engine,
        result.job.plan.budgets,
        result.job.plan.budgets.input,
        result.job.plan.budgets.ai,
        result.job.plan.budgets.delivery,
      ].every(Object.isFrozen),
    ).toBe(true);
    expect(
      result.job.source !== expected.source &&
        result.job.plan !== expected.plan,
    ).toBe(true);
    expect(isDeepStrictEqual(expected, originalExpected)).toBe(true);
    expect(callerObjects.every((value) => !Object.isFrozen(value))).toBe(true);
    expect(clockTransactions.length).toBe(2);
    expect(clockTransactions.every((value) => !value)).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(
      isDeepStrictEqual(
        db.prepare("SELECT total_changes() AS count").get(),
        changes,
      ),
    ).toBe(true);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    expect(isDeepStrictEqual(await inputs(storage), files)).toBe(true);
    expect(JSON.stringify(result).includes(storage.directory)).toBe(false);
  });

  it.each(["first", "second"] as const)(
    "blocks two queued prefix candidates, including a malformed %s key, using queue sequence for equal creation times",
    async (malformed) => {
      const storage = await fixture();
      const first = await queued(storage);
      const second = await queued(storage);
      expect(
        first.accepted.job.createdAt === second.accepted.job.createdAt,
      ).toBe(true);
      const corrupted = malformed === "first" ? first : second;
      editDatabase(storage, (db) => {
        db.prepare("UPDATE jobs SET idempotency_key = ? WHERE job_id = ?").run(
          `${prefix}malformed`,
          corrupted.accepted.job.jobId,
        );
      });
      const inspect = inspector(storage.store);
      const before = facts(storage);
      const files = await inputs(storage);
      blocked(
        inspect(storage.principal(), first.expected),
        first.accepted.job.jobId,
      );
      blocked(
        inspect(storage.principal(), second.expected),
        first.accepted.job.jobId,
      );
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
      expect(isDeepStrictEqual(await inputs(storage), files)).toBe(true);
    },
  );

  it.each([
    ["empty suffix", prefix],
    ["arbitrary suffix", `${prefix}identifier`],
    ["uppercase UUID", `${prefix}A50E3AF5-8E82-4BAD-8C0B-A1AE6F5B3629`],
    ["wrong version", `${prefix}a50e3af5-8e82-3bad-8c0b-a1ae6f5b3629`],
    ["wrong variant", `${prefix}a50e3af5-8e82-4bad-7c0b-a1ae6f5b3629`],
    ["extra suffix", `${prefix}a50e3af5-8e82-4bad-8c0b-a1ae6f5b3629:extra`],
  ] as const)(
    "blocks a single malformed reserved %s key without repairing it",
    async (_label, key) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      editDatabase(storage, (db) => {
        db.prepare("UPDATE jobs SET idempotency_key = ? WHERE job_id = ?").run(
          key,
          candidate.accepted.job.jobId,
        );
      });
      const inspect = inspector(storage.store);
      const before = facts(storage);
      blocked(
        inspect(storage.principal(), candidate.expected),
        candidate.accepted.job.jobId,
      );
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    },
  );

  it("blocks changed request, source, target, model and tile identities, and requires an explicit fixed request tile", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    const inspect = inspector(storage.store);
    const before = facts(storage);
    const files = await inputs(storage);
    const request = candidate.expected.request;
    const modelConfig = configInput();
    modelConfig.models[0]!.id = "another-fixture-4x";
    const { tile: _tile, ...withoutTile } = request;
    const changed: readonly (readonly [string, Expected])[] = [
      ["source", await expectedIdentity(await sourceImage("blue"))],
      [
        "target",
        await expectedIdentity(candidate.bytes, {
          ...request,
          target: { width: 16, height: 12, format: "png" },
        }),
      ],
      [
        "model",
        await expectedIdentity(
          candidate.bytes,
          {
            ...request,
            modelId: modelConfig.models[0]!.id,
          },
          createWorkerConfig(modelConfig),
        ),
      ],
      [
        "tile",
        await expectedIdentity(candidate.bytes, { ...request, tile: 128 }),
      ],
      [
        "request differs from plan",
        {
          ...candidate.expected,
          request: parsePlanRequest({ ...request, tile: 128 }),
        },
      ],
      [
        "implicit tile",
        {
          ...candidate.expected,
          request: parsePlanRequest(withoutTile),
        },
      ],
      [
        "source differs from request and plan",
        {
          ...candidate.expected,
          source: (await expectedIdentity(await sourceImage("blue"))).source,
        },
      ],
    ];
    for (const [label, expected] of changed) {
      const result = inspect(storage.principal(), expected);
      expect(result.kind === "blocked", label).toBe(true);
      blocked(result, candidate.accepted.job.jobId);
    }
    expect(
      requestFingerprint(
        parsePlanRequest(withoutTile),
        candidate.expected.plan.engine.tile,
      ) === requestFingerprint(request, candidate.expected.plan.engine.tile),
    ).toBe(true);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    expect(isDeepStrictEqual(await inputs(storage), files)).toBe(true);
  });

  it("blocks complete frozen engine, budget and execution-policy changes even while the original request fingerprint is equal", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    const inspect = inspector(storage.store);
    const before = facts(storage);
    const fingerprint = requestFingerprint(
      candidate.expected.request,
      candidate.expected.plan.engine.tile,
    );
    for (const field of [
      "binary version",
      "binary digest",
      "model version",
      "model digest",
      "GPU",
      "input bytes",
      "input pixels",
      "AI bytes",
      "AI pixels",
      "delivery bytes",
      "delivery pixels",
      "execution timeout",
      "cancel grace",
      "lease duration",
      "heartbeat",
      "allowed tiles",
    ] as const) {
      const config = configInput();
      const model = config.models[0]!;
      const limits = { ...runnerLimits };
      if (field === "binary version") model.binaryVersion = "fixture-binary-v2";
      if (field === "binary digest") model.binarySha256 = "d".repeat(64);
      if (field === "model version") model.modelVersion = "fixture-model-v2";
      if (field === "model digest") model.modelSha256 = "e".repeat(64);
      if (field === "GPU") model.gpuId = 1;
      if (field === "input bytes") config.budgets.input.maxBytes--;
      if (field === "input pixels") config.budgets.input.maxPixels--;
      if (field === "AI bytes") config.budgets.ai.maxBytes--;
      if (field === "AI pixels") config.budgets.ai.maxPixels--;
      if (field === "delivery bytes") config.budgets.delivery.maxBytes--;
      if (field === "delivery pixels") config.budgets.delivery.maxPixels--;
      if (field === "execution timeout") limits.executionTimeoutMs++;
      if (field === "cancel grace") limits.cancelGraceMs++;
      if (field === "lease duration") limits.leaseDurationMs++;
      if (field === "heartbeat") limits.heartbeatIntervalMs++;
      if (field === "allowed tiles") model.allowedTiles = [128, 256];
      const expected = await expectedIdentity(
        candidate.bytes,
        candidate.expected.request,
        createWorkerConfig(config),
        limits,
      );
      expect(
        requestFingerprint(expected.request, expected.plan.engine.tile) ===
          fingerprint,
        `request fingerprint omits ${field}`,
      ).toBe(true);
      expect(
        !isDeepStrictEqual(expected.plan, candidate.expected.plan) ||
          !isDeepStrictEqual(
            expected.executionPolicy,
            candidate.expected.executionPolicy,
          ),
        field,
      ).toBe(true);
      blocked(
        inspect(storage.principal(), expected),
        candidate.accepted.job.jobId,
      );
    }
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it.each(["raw source", "plan source", "request content"] as const)(
    "requires coherent %s even when all persisted comparisons and the real request fingerprint match",
    async (field) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      const other = await expectedIdentity(await sourceImage("blue"));
      const expected: Expected =
        field === "raw source"
          ? { ...candidate.expected, source: other.source }
          : field === "plan source"
            ? { ...candidate.expected, plan: other.plan }
            : {
                ...candidate.expected,
                request: parsePlanRequest({
                  ...candidate.expected.request,
                  tile: 128,
                }),
              };
      editDatabase(storage, (db) => {
        if (field === "raw source") {
          db.prepare("UPDATE jobs SET source_json = ? WHERE job_id = ?").run(
            JSON.stringify(expected.source),
            candidate.accepted.job.jobId,
          );
        }
        if (field === "plan source") {
          db.prepare("UPDATE jobs SET plan_json = ? WHERE job_id = ?").run(
            JSON.stringify(expected.plan),
            candidate.accepted.job.jobId,
          );
        }
        if (field === "request content") {
          db.prepare(
            "UPDATE jobs SET request_identity = ? WHERE job_id = ?",
          ).run(
            requestFingerprint(expected.request, expected.plan.engine.tile),
            candidate.accepted.job.jobId,
          );
        }
      });
      const principal = storage.principal();
      const persisted = storage.store.findByKey(principal, candidate.key);
      expect(
        persisted !== undefined &&
          persisted.requestIdentity ===
            requestFingerprint(expected.request, expected.plan.engine.tile) &&
          isDeepStrictEqual(persisted.job.plan, expected.plan) &&
          isDeepStrictEqual(persisted.job.source, expected.source) &&
          isDeepStrictEqual(
            persisted.executionPolicy,
            expected.executionPolicy,
          ),
        "the strict source/request relation is the remaining violated condition",
      ).toBe(true);
      const inspect = inspector(storage.store);
      const before = facts(storage);
      blocked(inspect(principal, expected), candidate.accepted.job.jobId);
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    },
  );

  it.each([
    "normalization",
    "plan content",
    "policy content",
    "source content",
    "request identity",
  ] as const)(
    "compares persisted %s beyond a single stored strategy or policy fingerprint",
    async (field) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      const jobId = candidate.accepted.job.jobId;
      editDatabase(storage, (db) => {
        if (field === "normalization" || field === "plan content") {
          const plan =
            field === "normalization"
              ? {
                  ...candidate.expected.plan,
                  normalizationProfile: "other-profile",
                }
              : {
                  ...candidate.expected.plan,
                  engine: {
                    ...candidate.expected.plan.engine,
                    binarySha256: "d".repeat(64),
                  },
                };
          db.prepare("UPDATE jobs SET plan_json = ? WHERE job_id = ?").run(
            JSON.stringify(plan),
            jobId,
          );
        }
        if (field === "policy content") {
          const policy = {
            ...candidate.expected.executionPolicy,
            limits: {
              ...candidate.expected.executionPolicy.limits,
              executionTimeoutMs:
                candidate.expected.executionPolicy.limits.executionTimeoutMs +
                1,
            },
          };
          db.prepare(
            "UPDATE jobs SET execution_policy_json = ? WHERE job_id = ?",
          ).run(JSON.stringify(policy), jobId);
        }
        if (field === "source content") {
          db.prepare("UPDATE jobs SET source_json = ? WHERE job_id = ?").run(
            JSON.stringify({
              ...candidate.expected.source,
              byteLength: candidate.expected.source.byteLength + 1,
            }),
            jobId,
          );
        }
        if (field === "request identity") {
          db.prepare(
            "UPDATE jobs SET request_identity = ? WHERE job_id = ?",
          ).run("different-fixture-request-identity", jobId);
        }
      });
      const inspect = inspector(storage.store);
      const before = facts(storage);
      blocked(inspect(storage.principal(), candidate.expected), jobId);
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    },
  );

  it.each(["running", "cancelled"] as const)(
    "does not reuse a real %s job or change its original execution slot",
    async (status) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      if (status === "running") {
        const attempt = storage.store.claimNext("self-test-identity-owner");
        expect(
          attempt !== undefined &&
            attempt.identity.jobId === candidate.accepted.job.jobId,
        ).toBe(true);
      } else {
        const cancelled = storage.store.requestCancel(
          storage.principal(),
          candidate.accepted.job.jobId,
        );
        expect(cancelled.applied && cancelled.job.status === "cancelled").toBe(
          true,
        );
      }
      const inspect = inspector(storage.store);
      const before = facts(storage);
      const files = await inputs(storage);
      expect(
        isDeepStrictEqual(inspect(storage.principal(), candidate.expected), {
          kind: "absent",
        }),
      ).toBe(true);
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
      expect(isDeepStrictEqual(await inputs(storage), files)).toBe(true);
    },
  );

  it("leaves a real historical successful prefix job and its selected artifact outside the queued query", async () => {
    const artifact = await artifactFixture();
    cleanups.push(() => artifact.cleanup());
    const published = await publishedArtifactControl(
      artifact,
      "historical-self-test-success",
    );
    const storage = artifact.storage;
    const key = `${prefix}${randomUUID()}`;
    // Only the historical key changes; success and its artifact use the complete existing fixture.
    editDatabase(storage, (db) => {
      db.prepare("UPDATE jobs SET idempotency_key = ? WHERE job_id = ?").run(
        key,
        published.attempt.identity.jobId,
      );
    });
    const inspect = inspector(storage.store);
    const expected = await expectedIdentity(await sourceImage("blue"));
    const before = facts(storage);
    const files = await inputs(storage);
    const original = storage.store.getOwned(
      storage.principal(),
      published.attempt.identity.jobId,
    );
    expect(original.status).toBe("succeeded");
    expect(original.result !== null).toBe(true);
    expect(
      isDeepStrictEqual(inspect(storage.principal(), expected), {
        kind: "absent",
      }),
    ).toBe(true);
    expect(
      isDeepStrictEqual(
        storage.store.getOwned(storage.principal(), original.jobId),
        original,
      ),
    ).toBe(true);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    expect(isDeepStrictEqual(await inputs(storage), files)).toBe(true);
  });

  it.each([
    "first_started_at",
    "execution_deadline_at",
    "active_attempt_no",
    "current_fence",
    "cancel_requested_at",
    "completed_at",
    "result_candidate_id",
  ] as const)(
    "blocks one isolated never-claimed violation in %s without repairing it",
    async (column) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      const jobId = candidate.accepted.job.jobId;
      editDatabase(storage, (db) => {
        // These two single-column corruptions deliberately contradict the queued CHECK/FK.
        const unchecked =
          column === "completed_at" || column === "result_candidate_id";
        if (unchecked) db.pragma("ignore_check_constraints = ON");
        if (column === "result_candidate_id") db.pragma("foreign_keys = OFF");
        try {
          const value =
            column === "result_candidate_id"
              ? "isolated-fixture-candidate"
              : column === "active_attempt_no" || column === "current_fence"
                ? 1
                : storage.clock();
          db.prepare(`UPDATE jobs SET ${column} = ? WHERE job_id = ?`).run(
            value,
            jobId,
          );
        } finally {
          if (column === "result_candidate_id") db.pragma("foreign_keys = ON");
          if (unchecked) db.pragma("ignore_check_constraints = OFF");
        }
      });
      const inspect = inspector(storage.store);
      const before = facts(storage);
      blocked(inspect(storage.principal(), candidate.expected), jobId);
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    },
  );

  it("blocks a queued record with a retained real attempt even after only the claim columns are restored", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    const queuedRow = snapshot(storage, (db) =>
      db
        .prepare("SELECT * FROM jobs WHERE job_id = ?")
        .get(candidate.accepted.job.jobId),
    );
    const attempt = storage.store.claimNext("retained-attempt-owner");
    expect(
      attempt !== undefined &&
        attempt.identity.jobId === candidate.accepted.job.jobId,
    ).toBe(true);
    editDatabase(storage, (db) => {
      db.prepare(
        `UPDATE jobs SET status = 'queued', first_started_at = NULL,
        execution_deadline_at = NULL, active_attempt_no = 0, current_fence = 0 WHERE job_id = ?`,
      ).run(candidate.accepted.job.jobId);
    });
    expect(
      snapshot(storage, (db) => {
        const row = db
          .prepare("SELECT * FROM jobs WHERE job_id = ?")
          .get(candidate.accepted.job.jobId);
        const attempts = db
          .prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?")
          .get(candidate.accepted.job.jobId) as { count: number };
        return isDeepStrictEqual(row, queuedRow) && attempts.count === 1;
      }),
    ).toBe(true);
    const inspect = inspector(storage.store);
    const before = facts(storage);
    blocked(
      inspect(storage.principal(), candidate.expected),
      candidate.accepted.job.jobId,
    );
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it("treats the exact queue deadline as reusable and later repeated reads as blocked without expiring or extending the job", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    const inspect = inspector(storage.store);
    storage.setNow(candidate.accepted.job.queueDeadlineAt);
    const before = facts(storage);
    expect(inspect(storage.principal(), candidate.expected).kind).toBe(
      "reusable",
    );
    storage.setNow(candidate.accepted.job.queueDeadlineAt + 1);
    blocked(
      inspect(storage.principal(), candidate.expected),
      candidate.accepted.job.jobId,
    );
    blocked(
      inspect(storage.principal(), candidate.expected),
      candidate.accepted.job.jobId,
    );
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    expect(
      isDeepStrictEqual(
        storage.store.getOwned(
          storage.principal(),
          candidate.accepted.job.jobId,
        ),
        candidate.accepted.job,
      ),
    ).toBe(true);
    expect(storage.store.claimNext("original-expiry-owner") === undefined).toBe(
      true,
    );
    const expired = storage.store.getOwned(
      storage.principal(),
      candidate.accepted.job.jobId,
    );
    expect(
      expired.status === "failed" && expired.reason === "queue_timeout",
    ).toBe(true);
    expect(
      expired.queueDeadlineAt === candidate.accepted.job.queueDeadlineAt,
    ).toBe(true);
    expect(expired.completedAt === storage.clock()).toBe(true);
  });

  it("rejects an already closed Store before any external clock callback", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    let observed = false;
    let calls = 0;
    const store = reopen(storage, () => {
      if (observed) calls++;
      return storage.clock();
    });
    const inspect = inspector(store);
    const principal = storage.principal();
    const before = facts(storage);
    store.close();
    observed = true;
    rejected(() => inspect(principal, candidate.expected), "internal_error", [
      candidate.key,
      candidate.accepted.job.jobId,
    ]);
    expect(calls).toBe(0);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it.each(["acceptQueued", "credential"] as const)(
    "rejects inspection reentered synchronously from a real %s transaction clock before calling clock again",
    async (outer) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      let armed = false;
      let observing = false;
      let calls = 0;
      let nestedReturned = false;
      let nestedFailure: unknown;
      let inspect: ReturnType<typeof inspector>;
      let principal: AuthenticatedClient;
      const store = reopen(storage, () => {
        if (observing) calls++;
        if (armed) {
          armed = false;
          try {
            inspect(principal, candidate.expected);
            nestedReturned = true;
          } catch (error) {
            nestedFailure = error;
          }
          throw new Error("fixture outer transaction rollback");
        }
        return storage.clock();
      });
      principal = storage.principal();
      inspect = inspector(store);
      const before = facts(storage);
      const credentials = snapshot(storage, (db) =>
        db.prepare("SELECT * FROM credentials ORDER BY rowid").all(),
      );
      observing = true;
      armed = true;
      rejected(
        () =>
          outer === "credential"
            ? store.issueCredential("d".repeat(64))
            : store.acceptQueued(
                principal,
                "outer-uncommitted-candidate",
                candidate.expected.request,
                candidate.accepted.job,
                candidate.expected.executionPolicy,
                submissionLimits,
                true,
              ),
        "internal_error",
      );
      observing = false;
      expect(calls).toBe(1);
      expect(nestedReturned).toBe(false);
      expect(
        nestedFailure instanceof EnhancementError &&
          nestedFailure.code === "internal_error",
      ).toBe(true);
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
      expect(
        isDeepStrictEqual(
          snapshot(storage, (db) =>
            db.prepare("SELECT * FROM credentials ORDER BY rowid").all(),
          ),
          credentials,
        ),
      ).toBe(true);
    },
  );

  it("rejects a preexisting outer transaction without clock reads or savepoint effects", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    let observed = false;
    let calls = 0;
    const { store, db } = reopenWithConnection(storage, () => {
      if (observed) calls++;
      return storage.clock();
    });
    const inspect = inspector(store);
    const principal = storage.principal();
    const before = facts(storage);
    observed = true;
    db.exec("BEGIN");
    try {
      rejected(() => inspect(principal, candidate.expected), "internal_error");
      expect(calls).toBe(0);
      expect(db.inTransaction).toBe(true);
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it.each(["close", "revoke", "replace", "transaction", "throw"] as const)(
    "rechecks after the external clock can %s before publishing a candidate",
    async (mode) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      const marker = "fixture-private-clock-marker";
      let armed = false;
      let effects = 0;
      let active: Database.Database | undefined;
      let principal: AuthenticatedClient;
      let store: EnhancementStore;
      const opened = reopenWithConnection(storage, () => {
        if (armed) {
          armed = false;
          effects++;
          if (mode === "close") store.close();
          if (mode === "revoke")
            revokeCredential(store, principal.credentialId);
          if (mode === "replace")
            rotateCredential(store, {
              clientId: principal.clientId,
              revokeCredentialId: principal.credentialId,
            });
          if (mode === "transaction") active!.exec("BEGIN");
          if (mode === "throw") throw new Error(marker);
        }
        return storage.clock();
      });
      store = opened.store;
      active = opened.db;
      principal = storage.principal();
      const inspect = inspector(store);
      const before = facts(storage);
      armed = true;
      try {
        rejected(
          () => inspect(principal, candidate.expected),
          mode === "revoke" || mode === "replace"
            ? "authentication_failed"
            : "internal_error",
          [
            marker,
            storage.directory,
            candidate.key,
            candidate.accepted.job.jobId,
            principal.clientId,
          ],
        );
        expect(effects).toBe(1);
        if (mode === "transaction") expect(active.inTransaction).toBe(true);
      } finally {
        if (active.open && active.inTransaction) active.exec("ROLLBACK");
      }
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    },
  );

  it.each(["close", "revoke", "replace", "throw"] as const)(
    "rechecks the final exit when an expected deep-comparison getter can %s",
    async (mode) => {
      const storage = await fixture();
      const candidate = await queued(storage);
      const { store, db } = reopenWithConnection(storage);
      const inspect = inspector(store);
      const principal = storage.principal();
      const before = facts(storage);
      const marker = "fixture-private-comparison-marker";
      const expected = structuredClone(candidate.expected);
      const value = expected.plan.engine.binaryVersion;
      const transactions: boolean[] = [];
      let effects = 0;
      Object.defineProperty(expected.plan.engine, "binaryVersion", {
        enumerable: true,
        configurable: true,
        get() {
          transactions.push(db.inTransaction);
          if (effects === 0) {
            effects++;
            if (mode === "close") {
              try {
                store.close();
              } catch {
                /* the closed flag still seals the final exit */
              }
            }
            if (mode === "revoke")
              revokeCredential(store, principal.credentialId);
            if (mode === "replace")
              rotateCredential(store, {
                clientId: principal.clientId,
                revokeCredentialId: principal.credentialId,
              });
            if (mode === "throw") throw new Error(marker);
          }
          return value;
        },
      });
      rejected(
        () => inspect(principal, expected),
        mode === "revoke" || mode === "replace"
          ? "authentication_failed"
          : "internal_error",
        [
          marker,
          storage.directory,
          candidate.key,
          candidate.accepted.job.jobId,
          principal.clientId,
        ],
      );
      expect(effects).toBe(1);
      expect(transactions.length > 0 && transactions.every(Boolean)).toBe(true);
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    },
  );

  it("preserves the safe-integer clock contract without writing or returning a queued candidate", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    let override: number | undefined;
    const store = reopen(storage, () => override ?? storage.clock());
    const inspect = inspector(store);
    const principal = storage.principal();
    const before = facts(storage);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      override = value;
      rejected(
        () => inspect(principal, candidate.expected),
        "configuration_invalid",
      );
    }
    override = undefined;
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it("sanitizes a marked invalid persisted JSON read instead of converting it to absent", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    const marker = "fixture-private-json-marker";
    editDatabase(storage, (db) => {
      db.prepare("UPDATE jobs SET plan_json = ? WHERE job_id = ?").run(
        `{"${marker}":`,
        candidate.accepted.job.jobId,
      );
    });
    const inspect = inspector(storage.store);
    const before = facts(storage);
    rejected(
      () => inspect(storage.principal(), candidate.expected),
      "internal_error",
      [marker, storage.directory, candidate.key, candidate.accepted.job.jobId],
    );
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it("sanitizes a marked real-connection read fault and a closed underlying connection", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    const { store, db } = reopenWithConnection(storage);
    const inspect = inspector(store);
    const principal = storage.principal();
    const before = facts(storage);
    const marker = "fixture-private-read-marker";
    const prepare = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error(marker);
    });
    try {
      rejected(() => inspect(principal, candidate.expected), "internal_error", [
        marker,
        storage.directory,
        candidate.key,
        candidate.accepted.job.jobId,
      ]);
    } finally {
      prepare.mockRestore();
    }
    db.close();
    expect(store.closed).toBe(false);
    rejected(() => inspect(principal, candidate.expected), "internal_error", [
      storage.directory,
      candidate.key,
      candidate.accepted.job.jobId,
    ]);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it("rejects malformed shallow envelopes before clock or writes while accepting plain typed data", async () => {
    const storage = await fixture();
    const candidate = await queued(storage);
    let observe = false;
    let clocks = 0;
    const store = reopen(storage, () => {
      if (observe) clocks++;
      return storage.clock();
    });
    const inspect = inspector(store);
    const principal = storage.principal();
    const before = facts(storage);
    const plain = structuredClone(candidate.expected);
    const { source: _source, ...missing } = plain;
    const invalid: unknown[] = [
      null,
      [],
      Object.assign(Object.create(null) as object, plain),
      Object.assign(new (class ExpectedInstance {})(), plain),
      missing,
      { ...plain, extra: true },
      { ...plain, [Symbol("extra")]: true },
    ];
    for (const field of [
      "request",
      "plan",
      "executionPolicy",
      "source",
    ] as const) {
      for (const value of [
        null,
        [],
        Object.assign(Object.create(null) as object, plain[field]),
        Object.assign(new (class RecordInstance {})(), plain[field]),
      ]) {
        invalid.push({ ...plain, [field]: value });
      }
    }
    observe = true;
    for (const value of invalid)
      rejected(() => inspect(principal, value), "invalid_request");
    expect(clocks).toBe(0);
    expect(inspect(principal, plain).kind).toBe("reusable");
    expect(clocks).toBe(1);
    observe = false;
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });
});
