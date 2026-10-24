import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  createArtifacts,
  type ArtifactRecoveryOutcome,
  type ArtifactWorkKey,
} from "../src/artifacts.js";
import type {
  AttemptIdentity,
  ClaimedAttempt,
  DurableInterruptionRecords,
  ExecutionExit,
  StartupRecoveryOutcome,
} from "../src/execution.js";
import { openStore } from "../src/store.js";
import {
  authorizedRecoveryFixture,
  type AuthorizedRecoveryFixture,
} from "./authorized-recovery-fixtures.js";
import { deferred } from "./http-fixtures.js";
import { commitFault, snapshot } from "./lifecycle-fixtures.js";
import { target } from "./recovery-fixtures.js";
import {
  fixtureAuthorizeGuard,
  fixturePrepareGuard,
} from "./execution-send-permission-fixtures.js";
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
  first_started_at: number;
  execution_deadline_at: number;
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
type RestartCall = Readonly<{
  key: ArtifactWorkKey;
  signal: AbortSignal;
}>;
type CreatedOutcome = Extract<StartupRecoveryOutcome, { kind: "created" }>;

// SELECT * preserves every persisted field in rollback and replay comparisons.
// snapshot reads the real database file bytes without opening another store.
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

async function reachedWhilePending<T, Reached>(
  reached: Promise<Reached>,
  pending: Promise<T>,
): Promise<Reached> {
  return Promise.race([
    reached,
    pending.then(() => {
      throw new Error("recovery settled before the required real stage");
    }),
  ]);
}

async function interruptedSource(f: AuthorizedRecoveryFixture) {
  await f.submit();
  const original = f.storage.store.claimNext("atomic-interruption-producer");
  assert.ok(original);
  const owner = await f.executor.adapter.prepare(
    original,
    fixturePrepareGuard(f.storage.store, original),
  );
  assert.equal(
    f.storage.store.registerPrepared(original.identity, owner),
    true,
  );
  assert.equal(f.storage.store.authorizeLaunch(original.identity, owner), true);
  await f.executor.adapter.authorize(
    original,
    owner,
    fixtureAuthorizeGuard(f.storage.store, original, owner),
  );
  assert.equal(f.allLaunchCalls.length, 1);
  const accepted = rows(f);
  assert.equal(accepted.jobs.length, 1);
  assert.equal(accepted.attempts.length, 1);
  assert.equal(accepted.events.length, 0);
  assert.equal(accepted.references.length, 0);
  assert.notEqual(accepted.attempts[0]?.authorized_at, null);
  assert.equal(accepted.attempts[0]?.sealed_at, null);
  await f.executor.loseController(target(original));
  const previousFacade = f.executor;
  const previousReader = previousFacade.adapter.readInterruptionEvidence;
  await f.reopen();
  assert.equal(previousFacade.retired, true);
  assert.notEqual(f.executor, previousFacade);
  assert.notEqual(f.executor.adapter.readInterruptionEvidence, previousReader);
  return { original, owner, accepted };
}

type Source = Awaited<ReturnType<typeof interruptedSource>>;

async function recordBuffers(f: AuthorizedRecoveryFixture, source: Source) {
  const authorization = await f.executor.recordBytes(
    target(source.original),
    "authorization",
  );
  const controllerLoss = await f.executor.recordBytes(
    target(source.original),
    "controller-loss",
  );
  const terminal = await f.executor.recordBytes(
    target(source.original),
    "terminal",
  );
  assert.ok(authorization && authorization.length > 0);
  assert.ok(controllerLoss && controllerLoss.length > 0);
  assert.ok(terminal && terminal.length > 0);
  return { authorization, controllerLoss, terminal };
}

async function transferSource(f: AuthorizedRecoveryFixture, source: Source) {
  const session = f.storage.store.beginRecovery("atomic-interruption-recovery");
  assert.ok(session);
  assert.deepEqual(session.target, target(source.original));
  assert.deepEqual(session.active.ownerDescriptor, source.owner);
  const inspected = await f.executor.adapter.inspect(
    session.target,
    session.active.ownerDescriptor,
  );
  assert.equal(inspected.kind, "tree-exited");
  if (inspected.kind !== "tree-exited")
    assert.fail("reopened facade must inspect the actual interrupted terminal");
  assert.equal(inspected.exit.completion?.kind, "interrupted");
  const moved = f.storage.store.applyRecoveryInspection(
    session.control,
    inspected,
  );
  assert.ok(moved && moved.kind === "transferred");
  assert.equal(moved.startupEventId, null);
  const transferred = rows(f);
  const originalRow = transferred.attempts[0];
  const acceptedRow = source.accepted.attempts[0];
  const control = transferred.controls[0];
  assert.ok(originalRow && acceptedRow && control);
  assert.equal(transferred.attempts.length, 1);
  assert.equal(transferred.events.length, 0);
  assert.equal(transferred.references.length, 0);
  assert.equal(transferred.controls.length, 1);
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
  assert.ok(Number.isSafeInteger(prePublisher.fence + 1));
  assert.deepEqual(
    {
      ...prePublisher,
      ownerInstanceId: control.owner_instance_id,
      fence: prePublisher.fence + 1,
    },
    moved.publisher,
  );
  assert.equal(originalRow.owner_instance_id, moved.publisher.ownerInstanceId);
  assert.equal(originalRow.fence, moved.publisher.fence);
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
  assert.deepEqual(JSON.parse(originalRow.exit_json!), inspected.exit);
  assert.deepEqual(transferred.slot, [
    {
      singleton: 1,
      job_id: source.original.identity.jobId,
      attempt_no: source.original.identity.attemptNo,
      fence: moved.publisher.fence,
    },
  ]);
  // These reads finish before any reader gate holds the same ticket queue.
  const buffers = await recordBuffers(f, source);
  const records: DurableInterruptionRecords = {
    authorization: JSON.parse(buffers.authorization.toString("utf8")),
    controllerLoss: JSON.parse(buffers.controllerLoss.toString("utf8")),
    terminal: JSON.parse(buffers.terminal.toString("utf8")),
  };
  for (const record of Object.values(records))
    assert.deepEqual(record.scope, {
      target: target(source.original),
      descriptor: source.owner,
    });
  assert.deepEqual(inspected.exit.completion, {
    kind: "interrupted",
    authorizationRecordId: records.authorization.recordId,
    controllerLossRecordId: records.controllerLoss.recordId,
    terminalRecordId: records.terminal.recordId,
  });
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
    ...source,
    publisher: moved.publisher,
    inspected: inspected.exit,
    transferred,
    control,
    buffers,
    records,
  };
}

type Transferred = Awaited<ReturnType<typeof transferSource>>;

async function qualifiedRecovery(
  f: AuthorizedRecoveryFixture,
  source: Transferred,
  calls: readonly RestartCall[] = f.restartCalls,
) {
  const callsBefore = calls.length;
  const readerMarker = f.executor.events.length;
  const gate = f.gate(
    (event) =>
      event.operation === "reader" &&
      event.role === "authorization" &&
      event.stage === "read" &&
      event.phase === "after" &&
      (event.bytesRead ?? 0) > 0,
  );
  f.executor.hooks.after = gate.hook;
  const artifacts = createArtifacts({
    store: f.storage.store,
    files: f.actualFiles,
  });
  const recovering = f.track(artifacts.recover(source.publisher, f.signal));
  await reachedWhilePending(gate.reached, recovering);
  assert.equal(calls.length, callsBefore + 1);
  const call = calls[callsBefore];
  assert.ok(call);
  assert.equal(call.signal, f.signal);
  assert.deepEqual(call.key.publisher, source.publisher);
  const baseline = rows(f);
  assert.equal(baseline.attempts.length, 1);
  assert.equal(baseline.events.length, 0);
  assert.deepEqual(baseline.jobs, source.transferred.jobs);
  assert.deepEqual(baseline.attempts, source.transferred.attempts);
  assert.deepEqual(baseline.controls, source.transferred.controls);
  assert.deepEqual(baseline.slot, source.transferred.slot);
  assert.equal(baseline.references.length, 1);
  const held = baseline.references.find(
    (reference) => reference.reference_id === call.key.referenceId,
  );
  assert.ok(held);
  assert.equal(held.released_at, null);
  assert.equal(held.purpose, "recovery");
  assert.equal(held.candidate_id, null);
  assert.equal(held.incarnation_id, source.control.incarnation_id);
  assert.equal(held.job_id, source.original.identity.jobId);
  assert.equal(held.attempt_no, source.original.identity.attemptNo);
  assert.deepEqual(JSON.parse(held.publisher_identity_json), source.publisher);
  const observations = baseline.observations.filter(
    (observation) => observation.reference_id === held.reference_id,
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.candidate_id, null);
  assert.equal(observations[0]?.code, "no_qualified_candidate");
  assert.equal(
    observations[0]?.checked_engine_sha256,
    source.original.job.engineInput.sha256,
  );
  assert.equal(baseline.candidates.length, 0);
  const engineReads = f.artifactEvents.filter(
    (event) =>
      event.path === source.original.inputPath &&
      event.stage === "read" &&
      (event.bytesRead ?? 0) > 0,
  );
  assert.ok(engineReads.length > 0);
  let position = 0;
  for (const read of engineReads) {
    assert.equal(read.position, position);
    assert.ok(read.bytes);
    assert.equal(read.bytes.length, read.bytesRead);
    position += read.bytes.length;
  }
  const engineBytes = Buffer.concat(engineReads.map((read) => read.bytes!));
  assert.equal(engineBytes.length, source.original.job.engineInput.byteLength);
  assert.equal(sha256(engineBytes), source.original.job.engineInput.sha256);
  for (const stage of ["open", "stat", "close"] as const)
    assert.ok(
      f.artifactEvents.some(
        (event) =>
          event.path === source.original.inputPath && event.stage === stage,
      ),
    );
  assert.ok(
    f.artifactEvents.some(
      (event) =>
        event.path === source.original.inputPath &&
        event.stage === "stat" &&
        event.size === engineBytes.length,
    ),
  );
  assert.equal(f.allLaunchCalls.length, 1);
  return { gate, recovering, key: call.key, baseline, held, readerMarker };
}

type Qualified = Awaited<ReturnType<typeof qualifiedRecovery>>;

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

async function unchangedRecords(
  f: AuthorizedRecoveryFixture,
  source: Transferred,
) {
  assert.deepEqual(await recordBuffers(f, source), source.buffers);
}

function createdReceipt(result: ArtifactRecoveryOutcome): CreatedOutcome {
  assert.equal(result.kind, "restarted");
  if (result.kind !== "restarted")
    assert.fail("the real artifacts recovery must deliver a restart outcome");
  assert.equal(result.outcome.kind, "created");
  if (result.outcome.kind !== "created")
    assert.fail("the original qualified recovery must create one replacement");
  return result.outcome;
}

function assertCreated(
  f: AuthorizedRecoveryFixture,
  source: Transferred,
  qualified: Qualified,
  replacement: ClaimedAttempt,
  baseline = qualified.baseline,
) {
  completeReader(f, qualified.readerMarker);
  const done = rows(f);
  assert.equal(done.jobs.length, 1);
  assert.equal(done.attempts.length, 2);
  assert.equal(done.events.length, 1);
  assert.deepEqual(done.controls, baseline.controls);
  assert.deepEqual(done.observations, baseline.observations);
  assert.deepEqual(done.candidates, baseline.candidates);
  assert.deepEqual(done.incarnations, baseline.incarnations);
  assert.deepEqual(done.attempts[0], source.transferred.attempts[0]);
  const event = done.events[0];
  const originalRow = done.attempts[0];
  const replacementRow = done.attempts[1];
  const job = done.jobs[0];
  assert.ok(event && originalRow && replacementRow && job);
  assert.equal(event.kind, "authorized-interruption");
  assert.equal(event.sealed_at, null);
  assert.notEqual(event.consumed_at, null);
  assert.equal(event.interrupted_at, f.storage.clock());
  assert.equal(event.consumed_at, f.storage.clock());
  assert.equal(event.job_id, source.original.identity.jobId);
  assert.equal(event.launch_ticket, source.original.launchTicket);
  assert.equal(
    event.source_incarnation_id,
    source.control.source_incarnation_id,
  );
  assert.equal(event.recovery_incarnation_id, source.control.incarnation_id);
  assert.deepEqual(
    JSON.parse(event.source_identity_json),
    source.original.identity,
  );
  assert.deepEqual(
    JSON.parse(event.consumed_publisher_identity_json!),
    source.publisher,
  );
  assert.equal(event.replacement_attempt_no, replacement.identity.attemptNo);
  assert.ok(event.evidence_json);
  const evidence = JSON.parse(event.evidence_json) as {
    v: number;
    recoveryId: string;
    referenceId: string;
    records: DurableInterruptionRecords;
  };
  assert.deepEqual(evidence, {
    v: 1,
    recoveryId: source.control.recovery_id,
    referenceId: qualified.key.referenceId,
    records: source.records,
  });
  const raw = JSON.parse(originalRow.exit_json!) as ExecutionExit;
  assert.deepEqual(raw, source.inspected);
  assert.deepEqual(raw.completion, {
    kind: "interrupted",
    authorizationRecordId: source.records.authorization.recordId,
    controllerLossRecordId: source.records.controllerLoss.recordId,
    terminalRecordId: source.records.terminal.recordId,
  });
  assert.equal(originalRow.sealed_at, null);
  assert.equal(replacement.identity.jobId, source.original.identity.jobId);
  assert.equal(
    replacement.identity.attemptNo,
    source.original.identity.attemptNo + 1,
  );
  assert.equal(
    replacement.identity.ownerInstanceId,
    source.publisher.ownerInstanceId,
  );
  assert.equal(replacement.identity.fence, source.publisher.fence + 1);
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
  assert.equal(
    replacementRow.producer_incarnation_id,
    source.control.incarnation_id,
  );
  assert.deepEqual(
    JSON.parse(replacementRow.producer_identity_json),
    replacement.identity,
  );
  assert.equal(replacementRow.launch_ticket, replacement.launchTicket);
  assert.notEqual(replacementRow.run_directory, originalRow.run_directory);
  assert.equal(replacementRow.owner_descriptor_json, null);
  assert.equal(replacementRow.prepared_at, null);
  assert.equal(replacementRow.authorized_at, null);
  assert.equal(replacementRow.exit_json, null);
  assert.equal(replacementRow.sealed_at, null);
  assert.deepEqual(job, {
    ...baseline.jobs[0],
    active_attempt_no: replacement.identity.attemptNo,
    current_fence: replacement.identity.fence,
  });
  for (const field of [
    "source_json",
    "engine_json",
    "plan_json",
    "execution_policy_json",
    "first_started_at",
    "execution_deadline_at",
  ] as const)
    assert.equal(job[field], source.accepted.jobs[0]?.[field]);
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
  assert.deepEqual(
    done.references,
    baseline.references.map((reference) =>
      reference.reference_id === qualified.key.referenceId
        ? { ...reference, released_at: event.consumed_at }
        : reference,
    ),
  );
  assert.equal(f.allLaunchCalls.length, 1);
  return { done, event, evidence };
}

function ioMarker(f: AuthorizedRecoveryFixture) {
  return {
    records: f.executor.events.length,
    artifacts: f.artifactEvents.length,
    starts: f.allLaunchCalls.length,
  };
}

function assertNoIo(
  f: AuthorizedRecoveryFixture,
  marker: ReturnType<typeof ioMarker>,
) {
  assert.deepEqual(ioMarker(f), marker);
}

async function assertReplay(
  f: AuthorizedRecoveryFixture,
  key: ArtifactWorkKey,
  replacementAttemptNo: number,
  restart = f.storage.store.restartInterruptedAttempt.bind(f.storage.store),
) {
  const before = rows(f);
  const marker = ioMarker(f);
  assert.deepEqual(await restart(key, f.signal), {
    kind: "already-applied",
    replacementAttemptNo,
  });
  assert.deepEqual(rows(f), before);
  assertNoIo(f, marker);
}

function installAuthorizedInterruptionCommitFault(
  f: AuthorizedRecoveryFixture,
) {
  const previousStore = f.storage.store;
  const reader = f.executor.adapter.readInterruptionEvidence;
  const businessClientId = f.storage.principal().clientId;
  const businessCredentials = snapshot(f.storage, (db) =>
    db
      .prepare(
        "SELECT credential_id, revoked_at FROM credentials WHERE client_id = ? ORDER BY version",
      )
      .all(businessClientId),
  );
  const activation = previousStore.issueCredential(
    sha256(Buffer.from("authorized-interruption-fault-activation", "utf8")),
  );
  const deactivation = previousStore.issueCredential(
    sha256(Buffer.from("authorized-interruption-fault-deactivation", "utf8")),
    { clientId: activation.clientId },
  );
  assert.notEqual(activation.clientId, businessClientId);
  assert.equal(deactivation.clientId, activation.clientId);
  assert.notEqual(activation.credentialId, deactivation.credentialId);
  const previousIncarnations = snapshot(f.storage, (db) =>
    db
      .prepare("SELECT incarnation_id FROM store_incarnations ORDER BY rowid")
      .all(),
  );
  const restartCalls: RestartCall[] = [];
  commitFault(
    f.storage,
    `CREATE TRIGGER authorized_interruption_exact_commit_fault
     AFTER UPDATE OF consumed_at ON recovery_events
     WHEN NEW.kind = 'authorized-interruption'
       AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
       AND OLD.consumed_publisher_identity_json IS NULL
       AND NEW.consumed_publisher_identity_json IS NOT NULL
       AND NEW.replacement_attempt_no IS NOT NULL
       AND NEW.sealed_at IS NULL AND NEW.evidence_json IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM credentials
         WHERE credential_id = '${activation.credentialId}'
           AND client_id = '${activation.clientId}' AND revoked_at IS NOT NULL
       ) AND EXISTS (
         SELECT 1 FROM credentials
         WHERE credential_id = '${deactivation.credentialId}'
           AND client_id = '${deactivation.clientId}' AND revoked_at IS NULL
       )
     BEGIN
       INSERT INTO lifecycle_commit_fault(client_id)
       VALUES ('authorized-interruption-fault-missing-client');
     END;`,
    (storage) => {
      // Exactly one construction binds the same facade reader before any
      // recovery control or artifact reference exists on this incarnation.
      const store = openStore({
        directory: storage.directory,
        clock: storage.clock,
        interruptionEvidenceReader: reader,
      });
      const restart = store.restartInterruptedAttempt.bind(store);
      store.restartInterruptedAttempt = (key, signal) => {
        restartCalls.push({ key, signal });
        return restart(key, signal);
      };
      return store;
    },
  );
  assert.equal(previousStore.closed, true);
  assert.notEqual(f.storage.store, previousStore);
  assert.equal(f.executor.adapter.readInterruptionEvidence, reader);
  const incarnations = snapshot(
    f.storage,
    (db) =>
      db
        .prepare("SELECT incarnation_id FROM store_incarnations ORDER BY rowid")
        .all() as { incarnation_id: string }[],
  );
  assert.equal(incarnations.length, previousIncarnations.length + 1);
  const incarnationId = incarnations.at(-1)?.incarnation_id;
  assert.ok(incarnationId);
  const currentStore = f.storage.store;
  assert.deepEqual(rows(f).controls, []);
  assert.deepEqual(rows(f).references, []);
  return {
    restartCalls,
    incarnationId,
    setEnabled(enabled: boolean) {
      assert.equal(f.storage.store, currentStore);
      assert.equal(currentStore.closed, false);
      assert.equal(f.executor.adapter.readInterruptionEvidence, reader);
      currentStore.revokeCredential(
        enabled ? activation.credentialId : deactivation.credentialId,
      );
      snapshot(f.storage, (db) => {
        const credentials = db
          .prepare(
            "SELECT credential_id, client_id, revoked_at FROM credentials WHERE credential_id IN (?, ?) ORDER BY version",
          )
          .all(activation.credentialId, deactivation.credentialId) as {
          credential_id: string;
          client_id: string;
          revoked_at: number | null;
        }[];
        assert.equal(credentials.length, 2);
        const active = credentials.find(
          (credential) => credential.credential_id === activation.credentialId,
        );
        const inactive = credentials.find(
          (credential) =>
            credential.credential_id === deactivation.credentialId,
        );
        assert.ok(active && inactive);
        assert.equal(active.client_id, activation.clientId);
        assert.equal(inactive.client_id, activation.clientId);
        assert.equal(
          active.revoked_at !== null && inactive.revoked_at === null,
          enabled,
        );
        assert.equal(
          db
            .prepare("SELECT 1 FROM clients WHERE client_id = ?")
            .get("authorized-interruption-fault-missing-client"),
          undefined,
        );
        assert.deepEqual(
          db
            .prepare(
              "SELECT incarnation_id FROM store_incarnations ORDER BY rowid",
            )
            .all(),
          incarnations,
        );
        assert.deepEqual(
          db
            .prepare(
              "SELECT credential_id, revoked_at FROM credentials WHERE client_id = ? ORDER BY version",
            )
            .all(businessClientId),
          businessCredentials,
        );
      });
      assert.equal(f.storage.store, currentStore);
      assert.equal(currentStore.closed, false);
    },
    faultRows() {
      return snapshot(f.storage, (db) =>
        db.prepare("SELECT * FROM lifecycle_commit_fault").all(),
      );
    },
  };
}

describe("authorized interruption atomic commit and historical replay", () => {
  it("rolls back the authorized interruption final COMMIT and creates once with the same qualified key when the fault is disabled", async () => {
    const f = await authorizedRecoveryFixture();
    const rejectionPermission = deferred<void>();
    try {
      const original = await interruptedSource(f);
      const fault = installAuthorizedInterruptionCommitFault(f);
      const source = await transferSource(f, original);
      assert.equal(source.control.incarnation_id, fault.incarnationId);
      const store = f.storage.store;
      const restart = store.restartInterruptedAttempt.bind(store);
      const getActiveAttempt = store.getActiveAttempt.bind(store);
      const transactionTail: ClaimedAttempt[] = [];
      store.getActiveAttempt = (identity) => {
        const actual = getActiveAttempt(identity);
        if (
          actual?.identity.attemptNo ===
          source.original.identity.attemptNo + 1
        )
          transactionTail.push(actual);
        return actual;
      };
      const rejectionReached = deferred<unknown>();
      const forwardedRejections: unknown[] = [];
      store.restartInterruptedAttempt = async (key, signal) => {
        try {
          return await restart(key, signal);
        } catch (error) {
          rejectionReached.resolve(error);
          // Only the real rejection receipt is delayed. The transaction has
          // already failed and rolled back; its error object is passed on.
          await rejectionPermission.promise;
          forwardedRejections.push(error);
          throw error;
        }
      };
      fault.setEnabled(true);
      const qualified = await qualifiedRecovery(f, source, fault.restartCalls);
      assert.deepEqual(fault.faultRows(), []);
      const fixedClock = f.storage.clock();
      const fixedSignal = f.signal;
      qualified.gate.release();
      const error = await reachedWhilePending(
        rejectionReached.promise,
        qualified.recovering,
      );
      assert.ok(error instanceof Error);
      completeReader(f, qualified.readerMarker);
      assert.equal(transactionTail.length, 1);
      const rolledBackReplacement = transactionTail[0];
      assert.ok(rolledBackReplacement);
      assert.equal(
        rolledBackReplacement.identity.attemptNo,
        source.original.identity.attemptNo + 1,
      );
      assert.notEqual(
        rolledBackReplacement.launchTicket,
        source.original.launchTicket,
      );
      assert.notEqual(
        rolledBackReplacement.workingDirectory,
        source.original.workingDirectory,
      );
      assert.equal(
        qualified.baseline.attempts.some(
          (attempt) =>
            attempt.attempt_no === rolledBackReplacement.identity.attemptNo,
        ),
        false,
      );
      assert.deepEqual(rows(f), qualified.baseline);
      assert.deepEqual(fault.faultRows(), []);
      assert.equal(f.storage.store, store);
      assert.equal(f.signal, fixedSignal);
      assert.equal(f.storage.clock(), fixedClock);
      await unchangedRecords(f, source);

      // An explicit same-key positive control is permitted only after the
      // complete real file snapshot above has established rollback.
      fault.setEnabled(false);
      const control = await f.track(restart(qualified.key, fixedSignal));
      assert.ok(control && control.kind === "created");
      const committed = assertCreated(f, source, qualified, control.attempt);
      assert.equal(transactionTail.length, 2);
      assert.equal(
        control.attempt.identity.attemptNo,
        rolledBackReplacement.identity.attemptNo,
      );
      assert.notEqual(
        control.attempt.launchTicket,
        rolledBackReplacement.launchTicket,
      );
      assert.equal(f.storage.clock(), fixedClock);
      await unchangedRecords(f, source);
      await assertReplay(
        f,
        qualified.key,
        control.attempt.identity.attemptNo,
        restart,
      );
      assert.deepEqual(fault.faultRows(), []);
      rejectionPermission.resolve();
      assert.deepEqual(await qualified.recovering, {
        kind: "settled",
        verdict: "blocked",
      });
      assert.equal(forwardedRejections.length, 1);
      assert.equal(forwardedRejections[0], error);
      assert.deepEqual(rows(f), committed.done);
      assert.equal(f.allLaunchCalls.length, 1);
    } finally {
      rejectionPermission.resolve();
      await f.cleanup();
    }
  });

  it("replays one committed authorized interruption after the created receipt is lost", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const source = await transferSource(f, await interruptedSource(f));
      const store = f.storage.store;
      const restart = store.restartInterruptedAttempt.bind(store);
      const receipts: {
        outcome: CreatedOutcome;
        committed: ReturnType<typeof rows>;
      }[] = [];
      const lostReceipt = new Error(
        "controlled application recovery receipt lost",
      );
      store.restartInterruptedAttempt = async (key, signal) => {
        const outcome = await restart(key, signal);
        if (outcome?.kind === "created") {
          // The awaited real public result means COMMIT already completed.
          // Lose only this application's delivery of that original object.
          receipts.push({ outcome, committed: rows(f) });
          throw lostReceipt;
        }
        return outcome;
      };
      const qualified = await qualifiedRecovery(f, source);
      qualified.gate.release();
      const callerResult = await qualified.recovering;
      assert.deepEqual(callerResult, { kind: "settled", verdict: "blocked" });
      assert.equal(receipts.length, 1);
      const receipt = receipts[0];
      assert.ok(receipt);
      const committed = assertCreated(
        f,
        source,
        qualified,
        receipt.outcome.attempt,
      );
      assert.deepEqual(committed.done, receipt.committed);
      await unchangedRecords(f, source);
      await assertReplay(
        f,
        qualified.key,
        receipt.outcome.attempt.identity.attemptNo,
        restart,
      );
      assert.equal(f.allLaunchCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("returns one created and one already-applied for concurrent calls with the same real recovery key", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const source = await transferSource(f, await interruptedSource(f));
      const store = f.storage.store;
      const restart = store.restartInterruptedAttempt.bind(store);
      const getActiveAttempt = store.getActiveAttempt.bind(store);
      const transactionTailMarkers: number[] = [];
      store.getActiveAttempt = (identity) => {
        const actual = getActiveAttempt(identity);
        if (
          actual?.identity.attemptNo ===
          source.original.identity.attemptNo + 1
        )
          transactionTailMarkers.push(f.executor.events.length);
        return actual;
      };
      const qualified = await qualifiedRecovery(f, source);
      const secondQueueGate = f.gate(
        (event) =>
          event.operation === "reader" &&
          event.role === "ticket-directory" &&
          event.stage === "queue" &&
          event.phase === "before",
      );
      f.executor.hooks.before = secondQueueGate.hook;
      // This is a second real store call, independent of artifacts' flight map.
      const second = f.track(restart(qualified.key, f.signal));
      const queued = await reachedWhilePending(secondQueueGate.reached, second);
      assert.deepEqual(queued.target, target(source.original));
      assert.equal(f.restartCalls.length, 2);
      assert.equal(f.restartCalls[1]?.key, qualified.key);
      assert.deepEqual(rows(f), qualified.baseline);
      secondQueueGate.release();
      qualified.gate.release();
      const [firstResult, secondResult] = await Promise.all([
        qualified.recovering,
        second,
      ]);
      const first = createdReceipt(firstResult);
      assert.deepEqual(secondResult, {
        kind: "already-applied",
        replacementAttemptNo: first.attempt.identity.attemptNo,
      });
      const outcomes = [first, secondResult];
      assert.equal(
        outcomes.filter((outcome) => outcome?.kind === "created").length,
        1,
      );
      assert.equal(
        outcomes.filter((outcome) => outcome?.kind === "already-applied")
          .length,
        1,
      );
      assert.equal(transactionTailMarkers.length, 1);
      const marker = transactionTailMarkers[0];
      assert.ok(marker !== undefined);
      // The final transaction is synchronous after this tail marker. A
      // concurrent reader may subsequently close only handles already issued.
      for (const event of f.executor.events.slice(marker))
        if (event.operation === "reader") {
          assert.equal(event.stage, "close");
          assert.equal(event.cleanup, true);
        }
      assertCreated(f, source, qualified, first.attempt);
      await unchangedRecords(f, source);
      await assertReplay(
        f,
        qualified.key,
        first.attempt.identity.attemptNo,
        restart,
      );
      assert.equal(f.allLaunchCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("replays the exact consumed key after store and facade reopen without rereading interruption records", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const source = await transferSource(f, await interruptedSource(f));
      const qualified = await qualifiedRecovery(f, source);
      qualified.gate.release();
      const created = createdReceipt(await qualified.recovering);
      const committed = assertCreated(f, source, qualified, created.attempt);
      await unchangedRecords(f, source);
      const oldStore = f.storage.store;
      const oldFacade = f.executor;
      const oldKey = qualified.key;
      const oldSignal = f.signal;
      await f.reopen();
      assert.equal(oldStore.closed, true);
      assert.equal(oldFacade.retired, true);
      assert.notEqual(f.storage.store, oldStore);
      assert.notEqual(f.executor, oldFacade);
      assert.notEqual(f.signal, oldSignal);
      assert.equal(f.signal.aborted, false);
      const baseline = rows(f);
      assert.equal(
        baseline.incarnations.length,
        committed.done.incarnations.length + 1,
      );
      assert.deepEqual(baseline.events, committed.done.events);
      assert.deepEqual(baseline.controls, committed.done.controls);
      assert.deepEqual(baseline.attempts, committed.done.attempts);
      assert.deepEqual(baseline.references, committed.done.references);
      const heldHistory = baseline.references.find(
        (reference) => reference.reference_id === oldKey.referenceId,
      );
      assert.ok(heldHistory);
      assert.equal(heldHistory.incarnation_id, source.control.incarnation_id);
      assert.equal(
        committed.event.recovery_incarnation_id,
        heldHistory.incarnation_id,
      );
      const marker = ioMarker(f);
      assert.deepEqual(f.storage.store.readArtifactWork(oldKey), {
        kind: "retired",
      });
      await assertReplay(f, oldKey, created.attempt.identity.attemptNo);
      assert.deepEqual(rows(f), baseline);
      assertNoIo(f, marker);
      assert.equal(f.executor.events.length, 0);
      assert.equal(f.allLaunchCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses an exact consumed reference presented by a different real publisher", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const source = await transferSource(f, await interruptedSource(f));
      const qualified = await qualifiedRecovery(f, source);
      qualified.gate.release();
      const created = createdReceipt(await qualified.recovering);
      assertCreated(f, source, qualified, created.attempt);
      await unchangedRecords(f, source);
      assert.equal(
        source.original.identity.jobId,
        qualified.key.publisher.jobId,
      );
      assert.equal(
        source.original.identity.attemptNo,
        qualified.key.publisher.attemptNo,
      );
      assert.notEqual(
        source.original.identity.ownerInstanceId,
        qualified.key.publisher.ownerInstanceId,
      );
      assert.notEqual(
        source.original.identity.fence,
        qualified.key.publisher.fence,
      );
      const wrongPublisherKey: ArtifactWorkKey = {
        publisher: source.original.identity,
        referenceId: qualified.key.referenceId,
      };
      const baseline = rows(f);
      const marker = ioMarker(f);
      assert.equal(
        await f.storage.store.restartInterruptedAttempt(
          wrongPublisherKey,
          f.signal,
        ),
        undefined,
      );
      assert.deepEqual(rows(f), baseline);
      assertNoIo(f, marker);
      await assertReplay(f, qualified.key, created.attempt.identity.attemptNo);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses a different genuine released reference even when its publisher and consumption time match", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const source = await transferSource(f, await interruptedSource(f));
      const qualified = await qualifiedRecovery(f, source);
      const other = f.storage.store.acquireArtifactWork(
        source.publisher,
        "recovery",
      );
      assert.ok(other);
      assert.equal(other.purpose, "recovery");
      assert.equal(other.access, "active");
      assert.equal(other.candidate, null);
      assert.deepEqual(other.key.publisher, qualified.key.publisher);
      assert.notEqual(other.key.referenceId, qualified.key.referenceId);
      const fixedClock = f.storage.clock();
      assert.equal(f.storage.store.releaseArtifactReference(other.key), true);
      const beforeCommit = rows(f);
      assert.equal(beforeCommit.references.length, 2);
      const otherReference = beforeCommit.references.find(
        (reference) => reference.reference_id === other.key.referenceId,
      );
      assert.ok(otherReference);
      for (const field of [
        "job_id",
        "attempt_no",
        "publisher_identity_json",
        "incarnation_id",
        "purpose",
        "candidate_id",
      ] as const)
        assert.equal(otherReference[field], qualified.held[field]);
      assert.equal(otherReference.released_at, fixedClock);
      assert.equal(
        beforeCommit.observations.some(
          (observation) => observation.reference_id === other.key.referenceId,
        ),
        false,
      );
      qualified.gate.release();
      const created = createdReceipt(await qualified.recovering);
      const committed = assertCreated(
        f,
        source,
        qualified,
        created.attempt,
        beforeCommit,
      );
      assert.equal(f.storage.clock(), fixedClock);
      assert.equal(otherReference.released_at, committed.event.consumed_at);
      assert.equal(committed.evidence.referenceId, qualified.key.referenceId);
      assert.notEqual(committed.evidence.referenceId, other.key.referenceId);
      assert.equal(
        committed.done.references.find(
          (reference) => reference.reference_id === other.key.referenceId,
        )?.released_at,
        committed.event.consumed_at,
      );
      await unchangedRecords(f, source);
      const baseline = rows(f);
      const marker = ioMarker(f);
      assert.equal(
        await f.storage.store.restartInterruptedAttempt(other.key, f.signal),
        undefined,
      );
      assert.deepEqual(rows(f), baseline);
      assertNoIo(f, marker);
      await assertReplay(f, qualified.key, created.attempt.identity.attemptNo);
      assert.equal(rows(f).references.length, 2);
      assert.equal(rows(f).events.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps authorized interruption and never-authorized events behind their respective recovery consumers", async () => {
    const authorized = await authorizedRecoveryFixture();
    try {
      const source = await transferSource(
        authorized,
        await interruptedSource(authorized),
      );
      const qualified = await qualifiedRecovery(authorized, source);
      qualified.gate.release();
      const created = createdReceipt(await qualified.recovering);
      const committed = assertCreated(
        authorized,
        source,
        qualified,
        created.attempt,
      );
      await unchangedRecords(authorized, source);
      const baseline = rows(authorized);
      const marker = ioMarker(authorized);
      assert.equal(
        authorized.storage.store.restartSealedAttempt(
          qualified.key.publisher,
          committed.event.event_id,
        ),
        undefined,
      );
      assert.deepEqual(rows(authorized), baseline);
      assertNoIo(authorized, marker);
      await assertReplay(
        authorized,
        qualified.key,
        created.attempt.identity.attemptNo,
      );
      assert.equal(
        rows(authorized).events.filter(
          (event) => event.launch_ticket === source.original.launchTicket,
        ).length,
        1,
      );
    } finally {
      await authorized.cleanup();
    }

    // The reverse direction has no legal interrupted-source recovery ref.
    // Keep this qualification refusal explicit; do not fabricate a business
    // reference to claim coverage of the deeper historical event-kind check.
    const never = await authorizedRecoveryFixture();
    try {
      await never.submit();
      const original = never.storage.store.claimNext(
        "atomic-never-authorized-producer",
      );
      assert.ok(original);
      const owner = await never.executor.adapter.prepare(
        original,
        fixturePrepareGuard(never.storage.store, original),
      );
      assert.equal(
        never.storage.store.registerPrepared(original.identity, owner),
        true,
      );
      assert.equal(never.allLaunchCalls.length, 0);
      const prepared = rows(never);
      assert.equal(prepared.attempts[0]?.authorized_at, null);
      assert.equal(prepared.attempts[0]?.exit_json, null);
      await never.reopen();
      const session = never.storage.store.beginRecovery(
        "atomic-never-authorized-recovery",
      );
      assert.ok(session);
      const inspected = await never.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      assert.equal(inspected.kind, "never-authorized");
      const moved = never.storage.store.applyRecoveryInspection(
        session.control,
        inspected,
      );
      assert.ok(moved && moved.kind === "transferred");
      assert.ok(moved.startupEventId);
      const before = rows(never);
      assert.equal(before.events.length, 1);
      assert.equal(before.attempts.length, 1);
      assert.equal(before.references.length, 0);
      const event = before.events[0];
      const sourceRow = before.attempts[0];
      assert.ok(event && sourceRow);
      assert.equal(event.event_id, moved.startupEventId);
      assert.equal(event.kind, "never-authorized");
      assert.equal(event.evidence_json, null);
      assert.notEqual(event.sealed_at, null);
      assert.equal(event.sealed_at, sourceRow.sealed_at);
      assert.equal(event.launch_ticket, original.launchTicket);
      assert.equal(sourceRow.authorized_at, null);
      assert.equal(sourceRow.exit_json, null);
      assert.equal(event.consumed_at, null);
      const marker = ioMarker(never);
      assert.equal(
        never.storage.store.acquireArtifactWork(moved.publisher, "recovery"),
        undefined,
      );
      assert.deepEqual(rows(never), before);
      assertNoIo(never, marker);
      const positive = never.storage.store.restartSealedAttempt(
        moved.publisher,
        moved.startupEventId,
      );
      assert.ok(positive && positive.kind === "created");
      const after = rows(never);
      assert.equal(after.attempts.length, 2);
      assert.equal(after.events.length, 1);
      assert.equal(after.references.length, 0);
      assert.deepEqual(after.attempts[0], before.attempts[0]);
      assert.equal(after.events[0]?.kind, "never-authorized");
      assert.equal(after.events[0]?.event_id, event.event_id);
      assert.equal(after.events[0]?.launch_ticket, original.launchTicket);
      assert.equal(after.events[0]?.evidence_json, null);
      assert.equal(after.events[0]?.sealed_at, event.sealed_at);
      assert.equal(
        after.events[0]?.replacement_attempt_no,
        positive.attempt.identity.attemptNo,
      );
      assert.equal(after.events[0]?.consumed_at, never.storage.clock());
      assert.deepEqual(
        JSON.parse(after.events[0]?.consumed_publisher_identity_json ?? "null"),
        moved.publisher,
      );
      assert.equal(
        positive.attempt.identity.attemptNo,
        original.identity.attemptNo + 1,
      );
      assert.equal(positive.attempt.identity.fence, moved.publisher.fence + 1);
      assert.notEqual(positive.attempt.launchTicket, original.launchTicket);
      assert.notEqual(
        positive.attempt.workingDirectory,
        original.workingDirectory,
      );
      assert.deepEqual(after.slot, [
        {
          singleton: 1,
          job_id: original.identity.jobId,
          attempt_no: positive.attempt.identity.attemptNo,
          fence: positive.attempt.identity.fence,
        },
      ]);
      assert.equal(never.allLaunchCalls.length, 0);
      assert.equal(
        never.executor.events.some((io) => io.operation === "reader"),
        false,
      );
    } finally {
      await never.cleanup();
    }
  });
});
