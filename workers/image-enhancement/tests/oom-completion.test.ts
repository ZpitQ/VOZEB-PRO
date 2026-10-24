import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import {
  freezeExecutionExit,
  type ClaimedAttempt,
  type ExecutionExit,
} from "../src/execution.js";
import {
  completionExit,
  completionFixture,
  type CompletionFixture,
} from "./completion-fixtures.js";

const fixtures: CompletionFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});

async function fixture() {
  const f = await completionFixture();
  fixtures.push(f);
  return f;
}

const oom = { kind: "oom", exitCode: 7, signal: null } as const;
const signalOom = { kind: "oom", exitCode: null, signal: "SIGKILL" } as const;

function exitWith(attempt: ClaimedAttempt, completion: unknown): ExecutionExit {
  // G1 adds the production union after these actual consumers demonstrate RED.
  return { ...completionExit(attempt), completion } as unknown as ExecutionExit;
}

async function recovery(f: CompletionFixture) {
  await f.reopen();
  const session = f.storage.store.beginRecovery("oom-recovery");
  assert.ok(session, "fixture must recover the occupied execution slot");
  return session;
}

describe("explicit OOM completion", () => {
  it("accepts an explicit OOM callback and preserves it across store reopen", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const exit = exitWith(attempt, oom);
    const before = f.rows();
    f.storage.setNow(1_050);

    expect(f.storage.store.registerExit(exit)).toBe(true);
    const persisted = f.rows();
    expect(persisted).toEqual({
      ...before,
      attempts: before.attempts.map((row) => ({
        ...(row as Record<string, unknown>),
        exit_json: JSON.stringify(exit),
        exit_observed_at: f.storage.clock(),
      })),
    });
    expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
      producer: attempt.identity,
      launchTicket: attempt.launchTicket,
      authorizedAt: 1_000,
      workingDirectory: attempt.workingDirectory,
      tile: attempt.tile,
      exit,
    });
    await f.reopen();
    expect(f.rows()).toEqual(persisted);
    expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
      exit,
    );
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      reason: null,
      result: null,
    });
    expect(f.storage.store.claimNext("oom-waiting-owner")).toBeUndefined();
    expect(f.rows()).toEqual(persisted);
  });

  it("accepts an explicit OOM inspection and transfers only the publisher", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const exit = exitWith(attempt, signalOom);
    f.executor.emit(exit);
    const session = await recovery(f);
    expect(session.target).toEqual({
      identity: attempt.identity,
      launchTicket: attempt.launchTicket,
    });
    const before = f.rows();
    const inspection = await f.executor.adapter.inspect(
      session.target,
      session.active.ownerDescriptor,
    );
    expect(inspection).toEqual({ kind: "tree-exited", exit });
    const resolution = f.storage.store.applyRecoveryInspection(
      session.control,
      inspection,
    );

    expect(resolution?.kind).toBe("transferred");
    assert.ok(resolution?.kind === "transferred");
    expect(resolution).toEqual({
      kind: "transferred",
      publisher: {
        ...attempt.identity,
        ownerInstanceId: "oom-recovery",
        fence: attempt.identity.fence + 1,
      },
      startupEventId: null,
    });
    const persisted = f.rows();
    expect(persisted).toEqual({
      ...before,
      jobs: before.jobs.map((row) => ({
        ...(row as Record<string, unknown>),
        current_fence: resolution.publisher.fence,
      })),
      attempts: before.attempts.map((row) => ({
        ...(row as Record<string, unknown>),
        owner_instance_id: resolution.publisher.ownerInstanceId,
        fence: resolution.publisher.fence,
        lease_expires_at:
          f.storage.clock() + attempt.executionPolicy.limits.leaseDurationMs,
        exit_json: JSON.stringify(exit),
        exit_observed_at: f.storage.clock(),
      })),
      slot: before.slot.map((row) => ({
        ...(row as Record<string, unknown>),
        fence: resolution.publisher.fence,
      })),
      controls: before.controls.map((row) => ({
        ...(row as Record<string, unknown>),
        state: "consumed",
        classification: "tree-exited",
        observed_at: f.storage.clock(),
        consumed_at: f.storage.clock(),
      })),
    });
    expect(
      f.storage.store.getActiveAttempt(resolution.publisher),
    ).toMatchObject({
      identity: resolution.publisher,
      producer: attempt.identity,
      launchTicket: attempt.launchTicket,
      ownerDescriptor: exit.descriptor,
      firstStartedAt: attempt.firstStartedAt,
      executionDeadlineAt: attempt.executionDeadlineAt,
      inputPath: attempt.inputPath,
      workingDirectory: attempt.workingDirectory,
      outputPath: attempt.outputPath,
      tile: attempt.tile,
      exit,
    });
    await f.reopen();
    expect(f.rows()).toEqual(persisted);
    expect(
      f.storage.store.getActiveAttempt(resolution.publisher)?.exit,
    ).toEqual(exit);
  });

  it.each(["failure", "oom"] as const)(
    "deep-freezes a lossless %s exit while retaining its declared classification",
    async (kind) => {
      const f = await fixture();
      const attempt = await f.claim();
      const identity = { ...attempt.identity };
      const details = { controlled: true, nested: { labels: ["original"] } };
      const owner = { ...completionExit(attempt).descriptor, details };
      const completion = { kind, exitCode: -7, signal: null };
      const exit = {
        ...exitWith(attempt, completion),
        identity,
        descriptor: owner,
      };
      const frozen = freezeExecutionExit(exit, attempt, owner);
      expect(frozen).toEqual(exit);
      expect(frozen).not.toBe(exit);
      expect(frozen.identity).not.toBe(identity);
      expect(frozen.descriptor).not.toBe(owner);
      expect(frozen.completion).not.toBe(completion);
      expect(Object.keys(frozen.completion!).sort()).toEqual([
        "exitCode",
        "kind",
        "signal",
      ]);
      const frozenDetails = frozen.descriptor.details as typeof details;
      expect(frozenDetails).not.toBe(details);
      for (const value of [
        frozen,
        frozen.identity,
        frozen.descriptor,
        frozenDetails,
        frozenDetails.nested,
        frozenDetails.nested.labels,
        frozen.completion,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      identity.fence += 1;
      details.nested.labels[0] = "changed";
      completion.exitCode = -9;
      expect(frozen.identity).toEqual(attempt.identity);
      expect(frozenDetails.nested.labels).toEqual(["original"]);
      expect(frozen.completion).toEqual({ kind, exitCode: -7, signal: null });
    },
  );

  it("enriches a classification-free exit only through same-source OOM inspection", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const terminal = completionExit(attempt);
    expect(f.storage.store.registerExit(terminal)).toBe(true);
    expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
      terminal,
    );
    const enriched = exitWith(attempt, oom);
    const beforeCallback = f.rows();
    expect(f.storage.store.registerExit(enriched)).toBe(false);
    expect(f.rows()).toEqual(beforeCallback);
    f.executor.emit(enriched);
    const session = await recovery(f);
    const inspection = await f.executor.adapter.inspect(
      session.target,
      session.active.ownerDescriptor,
    );
    const resolution = f.storage.store.applyRecoveryInspection(
      session.control,
      inspection,
    );
    expect(resolution?.kind).toBe("transferred");
    assert.ok(resolution?.kind === "transferred");
    expect(
      f.storage.store.getActiveAttempt(resolution.publisher),
    ).toMatchObject({
      producer: attempt.identity,
      launchTicket: attempt.launchTicket,
      exit: enriched,
    });
    await f.reopen();
    expect(
      f.storage.store.getActiveAttempt(resolution.publisher)?.exit,
    ).toEqual(enriched);
  });
});

const malformed: readonly (readonly [string, unknown])[] = [
  ["zero code", { ...oom, exitCode: 0 }],
  ["both code and signal", { ...oom, signal: "SIGKILL" }],
  ["neither code nor signal", { ...oom, exitCode: null }],
  ["fractional code", { ...oom, exitCode: 1.5 }],
  ["unsafe code", { ...oom, exitCode: Number.MAX_SAFE_INTEGER + 1 }],
  ["invalid signal", { ...signalOom, signal: "\u0000" }],
  ["unknown kind", { ...oom, kind: "out-of-memory" }],
  ["missing kind", { exitCode: 7, signal: null }],
  ["missing code", { kind: "oom", signal: "SIGKILL" }],
  ["missing signal", { kind: "oom", exitCode: 7 }],
  ["extra field", { ...oom, ignored: undefined }],
  [
    "hidden signal",
    Object.defineProperty({ ...oom }, "signal", { enumerable: false }),
  ],
];

describe.each(["callback", "inspection"] as const)(
  "%s preserves the OOM evidence boundary",
  (consumer) => {
    it("rejects malformed classifications without changing persistent state", async () => {
      const f = await fixture();
      const attempt = await f.claim();
      const session = consumer === "inspection" ? await recovery(f) : null;
      const before = f.rows();
      for (const [name, completion] of malformed) {
        const exit = exitWith(attempt, completion);
        if (session) {
          expect(
            f.storage.store.applyRecoveryInspection(session.control, {
              kind: "tree-exited",
              exit,
            }),
            name,
          ).toBeUndefined();
        } else {
          expect(f.storage.store.registerExit(exit), name).toBe(false);
        }
        expect(f.rows(), name).toEqual(before);
        expect(
          f.storage.store.getActiveAttempt(attempt.identity)?.exit,
          name,
        ).toBeNull();
      }
    });

    it("rejects foreign scope and incomplete tree proof without consuming authority", async () => {
      const f = await fixture();
      const attempt = await f.claim();
      const terminal =
        consumer === "inspection" ? completionExit(attempt) : null;
      if (terminal) expect(f.storage.store.registerExit(terminal)).toBe(true);
      const exit = exitWith(attempt, oom);
      const variants: readonly (readonly [string, unknown])[] = [
        [
          "job",
          {
            ...exit,
            identity: { ...attempt.identity, jobId: "foreign-oom-job" },
          },
        ],
        [
          "attempt",
          {
            ...exit,
            identity: {
              ...attempt.identity,
              attemptNo: attempt.identity.attemptNo + 1,
            },
          },
        ],
        [
          "producer",
          {
            ...exit,
            identity: {
              ...attempt.identity,
              ownerInstanceId: "foreign-oom-producer",
            },
          },
        ],
        [
          "fence",
          {
            ...exit,
            identity: {
              ...attempt.identity,
              fence: attempt.identity.fence + 1,
            },
          },
        ],
        ["ticket", { ...exit, launchTicket: "foreign-oom-ticket" }],
        [
          "descriptor",
          {
            ...exit,
            descriptor: {
              ...exit.descriptor,
              executionId: "foreign-oom-execution",
            },
          },
        ],
        ["tree", { ...exit, treeExited: false }],
      ];
      const session = consumer === "inspection" ? await recovery(f) : null;
      const before = f.rows();
      for (const [name, raw] of variants) {
        const foreign = raw as unknown as ExecutionExit;
        expect(
          () => freezeExecutionExit(foreign, attempt, exit.descriptor),
          name,
        ).toThrowError(
          expect.objectContaining({ code: "configuration_invalid" }),
        );
        if (session) {
          expect(
            f.storage.store.applyRecoveryInspection(session.control, {
              kind: "tree-exited",
              exit: foreign,
            }),
            name,
          ).toBeUndefined();
        } else {
          expect(f.storage.store.registerExit(foreign), name).toBe(false);
        }
        expect(f.rows(), name).toEqual(before);
        expect(
          f.storage.store.getActiveAttempt(attempt.identity)?.exit,
          name,
        ).toEqual(terminal);
      }
    });

    it("rejects OOM before launch authorization without saving a terminal", async () => {
      for (const phase of ["claimed", "prepared"] as const) {
        const f = await fixture();
        const attempt = await f.claim(phase);
        const exit = exitWith(attempt, oom);
        const session = consumer === "inspection" ? await recovery(f) : null;
        const before = f.rows();
        if (session) {
          expect(
            f.storage.store.applyRecoveryInspection(session.control, {
              kind: "tree-exited",
              exit,
            }),
            phase,
          ).toBeUndefined();
        } else {
          expect(f.storage.store.registerExit(exit), phase).toBe(false);
        }
        expect(f.rows(), phase).toEqual(before);
        expect(
          f.storage.store.getActiveAttempt(attempt.identity)?.exit,
          phase,
        ).toBeNull();
      }
    });
  },
);

const classified: readonly (readonly [string, unknown])[] = [
  ["success", { kind: "success", exitCode: 0, signal: null }],
  ["failure", { kind: "failure", exitCode: 7, signal: null }],
  ["signal failure", { kind: "failure", exitCode: null, signal: "SIGKILL" }],
  [
    "interrupted",
    {
      kind: "interrupted",
      authorizationRecordId: "oom-authorization-record",
      controllerLossRecordId: "oom-controller-loss-record",
      terminalRecordId: "oom-terminal-record",
    },
  ],
  ["oom", oom],
];

it.each(classified)(
  "never rewrites an existing %s classification through either same-source consumer",
  async (name, completion) => {
    const f = await fixture();
    const attempt = await f.claim();
    const original = exitWith(attempt, completion);
    expect(f.storage.store.registerExit(original)).toBe(true);
    const replacements = [
      completionExit(attempt),
      ...classified
        .filter(([other]) => other !== name)
        .map(([, evidence]) => exitWith(attempt, evidence)),
      exitWith(attempt, { ...oom, exitCode: 9 }),
    ];
    const beforeCallback = f.rows();
    for (const changed of replacements) {
      expect(f.storage.store.registerExit(changed)).toBe(false);
      expect(f.rows()).toEqual(beforeCallback);
      expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
        original,
      );
    }
    const session = await recovery(f);
    const beforeInspection = f.rows();
    for (const changed of replacements) {
      expect(
        f.storage.store.applyRecoveryInspection(session.control, {
          kind: "tree-exited",
          exit: changed,
        }),
      ).toBeUndefined();
      expect(f.rows()).toEqual(beforeInspection);
      expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
        original,
      );
    }
    f.executor.emit(original);
    const inspection = await f.executor.adapter.inspect(
      session.target,
      session.active.ownerDescriptor,
    );
    const resolution = f.storage.store.applyRecoveryInspection(
      session.control,
      inspection,
    );
    expect(resolution?.kind).toBe("transferred");
    assert.ok(resolution?.kind === "transferred");
    expect(
      f.storage.store.getActiveAttempt(resolution.publisher)?.exit,
    ).toEqual(original);
  },
);
