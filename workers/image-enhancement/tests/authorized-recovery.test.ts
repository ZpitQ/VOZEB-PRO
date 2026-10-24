import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { createArtifacts } from "../src/artifacts.js";
import type {
  AttemptIdentity,
  DurableInterruptionRecords,
  ExecutionExit,
  InterruptionReadScope,
} from "../src/execution.js";
import {
  authorizedRecoveryFixture,
  type AuthorizedRecoveryFixture,
} from "./authorized-recovery-fixtures.js";
import type { OrdinaryCompletion } from "./authorized-recovery-records.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  fixtureAuthorizeGuard,
  fixturePrepareGuard,
} from "./execution-send-permission-fixtures.js";
import { target } from "./recovery-fixtures.js";
import { sha256 } from "./storage-fixtures.js";

async function reachedWhilePending<T, Reached>(
  reached: Promise<Reached>,
  pending: Promise<T>,
): Promise<Reached> {
  return Promise.race([
    reached,
    pending.then(() => {
      throw new Error(
        "recovery chain settled before the required real controlled stage",
      );
    }),
  ]);
}

async function preparedSource(f: AuthorizedRecoveryFixture) {
  await f.submit();
  const original = f.storage.store.claimNext("durable-fixture-producer");
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
  return {
    original,
    owner,
    scope: { target: target(original), descriptor: owner },
  };
}

function assertFrozen(value: unknown) {
  if (value && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertFrozen(child);
  }
}

describe("durable authorized recovery fixture self-checks", () => {
  it("durable fixture rereads interruption records after facade reopen and refuses a removed final record", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const { original, owner, scope } = await preparedSource(f);
      await f.executor.adapter.authorize(
        original,
        owner,
        fixtureAuthorizeGuard(f.storage.store, original, owner),
      );
      assert.equal(f.executor.launchCalls.length, 1);
      await f.executor.loseController(target(original));
      const first = await f.executor.adapter.readInterruptionEvidence(
        scope,
        () => true,
      );
      assert.ok(first);
      assertFrozen(first);
      const oldFacade = f.executor;
      await f.reopen();
      assert.equal(oldFacade.retired, true);
      assert.notEqual(f.executor, oldFacade);
      const reread = await f.executor.adapter.readInterruptionEvidence(
        scope,
        () => true,
      );
      assert.ok(reread);
      assert.deepEqual(reread, first);
      assert.notEqual(reread, first);
      assert.notEqual(reread.authorization, first.authorization);
      assertFrozen(reread);
      assert.deepEqual(reread.authorization.scope, scope);
      assert.deepEqual(reread.controllerLoss.scope, scope);
      assert.deepEqual(reread.terminal.scope, scope);
      assert.equal(
        reread.controllerLoss.authorizationRecordId,
        reread.authorization.recordId,
      );
      assert.equal(
        reread.terminal.authorizationRecordId,
        reread.authorization.recordId,
      );
      assert.equal(
        reread.terminal.controllerLossRecordId,
        reread.controllerLoss.recordId,
      );
      assert.equal(
        new Set([
          reread.authorization.recordId,
          reread.controllerLoss.recordId,
          reread.terminal.recordId,
        ]).size,
        3,
      );
      const inspected = await f.executor.adapter.inspect(
        target(original),
        owner,
      );
      assert.equal(inspected.kind, "tree-exited");
      if (inspected.kind !== "tree-exited")
        assert.fail("durable terminal must be inspected");
      assert.deepEqual(inspected.exit.completion, {
        kind: "interrupted",
        authorizationRecordId: reread.authorization.recordId,
        controllerLossRecordId: reread.controllerLoss.recordId,
        terminalRecordId: reread.terminal.recordId,
      });
      const terminalBytes = await f.executor.recordBytes(
        target(original),
        "terminal",
      );
      assert.ok(terminalBytes);
      await f.executor.rewriteRecordBytes(
        target(original),
        "terminal",
        (actual) => {
          assert.deepEqual(actual, terminalBytes);
          return undefined;
        },
      );
      const marker = f.executor.events.length;
      assert.equal(
        await f.executor.adapter.readInterruptionEvidence(scope, () => true),
        undefined,
      );
      assert.ok(
        f.executor.events
          .slice(marker)
          .some(
            (event) =>
              event.operation === "reader" &&
              event.role === "terminal" &&
              event.stage === "open" &&
              event.phase === "after" &&
              event.missing === true,
          ),
        "the reopened reader must reach the removed terminal's actual open/ENOENT",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("durable fixture seals an issued authorization before its delayed start without retiring the facade", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const { original, owner, scope } = await preparedSource(f);
      const facade = f.executor;
      const gate = f.gate(
        (event) =>
          event.operation === "authorize" &&
          event.role === "authorization" &&
          event.stage === "start" &&
          event.phase === "before",
      );
      facade.hooks.before = gate.hook;
      const authorizing = f.track(
        facade.adapter.authorize(
          original,
          owner,
          fixtureAuthorizeGuard(f.storage.store, original, owner),
        ),
      );
      await reachedWhilePending(gate.reached, authorizing);
      const authorizationBytes = await facade.recordBytes(
        target(original),
        "authorization",
      );
      assert.ok(authorizationBytes);
      const authorization = JSON.parse(
        authorizationBytes.toString("utf8"),
      ) as DurableInterruptionRecords["authorization"];
      assert.deepEqual(authorization.scope, scope);
      assert.equal(facade.launchCalls.length, 0);
      await facade.loseController(target(original));
      const interrupted = await facade.adapter.readInterruptionEvidence(
        scope,
        () => true,
      );
      assert.ok(interrupted);
      assert.equal(interrupted.authorization.recordId, authorization.recordId);
      assert.equal(facade.retired, false);
      assert.equal(f.signal.aborted, false);
      const marker = facade.events.length;
      gate.release();
      await authorizing;
      assert.equal(facade.retired, false);
      assert.equal(facade.launchCalls.length, 0);
      assert.ok(
        facade.events
          .slice(marker)
          .some(
            (event) =>
              event.operation === "authorize" &&
              event.role === "sealed" &&
              event.stage === "directory-sync" &&
              event.phase === "after",
          ),
        "late authorization must actually reread the durable seal on its live facade",
      );
      assert.equal(
        facade.events
          .slice(marker)
          .some(
            (event) =>
              event.operation === "authorize" &&
              event.stage === "start" &&
              event.phase === "after",
          ),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });

  it("durable fixture keeps inspection reachable while a controlled tree has not exited", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      const { original, owner, scope } = await preparedSource(f);
      await f.executor.adapter.authorize(
        original,
        owner,
        fixtureAuthorizeGuard(f.storage.store, original, owner),
      );
      const tree = f.executor.holdTreeExit(target(original));
      const losing = f.track(f.executor.loseController(target(original)));
      await reachedWhilePending(tree.reached, losing);
      assert.equal(tree.allExited(), false);
      assert.ok(
        await f.executor.recordBytes(target(original), "controller-loss"),
      );
      assert.equal(
        await f.executor.recordBytes(target(original), "terminal"),
        undefined,
      );
      const inspected = await f.executor.adapter.inspect(
        target(original),
        owner,
      );
      assert.ok(
        inspected.kind === "owned-alive" || inspected.kind === "unknown",
      );
      assert.equal(
        await f.executor.adapter.readInterruptionEvidence(scope, () => true),
        undefined,
      );
      assert.equal(tree.allExited(), false);
      tree.release();
      await losing;
      assert.equal(tree.allExited(), true);
      const records = await f.executor.adapter.readInterruptionEvidence(
        scope,
        () => true,
      );
      assert.ok(records);
      assert.equal(records.terminal.treeExited, true);
      assert.equal(records.terminal.authorizationsSealed, true);
      const terminal = await f.executor.adapter.inspect(
        target(original),
        owner,
      );
      assert.equal(terminal.kind, "tree-exited");
    } finally {
      await f.cleanup();
    }
  });

  async function preservesOrdinaryTerminal(completion: OrdinaryCompletion) {
    const f = await authorizedRecoveryFixture();
    try {
      const { original, owner, scope } = await preparedSource(f);
      await f.executor.adapter.authorize(
        original,
        owner,
        fixtureAuthorizeGuard(f.storage.store, original, owner),
      );
      await f.executor.finish(target(original), completion);
      const before = await f.executor.recordBytes(target(original), "terminal");
      assert.ok(before);
      assert.equal(JSON.parse(before.toString("utf8")).kind, "completed");
      const marker = f.executor.events.length;
      await f.executor.loseController(target(original));
      assert.deepEqual(
        await f.executor.recordBytes(target(original), "terminal"),
        before,
      );
      assert.equal(
        await f.executor.recordBytes(target(original), "controller-loss"),
        undefined,
      );
      assert.equal(
        f.executor.events
          .slice(marker)
          .some(
            (event) =>
              event.operation === "loss" &&
              (event.stage === "write" || event.stage === "rename"),
          ),
        false,
        "loss after a durable ordinary terminal must not write another classification",
      );
      await f.reopen();
      const inspected = await f.executor.adapter.inspect(
        target(original),
        owner,
      );
      assert.equal(inspected.kind, "tree-exited");
      if (inspected.kind !== "tree-exited")
        assert.fail("ordinary durable terminal must survive reopen");
      assert.deepEqual(inspected.exit.completion, completion);
      assert.deepEqual(
        await f.executor.recordBytes(target(original), "terminal"),
        before,
      );
      assert.equal(
        await f.executor.adapter.readInterruptionEvidence(scope, () => true),
        undefined,
      );
    } finally {
      await f.cleanup();
    }
  }

  it("durable fixture preserves a durable success terminal when controller loss arrives later", async () => {
    await preservesOrdinaryTerminal({
      kind: "success",
      exitCode: 0,
      signal: null,
    });
  });

  it("durable fixture preserves a durable failure terminal when controller loss arrives later", async () => {
    await preservesOrdinaryTerminal({
      kind: "failure",
      exitCode: 7,
      signal: null,
    });
  });
});

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
      .all() as ObservationRow[],
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

describe("durable authorized interruption production recovery", () => {
  it("reopens a durably interrupted source and atomically creates one replacement through artifacts recovery", async () => {
    const f = await authorizedRecoveryFixture();
    try {
      // The business sequence is deliberately visible: no pre-acquire, injected
      // observations or hand-written attempts/controls/events are involved.
      await f.submit();
      const original = f.storage.store.claimNext(
        "authorized-interruption-producer",
      );
      assert.ok(original);
      const owner = await f.executor.adapter.prepare(
        original,
        fixturePrepareGuard(f.storage.store, original),
      );
      assert.equal(
        f.storage.store.registerPrepared(original.identity, owner),
        true,
      );
      assert.equal(
        f.storage.store.authorizeLaunch(original.identity, owner),
        true,
      );
      await f.executor.adapter.authorize(
        original,
        owner,
        fixtureAuthorizeGuard(f.storage.store, original, owner),
      );
      assert.equal(f.allLaunchCalls.length, 1);
      const accepted = rows(f);
      const acceptedJob = accepted.jobs[0];
      const acceptedAttempt = accepted.attempts[0];
      assert.ok(acceptedJob && acceptedAttempt);
      assert.equal(accepted.attempts.length, 1);
      assert.equal(accepted.events.length, 0);
      assert.equal(accepted.references.length, 0);
      assert.notEqual(acceptedAttempt.authorized_at, null);
      assert.equal(acceptedAttempt.sealed_at, null);
      await f.executor.loseController(target(original));
      const oldFacade = f.executor;
      const oldReader = oldFacade.adapter.readInterruptionEvidence;
      await f.reopen();
      assert.equal(oldFacade.retired, true);
      assert.notEqual(f.executor, oldFacade);
      assert.notEqual(f.executor.adapter.readInterruptionEvidence, oldReader);
      const session = f.storage.store.beginRecovery(
        "authorized-interruption-recovery",
      );
      assert.ok(session);
      assert.deepEqual(session.target, target(original));
      assert.deepEqual(session.active.ownerDescriptor, owner);
      const inspected = await f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      assert.equal(inspected.kind, "tree-exited");
      if (inspected.kind !== "tree-exited")
        assert.fail(
          "the reopened facade must read a real durable interruption",
        );
      assert.equal(inspected.exit.completion?.kind, "interrupted");
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
      assert.deepEqual(transferred.slot, [
        {
          singleton: 1,
          job_id: original.identity.jobId,
          attempt_no: original.identity.attemptNo,
          fence: moved.publisher.fence,
        },
      ]);
      const source = transferred.attempts[0];
      const control = transferred.controls[0];
      assert.ok(source && control);
      assert.equal(
        source.producer_identity_json,
        acceptedAttempt.producer_identity_json,
      );
      assert.equal(
        source.producer_incarnation_id,
        acceptedAttempt.producer_incarnation_id,
      );
      assert.equal(source.launch_ticket, original.launchTicket);
      assert.equal(source.run_directory, acceptedAttempt.run_directory);
      assert.equal(source.authorized_at, acceptedAttempt.authorized_at);
      assert.equal(
        source.owner_descriptor_json,
        acceptedAttempt.owner_descriptor_json,
      );
      assert.equal(source.sealed_at, null);
      assert.deepEqual(JSON.parse(source.exit_json!), inspected.exit);
      assert.equal(transferred.controls.length, 1);
      assert.equal(control.state, "consumed");
      assert.equal(control.classification, "tree-exited");
      assert.notEqual(control.observed_at, null);
      assert.notEqual(control.consumed_at, null);
      assert.equal(
        control.source_incarnation_id,
        acceptedAttempt.producer_incarnation_id,
      );
      assert.notEqual(control.incarnation_id, control.source_incarnation_id);
      assert.deepEqual(
        JSON.parse(control.source_identity_json),
        original.identity,
      );
      const prePublisher = JSON.parse(
        control.publisher_identity_json,
      ) as AttemptIdentity;
      assert.deepEqual(prePublisher, original.identity);
      assert.ok(Number.isSafeInteger(prePublisher.fence + 1));
      assert.deepEqual(
        {
          ...prePublisher,
          ownerInstanceId: control.owner_instance_id,
          fence: prePublisher.fence + 1,
        },
        moved.publisher,
      );
      assert.equal(source.owner_instance_id, moved.publisher.ownerInstanceId);
      assert.equal(source.fence, moved.publisher.fence);
      assert.equal(
        f.executor.events.some((event) => event.operation === "reader"),
        false,
      );

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
      const recovering = f.track(artifacts.recover(moved.publisher, f.signal));
      await reachedWhilePending(gate.reached, recovering);

      // These GREEN expectations are intentionally beyond today's recover
      // throw-only seam. Only the root run establishes the actual deepest gate.
      assert.equal(f.restartCalls.length, 1);
      const restartCall = f.restartCalls[0];
      assert.ok(restartCall);
      assert.equal(restartCall.signal, f.signal);
      assert.deepEqual(restartCall.key.publisher, moved.publisher);
      const gated = rows(f);
      assert.equal(gated.attempts.length, 1);
      assert.equal(gated.events.length, 0);
      assert.deepEqual(gated.slot, transferred.slot);
      assert.equal(gated.references.length, 1);
      const held = gated.references.find(
        (row) => row.reference_id === restartCall.key.referenceId,
      );
      assert.ok(held);
      assert.equal(held.released_at, null);
      assert.equal(held.purpose, "recovery");
      assert.equal(held.candidate_id, null);
      assert.equal(held.incarnation_id, control.incarnation_id);
      assert.deepEqual(
        JSON.parse(held.publisher_identity_json),
        moved.publisher,
      );
      assert.equal(held.job_id, original.identity.jobId);
      assert.equal(held.attempt_no, original.identity.attemptNo);
      assert.deepEqual(
        gated.observations
          .filter((row) => row.reference_id === held.reference_id)
          .map((row) => ({
            candidateId: row.candidate_id,
            code: row.code,
            checkedEngineSha256: row.checked_engine_sha256,
          })),
        [
          {
            candidateId: null,
            code: "no_qualified_candidate",
            checkedEngineSha256: original.job.engineInput.sha256,
          },
        ],
      );
      assert.equal(gated.candidates.length, 0);
      const engineReads = f.artifactEvents.filter(
        (event) =>
          event.path === original.inputPath &&
          event.stage === "read" &&
          (event.bytesRead ?? 0) > 0,
      );
      assert.ok(engineReads.length > 0);
      let readPosition = 0;
      for (const read of engineReads) {
        assert.equal(read.position, readPosition);
        assert.ok(read.bytes);
        assert.equal(read.bytes.length, read.bytesRead);
        readPosition += read.bytes.length;
      }
      const engineBytes = Buffer.concat(engineReads.map((read) => read.bytes!));
      assert.equal(engineBytes.length, original.job.engineInput.byteLength);
      assert.equal(sha256(engineBytes), original.job.engineInput.sha256);
      assert.ok(
        f.artifactEvents.some(
          (event) =>
            event.path === original.inputPath &&
            event.stage === "stat" &&
            event.size === engineBytes.length,
        ),
      );
      assert.ok(
        f.artifactEvents.some(
          (event) =>
            event.path === original.inputPath && event.stage === "close",
        ),
      );
      assert.equal(f.allLaunchCalls.length, 1);
      gate.release();
      const result = await recovering;
      assert.equal(result.kind, "restarted");
      if (result.kind !== "restarted")
        assert.fail(
          "durable authorized interruption must return the real restart outcome",
        );
      assert.equal(result.outcome.kind, "created");
      if (result.outcome.kind !== "created")
        assert.fail("the first recovery must create exactly one replacement");
      const replacement = result.outcome.attempt;
      const recoveryReaderEvents = [...f.executor.events].filter(
        (event) => event.operation === "reader",
      );
      for (const role of [
        "authorization",
        "controller-loss",
        "terminal",
      ] as const)
        assert.ok(
          recoveryReaderEvents.some(
            (event) =>
              event.role === role &&
              event.stage === "read" &&
              event.phase === "after" &&
              (event.bytesRead ?? 0) > 0,
          ),
        );
      const done = rows(f);
      assert.equal(done.attempts.length, 2);
      assert.equal(done.events.length, 1);
      assert.equal(done.controls.length, 1);
      assert.equal(done.references.length, 1);
      assert.equal(done.candidates.length, 0);
      const event = done.events[0];
      const originalRow = done.attempts[0];
      const replacementRow = done.attempts[1];
      const job = done.jobs[0];
      assert.ok(event && originalRow && replacementRow && job);
      assert.equal(event.kind, "authorized-interruption");
      assert.equal(event.sealed_at, null);
      assert.notEqual(event.consumed_at, null);
      assert.equal(event.job_id, original.identity.jobId);
      assert.equal(event.launch_ticket, original.launchTicket);
      assert.equal(
        event.source_incarnation_id,
        acceptedAttempt.producer_incarnation_id,
      );
      assert.equal(event.recovery_incarnation_id, control.incarnation_id);
      assert.deepEqual(
        JSON.parse(event.source_identity_json),
        original.identity,
      );
      assert.deepEqual(
        JSON.parse(event.consumed_publisher_identity_json!),
        moved.publisher,
      );
      assert.equal(
        event.replacement_attempt_no,
        replacement.identity.attemptNo,
      );
      assert.ok(event.evidence_json);
      const evidence = JSON.parse(event.evidence_json) as {
        v: number;
        recoveryId: string;
        referenceId: string;
        records: DurableInterruptionRecords;
      };
      assert.equal(evidence.v, 1);
      assert.equal(evidence.recoveryId, control.recovery_id);
      assert.equal(evidence.referenceId, held.reference_id);
      const actualRecords = {
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
      };
      assert.deepEqual(evidence.records, actualRecords);
      const scope: InterruptionReadScope = {
        target: target(original),
        descriptor: owner,
      };
      for (const record of Object.values(evidence.records))
        assert.deepEqual(record.scope, scope);
      const raw = JSON.parse(originalRow.exit_json!) as ExecutionExit;
      assert.deepEqual(raw, inspected.exit);
      assert.deepEqual(raw.completion, {
        kind: "interrupted",
        authorizationRecordId: evidence.records.authorization.recordId,
        controllerLossRecordId: evidence.records.controllerLoss.recordId,
        terminalRecordId: evidence.records.terminal.recordId,
      });
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
        assert.equal(originalRow[field], acceptedAttempt[field]);
      assert.equal(originalRow.sealed_at, null);
      assert.equal(replacement.identity.jobId, original.identity.jobId);
      assert.equal(
        replacement.identity.attemptNo,
        original.identity.attemptNo + 1,
      );
      assert.equal(replacement.identity.fence, moved.publisher.fence + 1);
      assert.ok(
        Number.isSafeInteger(replacement.identity.attemptNo) &&
          Number.isSafeInteger(replacement.identity.fence),
      );
      assert.notEqual(replacement.launchTicket, original.launchTicket);
      assert.notEqual(replacement.workingDirectory, original.workingDirectory);
      assert.equal(replacement.inputPath, original.inputPath);
      assert.equal(replacement.tile, original.tile);
      assert.deepEqual(replacement.executionPolicy, original.executionPolicy);
      assert.deepEqual(replacement.job.source, original.job.source);
      assert.deepEqual(replacement.job.engineInput, original.job.engineInput);
      assert.deepEqual(replacement.job.plan, original.job.plan);
      assert.equal(replacement.firstStartedAt, original.firstStartedAt);
      assert.equal(
        replacement.executionDeadlineAt,
        original.executionDeadlineAt,
      );
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
      assert.equal(job.active_attempt_no, replacement.identity.attemptNo);
      assert.equal(job.current_fence, replacement.identity.fence);
      assert.deepEqual(done.slot, [
        {
          singleton: 1,
          job_id: original.identity.jobId,
          attempt_no: replacement.identity.attemptNo,
          fence: replacement.identity.fence,
        },
      ]);
      assert.equal(replacementRow.owner_descriptor_json, null);
      assert.equal(replacementRow.prepared_at, null);
      assert.equal(replacementRow.authorized_at, null);
      assert.equal(replacementRow.exit_json, null);
      assert.equal(replacementRow.sealed_at, null);
      const released = done.references.find(
        (row) => row.reference_id === held.reference_id,
      );
      assert.ok(
        released && released.released_at !== null,
        "only the actual owned ref may finish after durable restart consumption",
      );
      assert.equal(
        f.allLaunchCalls.length,
        1,
        "this slice creates the replacement but does not start it",
      );
    } finally {
      await f.cleanup();
    }
  });
});
