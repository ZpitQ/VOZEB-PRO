import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rmdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import { describe, it } from "vitest";

import {
  createArtifacts,
  type ArtifactCandidate,
  type ArtifactWorkKey,
} from "../src/artifacts.js";
import {
  freezeOwnerDescriptor,
  validIdentifier,
  type AttemptIdentity,
  type ClaimedAttempt,
  type DurableInterruptionRecords,
  type ExecutionExit,
  type InterruptedCompletion,
  type InterruptionEvidenceReader,
  type InterruptionReadScope,
  type RecoverySession,
} from "../src/execution.js";
import { openStore, type EnhancementStore } from "../src/store.js";
import { nativePng, writeActualFile } from "./artifact-fixtures.js";
import { traceArtifactCommit } from "./artifact-fault-fixtures.js";
import {
  artifactRecoveryFixture,
  changedArtifactBytes,
  transferArtifactPublisher,
} from "./artifact-recovery-fixtures.js";
import {
  authorizedRecoveryFixture,
  type AuthorizedRecoveryFixture,
} from "./authorized-recovery-fixtures.js";
import {
  canonicalCopy,
  checkedScope,
  ticketKey,
  type DurableIoEvent,
  type RecordRole,
} from "./authorized-recovery-records.js";
import { snapshot, type StorageFixture } from "./lifecycle-fixtures.js";
import { target } from "./recovery-fixtures.js";
import {
  fixtureAuthorizeGuard,
  fixturePrepareGuard,
  fixtureSendGuard,
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
  cancel_requested_at: number | null;
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
  exit_observed_at: number | null;
  sealed_at: number | null;
  stop_reason: string | null;
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
  classification: string | null;
  created_at: number;
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
  released_at: number | null;
};
type ObservationRow = {
  reference_id: string;
  candidate_id: string | null;
  code: string;
  checked_engine_sha256: string | null;
};
type CandidateRow = {
  candidate_id: string;
  job_id: string;
  attempt_no: number;
  directory: string;
  manifest_json: string;
  state: string;
  durable_at: number | null;
};

function rows(storage: StorageFixture) {
  return snapshot(storage, (db) => ({
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
      .all() as CandidateRow[],
    slot: db.prepare("SELECT * FROM execution_slot").all() as {
      singleton: number;
      job_id: string;
      attempt_no: number;
      fence: number;
    }[],
  }));
}

function canonicalBytes(value: unknown) {
  return Buffer.from(JSON.stringify(canonicalCopy(value)), "utf8");
}

function parsedBytes(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function replacementUuid(existing: readonly string[]) {
  const id = randomUUID();
  assert.ok(validIdentifier(id));
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(existing.includes(id), false);
  for (const original of existing) assert.equal(id.length, original.length);
  return id;
}

function assertRecords(
  records: DurableInterruptionRecords,
  scope: InterruptionReadScope,
) {
  for (const record of Object.values(records)) {
    assert.deepEqual(record.scope, scope);
    assert.ok(validIdentifier(record.recordId));
    assert.equal(Object.isFrozen(record), true);
  }
  assert.equal(records.authorization.kind, "authorized");
  assert.equal(records.controllerLoss.kind, "controller-lost");
  assert.equal(records.terminal.kind, "terminal");
  assert.equal(records.terminal.completion, "interrupted");
  assert.equal(records.terminal.treeExited, true);
  assert.equal(records.terminal.authorizationsSealed, true);
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
  assert.equal(
    new Set(Object.values(records).map((record) => record.recordId)).size,
    3,
  );
}

// 仅用于输入预断言：照固定 records helper 的三种终局形状计算私有 bound。
// 真实 scope、真实 UUID 与 128 反斜杠分支决定长度；不参与任何业务裁决。
function terminalTrustedBound(
  scope: InterruptionReadScope,
  actual: DurableInterruptionRecords["terminal"],
) {
  assert.equal(actual.recordId.length, actual.authorizationRecordId.length);
  assert.equal(actual.recordId.length, actual.controllerLossRecordId.length);
  assert.equal(actual.recordId.length, randomUUID().length);
  return Math.max(
    canonicalBytes(actual).length,
    canonicalBytes({
      v: 1,
      kind: "completed",
      scope,
      completion: {
        kind: "failure",
        exitCode: -Number.MAX_SAFE_INTEGER,
        signal: null,
      },
      treeExited: true,
      authorizationsSealed: true,
    }).length,
    canonicalBytes({
      v: 1,
      kind: "completed",
      scope,
      completion: { kind: "failure", exitCode: null, signal: "\\".repeat(128) },
      treeExited: true,
      authorizationsSealed: true,
    }).length,
  );
}

function traceStore(store: EnhancementStore) {
  const restartCalls: { key: ArtifactWorkKey; signal: AbortSignal }[] = [];
  const restart = store.restartInterruptedAttempt.bind(store);
  store.restartInterruptedAttempt = (key, signal) => {
    restartCalls.push({ key, signal });
    return restart(key, signal);
  };
  const acquire = traceArtifactCommit<
    Parameters<EnhancementStore["acquireArtifactWork"]>,
    ReturnType<EnhancementStore["acquireArtifactWork"]>,
    undefined
  >(store.acquireArtifactWork.bind(store), () => undefined);
  const read = traceArtifactCommit<
    Parameters<EnhancementStore["readArtifactWork"]>,
    ReturnType<EnhancementStore["readArtifactWork"]>,
    undefined
  >(store.readArtifactWork.bind(store), () => undefined);
  const reserve = traceArtifactCommit<
    Parameters<EnhancementStore["reserveArtifactCandidate"]>,
    ReturnType<EnhancementStore["reserveArtifactCandidate"]>,
    undefined
  >(store.reserveArtifactCandidate.bind(store), () => undefined);
  const durable = traceArtifactCommit<
    Parameters<EnhancementStore["recordArtifactCandidate"]>,
    ReturnType<EnhancementStore["recordArtifactCandidate"]>,
    undefined
  >(store.recordArtifactCandidate.bind(store), () => undefined);
  const success = traceArtifactCommit<
    Parameters<EnhancementStore["finishSucceeded"]>,
    ReturnType<EnhancementStore["finishSucceeded"]>,
    undefined
  >(store.finishSucceeded.bind(store), () => undefined);
  const prepared = traceArtifactCommit<
    Parameters<EnhancementStore["registerPrepared"]>,
    ReturnType<EnhancementStore["registerPrepared"]>,
    undefined
  >(store.registerPrepared.bind(store), () => undefined);
  const authorized = traceArtifactCommit<
    Parameters<EnhancementStore["authorizeLaunch"]>,
    ReturnType<EnhancementStore["authorizeLaunch"]>,
    undefined
  >(store.authorizeLaunch.bind(store), () => undefined);
  store.acquireArtifactWork = acquire.invoke;
  store.readArtifactWork = read.invoke;
  store.reserveArtifactCandidate = reserve.invoke;
  store.recordArtifactCandidate = durable.invoke;
  store.finishSucceeded = success.invoke;
  store.registerPrepared = prepared.invoke;
  store.authorizeLaunch = authorized.invoke;
  return {
    restartCalls,
    acquire,
    read,
    reserve,
    durable,
    success,
    prepared,
    authorized,
  };
}

type ReaderCall = {
  scope: InterruptionReadScope;
  stillCurrent: () => boolean;
  returned: boolean;
  records?: DurableInterruptionRecords;
  error?: unknown;
};

function constructStore(f: AuthorizedRecoveryFixture, withReader: boolean) {
  const readerCalls: ReaderCall[] = [];
  const originalReader = f.executor.adapter.readInterruptionEvidence;
  const reader: InterruptionEvidenceReader = async (scope, stillCurrent) => {
    const call: ReaderCall = { scope, stillCurrent, returned: false };
    readerCalls.push(call);
    try {
      const records = await originalReader(scope, stillCurrent);
      call.records = records;
      call.returned = true;
      return records;
    } catch (error) {
      call.error = error;
      throw error;
    }
  };
  // 装配先于本轮 control/ref/key；此后不换 reader 或 store incarnation。
  assert.equal(rows(f.storage).references.length, 0);
  assert.equal(rows(f.storage).controls.length, 0);
  f.storage.store.close();
  f.storage.setStore(
    openStore({
      directory: f.storage.directory,
      clock: f.storage.clock,
      ...(withReader ? { interruptionEvidenceReader: reader } : {}),
    }),
  );
  return { readerCalls, withReader, trace: traceStore(f.storage.store) };
}

async function actualRecords(
  f: AuthorizedRecoveryFixture,
  original: ClaimedAttempt,
) {
  const authorization = await f.executor.recordBytes(
    target(original),
    "authorization",
  );
  const loss = await f.executor.recordBytes(
    target(original),
    "controller-loss",
  );
  const terminal = await f.executor.recordBytes(target(original), "terminal");
  assert.ok(authorization && loss && terminal);
  const records = canonicalCopy({
    authorization: parsedBytes(authorization),
    controllerLoss: parsedBytes(loss),
    terminal: parsedBytes(terminal),
  }) as DurableInterruptionRecords;
  assert.deepEqual(canonicalBytes(records.authorization), authorization);
  assert.deepEqual(canonicalBytes(records.controllerLoss), loss);
  assert.deepEqual(canonicalBytes(records.terminal), terminal);
  return {
    records,
    bytes: { authorization, "controller-loss": loss, terminal },
  };
}

async function newSource(
  options: {
    reopen?: boolean;
    reader?: boolean;
    storeAuthorization?: boolean;
    png?: boolean;
  } = {},
) {
  const f = await authorizedRecoveryFixture();
  try {
    // 只有同 incarnation 项保留这个在 submit 前装配的 store。
    const initial = constructStore(f, true);
    await f.submit();
    const original = f.storage.store.claimNext("qualification-producer");
    assert.ok(original);
    const owner = await f.executor.adapter.prepare(
      original,
      fixturePrepareGuard(f.storage.store, original),
    );
    assert.equal(
      f.storage.store.registerPrepared(original.identity, owner),
      true,
    );
    if (options.storeAuthorization !== false)
      assert.equal(
        f.storage.store.authorizeLaunch(original.identity, owner),
        true,
      );
    // The missing-store-AUTH case deliberately constructs a native-record/store
    // mismatch in the historical nonconforming fixture; it proves qualification
    // rejection, never permission to send under ExecutionSendGuard.
    await f.executor.adapter.authorize(
      original,
      owner,
      options.storeAuthorization === false
        ? fixtureSendGuard(() => true)
        : fixtureAuthorizeGuard(f.storage.store, original, owner),
    );
    assert.equal(f.allLaunchCalls.length, 1);
    const accepted = rows(f.storage);
    assert.equal(accepted.attempts.length, 1);
    assert.equal(accepted.events.length, 0);
    assert.equal(accepted.references.length, 0);
    assert.equal(
      accepted.attempts[0]!.authorized_at === null,
      options.storeAuthorization === false,
    );
    const png = options.png ? await nativePng(original) : undefined;
    if (png) await writeActualFile(original.outputPath, png);
    await f.executor.loseController(target(original));
    const oldFacade = f.executor;
    let assembly = initial;
    if (options.reopen !== false) {
      await f.reopen();
      assert.equal(oldFacade.retired, true);
      assert.notEqual(f.executor, oldFacade);
      assembly = constructStore(f, options.reader !== false);
    } else {
      assert.equal(f.executor, oldFacade);
      assert.equal(oldFacade.retired, false);
      assert.notEqual(options.reader, false);
    }
    const scope: InterruptionReadScope = {
      target: target(original),
      descriptor: owner,
    };
    const actual = await actualRecords(f, original);
    assertRecords(actual.records, scope);
    assert.equal(assembly.readerCalls.length, 0);
    return { f, original, owner, scope, accepted, png, ...assembly, ...actual };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

type Source = Awaited<ReturnType<typeof newSource>>;

function assertOriginalFacts(
  s: Source,
  state: ReturnType<typeof rows>,
  raw?: ExecutionExit,
) {
  const current = state.attempts[0];
  const original = s.accepted.attempts[0];
  const job = state.jobs[0];
  const acceptedJob = s.accepted.jobs[0];
  assert.ok(current && original && job && acceptedJob);
  for (const field of [
    "producer_identity_json",
    "producer_incarnation_id",
    "launch_ticket",
    "run_directory",
    "tile",
    "owner_descriptor_json",
    "prepared_at",
    "authorized_at",
    "sealed_at",
  ] as const)
    assert.equal(current[field], original[field]);
  for (const field of [
    "source_json",
    "engine_json",
    "plan_json",
    "execution_policy_json",
    "first_started_at",
    "execution_deadline_at",
    "cancel_requested_at",
  ] as const)
    assert.equal(job[field], acceptedJob[field]);
  assert.deepEqual(
    JSON.parse(current.producer_identity_json),
    s.original.identity,
  );
  assert.equal(current.launch_ticket, s.original.launchTicket);
  assert.equal(current.stop_reason, null);
  assert.equal(current.sealed_at, null);
  assert.equal(job.status, "running");
  assert.equal(job.reason, null);
  assert.equal(job.result_candidate_id, null);
  if (raw) assert.deepEqual(JSON.parse(current.exit_json!), raw);
}

async function inspectSource(s: Source, session: RecoverySession) {
  assert.deepEqual(session.target, target(s.original));
  assert.deepEqual(session.active.ownerDescriptor, s.owner);
  const inspected = await s.f.executor.adapter.inspect(
    session.target,
    session.active.ownerDescriptor,
  );
  assert.equal(inspected.kind, "tree-exited");
  if (inspected.kind !== "tree-exited")
    assert.fail("必须读取真实 interrupted terminal");
  assert.deepEqual(inspected.exit.completion, {
    kind: "interrupted",
    authorizationRecordId: s.records.authorization.recordId,
    controllerLossRecordId: s.records.controllerLoss.recordId,
    terminalRecordId: s.records.terminal.recordId,
  });
  return inspected;
}

async function applySession(
  s: Source,
  session: RecoverySession,
  rawField?: keyof Omit<InterruptedCompletion, "kind">,
) {
  const before = rows(s.f.storage);
  const inspected = await inspectSource(s, session);
  let appliedInspection = inspected;
  if (rawField) {
    const completion = inspected.exit.completion;
    assert.ok(completion?.kind === "interrupted");
    const wrongId = replacementUuid(
      Object.values(s.records).map((record) => record.recordId),
    );
    appliedInspection = {
      kind: "tree-exited",
      exit: {
        ...inspected.exit,
        completion: { ...completion, [rawField]: wrongId },
      },
    };
    assert.deepEqual(
      {
        ...appliedInspection.exit.completion,
        [rawField]: completion[rawField],
      },
      completion,
    );
  }
  const moved = s.f.storage.store.applyRecoveryInspection(
    session.control,
    appliedInspection,
  );
  assert.ok(moved?.kind === "transferred");
  assert.equal(moved.startupEventId, null);
  const baseline = rows(s.f.storage);
  assert.equal(baseline.attempts.length, 1);
  assert.equal(baseline.events.length, 0);
  assert.deepEqual(baseline.references, before.references);
  assert.deepEqual(baseline.candidates, before.candidates);
  assertOriginalFacts(s, baseline, appliedInspection.exit);
  const control = baseline.controls.find(
    (row) => row.recovery_id === session.control.recoveryId,
  );
  assert.ok(control);
  assert.equal(control.state, "consumed");
  assert.equal(control.classification, "tree-exited");
  assert.notEqual(control.observed_at, null);
  assert.notEqual(control.consumed_at, null);
  assert.equal(
    control.source_incarnation_id,
    s.accepted.attempts[0]!.producer_incarnation_id,
  );
  assert.deepEqual(
    JSON.parse(control.source_identity_json),
    s.original.identity,
  );
  const pre = JSON.parse(control.publisher_identity_json) as AttemptIdentity;
  assert.deepEqual(pre, session.control.publisher);
  assert.ok(Number.isSafeInteger(pre.fence + 1));
  assert.deepEqual(
    {
      ...pre,
      ownerInstanceId: control.owner_instance_id,
      fence: pre.fence + 1,
    },
    moved.publisher,
  );
  assert.deepEqual(baseline.slot, [
    {
      singleton: 1,
      job_id: s.original.identity.jobId,
      attempt_no: s.original.identity.attemptNo,
      fence: moved.publisher.fence,
    },
  ]);
  assert.equal(
    baseline.attempts[0]!.owner_instance_id,
    moved.publisher.ownerInstanceId,
  );
  assert.equal(baseline.attempts[0]!.fence, moved.publisher.fence);
  return {
    ...s,
    session,
    inspected,
    appliedInspection,
    publisher: moved.publisher,
    baseline,
  };
}

async function qualificationSource(
  options: Parameters<typeof newSource>[0] & {
    rawField?: keyof Omit<InterruptedCompletion, "kind">;
  } = {},
) {
  const s = await newSource(options);
  try {
    const session = s.f.storage.store.beginRecovery("qualification-publisher");
    assert.ok(session);
    return await applySession(s, session, options.rawField);
  } catch (error) {
    await s.f.cleanup();
    throw error;
  }
}

type QualifiedSource = Awaited<ReturnType<typeof qualificationSource>>;

function assertSameEnvironment(subject: Source, positive: Source) {
  assert.notEqual(subject.f.storage.directory, positive.f.storage.directory);
  assert.equal(subject.f.storage.clock(), positive.f.storage.clock());
  assert.deepEqual(subject.original.job.source, positive.original.job.source);
  assert.deepEqual(
    subject.original.job.engineInput,
    positive.original.job.engineInput,
  );
  assert.deepEqual(subject.original.job.plan, positive.original.job.plan);
  assert.deepEqual(
    subject.original.executionPolicy,
    positive.original.executionPolicy,
  );
  assert.equal(subject.original.tile, positive.original.tile);
  assert.equal(
    subject.original.firstStartedAt,
    positive.original.firstStartedAt,
  );
  assert.equal(
    subject.original.executionDeadlineAt,
    positive.original.executionDeadlineAt,
  );
  assert.equal(
    subject.original.leaseExpiresAt,
    positive.original.leaseExpiresAt,
  );
  assert.equal(
    subject.f.executor.adapter.kind,
    positive.f.executor.adapter.kind,
  );
  assert.equal(subject.owner.adapterId, positive.owner.adapterId);
  assert.deepEqual(subject.owner.details, positive.owner.details);
  assert.deepEqual(
    Object.keys(subject.f.actualFiles).sort(),
    Object.keys(positive.f.actualFiles).sort(),
  );
  assert.equal(subject.f.executor.hooks.before, undefined);
  assert.equal(subject.f.executor.hooks.after, undefined);
  assert.equal(positive.f.executor.hooks.before, undefined);
  assert.equal(positive.f.executor.hooks.after, undefined);
}

function mark(s: Source) {
  return {
    readerEvents: s.f.executor.events.length,
    readerCalls: s.readerCalls.length,
    artifactEvents: s.f.artifactEvents.length,
    restartCalls: s.trace.restartCalls.length,
    acquire: s.trace.acquire.calls.length,
    read: s.trace.read.calls.length,
    reserve: s.trace.reserve.calls.length,
    durable: s.trace.durable.calls.length,
    success: s.trace.success.calls.length,
    prepared: s.trace.prepared.calls.length,
    authorized: s.trace.authorized.calls.length,
    launches: s.f.allLaunchCalls.length,
  };
}

type Marker = ReturnType<typeof mark>;

function readerEvents(s: Source, start: Marker) {
  return s.f.executor.events
    .slice(start.readerEvents)
    .filter((event) => event.operation === "reader");
}

function assertReadToEof(
  events: readonly DurableIoEvent[],
  role: DurableIoEvent["role"],
  cleanup = false,
) {
  const data = events.findIndex(
    (event) =>
      event.role === role &&
      event.stage === "read" &&
      event.phase === "after" &&
      (event.bytesRead ?? 0) > 0,
  );
  const eof = events.findIndex(
    (event, index) =>
      index > data &&
      event.role === role &&
      event.stage === "read" &&
      event.phase === "after" &&
      event.bytesRead === 0,
  );
  assert.ok(data >= 0, `${role} 必须实际读取非零正文`);
  assert.ok(eof > data, `${role} 必须从同一读取链读到 EOF`);
  assert.ok(
    events.some(
      (event, index) =>
        index > eof &&
        event.role === role &&
        event.stage === "close" &&
        event.phase === "after" &&
        (!cleanup || event.cleanup === true),
    ),
    `${role} 必须在 EOF 后实际关闭句柄`,
  );
}

function assertEngineRead(s: Source, start: Marker, expected?: Buffer) {
  const events = s.f.artifactEvents
    .slice(start.artifactEvents)
    .filter((event) => event.path === s.original.inputPath);
  const reads = events.filter(
    (event) => event.stage === "read" && (event.bytesRead ?? 0) > 0,
  );
  assert.ok(reads.length > 0);
  let position = 0;
  for (const read of reads) {
    assert.equal(read.position, position);
    assert.ok(read.bytes);
    assert.equal(read.bytes.length, read.bytesRead);
    position += read.bytes.length;
  }
  const actual = Buffer.concat(reads.map((event) => event.bytes!));
  assert.equal(actual.length, s.original.job.engineInput.byteLength);
  if (expected) assert.deepEqual(actual, expected);
  else assert.equal(sha256(actual), s.original.job.engineInput.sha256);
  assert.ok(
    events.some(
      (event) => event.stage === "stat" && event.size === actual.length,
    ),
  );
  assert.ok(
    events.some((event) => event.stage === "read" && event.bytesRead === 0),
  );
  assert.ok(events.some((event) => event.stage === "close"));
}

function assertNoLaunchOrPublication(s: Source, start: Marker) {
  assert.equal(
    s.f.artifactEvents
      .slice(start.artifactEvents)
      .some(
        (event) =>
          (event.stage === "open" && event.flags !== "r") ||
          event.stage === "file_sync" ||
          event.stage === "directory_sync",
      ),
    false,
  );
  assert.equal(s.trace.reserve.calls.length, start.reserve);
  assert.equal(s.trace.durable.calls.length, start.durable);
  assert.equal(s.trace.success.calls.length, start.success);
  assert.equal(s.trace.prepared.calls.length, start.prepared);
  assert.equal(s.trace.authorized.calls.length, start.authorized);
  assert.equal(s.f.allLaunchCalls.length, start.launches);
  assert.equal(
    s.f.executor.events
      .slice(start.readerEvents)
      .some(
        (event) =>
          event.operation === "prepare" ||
          event.operation === "authorize" ||
          event.stage === "start",
      ),
    false,
  );
}

function assertStable(
  s: QualifiedSource,
  before: ReturnType<typeof rows>,
  after: ReturnType<typeof rows>,
) {
  assert.equal(after.attempts.length, 1);
  assert.equal(after.events.length, 0);
  assert.deepEqual(after.slot, before.slot);
  assert.deepEqual(after.candidates, before.candidates);
  assert.deepEqual(after.controls, before.controls);
  assertOriginalFacts(s, after, s.appliedInspection.exit);
  for (const field of [
    "owner_instance_id",
    "fence",
    "lease_expires_at",
    "exit_json",
    "exit_observed_at",
    "stop_reason",
  ] as const)
    assert.equal(after.attempts[0]![field], before.attempts[0]![field]);
  for (const field of [
    "status",
    "reason",
    "result_candidate_id",
    "active_attempt_no",
    "current_fence",
  ] as const)
    assert.equal(after.jobs[0]![field], before.jobs[0]![field]);
  for (const held of before.references)
    assert.deepEqual(
      after.references.find((row) => row.reference_id === held.reference_id),
      held,
    );
}

function assertReference(
  s: QualifiedSource,
  state: ReturnType<typeof rows>,
  key: ArtifactWorkKey,
  released: boolean,
) {
  const ref = state.references.find(
    (row) => row.reference_id === key.referenceId,
  );
  assert.ok(ref);
  assert.deepEqual(key.publisher, s.publisher);
  assert.deepEqual(JSON.parse(ref.publisher_identity_json), s.publisher);
  assert.equal(
    ref.incarnation_id,
    s.baseline.controls.find(
      (control) => control.recovery_id === s.session.control.recoveryId,
    )!.incarnation_id,
  );
  assert.equal(ref.purpose, "recovery");
  assert.equal(ref.candidate_id, null);
  assert.equal(ref.job_id, s.original.identity.jobId);
  assert.equal(ref.attempt_no, s.original.identity.attemptNo);
  assert.equal(ref.released_at === null, !released);
  assert.deepEqual(
    state.observations
      .filter((row) => row.reference_id === ref.reference_id)
      .map((row) => ({
        candidateId: row.candidate_id,
        code: row.code,
        checkedEngineSha256: row.checked_engine_sha256,
      })),
    [
      {
        candidateId: null,
        code: "no_qualified_candidate",
        checkedEngineSha256: s.original.job.engineInput.sha256,
      },
    ],
  );
  return ref;
}

async function rejectedRecovery(s: QualifiedSource) {
  const before = rows(s.f.storage);
  const start = mark(s);
  const result = await s.f.track(
    createArtifacts({
      store: s.f.storage.store,
      files: s.f.actualFiles,
    }).recover(s.publisher, s.f.signal),
  );
  assert.equal(result.kind, "settled");
  if (result.kind !== "settled") assert.fail("资格负例不得创建 replacement");
  assert.ok(
    result.verdict === "blocked" || result.verdict === "no-qualified-candidate",
  );
  assert.equal(s.trace.restartCalls.length, start.restartCalls + 1);
  const call = s.trace.restartCalls[start.restartCalls];
  assert.ok(call);
  assert.equal(call.signal, s.f.signal);
  const after = rows(s.f.storage);
  assertStable(s, before, after);
  assert.equal(after.references.length, before.references.length + 1);
  const ref = assertReference(s, after, call.key, false);
  assert.equal(s.f.storage.store.readArtifactReference(call.key), "held");
  assertEngineRead(s, start);
  assertNoLaunchOrPublication(s, start);
  return {
    before,
    after,
    start,
    result,
    key: call.key,
    signal: call.signal,
    ref,
    events: readerEvents(s, start),
  };
}

function assertReaderRejected(s: Source, start: Marker) {
  assert.equal(s.readerCalls.length, start.readerCalls + 1);
  const call = s.readerCalls[start.readerCalls];
  assert.ok(call);
  assert.deepEqual(call.scope, s.scope);
  assert.equal(call.returned, true);
  assert.equal(call.error, undefined);
  assert.equal(call.records, undefined);
}

async function createdRecovery(s: QualifiedSource) {
  const before = rows(s.f.storage);
  const start = mark(s);
  const result = await s.f.track(
    createArtifacts({
      store: s.f.storage.store,
      files: s.f.actualFiles,
    }).recover(s.publisher, s.f.signal),
  );
  assert.equal(result.kind, "restarted");
  if (result.kind !== "restarted")
    assert.fail("无扰动正控必须通过真实 recover 创建 replacement");
  assert.equal(result.outcome.kind, "created");
  if (result.outcome.kind !== "created") assert.fail("fresh 正控必须 created");
  assert.equal(s.trace.restartCalls.length, start.restartCalls + 1);
  assert.equal(s.readerCalls.length, start.readerCalls + 1);
  const call = s.trace.restartCalls[start.restartCalls];
  const reader = s.readerCalls[start.readerCalls];
  assert.ok(call && reader?.records);
  assert.equal(call.signal, s.f.signal);
  assert.equal(reader.returned, true);
  assert.equal(reader.error, undefined);
  assertRecords(reader.records, s.scope);
  assert.deepEqual(reader.records, s.records);
  const events = readerEvents(s, start);
  for (const role of ["authorization", "controller-loss", "terminal"] as const)
    assertReadToEof(events, role);
  assert.ok(
    events.some(
      (event) =>
        event.role === "sealed" &&
        event.stage === "directory-sync" &&
        event.phase === "after",
    ),
  );
  assertEngineRead(s, start);
  assertNoLaunchOrPublication(s, start);
  const after = rows(s.f.storage);
  assert.equal(after.attempts.length, 2);
  assert.equal(after.events.length, 1);
  assert.deepEqual(after.controls, before.controls);
  assert.equal(after.references.length, before.references.length + 1);
  assert.equal(after.candidates.length, 0);
  const ref = assertReference(s, after, call.key, true);
  for (const oldRef of before.references)
    assert.deepEqual(
      after.references.find((row) => row.reference_id === oldRef.reference_id),
      oldRef,
    );
  assertOriginalFacts(s, after, s.appliedInspection.exit);
  const event = after.events[0]!;
  assert.equal(event.kind, "authorized-interruption");
  assert.equal(event.sealed_at, null);
  assert.notEqual(event.consumed_at, null);
  assert.equal(event.launch_ticket, s.original.launchTicket);
  assert.equal(
    event.source_incarnation_id,
    s.accepted.attempts[0]!.producer_incarnation_id,
  );
  assert.equal(event.recovery_incarnation_id, ref.incarnation_id);
  assert.deepEqual(JSON.parse(event.source_identity_json), s.original.identity);
  assert.deepEqual(
    JSON.parse(event.consumed_publisher_identity_json!),
    s.publisher,
  );
  assert.deepEqual(JSON.parse(event.evidence_json!), {
    v: 1,
    recoveryId: s.session.control.recoveryId,
    referenceId: ref.reference_id,
    records: s.records,
  });
  const replacement = result.outcome.attempt;
  assert.equal(event.replacement_attempt_no, replacement.identity.attemptNo);
  assert.equal(
    replacement.identity.attemptNo,
    s.original.identity.attemptNo + 1,
  );
  assert.equal(replacement.identity.fence, s.publisher.fence + 1);
  assert.equal(replacement.identity.jobId, s.original.identity.jobId);
  assert.equal(
    replacement.identity.ownerInstanceId,
    s.publisher.ownerInstanceId,
  );
  assert.notEqual(replacement.launchTicket, s.original.launchTicket);
  assert.notEqual(replacement.workingDirectory, s.original.workingDirectory);
  assert.equal(replacement.inputPath, s.original.inputPath);
  assert.equal(replacement.tile, s.original.tile);
  assert.deepEqual(replacement.executionPolicy, s.original.executionPolicy);
  assert.deepEqual(replacement.job.source, s.original.job.source);
  assert.deepEqual(replacement.job.engineInput, s.original.job.engineInput);
  assert.deepEqual(replacement.job.plan, s.original.job.plan);
  assert.equal(replacement.firstStartedAt, s.original.firstStartedAt);
  assert.equal(replacement.executionDeadlineAt, s.original.executionDeadlineAt);
  const newAttempt = after.attempts[1]!;
  assert.equal(newAttempt.owner_descriptor_json, null);
  assert.equal(newAttempt.prepared_at, null);
  assert.equal(newAttempt.authorized_at, null);
  assert.equal(newAttempt.exit_json, null);
  assert.equal(newAttempt.sealed_at, null);
  assert.deepEqual(after.slot, [
    {
      singleton: 1,
      job_id: replacement.identity.jobId,
      attempt_no: replacement.identity.attemptNo,
      fence: replacement.identity.fence,
    },
  ]);
  assert.equal(
    after.jobs[0]!.active_attempt_no,
    replacement.identity.attemptNo,
  );
  assert.equal(after.jobs[0]!.current_fence, replacement.identity.fence);
  return { after, start, key: call.key, ref, replacement, event };
}

async function rewrite(
  s: Source,
  role: Exclude<RecordRole, "prepared">,
  replacement: Buffer | undefined,
) {
  await s.f.executor.rewriteRecordBytes(target(s.original), role, (actual) => {
    assert.deepEqual(actual, s.bytes[role]);
    return replacement;
  });
}

function assertCanonicalWithinBound(
  s: Source,
  role: Exclude<RecordRole, "prepared">,
  replacement: Buffer,
) {
  assert.deepEqual(canonicalBytes(parsedBytes(replacement)), replacement);
  if (role === "terminal")
    assert.ok(
      replacement.length < terminalTrustedBound(s.scope, s.records.terminal),
    );
  else assert.equal(replacement.length, s.bytes[role].length);
}

async function qualificationPair(
  options: Parameters<typeof qualificationSource>[0] = {},
) {
  const subject = await qualificationSource(options);
  try {
    const positive = await qualificationSource();
    try {
      assertSameEnvironment(subject, positive);
      assert.equal(subject.withReader, options.reader !== false);
      assert.equal(positive.withReader, true);
      return {
        subject,
        positive,
        async cleanup() {
          await Promise.all([subject.f.cleanup(), positive.f.cleanup()]);
        },
      };
    } catch (error) {
      await positive.f.cleanup();
      throw error;
    }
  } catch (error) {
    await subject.f.cleanup();
    throw error;
  }
}

function assertRawMismatchReader(
  s: QualifiedSource,
  run: Awaited<ReturnType<typeof rejectedRecovery>>,
  field: keyof Omit<InterruptedCompletion, "kind">,
) {
  assert.equal(s.readerCalls.length, run.start.readerCalls + 1);
  const call = s.readerCalls[run.start.readerCalls];
  assert.ok(call?.records);
  assert.equal(call.returned, true);
  assert.equal(call.error, undefined);
  assertRecords(call.records, s.scope);
  assert.deepEqual(call.records, s.records);
  const raw = JSON.parse(run.after.attempts[0]!.exit_json!) as ExecutionExit;
  const actual = s.inspected.exit.completion;
  assert.ok(
    raw.completion?.kind === "interrupted" && actual?.kind === "interrupted",
  );
  assert.notEqual(raw.completion[field], actual[field]);
  assert.ok(validIdentifier(raw.completion[field]));
  assert.equal(raw.completion[field].length, actual[field].length);
  assert.deepEqual({ ...raw.completion, [field]: actual[field] }, actual);
  for (const role of ["authorization", "controller-loss", "terminal"] as const)
    assertReadToEof(run.events, role);
}

describe("authorized interruption recovery qualification R1", () => {
  it("refuses recovery when the final reader cannot reopen authorization", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      await rewrite(s, "authorization", undefined);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assert.ok(
        run.events.some(
          (event) =>
            event.role === "authorization" &&
            event.stage === "open" &&
            event.phase === "after" &&
            event.missing === true,
        ),
      );
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses recovery when the final reader cannot reopen controller loss", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      await rewrite(s, "controller-loss", undefined);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assert.ok(
        run.events.some(
          (event) =>
            event.role === "controller-loss" &&
            event.stage === "open" &&
            event.phase === "after" &&
            event.missing === true,
        ),
      );
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses recovery when the final reader cannot reopen the interrupted terminal", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      await rewrite(s, "terminal", undefined);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assert.ok(
        run.events.some(
          (event) =>
            event.role === "terminal" &&
            event.stage === "open" &&
            event.phase === "after" &&
            event.missing === true,
        ),
      );
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a raw authorization id that differs from the durably reread record", async () => {
    const pair = await qualificationPair({ rawField: "authorizationRecordId" });
    const { subject: s, positive } = pair;
    try {
      const run = await rejectedRecovery(s);
      assertRawMismatchReader(s, run, "authorizationRecordId");
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a raw controller loss id that differs from the durably reread record", async () => {
    const pair = await qualificationPair({
      rawField: "controllerLossRecordId",
    });
    const { subject: s, positive } = pair;
    try {
      const run = await rejectedRecovery(s);
      assertRawMismatchReader(s, run, "controllerLossRecordId");
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a raw terminal id that differs from the durably reread record", async () => {
    const pair = await qualificationPair({ rawField: "terminalRecordId" });
    const { subject: s, positive } = pair;
    try {
      const run = await rejectedRecovery(s);
      assertRawMismatchReader(s, run, "terminalRecordId");
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a durably reread loss that names another authorization", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.records.controllerLoss;
      const changed = {
        ...original,
        authorizationRecordId: replacementUuid(
          Object.values(s.records).map((record) => record.recordId),
        ),
      };
      assert.deepEqual(
        { ...changed, authorizationRecordId: original.authorizationRecordId },
        original,
      );
      assert.deepEqual(checkedScope(changed.scope), s.scope);
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "controller-loss", bytes);
      await rewrite(s, "controller-loss", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      for (const role of [
        "authorization",
        "controller-loss",
        "terminal",
      ] as const)
        assertReadToEof(run.events, role);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a durably reread terminal that names another authorization", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.records.terminal;
      const changed = {
        ...original,
        authorizationRecordId: replacementUuid(
          Object.values(s.records).map((record) => record.recordId),
        ),
      };
      assert.deepEqual(
        { ...changed, authorizationRecordId: original.authorizationRecordId },
        original,
      );
      assert.deepEqual(checkedScope(changed.scope), s.scope);
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "terminal", bytes);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal");
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a durably reread terminal that names another controller loss", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.records.terminal;
      const changed = {
        ...original,
        controllerLossRecordId: replacementUuid(
          Object.values(s.records).map((record) => record.recordId),
        ),
      };
      assert.deepEqual(
        { ...changed, controllerLossRecordId: original.controllerLossRecordId },
        original,
      );
      assert.deepEqual(checkedScope(changed.scope), s.scope);
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "terminal", bytes);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal");
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses an interrupted terminal whose record id repeats the authorization id", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.records.terminal;
      const changed = {
        ...original,
        recordId: s.records.authorization.recordId,
      };
      assert.notEqual(original.recordId, changed.recordId);
      assert.ok(validIdentifier(changed.recordId));
      assert.equal(changed.recordId.length, original.recordId.length);
      assert.equal(
        changed.authorizationRecordId,
        s.records.authorization.recordId,
      );
      assert.equal(
        changed.controllerLossRecordId,
        s.records.controllerLoss.recordId,
      );
      assert.deepEqual({ ...changed, recordId: original.recordId }, original);
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "terminal", bytes);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal");
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a record scoped to a publisher fence instead of the original producer", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.records.authorization;
      assert.notEqual(s.publisher.fence, s.original.identity.fence);
      assert.equal(
        String(s.publisher.fence).length,
        String(s.original.identity.fence).length,
      );
      const changed = {
        ...original,
        scope: {
          ...original.scope,
          target: {
            ...original.scope.target,
            identity: {
              ...original.scope.target.identity,
              fence: s.publisher.fence,
            },
          },
        },
      };
      assert.equal(
        changed.scope.target.identity.ownerInstanceId,
        s.original.identity.ownerInstanceId,
      );
      assert.deepEqual(checkedScope(changed.scope), changed.scope);
      assert.deepEqual(
        {
          ...changed,
          scope: {
            ...changed.scope,
            target: {
              ...changed.scope.target,
              identity: {
                ...changed.scope.target.identity,
                fence: s.original.identity.fence,
              },
            },
          },
        },
        original,
      );
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "authorization", bytes);
      await rewrite(s, "authorization", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "authorization", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a record whose descriptor details differ from the registered descriptor", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.records.authorization;
      const persistence = original.scope.descriptor.details.persistence;
      assert.equal(typeof persistence, "string");
      if (typeof persistence !== "string")
        assert.fail("真实 descriptor 必须含 persistence");
      const different =
        persistence.slice(0, -1) + (persistence.endsWith("x") ? "y" : "x");
      assert.equal(
        Buffer.byteLength(different),
        Buffer.byteLength(persistence),
      );
      const changed = {
        ...original,
        scope: {
          ...original.scope,
          descriptor: {
            ...original.scope.descriptor,
            details: {
              ...original.scope.descriptor.details,
              persistence: different,
            },
          },
        },
      };
      assert.deepEqual(
        freezeOwnerDescriptor(
          changed.scope.descriptor,
          s.original.launchTicket,
        ),
        changed.scope.descriptor,
      );
      assert.deepEqual(checkedScope(changed.scope), changed.scope);
      assert.deepEqual(
        {
          ...changed,
          scope: {
            ...changed.scope,
            descriptor: {
              ...changed.scope.descriptor,
              details: { ...changed.scope.descriptor.details, persistence },
            },
          },
        },
        original,
      );
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "authorization", bytes);
      await rewrite(s, "authorization", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "authorization", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a record scoped to another launch ticket", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.records.authorization;
      const ticket = replacementUuid([s.original.launchTicket]);
      const changed = {
        ...original,
        scope: {
          ...original.scope,
          target: { ...original.scope.target, launchTicket: ticket },
          descriptor: { ...original.scope.descriptor, launchTicket: ticket },
        },
      };
      assert.equal(
        changed.scope.target.launchTicket,
        changed.scope.descriptor.launchTicket,
      );
      assert.deepEqual(checkedScope(changed.scope), changed.scope);
      assert.deepEqual(
        {
          ...changed,
          scope: {
            ...changed.scope,
            target: {
              ...changed.scope.target,
              launchTicket: s.original.launchTicket,
            },
            descriptor: {
              ...changed.scope.descriptor,
              launchTicket: s.original.launchTicket,
            },
          },
        },
        original,
      );
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "authorization", bytes);
      await rewrite(s, "authorization", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "authorization", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a reread terminal that no longer proves tree exit", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      assert.equal(s.records.terminal.treeExited, true);
      const changed = { ...s.records.terminal, treeExited: false };
      assert.deepEqual({ ...changed, treeExited: true }, s.records.terminal);
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "terminal", bytes);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a reread terminal that no longer seals issued authorizations", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      assert.equal(s.records.terminal.authorizationsSealed, true);
      const changed = { ...s.records.terminal, authorizationsSealed: false };
      assert.deepEqual(
        { ...changed, authorizationsSealed: true },
        s.records.terminal,
      );
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "terminal", bytes);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a reread interruption after its actual seal directory is removed", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const ticket = resolve(
        join(
          s.f.storage.directory,
          "durable-adapter",
          "tickets",
          ticketKey(s.scope.target),
        ),
      );
      const sealed = resolve(join(ticket, "sealed"));
      assert.equal(dirname(sealed), ticket);
      assert.ok(
        ticket.startsWith(resolve(s.f.storage.directory) + "/") ||
          ticket.startsWith(resolve(s.f.storage.directory) + "\\"),
      );
      assert.equal((await stat(sealed)).isDirectory(), true);
      assert.deepEqual(await readdir(sealed), []);
      await rmdir(sealed);
      for (const role of [
        "authorization",
        "controller-loss",
        "terminal",
      ] as const)
        assert.deepEqual(
          await s.f.executor.recordBytes(target(s.original), role),
          s.bytes[role],
        );
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assert.ok(
        run.events.some(
          (event) =>
            event.role === "sealed" &&
            event.stage === "open" &&
            event.phase === "after" &&
            event.missing === true,
        ),
      );
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a canonical record with an extra persisted field", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const changed = { ...s.records.terminal, x: 1 };
      const { x, ...original } = changed;
      assert.equal(x, 1);
      assert.deepEqual(original, s.records.terminal);
      assert.equal(
        Object.keys(changed).length,
        Object.keys(original).length + 1,
      );
      const bytes = canonicalBytes(changed);
      assertCanonicalWithinBound(s, "terminal", bytes);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses duplicate keys in the bytes reread for interruption", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const original = s.bytes.terminal;
      assert.equal(original[0], "{".charCodeAt(0));
      const bytes = Buffer.concat([
        Buffer.from('{"v":1,', "ascii"),
        original.subarray(1),
      ]);
      assert.equal(bytes.length, original.length + 6);
      assert.ok(
        bytes.length < terminalTrustedBound(s.scope, s.records.terminal),
      );
      assert.deepEqual(parsedBytes(bytes), s.records.terminal);
      assert.deepEqual(canonicalBytes(parsedBytes(bytes)), original);
      assert.equal(bytes.equals(canonicalBytes(parsedBytes(bytes))), false);
      assert.equal((original.toString("utf8").match(/"v":1/g) ?? []).length, 1);
      assert.equal((bytes.toString("utf8").match(/"v":1/g) ?? []).length, 2);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses invalid utf8 bytes in a reread interruption record", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const bytes = Buffer.from(s.bytes.terminal);
      bytes[0] = 0xff;
      assert.equal(bytes.length, s.bytes.terminal.length);
      assert.deepEqual(bytes.subarray(1), s.bytes.terminal.subarray(1));
      assert.throws(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      assert.ok(
        bytes.length < terminalTrustedBound(s.scope, s.records.terminal),
      );
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses an interruption record larger than its trusted byte bound", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const bound = terminalTrustedBound(s.scope, s.records.terminal);
      const bytes = Buffer.concat([
        s.bytes.terminal,
        Buffer.alloc(bound - s.bytes.terminal.length + 1, " "),
      ]);
      assert.equal(bytes.length, bound + 1);
      assert.deepEqual(parsedBytes(bytes), s.records.terminal);
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assert.ok(
        run.events.some(
          (event) =>
            event.role === "terminal" &&
            event.stage === "stat" &&
            event.phase === "after",
        ),
      );
      assert.equal(
        run.events.some(
          (event) => event.role === "terminal" && event.stage === "read",
        ),
        false,
      );
      assert.ok(
        run.events.some(
          (event) =>
            event.role === "terminal" &&
            event.stage === "close" &&
            event.phase === "after" &&
            event.cleanup === true,
        ),
      );
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses a truncated final interruption record", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const bytes = Buffer.from(
        s.bytes.terminal.subarray(0, s.bytes.terminal.length - 1),
      );
      assert.ok(
        bytes.length > 0 &&
          bytes.length < terminalTrustedBound(s.scope, s.records.terminal),
      );
      assert.doesNotThrow(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      assert.throws(() => parsedBytes(bytes));
      await rewrite(s, "terminal", bytes);
      const run = await rejectedRecovery(s);
      assertReaderRejected(s, run.start);
      assertReadToEof(run.events, "terminal", true);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("keeps the owned recovery reference when no interruption reader was constructed", async () => {
    const pair = await qualificationPair({ reader: false });
    const { subject: s, positive } = pair;
    try {
      assert.equal(s.withReader, false);
      assert.equal(positive.withReader, true);
      assertRecords(s.records, s.scope);
      const run = await rejectedRecovery(s);
      assert.equal(s.readerCalls.length, run.start.readerCalls);
      assert.equal(run.events.length, 0);
      assert.equal(s.f.storage.store.readArtifactReference(run.key), "held");
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });
});

async function durableSuccessSource() {
  const f = await artifactRecoveryFixture();
  try {
    const original = await f.claim();
    await f.complete(original, await nativePng(original));
    const accepted = rows(f.storage);
    const store = f.storage.store;
    const finishSucceeded = store.finishSucceeded.bind(store);
    const capture: {
      seedSession?: RecoverySession;
      candidate?: ArtifactCandidate;
      actualFinishCalls: number;
      actualFinishResult?: boolean;
      activeAtFinish?: ControlRow;
    } = { actualFinishCalls: 0 };

    // trace()/settle() 绑定原 finishSucceeded 前先安装。只以真实 active
    // control 阻止最后成功 CAS；仍调用原方法、原参数并返回原结果。
    store.finishSucceeded = (key, candidateId) => {
      capture.actualFinishCalls += 1;
      assert.equal(capture.actualFinishCalls, 1);
      const read = store.readArtifactWork(key);
      assert.equal(read.kind, "active");
      if (read.kind !== "active")
        assert.fail("seed 必须先具有真实 active work");
      assert.deepEqual(read.work.key, key);
      assert.ok(read.work.candidate);
      const candidate = read.work.candidate;
      capture.candidate = candidate;
      assert.equal(candidate.candidateId, candidateId);
      assert.equal(candidate.state, "durable");
      assert.deepEqual(read.work.attempt.exit?.completion, {
        kind: "success",
        exitCode: 0,
        signal: null,
      });
      assert.ok(f.storage.clock() <= read.work.attempt.leaseExpiresAt);
      assert.ok(f.storage.clock() <= read.work.attempt.executionDeadlineAt);
      const before = rows(f.storage);
      assert.equal(before.controls.length, 0);
      assert.equal(before.candidates.length, 1);
      assert.equal(before.candidates[0]!.candidate_id, candidateId);
      assert.equal(before.candidates[0]!.state, "durable");
      assert.notEqual(before.candidates[0]!.durable_at, null);
      assert.equal(before.jobs[0]!.status, "running");
      assert.equal(before.jobs[0]!.result_candidate_id, null);
      assert.equal(before.events.length, 0);
      assert.deepEqual(before.slot, accepted.slot);
      const ref = before.references.find(
        (row) => row.reference_id === key.referenceId,
      );
      assert.ok(ref && ref.released_at === null);
      assert.equal(ref.purpose, "run");
      assert.equal(ref.candidate_id, candidateId);
      assert.deepEqual(JSON.parse(ref.publisher_identity_json), key.publisher);
      capture.seedSession = store.beginRecovery("qualification-seed-control");
      assert.ok(capture.seedSession);
      assert.deepEqual(capture.seedSession.target, target(original));
      const immediatelyBeforeFinish = rows(f.storage);
      const activeAtFinish = immediatelyBeforeFinish.controls.find(
        (control) =>
          control.recovery_id === capture.seedSession!.control.recoveryId,
      );
      assert.ok(activeAtFinish);
      capture.activeAtFinish = activeAtFinish;
      assert.equal(activeAtFinish.state, "active");
      assert.equal(activeAtFinish.consumed_at, null);
      assert.deepEqual(
        JSON.parse(activeAtFinish.source_identity_json),
        original.identity,
      );
      assert.deepEqual(
        JSON.parse(activeAtFinish.publisher_identity_json),
        original.identity,
      );
      assert.equal(
        activeAtFinish.source_incarnation_id,
        accepted.attempts[0]!.producer_incarnation_id,
      );
      capture.actualFinishResult = finishSucceeded(key, candidateId);
      assert.equal(capture.actualFinishResult, false);
      return capture.actualFinishResult;
    };
    let seedVerdict: Awaited<ReturnType<typeof f.settle>>;
    try {
      seedVerdict = await f.settle(original);
    } finally {
      store.finishSucceeded = finishSucceeded;
    }
    assert.equal(seedVerdict, "stale");
    assert.equal(capture.actualFinishCalls, 1);
    assert.equal(capture.actualFinishResult, false);
    assert.ok(
      capture.seedSession && capture.candidate && capture.activeAtFinish,
    );
    const { seedSession, candidate, activeAtFinish } = capture;
    const seed = rows(f.storage);
    assert.equal(seed.jobs[0]!.status, "running");
    assert.equal(seed.jobs[0]!.result_candidate_id, null);
    assert.equal(seed.attempts.length, 1);
    assert.equal(seed.events.length, 0);
    assert.deepEqual(seed.slot, accepted.slot);
    assert.equal(seed.candidates.length, 1);
    assert.equal(seed.candidates[0]!.state, "durable");
    assert.notEqual(seed.candidates[0]!.durable_at, null);
    assert.equal(seed.candidates[0]!.candidate_id, candidate.candidateId);
    assert.deepEqual(
      (JSON.parse(seed.attempts[0]!.exit_json!) as ExecutionExit).completion,
      { kind: "success", exitCode: 0, signal: null },
    );
    assert.deepEqual(
      seed.controls.find(
        (control) => control.recovery_id === seedSession.control.recoveryId,
      ),
      activeAtFinish,
    );
    assert.equal(seed.references.length, 1);
    assert.equal(seed.references[0]!.released_at, null);
    f.reopen();
    const trace = traceStore(f.storage.store);
    const publisher = await transferArtifactPublisher(
      f,
      original,
      "qualification-success-publisher",
    );
    const baseline = rows(f.storage);
    assert.equal(baseline.events.length, 0);
    assert.equal(baseline.attempts.length, 1);
    assert.deepEqual(baseline.candidates, seed.candidates);
    assert.deepEqual(baseline.references, seed.references);
    assert.equal(baseline.jobs[0]!.status, "running");
    assert.equal(baseline.jobs[0]!.result_candidate_id, null);
    assert.deepEqual(
      (JSON.parse(baseline.attempts[0]!.exit_json!) as ExecutionExit)
        .completion,
      { kind: "success", exitCode: 0, signal: null },
    );
    const consumed = baseline.controls.filter(
      (control) => control.state === "consumed",
    );
    assert.equal(consumed.length, 1);
    assert.notEqual(
      consumed[0]!.incarnation_id,
      consumed[0]!.source_incarnation_id,
    );
    return {
      f,
      original,
      accepted,
      seed,
      baseline,
      publisher,
      candidate,
      trace,
    };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

type DurableSuccessSource = Awaited<ReturnType<typeof durableSuccessSource>>;

function assertSuccessEnvironment(
  subject: DurableSuccessSource,
  positive: DurableSuccessSource,
) {
  assert.notEqual(subject.f.storage.directory, positive.f.storage.directory);
  assert.equal(subject.f.storage.clock(), positive.f.storage.clock());
  assert.deepEqual(subject.original.job.source, positive.original.job.source);
  assert.deepEqual(
    subject.original.job.engineInput,
    positive.original.job.engineInput,
  );
  assert.deepEqual(subject.original.job.plan, positive.original.job.plan);
  assert.deepEqual(
    subject.original.executionPolicy,
    positive.original.executionPolicy,
  );
  assert.equal(subject.original.tile, positive.original.tile);
  assert.equal(
    subject.original.firstStartedAt,
    positive.original.firstStartedAt,
  );
  assert.equal(
    subject.original.executionDeadlineAt,
    positive.original.executionDeadlineAt,
  );
  assert.equal(
    subject.original.leaseExpiresAt,
    positive.original.leaseExpiresAt,
  );
  assert.deepEqual(
    Object.keys(subject.f.files).sort(),
    Object.keys(positive.f.files).sort(),
  );
  assert.deepEqual(subject.f.hooks, positive.f.hooks);
  assert.equal(
    subject.f.executor.adapter.kind,
    positive.f.executor.adapter.kind,
  );
  assert.deepEqual(
    subject.candidate.manifest.png,
    positive.candidate.manifest.png,
  );
  assert.equal(subject.candidate.state, "durable");
  assert.equal(positive.candidate.state, "durable");
}

function assertSuccessSourceStable(
  s: DurableSuccessSource,
  after: ReturnType<typeof rows>,
  succeeded: boolean,
) {
  assert.equal(after.attempts.length, 1);
  assert.equal(after.events.length, 0);
  assert.deepEqual(after.attempts, s.baseline.attempts);
  assert.deepEqual(after.controls, s.baseline.controls);
  assert.deepEqual(after.candidates, s.baseline.candidates);
  assert.equal(after.jobs[0]!.status, succeeded ? "succeeded" : "running");
  assert.equal(after.jobs[0]!.reason, null);
  assert.equal(
    after.jobs[0]!.result_candidate_id,
    succeeded ? s.candidate.candidateId : null,
  );
  for (const field of [
    "source_json",
    "engine_json",
    "plan_json",
    "execution_policy_json",
    "first_started_at",
    "execution_deadline_at",
    "active_attempt_no",
    "current_fence",
    "cancel_requested_at",
  ] as const)
    assert.equal(after.jobs[0]![field], s.baseline.jobs[0]![field]);
  if (!succeeded) assert.deepEqual(after.slot, s.baseline.slot);
  else assert.equal(after.slot.length, 0);
  for (const oldRef of s.baseline.references)
    assert.deepEqual(
      after.references.find((ref) => ref.reference_id === oldRef.reference_id),
      oldRef,
    );
  assert.equal(after.references.length, s.baseline.references.length + 1);
  const current = after.references.filter(
    (ref) =>
      !s.baseline.references.some(
        (oldRef) => oldRef.reference_id === ref.reference_id,
      ),
  );
  assert.equal(current.length, 1);
  const ref = current[0]!;
  assert.equal(ref.candidate_id, s.candidate.candidateId);
  assert.equal(ref.purpose, "recovery");
  assert.equal(ref.job_id, s.original.identity.jobId);
  assert.equal(ref.attempt_no, s.original.identity.attemptNo);
  assert.deepEqual(JSON.parse(ref.publisher_identity_json), s.publisher);
  const control = s.baseline.controls.find((row) => row.state === "consumed");
  assert.ok(control);
  assert.equal(ref.incarnation_id, control.incarnation_id);
  assert.equal(ref.released_at === null, !succeeded);
  return ref;
}

function assertSuccessFileRead(
  s: DurableSuccessSource,
  start: number,
  path: string,
  expected?: Buffer,
) {
  const events = s.f.events
    .slice(start)
    .filter(({ phase, event }) => phase === "after" && event.path === path)
    .map(({ event }) => event);
  const reads = events.filter(
    (event) => event.stage === "read" && (event.bytesRead ?? 0) > 0,
  );
  assert.ok(reads.length > 0);
  let position = 0;
  const bytes = reads.map((event) => {
    assert.equal(event.position, position);
    assert.ok(event.buffer);
    assert.notEqual(event.offset, undefined);
    const actual = Buffer.from(
      event.buffer.subarray(event.offset!, event.offset! + event.bytesRead!),
    );
    position += actual.length;
    return actual;
  });
  const actual = Buffer.concat(bytes);
  if (expected) assert.deepEqual(actual, expected);
  assert.ok(
    events.some((event) => event.stage === "read" && event.bytesRead === 0),
  );
  assert.ok(events.some((event) => event.stage === "close"));
  return actual;
}

describe("authorized interruption recovery qualification R2", () => {
  it("restarts a true interruption with a valid png without publishing that png as success", async () => {
    const pair = await qualificationPair({ png: true });
    const { subject: s, positive } = pair;
    try {
      assert.ok(s.png);
      assert.deepEqual(await readFile(s.original.outputPath), s.png);
      assert.equal(s.appliedInspection.exit.completion?.kind, "interrupted");
      assertRecords(s.records, s.scope);
      const run = await createdRecovery(s);
      assert.equal(run.after.jobs[0]!.status, "running");
      assert.equal(run.after.jobs[0]!.result_candidate_id, null);
      assert.equal(run.after.jobs[0]!.reason, null);
      assert.equal(run.after.candidates.length, 0);
      assert.deepEqual(await readFile(s.original.outputPath), s.png);
      assert.equal(
        s.f.artifactEvents
          .slice(run.start.artifactEvents)
          .some((event) => event.path === s.original.outputPath),
        false,
      );
      assert.equal(s.trace.success.calls.length, run.start.success);
      assert.equal(s.trace.reserve.calls.length, run.start.reserve);
      assert.equal(s.trace.durable.calls.length, run.start.durable);
      assert.equal(positive.png, undefined);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("blocks interrupted recovery when the accepted engine bytes fail integrity checks", async () => {
    const pair = await qualificationPair();
    const { subject: s, positive } = pair;
    try {
      const actual = await readFile(s.original.inputPath);
      assert.equal(sha256(actual), s.original.job.engineInput.sha256);
      const corrupt = changedArtifactBytes(actual);
      assert.equal(corrupt.length, actual.length);
      await writeActualFile(s.original.inputPath, corrupt, false);
      const before = rows(s.f.storage);
      const start = mark(s);
      const result = await s.f.track(
        createArtifacts({
          store: s.f.storage.store,
          files: s.f.actualFiles,
        }).recover(s.publisher, s.f.signal),
      );
      assert.deepEqual(result, { kind: "settled", verdict: "blocked" });
      const after = rows(s.f.storage);
      assertStable(s, before, after);
      assertEngineRead(s, start, corrupt);
      assert.equal(s.trace.restartCalls.length, start.restartCalls);
      assert.equal(s.readerCalls.length, start.readerCalls);
      assert.equal(readerEvents(s, start).length, 0);
      assertNoLaunchOrPublication(s, start);
      const refs = after.references.filter(
        (ref) =>
          !before.references.some(
            (previous) => previous.reference_id === ref.reference_id,
          ),
      );
      assert.equal(refs.length, 1);
      const ref = refs[0]!;
      assert.equal(ref.released_at, null);
      assert.equal(ref.purpose, "recovery");
      assert.equal(ref.candidate_id, null);
      assert.deepEqual(JSON.parse(ref.publisher_identity_json), s.publisher);
      assert.equal(ref.incarnation_id, s.baseline.controls[0]!.incarnation_id);
      assert.equal(ref.job_id, s.original.identity.jobId);
      assert.equal(ref.attempt_no, s.original.identity.attemptNo);
      assert.deepEqual(
        after.observations
          .filter((row) => row.reference_id === ref.reference_id)
          .map((row) => ({ code: row.code, candidateId: row.candidate_id })),
        [{ code: "engine_integrity", candidateId: null }],
      );
      assert.equal(
        after.observations.some((row) => row.code === "no_qualified_candidate"),
        false,
      );
      assert.deepEqual(await readFile(s.original.inputPath), corrupt);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("blocks recovery of a corrupt durable success candidate without creating an interruption event", async () => {
    const s = await durableSuccessSource();
    let positive: DurableSuccessSource | undefined;
    try {
      positive = await durableSuccessSource();
      assertSuccessEnvironment(s, positive);
      assert.equal("readInterruptionEvidence" in s.f.executor.adapter, false);
      assert.equal(
        "readInterruptionEvidence" in positive.f.executor.adapter,
        false,
      );
      const actual = await readFile(s.candidate.pngPath);
      assert.equal(sha256(actual), s.candidate.manifest.png.sha256);
      const corrupt = changedArtifactBytes(actual);
      await writeActualFile(s.candidate.pngPath, corrupt, false);
      const marker = s.f.events.length;
      const result = await createArtifacts({
        store: s.f.storage.store,
        files: s.f.files,
      }).recover(s.publisher, s.f.controller.signal);
      assert.deepEqual(result, { kind: "settled", verdict: "blocked" });
      const after = rows(s.f.storage);
      const ref = assertSuccessSourceStable(s, after, false);
      assert.equal(
        sha256(
          assertSuccessFileRead(
            s,
            marker,
            s.original.inputPath,
            await readFile(s.original.inputPath),
          ),
        ),
        s.original.job.engineInput.sha256,
      );
      assertSuccessFileRead(s, marker, s.candidate.pngPath, corrupt);
      assertSuccessFileRead(
        s,
        marker,
        s.candidate.manifestPath,
        await readFile(s.candidate.manifestPath),
      );
      const events = s.f.events.slice(marker);
      const engineClose = events.findIndex(
        ({ phase, event }) =>
          phase === "after" &&
          event.path === s.original.inputPath &&
          event.stage === "close",
      );
      const candidateOpen = events.findIndex(
        ({ phase, event }) =>
          phase === "after" &&
          event.path === s.candidate.pngPath &&
          event.stage === "open",
      );
      assert.ok(engineClose >= 0 && candidateOpen > engineClose);
      assert.deepEqual(
        after.observations
          .filter((row) => row.reference_id === ref.reference_id)
          .map((row) => ({ code: row.code, candidateId: row.candidate_id })),
        [{ code: "candidate_integrity", candidateId: s.candidate.candidateId }],
      );
      assert.equal(
        after.observations.some((row) => row.code === "no_qualified_candidate"),
        false,
      );
      assert.equal(s.trace.restartCalls.length, 0);
      assert.equal(s.trace.reserve.calls.length, 0);
      assert.equal(s.trace.durable.calls.length, 0);
      assert.equal(s.trace.success.calls.length, 0);
      assert.equal(s.trace.prepared.calls.length, 0);
      assert.equal(s.trace.authorized.calls.length, 0);
      assert.equal(
        events.some(({ event }) => event.path === s.original.outputPath),
        false,
      );
      assert.deepEqual(await readFile(s.candidate.pngPath), corrupt);
      assert.equal(s.f.executor.launchCalls.length, 1);

      // 同一 durable 未发布 seed 的 fresh 健康正控；实际 recover 重验同候选。
      const healthyMarker = positive.f.events.length;
      const healthy = await createArtifacts({
        store: positive.f.storage.store,
        files: positive.f.files,
      }).recover(positive.publisher, positive.f.controller.signal);
      assert.deepEqual(healthy, { kind: "settled", verdict: "succeeded" });
      const healthyRows = rows(positive.f.storage);
      assertSuccessSourceStable(positive, healthyRows, true);
      assert.equal(
        sha256(
          assertSuccessFileRead(
            positive,
            healthyMarker,
            positive.original.inputPath,
            await readFile(positive.original.inputPath),
          ),
        ),
        positive.original.job.engineInput.sha256,
      );
      assertSuccessFileRead(
        positive,
        healthyMarker,
        positive.candidate.pngPath,
        await readFile(positive.candidate.pngPath),
      );
      assert.equal(positive.trace.restartCalls.length, 0);
      assert.equal(positive.trace.reserve.calls.length, 0);
      assert.equal(positive.trace.durable.calls.length, 0);
      assert.equal(positive.trace.success.calls.length, 1);
      assert.equal(
        positive.trace.success.calls[0]!.args[1],
        positive.candidate.candidateId,
      );
      assert.equal(positive.trace.success.calls[0]!.result, true);
      assert.equal(positive.trace.prepared.calls.length, 0);
      assert.equal(positive.trace.authorized.calls.length, 0);
      assert.equal(positive.f.executor.launchCalls.length, 1);
      assert.equal(
        positive.f.events
          .slice(healthyMarker)
          .some(({ event }) => event.path === positive!.original.outputPath),
        false,
      );
    } finally {
      await s.f.cleanup();
      if (positive) await positive.f.cleanup();
    }
  });
});

async function heldKeySource() {
  const s = await qualificationSource();
  try {
    const actual = s.bytes["controller-loss"];
    const changed = canonicalBytes({
      ...s.records.controllerLoss,
      authorizationRecordId: replacementUuid(
        Object.values(s.records).map((record) => record.recordId),
      ),
    });
    assertCanonicalWithinBound(s, "controller-loss", changed);
    await rewrite(s, "controller-loss", changed);
    const held = await rejectedRecovery(s);
    assertReaderRejected(s, held.start);
    for (const role of [
      "authorization",
      "controller-loss",
      "terminal",
    ] as const)
      assertReadToEof(held.events, role);
    assert.equal(held.after.events.length, 0);
    assert.equal(held.after.attempts.length, 1);
    assert.equal(held.ref.released_at, null);
    await s.f.executor.rewriteRecordBytes(
      target(s.original),
      "controller-loss",
      (bytes) => {
        assert.deepEqual(bytes, changed);
        return actual;
      },
    );
    const restored = await actualRecords(s.f, s.original);
    assert.deepEqual(restored.bytes, s.bytes);
    assert.deepEqual(restored.records, s.records);
    assertRecords(restored.records, s.scope);
    const inspected = await inspectSource(s, s.session);
    assert.deepEqual(inspected, s.inspected);
    assert.deepEqual(
      rows(s.f.storage).references.find(
        (ref) => ref.reference_id === held.key.referenceId,
      ),
      held.ref,
    );
    return { source: s, key: held.key, signal: held.signal, ref: held.ref };
  } catch (error) {
    await s.f.cleanup();
    throw error;
  }
}

function assertCurrentControlHistory(s: QualifiedSource) {
  const state = rows(s.f.storage);
  const current = state.controls.find(
    (control) => control.recovery_id === s.session.control.recoveryId,
  );
  assert.ok(current);
  const derived = state.controls.map((control) => {
    assert.equal(control.job_id, s.original.identity.jobId);
    assert.equal(control.attempt_no, s.original.identity.attemptNo);
    assert.equal(control.launch_ticket, s.original.launchTicket);
    assert.deepEqual(
      JSON.parse(control.source_identity_json),
      s.original.identity,
    );
    assert.equal(
      control.source_incarnation_id,
      s.accepted.attempts[0]!.producer_incarnation_id,
    );
    assert.equal(control.incarnation_id, current.incarnation_id);
    assert.notEqual(control.incarnation_id, control.source_incarnation_id);
    const pre = JSON.parse(control.publisher_identity_json) as AttemptIdentity;
    assert.equal(pre.jobId, s.original.identity.jobId);
    assert.equal(pre.attemptNo, s.original.identity.attemptNo);
    assert.ok(validIdentifier(pre.ownerInstanceId));
    assert.ok(Number.isSafeInteger(pre.fence) && pre.fence > 0);
    assert.ok(Number.isSafeInteger(pre.fence + 1));
    const post = {
      ...pre,
      ownerInstanceId: control.owner_instance_id,
      fence: pre.fence + 1,
    };
    if (control.state === "consumed") {
      assert.equal(control.classification, "tree-exited");
      assert.notEqual(control.observed_at, null);
      assert.notEqual(control.consumed_at, null);
      assert.ok(
        control.created_at <= control.observed_at! &&
          control.observed_at! <= control.consumed_at!,
      );
    }
    return { control, pre, post };
  });
  const candidates = derived.filter(
    ({ control, post }) =>
      control.state === "consumed" &&
      control.classification === "tree-exited" &&
      control.owner_instance_id === s.publisher.ownerInstanceId &&
      isDeepStrictEqual(post, s.publisher),
  );
  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0]!.control.recovery_id,
    s.session.control.recoveryId,
  );
  assert.equal(
    state.controls.filter((control) => control.state === "active").length,
    0,
  );
  assert.ok(
    state.controls.filter((control) => control.state === "consumed").length >=
      2,
  );
  assert.deepEqual(
    JSON.parse(state.attempts[0]!.producer_identity_json),
    s.original.identity,
  );
  assert.equal(
    state.attempts[0]!.producer_incarnation_id,
    s.accepted.attempts[0]!.producer_incarnation_id,
  );
  return candidates[0]!;
}

async function rejectsCapturedKey(
  s: QualifiedSource,
  held: Awaited<ReturnType<typeof heldKeySource>>,
) {
  const before = rows(s.f.storage);
  const start = mark(s);
  assert.equal(
    await s.f.storage.store.restartInterruptedAttempt(held.key, held.signal),
    undefined,
  );
  assert.equal(s.trace.restartCalls.length, start.restartCalls + 1);
  const actualCall = s.trace.restartCalls[start.restartCalls];
  assert.ok(actualCall);
  assert.equal(actualCall.key, held.key);
  assert.equal(actualCall.signal, held.signal);
  assert.equal(s.readerCalls.length, start.readerCalls);
  assert.equal(readerEvents(s, start).length, 0);
  assert.equal(s.f.artifactEvents.length, start.artifactEvents);
  assertNoLaunchOrPublication(s, start);
  const after = rows(s.f.storage);
  assertStable(s, before, after);
  assert.deepEqual(after.references, before.references);
  assert.deepEqual(
    after.references.find((ref) => ref.reference_id === held.key.referenceId),
    held.ref,
  );
  return { before, after, start };
}

describe("authorized interruption recovery qualification R3", () => {
  it("refuses an old recovery key after a real second publisher transfer", async () => {
    const held = await heldKeySource();
    const s = held.source;
    try {
      const session = s.f.storage.store.beginRecovery(
        s.publisher.ownerInstanceId,
      );
      assert.ok(session);
      const current = await applySession(s, session);
      assert.equal(
        current.publisher.ownerInstanceId,
        s.publisher.ownerInstanceId,
      );
      assert.equal(current.publisher.fence, s.publisher.fence + 1);
      assert.deepEqual(held.key.publisher, s.publisher);
      assert.notEqual(held.key.publisher.fence, current.publisher.fence);
      const eligible = assertCurrentControlHistory(current);
      assert.equal(eligible.control.recovery_id, session.control.recoveryId);
      await rejectsCapturedKey(current, held);

      // 当前 P2 的新 recover 链为本环境正控；K2 也只捕获实际 restart 参数。
      assert.equal(current.f, s.f);
      assert.equal(current.f.actualFiles, s.f.actualFiles);
      assert.equal(current.trace, s.trace);
      assert.equal(current.readerCalls, s.readerCalls);
      assert.equal(current.f.signal, held.signal);
      const positive = await createdRecovery(current);
      assert.notEqual(positive.key.referenceId, held.key.referenceId);
      assert.deepEqual(positive.key.publisher, current.publisher);
      const evidence = JSON.parse(positive.event.evidence_json!) as {
        recoveryId: string;
        referenceId: string;
      };
      assert.equal(evidence.recoveryId, session.control.recoveryId);
      assert.equal(evidence.referenceId, positive.key.referenceId);
      assert.notEqual(evidence.recoveryId, s.session.control.recoveryId);
      assert.deepEqual(
        positive.after.references.find(
          (ref) => ref.reference_id === held.key.referenceId,
        ),
        held.ref,
      );
    } finally {
      await s.f.cleanup();
    }
  });

  it("refuses the captured recovery key while another recovery control is active", async () => {
    const held = await heldKeySource();
    const s = held.source;
    try {
      const other = s.f.storage.store.beginRecovery(
        "qualification-other-controller",
      );
      assert.ok(other);
      const actualInspection = await inspectSource(s, other);
      const session = s.f.storage.store.beginRecovery(
        s.publisher.ownerInstanceId,
      );
      assert.ok(session);
      const active = rows(s.f.storage);
      const replaced = active.controls.find(
        (control) => control.recovery_id === other.control.recoveryId,
      );
      const currentControl = active.controls.find(
        (control) => control.recovery_id === session.control.recoveryId,
      );
      assert.ok(replaced && currentControl);
      assert.equal(replaced.state, "replaced");
      assert.equal(replaced.consumed_at, null);
      assert.equal(currentControl.state, "active");
      assert.deepEqual(
        JSON.parse(replaced.publisher_identity_json),
        s.publisher,
      );
      assert.deepEqual(
        JSON.parse(currentControl.publisher_identity_json),
        s.publisher,
      );
      assert.equal(
        s.f.storage.store.applyRecoveryInspection(
          other.control,
          actualInspection,
        ),
        undefined,
      );
      assert.deepEqual(rows(s.f.storage).controls, active.controls);
      assert.deepEqual(active.slot, s.baseline.slot);
      assert.deepEqual(held.key.publisher, s.publisher);
      await rejectsCapturedKey(s, held);
      assert.equal(
        rows(s.f.storage).controls.find(
          (control) => control.recovery_id === session.control.recoveryId,
        )!.state,
        "active",
      );

      const current = await applySession(s, session);
      assert.equal(
        current.publisher.ownerInstanceId,
        s.publisher.ownerInstanceId,
      );
      assert.equal(current.publisher.fence, s.publisher.fence + 1);
      const eligible = assertCurrentControlHistory(current);
      assert.equal(eligible.control.recovery_id, session.control.recoveryId);
      assert.equal(
        rows(s.f.storage).controls.find(
          (control) => control.recovery_id === other.control.recoveryId,
        )!.state,
        "replaced",
      );
      assert.equal(current.f, s.f);
      assert.equal(current.f.actualFiles, s.f.actualFiles);
      assert.equal(current.trace, s.trace);
      assert.equal(current.readerCalls, s.readerCalls);
      assert.equal(current.f.signal, held.signal);
      const positive = await createdRecovery(current);
      assert.notEqual(positive.key.referenceId, held.key.referenceId);
      const evidence = JSON.parse(positive.event.evidence_json!) as {
        recoveryId: string;
      };
      assert.equal(evidence.recoveryId, session.control.recoveryId);
      assert.deepEqual(
        positive.after.references.find(
          (ref) => ref.reference_id === held.key.referenceId,
        ),
        held.ref,
      );
    } finally {
      await s.f.cleanup();
    }
  });

  it("refuses interruption restart within the producer store incarnation", async () => {
    const pair = await qualificationPair({ reopen: false });
    const { subject: s, positive } = pair;
    try {
      const control = s.baseline.controls.find(
        (row) => row.recovery_id === s.session.control.recoveryId,
      );
      assert.ok(control);
      assert.equal(
        control.incarnation_id,
        s.accepted.attempts[0]!.producer_incarnation_id,
      );
      assert.equal(control.source_incarnation_id, control.incarnation_id);
      assertRecords(s.records, s.scope);
      assert.equal(s.appliedInspection.exit.completion?.kind, "interrupted");
      const before = rows(s.f.storage);
      const start = mark(s);
      const result = await s.f.track(
        createArtifacts({
          store: s.f.storage.store,
          files: s.f.actualFiles,
        }).recover(s.publisher, s.f.signal),
      );
      assert.deepEqual(result, { kind: "settled", verdict: "stale" });
      const after = rows(s.f.storage);
      assertStable(s, before, after);
      assert.equal(s.trace.acquire.calls.length, start.acquire + 1);
      assert.equal(s.trace.acquire.calls[start.acquire]!.result, undefined);
      assert.equal(s.trace.acquire.calls[start.acquire]!.error, undefined);
      assert.equal(s.trace.read.calls.length, start.read);
      assert.equal(s.trace.restartCalls.length, start.restartCalls);
      assert.equal(s.readerCalls.length, start.readerCalls);
      assert.equal(readerEvents(s, start).length, 0);
      assert.equal(s.f.artifactEvents.length, start.artifactEvents);
      assert.equal(after.references.length, 0);
      assertNoLaunchOrPublication(s, start);
      const reopened = positive.baseline.controls.find(
        (row) => row.recovery_id === positive.session.control.recoveryId,
      );
      assert.ok(reopened);
      assert.notEqual(reopened.incarnation_id, reopened.source_incarnation_id);
      await createdRecovery(positive);
    } finally {
      await pair.cleanup();
    }
  });

  it("refuses adapter interruption evidence without the original store authorization", async () => {
    const s = await newSource({ storeAuthorization: false });
    let positive: QualifiedSource | undefined;
    try {
      positive = await qualificationSource();
      assertSameEnvironment(s, positive);
      assert.equal(s.accepted.attempts[0]!.authorized_at, null);
      assert.notEqual(positive.accepted.attempts[0]!.authorized_at, null);
      assert.equal(s.f.allLaunchCalls.length, 1);
      assertRecords(s.records, s.scope);
      const session = s.f.storage.store.beginRecovery(
        "qualification-publisher",
      );
      assert.ok(session);
      const inspected = await inspectSource(s, session);
      assert.equal(inspected.exit.completion?.kind, "interrupted");
      const before = rows(s.f.storage);
      const start = mark(s);
      assert.equal(
        s.f.storage.store.applyRecoveryInspection(session.control, inspected),
        undefined,
      );
      const after = rows(s.f.storage);
      assertOriginalFacts(s, after);
      assert.equal(after.attempts.length, 1);
      assert.equal(after.attempts[0]!.authorized_at, null);
      assert.equal(after.attempts[0]!.exit_json, null);
      assert.equal(
        after.attempts[0]!.owner_instance_id,
        s.original.identity.ownerInstanceId,
      );
      assert.equal(after.attempts[0]!.fence, s.original.identity.fence);
      assert.deepEqual(after.slot, before.slot);
      assert.deepEqual(after.controls, before.controls);
      assert.equal(
        after.controls.find(
          (control) => control.recovery_id === session.control.recoveryId,
        )!.state,
        "active",
      );
      assert.equal(after.events.length, 0);
      assert.equal(after.references.length, 0);
      assert.equal(after.candidates.length, 0);
      assert.equal(s.trace.acquire.calls.length, start.acquire);
      assert.equal(s.trace.read.calls.length, start.read);
      assert.equal(s.trace.restartCalls.length, start.restartCalls);
      assert.equal(s.readerCalls.length, start.readerCalls);
      assert.equal(readerEvents(s, start).length, 0);
      assert.equal(s.f.artifactEvents.length, start.artifactEvents);
      assertNoLaunchOrPublication(s, start);
      await createdRecovery(positive);
    } finally {
      await s.f.cleanup();
      if (positive) await positive.f.cleanup();
    }
  });
});
