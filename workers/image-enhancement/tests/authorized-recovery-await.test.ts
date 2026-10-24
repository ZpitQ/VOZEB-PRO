import assert from "node:assert/strict";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, it } from "vitest";

import {
  createArtifacts,
  type ArtifactFiles,
  type ArtifactRecoveryOutcome,
  type ArtifactWorkKey,
} from "../src/artifacts.js";
import type {
  AttemptIdentity,
  ClaimedAttempt,
  DurableInterruptionRecords,
  InterruptionEvidenceReader,
  InterruptionReadScope,
} from "../src/execution.js";
import {
  artifactGate,
  nativePng,
  writeActualFile,
} from "./artifact-fixtures.js";
import {
  authorizedRecoveryFixture,
  type AuthorizedRecoveryFixture,
} from "./authorized-recovery-fixtures.js";
import type { DurableHandleEvent } from "./authorized-recovery-records.js";
import { deferred } from "./http-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
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
  sealed_at: number | null;
  stop_reason: string | null;
};
type ControlRow = {
  recovery_id: string;
  owner_instance_id: string;
  incarnation_id: string;
  source_incarnation_id: string;
  source_identity_json: string;
  publisher_identity_json: string;
  launch_ticket: string;
  state: string;
  classification: string | null;
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
type EventRow = {
  kind: string;
  job_id: string;
  source_identity_json: string;
  source_incarnation_id: string;
  recovery_incarnation_id: string;
  launch_ticket: string;
  sealed_at: number | null;
  evidence_json: string | null;
  consumed_publisher_identity_json: string | null;
  replacement_attempt_no: number | null;
  consumed_at: number | null;
};

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
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all() as ReferenceRow[],
    observations: db
      .prepare(
        "SELECT * FROM artifact_observations ORDER BY reference_id, observation_no",
      )
      .all() as {
      reference_id: string;
      candidate_id: string | null;
      code: string;
      checked_engine_sha256: string | null;
    }[],
    slot: db.prepare("SELECT * FROM execution_slot").all() as {
      singleton: number;
      job_id: string;
      attempt_no: number;
      fence: number;
    }[],
    candidates: db
      .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
      .all(),
  }));
}
type Rows = ReturnType<typeof rows>;

async function reachedWhilePending<T, R>(
  reached: Promise<R>,
  pending: Promise<T>,
): Promise<R> {
  return Promise.race([
    reached,
    pending.then(() => {
      throw new Error("chain settled before the required real await boundary");
    }),
  ]);
}

function cleanupCompletionGate() {
  const reached = deferred<DurableHandleEvent>();
  const released = deferred<void>();
  let hit = false;
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    async hook(event: DurableHandleEvent) {
      if (
        !hit &&
        event.operation === "reader" &&
        event.role === "authorization"
      ) {
        hit = true;
        reached.resolve(event);
        await released.promise;
      }
    },
  };
}

function readerReturnGate() {
  type Call = {
    scope: InterruptionReadScope;
    stillCurrent: () => boolean;
    records: DurableInterruptionRecords | undefined;
  };
  const reached = deferred<Call>();
  const released = deferred<void>();
  const bindings: {
    canonical: InterruptionEvidenceReader;
    fixed: InterruptionEvidenceReader;
  }[] = [];
  const calls: Call[] = [];
  const delivered: (DurableInterruptionRecords | undefined)[] = [];
  let hit = false;
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    bindings,
    calls,
    delivered,
    decorate(
      canonical: InterruptionEvidenceReader,
    ): InterruptionEvidenceReader {
      const fixed: InterruptionEvidenceReader = async (scope, stillCurrent) => {
        // Await the complete canonical run/catch promise, including both its
        // issued-handle finally and its ticket-transition finally.
        const records = await canonical(scope, stillCurrent);
        const call = { scope, stillCurrent, records };
        calls.push(call);
        if (!hit && records) {
          hit = true;
          reached.resolve(call);
          await released.promise;
        }
        delivered.push(records);
        return records;
      };
      bindings.push({ canonical, fixed });
      return fixed;
    },
  };
}

type RefReceipt = {
  kind: "fact" | "release";
  phase: "call" | "return" | "throw";
  key: ArtifactWorkKey;
  handleCount: number;
  value?: "held" | "released" | "retired" | boolean;
  error?: unknown;
};

function referenceReceipts(f: AuthorizedRecoveryFixture) {
  const receipts: RefReceipt[] = [];
  const store = f.storage.store;
  const fact = store.readArtifactReference.bind(store);
  const release = store.releaseArtifactReference.bind(store);
  const record = (receipt: Omit<RefReceipt, "handleCount">) => {
    receipts.push({ ...receipt, handleCount: f.executor.handleEvents.length });
  };
  store.readArtifactReference = (key) => {
    record({ kind: "fact", phase: "call", key });
    try {
      const value = fact(key);
      record({ kind: "fact", phase: "return", key, value });
      return value;
    } catch (error) {
      record({ kind: "fact", phase: "throw", key, error });
      throw error;
    }
  };
  store.releaseArtifactReference = (key) => {
    record({ kind: "release", phase: "call", key });
    try {
      const value = release(key);
      record({ kind: "release", phase: "return", key, value });
      return value;
    } catch (error) {
      record({ kind: "release", phase: "throw", key, error });
      throw error;
    }
  };
  return receipts;
}

async function source(f: AuthorizedRecoveryFixture, ordinarySuccess = false) {
  await f.submit();
  const original = f.storage.store.claimNext("await-source-producer");
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
  if (ordinarySuccess) {
    await writeActualFile(original.outputPath, await nativePng(original));
    await f.executor.finish(target(original), {
      kind: "success",
      exitCode: 0,
      signal: null,
    });
  } else await f.executor.loseController(target(original));
  const actualRecords = ordinarySuccess
    ? undefined
    : ({
        authorization: JSON.parse(
          (await f.executor.recordBytes(
            target(original),
            "authorization",
          ))!.toString("utf8"),
        ),
        controllerLoss: JSON.parse(
          (await f.executor.recordBytes(
            target(original),
            "controller-loss",
          ))!.toString("utf8"),
        ),
        terminal: JSON.parse(
          (await f.executor.recordBytes(
            target(original),
            "terminal",
          ))!.toString("utf8"),
        ),
      } as DurableInterruptionRecords | undefined);
  const oldFacade = f.executor;
  await f.reopen();
  assert.equal(oldFacade.retired, true);
  assert.notEqual(f.executor, oldFacade);
  const session = f.storage.store.beginRecovery("await-recovery-owner");
  assert.ok(session);
  assert.deepEqual(session.target, target(original));
  assert.deepEqual(session.active.ownerDescriptor, owner);
  const inspected = await f.executor.adapter.inspect(
    session.target,
    session.active.ownerDescriptor,
  );
  assert.equal(inspected.kind, "tree-exited");
  if (inspected.kind !== "tree-exited")
    assert.fail("real durable terminal required");
  assert.equal(
    inspected.exit.completion?.kind,
    ordinarySuccess ? "success" : "interrupted",
  );
  const moved = f.storage.store.applyRecoveryInspection(
    session.control,
    inspected,
  );
  assert.ok(moved && moved.kind === "transferred");
  assert.equal(moved.startupEventId, null);
  const transferred = rows(f);
  assert.equal(transferred.attempts.length, 1);
  assert.equal(transferred.events.length, 0);
  assert.equal(transferred.references.length, 0);
  const control = transferred.controls[0];
  assert.ok(control);
  assert.equal(control.state, "consumed");
  assert.equal(control.classification, "tree-exited");
  assert.notEqual(control.incarnation_id, control.source_incarnation_id);
  assert.deepEqual(JSON.parse(control.source_identity_json), original.identity);
  const pre = JSON.parse(control.publisher_identity_json) as AttemptIdentity;
  assert.deepEqual(pre, original.identity);
  assert.ok(Number.isSafeInteger(pre.fence + 1));
  assert.deepEqual(
    {
      ...pre,
      ownerInstanceId: control.owner_instance_id,
      fence: pre.fence + 1,
    },
    moved.publisher,
  );
  assert.deepEqual(transferred.slot, [
    {
      singleton: 1,
      job_id: original.identity.jobId,
      attempt_no: original.identity.attemptNo,
      fence: moved.publisher.fence,
    },
  ]);
  return {
    original,
    owner,
    accepted,
    inspected,
    moved,
    transferred,
    control,
    actualRecords,
  };
}
type Source = Awaited<ReturnType<typeof source>>;

function assertEngineRead(
  f: AuthorizedRecoveryFixture,
  original: ClaimedAttempt,
) {
  const events = f.artifactEvents.filter(
    (event) => event.path === original.inputPath,
  );
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
  const bytes = Buffer.concat(reads.map((event) => event.bytes!));
  assert.equal(bytes.length, original.job.engineInput.byteLength);
  assert.equal(sha256(bytes), original.job.engineInput.sha256);
  assert.ok(
    events.some(
      (event) => event.stage === "stat" && event.size === bytes.length,
    ),
  );
  assert.equal(events.filter((event) => event.stage === "open").length, 1);
  assert.equal(events.filter((event) => event.stage === "close").length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.stage === "read" &&
        event.bytesRead === 0 &&
        event.position === bytes.length,
    ),
  );
}

function assertHandleCompletion(events: readonly DurableHandleEvent[]) {
  assert.equal(
    events.some((event) => event.stage === "observer-failed"),
    false,
  );
  for (const opened of events.filter((event) => event.stage === "opened")) {
    const same = events.filter(
      (event) => event.handleToken === opened.handleToken,
    );
    assert.equal(same.filter((event) => event.stage === "opened").length, 1);
    assert.equal(
      same.filter((event) => event.stage === "close-issued").length,
      1,
    );
    assert.equal(
      same.filter(
        (event) =>
          event.stage === "native-close-settled" &&
          event.outcome === "fulfilled",
      ).length,
      1,
    );
    assert.equal(
      same.filter(
        (event) =>
          event.stage === "completion-delivered" &&
          event.outcome === "fulfilled",
      ).length,
      1,
    );
    assert.ok(
      same.findIndex((event) => event.stage === "opened") <
        same.findIndex((event) => event.stage === "close-issued"),
    );
    assert.ok(
      same.findIndex((event) => event.stage === "close-issued") <
        same.findIndex((event) => event.stage === "native-close-settled"),
    );
    assert.ok(
      same.findIndex((event) => event.stage === "native-close-settled") <
        same.findIndex((event) => event.stage === "completion-delivered"),
    );
  }
}

async function readSetup(
  options: {
    returnGate?: ReturnType<typeof readerReturnGate>;
    beforeRead?: (f: AuthorizedRecoveryFixture, s: Source) => void;
  } = {},
) {
  const completion = cleanupCompletionGate();
  const f = await authorizedRecoveryFixture({
    readerDecorator: options.returnGate?.decorate,
    observationGateReleases: [
      completion.release,
      ...(options.returnGate ? [options.returnGate.release] : []),
    ],
  });
  try {
    const s = await source(f);
    if (options.returnGate) {
      assert.equal(options.returnGate.bindings.length, 2);
      assert.equal(
        options.returnGate.bindings[1]!.canonical,
        f.executor.adapter.readInterruptionEvidence,
      );
      assert.equal(options.returnGate.calls.length, 0);
    }
    options.beforeRead?.(f, s);
    const receipts = referenceReceipts(f);
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
    return { f, s, completion, receipts, gate, artifacts };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}
type ReadSetup = Awaited<ReturnType<typeof readSetup>>;

async function enterRead(x: ReadSetup, signal = x.f.signal) {
  const { f, s } = x;
  const recovering = f.track(x.artifacts.recover(s.moved.publisher, signal));
  const reached = await reachedWhilePending(x.gate.reached, recovering);
  assert.equal(reached.operation, "reader");
  assert.equal(reached.role, "authorization");
  assert.equal(reached.stage, "read");
  assert.equal(reached.phase, "after");
  assert.ok((reached.bytesRead ?? 0) > 0);
  assert.ok(reached.handleToken);
  assert.equal(f.restartCalls.length, 1);
  const call = f.restartCalls[0]!;
  assert.equal(call.signal, signal);
  assert.deepEqual(call.key.publisher, s.moved.publisher);
  const gated = rows(f);
  assert.equal(gated.attempts.length, 1);
  assert.equal(gated.events.length, 0);
  assert.deepEqual(gated.slot, s.transferred.slot);
  assert.equal(gated.references.length, 1);
  const held = gated.references.find(
    (row) => row.reference_id === call.key.referenceId,
  );
  assert.ok(held);
  assert.equal(held.released_at, null);
  assert.equal(held.purpose, "recovery");
  assert.equal(held.candidate_id, null);
  assert.equal(held.incarnation_id, s.control.incarnation_id);
  assert.deepEqual(JSON.parse(held.publisher_identity_json), s.moved.publisher);
  assert.equal(held.job_id, s.original.identity.jobId);
  assert.equal(held.attempt_no, s.original.identity.attemptNo);
  assert.deepEqual(
    gated.observations
      .filter((row) => row.reference_id === held.reference_id)
      .map((row) => ({
        candidate: row.candidate_id,
        code: row.code,
        engine: row.checked_engine_sha256,
      })),
    [
      {
        candidate: null,
        code: "no_qualified_candidate",
        engine: s.original.job.engineInput.sha256,
      },
    ],
  );
  assert.equal(gated.candidates.length, 0);
  assert.equal(f.allLaunchCalls.length, 1);
  assert.equal(f.executor.retired, false);
  assert.equal(f.storage.store.closed, false);
  assert.equal(signal.aborted, false);
  assert.equal(gated.jobs[0]!.cancel_requested_at, null);
  assert.equal(gated.attempts[0]!.stop_reason, null);
  assert.deepEqual(JSON.parse(gated.attempts[0]!.exit_json!), s.inspected.exit);
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
    assert.equal(gated.attempts[0]![field], s.accepted.attempts[0]![field]);
  assertEngineRead(f, s.original);
  const token = reached.handleToken;
  const native = f.executor.handleEvents.filter(
    (event) => event.handleToken === token,
  );
  assert.equal(native.filter((event) => event.stage === "opened").length, 1);
  assert.ok(
    native.some(
      (event) => event.stage === "read-returned" && (event.bytesRead ?? 0) > 0,
    ),
  );
  assert.equal(
    native.some((event) => event.stage === "close-issued"),
    false,
  );
  return { recovering, reached, call, gated, held, token };
}
type InRead = Awaited<ReturnType<typeof enterRead>>;

function assertUnchangedSource(before: Rows, after: Rows) {
  for (const field of [
    "source_json",
    "engine_json",
    "plan_json",
    "execution_policy_json",
    "first_started_at",
    "execution_deadline_at",
  ] as const)
    assert.equal(after.jobs[0]![field], before.jobs[0]![field]);
  for (const field of [
    "producer_identity_json",
    "producer_incarnation_id",
    "launch_ticket",
    "run_directory",
    "tile",
    "owner_descriptor_json",
    "prepared_at",
    "authorized_at",
    "exit_json",
    "sealed_at",
  ] as const)
    assert.equal(after.attempts[0]![field], before.attempts[0]![field]);
}

function assertNoOldWrites(expected: Rows, actual: Rows) {
  assert.deepEqual(actual.jobs, expected.jobs);
  assert.deepEqual(actual.attempts, expected.attempts);
  assert.deepEqual(actual.controls, expected.controls);
  assert.deepEqual(actual.events, expected.events);
  assert.deepEqual(actual.slot, expected.slot);
  assert.deepEqual(actual.observations, expected.observations);
  assert.deepEqual(actual.candidates, expected.candidates);
  assert.equal(actual.attempts.length, 1);
  assert.equal(actual.events.length, 0);
  assert.equal(actual.jobs[0]!.status, "running");
  assert.equal(actual.jobs[0]!.reason, null);
  assert.equal(actual.jobs[0]!.result_candidate_id, null);
}

function explainNegativeReference(
  x: ReadSetup,
  read: InRead,
  expected: Rows,
  forbidFact: boolean,
  lostAuthority: boolean,
) {
  const done = rows(x.f);
  const ref = done.references.find(
    (row) => row.reference_id === read.call.key.referenceId,
  );
  assert.ok(ref);
  assert.equal(done.references.length, expected.references.length);
  assert.deepEqual({ ...ref, released_at: null }, read.held);
  const receipts = x.receipts;
  for (const receipt of receipts) assert.deepEqual(receipt.key, read.call.key);
  if (forbidFact)
    assert.equal(
      receipts.length,
      0,
      "closed/aborted cleanup may not query the DB or release",
    );
  const releases = receipts.filter(
    (receipt) => receipt.kind === "release" && receipt.phase === "call",
  );
  const successes = receipts.filter(
    (receipt) =>
      receipt.kind === "release" &&
      receipt.phase === "return" &&
      receipt.value === true,
  );
  if (lostAuthority)
    assert.equal(
      successes.length,
      0,
      "old control/lease/deadline keys may not release successfully",
    );
  for (const release of releases) {
    const index = receipts.indexOf(release);
    const prior = receipts[index - 1];
    assert.ok(
      prior &&
        prior.kind === "fact" &&
        prior.phase === "return" &&
        prior.value === "held",
    );
    assert.deepEqual(prior.key, release.key);
    assert.equal(read.held.incarnation_id, x.s.control.incarnation_id);
    const delivered = x.f.executor.handleEvents
      .map(
        (event) =>
          event.operation === "reader" &&
          event.stage === "completion-delivered",
      )
      .lastIndexOf(true);
    assert.ok(
      delivered >= 0 && release.handleCount > delivered,
      "late release must follow every real close receipt",
    );
  }
  if (ref.released_at !== null) {
    assert.equal(
      successes.length,
      1,
      "released requires one actual same-key legal release receipt",
    );
    assert.equal(releases.length, 1);
  } else {
    assert.equal(
      successes.length,
      0,
      "without a successful receipt the exact ref stays held",
    );
  }
  return done;
}

async function retireAtRead(
  x: ReadSetup,
  read: InRead,
  action: () => void,
  options: { forbidFact?: boolean; lostAuthority?: boolean } = {},
) {
  const { f } = x;
  // Positive controls have no suspended cleanup receipt. If a positive case
  // unexpectedly retires, it must settle into a useful assertion failure.
  f.executor.hooks.cleanupCloseCompletion = x.completion.hook;
  action();
  const expected = rows(f);
  const marker = f.executor.events.length;
  const artifactMarker = f.artifactEvents.length;
  x.gate.release();
  const settled = await reachedWhilePending(
    x.completion.reached,
    read.recovering,
  );
  assert.equal(settled.handleToken, read.token);
  assert.equal(settled.stage, "native-close-settled");
  assert.equal(settled.cleanup, true);
  assert.equal(settled.outcome, "fulfilled");
  assert.equal(
    f.executor.handleEvents.some(
      (event) =>
        event.handleToken === read.token &&
        event.stage === "completion-delivered",
    ),
    false,
  );
  const pending = rows(f);
  assertNoOldWrites(expected, pending);
  assert.equal(
    pending.references.find(
      (row) => row.reference_id === read.call.key.referenceId,
    )!.released_at,
    null,
  );
  assert.equal(x.receipts.length, 0);
  assert.equal(f.artifactEvents.length, artifactMarker);
  const suffix = f.executor.events.slice(marker);
  assert.deepEqual(
    suffix.map((event) => ({
      operation: event.operation,
      role: event.role,
      stage: event.stage,
      phase: event.phase,
      cleanup: event.cleanup,
      token: event.handleToken,
    })),
    [
      {
        operation: "reader",
        role: "authorization",
        stage: "close",
        phase: "before",
        cleanup: true,
        token: read.token,
      },
    ],
  );
  // Only the completion receipt is pending here. Native close already settled.
  x.completion.release();
  const result = await read.recovering;
  assert.equal(result.kind, "settled");
  assert.equal(f.artifactEvents.length, artifactMarker);
  assert.deepEqual(
    f.executor.events.slice(marker).map((event) => ({
      operation: event.operation,
      role: event.role,
      stage: event.stage,
      phase: event.phase,
      cleanup: event.cleanup,
      token: event.handleToken,
    })),
    [
      {
        operation: "reader",
        role: "authorization",
        stage: "close",
        phase: "before",
        cleanup: true,
        token: read.token,
      },
      {
        operation: "reader",
        role: "authorization",
        stage: "close",
        phase: "after",
        cleanup: true,
        token: read.token,
      },
    ],
  );
  assertHandleCompletion(f.executor.handleEvents);
  const done = explainNegativeReference(
    x,
    read,
    expected,
    options.forbidFact ?? false,
    options.lostAuthority ?? false,
  );
  assertNoOldWrites(expected, done);
  assertUnchangedSource(read.gated, done);
  assert.equal(f.allLaunchCalls.length, 1);
  assert.equal(
    f.executor.events.some((event) => event.operation === "stop"),
    false,
  );
  return { result, expected, done };
}

function assertCreated(
  x: ReadSetup,
  read: InRead,
  result: ArtifactRecoveryOutcome,
) {
  assert.equal(result.kind, "restarted");
  if (result.kind !== "restarted")
    assert.fail("the real reader must reach a restart receipt");
  assert.equal(result.outcome.kind, "created");
  if (result.outcome.kind !== "created")
    assert.fail("the first exact ref must create one replacement");
  const replacement = result.outcome.attempt;
  const done = rows(x.f);
  assert.equal(done.attempts.length, 2);
  assert.equal(done.events.length, 1);
  assert.equal(done.references.length, 1);
  assert.equal(done.controls.length, 1);
  assert.deepEqual(done.controls, read.gated.controls);
  assert.equal(done.candidates.length, 0);
  assert.deepEqual(done.observations, read.gated.observations);
  const event = done.events[0]!;
  assert.equal(event.kind, "authorized-interruption");
  assert.equal(event.sealed_at, null);
  assert.notEqual(event.consumed_at, null);
  assert.equal(event.job_id, x.s.original.identity.jobId);
  assert.equal(event.launch_ticket, x.s.original.launchTicket);
  assert.equal(
    event.source_incarnation_id,
    x.s.accepted.attempts[0]!.producer_incarnation_id,
  );
  assert.equal(event.recovery_incarnation_id, x.s.control.incarnation_id);
  assert.deepEqual(
    JSON.parse(event.source_identity_json),
    x.s.original.identity,
  );
  assert.deepEqual(
    JSON.parse(event.consumed_publisher_identity_json!),
    x.s.moved.publisher,
  );
  assert.equal(event.replacement_attempt_no, replacement.identity.attemptNo);
  assert.ok(event.evidence_json);
  const evidence = JSON.parse(event.evidence_json) as {
    v: number;
    recoveryId: string;
    referenceId: string;
    records: DurableInterruptionRecords;
  };
  assert.equal(evidence.v, 1);
  assert.equal(evidence.recoveryId, x.s.control.recovery_id);
  assert.equal(evidence.referenceId, read.call.key.referenceId);
  assert.deepEqual(evidence.records, x.s.actualRecords);
  assert.deepEqual(
    JSON.parse(done.attempts[0]!.exit_json!),
    x.s.inspected.exit,
  );
  assertUnchangedSource(read.gated, done);
  assert.equal(done.attempts[0]!.sealed_at, null);
  assert.equal(replacement.identity.jobId, x.s.original.identity.jobId);
  assert.equal(
    replacement.identity.attemptNo,
    x.s.original.identity.attemptNo + 1,
  );
  assert.equal(replacement.identity.fence, x.s.moved.publisher.fence + 1);
  assert.ok(
    Number.isSafeInteger(replacement.identity.attemptNo) &&
      Number.isSafeInteger(replacement.identity.fence),
  );
  assert.notEqual(replacement.launchTicket, x.s.original.launchTicket);
  assert.notEqual(replacement.workingDirectory, x.s.original.workingDirectory);
  assert.equal(replacement.inputPath, x.s.original.inputPath);
  assert.equal(replacement.tile, x.s.original.tile);
  assert.deepEqual(replacement.executionPolicy, x.s.original.executionPolicy);
  assert.deepEqual(replacement.job.source, x.s.original.job.source);
  assert.deepEqual(replacement.job.engineInput, x.s.original.job.engineInput);
  assert.deepEqual(replacement.job.plan, x.s.original.job.plan);
  assert.equal(replacement.firstStartedAt, x.s.original.firstStartedAt);
  assert.equal(
    replacement.executionDeadlineAt,
    x.s.original.executionDeadlineAt,
  );
  assert.equal(done.jobs[0]!.status, "running");
  assert.equal(done.jobs[0]!.reason, null);
  assert.equal(done.jobs[0]!.result_candidate_id, null);
  assert.equal(done.jobs[0]!.active_attempt_no, replacement.identity.attemptNo);
  assert.equal(done.jobs[0]!.current_fence, replacement.identity.fence);
  assert.deepEqual(done.slot, [
    {
      singleton: 1,
      job_id: replacement.identity.jobId,
      attempt_no: replacement.identity.attemptNo,
      fence: replacement.identity.fence,
    },
  ]);
  const replacementRow = done.attempts[1]!;
  for (const field of [
    "owner_descriptor_json",
    "prepared_at",
    "authorized_at",
    "exit_json",
    "sealed_at",
  ] as const)
    assert.equal(replacementRow[field], null);
  assert.notEqual(
    done.references.find(
      (row) => row.reference_id === read.call.key.referenceId,
    )!.released_at,
    null,
  );
  assert.deepEqual(
    x.receipts,
    [],
    "the created transaction ends its exact ref without a late release",
  );
  for (const role of [
    "authorization",
    "controller-loss",
    "terminal",
  ] as const) {
    assert.ok(
      x.f.executor.events.some(
        (event) =>
          event.operation === "reader" &&
          event.role === role &&
          event.stage === "read" &&
          event.phase === "after" &&
          (event.bytesRead ?? 0) > 0,
      ),
    );
    const handles = x.f.executor.handleEvents.filter(
      (event) => event.operation === "reader" && event.role === role,
    );
    assert.ok(
      handles.some(
        (event) =>
          event.stage === "read-returned" && (event.bytesRead ?? 0) > 0,
      ),
    );
    assert.ok(
      handles.some(
        (event) => event.stage === "read-returned" && event.bytesRead === 0,
      ),
    );
    assert.ok(
      x.f.executor.events.some(
        (event) =>
          event.operation === "reader" &&
          event.role === role &&
          event.stage === "file-sync" &&
          event.phase === "after",
      ),
    );
  }
  assertHandleCompletion(x.f.executor.handleEvents);
  const authorizationHandle = x.f.executor.handleEvents.filter(
    (event) => event.handleToken === read.token,
  );
  assert.equal(
    authorizationHandle.some(
      (event) =>
        event.stage === "completion-delivered" &&
        event.outcome === "fulfilled" &&
        !event.cleanup,
    ),
    true,
  );
  assert.equal(
    x.f.executor.events.some((event) => event.operation === "stop"),
    false,
  );
  assert.equal(x.f.allLaunchCalls.length, 1);
  return done;
}

function renewBeyondOriginalDeadline(f: AuthorizedRecoveryFixture, s: Source) {
  const deadline = rows(f).jobs[0]!.execution_deadline_at;
  const policy = s.original.executionPolicy.limits;
  assert.ok(policy.leaseDurationMs > policy.heartbeatIntervalMs + 1);
  const finalRenewalAt = deadline - policy.heartbeatIntervalMs;
  assert.equal(
    rows(f).attempts[0]!.lease_expires_at - f.storage.clock(),
    policy.leaseDurationMs,
  );
  for (;;) {
    const before = rows(f);
    const lease = before.attempts[0]!.lease_expires_at;
    if (lease > deadline + 1) break;
    // Keep reader startup before all three deadline targets. The final renewal
    // is one saved heartbeat interval before T; earlier ones use current L.
    const at = Math.min(lease, finalRenewalAt);
    assert.ok(at >= f.storage.clock() && at <= lease && at <= deadline);
    f.time.advanceTo(at);
    assert.equal(f.storage.store.renewLease(s.moved.publisher), true);
    const renewed = rows(f);
    assert.equal(
      renewed.attempts[0]!.lease_expires_at,
      at + policy.leaseDurationMs,
    );
    assert.ok(renewed.attempts[0]!.lease_expires_at > lease);
    assert.deepEqual(renewed.attempts, [
      { ...before.attempts[0]!, lease_expires_at: at + policy.leaseDurationMs },
    ]);
    assert.deepEqual(renewed.jobs, before.jobs);
    assert.deepEqual(renewed.controls, before.controls);
    assert.deepEqual(renewed.slot, before.slot);
    assert.deepEqual(renewed.references, before.references);
  }
  const final = rows(f);
  assert.ok(final.attempts[0]!.lease_expires_at > deadline + 1);
  assert.equal(
    final.jobs[0]!.execution_deadline_at,
    s.original.executionDeadlineAt,
  );
  assert.equal(final.jobs[0]!.first_started_at, s.original.firstStartedAt);
}

async function boundary(axis: "lease" | "deadline", offset: -1 | 0 | 1) {
  const x = await readSetup({
    beforeRead: axis === "deadline" ? renewBeyondOriginalDeadline : undefined,
  });
  try {
    const read = await enterRead(x);
    const lease = read.gated.attempts[0]!.lease_expires_at;
    const deadline = read.gated.jobs[0]!.execution_deadline_at;
    if (axis === "lease") assert.ok(lease + 1 < deadline);
    else assert.ok(lease > deadline + 1);
    const at = (axis === "lease" ? lease : deadline) + offset;
    assert.ok(at >= x.f.storage.clock());
    x.f.time.advanceTo(at);
    assert.equal(x.f.storage.clock(), at);
    assert.deepEqual(
      rows(x.f),
      read.gated,
      "clock alone must not persist timeout, stop or another control",
    );
    if (offset === 1) {
      await retireAtRead(x, read, () => {}, { lostAuthority: true });
      const done = rows(x.f);
      assert.equal(done.jobs[0]!.cancel_requested_at, null);
      assert.equal(done.attempts[0]!.stop_reason, null);
      if (axis === "deadline")
        assert.ok(done.attempts[0]!.lease_expires_at > x.f.storage.clock());
    } else {
      x.gate.release();
      assertCreated(x, read, await read.recovering);
    }
    assert.equal(x.f.signal.aborted, false);
    assert.equal(x.f.storage.store.closed, false);
    assert.equal(x.f.executor.retired, false);
  } finally {
    await x.f.cleanup();
  }
}

// Private tracer for the exact better-sqlite3 consumers in store.ts. Native
// objects, transaction functions, callbacks, results and exceptions are retained.
function nativeDatabaseTracer() {
  type Method = (this: object, ...args: unknown[]) => unknown;
  type Attempt = {
    db: Database.Database;
    kind: "database" | "statement";
    method: string;
  };
  const events: Attempt[] = [];
  const connections = new Set<Database.Database>();
  const owners = new WeakMap<object, Database.Database>();
  const installed = new WeakMap<object, Set<string>>();
  const restores: (() => void)[] = [];
  const coverageFailures = new Set<string>();
  let selected: Database.Database | undefined;

  function spy(
    object: object,
    name: string,
    wrap: (original: Method) => Method,
  ) {
    const names = installed.get(object) ?? new Set<string>();
    installed.set(object, names);
    if (names.has(name)) return;
    names.add(name);
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (
      !descriptor ||
      typeof descriptor.value !== "function" ||
      (!descriptor.configurable && !descriptor.writable)
    ) {
      coverageFailures.add(
        `native descriptor cannot be observed transparently: ${name}`,
      );
      return;
    }
    const replacement = wrap(descriptor.value as Method);
    if (
      !Reflect.defineProperty(object, name, {
        ...descriptor,
        value: replacement,
      })
    ) {
      coverageFailures.add(`native descriptor installation failed: ${name}`);
      return;
    }
    restores.push(() => {
      assert.equal(Reflect.defineProperty(object, name, descriptor), true);
    });
  }
  function attempt(
    db: Database.Database,
    kind: Attempt["kind"],
    method: string,
  ) {
    connections.add(db);
    events.push({ db, kind, method });
  }
  function statement(statement: object, db: Database.Database) {
    owners.set(statement, db);
    const prototype = Object.getPrototypeOf(statement) as object;
    for (const name of ["run", "get", "all"])
      spy(
        prototype,
        name,
        (original) =>
          function (...args) {
            const owner = owners.get(this);
            if (owner) attempt(owner, "statement", name);
            return Reflect.apply(original, this, args);
          },
      );
  }
  // better-sqlite3 13.0.3 makes transaction.immediate/exclusive nonwritable
  // and nonconfigurable. Root's clarified contract observes their real factory
  // and independently audits every immediate/exclusive call as a local call on
  // that fresh result. No transaction object, callback or variant is replaced;
  // direct variant execution remains an explicit dynamic observation gap.
  for (const name of ["prepare", "pragma", "exec", "transaction", "close"])
    spy(
      Database.prototype,
      name,
      (original) =>
        function (...args) {
          const db = this as Database.Database;
          attempt(db, "database", name);
          const value = Reflect.apply(original, this, args);
          if (name === "prepare") statement(value as object, db);
          return value;
        },
    );

  return {
    select(f: AuthorizedRecoveryFixture) {
      const path = resolve(f.storage.directory, "worker.sqlite");
      const matching = [...connections].filter(
        (db) => typeof db.name === "string" && resolve(db.name) === path,
      );
      const open = matching.filter((db) => db.open);
      assert.equal(
        open.length,
        1,
        "one unique final worker.sqlite connection must be observed",
      );
      selected = open[0]!;
      for (const db of matching)
        if (db !== selected) assert.equal(db.open, false);
      return selected;
    },
    assertComplete() {
      assert.deepEqual(
        [...coverageFailures],
        [],
        "a tracer coverage failure is instrumentation failure, never zero attempted DB access",
      );
    },
    mark: () => events.length,
    targetSince(marker: number) {
      assert.ok(selected);
      // Do not test db.open here: closed-store attempts must remain observable.
      return events.slice(marker).filter((event) => event.db === selected);
    },
    restore() {
      for (const restore of restores.reverse()) restore();
    },
  };
}

describe("authorized interruption reader await and boundary recovery", () => {
  it("retires a reader after a positive authorization read when its original signal is aborted", async () => {
    const x = await readSetup();
    const controller = new AbortController();
    try {
      const read = await enterRead(x, controller.signal);
      const now = x.f.storage.clock();
      await retireAtRead(x, read, () => controller.abort(), {
        forbidFact: true,
      });
      assert.equal(x.f.storage.clock(), now);
      assert.equal(x.f.storage.store.closed, false);
      assert.equal(x.f.executor.retired, false);
    } finally {
      await x.f.cleanup();
    }
  });

  it("short-circuits a closed store before any database access after a positive authorization read", async () => {
    const tracer = nativeDatabaseTracer();
    let x: ReadSetup | undefined;
    try {
      x = await readSetup();
      const db = tracer.select(x.f);
      const read = await enterRead(x);
      const marker = tracer.mark();
      assert.deepEqual(x.f.storage.store.durability, {
        synchronous: "full",
        lockingMode: "exclusive",
        journalMode: "delete",
      });
      assert.ok(x.f.storage.store.getActiveAttempt(x.s.moved.publisher));
      tracer.assertComplete();
      const live = tracer.targetSince(marker);
      for (const [kind, method] of [
        ["database", "pragma"],
        ["database", "prepare"],
        ["statement", "get"],
      ])
        assert.ok(
          live.some((event) => event.kind === kind && event.method === method),
          `real nonzero DB positive control: ${kind}.${method}`,
        );
      for (const [kind, method] of [["database", "transaction"]])
        assert.ok(
          tracer
            .targetSince(0)
            .some((event) => event.kind === kind && event.method === method),
          `real begin/apply transaction positive control: ${kind}.${method}`,
        );
      let closedMarker = -1;
      await retireAtRead(
        x,
        read,
        () => {
          x!.f.storage.store.close();
          assert.equal(db.open, false);
          closedMarker = tracer.mark();
        },
        { forbidFact: true },
      );
      assert.deepEqual(tracer.targetSince(closedMarker), []);
      const readerMarker = x.f.executor.events.length;
      const artifactMarker = x.f.artifactEvents.length;
      const entryMarker = tracer.mark();
      assert.equal(
        await x.f.storage.store.restartInterruptedAttempt(
          read.call.key,
          read.call.signal,
        ),
        undefined,
      );
      assert.deepEqual(tracer.targetSince(entryMarker), []);
      assert.equal(x.f.executor.events.length, readerMarker);
      assert.equal(x.f.artifactEvents.length, artifactMarker);
      assert.equal(x.f.signal.aborted, false);
      assert.equal(x.f.executor.retired, false);
      tracer.assertComplete();
    } finally {
      // Fixture releases read/receipt gates and drains real pending operations
      // before any native method descriptor is restored.
      try {
        await x?.f.cleanup();
      } finally {
        tracer.restore();
      }
    }
  });

  it("does not restart after authenticated cancellation during a positive authorization read", async () => {
    const x = await readSetup();
    try {
      const principal = x.f.storage.principal();
      const read = await enterRead(x);
      await retireAtRead(x, read, () => {
        const result = x.f.storage.store.requestCancel(
          principal,
          x.s.original.identity.jobId,
        );
        assert.equal(result.applied, true);
        assert.equal(result.status, 202);
        const cancelled = rows(x.f);
        assert.equal(cancelled.jobs[0]!.status, "running");
        assert.equal(
          cancelled.jobs[0]!.cancel_requested_at,
          x.f.storage.clock(),
        );
        assert.equal(cancelled.attempts[0]!.stop_reason, "user_cancel");
      });
    } finally {
      await x.f.cleanup();
    }
  });

  it("does not restart after a stop request without cancellation during a positive authorization read", async () => {
    const x = await readSetup();
    try {
      const read = await enterRead(x);
      await retireAtRead(x, read, () => {
        assert.equal(
          x.f.storage.store.requestStop(x.s.moved.publisher, "user_cancel"),
          true,
        );
        const stopped = rows(x.f);
        assert.equal(stopped.jobs[0]!.cancel_requested_at, null);
        assert.equal(stopped.attempts[0]!.stop_reason, "user_cancel");
      });
    } finally {
      await x.f.cleanup();
    }
  });

  it("retires a pending reader when a new real recovery control becomes active", async () => {
    const x = await readSetup();
    try {
      const read = await enterRead(x);
      await retireAtRead(
        x,
        read,
        () => {
          const session = x.f.storage.store.beginRecovery(
            "await-next-active-owner",
          );
          assert.ok(session);
          const active = rows(x.f);
          assert.equal(active.controls.length, 2);
          assert.equal(active.controls[0]!.state, "consumed");
          assert.equal(active.controls[1]!.state, "active");
          assert.deepEqual(
            JSON.parse(active.controls[1]!.publisher_identity_json),
            x.s.moved.publisher,
          );
          assert.deepEqual(active.slot, read.gated.slot);
          assert.equal(
            active.attempts[0]!.owner_instance_id,
            x.s.moved.publisher.ownerInstanceId,
          );
          assert.equal(active.attempts[0]!.fence, x.s.moved.publisher.fence);
        },
        { lostAuthority: true },
      );
    } finally {
      await x.f.cleanup();
    }
  });

  it("rejects an old reader result after a real publisher transfer before the reader returns to the store", async () => {
    // This same-setup positive control proves the fixed wrapper and native
    // handle observations preserve created before any transfer is injected.
    const positiveReturn = readerReturnGate();
    const positive = await readSetup({ returnGate: positiveReturn });
    try {
      const read = await enterRead(positive);
      positive.gate.release();
      const returned = await reachedWhilePending(
        positiveReturn.reached,
        read.recovering,
      );
      assert.deepEqual(returned.records, positive.s.actualRecords);
      assertHandleCompletion(positive.f.executor.handleEvents);
      assert.equal(positiveReturn.delivered.length, 0);
      positiveReturn.release();
      assertCreated(positive, read, await read.recovering);
      assert.equal(positiveReturn.delivered[0], returned.records);
    } finally {
      await positive.f.cleanup();
    }

    const returnGate = readerReturnGate();
    const x = await readSetup({ returnGate });
    try {
      const read = await enterRead(x);
      x.gate.release();
      const returned = await reachedWhilePending(
        returnGate.reached,
        read.recovering,
      );
      assert.deepEqual(returned.records, x.s.actualRecords);
      assert.deepEqual(returned.scope, {
        target: target(x.s.original),
        descriptor: x.s.owner,
      });
      assertHandleCompletion(x.f.executor.handleEvents);
      assert.equal(returnGate.delivered.length, 0);
      assert.equal(rows(x.f).references[0]!.released_at, null);
      const session = x.f.storage.store.beginRecovery(
        "await-transferred-next-owner",
      );
      assert.ok(session);
      assert.equal(rows(x.f).controls[1]!.state, "active");
      // This actual inspect finishes while G-return is held, proving that the
      // canonical reader's ticket queue finally has already released it.
      const inspected = await x.f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      assert.equal(inspected.kind, "tree-exited");
      const moved = x.f.storage.store.applyRecoveryInspection(
        session.control,
        inspected,
      );
      assert.ok(moved && moved.kind === "transferred");
      assert.equal(moved.startupEventId, null);
      const transferred = rows(x.f);
      assert.equal(transferred.controls[1]!.state, "consumed");
      assert.deepEqual(
        JSON.parse(transferred.controls[1]!.publisher_identity_json),
        x.s.moved.publisher,
      );
      assert.deepEqual(moved.publisher, {
        ...x.s.moved.publisher,
        ownerInstanceId: transferred.controls[1]!.owner_instance_id,
        fence: x.s.moved.publisher.fence + 1,
      });
      assert.equal(
        transferred.attempts[0]!.owner_instance_id,
        moved.publisher.ownerInstanceId,
      );
      assert.equal(transferred.attempts[0]!.fence, moved.publisher.fence);
      assert.equal(transferred.jobs[0]!.current_fence, moved.publisher.fence);
      assert.deepEqual(transferred.slot, [
        {
          singleton: 1,
          job_id: moved.publisher.jobId,
          attempt_no: moved.publisher.attemptNo,
          fence: moved.publisher.fence,
        },
      ]);
      const ioMarker = x.f.executor.events.length;
      const handleMarker = x.f.executor.handleEvents.length;
      const artifactMarker = x.f.artifactEvents.length;
      returnGate.release();
      const result = await read.recovering;
      assert.equal(result.kind, "settled");
      assert.equal(
        returnGate.delivered[0],
        returned.records,
        "wrapper returns the exact canonical result without its own current rejection",
      );
      assert.equal(x.f.executor.events.length, ioMarker);
      assert.equal(x.f.executor.handleEvents.length, handleMarker);
      assert.equal(x.f.artifactEvents.length, artifactMarker);
      const done = explainNegativeReference(x, read, transferred, false, true);
      assertNoOldWrites(transferred, done);
      assertUnchangedSource(read.gated, done);
      assert.equal(x.f.allLaunchCalls.length, 1);
    } finally {
      await x.f.cleanup();
    }
  });

  it("restarts when the reader resumes strictly before the current lease expires", async () => {
    await boundary("lease", -1);
  });
  it("restarts when the reader resumes exactly at the current lease expiry", async () => {
    await boundary("lease", 0);
  });
  it("does not restart when the reader resumes strictly after the current lease expires", async () => {
    await boundary("lease", 1);
  });
  it("restarts when the reader resumes strictly before the original execution deadline", async () => {
    await boundary("deadline", -1);
  });
  it("restarts when the reader resumes exactly at the original execution deadline", async () => {
    await boundary("deadline", 0);
  });
  it("does not restart when the reader resumes strictly after the original execution deadline", async () => {
    await boundary("deadline", 1);
  });

  it("keeps a real interrupted recovery in flight and immediately rejects competing settlement without another acquire", async () => {
    const x = await readSetup();
    try {
      const acquire = x.f.storage.store.acquireArtifactWork.bind(
        x.f.storage.store,
      );
      const acquisitions: {
        publisher: AttemptIdentity;
        purpose: "run" | "recovery";
      }[] = [];
      x.f.storage.store.acquireArtifactWork = (publisher, purpose) => {
        acquisitions.push({ publisher, purpose });
        return acquire(publisher, purpose);
      };
      const read = await enterRead(x);
      assert.equal(acquisitions.length, 1);
      assert.deepEqual(acquisitions[0], {
        publisher: x.s.moved.publisher,
        purpose: "recovery",
      });
      const laterSignal = new AbortController();
      assert.equal(
        x.artifacts.recover(x.s.moved.publisher, laterSignal.signal),
        read.recovering,
      );
      laterSignal.abort();
      const ioMarker = x.f.executor.events.length;
      const artifactMarker = x.f.artifactEvents.length;
      assert.equal(
        await reachedWhilePending(
          x.artifacts.settle(x.s.moved.publisher, "recovery", x.f.signal),
          read.recovering,
        ),
        "stale",
      );
      assert.equal(acquisitions.length, 1);
      assert.deepEqual(rows(x.f), read.gated);
      assert.equal(x.f.executor.events.length, ioMarker);
      assert.equal(x.f.artifactEvents.length, artifactMarker);
      assert.equal(x.f.restartCalls[0]!.signal, x.f.signal);
      assert.equal(x.f.signal.aborted, false);
      x.gate.release();
      assertCreated(x, read, await read.recovering);
      assert.equal(acquisitions.length, 1);
    } finally {
      await x.f.cleanup();
    }
  });

  it("keeps a real success settlement in flight and immediately rejects competing recovery without another acquire", async () => {
    // Interrupted settle returns before engine/reader I/O. This approved
    // direction uses a real ordinary success with the same recovery purpose.
    const gate = artifactGate(
      (event) =>
        event.role === "engine" &&
        event.stage === "read" &&
        (event.bytesRead ?? 0) > 0,
    );
    const f = await authorizedRecoveryFixture({
      observationGateReleases: [gate.release],
    });
    try {
      const s = await source(f, true);
      const acquire = f.storage.store.acquireArtifactWork.bind(f.storage.store);
      const acquisitions: {
        publisher: AttemptIdentity;
        purpose: "run" | "recovery";
      }[] = [];
      f.storage.store.acquireArtifactWork = (publisher, purpose) => {
        acquisitions.push({ publisher, purpose });
        return acquire(publisher, purpose);
      };
      const files: ArtifactFiles = {
        ...f.actualFiles,
        async open(path, flags, mode) {
          const file = await f.actualFiles.open(path, flags, mode);
          return {
            stat: () => file.stat(),
            async read(buffer, offset, length, position) {
              const value = await file.read(buffer, offset, length, position);
              if (path === s.original.inputPath)
                await gate.hook({
                  stage: "read",
                  role: "engine",
                  path,
                  file,
                  buffer,
                  offset,
                  length,
                  position,
                  bytesRead: value.bytesRead,
                });
              return value;
            },
            write: (buffer, offset, length, position) =>
              file.write(buffer, offset, length, position),
            sync: () => file.sync(),
            close: () => file.close(),
          };
        },
      };
      const artifacts = createArtifacts({ store: f.storage.store, files });
      const settling = f.track(
        artifacts.settle(s.moved.publisher, "recovery", f.signal),
      );
      const reached = await reachedWhilePending(gate.reached, settling);
      assert.equal(reached.path, s.original.inputPath);
      assert.ok((reached.bytesRead ?? 0) > 0);
      assert.equal(acquisitions.length, 1);
      assert.deepEqual(acquisitions[0], {
        publisher: s.moved.publisher,
        purpose: "recovery",
      });
      const gated = rows(f);
      assert.equal(gated.references.length, 1);
      assert.equal(gated.references[0]!.purpose, "recovery");
      assert.equal(
        gated.references[0]!.incarnation_id,
        s.control.incarnation_id,
      );
      assert.deepEqual(
        JSON.parse(gated.references[0]!.publisher_identity_json),
        s.moved.publisher,
      );
      assert.equal(gated.references[0]!.released_at, null);
      const laterSignal = new AbortController();
      assert.equal(
        artifacts.settle(s.moved.publisher, "recovery", laterSignal.signal),
        settling,
      );
      laterSignal.abort();
      const ioMarker = f.executor.events.length;
      const artifactMarker = f.artifactEvents.length;
      const competing = await reachedWhilePending(
        artifacts.recover(s.moved.publisher, f.signal),
        settling,
      );
      assert.deepEqual(competing, { kind: "settled", verdict: "stale" });
      assert.equal(acquisitions.length, 1);
      assert.equal(f.restartCalls.length, 0);
      assert.deepEqual(rows(f), gated);
      assert.equal(f.executor.events.length, ioMarker);
      assert.equal(f.artifactEvents.length, artifactMarker);
      assert.equal(f.signal.aborted, false);
      gate.release();
      assert.equal(await settling, "succeeded");
      assertEngineRead(f, s.original);
      const done = rows(f);
      assert.equal(done.jobs[0]!.status, "succeeded");
      assert.equal(done.jobs[0]!.reason, null);
      assert.notEqual(done.jobs[0]!.result_candidate_id, null);
      assert.equal(done.attempts.length, 1);
      assert.equal(done.events.length, 0);
      assert.equal(done.candidates.length, 1);
      assert.equal(done.references.length, 1);
      assert.notEqual(done.references[0]!.released_at, null);
      assert.deepEqual(done.slot, []);
      assertUnchangedSource(gated, done);
      assert.deepEqual(done.controls, gated.controls);
      assert.equal(acquisitions.length, 1);
      assert.equal(f.restartCalls.length, 0);
      assert.equal(
        f.executor.events.some(
          (event) => event.operation === "reader" || event.operation === "stop",
        ),
        false,
      );
      assert.equal(f.allLaunchCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps an interrupted reader current after a real valid lease renewal", async () => {
    const positive = await readSetup();
    try {
      const read = await enterRead(positive);
      positive.gate.release();
      assertCreated(positive, read, await read.recovering);
    } finally {
      await positive.f.cleanup();
    }
    const x = await readSetup();
    try {
      const read = await enterRead(x);
      const before = rows(x.f);
      const policy = x.s.original.executionPolicy.limits;
      const heartbeatAt =
        before.attempts[0]!.lease_expires_at -
        policy.leaseDurationMs +
        policy.heartbeatIntervalMs;
      assert.ok(heartbeatAt > x.f.storage.clock());
      assert.ok(
        heartbeatAt <= before.attempts[0]!.lease_expires_at &&
          heartbeatAt <= before.jobs[0]!.execution_deadline_at,
      );
      x.f.time.advanceTo(heartbeatAt);
      assert.equal(x.f.storage.store.renewLease(x.s.moved.publisher), true);
      const renewed = rows(x.f);
      assert.ok(
        renewed.attempts[0]!.lease_expires_at >
          before.attempts[0]!.lease_expires_at,
      );
      assert.deepEqual(renewed, {
        ...before,
        attempts: [
          {
            ...before.attempts[0]!,
            lease_expires_at: heartbeatAt + policy.leaseDurationMs,
          },
        ],
      });
      assert.equal(x.f.signal.aborted, false);
      assert.equal(x.f.storage.store.closed, false);
      assert.equal(x.f.executor.retired, false);
      assert.equal(renewed.jobs[0]!.cancel_requested_at, null);
      assert.equal(renewed.attempts[0]!.stop_reason, null);
      x.gate.release();
      assertCreated(x, read, await read.recovering);
    } finally {
      await x.f.cleanup();
    }
  });
});
