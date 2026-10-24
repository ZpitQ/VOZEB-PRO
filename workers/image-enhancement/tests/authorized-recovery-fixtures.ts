import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  localArtifactFiles,
  type ArtifactFile,
  type ArtifactFiles,
  type ArtifactIoStage,
  type ArtifactWorkKey,
} from "../src/artifacts.js";
import {
  freezeExecutionExit,
  freezeOwnerDescriptor,
  type AuthorizationRecord,
  type ClaimedAttempt,
  type ControllerLossRecord,
  type ExecutionAdapter,
  type ExecutionExit,
  type ExecutionTarget,
  type Inspection,
  type InterruptionEvidenceReader,
  type InterruptionReadScope,
  type OwnerDescriptor,
} from "../src/execution.js";
import { openStore } from "../src/store.js";
import { deferred } from "./http-fixtures.js";
import { manualClock } from "./lifecycle-fixtures.js";
import { sourceImage, storageFixture, submission } from "./storage-fixtures.js";
import {
  canonicalCopy,
  checkedCompletion,
  checkedScope,
  closeIssuedHandles,
  createCanonicalRecordIo,
  notice,
  perform,
  requireCurrent,
  ticketKey,
  type ControlledSnapshot,
  type DurableHandleEvent,
  type DurableIoEvent,
  type DurableIoHooks,
  type OrdinaryCompletion,
  type RecordContext,
  type RecordRole,
} from "./authorized-recovery-records.js";

type ControlledTree = {
  exited: boolean;
  exitRequested: boolean;
  exitedEvent: ReturnType<typeof deferred<void>>;
  exitPermission?: ReturnType<typeof deferred<void>>;
  exitReached?: ReturnType<typeof deferred<ExecutionTarget>>;
};
type Issuance = {
  generation: symbol;
  authorizationRecordId: string;
  live: boolean;
};
type ExecutionHandle = {
  generation: symbol;
  authorizationRecordId: string;
  trees: Set<ControlledTree>;
  issuances: Set<Issuance>;
};
type Convergence = {
  generation: symbol;
  kind: "loss" | "finish";
  handle: ExecutionHandle;
  done: ReturnType<typeof deferred<void>>;
};
type Controller = {
  // These are control handles, never a source of reader/inspection records.
  handles: Map<string, ExecutionHandle>;
  convergence: Map<string, Convergence>;
  queues: Map<string, Promise<void>>;
  cleanupReleases: Set<() => void>;
};

export type DurableRecoveryExecutor = Readonly<{
  adapter: ExecutionAdapter & {
    readInterruptionEvidence: InterruptionEvidenceReader;
  };
  hooks: DurableIoHooks;
  events: readonly DurableIoEvent[];
  handleEvents: readonly DurableHandleEvent[];
  launchCalls: readonly ClaimedAttempt[];
  retired: boolean;
  loseController(target: ExecutionTarget): Promise<void>;
  finish(
    target: ExecutionTarget,
    completion: OrdinaryCompletion,
  ): Promise<void>;
  holdTreeExit(target: ExecutionTarget): Readonly<{
    reached: Promise<ExecutionTarget>;
    release(): void;
    allExited(): boolean;
  }>;
  recordBytes(
    target: ExecutionTarget,
    role: RecordRole,
  ): Promise<Buffer | undefined>;
  rewriteRecordBytes(
    target: ExecutionTarget,
    role: Exclude<RecordRole, "prepared">,
    rewrite: (actualBytes: Buffer) => Buffer | undefined,
  ): Promise<void>;
  retire(): void;
  drain(): Promise<void>;
  openFacade(): Promise<DurableRecoveryExecutor>;
  releasePendingControls(): void;
}>;

function originalTarget(target: ExecutionTarget): ExecutionTarget {
  return canonicalCopy({
    identity: { ...target.identity },
    launchTicket: target.launchTicket,
  });
}

function scopeFor(
  target: ExecutionTarget,
  owner?: OwnerDescriptor | null,
): InterruptionReadScope {
  const original = originalTarget(target);
  const descriptor = freezeOwnerDescriptor(
    {
      adapterId: "durable-controlled-recovery-fixture",
      launchTicket: original.launchTicket,
      executionId: `execution-${original.identity.jobId}-${original.identity.attemptNo}`,
      details: { controlled: true, persistence: "canonical-files-v1" },
    },
    original.launchTicket,
  );
  if (owner && !isDeepStrictEqual(owner, descriptor))
    throw new Error("durable fixture descriptor mismatch");
  return checkedScope({ target: original, descriptor });
}

function exitFrom(snapshot: ControlledSnapshot): ExecutionExit | undefined {
  const terminal = snapshot.terminal;
  if (!terminal) return undefined;
  const completion =
    terminal.kind === "completed"
      ? terminal.completion
      : {
          kind: "interrupted" as const,
          authorizationRecordId: terminal.authorizationRecordId,
          controllerLossRecordId: terminal.controllerLossRecordId,
          terminalRecordId: terminal.recordId,
        };
  return freezeExecutionExit(
    {
      identity: snapshot.scope.target.identity,
      descriptor: snapshot.scope.descriptor,
      launchTicket: snapshot.scope.target.launchTicket,
      treeExited: true,
      completion,
    },
    snapshot.scope.target,
    snapshot.scope.descriptor,
  );
}

function newTree(): ControlledTree {
  return { exited: false, exitRequested: false, exitedEvent: deferred<void>() };
}

function issueTreeExit(tree: ControlledTree, target: ExecutionTarget) {
  if (tree.exitRequested) return;
  tree.exitRequested = true;
  tree.exitReached?.resolve(target);
  const exit = () => {
    tree.exited = true;
    tree.exitedEvent.resolve();
  };
  // This is the controlled tree's completion, independent of a facade callback.
  // A facade retiring cannot turn a still-pending tree into an exited one.
  if (tree.exitPermission) void tree.exitPermission.promise.then(exit);
  else exit();
}

function openDurableFacade(
  directory: string,
  controller: Controller,
): DurableRecoveryExecutor {
  const generation = Symbol("durable-facade");
  const io = createCanonicalRecordIo(directory);
  const hooks: DurableIoHooks = {};
  const events: DurableIoEvent[] = [];
  const handleEvents: DurableHandleEvent[] = [];
  const pending = new Set<Promise<unknown>>();
  const launchCalls: ClaimedAttempt[] = [];
  const observers: {
    scope: InterruptionReadScope;
    listener: (exit: ExecutionExit) => void;
    subscribed: boolean;
  }[] = [];
  let retired = false;

  function run<T>(
    operation: DurableIoEvent["operation"],
    target: ExecutionTarget,
    body: (context: RecordContext) => Promise<T>,
    stillCurrent: () => boolean = () => true,
  ): Promise<T> {
    const context: RecordContext = {
      operation,
      target: originalTarget(target),
      current: () => !retired && stillCurrent(),
      hooks,
      events,
      handleEvents,
      opened: new Map(),
    };
    const promise = (async () => {
      try {
        requireCurrent(context);
        const result = await body(context);
        requireCurrent(context);
        return result;
      } finally {
        await closeIssuedHandles(context);
        context.current();
      }
    })();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }

  async function withTicketTransition<T>(
    context: RecordContext,
    body: () => Promise<T>,
  ): Promise<T> {
    requireCurrent(context);
    const key = ticketKey(context.target);
    const previous = controller.queues.get(key) ?? Promise.resolve();
    const released = deferred<void>();
    const tail = previous.then(() => released.promise);
    controller.queues.set(key, tail);
    try {
      await perform(context, "ticket-directory", "queue", () => previous);
      requireCurrent(context);
      const result = await body();
      requireCurrent(context);
      return result;
    } finally {
      released.resolve();
      if (controller.queues.get(key) === tail) controller.queues.delete(key);
    }
  }

  function revokeIssued(handle: ExecutionHandle) {
    for (const token of handle.issuances) token.live = false;
  }

  function notify(context: RecordContext, snapshot: ControlledSnapshot) {
    requireCurrent(context);
    const exit = exitFrom(snapshot);
    if (!exit) return;
    for (const observer of observers) {
      if (
        observer.subscribed &&
        isDeepStrictEqual(observer.scope, snapshot.scope)
      )
        observer.listener(exit);
    }
  }

  async function awaitTreeExit(
    context: RecordContext,
    handle: ExecutionHandle,
  ) {
    requireCurrent(context);
    for (const tree of handle.trees) issueTreeExit(tree, context.target);
    // This wait is outside the ticket queue, so inspect can read the durable
    // seal/loss while an actual controlled tree's exit remains unresolved.
    await perform(context, "tree", "tree-exit", () =>
      Promise.all([...handle.trees].map((tree) => tree.exitedEvent.promise)),
    );
    requireCurrent(context);
    if ([...handle.trees].some((tree) => !tree.exited))
      throw new Error("durable fixture controlled tree did not exit");
  }

  async function converge(
    context: RecordContext,
    scope: InterruptionReadScope,
    completion?: OrdinaryCompletion,
  ) {
    const key = ticketKey(scope.target);
    const kind = completion === undefined ? "loss" : "finish";
    let issuedClaim: Convergence | undefined;
    let plan: { claim: Convergence; joined: boolean } | undefined;
    try {
      plan = await withTicketTransition(context, async () => {
        const snapshot = await io.readControlledSnapshot(context, scope);
        requireCurrent(context);
        if (!snapshot?.authorization || snapshot.terminal) return undefined;
        const existing = controller.convergence.get(key);
        if (existing)
          return existing.generation === generation
            ? { claim: existing, joined: true }
            : undefined;
        if (snapshot.controllerLoss) return undefined;
        const handle = controller.handles.get(key);
        if (
          !handle ||
          handle.generation !== generation ||
          handle.authorizationRecordId !== snapshot.authorization.recordId
        )
          return undefined;
        const claim: Convergence = {
          generation,
          kind,
          handle,
          done: deferred<void>(),
        };
        issuedClaim = claim;
        controller.convergence.set(key, claim);
        revokeIssued(handle);
        await io.seal(context, scope);
        requireCurrent(context);
        if (kind === "loss") {
          const loss: ControllerLossRecord = {
            v: 1,
            kind: "controller-lost",
            recordId: randomUUID(),
            scope,
            authorizationRecordId: snapshot.authorization.recordId,
          };
          await io.writeCanonicalRecord(
            context,
            scope,
            "controller-loss",
            loss,
          );
          requireCurrent(context);
        }
        return { claim, joined: false };
      });
      requireCurrent(context);
    } catch (error) {
      // Failed/retired durable writes leave unknown files, never a hanging join
      // or permission to synthesize a terminal on a later facade.
      issuedClaim?.done.resolve();
      context.current();
      throw error;
    }
    if (!plan) return;
    const claim = plan.claim;
    if (plan.joined) {
      await claim.done.promise;
      requireCurrent(context);
      return;
    }
    try {
      await awaitTreeExit(context, claim.handle);
      requireCurrent(context);
      await withTicketTransition(context, async () => {
        const snapshot = await io.readControlledSnapshot(context, scope);
        requireCurrent(context);
        if (!snapshot?.authorization || !snapshot.sealed || snapshot.terminal)
          return;
        if (
          controller.convergence.get(key) !== claim ||
          claim.generation !== generation
        )
          return;
        if (kind === "loss") {
          if (!snapshot.controllerLoss) return;
          await io.writeCanonicalRecord(context, scope, "terminal", {
            v: 1,
            kind: "terminal",
            recordId: randomUUID(),
            scope,
            completion: "interrupted",
            authorizationRecordId: snapshot.authorization.recordId,
            controllerLossRecordId: snapshot.controllerLoss.recordId,
            treeExited: true,
            authorizationsSealed: true,
          });
          requireCurrent(context);
        } else {
          if (snapshot.controllerLoss || completion === undefined) return;
          await io.writeCanonicalRecord(context, scope, "terminal", {
            v: 1,
            kind: "completed",
            scope,
            completion,
            treeExited: true,
            authorizationsSealed: true,
          });
          requireCurrent(context);
        }
        const durable = await io.readControlledSnapshot(context, scope);
        requireCurrent(context);
        if (durable) notify(context, durable);
      });
      requireCurrent(context);
    } finally {
      claim.done.resolve();
    }
  }

  const readInterruptionEvidence: InterruptionEvidenceReader = (
    scope,
    stillCurrent,
  ) =>
    run(
      "reader",
      scope.target,
      async (context) => {
        const checked = checkedScope(scope);
        return withTicketTransition(context, () =>
          io.readInterruptionRecords(context, checked),
        );
      },
      stillCurrent,
    ).catch(() => undefined);

  const adapter: ExecutionAdapter & {
    readInterruptionEvidence: InterruptionEvidenceReader;
  } = {
    kind: "test",
    readInterruptionEvidence,
    // Historical durable-record/convergence model: deliberately nonconforming
    // to ExecutionSendGuard. Its nested file awaits and issued-authorization
    // hooks keep their original causal positions. These recovery tests do not
    // prove final-send permission (P1-P15), native AUTH, Resume or pipe dispatch;
    // execution-send-permission.test.ts supplies that separate seam coverage.
    prepare(attempt, _guard) {
      return run("prepare", attempt, async (context) => {
        const scope = scopeFor(attempt);
        await withTicketTransition(context, () => io.prepare(context, scope));
        requireCurrent(context);
        return scope.descriptor;
      });
    },
    authorize(attempt, owner, _guard) {
      return run("authorize", attempt, async (context) => {
        const scope = scopeFor(attempt, owner);
        const key = ticketKey(scope.target);
        const issuance = await withTicketTransition(context, async () => {
          const snapshot = await io.readControlledSnapshot(context, scope);
          requireCurrent(context);
          if (
            !snapshot ||
            snapshot.authorization ||
            snapshot.sealed ||
            snapshot.controllerLoss ||
            snapshot.terminal ||
            controller.handles.has(key)
          )
            return undefined;
          const authorization: AuthorizationRecord = {
            v: 1,
            kind: "authorized",
            recordId: randomUUID(),
            scope,
          };
          const token: Issuance = {
            generation,
            authorizationRecordId: authorization.recordId,
            live: true,
          };
          const handle: ExecutionHandle = {
            generation,
            authorizationRecordId: authorization.recordId,
            trees: new Set(),
            issuances: new Set([token]),
          };
          controller.handles.set(key, handle);
          await io.writeCanonicalRecord(
            context,
            scope,
            "authorization",
            authorization,
          );
          requireCurrent(context);
          return { token, handle };
        });
        requireCurrent(context);
        if (!issuance) return;
        // Durable authorization is complete; this gate holds no ticket channel.
        await notice(context, "authorization", "start", "before");
        requireCurrent(context);
        const started = await withTicketTransition(context, async () => {
          // Always reread the seal even if loss has already revoked the token.
          const snapshot = await io.readControlledSnapshot(context, scope);
          requireCurrent(context);
          if (
            !snapshot?.authorization ||
            snapshot.sealed ||
            snapshot.controllerLoss ||
            snapshot.terminal ||
            !issuance.token.live ||
            issuance.token.generation !== generation ||
            snapshot.authorization.recordId !==
              issuance.token.authorizationRecordId
          )
            return;
          // No await between the final checks and this one controlled start.
          issuance.token.live = false;
          issuance.handle.trees.add(newTree());
          launchCalls.push(attempt);
          return true;
        });
        requireCurrent(context);
        if (started) {
          await notice(context, "authorization", "start", "after");
          requireCurrent(context);
        }
      });
    },
    inspect(target, owner) {
      return run<Inspection>("inspect", target, async (context) => {
        const scope = scopeFor(target, owner);
        return withTicketTransition(context, async () => {
          const snapshot = await io.readControlledSnapshot(context, scope);
          requireCurrent(context);
          if (!snapshot) return { kind: "unknown", ...scope.target };
          const exit = exitFrom(snapshot);
          if (exit) return { kind: "tree-exited", exit };
          const handle = controller.handles.get(ticketKey(scope.target));
          if (
            handle?.generation === generation &&
            [...handle.trees].some((tree) => !tree.exited)
          )
            return {
              kind: "owned-alive",
              ...scope.target,
              descriptor: scope.descriptor,
            };
          if (snapshot.authorization)
            return { kind: "unknown", ...scope.target };
          await io.seal(context, scope);
          requireCurrent(context);
          return { kind: "never-authorized", ...scope.target };
        });
      }).catch((): Inspection => ({
        kind: "unknown",
        ...originalTarget(target),
      }));
    },
    // Historical convergence fixture ignores the final stop guard; not stop proof.
    requestStop(target, owner, _request, _guard) {
      return run("stop", target, async (context) => {
        const scope = scopeFor(target, owner);
        const handle = await withTicketTransition(context, async () => {
          const snapshot = await io.readControlledSnapshot(context, scope);
          requireCurrent(context);
          const controlled = controller.handles.get(ticketKey(scope.target));
          return snapshot?.authorization &&
            controlled?.generation === generation
            ? controlled
            : undefined;
        });
        requireCurrent(context);
        if (handle) {
          await awaitTreeExit(context, handle);
          requireCurrent(context);
        }
      });
    },
    observeExit(target, owner, listener) {
      if (retired) return () => {};
      const observer = {
        scope: scopeFor(target, owner),
        listener,
        subscribed: true,
      };
      observers.push(observer);
      return () => {
        observer.subscribed = false;
      };
    },
  };

  return {
    adapter,
    hooks,
    events: events as readonly DurableIoEvent[],
    handleEvents: handleEvents as readonly DurableHandleEvent[],
    launchCalls: launchCalls as readonly ClaimedAttempt[],
    get retired() {
      return retired;
    },
    loseController(target: ExecutionTarget) {
      return run("loss", target, (context) =>
        converge(context, scopeFor(target)),
      );
    },
    finish(target: ExecutionTarget, completion: OrdinaryCompletion) {
      return run("finish", target, (context) =>
        converge(context, scopeFor(target), checkedCompletion(completion)),
      );
    },
    holdTreeExit(target: ExecutionTarget) {
      assert.equal(retired, false);
      const handle = controller.handles.get(ticketKey(originalTarget(target)));
      assert.ok(handle && handle.generation === generation);
      const trees = [...handle.trees].filter((tree) => !tree.exited);
      assert.ok(trees.length > 0 && trees.every((tree) => !tree.exitRequested));
      const reached = deferred<ExecutionTarget>();
      const permission = deferred<void>();
      const release = () => permission.resolve();
      controller.cleanupReleases.add(release);
      for (const tree of trees) {
        tree.exitPermission = permission;
        tree.exitReached = reached;
      }
      return {
        reached: reached.promise,
        release,
        allExited: () => trees.every((tree) => tree.exited),
      };
    },
    recordBytes(target: ExecutionTarget, role: RecordRole) {
      return run("rewrite", target, async (context) => {
        const scope = scopeFor(target);
        return withTicketTransition(context, async () => {
          const prepared = await io.readCanonicalRecord(
            context,
            scope,
            "prepared",
          );
          requireCurrent(context);
          if (!prepared) return undefined;
          const bytes = await io.readBytes(context, scope, role);
          requireCurrent(context);
          return bytes;
        });
      });
    },
    rewriteRecordBytes(
      target: ExecutionTarget,
      role: Exclude<RecordRole, "prepared">,
      rewrite: (actualBytes: Buffer) => Buffer | undefined,
    ) {
      return run("rewrite", target, async (context) => {
        const scope = scopeFor(target);
        await withTicketTransition(context, async () => {
          const prepared = await io.readCanonicalRecord(
            context,
            scope,
            "prepared",
          );
          requireCurrent(context);
          if (!prepared)
            throw new Error("durable fixture original prepare missing");
          await io.rewriteRecordBytes(context, scope, role, rewrite);
          requireCurrent(context);
        });
        requireCurrent(context);
      });
    },
    retire() {
      retired = true;
      for (const handle of controller.handles.values())
        for (const token of handle.issuances)
          if (token.generation === generation) token.live = false;
      for (const observer of observers) observer.subscribed = false;
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
    async openFacade() {
      return openDurableFacade(directory, controller);
    },
    releasePendingControls() {
      for (const release of controller.cleanupReleases) release();
    },
  };
}

export async function createDurableRecoveryExecutor(
  options: Readonly<{ directory: string }>,
): Promise<DurableRecoveryExecutor> {
  return openDurableFacade(options.directory, {
    handles: new Map(),
    convergence: new Map(),
    queues: new Map(),
    cleanupReleases: new Set(),
  });
}

export type ActualArtifactEvent = Readonly<{
  stage: ArtifactIoStage;
  path: string;
  flags?: "r" | "r+" | "wx";
  position?: number;
  bytesRead?: number;
  bytes?: Buffer;
  size?: number;
}>;

function actualArtifactFiles(events: ActualArtifactEvent[]): ArtifactFiles {
  return {
    async open(path, flags, mode) {
      const file = await localArtifactFiles.open(path, flags, mode);
      events.push({ stage: "open", path, flags });
      const wrapped: ArtifactFile = {
        async stat() {
          const value = await file.stat();
          events.push({ stage: "stat", path, size: value.size });
          return value;
        },
        async read(buffer, offset, length, position) {
          const value = await file.read(buffer, offset, length, position);
          events.push({
            stage: "read",
            path,
            position,
            bytesRead: value.bytesRead,
            bytes: Buffer.from(
              buffer.subarray(offset, offset + value.bytesRead),
            ),
          });
          return value;
        },
        async write(buffer, offset, length, position) {
          const value = await file.write(buffer, offset, length, position);
          events.push({ stage: "write", path, position });
          return value;
        },
        async sync() {
          await file.sync();
          events.push({ stage: "file_sync", path });
        },
        async close() {
          await file.close();
          events.push({ stage: "close", path });
        },
      };
      return wrapped;
    },
    async mkdir(path) {
      await localArtifactFiles.mkdir(path);
      events.push({ stage: "mkdir", path });
    },
    async rename(path, to) {
      await localArtifactFiles.rename(path, to);
      events.push({ stage: "rename", path });
    },
    unlink: localArtifactFiles.unlink,
    async syncDirectory(path, stillCurrent) {
      await localArtifactFiles.syncDirectory(path, stillCurrent);
      events.push({ stage: "directory_sync", path });
    },
  };
}

function eventGate(predicate: (event: DurableIoEvent) => boolean) {
  const reached = deferred<DurableIoEvent>();
  const released = deferred<void>();
  let hit = false;
  return {
    reached: reached.promise,
    release() {
      released.resolve();
    },
    async hook(event: DurableIoEvent) {
      if (!hit && predicate(event)) {
        hit = true;
        reached.resolve(event);
        await released.promise;
      }
    },
  };
}

export async function authorizedRecoveryFixture(
  options: Readonly<{
    readerDecorator?: (
      canonicalReader: InterruptionEvidenceReader,
    ) => InterruptionEvidenceReader;
    observationGateReleases?: readonly (() => void)[];
  }> = {},
) {
  const storage = await storageFixture();
  const time = manualClock(storage);
  let executor = await createDurableRecoveryExecutor({
    directory: join(storage.directory, "durable-adapter"),
  });
  const facades = [executor];
  let controller = new AbortController();
  const controllers = [controller];
  const cleanupReleases: (() => void)[] = [
    ...(options.observationGateReleases ?? []),
  ];
  const pending = new Set<Promise<unknown>>();
  const artifactEvents: ActualArtifactEvent[] = [];
  const restartCalls: { key: ArtifactWorkKey; signal: AbortSignal }[] = [];
  const actualFiles = actualArtifactFiles(artifactEvents);
  const bytes = await sourceImage();

  function bindNewStore() {
    const canonicalReader = executor.adapter.readInterruptionEvidence;
    const fixedReader = options.readerDecorator
      ? options.readerDecorator(canonicalReader)
      : canonicalReader;
    storage.setStore(
      openStore({
        directory: storage.directory,
        clock: storage.clock,
        interruptionEvidenceReader: fixedReader,
      }),
    );
    const store = storage.store;
    const restart = store.restartInterruptedAttempt.bind(store);
    store.restartInterruptedAttempt = (key, signal) => {
      restartCalls.push({ key, signal });
      return restart(key, signal);
    };
  }
  // This empty-store construction precedes every submit/claim. It is not the
  // later crash/reopen under test, and no reader rebind API is introduced.
  storage.store.close();
  bindNewStore();

  return {
    storage,
    time,
    actualFiles,
    artifactEvents: artifactEvents as readonly ActualArtifactEvent[],
    restartCalls: restartCalls as readonly {
      key: ArtifactWorkKey;
      signal: AbortSignal;
    }[],
    get executor() {
      return executor;
    },
    get signal() {
      return controller.signal;
    },
    get allLaunchCalls() {
      return facades.flatMap((facade) => facade.launchCalls);
    },
    submit(key = "authorized-recovery-first") {
      return storage
        .service()
        .submit(storage.principal(), submission(bytes, key));
    },
    gate(predicate: (event: DurableIoEvent) => boolean) {
      const gate = eventGate(predicate);
      cleanupReleases.push(gate.release);
      return gate;
    },
    track<T>(promise: Promise<T>): Promise<T> {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    },
    async reopen() {
      executor.retire();
      storage.store.close();
      executor = await executor.openFacade();
      facades.push(executor);
      controller = new AbortController();
      controllers.push(controller);
      bindNewStore();
    },
    async cleanup() {
      // Release every I/O/tree gate before retirement and drain. No business
      // reference is purged or released by fixture teardown.
      for (const release of cleanupReleases) release();
      for (const facade of facades) facade.releasePendingControls();
      for (const facade of facades) facade.retire();
      for (const issued of controllers) issued.abort();
      await Promise.allSettled([...pending]);
      await Promise.all(facades.map((facade) => facade.drain()));
      await storage.cleanup();
    },
  };
}

export type AuthorizedRecoveryFixture = Awaited<
  ReturnType<typeof authorizedRecoveryFixture>
>;
