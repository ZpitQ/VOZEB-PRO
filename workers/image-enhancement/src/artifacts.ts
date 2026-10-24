import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { EnhancementError } from "./contracts.js";
import type {
  ActiveAttempt,
  AttemptIdentity,
  ExecutionTarget,
  StartupRecoveryOutcome,
} from "./execution.js";
import {
  inspectImage,
  validateAiOutput,
  type EngineInput,
  type ValidatedAiArtifact,
} from "./image-io.js";
import type { AuthenticatedClient, EnhancementStore } from "./store.js";

export type ArtifactResult = Omit<ValidatedAiArtifact, "bytes">;
export type ArtifactManifest = Readonly<{
  producer: ExecutionTarget;
  planFingerprint: string;
  engineInputSha256: string;
  executionPolicyFingerprint: string;
  tile: number;
  png: ArtifactResult;
}>;
export type ArtifactWorkKey = Readonly<{
  publisher: AttemptIdentity;
  referenceId: string;
}>;
export type ArtifactIoStage =
  | "open"
  | "stat"
  | "read"
  | "mkdir"
  | "write"
  | "file_sync"
  | "close"
  | "rename"
  | "directory_sync"
  | "acquire_commit"
  | "reserve_commit"
  | "candidate_commit"
  | "success_commit"
  | "observation_commit"
  | "release_commit";
export type ArtifactObservation = Readonly<
  | { code: "io_failure"; stage: ArtifactIoStage; candidateId?: string }
  | {
      code:
        | "engine_integrity"
        | "candidate_integrity"
        | "output_invalid"
        | "no_qualified_candidate"
        | "publication_unknown";
      candidateId?: string;
      checkedEngineSha256?: string;
    }
>;
export type ArtifactCandidate = Readonly<{
  candidateId: string;
  state: "intent" | "durable";
  directory: string;
  pngPartPath: string;
  pngPath: string;
  manifestPartPath: string;
  manifestPath: string;
  manifest: ArtifactManifest;
  manifestSha256: string;
  manifestByteLength: number;
}>;
export type ArtifactWork = Readonly<{
  key: ArtifactWorkKey;
  purpose: "run" | "recovery";
  access: "active" | "published";
  attempt: ActiveAttempt;
  enginePath: string;
  outputPath: string;
  candidate: ArtifactCandidate | null;
  observations: readonly ArtifactObservation[];
}>;
export type ArtifactWorkRead =
  | Readonly<{ kind: "active" | "published"; work: ArtifactWork }>
  | Readonly<{ kind: "retired" }>;
export type ArtifactVerdict =
  "succeeded" | "failed" | "blocked" | "stale" | "no-qualified-candidate";
export type ArtifactRecoveryOutcome =
  | Readonly<{ kind: "settled"; verdict: ArtifactVerdict }>
  | Readonly<{ kind: "restarted"; outcome: StartupRecoveryOutcome }>;
export type ArtifactFile = Readonly<{
  stat(): Promise<Readonly<{ size: number; isFile(): boolean }>>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>;
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesWritten: number }>>;
  sync(): Promise<void>;
  close(): Promise<void>;
}>;
export type ArtifactFiles = Readonly<{
  open(
    path: string,
    flags: "r" | "r+" | "wx",
    mode?: number,
  ): Promise<ArtifactFile>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  syncDirectory(path: string, stillCurrent: () => boolean): Promise<void>;
}>;

export const localArtifactFiles: ArtifactFiles = Object.freeze({
  async open(
    path: string,
    flags: "r" | "r+" | "wx",
    mode?: number,
  ): Promise<ArtifactFile> {
    return open(path, flags, mode);
  },
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700 });
  },
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  },
  async unlink(path: string): Promise<void> {
    await unlink(path);
  },
  async syncDirectory(
    path: string,
    stillCurrent: () => boolean,
  ): Promise<void> {
    if (!stillCurrent()) return;
    const directory = await open(
      path,
      process.platform === "win32" ? "r+" : "r",
    );
    try {
      if (!stillCurrent()) return;
      await directory.sync();
      if (!stillCurrent()) return;
    } finally {
      await directory.close();
    }
  },
});

class RetiredArtifactWork extends Error {}
class MissingArtifactFinal extends Error {}

class ArtifactContentFailure extends Error {
  constructor(
    readonly code:
      "engine_integrity" | "output_invalid" | "candidate_integrity",
  ) {
    super(code);
  }
}

class ArtifactIoFailure extends Error {
  constructor(readonly stage: ArtifactIoStage) {
    super("artifact_io_failure");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

export function createArtifacts(
  options: Readonly<{
    store: EnhancementStore;
    files?: ArtifactFiles;
  }>,
) {
  const { store } = options;
  const files = options.files ?? localArtifactFiles;
  type PublishedRead = Readonly<{
    kind: "read-published";
    assertAuthorized(): void;
    capture(artifact: ValidatedAiArtifact): void;
  }>;
  type Flight = Readonly<{
    generation: symbol;
    purpose: "run" | "recovery";
  }> &
    (
      | Readonly<{ mode: "settle"; promise: Promise<ArtifactVerdict> }>
      | Readonly<{ mode: "recover"; promise: Promise<ArtifactRecoveryOutcome> }>
      | Readonly<{
          mode: "read-published";
          promise: Promise<ValidatedAiArtifact>;
        }>
    );
  const inFlight = new Map<string | symbol, Flight>();

  async function run(
    publisher: AttemptIdentity,
    purpose: "run" | "recovery",
    signal: AbortSignal,
    id: string | symbol,
    generation: symbol,
    mode: "settle" | "recover" | PublishedRead,
  ): Promise<ArtifactVerdict | StartupRecoveryOutcome> {
    const publishedRead = typeof mode === "object" ? mode : undefined;
    function ownedGeneration() {
      return (
        !signal.aborted &&
        !store.closed &&
        inFlight.get(id)?.generation === generation
      );
    }
    if (!ownedGeneration()) return "stale";
    if (publishedRead) {
      try {
        publishedRead.assertAuthorized();
      } catch {
        return "stale";
      }
    }
    let work: ArtifactWork;
    try {
      const acquired = store.acquireArtifactWork(publisher, purpose);
      if (!acquired) return "stale";
      work = acquired;
    } catch (error) {
      if (
        publishedRead &&
        error instanceof EnhancementError &&
        error.code === "result_gone"
      )
        throw error;
      // An acquisition failure has no trustworthy reference to annotate.
      return "blocked";
    }
    const opened = new Set<ArtifactFile>();
    // This grant comes only from the acquisition above (or the explicit
    // published acquisition below), never from a consumed key's fact query.
    let access = work.access;
    let retainReference = false;
    let restartRequested = false;
    const publishedKey = work.key;
    const publishedCandidate = work.candidate;
    let publishedGrant = false;
    let releaseAttempted = false;
    let releaseConfirmed = false;

    function refresh(): ArtifactWork {
      if (!ownedGeneration()) throw new RetiredArtifactWork();
      if (publishedRead) {
        if (
          access !== "published" ||
          purpose !== "recovery" ||
          work.purpose !== "recovery" ||
          !publishedCandidate ||
          publishedCandidate.state !== "durable" ||
          !isDeepStrictEqual(publishedKey.publisher, publisher)
        )
          throw new RetiredArtifactWork();
        try {
          publishedRead.assertAuthorized();
        } catch (error) {
          if (
            !(error instanceof EnhancementError) ||
            error.code !== "authentication_failed"
          )
            retainReference = true;
          throw new RetiredArtifactWork();
        }
        try {
          // Published facts remain queryable after release; only this held ref grants I/O.
          const reference = store.readArtifactReference(publishedKey);
          if (reference !== "held") {
            if (reference === "retired") retainReference = true;
            throw new RetiredArtifactWork();
          }
          const read = store.readArtifactWork(publishedKey);
          if (
            read.kind !== "published" ||
            read.work.access !== "published" ||
            read.work.purpose !== "recovery" ||
            read.work.attempt.exit?.completion?.kind !== "success" ||
            !isDeepStrictEqual(read.work.key, publishedKey) ||
            !isDeepStrictEqual(read.work.attempt.identity, publisher) ||
            !isDeepStrictEqual(read.work.candidate, publishedCandidate)
          ) {
            retainReference = true;
            throw new RetiredArtifactWork();
          }
          work = read.work;
          publishedGrant = true;
          return work;
        } catch (error) {
          if (!(error instanceof RetiredArtifactWork)) retainReference = true;
          throw error;
        }
      }
      const read = store.readArtifactWork(work.key);
      if (read.kind === "retired" || read.kind !== access)
        throw new RetiredArtifactWork();
      work = read.work;
      return work;
    }
    function stillCurrent(): boolean {
      try {
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    async function step<T>(
      stage: ArtifactIoStage,
      operation: () => Promise<T>,
    ): Promise<T> {
      refresh();
      try {
        const value = await operation();
        refresh();
        return value;
      } catch (error) {
        if (
          error instanceof RetiredArtifactWork ||
          error instanceof MissingArtifactFinal ||
          error instanceof ArtifactContentFailure ||
          error instanceof ArtifactIoFailure
        )
          throw error;
        if (!stillCurrent()) throw new RetiredArtifactWork();
        throw new ArtifactIoFailure(stage);
      }
    }
    function commit<T>(stage: ArtifactIoStage, operation: () => T): T {
      refresh();
      try {
        return operation();
      } catch {
        throw new ArtifactIoFailure(stage);
      }
    }
    async function closeCurrent(file: ArtifactFile) {
      await step("close", async () => {
        try {
          await file.close();
        } catch (error) {
          if (publishedRead) retainReference = true;
          throw error;
        }
        opened.delete(file);
      });
    }
    async function readBytes(
      path: string,
      maxBytes: number,
      code: "engine_integrity" | "output_invalid" | "candidate_integrity",
      expectedLength?: number,
      retained?: ArtifactFile[],
      flags: "r" | "r+" = "r",
    ): Promise<Buffer> {
      const file = await step("open", async () => {
        try {
          const value = await files.open(path, flags);
          // Register the handle before the post-await permission check, so a
          // late open can only be cleaned up even after this work retires.
          opened.add(value);
          return value;
        } catch (error) {
          if (hasCode(error, "ENOENT")) {
            if (code === "candidate_integrity")
              throw new MissingArtifactFinal();
            throw new ArtifactContentFailure(code);
          }
          throw error;
        }
      });
      const stat = await step("stat", () => file.stat());
      const bound =
        expectedLength === undefined
          ? Math.min(stat.size, maxBytes)
          : Math.min(expectedLength, maxBytes);
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(stat.size) ||
        stat.size <= 0 ||
        !Number.isSafeInteger(bound) ||
        bound <= 0 ||
        stat.size > bound ||
        (expectedLength !== undefined && stat.size !== expectedLength)
      )
        throw new ArtifactContentFailure(code);
      // One extra byte detects growth without following a growing inode. A
      // short read continues; only zero bytes proves EOF for this descriptor.
      const buffer = Buffer.allocUnsafe(bound + 1);
      let position = 0;
      while (position < buffer.length) {
        const length = buffer.length - position;
        const { bytesRead } = await step("read", () =>
          file.read(buffer, position, length, position),
        );
        if (
          !Number.isSafeInteger(bytesRead) ||
          bytesRead < 0 ||
          bytesRead > length
        )
          throw new ArtifactIoFailure("read");
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > bound) throw new ArtifactContentFailure(code);
      }
      if (
        position !== stat.size ||
        (expectedLength !== undefined && position !== expectedLength)
      )
        throw new ArtifactContentFailure(code);
      const bytes = Buffer.from(buffer.subarray(0, position));
      if (retained) retained.push(file);
      else await closeCurrent(file);
      return bytes;
    }
    async function writePart(path: string, bytes: Buffer) {
      const file = await step("open", async () => {
        const value = await files.open(path, "wx", 0o600);
        opened.add(value);
        return value;
      });
      let position = 0;
      while (position < bytes.length) {
        const length = bytes.length - position;
        const { bytesWritten } = await step("write", () =>
          file.write(bytes, position, length, position),
        );
        if (
          !Number.isSafeInteger(bytesWritten) ||
          bytesWritten <= 0 ||
          bytesWritten > length
        )
          throw new ArtifactIoFailure("write");
        position += bytesWritten;
      }
      await step("file_sync", () => file.sync());
      await closeCurrent(file);
    }

    async function readEngine(): Promise<EngineInput> {
      refresh();
      const accepted = work.attempt.job.engineInput;
      const plan = work.attempt.job.plan;
      if (
        accepted.normalizationProfile !== plan.normalizationProfile ||
        plan.sourceSha256 !== work.attempt.job.source.sha256
      )
        throw new ArtifactContentFailure("engine_integrity");
      const engineBytes = await readBytes(
        work.enginePath,
        plan.budgets.ai.maxBytes,
        "engine_integrity",
        accepted.byteLength,
      );
      const engineInfo = await step("read", async () => {
        try {
          return await inspectImage(engineBytes, {
            maxBytes: plan.budgets.ai.maxBytes,
            maxPixels: plan.budgets.input.maxPixels,
          });
        } catch {
          throw new ArtifactContentFailure("engine_integrity");
        }
      });
      if (
        engineInfo.format !== "png" ||
        engineInfo.orientation !== 1 ||
        engineInfo.width !== accepted.width ||
        engineInfo.height !== accepted.height ||
        engineInfo.byteLength !== accepted.byteLength ||
        engineInfo.sha256 !== accepted.sha256
      )
        throw new ArtifactContentFailure("engine_integrity");
      return Object.freeze({
        ...accepted,
        bytes: engineBytes,
      });
    }

    function durableDirectories(candidate: ArtifactCandidate): string[] {
      // Validate the complete chain before emitting any sync. The already
      // durable store root is the outer boundary; no ancestor outside it is used.
      const durableRoot = resolve(dirname(store.inputDirectory));
      const directories: string[] = [];
      let directory = resolve(candidate.directory);
      for (;;) {
        const parentDirectory = dirname(directory);
        if (parentDirectory === directory)
          throw new EnhancementError("internal_error");
        directories.push(directory);
        if (directory === durableRoot) return directories;
        directory = parentDirectory;
      }
    }

    async function syncDirectories(candidate: ArtifactCandidate) {
      for (const directory of durableDirectories(candidate))
        await step("directory_sync", () =>
          files.syncDirectory(directory, stillCurrent),
        );
    }

    function preserveCandidate(candidate: ArtifactCandidate): boolean {
      return (
        candidate.state === "durable" ||
        work.observations.some(
          (observation) =>
            observation.candidateId === candidate.candidateId &&
            (observation.code === "candidate_integrity" ||
              (observation.code === "io_failure" &&
                (observation.stage === "directory_sync" ||
                  observation.stage === "candidate_commit"))),
        )
      );
    }

    function sameResult(
      actual: ArtifactResult,
      expected: ArtifactResult,
    ): boolean {
      return (
        actual.format === expected.format &&
        actual.width === expected.width &&
        actual.height === expected.height &&
        actual.byteLength === expected.byteLength &&
        actual.sha256 === expected.sha256
      );
    }

    async function revalidateCandidate(
      engineInput: EngineInput,
      capture?: (artifact: ValidatedAiArtifact) => void,
    ): Promise<"complete" | "half"> {
      refresh();
      const candidate = work.candidate;
      if (!candidate) throw new EnhancementError("internal_error");
      const validate = async (flags: "r" | "r+") => {
        const retained: ArtifactFile[] = [];
        let png: Buffer | undefined;
        let manifest: Buffer | undefined;
        let artifact: ValidatedAiArtifact | undefined;
        let missing = false;
        try {
          png = await readBytes(
            candidate.pngPath,
            work.attempt.job.plan.budgets.ai.maxBytes,
            "candidate_integrity",
            candidate.manifest.png.byteLength,
            retained,
            flags,
          );
        } catch (error) {
          if (!(error instanceof MissingArtifactFinal)) throw error;
          missing = true;
        }
        try {
          manifest = await readBytes(
            candidate.manifestPath,
            candidate.manifestByteLength,
            "candidate_integrity",
            candidate.manifestByteLength,
            retained,
            flags,
          );
        } catch (error) {
          if (!(error instanceof MissingArtifactFinal)) throw error;
          missing = true;
        }
        if (manifest) {
          const canonical = Buffer.from(
            JSON.stringify(candidate.manifest),
            "utf8",
          );
          if (
            !manifest.equals(canonical) ||
            createHash("sha256").update(manifest).digest("hex") !==
              candidate.manifestSha256
          )
            throw new ArtifactContentFailure("candidate_integrity");
        }
        if (png) {
          const bytes = png;
          const validated = await step("read", async () => {
            try {
              return await validateAiOutput(
                bytes,
                engineInput,
                work.attempt.job.plan,
                candidate.manifest.png.sha256,
              );
            } catch {
              throw new ArtifactContentFailure("candidate_integrity");
            }
          });
          if (!sameResult(validated, candidate.manifest.png))
            throw new ArtifactContentFailure("candidate_integrity");
          if (capture) artifact = validated;
        }
        if (
          missing &&
          (flags === "r+" ||
            access === "published" ||
            preserveCandidate(candidate))
        )
          throw new ArtifactContentFailure("candidate_integrity");
        return { missing, retained, artifact };
      };
      let validated = await validate("r");
      const flush =
        !validated.missing &&
        access === "active" &&
        candidate.state === "intent" &&
        work.attempt.exit?.completion?.kind === "success";
      if (process.platform === "win32" && flush) {
        for (const file of validated.retained) await closeCurrent(file);
        const current = refresh();
        if (
          current.candidate?.candidateId !== candidate.candidateId ||
          current.candidate.state !== "intent" ||
          current.access !== "active" ||
          current.attempt.exit?.completion?.kind !== "success"
        )
          throw new EnhancementError("internal_error");
        // Windows needs write access to flush; validate those exact handles anew.
        validated = await validate("r+");
      }
      // Retain the exact read handles through full decode and manifest checking.
      // A half root and an already-published root remain strictly read-only.
      for (const file of validated.retained) {
        if (flush) await step("file_sync", () => file.sync());
        await closeCurrent(file);
      }
      if (validated.missing) return "half";
      if (flush) {
        await syncDirectories(candidate);
        if (
          !commit("candidate_commit", () =>
            store.recordArtifactCandidate(work.key, candidate.candidateId),
          )
        )
          throw new RetiredArtifactWork();
      }
      if (capture) {
        refresh();
        if (access !== "published" || !validated.artifact)
          throw new ArtifactContentFailure("candidate_integrity");
        capture(validated.artifact);
      }
      return "complete";
    }

    function saveObservation(observation: ArtifactObservation): boolean {
      refresh();
      try {
        if (!store.recordArtifactObservation(work.key, observation))
          return false;
        // Read the committed fact through the real same-source consumer.
        refresh();
        return true;
      } catch {
        // A thrown COMMIT is not proof of rollback or persistence. Query what
        // is real, but retain the reference when this new insert is uncertain.
        retainReference = true;
        if (ownedGeneration()) {
          try {
            store.readArtifactWork(work.key);
          } catch {
            /* preserve uncertainty */
          }
        }
        return false;
      }
    }

    function releaseCompleted(): boolean {
      if (publishedRead) {
        // No issued I/O remains here; cancellation/revocation can still clean its exact grant.
        const cleanupCurrent = () =>
          publishedGrant &&
          !store.closed &&
          inFlight.get(id)?.generation === generation &&
          opened.size === 0 &&
          !retainReference;
        if (!cleanupCurrent()) return false;
        if (releaseAttempted) return releaseConfirmed;
        try {
          if (store.readArtifactReference(publishedKey) !== "held")
            return false;
        } catch {
          retainReference = true;
          return false;
        }
        releaseAttempted = true;
        try {
          releaseConfirmed = store.releaseArtifactReference(publishedKey);
          if (!releaseConfirmed) retainReference = true;
          return releaseConfirmed;
        } catch {
          if (!cleanupCurrent()) return false;
          try {
            releaseConfirmed =
              store.readArtifactReference(publishedKey) === "released";
            if (!releaseConfirmed) retainReference = true;
            return releaseConfirmed;
          } catch {
            retainReference = true;
            return false;
          }
        }
      }
      if (!ownedGeneration() || opened.size !== 0 || retainReference)
        return false;
      try {
        return store.releaseArtifactReference(work.key);
      } catch {
        // The operation is never retried. Only this exact held tuple may explain
        // whether its first release actually COMMITted.
        if (!ownedGeneration()) return false;
        try {
          return store.readArtifactReference(work.key) === "released";
        } catch {
          return false;
        }
      }
    }

    async function prepareRaw(
      engineInput: EngineInput,
    ): Promise<ArtifactVerdict> {
      refresh();
      if (work.attempt.exit?.completion?.kind !== "success")
        return "no-qualified-candidate";
      const plan = work.attempt.job.plan;
      const raw = await readBytes(
        work.outputPath,
        plan.budgets.ai.maxBytes,
        "output_invalid",
      );
      const validated = await step("read", async () => {
        try {
          return await validateAiOutput(raw, engineInput, plan);
        } catch {
          throw new ArtifactContentFailure("output_invalid");
        }
      });
      const { bytes: _validatedBytes, ...pngMetadata } = validated;
      const candidate = commit("reserve_commit", () =>
        store.reserveArtifactCandidate(work.key, pngMetadata),
      );
      if (!candidate || candidate.state !== "intent") return "blocked";
      const parent = dirname(candidate.directory);
      await step("mkdir", async () => {
        try {
          await files.mkdir(parent);
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      });
      // Only this successful, exclusive mkdir grants this invocation a writer.
      await step("mkdir", () => files.mkdir(candidate.directory));
      const manifest = Buffer.from(JSON.stringify(candidate.manifest), "utf8");
      if (manifest.length !== candidate.manifestByteLength)
        throw new EnhancementError("internal_error");
      await writePart(candidate.pngPartPath, validated.bytes);
      await writePart(candidate.manifestPartPath, manifest);
      await step("rename", () =>
        files.rename(candidate.pngPartPath, candidate.pngPath),
      );
      await step("rename", () =>
        files.rename(candidate.manifestPartPath, candidate.manifestPath),
      );
      await syncDirectories(candidate);
      if (
        !commit("candidate_commit", () =>
          store.recordArtifactCandidate(work.key, candidate.candidateId),
        )
      )
        return stillCurrent() ? "blocked" : "stale";
      return publish(candidate.candidateId);
    }

    async function consumePublished(): Promise<ArtifactVerdict> {
      refresh();
      const candidate = work.candidate;
      if (!candidate) return "blocked";
      const engineInput = await readEngine();
      await revalidateCandidate(engineInput, publishedRead?.capture);
      if (publishedRead) refresh();
      return releaseCompleted() ? "succeeded" : "blocked";
    }

    async function publish(candidateId: string): Promise<ArtifactVerdict> {
      // No await or runner advance before this CAS. A pending user_cancel
      // request alone does not outrank the first terminal transaction to COMMIT.
      refresh();
      if (work.attempt.exit?.completion?.kind !== "success")
        return "no-qualified-candidate";
      try {
        if (store.finishSucceeded(work.key, candidateId)) return "succeeded";
        return stillCurrent() ? "blocked" : "stale";
      } catch {
        if (!ownedGeneration()) throw new RetiredArtifactWork();
        let read: ArtifactWorkRead;
        try {
          read = store.readArtifactWork(work.key);
        } catch {
          retainReference = true;
          return "blocked";
        }
        if (read.kind !== "published")
          throw new ArtifactIoFailure("success_commit");
        if (read.work.candidate?.candidateId !== candidateId) {
          retainReference = true;
          return "blocked";
        }
        // A query of the consumed success key does not grant I/O. Acquire a new,
        // held recovery ref bound to the original durable result before reading.
        let acquired: ArtifactWork | undefined;
        try {
          acquired = store.acquireArtifactWork(publisher, "recovery");
        } catch {
          retainReference = true;
          return "blocked";
        }
        if (
          !acquired ||
          acquired.access !== "published" ||
          acquired.purpose !== "recovery" ||
          acquired.candidate?.candidateId !== candidateId
        )
          return "blocked";
        work = acquired;
        access = "published";
        if (!saveObservation({ code: "publication_unknown", candidateId }))
          return "blocked";
        return consumePublished();
      }
    }

    async function execute(): Promise<ArtifactVerdict> {
      refresh();
      if (publishedRead)
        return access === "published" ? consumePublished() : "blocked";
      if (access === "published") return consumePublished();
      const interrupted = work.attempt.exit?.completion?.kind === "interrupted";
      if (interrupted && mode !== "recover") return "no-qualified-candidate";
      const engineInput = await readEngine();
      if (interrupted) {
        // This is a read-only candidate check. An interrupted producer has no
        // success grant, including when the complete PNG happens to be valid.
        const candidateId = work.candidate?.candidateId;
        if (work.candidate) await revalidateCandidate(engineInput);
        if (
          !saveObservation({
            code: "no_qualified_candidate",
            ...(candidateId === undefined ? {} : { candidateId }),
            checkedEngineSha256: engineInput.sha256,
          })
        )
          return "blocked";
        restartRequested = true;
        return "no-qualified-candidate";
      }
      if (work.candidate) {
        const candidateId = work.candidate.candidateId;
        if ((await revalidateCandidate(engineInput)) === "complete")
          return publish(candidateId);
        if (
          !saveObservation({
            code: "no_qualified_candidate",
            candidateId,
            checkedEngineSha256: engineInput.sha256,
          })
        )
          return "blocked";
        if (!releaseCompleted()) return "blocked";
        // Exactly one checked half-root may become one fresh storage chain.
        // A new ref is mandatory; an old candidate/ref is never rebound.
        if (!ownedGeneration()) throw new RetiredArtifactWork();
        let fresh: ArtifactWork | undefined;
        try {
          fresh = store.acquireArtifactWork(publisher, purpose);
        } catch {
          return "blocked";
        }
        if (!fresh || fresh.access !== "active" || fresh.candidate !== null)
          return "blocked";
        work = fresh;
        access = "active";
      }
      return prepareRaw(engineInput);
    }

    let verdict: ArtifactVerdict | undefined;
    let failure: unknown;
    try {
      verdict = await execute();
    } catch (error) {
      failure = error;
    }

    // Finish every issued I/O and close before recording a diagnostic or ending
    // a reference. Retirement permits only cleanup of already-open handles.
    let closeFailed = false;
    for (const file of opened) {
      try {
        await file.close();
      } catch {
        closeFailed = true;
      } finally {
        opened.delete(file);
      }
    }
    if (closeFailed) {
      retainReference = true;
      failure = new ArtifactIoFailure("close");
    }
    if (publishedRead) {
      if (failure !== undefined && !retainReference && stillCurrent()) {
        const associated = work.candidate
          ? { candidateId: work.candidate.candidateId }
          : {};
        const observation: ArtifactObservation | undefined =
          failure instanceof ArtifactContentFailure
            ? { code: failure.code, ...associated }
            : failure instanceof ArtifactIoFailure
              ? { code: "io_failure", stage: failure.stage, ...associated }
              : undefined;
        if (observation) saveObservation(observation);
      }
      const released = releaseCompleted();
      return failure === undefined && verdict === "succeeded" && released
        ? "succeeded"
        : "blocked";
    }
    if (
      failure instanceof RetiredArtifactWork ||
      verdict === "stale" ||
      (failure !== undefined && !stillCurrent())
    ) {
      // readWork deliberately gives no I/O permission to a cancelled terminal.
      // Once issued operations and closes finish, query only this exact holder
      // to distinguish that normal terminal from control/incarnation retirement.
      if (ownedGeneration() && !retainReference) {
        try {
          if (store.readArtifactReference(work.key) === "held")
            releaseCompleted();
        } catch {
          /* a failed fact query preserves the unknown reference */
        }
      }
      return "stale";
    }
    if (failure === undefined) {
      if (mode === "recover" && restartRequested) {
        // The same ref remains held across all reader awaits. No old-key
        // refresh or release follows a committed replacement receipt.
        retainReference = true;
        if (!ownedGeneration() || !stillCurrent()) return "stale";
        try {
          const outcome = await store.restartInterruptedAttempt(
            work.key,
            signal,
          );
          if (outcome) return outcome;
          return ownedGeneration() ? "no-qualified-candidate" : "stale";
        } catch {
          return ownedGeneration() ? "blocked" : "stale";
        }
      }
      return verdict ?? "blocked";
    }
    const associated = work.candidate
      ? { candidateId: work.candidate.candidateId }
      : {};
    const observation: ArtifactObservation | undefined =
      failure instanceof ArtifactContentFailure
        ? { code: failure.code, ...associated }
        : failure instanceof ArtifactIoFailure
          ? { code: "io_failure", stage: failure.stage, ...associated }
          : undefined;
    if (!observation || !saveObservation(observation)) return "blocked";
    if (access === "published") {
      releaseCompleted();
      return "blocked";
    }
    if (observation.code === "output_invalid") {
      try {
        return store.finishFailed(publisher, work.key)
          ? "failed"
          : stillCurrent()
            ? "blocked"
            : "stale";
      } catch {
        return "blocked";
      }
    }
    return "blocked";
  }

  return Object.freeze({
    async cleanupAcknowledgedResult(
      principal: AuthenticatedClient,
      jobId: string,
      retentionMs: number,
      signal?: AbortSignal,
    ): Promise<
      Readonly<{
        state:
          | "awaiting_receipt"
          | "retention_pending"
          | "reference_held"
          | "pending"
          | "complete";
      }>
    > {
      const outcome = store.retireResult(principal, jobId, retentionMs, signal);
      if (outcome.kind === "blocked") {
        const state = outcome.inspection.state;
        if (state === "eligible") throw new EnhancementError("internal_error");
        return Object.freeze({ state });
      }
      const { work, retirement } = outcome;
      if (!work)
        return Object.freeze({
          state: retirement.cleanedAt === null ? "pending" : "complete",
        });
      try {
        store.assertResultCleanupWork(work, signal);
        await files.unlink(work.pngPath);
        store.assertResultCleanupWork(work, signal);
        await files.unlink(work.manifestPath);
        store.assertResultCleanupWork(work, signal);
        await files.syncDirectory(work.directory, () => {
          store.assertResultCleanupWork(work, signal);
          return true;
        });
        store.assertResultCleanupWork(work, signal);
        store.completeResultCleanup(work, signal);
        return Object.freeze({ state: "complete" });
      } catch {
        return Object.freeze({ state: "pending" });
      }
    },
    async readPublished(
      principal: AuthenticatedClient,
      jobId: string,
      signal: AbortSignal,
    ): Promise<ValidatedAiArtifact> {
      if (store.closed || signal.aborted)
        throw new EnhancementError("internal_error");
      const publisher = store.getPublishedResultPublisher(principal, jobId);
      const id = Symbol("artifact-published-read");
      const generation = Symbol("artifact-published-generation");
      let captured: ValidatedAiArtifact | undefined;
      const readMode: PublishedRead = Object.freeze({
        kind: "read-published",
        assertAuthorized() {
          store.assertPrincipal(principal);
        },
        capture(artifact: ValidatedAiArtifact) {
          captured = artifact;
        },
      });
      const promise: Promise<ValidatedAiArtifact> = Promise.resolve()
        .then(() =>
          run(publisher, "recovery", signal, id, generation, readMode),
        )
        .then((result) => {
          if (
            result !== "succeeded" ||
            !captured ||
            store.closed ||
            signal.aborted
          )
            throw new EnhancementError("internal_error");
          store.assertPrincipal(principal);
          return captured;
        })
        .catch((error: unknown) => {
          if (error instanceof EnhancementError && error.code === "result_gone")
            throw error;
          throw new EnhancementError("internal_error");
        })
        .finally(() => {
          if (inFlight.get(id)?.generation === generation) inFlight.delete(id);
        });
      inFlight.set(id, {
        mode: "read-published",
        purpose: "recovery",
        generation,
        promise,
      });
      return promise;
    },
    recover(
      publisher: AttemptIdentity,
      signal: AbortSignal,
    ): Promise<ArtifactRecoveryOutcome> {
      const frozen = Object.freeze({ ...publisher });
      const id = JSON.stringify([
        frozen.jobId,
        frozen.attemptNo,
        frozen.ownerInstanceId,
        frozen.fence,
      ]);
      const existing = inFlight.get(id);
      if (existing)
        return existing.mode === "recover" && existing.purpose === "recovery"
          ? existing.promise
          : Promise.resolve(
              Object.freeze({ kind: "settled", verdict: "stale" }),
            );
      if (signal.aborted || store.closed)
        return Promise.resolve(
          Object.freeze({ kind: "settled", verdict: "stale" }),
        );
      const generation = Symbol("artifact-recovery");
      const promise: Promise<ArtifactRecoveryOutcome> = Promise.resolve()
        .then(() => run(frozen, "recovery", signal, id, generation, "recover"))
        .then((result): ArtifactRecoveryOutcome =>
          typeof result === "string"
            ? Object.freeze({ kind: "settled", verdict: result })
            : Object.freeze({ kind: "restarted", outcome: result }),
        )
        .finally(() => {
          if (inFlight.get(id)?.generation === generation) inFlight.delete(id);
        });
      inFlight.set(id, {
        mode: "recover",
        purpose: "recovery",
        generation,
        promise,
      });
      return promise;
    },
    settle(
      publisher: AttemptIdentity,
      purpose: "run" | "recovery",
      signal: AbortSignal,
    ): Promise<ArtifactVerdict> {
      const frozen = Object.freeze({ ...publisher });
      const id = JSON.stringify([
        frozen.jobId,
        frozen.attemptNo,
        frozen.ownerInstanceId,
        frozen.fence,
      ]);
      const existing = inFlight.get(id);
      if (existing)
        return existing.mode === "settle" && existing.purpose === purpose
          ? existing.promise
          : Promise.resolve("stale");
      if (signal.aborted || store.closed) return Promise.resolve("stale");
      const generation = Symbol("artifact-work");
      const promise: Promise<ArtifactVerdict> = Promise.resolve()
        .then(() => run(frozen, purpose, signal, id, generation, "settle"))
        .then((result) => (typeof result === "string" ? result : "stale"))
        .finally(() => {
          if (inFlight.get(id)?.generation === generation) inFlight.delete(id);
        });
      inFlight.set(id, { mode: "settle", purpose, generation, promise });
      return promise;
    },
  });
}
