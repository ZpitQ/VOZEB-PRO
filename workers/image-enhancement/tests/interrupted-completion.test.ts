import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import {
  freezeExecutionExit,
  type ExecutionExit,
  type ExecutionTarget,
  type InterruptedCompletion,
  type OwnerDescriptor,
} from "../src/execution.js";
import { openStore } from "../src/store.js";
import {
  descriptor,
  snapshot,
  treeExit,
  type StorageFixture,
} from "./lifecycle-fixtures.js";
import { target } from "./recovery-fixtures.js";
import { sourceImage, storageFixture, submission } from "./storage-fixtures.js";

const fixtures: StorageFixture[] = [];
afterEach(async () => {
  for (const storage of fixtures.splice(0).reverse()) await storage.cleanup();
});

const normalizerTarget: ExecutionTarget = {
  identity: {
    jobId: "interrupted-normalizer-job",
    attemptNo: 1,
    ownerInstanceId: "interrupted-producer",
    fence: 1,
  },
  launchTicket: "interrupted-normalizer-ticket",
};

function interruptedExit(
  execution: ExecutionTarget,
  owner: OwnerDescriptor = descriptor(execution),
): ExecutionExit & Readonly<{ completion: InterruptedCompletion }> {
  // 本片故意只输入 raw 声明；这些 ID 没有对应的可信 Adapter 持久记录。
  return {
    ...treeExit(execution, owner),
    completion: {
      kind: "interrupted",
      authorizationRecordId: "raw-authorization-record",
      controllerLossRecordId: "raw-controller-loss-record",
      terminalRecordId: "raw-terminal-record",
    },
  };
}

async function authorized() {
  const storage = await storageFixture();
  fixtures.push(storage);
  await storage
    .service()
    .submit(storage.principal(), submission(await sourceImage()));
  const attempt = storage.store.claimNext("interrupted-producer");
  assert.ok(attempt);
  const owner = descriptor(attempt);
  assert.equal(storage.store.registerPrepared(attempt.identity, owner), true);
  assert.equal(storage.store.authorizeLaunch(attempt.identity, owner), true);
  return { storage, attempt, owner };
}

function rows(storage: StorageFixture) {
  return snapshot(storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all() as Record<string, unknown>[],
    slot: db.prepare("SELECT * FROM execution_slot").all() as Record<
      string,
      unknown
    >[],
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all() as Record<string, unknown>[],
    events: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
  }));
}

function reopen(storage: StorageFixture) {
  storage.store.close();
  storage.setStore(
    openStore({ directory: storage.directory, clock: storage.clock }),
  );
}

describe("raw interrupted completion classification", () => {
  it("freezes a canonical interrupted completion without treating raw record IDs as recovery authority", () => {
    const identity = { ...normalizerTarget.identity };
    const details = { controlled: true, nested: { labels: ["original"] } };
    const owner = { ...descriptor(normalizerTarget), details };
    const completion = {
      kind: "interrupted" as const,
      authorizationRecordId: "raw-authorization-record",
      controllerLossRecordId: "raw-controller-loss-record",
      terminalRecordId: "raw-terminal-record",
    };
    const exit: ExecutionExit = {
      ...treeExit(normalizerTarget, owner),
      identity,
      completion,
    };
    const frozen = freezeExecutionExit(exit, normalizerTarget, owner);
    expect(frozen).toEqual(exit);
    expect(frozen).not.toBe(exit);
    expect(frozen.identity).not.toBe(identity);
    expect(frozen.descriptor).not.toBe(owner);
    expect(frozen.descriptor.details).not.toBe(details);
    expect(frozen.completion).not.toBe(completion);
    expect(frozen.identity).toEqual(normalizerTarget.identity);
    expect(frozen.descriptor).toEqual(owner);
    expect(frozen.launchTicket).toBe(normalizerTarget.launchTicket);
    expect(Object.keys(frozen.completion!).sort()).toEqual(
      [
        "kind",
        "authorizationRecordId",
        "controllerLossRecordId",
        "terminalRecordId",
      ].sort(),
    );
    expect(Object.hasOwn(frozen.completion!, "exitCode")).toBe(false);
    expect(Object.hasOwn(frozen.completion!, "signal")).toBe(false);
    const frozenDetails = frozen.descriptor.details as typeof details;
    for (const value of [
      frozen,
      frozen.identity,
      frozen.descriptor,
      frozen.descriptor.details,
      frozenDetails.nested,
      frozenDetails.nested.labels,
      frozen.completion,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    identity.fence += 1;
    details.nested.labels[0] = "changed";
    completion.terminalRecordId = "changed-terminal-record";
    expect(frozen.identity).toEqual(normalizerTarget.identity);
    expect(frozenDetails.nested.labels).toEqual(["original"]);
    expect(frozen.completion).toEqual({
      kind: "interrupted",
      authorizationRecordId: "raw-authorization-record",
      controllerLossRecordId: "raw-controller-loss-record",
      terminalRecordId: "raw-terminal-record",
    });
  });

  it("persists an interrupted callback classification across store reopen without creating a recovery event", async () => {
    const { storage, attempt, owner } = await authorized();
    const exit = interruptedExit(attempt, owner);
    const before = rows(storage);
    storage.setNow(1_050);
    expect(storage.store.registerExit(exit)).toBe(true);
    const persisted = rows(storage);
    expect(persisted.attempts).toEqual(
      before.attempts.map((row) => ({
        ...row,
        exit_json: JSON.stringify(exit),
        exit_observed_at: storage.clock(),
      })),
    );
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.attempts[0]).toMatchObject({
      producer_identity_json: JSON.stringify(attempt.identity),
      owner_descriptor_json: JSON.stringify(owner),
      launch_ticket: attempt.launchTicket,
      authorized_at: 1_000,
      sealed_at: null,
    });
    expect(persisted.jobs).toEqual(before.jobs);
    expect(persisted.slot).toEqual(before.slot);
    expect(persisted.controls).toEqual([]);
    expect(persisted.events).toEqual([]);
    reopen(storage);
    expect(rows(storage)).toEqual(persisted);
    expect(storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
      identity: attempt.identity,
      producer: attempt.identity,
      launchTicket: attempt.launchTicket,
      ownerDescriptor: owner,
      authorizedAt: 1_000,
      firstStartedAt: attempt.firstStartedAt,
      executionDeadlineAt: attempt.executionDeadlineAt,
      workingDirectory: attempt.workingDirectory,
      exit,
    });
    expect(
      storage.store.getOwned(storage.principal(), attempt.identity.jobId),
    ).toMatchObject({ status: "running", reason: null, result: null });
    expect(storage.store.claimNext("unrelated-owner")).toBeUndefined();
    expect(rows(storage)).toEqual(persisted);
  });

  it("persists an interrupted inspection while transferring only publisher and creating no recovery event", async () => {
    const { storage, attempt, owner } = await authorized();
    const exit = interruptedExit(attempt, owner);
    storage.setNow(1_100);
    reopen(storage);
    const session = storage.store.beginRecovery("interrupted-recovery-owner");
    assert.ok(session);
    expect(session.target).toEqual(target(attempt));
    expect(session.active.ownerDescriptor).toEqual(owner);
    const before = rows(storage);
    const resolution = storage.store.applyRecoveryInspection(session.control, {
      kind: "tree-exited",
      exit,
    });
    assert.ok(resolution?.kind === "transferred");
    expect(resolution).toEqual({
      kind: "transferred",
      publisher: {
        ...attempt.identity,
        ownerInstanceId: "interrupted-recovery-owner",
        fence: attempt.identity.fence + 1,
      },
      startupEventId: null,
    });
    const persisted = rows(storage);
    expect(persisted.attempts).toEqual(
      before.attempts.map((row) => ({
        ...row,
        owner_instance_id: resolution.publisher.ownerInstanceId,
        fence: resolution.publisher.fence,
        lease_expires_at:
          storage.clock() + attempt.executionPolicy.limits.leaseDurationMs,
        exit_json: JSON.stringify(exit),
        exit_observed_at: storage.clock(),
      })),
    );
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.jobs).toEqual(
      before.jobs.map((row) => ({
        ...(row as Record<string, unknown>),
        current_fence: resolution.publisher.fence,
      })),
    );
    expect(persisted.slot).toEqual(
      before.slot.map((row) => ({ ...row, fence: resolution.publisher.fence })),
    );
    expect(persisted.controls).toEqual(
      before.controls.map((row) => ({
        ...row,
        state: "consumed",
        classification: "tree-exited",
        observed_at: storage.clock(),
        consumed_at: storage.clock(),
      })),
    );
    expect(persisted.events).toEqual([]);
    expect(storage.store.getActiveAttempt(resolution.publisher)).toMatchObject({
      identity: resolution.publisher,
      producer: attempt.identity,
      launchTicket: attempt.launchTicket,
      ownerDescriptor: owner,
      preparedAt: 1_000,
      authorizedAt: 1_000,
      firstStartedAt: attempt.firstStartedAt,
      executionDeadlineAt: attempt.executionDeadlineAt,
      inputPath: attempt.inputPath,
      workingDirectory: attempt.workingDirectory,
      outputPath: attempt.outputPath,
      tile: attempt.tile,
      exit,
    });
    reopen(storage);
    expect(rows(storage)).toEqual(persisted);
    expect(storage.store.getActiveAttempt(resolution.publisher)?.exit).toEqual(
      exit,
    );
    expect(storage.store.claimNext("unrelated-owner")).toBeUndefined();
    expect(rows(storage)).toEqual(persisted);
  });

  it("rejects interrupted completion missing terminalRecordId", () => {
    const exit = interruptedExit(normalizerTarget);
    const { terminalRecordId: _terminalRecordId, ...completion } =
      exit.completion;
    const malformed = { ...exit, completion } as unknown as ExecutionExit;
    expect(() =>
      freezeExecutionExit(malformed, normalizerTarget, exit.descriptor),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });

  it("rejects interrupted completion carrying exitCode and signal", () => {
    const exit = interruptedExit(normalizerTarget);
    const malformed: ExecutionExit = {
      ...exit,
      completion: { ...exit.completion, exitCode: 0, signal: null },
    } as ExecutionExit;
    expect(() =>
      freezeExecutionExit(malformed, normalizerTarget, exit.descriptor),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });

  it("rejects interrupted completion with an invalid controllerLossRecordId", () => {
    const exit = interruptedExit(normalizerTarget);
    const malformed: ExecutionExit = {
      ...exit,
      completion: { ...exit.completion, controllerLossRecordId: "\u0000" },
    };
    expect(() =>
      freezeExecutionExit(malformed, normalizerTarget, exit.descriptor),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });
});
