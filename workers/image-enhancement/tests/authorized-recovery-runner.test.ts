import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttemptIdentity,
  ClaimedAttempt,
  DurableInterruptionRecords,
  ExecutionExit,
  OwnerDescriptor,
  StartupRecoveryOutcome,
} from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import {
  authorizedRecoveryFixture,
  type AuthorizedRecoveryFixture,
} from "./authorized-recovery-fixtures.js";
import {
  ticketKey,
  type DurableIoEvent,
} from "./authorized-recovery-records.js";
import { deferred } from "./http-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import { target } from "./recovery-fixtures.js";
import { sha256 } from "./storage-fixtures.js";

type JobRow = {
  job_id: string;
  status: string;
  reason: string | null;
  result_candidate_id: string | null;
  source_json: string;
  engine_json: string;
  plan_json: string;
  execution_policy_json: string;
  first_started_at: number | null;
  execution_deadline_at: number | null;
  active_attempt_no: number;
  current_fence: number;
};
type AttemptRow = {
  job_id: string;
  attempt_no: number;
  owner_instance_id: string;
  fence: number;
  lease_expires_at: number;
  producer_identity_json: string;
  producer_incarnation_id: string;
  launch_ticket: string;
  run_directory: string;
  tile: number;
  owner_descriptor_json: string | null;
  prepared_at: number | null;
  authorized_at: number | null;
  exit_json: string | null;
  sealed_at: number | null;
};
type ControlRow = {
  recovery_id: string;
  job_id: string;
  attempt_no: number;
  owner_instance_id: string;
  incarnation_id: string;
  source_incarnation_id: string;
  source_identity_json: string;
  publisher_identity_json: string;
  launch_ticket: string;
  state: string;
  classification: string;
  observed_at: number | null;
  consumed_at: number | null;
};
type EventRow = {
  event_id: string;
  kind: string;
  job_id: string;
  source_identity_json: string;
  launch_ticket: string;
  source_incarnation_id: string;
  recovery_incarnation_id: string;
  interrupted_at: number;
  evidence_json: string | null;
  sealed_at: number | null;
  consumed_publisher_identity_json: string | null;
  replacement_attempt_no: number | null;
  consumed_at: number | null;
};
type ReferenceRow = {
  reference_id: string;
  job_id: string;
  attempt_no: number;
  publisher_identity_json: string;
  incarnation_id: string;
  purpose: string;
  candidate_id: string | null;
  acquired_at: number;
  released_at: number | null;
};
type ObservationRow = {
  reference_id: string;
  observation_no: number;
  candidate_id: string | null;
  code: string;
  checked_engine_sha256: string | null;
};
type Store = AuthorizedRecoveryFixture["storage"]["store"];
type Runner = ReturnType<typeof createRunner>;
type CreatedOutcome = Extract<StartupRecoveryOutcome, { kind: "created" }>;

// Every business assertion reads a copy of the real persisted SQLite bytes.
// SELECT * also preserves columns outside these typed assertion projections.
function rows(f: AuthorizedRecoveryFixture) {
  return snapshot(f.storage, (db) => ({
    jobs: db
      .prepare("SELECT * FROM jobs ORDER BY queue_sequence")
      .all() as JobRow[],
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all() as AttemptRow[],
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all() as ControlRow[],
    events: db
      .prepare("SELECT * FROM recovery_events ORDER BY rowid")
      .all() as EventRow[],
    slot: db.prepare("SELECT * FROM execution_slot").all() as {
      singleton: number;
      job_id: string;
      attempt_no: number;
      fence: number;
    }[],
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all() as ReferenceRow[],
    observations: db
      .prepare(
        "SELECT * FROM artifact_observations ORDER BY reference_id, observation_no",
      )
      .all() as ObservationRow[],
    candidates: db
      .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
      .all(),
    incarnations: db
      .prepare("SELECT * FROM store_incarnations ORDER BY rowid")
      .all(),
  }));
}

type Rows = ReturnType<typeof rows>;
type Harness = {
  f: AuthorizedRecoveryFixture;
  runner(ownerInstanceId: string): Runner;
  track<T>(promise: Promise<T>): Promise<T>;
  releaseOnCleanup(release: () => void): void;
  gate(
    predicate: (event: DurableIoEvent) => boolean,
  ): ReturnType<AuthorizedRecoveryFixture["gate"]>;
  cleanup(): Promise<void>;
};
const fixtures: Harness[] = [];

afterEach(async () => {
  try {
    for (const h of fixtures.splice(0).reverse()) await h.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(): Promise<Harness> {
  const f = await authorizedRecoveryFixture();
  const runners: Runner[] = [];
  const releases: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  const h: Harness = {
    f,
    runner(ownerInstanceId: string) {
      const runner = createRunner({
        store: f.storage.store,
        clock: f.time.clock,
        executor: f.executor.adapter,
        artifactFiles: f.actualFiles,
        ownerInstanceId,
      });
      runners.push(runner);
      return runner;
    },
    track<T>(promise: Promise<T>): Promise<T> {
      pending.push(promise);
      return f.track(promise);
    },
    releaseOnCleanup(release: () => void) {
      releases.push(release);
    },
    gate(predicate: (event: DurableIoEvent) => boolean) {
      const gate = f.gate(predicate);
      releases.push(gate.release);
      return gate;
    },
    async cleanup() {
      // All runners close explicitly; no teardown grants/releases a business ref.
      for (const runner of [...runners].reverse()) await runner.close();
      for (const release of releases) release();
      await Promise.allSettled(pending);
      await f.cleanup();
    },
  };
  fixtures.push(h);
  return h;
}

async function reachedWhilePending<T, Reached>(
  reached: Promise<Reached>,
  pending: Promise<T>,
  stoppedFacts?: () => unknown,
): Promise<Reached> {
  return Promise.race([
    reached,
    pending.then(() => {
      throw new Error(
        "runner recovery settled before the required real controlled stage" +
          (stoppedFacts ? `: ${JSON.stringify(stoppedFacts())}` : ""),
      );
    }),
  ]);
}

function ticketDirectory(
  f: AuthorizedRecoveryFixture,
  attempt: ClaimedAttempt,
) {
  return join(
    f.storage.directory,
    "durable-adapter",
    "tickets",
    ticketKey(target(attempt)),
  );
}

async function ticketDirectories(f: AuthorizedRecoveryFixture) {
  return (
    await readdir(join(f.storage.directory, "durable-adapter", "tickets"))
  ).sort();
}

async function recordBuffers(
  f: AuthorizedRecoveryFixture,
  original: ClaimedAttempt,
) {
  const authorization = await f.executor.recordBytes(
    target(original),
    "authorization",
  );
  const controllerLoss = await f.executor.recordBytes(
    target(original),
    "controller-loss",
  );
  const terminal = await f.executor.recordBytes(target(original), "terminal");
  assert.ok(authorization && authorization.length > 0);
  assert.ok(controllerLoss && controllerLoss.length > 0);
  assert.ok(terminal && terminal.length > 0);
  return { authorization, controllerLoss, terminal };
}

async function interruptedSource(h: Harness, withWaitingJob = false) {
  const { f } = h;
  await f.submit();
  const originalRunner = h.runner("authorized-runner-producer");
  await h.track(originalRunner.wake());
  assert.equal(f.allLaunchCalls.length, 1);
  const original = f.allLaunchCalls[0];
  assert.ok(original);
  let waitingJobId: string | undefined;
  if (withWaitingJob) {
    // Seed only after the original runner really owns the execution slot.
    const waiting = await f.submit("authorized-runner-waiting");
    waitingJobId = waiting.job.jobId;
  }
  const accepted = rows(f);
  const acceptedAttempt = accepted.attempts[0];
  assert.ok(acceptedAttempt && acceptedAttempt.owner_descriptor_json);
  assert.equal(accepted.jobs.length, withWaitingJob ? 2 : 1);
  assert.equal(accepted.attempts.length, 1);
  assert.equal(accepted.events.length, 0);
  assert.equal(accepted.controls.length, 0);
  assert.equal(accepted.references.length, 0);
  assert.notEqual(acceptedAttempt.prepared_at, null);
  assert.notEqual(acceptedAttempt.authorized_at, null);
  assert.equal(acceptedAttempt.exit_json, null);
  assert.equal(acceptedAttempt.sealed_at, null);
  const owner = JSON.parse(
    acceptedAttempt.owner_descriptor_json,
  ) as OwnerDescriptor;
  assert.equal(owner.launchTicket, original.launchTicket);
  assert.deepEqual(accepted.slot, [
    {
      singleton: 1,
      job_id: original.identity.jobId,
      attempt_no: original.identity.attemptNo,
      fence: original.identity.fence,
    },
  ]);
  if (waitingJobId) {
    assert.equal(
      accepted.jobs.find((job) => job.job_id === waitingJobId)?.status,
      "queued",
    );
    assert.equal(
      accepted.attempts.some((attempt) => attempt.job_id === waitingJobId),
      false,
    );
  }

  // close cancels the original runner; only real durable loss proves termination.
  await originalRunner.close();
  assert.deepEqual(f.time.pending(), []);
  const previousFacade = f.executor;
  const previousReader = previousFacade.adapter.readInterruptionEvidence;
  await previousFacade.loseController(target(original));
  await f.reopen();
  assert.equal(previousFacade.retired, true);
  assert.notEqual(f.executor, previousFacade);
  assert.notEqual(f.executor.adapter.readInterruptionEvidence, previousReader);
  assert.equal(f.storage.store.closed, false);

  // Finish these real record reads before the reader takes the ticket queue.
  const buffers = await recordBuffers(f, original);
  const records: DurableInterruptionRecords = {
    authorization: JSON.parse(buffers.authorization.toString("utf8")),
    controllerLoss: JSON.parse(buffers.controllerLoss.toString("utf8")),
    terminal: JSON.parse(buffers.terminal.toString("utf8")),
  };
  for (const record of Object.values(records))
    assert.deepEqual(record.scope, {
      target: target(original),
      descriptor: owner,
    });
  assert.equal(
    records.controllerLoss.authorizationRecordId,
    records.authorization.recordId,
  );
  assert.equal(
    records.terminal.authorizationRecordId,
    records.authorization.recordId,
  );
  assert.equal(
    records.terminal.controllerLossRecordId,
    records.controllerLoss.recordId,
  );
  assert.equal(records.terminal.treeExited, true);
  assert.equal(records.terminal.authorizationsSealed, true);
  assert.equal(
    new Set([
      records.authorization.recordId,
      records.controllerLoss.recordId,
      records.terminal.recordId,
    ]).size,
    3,
  );
  assert.equal(
    f.executor.events.some((event) => event.operation === "reader"),
    false,
  );
  return {
    original,
    owner,
    accepted,
    waitingJobId,
    buffers,
    records,
    ticketDirectories: await ticketDirectories(f),
    originalTicketFiles: (await readdir(ticketDirectory(f, original))).sort(),
  };
}

type Source = Awaited<ReturnType<typeof interruptedSource>>;

function observeRunner(f: AuthorizedRecoveryFixture) {
  const store = f.storage.store;
  // Default spies preserve the real receiver, arguments, result and exception.
  const originalRestart = store.restartInterruptedAttempt;
  return {
    originalRestart,
    begin: vi.spyOn(store, "beginRecovery"),
    inspect: vi.spyOn(f.executor.adapter, "inspect"),
    apply: vi.spyOn(store, "applyRecoveryInspection"),
    acquire: vi.spyOn(store, "acquireArtifactWork"),
    restart: vi.spyOn(store, "restartInterruptedAttempt"),
    reserve: vi.spyOn(store, "reserveArtifactCandidate"),
    getActive: vi.spyOn(store, "getActiveAttempt"),
    claim: vi.spyOn(store, "claimNext"),
    prepare: vi.spyOn(f.executor.adapter, "prepare"),
    registerPrepared: vi.spyOn(store, "registerPrepared"),
    authorizeLaunch: vi.spyOn(store, "authorizeLaunch"),
    observeExit: vi.spyOn(f.executor.adapter, "observeExit"),
    authorize: vi.spyOn(f.executor.adapter, "authorize"),
    renewLease: vi.spyOn(store, "renewLease"),
  };
}

type Probes = ReturnType<typeof observeRunner>;

function readerGate(h: Harness) {
  const marker = h.f.executor.events.length;
  const gate = h.gate(
    (event) =>
      event.operation === "reader" &&
      event.role === "authorization" &&
      event.stage === "read" &&
      event.phase === "after" &&
      (event.bytesRead ?? 0) > 0,
  );
  h.f.executor.hooks.after = gate.hook;
  return { ...gate, marker };
}

function assertNoLaunch(p: Probes, f: AuthorizedRecoveryFixture) {
  assert.equal(p.prepare.mock.calls.length, 0);
  assert.equal(p.registerPrepared.mock.calls.length, 0);
  assert.equal(p.authorizeLaunch.mock.calls.length, 0);
  assert.equal(p.observeExit.mock.calls.length, 0);
  assert.equal(p.authorize.mock.calls.length, 0);
  assert.equal(f.allLaunchCalls.length, 1);
}

async function assertReaderStage(
  f: AuthorizedRecoveryFixture,
  source: Source,
  p: Probes,
  readerMarker: number,
) {
  assert.ok(p.begin.mock.calls.length > 0);
  assert.equal(p.inspect.mock.calls.length, 1);
  assert.equal(p.apply.mock.calls.length, 1);
  assert.equal(p.acquire.mock.calls.length, 1);
  assert.equal(p.restart.mock.calls.length, 1);
  assert.equal(f.restartCalls.length, 1);
  assert.equal(p.reserve.mock.calls.length, 0);
  const inspectionResult = p.inspect.mock.results[0];
  assert.ok(inspectionResult && inspectionResult.type === "return");
  const inspected = await inspectionResult.value;
  assert.equal(inspected.kind, "tree-exited");
  if (inspected.kind !== "tree-exited")
    assert.fail("actual inspection must transfer an interruption");
  assert.deepEqual(p.inspect.mock.calls[0], [
    target(source.original),
    source.owner,
  ]);
  assert.deepEqual(inspected.exit.completion, {
    kind: "interrupted",
    authorizationRecordId: source.records.authorization.recordId,
    controllerLossRecordId: source.records.controllerLoss.recordId,
    terminalRecordId: source.records.terminal.recordId,
  });
  const appliedResult = p.apply.mock.results[0];
  assert.ok(appliedResult && appliedResult.type === "return");
  const moved = appliedResult.value;
  assert.ok(moved && moved.kind === "transferred");
  assert.equal(moved.startupEventId, null);
  const publisher = moved.publisher;
  const baseline = rows(f);
  assert.equal(baseline.attempts.length, 1);
  assert.equal(baseline.events.length, 0);
  assert.equal(baseline.controls.length, 1);
  assert.equal(baseline.references.length, 1);
  assert.equal(baseline.candidates.length, 0);
  const control = baseline.controls[0];
  const originalRow = baseline.attempts[0];
  const acceptedRow = source.accepted.attempts[0];
  assert.ok(control && originalRow && acceptedRow);
  assert.equal(control.state, "consumed");
  assert.equal(control.classification, "tree-exited");
  assert.notEqual(control.observed_at, null);
  assert.notEqual(control.consumed_at, null);
  assert.equal(control.job_id, source.original.identity.jobId);
  assert.equal(control.attempt_no, source.original.identity.attemptNo);
  assert.equal(control.launch_ticket, source.original.launchTicket);
  assert.equal(
    control.source_incarnation_id,
    acceptedRow.producer_incarnation_id,
  );
  assert.notEqual(control.incarnation_id, control.source_incarnation_id);
  assert.deepEqual(
    JSON.parse(control.source_identity_json),
    source.original.identity,
  );
  const prePublisher = JSON.parse(
    control.publisher_identity_json,
  ) as AttemptIdentity;
  assert.deepEqual(prePublisher, source.original.identity);
  assert.deepEqual(publisher, {
    ...prePublisher,
    ownerInstanceId: control.owner_instance_id,
    fence: prePublisher.fence + 1,
  });
  assert.equal(originalRow.owner_instance_id, publisher.ownerInstanceId);
  assert.equal(originalRow.fence, publisher.fence);
  for (const field of [
    "producer_identity_json",
    "producer_incarnation_id",
    "launch_ticket",
    "run_directory",
    "tile",
    "owner_descriptor_json",
    "prepared_at",
    "authorized_at",
  ] as const)
    assert.equal(originalRow[field], acceptedRow[field]);
  assert.equal(originalRow.sealed_at, null);
  assert.ok(originalRow.exit_json);
  assert.deepEqual(
    JSON.parse(originalRow.exit_json) as ExecutionExit,
    inspected.exit,
  );
  assert.deepEqual(baseline.slot, [
    {
      singleton: 1,
      job_id: publisher.jobId,
      attempt_no: publisher.attemptNo,
      fence: publisher.fence,
    },
  ]);

  const call = f.restartCalls[0];
  assert.ok(call);
  assert.equal(call.signal.aborted, false);
  assert.deepEqual(call.key.publisher, publisher);
  assert.deepEqual(p.acquire.mock.calls[0], [publisher, "recovery"]);
  const acquiredResult = p.acquire.mock.results[0];
  assert.ok(
    acquiredResult && acquiredResult.type === "return" && acquiredResult.value,
  );
  assert.deepEqual(acquiredResult.value.key, call.key);
  const held = baseline.references[0];
  assert.ok(held);
  assert.equal(held.reference_id, call.key.referenceId);
  assert.equal(held.released_at, null);
  assert.equal(held.purpose, "recovery");
  assert.equal(held.candidate_id, null);
  assert.equal(held.incarnation_id, control.incarnation_id);
  assert.equal(held.job_id, source.original.identity.jobId);
  assert.equal(held.attempt_no, source.original.identity.attemptNo);
  assert.deepEqual(JSON.parse(held.publisher_identity_json), publisher);
  assert.equal(baseline.observations.length, 1);
  const observation = baseline.observations[0];
  assert.ok(observation);
  assert.equal(observation.reference_id, held.reference_id);
  assert.equal(observation.candidate_id, null);
  assert.equal(observation.code, "no_qualified_candidate");
  assert.equal(
    observation.checked_engine_sha256,
    source.original.job.engineInput.sha256,
  );

  const engineEvents = f.artifactEvents.filter(
    (event) => event.path === source.original.inputPath,
  );
  assert.equal(engineEvents[0]?.stage, "open");
  assert.equal(engineEvents[0]?.flags, "r");
  assert.equal(engineEvents.at(-1)?.stage, "close");
  assert.ok(
    engineEvents.some(
      (event) =>
        event.stage === "stat" &&
        event.size === source.original.job.engineInput.byteLength,
    ),
  );
  let position = 0;
  const chunks: Buffer[] = [];
  for (const event of engineEvents.filter((event) => event.stage === "read")) {
    assert.equal(event.position, position);
    assert.ok(event.bytes);
    assert.equal(event.bytes.length, event.bytesRead);
    chunks.push(event.bytes);
    position += event.bytes.length;
  }
  const engineBytes = Buffer.concat(chunks);
  assert.equal(engineBytes.length, source.original.job.engineInput.byteLength);
  assert.equal(sha256(engineBytes), source.original.job.engineInput.sha256);
  assert.ok(
    f.artifactEvents.every(
      (event) =>
        event.path === source.original.inputPath &&
        ["open", "stat", "read", "close"].includes(event.stage),
    ),
  );
  assert.ok(
    f.executor.events
      .slice(readerMarker)
      .some(
        (event) =>
          event.operation === "reader" &&
          event.role === "authorization" &&
          event.stage === "read" &&
          event.phase === "after" &&
          (event.bytesRead ?? 0) > 0,
      ),
  );
  assertNoLaunch(p, f);
  assert.deepEqual(await ticketDirectories(f), source.ticketDirectories);
  assertWaitingUnclaimed(f, source, baseline);
  return {
    publisher,
    control,
    key: call.key,
    signal: call.signal,
    held,
    baseline,
    readerMarker,
  };
}

type ReaderStage = Awaited<ReturnType<typeof assertReaderStage>>;

function assertWaitingUnclaimed(
  f: AuthorizedRecoveryFixture,
  source: Source,
  facts = rows(f),
) {
  if (!source.waitingJobId) return;
  const waiting = facts.jobs.find((job) => job.job_id === source.waitingJobId);
  assert.ok(waiting);
  assert.equal(waiting.status, "queued");
  assert.deepEqual(
    waiting,
    source.accepted.jobs.find((job) => job.job_id === source.waitingJobId),
  );
  assert.equal(
    facts.attempts.some((attempt) => attempt.job_id === source.waitingJobId),
    false,
  );
  assert.equal(
    f.allLaunchCalls.some(
      (attempt) => attempt.identity.jobId === source.waitingJobId,
    ),
    false,
  );
}

function completeReader(f: AuthorizedRecoveryFixture, marker: number) {
  const events = f.executor.events
    .slice(marker)
    .filter((event) => event.operation === "reader");
  for (const role of [
    "authorization",
    "controller-loss",
    "terminal",
  ] as const) {
    assert.ok(
      events.some(
        (event) =>
          event.role === role &&
          event.stage === "read" &&
          event.phase === "after" &&
          (event.bytesRead ?? 0) > 0,
      ),
    );
    for (const stage of ["file-sync", "close"] as const)
      assert.ok(
        events.some(
          (event) =>
            event.role === role &&
            event.stage === stage &&
            event.phase === "after" &&
            event.cleanup !== true,
        ),
      );
  }
}

function createdReceipt(
  outcome: StartupRecoveryOutcome | undefined,
): CreatedOutcome {
  assert.ok(
    outcome && outcome.kind === "created",
    "the original real restart must COMMIT a created outcome",
  );
  return outcome;
}

function postCommitGate(h: Harness, p: Probes) {
  const reached = deferred<CreatedOutcome>();
  const permission = deferred<void>();
  const release = () => permission.resolve();
  h.releaseOnCleanup(release);
  p.restart.mockImplementation(async function (
    this: Store,
    ...args: Parameters<Store["restartInterruptedAttempt"]>
  ) {
    const outcome = createdReceipt(await p.originalRestart.apply(this, args));
    // The real transaction and reader are over. Return the same object later.
    reached.resolve(outcome);
    await permission.promise;
    return outcome;
  });
  return { reached: reached.promise, release };
}

function assertCommitted(
  f: AuthorizedRecoveryFixture,
  source: Source,
  stage: ReaderStage,
  replacement: ClaimedAttempt,
  launched = false,
) {
  completeReader(f, stage.readerMarker);
  const done = rows(f);
  assert.equal(done.attempts.length, 2);
  assert.equal(done.events.length, 1);
  assert.deepEqual(done.controls, stage.baseline.controls);
  assert.deepEqual(done.observations, stage.baseline.observations);
  assert.deepEqual(done.candidates, []);
  assert.deepEqual(done.incarnations, stage.baseline.incarnations);
  const originalRow = done.attempts.find(
    (row) => row.attempt_no === source.original.identity.attemptNo,
  );
  const replacementRow = done.attempts.find(
    (row) => row.attempt_no === replacement.identity.attemptNo,
  );
  const job = done.jobs.find(
    (row) => row.job_id === source.original.identity.jobId,
  );
  const baselineJob = stage.baseline.jobs.find(
    (row) => row.job_id === source.original.identity.jobId,
  );
  const event = done.events[0];
  assert.ok(originalRow && replacementRow && job && baselineJob && event);
  assert.deepEqual(originalRow, stage.baseline.attempts[0]);
  assert.equal(event.kind, "authorized-interruption");
  assert.equal(event.sealed_at, null);
  assert.equal(event.interrupted_at, f.storage.clock());
  assert.equal(event.consumed_at, f.storage.clock());
  assert.equal(event.job_id, source.original.identity.jobId);
  assert.equal(event.launch_ticket, source.original.launchTicket);
  assert.equal(
    event.source_incarnation_id,
    stage.control.source_incarnation_id,
  );
  assert.equal(event.recovery_incarnation_id, stage.control.incarnation_id);
  assert.deepEqual(
    JSON.parse(event.source_identity_json),
    source.original.identity,
  );
  assert.ok(event.consumed_publisher_identity_json && event.evidence_json);
  assert.deepEqual(
    JSON.parse(event.consumed_publisher_identity_json),
    stage.publisher,
  );
  assert.equal(event.replacement_attempt_no, replacement.identity.attemptNo);
  assert.deepEqual(JSON.parse(event.evidence_json), {
    v: 1,
    recoveryId: stage.control.recovery_id,
    referenceId: stage.key.referenceId,
    records: source.records,
  });
  assert.deepEqual(
    done.references,
    stage.baseline.references.map((reference) =>
      reference.reference_id === stage.key.referenceId
        ? { ...reference, released_at: event.consumed_at }
        : reference,
    ),
  );
  assert.equal(replacement.identity.jobId, source.original.identity.jobId);
  assert.equal(
    replacement.identity.attemptNo,
    source.original.identity.attemptNo + 1,
  );
  assert.equal(
    replacement.identity.ownerInstanceId,
    stage.publisher.ownerInstanceId,
  );
  assert.equal(replacement.identity.fence, stage.publisher.fence + 1);
  assert.ok(Number.isSafeInteger(replacement.identity.attemptNo));
  assert.ok(Number.isSafeInteger(replacement.identity.fence));
  assert.notEqual(replacement.launchTicket, source.original.launchTicket);
  assert.notEqual(
    replacement.workingDirectory,
    source.original.workingDirectory,
  );
  assert.equal(replacement.inputPath, source.original.inputPath);
  assert.equal(replacement.tile, source.original.tile);
  assert.deepEqual(
    replacement.executionPolicy,
    source.original.executionPolicy,
  );
  assert.deepEqual(replacement.job.source, source.original.job.source);
  assert.deepEqual(
    replacement.job.engineInput,
    source.original.job.engineInput,
  );
  assert.deepEqual(replacement.job.plan, source.original.job.plan);
  assert.equal(replacement.firstStartedAt, source.original.firstStartedAt);
  assert.equal(
    replacement.executionDeadlineAt,
    source.original.executionDeadlineAt,
  );
  assert.deepEqual(
    JSON.parse(replacementRow.producer_identity_json),
    replacement.identity,
  );
  assert.equal(
    replacementRow.producer_incarnation_id,
    stage.control.incarnation_id,
  );
  assert.equal(replacementRow.launch_ticket, replacement.launchTicket);
  assert.notEqual(replacementRow.run_directory, originalRow.run_directory);
  assert.equal(new Set(done.attempts.map((row) => row.launch_ticket)).size, 2);
  assert.equal(new Set(done.attempts.map((row) => row.run_directory)).size, 2);
  assert.equal(replacementRow.exit_json, null);
  assert.equal(replacementRow.sealed_at, null);
  if (launched) {
    assert.ok(replacementRow.owner_descriptor_json);
    assert.equal(
      JSON.parse(replacementRow.owner_descriptor_json).launchTicket,
      replacement.launchTicket,
    );
    assert.notEqual(replacementRow.prepared_at, null);
    assert.notEqual(replacementRow.authorized_at, null);
  } else {
    assert.equal(replacementRow.owner_descriptor_json, null);
    assert.equal(replacementRow.prepared_at, null);
    assert.equal(replacementRow.authorized_at, null);
  }
  assert.deepEqual(job, {
    ...baselineJob,
    active_attempt_no: replacement.identity.attemptNo,
    current_fence: replacement.identity.fence,
  });
  const acceptedJob = source.accepted.jobs.find(
    (row) => row.job_id === job.job_id,
  );
  assert.ok(acceptedJob);
  for (const field of [
    "source_json",
    "engine_json",
    "plan_json",
    "execution_policy_json",
    "first_started_at",
    "execution_deadline_at",
  ] as const)
    assert.equal(job[field], acceptedJob[field]);
  assert.equal(job.status, "running");
  assert.equal(job.reason, null);
  assert.equal(job.result_candidate_id, null);
  assert.deepEqual(done.slot, [
    {
      singleton: 1,
      job_id: replacement.identity.jobId,
      attempt_no: replacement.identity.attemptNo,
      fence: replacement.identity.fence,
    },
  ]);
  assertWaitingUnclaimed(f, source, done);
  return done;
}

async function unchangedOriginalRecords(
  f: AuthorizedRecoveryFixture,
  source: Source,
) {
  assert.deepEqual(await recordBuffers(f, source.original), source.buffers);
  assert.deepEqual(
    (await readdir(ticketDirectory(f, source.original))).sort(),
    source.originalTicketFiles,
  );
}

function chainCounts(f: AuthorizedRecoveryFixture, p: Probes) {
  return {
    inspect: p.inspect.mock.calls.length,
    apply: p.apply.mock.calls.length,
    acquire: p.acquire.mock.calls.length,
    restart: p.restart.mock.calls.length,
    actualRestart: f.restartCalls.length,
    reserve: p.reserve.mock.calls.length,
    records: f.executor.events.length,
    artifacts: f.artifactEvents.length,
    starts: f.allLaunchCalls.length,
  };
}

function stableHeartbeatFacts(facts: Rows) {
  return {
    ...facts,
    attempts: facts.attempts.map(
      ({ lease_expires_at: _lease, ...attempt }) => attempt,
    ),
    controls: facts.controls.map(
      ({ observed_at: _observed, ...control }) => control,
    ),
  };
}

describe("real runner authorized interruption recovery", () => {
  it("uses only the current attempt execution interval after a real durable interruption replacement", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h);
    const publicJob = () => f.storage.store.getOwned(f.storage.principal(), source.original.identity.jobId);
    f.storage.setNow(1_900);
    const probes = observeRunner(f);
    const committed = postCommitGate(h, probes);
    const reader = readerGate(h);
    const runner = h.runner("timing-recovery-owner");
    const recovering = h.track(runner.recover());
    await reachedWhilePending(reader.reached, recovering);
    expect(publicJob()).toMatchObject({ timings: { workerQueueMs: 0, workerExecutionMs: 900 } });
    reader.release();
    const created = await reachedWhilePending(committed.reached, recovering);
    expect(created.attempt.identity.attemptNo).toBe(2);
    expect(publicJob()).toMatchObject({ timings: { workerQueueMs: 0 } });
    expect(publicJob()).not.toHaveProperty("timings.workerExecutionMs");
    committed.release();
    await recovering;
    const replacement = f.allLaunchCalls[1];
    assert.ok(replacement);
    expect(publicJob()).not.toHaveProperty("timings.workerExecutionMs");
    f.storage.setNow(2_200);
    await f.executor.finish(target(replacement), { kind: "failure", exitCode: 7, signal: null });
    await h.track(runner.wake());
    expect(publicJob()).toMatchObject({ status: "failed", timings: { workerQueueMs: 0, workerExecutionMs: 300 } });
    const finished = publicJob();
    await runner.close();
    await f.reopen();
    expect(publicJob()).toEqual(finished);
  });

  it("recovers a durably authorized interruption through the real runner and starts only its created replacement once", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h, true);
    const p = observeRunner(f);
    const runner = h.runner("authorized-runner-recovery");
    const gate = readerGate(h);
    const recovering = h.track(runner.recover());
    await reachedWhilePending(gate.reached, recovering, () => {
      const stopped = rows(f);
      return {
        readiness: runner.readiness(),
        inspections: p.inspect.mock.calls.length,
        appliedInspections: p.apply.mock.calls.length,
        artifactAcquisitions: p.acquire.mock.calls.length,
        references: stopped.references.length,
        engineReads: f.artifactEvents.filter((event) => event.stage === "read")
          .length,
        restarts: f.restartCalls.length,
        readerEvents: f.executor.events.filter(
          (event) => event.operation === "reader",
        ).length,
        recoveryEvents: stopped.events.length,
        attempts: stopped.attempts.length,
      };
    });
    const stage = await assertReaderStage(f, source, p, gate.marker);
    const beforeRepeatedWakes = chainCounts(f, p);
    // Keep both promises pending until the shared real reader is released.
    const repeatedRecovery = h.track(runner.recover());
    const ordinaryWake = h.track(runner.wake());
    assert.equal(repeatedRecovery, recovering);
    await Promise.resolve();
    assert.deepEqual(chainCounts(f, p), beforeRepeatedWakes);
    assert.deepEqual(rows(f), stage.baseline);
    gate.release();
    await Promise.all([recovering, repeatedRecovery, ordinaryWake]);
    const replacement = f.allLaunchCalls[1];
    assert.ok(replacement);
    const committed = assertCommitted(f, source, stage, replacement, true);
    assert.equal(p.inspect.mock.calls.length, 1);
    assert.equal(p.apply.mock.calls.length, 1);
    assert.equal(p.acquire.mock.calls.length, 1);
    assert.equal(p.restart.mock.calls.length, 1);
    assert.equal(f.restartCalls.length, 1);
    assert.deepEqual(f.allLaunchCalls, [source.original, replacement]);
    assert.equal(p.prepare.mock.calls.length, 1);
    const prepareCall = p.prepare.mock.calls[0];
    assert.ok(prepareCall);
    assert.equal(prepareCall.length, 2);
    assert.equal(prepareCall[0], replacement);
    const prepareGuard = prepareCall[1];
    assert.ok(prepareGuard);
    assert.equal(Object.isFrozen(prepareGuard), true);
    assert.equal(Reflect.ownKeys(prepareGuard).length, 3);
    assert.deepEqual(Object.keys(prepareGuard).sort(), [
      "signal",
      "stillCurrent",
      "takeSendPermission",
    ]);
    assert.ok(prepareGuard.signal instanceof AbortSignal);
    assert.equal(prepareGuard.signal.aborted, false);
    assert.equal(typeof prepareGuard.stillCurrent, "function");
    assert.equal(typeof prepareGuard.takeSendPermission, "function");
    assert.equal(prepareGuard.stillCurrent(), false);
    assert.equal(prepareGuard.takeSendPermission(), false);
    assert.equal(p.registerPrepared.mock.calls.length, 1);
    assert.equal(p.authorizeLaunch.mock.calls.length, 1);
    assert.equal(p.observeExit.mock.calls.length, 1);
    assert.equal(p.authorize.mock.calls.length, 1);
    assert.equal(p.authorize.mock.calls[0]?.[0], replacement);
    const order = [
      p.prepare,
      p.registerPrepared,
      p.authorizeLaunch,
      p.observeExit,
      p.authorize,
    ].map((probe) => probe.mock.invocationCallOrder[0]);
    assert.ok(order.every((value) => value !== undefined));
    for (let index = 1; index < order.length; index++)
      assert.ok(order[index - 1]! < order[index]!);
    assert.deepEqual(
      await ticketDirectories(f),
      [
        ticketKey(target(source.original)),
        ticketKey(target(replacement)),
      ].sort(),
    );
    const beforeWake = chainCounts(f, p);
    await h.track(runner.wake());
    await h.track(runner.wake());
    assert.deepEqual(chainCounts(f, p), beforeWake);
    assert.deepEqual(rows(f), committed);
    assertWaitingUnclaimed(f, source);
    assert.equal(stage.signal.aborted, false);
    await unchangedOriginalRecords(f, source);
    await runner.close();
    assert.equal(stage.signal.aborted, true);
    assert.deepEqual(f.time.pending(), []);
  });

  it("receives a real already-applied interruption outcome without preparing or starting its replacement", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h);
    const p = observeRunner(f);
    const receipts: {
      first?: CreatedOutcome;
      replay?: StartupRecoveryOutcome;
    } = {};
    p.restart.mockImplementation(async function (
      this: Store,
      ...args: Parameters<Store["restartInterruptedAttempt"]>
    ) {
      const first = createdReceipt(await p.originalRestart.apply(this, args));
      receipts.first = first;
      const beforeReplay = rows(f);
      const io = chainCounts(f, p);
      const replay = await p.originalRestart.apply(this, args);
      receipts.replay = replay;
      assert.ok(replay && replay.kind === "already-applied");
      assert.equal(
        replay.replacementAttemptNo,
        first.attempt.identity.attemptNo,
      );
      assert.deepEqual(rows(f), beforeReplay);
      assert.deepEqual(chainCounts(f, p), {
        ...io,
        actualRestart: io.actualRestart + 1,
      });
      return replay;
    });
    const runner = h.runner("authorized-runner-replay");
    const gate = readerGate(h);
    const recovering = h.track(runner.recover());
    await reachedWhilePending(gate.reached, recovering);
    const stage = await assertReaderStage(f, source, p, gate.marker);
    gate.release();
    await recovering;
    const { first, replay } = receipts;
    assert.ok(first && replay && replay.kind === "already-applied");
    assert.equal(await p.restart.mock.results[0]!.value, replay);
    assert.equal(f.restartCalls.length, 2);
    assert.equal(f.restartCalls[0]?.key, f.restartCalls[1]?.key);
    assert.equal(f.restartCalls[0]?.signal, f.restartCalls[1]?.signal);
    const committed = assertCommitted(f, source, stage, first.attempt);
    assertNoLaunch(p, f);
    const beforeWakes = chainCounts(f, p);
    await h.track(runner.wake());
    await h.track(runner.recover());
    assert.deepEqual(chainCounts(f, p), beforeWakes);
    assert.deepEqual(rows(f), committed);
    assertNoLaunch(p, f);
    assert.deepEqual(await ticketDirectories(f), source.ticketDirectories);
    await unchangedOriginalRecords(f, source);
    await runner.close();
    assert.equal(stage.signal.aborted, true);
  });

  it("closes after the real interruption COMMIT and preserves an unprepared unauthorized replacement without starting it", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h);
    const p = observeRunner(f);
    const receiptGate = postCommitGate(h, p);
    const runner = h.runner("authorized-runner-close");
    const gate = readerGate(h);
    const recovering = h.track(runner.recover());
    await reachedWhilePending(gate.reached, recovering);
    const stage = await assertReaderStage(f, source, p, gate.marker);
    gate.release();
    const receipt = await reachedWhilePending(receiptGate.reached, recovering);
    const committed = assertCommitted(f, source, stage, receipt.attempt);
    assertNoLaunch(p, f);
    assert.equal(f.storage.store.closed, false);
    assert.equal(stage.signal.aborted, false);
    const reads = [p.getActive.mock.calls.length, p.claim.mock.calls.length];
    const io = chainCounts(f, p);
    await runner.close();
    assert.equal(stage.signal.aborted, true);
    assert.deepEqual(f.time.pending(), []);
    assert.deepEqual(rows(f), committed);
    receiptGate.release();
    await recovering;
    assert.equal(await p.restart.mock.results[0]!.value, receipt);
    assert.deepEqual(
      [p.getActive.mock.calls.length, p.claim.mock.calls.length],
      reads,
    );
    assert.deepEqual(chainCounts(f, p), io);
    assert.deepEqual(rows(f), committed);
    assertNoLaunch(p, f);
    assert.deepEqual(await ticketDirectories(f), source.ticketDirectories);
    await unchangedOriginalRecords(f, source);
  });

  it("does not prepare or start a committed interruption replacement after its store closes before the receipt returns", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h);
    const p = observeRunner(f);
    const receiptGate = postCommitGate(h, p);
    const runner = h.runner("authorized-runner-store-close");
    const gate = readerGate(h);
    const recovering = h.track(runner.recover());
    await reachedWhilePending(gate.reached, recovering);
    const stage = await assertReaderStage(f, source, p, gate.marker);
    gate.release();
    const receipt = await reachedWhilePending(receiptGate.reached, recovering);
    const committed = assertCommitted(f, source, stage, receipt.attempt);
    assertNoLaunch(p, f);
    const reads = [p.getActive.mock.calls.length, p.claim.mock.calls.length];
    const io = chainCounts(f, p);
    f.storage.store.close();
    assert.equal(f.storage.store.closed, true);
    // Only store.close is under test; the runner's real signal remains live.
    assert.equal(stage.signal.aborted, false);
    receiptGate.release();
    await recovering;
    assert.equal(await p.restart.mock.results[0]!.value, receipt);
    assert.equal(stage.signal.aborted, false);
    assert.deepEqual(
      [p.getActive.mock.calls.length, p.claim.mock.calls.length],
      reads,
    );
    assert.deepEqual(chainCounts(f, p), io);
    // snapshot opens copied file bytes, never a fresh store or closed-store API.
    assert.deepEqual(rows(f), committed);
    assertNoLaunch(p, f);
    assert.deepEqual(await ticketDirectories(f), source.ticketDirectories);
    await runner.close();
    assert.equal(stage.signal.aborted, true);
    assert.deepEqual(f.time.pending(), []);
  });

  it("ignores a real created interruption receipt after a public wake retires its original OwnedAttempt", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h, true);
    const p = observeRunner(f);
    const receiptGate = postCommitGate(h, p);
    const runner = h.runner("authorized-runner-retired-holder");
    const gate = readerGate(h);
    const recovering = h.track(runner.recover());
    await reachedWhilePending(gate.reached, recovering);
    const stage = await assertReaderStage(f, source, p, gate.marker);
    gate.release();
    const receipt = await reachedWhilePending(receiptGate.reached, recovering);
    const committed = assertCommitted(f, source, stage, receipt.attempt);
    const activeReads = p.getActive.mock.calls.length;
    const claims = p.claim.mock.calls.length;
    assert.equal(f.storage.store.closed, false);
    assert.equal(stage.signal.aborted, false);
    // Public fresh -> discard must finish while the old receipt is held.
    await h.track(runner.wake());
    const retiredRead = p.getActive.mock.calls.findIndex(
      (args, index) =>
        index >= activeReads &&
        args[0].jobId === stage.publisher.jobId &&
        args[0].attemptNo === stage.publisher.attemptNo &&
        args[0].ownerInstanceId === stage.publisher.ownerInstanceId &&
        args[0].fence === stage.publisher.fence,
    );
    assert.ok(
      retiredRead >= activeReads,
      "public wake must actually read the retired publisher",
    );
    assert.equal(p.getActive.mock.results[retiredRead]?.type, "return");
    assert.equal(p.getActive.mock.results[retiredRead]?.value, undefined);
    assert.equal(p.claim.mock.calls.length, claims + 1);
    assert.equal(p.claim.mock.results[claims]?.type, "return");
    assert.equal(p.claim.mock.results[claims]?.value, undefined);
    assert.equal(runner.readiness().recoveryState, "idle");
    assert.equal(stage.signal.aborted, false);
    assert.equal(f.storage.store.closed, false);
    assert.deepEqual(rows(f), committed);
    assertWaitingUnclaimed(f, source);
    assertNoLaunch(p, f);
    const beforeLateReceipt = chainCounts(f, p);
    const reads = [p.getActive.mock.calls.length, p.claim.mock.calls.length];
    receiptGate.release();
    await recovering;
    assert.equal(await p.restart.mock.results[0]!.value, receipt);
    assert.deepEqual(chainCounts(f, p), beforeLateReceipt);
    assert.equal(stage.signal.aborted, false);
    assert.deepEqual(
      [p.getActive.mock.calls.length, p.claim.mock.calls.length],
      reads,
    );
    assert.deepEqual(rows(f), committed);
    assertNoLaunch(p, f);
    assertWaitingUnclaimed(f, source);
    assert.deepEqual(await ticketDirectories(f), source.ticketDirectories);
    await unchangedOriginalRecords(f, source);
    await runner.close();
    assert.equal(stage.signal.aborted, true);
  });

  it("keeps a resolved interruption recovery chain cached across ordinary timer and repeated recovery wakes", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h);
    const p = observeRunner(f);
    const runner = h.runner("authorized-runner-cached-chain");
    const gate = readerGate(h);
    const recovering = h.track(runner.recover());
    await reachedWhilePending(gate.reached, recovering);
    const stage = await assertReaderStage(f, source, p, gate.marker);
    const previousBefore = f.executor.hooks.before;
    let faultHits = 0;
    f.executor.hooks.before = async (event) => {
      await previousBefore?.(event);
      if (
        faultHits === 0 &&
        event.operation === "reader" &&
        event.role === "terminal" &&
        event.stage === "open" &&
        event.phase === "before"
      ) {
        faultHits++;
        throw new Error("controlled terminal open failure");
      }
    };
    gate.release();
    await recovering;
    f.executor.hooks.before = previousBefore;
    assert.equal(faultHits, 1);
    assert.equal(await p.restart.mock.results[0]!.value, undefined);
    assert.ok(
      f.executor.events.some(
        (event) =>
          event.operation === "inspect" &&
          event.role === "terminal" &&
          event.stage === "read" &&
          event.phase === "after" &&
          (event.bytesRead ?? 0) > 0,
      ),
    );
    const readerEvents = f.executor.events
      .slice(gate.marker)
      .filter((event) => event.operation === "reader");
    for (const role of ["authorization", "controller-loss"] as const)
      assert.ok(
        readerEvents.some(
          (event) =>
            event.role === role &&
            event.stage === "read" &&
            event.phase === "after" &&
            (event.bytesRead ?? 0) > 0,
        ),
      );
    assert.equal(
      readerEvents.filter(
        (event) =>
          event.role === "terminal" &&
          event.stage === "open" &&
          event.phase === "before",
      ).length,
      1,
    );
    assert.equal(
      readerEvents.some(
        (event) =>
          event.role === "terminal" &&
          event.stage === "open" &&
          event.phase === "after",
      ),
      false,
    );
    const cached = rows(f);
    assert.deepEqual(cached, stage.baseline);
    assert.equal(cached.events.length, 0);
    assert.equal(cached.attempts.length, 1);
    assert.equal(cached.references.length, 1);
    assert.equal(cached.references[0]?.released_at, null);
    assertNoLaunch(p, f);
    const cachedCounts = chainCounts(f, p);
    await h.track(runner.wake());
    await h.track(runner.recover());
    await h.track(runner.recover());
    assert.deepEqual(chainCounts(f, p), cachedCounts);
    const active = cached.attempts[0];
    assert.ok(active);
    const limits = source.original.executionPolicy.limits;
    const heartbeatAt =
      active.lease_expires_at -
      limits.leaseDurationMs +
      limits.heartbeatIntervalMs;
    assert.ok(
      heartbeatAt > f.storage.clock() &&
        heartbeatAt < source.original.executionDeadlineAt,
    );
    assert.deepEqual(
      f.time.pending().map((entry) => entry.at),
      [heartbeatAt],
    );
    const renewals = p.renewLease.mock.calls.length;
    f.time.advanceTo(heartbeatAt);
    assert.equal(p.renewLease.mock.calls.length, renewals + 1);
    const afterHeartbeat = rows(f);
    assert.equal(
      afterHeartbeat.attempts[0]?.lease_expires_at,
      heartbeatAt + limits.leaseDurationMs,
    );
    assert.deepEqual(
      stableHeartbeatFacts(afterHeartbeat),
      stableHeartbeatFacts(cached),
    );
    assert.deepEqual(chainCounts(f, p), cachedCounts);
    await h.track(runner.wake());
    assert.equal(p.renewLease.mock.calls.length, renewals + 1);
    assert.deepEqual(chainCounts(f, p), cachedCounts);
    assert.deepEqual(rows(f), afterHeartbeat);
    assert.equal(f.restartCalls[0]?.signal, stage.signal);
    assert.equal(stage.signal.aborted, false);
    assert.equal(p.reserve.mock.calls.length, 0);
    assert.deepEqual(await ticketDirectories(f), source.ticketDirectories);
    assertNoLaunch(p, f);
    await unchangedOriginalRecords(f, source);
    await runner.close();
    assert.equal(stage.signal.aborted, true);
    assert.deepEqual(rows(f).references, cached.references);
    assert.deepEqual(f.time.pending(), []);
  });

  it("does not prepare a committed interruption replacement while a real active recovery control holds its launch authority", async () => {
    const h = await fixture();
    const { f } = h;
    const source = await interruptedSource(h);
    const p = observeRunner(f);
    const receiptGate = postCommitGate(h, p);
    const runner = h.runner("authorized-runner-permission");
    const gate = readerGate(h);
    const recovering = h.track(runner.recover());
    await reachedWhilePending(gate.reached, recovering);
    const stage = await assertReaderStage(f, source, p, gate.marker);
    gate.release();
    const receipt = await reachedWhilePending(receiptGate.reached, recovering);
    const replacement = receipt.attempt;
    const committed = assertCommitted(f, source, stage, replacement);
    assertNoLaunch(p, f);
    assert.equal(f.storage.store.closed, false);
    assert.equal(stage.signal.aborted, false);

    // A real competing control holds authority without moving the current slot.
    const competingOwner = "authorized-runner-permission-controller";
    assert.notEqual(competingOwner, replacement.identity.ownerInstanceId);
    const session = f.storage.store.beginRecovery(competingOwner);
    assert.ok(session);
    assert.equal(session.control.ownerInstanceId, competingOwner);
    assert.deepEqual(session.control.source, replacement.identity);
    assert.deepEqual(session.control.publisher, replacement.identity);
    assert.equal(session.control.launchTicket, replacement.launchTicket);
    assert.deepEqual(session.target, target(replacement));
    assert.deepEqual(session.active.identity, replacement.identity);
    assert.equal(session.active.launchTicket, replacement.launchTicket);

    // This public read must still succeed: missing current ownership is not the gate.
    const active = f.storage.store.getActiveAttempt(replacement.identity);
    assert.ok(active);
    assert.deepEqual(active.identity, replacement.identity);
    assert.equal(active.launchTicket, replacement.launchTicket);
    assert.equal(active.ownerDescriptor, null);
    assert.equal(active.preparedAt, null);
    assert.equal(active.authorizedAt, null);
    assert.equal(active.exit, null);
    assert.equal(active.stopReason, null);
    const controlled = rows(f);
    assert.equal(controlled.controls.length, committed.controls.length + 1);
    const activeControls = controlled.controls.filter(
      (control) => control.recovery_id === session.control.recoveryId,
    );
    assert.equal(activeControls.length, 1);
    const activeControl = activeControls[0];
    assert.ok(activeControl);
    assert.equal(activeControl.state, "active");
    assert.equal(activeControl.classification, "inspecting");
    assert.equal(activeControl.consumed_at, null);
    assert.equal(activeControl.observed_at, null);
    assert.equal(activeControl.job_id, replacement.identity.jobId);
    assert.equal(activeControl.attempt_no, replacement.identity.attemptNo);
    assert.equal(activeControl.owner_instance_id, competingOwner);
    assert.equal(activeControl.launch_ticket, replacement.launchTicket);
    assert.equal(activeControl.incarnation_id, stage.control.incarnation_id);
    assert.equal(
      activeControl.source_incarnation_id,
      stage.control.incarnation_id,
    );
    assert.deepEqual(
      JSON.parse(activeControl.source_identity_json),
      replacement.identity,
    );
    assert.deepEqual(
      JSON.parse(activeControl.publisher_identity_json),
      replacement.identity,
    );
    assert.deepEqual(controlled, {
      ...committed,
      controls: [...committed.controls, activeControl],
    });
    assert.deepEqual(controlled.slot, committed.slot);
    assert.equal(controlled.events.length, 1);
    assert.equal(controlled.attempts.length, 2);
    assert.equal(controlled.references.length, 1);
    assert.notEqual(controlled.references[0]?.released_at, null);
    assert.equal(f.storage.store.closed, false);
    assert.equal(stage.signal.aborted, false);
    assertNoLaunch(p, f);
    const beforeLateReceipt = chainCounts(f, p);

    // Only release the original real created receipt; do not apply/retire/close.
    receiptGate.release();
    await recovering;
    assert.equal(await p.restart.mock.results[0]!.value, receipt);
    assertNoLaunch(p, f);
    assert.deepEqual(rows(f), controlled);
    assert.deepEqual(chainCounts(f, p), beforeLateReceipt);
    assert.equal(f.storage.store.closed, false);
    assert.equal(stage.signal.aborted, false);
    assert.deepEqual(await ticketDirectories(f), source.ticketDirectories);
    await unchangedOriginalRecords(f, source);
    await runner.close();
    assert.equal(stage.signal.aborted, true);
    assert.deepEqual(rows(f), controlled);
    assert.deepEqual(f.time.pending(), []);
  });
});
