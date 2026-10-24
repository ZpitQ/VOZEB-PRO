import assert from "node:assert/strict";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import sharp from "sharp";

import {
  createArtifacts,
  localArtifactFiles,
  type ArtifactFile,
  type ArtifactFiles,
  type ArtifactIoStage,
  type ArtifactVerdict,
  type ArtifactWork,
} from "../src/artifacts.js";
import type { ClaimedAttempt } from "../src/execution.js";
import { completionExit } from "./completion-fixtures.js";
import { deferred } from "./http-fixtures.js";
import { fixtureSendGuard } from "./execution-send-permission-fixtures.js";
import { manualClock, snapshot } from "./lifecycle-fixtures.js";
import { recoveryExecutor } from "./recovery-fixtures.js";
import { sourceImage, storageFixture, submission } from "./storage-fixtures.js";

export type ArtifactFileRole =
  | "engine"
  | "raw-output"
  | "artifact-part"
  | "manifest-part"
  | "candidate-png"
  | "candidate-manifest"
  | "candidate-directory"
  | "parent-directory";
export type ArtifactFileEvent = Readonly<{
  stage: ArtifactIoStage | "unlink";
  role: ArtifactFileRole;
  path: string;
  to?: string;
  flags?: "r" | "r+" | "wx";
  file?: ArtifactFile;
  buffer?: Buffer;
  offset?: number;
  length?: number;
  position?: number;
  bytesRead?: number;
  bytesWritten?: number;
}>;
export type ArtifactCandidateRow = {
  candidate_id: string;
  job_id: string;
  attempt_no: number;
  directory: string;
  manifest_json: string;
  manifest_sha256: string;
  manifest_byte_length: number;
  state: "intent" | "durable";
  durable_at: number | null;
};
export type ArtifactReferenceRow = {
  reference_id: string;
  job_id: string;
  attempt_no: number;
  publisher_identity_json: string;
  candidate_id: string | null;
  purpose: "run" | "recovery";
  released_at: number | null;
};
export type ArtifactObservationRow = {
  reference_id: string;
  candidate_id: string | null;
  code: string;
  stage: string | null;
};

export async function nativePng(
  attempt: ClaimedAttempt,
  options: {
    alpha?: number;
    width?: number;
    height?: number;
    orientation?: number;
    jpeg?: boolean;
  } = {},
) {
  let image = sharp({
    create: {
      width:
        options.width ??
        attempt.job.engineInput.width * attempt.job.plan.engine.nativeScale,
      height:
        options.height ??
        attempt.job.engineInput.height * attempt.job.plan.engine.nativeScale,
      channels: options.alpha === undefined ? 3 : 4,
      background: { r: 34, g: 83, b: 125, alpha: options.alpha ?? 1 },
    },
  });
  image = options.jpeg ? image.jpeg() : image.png();
  if (options.orientation !== undefined)
    image = image.withMetadata({ orientation: options.orientation });
  return image.toBuffer();
}

export async function writeActualFile(
  path: string,
  bytes: Buffer,
  exclusive = true,
) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, exclusive ? "wx" : "w", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

export function artifactGate(predicate: (event: ArtifactFileEvent) => boolean) {
  const reached = deferred<ArtifactFileEvent>();
  const released = deferred<void>();
  let hit = false;
  return {
    reached: reached.promise,
    get hit() {
      return hit;
    },
    release() {
      released.resolve();
    },
    async hook(event: ArtifactFileEvent) {
      if (!hit && predicate(event)) {
        hit = true;
        reached.resolve(event);
        await released.promise;
      }
    },
  };
}

export async function reachedBeforeSettled(
  gate: ReturnType<typeof artifactGate>,
  pending: Promise<ArtifactVerdict>,
) {
  return Promise.race([
    gate.reached,
    pending.then(() => {
      throw new Error(
        "artifact chain settled before the required real I/O stage",
      );
    }),
  ]);
}

export async function artifactFixture() {
  const storage = await storageFixture();
  const time = manualClock(storage);
  const executor = recoveryExecutor();
  const controller = new AbortController();
  const gates: ReturnType<typeof artifactGate>[] = [];
  const pending: Promise<ArtifactVerdict>[] = [];
  const events: { phase: "before" | "after"; event: ArtifactFileEvent }[] = [];
  const failures: { event: ArtifactFileEvent; error: unknown }[] = [];
  const hooks: {
    before?: (event: ArtifactFileEvent) => Promise<void>;
    after?: (event: ArtifactFileEvent) => Promise<void>;
    maxReadLength?: number;
  } = {};
  let attempt: ClaimedAttempt | undefined;
  let module: ReturnType<typeof createArtifacts> | undefined;
  function role(path: string): ArtifactFileRole {
    if (path === attempt?.inputPath) return "engine";
    if (path === attempt?.outputPath) return "raw-output";
    const name = basename(path);
    if (name === "artifact.part.png") return "artifact-part";
    if (name === "manifest.part.json") return "manifest-part";
    if (name === "artifact.png") return "candidate-png";
    if (name === "manifest.json") return "candidate-manifest";
    return basename(dirname(path)) === "artifacts"
      ? "candidate-directory"
      : "parent-directory";
  }
  async function perform<T>(
    event: ArtifactFileEvent,
    operation: () => Promise<T>,
    observe?: (result: T) => Partial<ArtifactFileEvent>,
  ): Promise<T> {
    events.push({ phase: "before", event });
    await hooks.before?.(event);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      failures.push({ event, error });
      throw error;
    }
    const after =
      observe === undefined ? event : { ...event, ...observe(result) };
    events.push({ phase: "after", event: after });
    await hooks.after?.(after);
    return result;
  }
  const files: ArtifactFiles = {
    async open(path, flags, mode) {
      const file = await perform(
        { stage: "open", role: role(path), path, flags },
        () => localArtifactFiles.open(path, flags, mode),
        (result) => ({ file: result }),
      );
      return {
        stat: () =>
          perform({ stage: "stat", role: role(path), path, file }, () =>
            file.stat(),
          ),
        read: (buffer, offset, length, position) => {
          const readLength = Math.min(length, hooks.maxReadLength ?? length);
          return perform(
            {
              stage: "read",
              role: role(path),
              path,
              file,
              buffer,
              offset,
              length: readLength,
              position,
            },
            () => file.read(buffer, offset, readLength, position),
            ({ bytesRead }) => ({ bytesRead }),
          );
        },
        write: (buffer, offset, length, position) =>
          perform(
            {
              stage: "write",
              role: role(path),
              path,
              file,
              buffer,
              offset,
              length,
              position,
            },
            () => file.write(buffer, offset, length, position),
            ({ bytesWritten }) => ({ bytesWritten }),
          ),
        sync: () =>
          perform({ stage: "file_sync", role: role(path), path, file }, () =>
            file.sync(),
          ),
        close: () =>
          perform({ stage: "close", role: role(path), path, file }, () =>
            file.close(),
          ),
      };
    },
    mkdir: (path) =>
      perform({ stage: "mkdir", role: role(path), path }, () =>
        localArtifactFiles.mkdir(path),
      ),
    rename: (path, to) =>
      perform({ stage: "rename", role: role(path), path, to }, () =>
        localArtifactFiles.rename(path, to),
      ),
    unlink: (path) =>
      perform({ stage: "unlink", role: role(path), path }, () =>
        localArtifactFiles.unlink(path),
      ),
    syncDirectory: (path, guard) =>
      perform({ stage: "directory_sync", role: role(path), path }, () =>
        localArtifactFiles.syncDirectory(path, guard),
      ),
  };
  return {
    storage,
    time,
    executor,
    controller,
    hooks,
    files,
    events,
    failures,
    async claim(input?: ReturnType<typeof submission>) {
      const accepted = await storage
        .service()
        .submit(
          storage.principal(),
          input ?? submission(await sourceImage(), "artifact-first"),
        );
      attempt = storage.store.claimNext("artifact-producer");
      assert.ok(attempt);
      assert.equal(attempt.identity.jobId, accepted.job.jobId);
      const owner = await executor.adapter.prepare(
        attempt,
        fixtureSendGuard(() =>
          storage.store.canPrepareAttempt(
            attempt!.identity,
            attempt!.launchTicket,
          ),
        ),
      );
      assert.equal(
        storage.store.registerPrepared(attempt.identity, owner),
        true,
      );
      assert.equal(
        storage.store.authorizeLaunch(attempt.identity, owner),
        true,
      );
      await executor.adapter.authorize(
        attempt,
        owner,
        fixtureSendGuard(() =>
          storage.store.canAuthorizeLaunch(
            attempt!.identity,
            attempt!.launchTicket,
            owner,
          ),
        ),
      );
      return attempt;
    },
    async complete(target: ClaimedAttempt, bytes?: Buffer) {
      if (bytes !== undefined) await writeActualFile(target.outputPath, bytes);
      const exit = completionExit(target, {
        kind: "success",
        exitCode: 0,
        signal: null,
      });
      executor.emit(exit);
      assert.equal(storage.store.registerExit(exit), true);
    },
    gate(
      predicate: (event: ArtifactFileEvent) => boolean,
      phase: "before" | "after" = "after",
    ) {
      const gate = artifactGate(predicate);
      gates.push(gate);
      const previous = hooks[phase];
      hooks[phase] = async (event) => {
        await previous?.(event);
        await gate.hook(event);
      };
      return gate;
    },
    settle(target: ClaimedAttempt) {
      module ??= createArtifacts({ store: storage.store, files });
      const work = module.settle(target.identity, "run", controller.signal);
      pending.push(work);
      return work;
    },
    job(jobId: string) {
      return storage.store.getOwned(storage.principal(), jobId);
    },
    // Called only after a real artifacts entry/stage has run. No fixture setup
    // queries optional new tables before the G2a throw-only behavior is reached.
    rows() {
      return snapshot(storage, (db) => ({
        jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
        attempts: db
          .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
          .all(),
        slot: db.prepare("SELECT * FROM execution_slot").all(),
        candidates: db
          .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
          .all() as ArtifactCandidateRow[],
        references: db
          .prepare("SELECT * FROM artifact_references ORDER BY rowid")
          .all() as ArtifactReferenceRow[],
        observations: db
          .prepare("SELECT * FROM artifact_observations ORDER BY rowid")
          .all() as ArtifactObservationRow[],
      }));
    },
    currentWork(): ArtifactWork {
      const rows = snapshot(
        storage,
        (db) =>
          db
            .prepare(
              "SELECT * FROM artifact_references WHERE released_at IS NULL ORDER BY rowid DESC",
            )
            .all() as ArtifactReferenceRow[],
      );
      const ref = rows[0];
      assert.ok(ref);
      const read = storage.store.readArtifactWork({
        publisher: JSON.parse(ref.publisher_identity_json),
        referenceId: ref.reference_id,
      });
      assert.ok(read.kind === "active");
      return read.work;
    },
    async originalBytes(target: ClaimedAttempt) {
      return readFile(
        join(
          storage.store.inputDirectory,
          target.identity.jobId,
          `original.${target.job.source.format}`,
        ),
      );
    },
    async cleanup() {
      controller.abort();
      for (const gate of gates) gate.release();
      await Promise.allSettled(pending);
      await storage.cleanup();
    },
  };
}

export type ArtifactFixture = Awaited<ReturnType<typeof artifactFixture>>;
