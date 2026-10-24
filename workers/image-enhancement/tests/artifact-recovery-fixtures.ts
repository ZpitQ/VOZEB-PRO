import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createArtifacts,
  type ArtifactCandidate,
  type ArtifactWork,
  type ArtifactWorkKey,
  type ArtifactVerdict,
} from "../src/artifacts.js";
import type { AttemptIdentity, ClaimedAttempt } from "../src/execution.js";
import { openStore, type EnhancementStore } from "../src/store.js";
import {
  artifactFixture,
  type ArtifactFileEvent,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import {
  artifactJobRows,
  traceArtifactCommit,
} from "./artifact-fault-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import { sha256 } from "./storage-fixtures.js";

type RecoveryStoreHooks = {
  afterSucceeded?: (key: ArtifactWorkKey, candidateId: string) => void;
  afterReleased?: (key: ArtifactWorkKey) => void;
};

function traceRecoveryStore(f: ArtifactFixture, store: EnhancementStore) {
  const sequence: {
    method: string;
    referenceId?: string;
    purpose?: "run" | "recovery";
  }[] = [];
  const hooks: RecoveryStoreHooks = {};
  function mark(
    method: string,
    key?: ArtifactWorkKey,
    purpose?: "run" | "recovery",
  ) {
    sequence.push({
      method,
      ...(key ? { referenceId: key.referenceId } : {}),
      ...(purpose ? { purpose } : {}),
    });
    return { order: sequence.length - 1, fileEventIndex: f.events.length };
  }
  const acquisition = traceArtifactCommit(
    store.acquireArtifactWork.bind(store),
    (_publisher, purpose) => mark("acquire", undefined, purpose),
  );
  const readWork = traceArtifactCommit(
    store.readArtifactWork.bind(store),
    (key) => mark("readWork", key),
  );
  const reserve = traceArtifactCommit(
    store.reserveArtifactCandidate.bind(store),
    (key) => mark("reserve", key),
  );
  const durable = traceArtifactCommit(
    store.recordArtifactCandidate.bind(store),
    (key) => mark("durable", key),
  );
  const observation = traceArtifactCommit(
    store.recordArtifactObservation.bind(store),
    (key) => mark("observation", key),
  );
  const successCommits: {
    key: ArtifactWorkKey;
    candidateId: string;
    result: boolean;
    rows: ReturnType<typeof artifactJobRows>;
  }[] = [];
  const originalSuccess = store.finishSucceeded.bind(store);
  const success = traceArtifactCommit(
    (key: ArtifactWorkKey, candidateId: string) => {
      const result = originalSuccess(key, candidateId);
      successCommits.push({
        key,
        candidateId,
        result,
        rows: artifactJobRows(f, key.publisher.jobId),
      });
      if (result) hooks.afterSucceeded?.(key, candidateId);
      return result;
    },
    (key) => mark("success", key),
  );
  const releaseCommits: {
    key: ArtifactWorkKey;
    result: boolean;
    rows: ReturnType<typeof artifactJobRows>;
  }[] = [];
  const originalRelease = store.releaseArtifactReference.bind(store);
  const release = traceArtifactCommit(
    (key: ArtifactWorkKey) => {
      const result = originalRelease(key);
      releaseCommits.push({
        key,
        result,
        rows: artifactJobRows(f, key.publisher.jobId),
      });
      if (result) hooks.afterReleased?.(key);
      return result;
    },
    (key) => mark("release", key),
  );
  const readReference = traceArtifactCommit(
    store.readArtifactReference.bind(store),
    (key) => mark("readReference", key),
  );
  store.acquireArtifactWork = acquisition.invoke;
  store.readArtifactWork = readWork.invoke;
  store.reserveArtifactCandidate = reserve.invoke;
  store.recordArtifactCandidate = durable.invoke;
  store.recordArtifactObservation = observation.invoke;
  store.finishSucceeded = success.invoke;
  store.releaseArtifactReference = release.invoke;
  store.readArtifactReference = readReference.invoke;
  return {
    sequence,
    hooks,
    acquisition,
    readWork,
    reserve,
    durable,
    observation,
    success,
    successCommits,
    release,
    releaseCommits,
    readReference,
  };
}

export async function artifactRecoveryFixture() {
  const base = await artifactFixture();
  const modules = new Map<
    EnhancementStore,
    ReturnType<typeof createArtifacts>
  >();
  const traces = new Map<
    EnhancementStore,
    ReturnType<typeof traceRecoveryStore>
  >();
  const pending: Promise<ArtifactVerdict>[] = [];
  const gates: ReturnType<ArtifactFixture["gate"]>[] = [];
  function trace() {
    const store = base.storage.store;
    let value = traces.get(store);
    if (!value) {
      value = traceRecoveryStore(base, store);
      traces.set(store, value);
    }
    return value;
  }
  return {
    ...base,
    trace,
    gate(
      predicate: (event: ArtifactFileEvent) => boolean,
      phase: "before" | "after" = "after",
    ) {
      const gate = base.gate(predicate, phase);
      gates.push(gate);
      return gate;
    },
    settle(
      target: ClaimedAttempt | AttemptIdentity,
      purpose: "run" | "recovery" = "run",
    ) {
      const store = base.storage.store;
      trace();
      let module = modules.get(store);
      if (!module) {
        module = createArtifacts({ store, files: base.files });
        modules.set(store, module);
      }
      const publisher = "identity" in target ? target.identity : target;
      const work = module.settle(publisher, purpose, base.controller.signal);
      pending.push(work);
      return work;
    },
    reopen() {
      const oldStore = base.storage.store;
      oldStore.close();
      base.storage.setStore(
        openStore({
          directory: base.storage.directory,
          clock: base.storage.clock,
        }),
      );
      assert.notEqual(base.storage.store, oldStore);
      assert.equal(oldStore.closed, true);
      return oldStore;
    },
    async cleanup() {
      base.controller.abort();
      for (const gate of gates) gate.release();
      await Promise.allSettled(pending);
      await base.cleanup();
    },
  };
}

export type ArtifactRecoveryFixture = Awaited<
  ReturnType<typeof artifactRecoveryFixture>
>;

export async function transferArtifactPublisher(
  f: ArtifactRecoveryFixture,
  attempt: ClaimedAttempt,
  owner = "artifact-recovery-publisher",
) {
  const session = f.storage.store.beginRecovery(owner);
  assert.ok(session);
  assert.deepEqual(session.target, {
    identity: attempt.identity,
    launchTicket: attempt.launchTicket,
  });
  const inspection = await f.executor.adapter.inspect(
    session.target,
    session.active.ownerDescriptor,
  );
  assert.equal(inspection.kind, "tree-exited");
  const resolution = f.storage.store.applyRecoveryInspection(
    session.control,
    inspection,
  );
  assert.ok(resolution?.kind === "transferred");
  assert.equal(resolution.startupEventId, null);
  assert.equal(resolution.publisher.attemptNo, attempt.identity.attemptNo);
  assert.equal(resolution.publisher.jobId, attempt.identity.jobId);
  return resolution.publisher;
}

export function artifactSourceFacts(f: ArtifactRecoveryFixture, jobId: string) {
  return snapshot(f.storage, (db) => ({
    job: db
      .prepare(
        `SELECT source_json, engine_json, plan_json, execution_policy_json,
          first_started_at, execution_deadline_at, active_attempt_no
         FROM jobs WHERE job_id = ?`,
      )
      .get(jobId),
    attempts: db
      .prepare(
        `SELECT attempt_no, producer_identity_json, producer_incarnation_id,
          launch_ticket, run_directory, tile, owner_descriptor_json,
          prepared_at, authorized_at, exit_json, exit_observed_at, sealed_at
         FROM attempts WHERE job_id = ? ORDER BY attempt_no`,
      )
      .all(jobId),
    recoveryEvents: db
      .prepare("SELECT * FROM recovery_events WHERE job_id = ? ORDER BY rowid")
      .all(jobId),
  }));
}

export async function candidateDirectoryBytes(candidate: ArtifactCandidate) {
  const names = (await readdir(candidate.directory)).sort();
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(candidate.directory, name));
      return { name, bytes, sha256: sha256(bytes) };
    }),
  );
}

export function candidateFromWork(work: ArtifactWork | undefined) {
  assert.ok(work?.candidate);
  return work.candidate;
}

export function changedArtifactBytes(bytes: Buffer) {
  assert.ok(bytes.length > 0);
  const changed = Buffer.from(bytes);
  const last = changed.length - 1;
  changed[last] = changed[last]! ^ 1;
  assert.equal(changed.length, bytes.length);
  assert.notDeepEqual(changed, bytes);
  return changed;
}

export function completedEvents(f: ArtifactRecoveryFixture, start = 0) {
  return f.events.slice(start).filter(({ phase }) => phase === "after");
}

export function writableEvents(f: ArtifactRecoveryFixture, start = 0) {
  return f.events
    .slice(start)
    .filter(
      ({ event }) =>
        event.flags === "wx" ||
        event.stage === "mkdir" ||
        event.stage === "write" ||
        event.stage === "rename",
    );
}

export function readWorksWith(
  f: ArtifactRecoveryFixture,
  referenceId: string,
  code: string,
  callLimit = f.trace().readWork.calls.length,
) {
  return f
    .trace()
    .readWork.calls.slice(0, callLimit)
    .filter(
      ({ args, result }) =>
        args[0].referenceId === referenceId &&
        result !== undefined &&
        result.kind !== "retired" &&
        result.work.observations.some(
          (observation) => observation.code === code,
        ),
    );
}
