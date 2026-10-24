import fs from "node:fs";
import { dirname, toNamespacedPath } from "node:path";

import { createArtifacts, type ArtifactFiles } from "./artifacts.js";
import { EnhancementError } from "./contracts.js";
import {
  freezeOwnerDescriptor,
  validIdentifier,
  type ClaimedAttempt,
  type Clock,
  type ExecutionAdapter,
  type ExecutionSendGuard,
  type OwnerDescriptor,
  type RecoveryControl,
  type RecoveryResolution,
  type RecoverySession,
} from "./execution.js";
import type { EnhancementStore } from "./store.js";

export type ClaimSelection =
  "none" | "ordinary" | Readonly<{ onlyJobId: string }>;

export type RunnerOptions = Readonly<{
  store: EnhancementStore;
  clock: Clock;
  executor: ExecutionAdapter;
  ownerInstanceId: string;
  artifactFiles?: ArtifactFiles;
  claimSelection?: () => ClaimSelection;
}>;

export type RunnerStatus = Readonly<{
  closed: boolean;
  storeClosed: boolean;
  recoveryState:
    "idle" | "inspecting" | "owned-alive" | "unknown" | "awaiting-artifacts";
  recoveryInFlight: boolean;
  ownedState: "none" | "busy" | "unknown";
}>;

export function createRunner(options: RunnerOptions) {
  const originalStore = options.store;
  if (!validIdentifier(options.ownerInstanceId))
    throw new EnhancementError("configuration_invalid");
  const artifacts = createArtifacts({
    store: options.store,
    files: options.artifactFiles,
  });
  const closeController = new AbortController();
  let closed = false;
  type OwnedAttempt = {
    attempt: ClaimedAttempt;
    launchUnknown: boolean;
    launch?: Promise<void>;
    unsubscribe?: () => void;
    softSent: boolean;
    forceSent: boolean;
    awaitingArtifacts?: boolean;
    artifact?: Promise<void>;
  };
  type RecoveringAttempt = {
    session: RecoverySession;
    unsubscribe?: () => void;
    softSent: boolean;
    forceSent: boolean;
  };
  let owned: OwnedAttempt | undefined;
  let recovering: RecoveringAttempt | undefined;
  let recoveryPending: Promise<void> | undefined;
  let lastRecoveryControl: RecoveryControl | undefined;
  let recoveryRetired = false;
  let recoveryState: RunnerStatus["recoveryState"] = "idle";
  let cancelScheduled: (() => void) | undefined;
  let scheduleGeneration = 0;
  let pendingWorkCount = 0;

  function reserveWork() {
    pendingWorkCount++;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      pendingWorkCount--;
    };
  }
  function trackWork<T>(startWork: () => Promise<T>): Promise<T> {
    const settle = reserveWork();
    try {
      const pending = startWork();
      void pending.then(settle, settle);
      return pending;
    } catch (error) {
      settle();
      throw error;
    }
  }

  function errorOf(error: unknown) {
    return error instanceof EnhancementError
      ? error
      : new EnhancementError("internal_error");
  }
  function observe(pending: Promise<void> | undefined) {
    void pending?.catch(() => {
      /* Unknown asynchronous work preserves its durable slot. */
    });
  }
  function now() {
    const value = options.clock.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new EnhancementError("configuration_invalid");
    return value;
  }
  function beyond(deadline: number) {
    const at = deadline + 1;
    if (!Number.isSafeInteger(at))
      throw new EnhancementError("configuration_invalid");
    return at;
  }
  function cancelTimer() {
    scheduleGeneration++;
    cancelScheduled?.();
    cancelScheduled = undefined;
  }
  function discard(current: OwnedAttempt) {
    if (owned === current) {
      owned = undefined;
      cancelTimer();
      if (current.awaitingArtifacts) recoveryState = "idle";
    }
    current.unsubscribe?.();
    current.unsubscribe = undefined;
  }

  function discardRecovery(current: RecoveringAttempt) {
    if (recovering === current) {
      recovering = undefined;
      cancelTimer();
    }
    current.unsubscribe?.();
    current.unsubscribe = undefined;
  }
  function readOwned(current: OwnedAttempt) {
    if (
      owned !== current ||
      options.store !== originalStore ||
      originalStore.closed
    )
      return;
    const active = originalStore.getActiveAttempt(current.attempt.identity);
    if (
      owned === current &&
      options.store === originalStore &&
      !originalStore.closed &&
      active?.launchTicket === current.attempt.launchTicket
    )
      return active;
  }
  function fresh(current: OwnedAttempt) {
    // Adapter calls can synchronously change time, ownership or durable facts.
    const read = () => {
      if (closed || options.store.closed || owned !== current) return;
      const active = options.store.getActiveAttempt(current.attempt.identity);
      if (!active) {
        discard(current);
        return;
      }
      const at = now();
      if (
        closed ||
        options.store.closed ||
        owned !== current ||
        active.launchTicket !== current.attempt.launchTicket ||
        at > active.leaseExpiresAt
      )
        return;
      return { active, at };
    };
    let facts = read();
    if (!facts) return;
    if (
      facts.active.stopReason === null &&
      facts.at > facts.active.executionDeadlineAt
    ) {
      options.store.requestStop(current.attempt.identity, "execution_timeout");
      facts = read();
      if (!facts) return;
    }
    const limits = facts.active.executionPolicy.limits;
    const heartbeatAt =
      facts.active.leaseExpiresAt -
      limits.leaseDurationMs +
      limits.heartbeatIntervalMs;
    if (facts.at >= heartbeatAt) {
      options.store.renewLease(current.attempt.identity);
      facts = read();
    }
    return facts;
  }
  function schedule(current: OwnedAttempt) {
    const facts = fresh(current);
    if (!facts) return;
    const { active, at } = facts;
    const limits = active.executionPolicy.limits;
    const heartbeatAt =
      active.leaseExpiresAt -
      limits.leaseDurationMs +
      limits.heartbeatIntervalMs;
    const events: number[] = [];
    if (
      heartbeatAt > at &&
      (at <= active.executionDeadlineAt ||
        (active.stopReason !== null && active.authorizedAt !== null))
    )
      events.push(heartbeatAt);
    if (active.stopReason === null) {
      const executionAt = beyond(active.executionDeadlineAt);
      if (executionAt > at) events.push(executionAt);
    }
    if (
      active.stopReason !== null &&
      active.authorizedAt !== null &&
      !current.forceSent
    ) {
      const forceAt = beyond(active.terminateAfterAt!);
      if (forceAt > at) events.push(forceAt);
    }
    if (!events.length) return active;
    const generation = scheduleGeneration;
    cancelScheduled = options.clock.scheduleAt(Math.min(...events), () => {
      if (closed || owned !== current || generation !== scheduleGeneration)
        return;
      cancelScheduled = undefined;
      try {
        observe(advance());
      } catch {
        /* Preserve the durable slot on ambiguous I/O. */
      }
    });
    return active;
  }
  function sendStop(current: OwnedAttempt, mode: "soft" | "force") {
    const guard = mode === "soft" ? "softSent" : "forceSent";
    if (closed || owned !== current || current[guard]) return;
    const facts = fresh(current);
    if (!facts) return;
    const { active, at } = facts;
    if (
      active.stopReason === null ||
      active.stopRequestedAt === null ||
      active.terminateAfterAt === null ||
      active.ownerDescriptor === null ||
      active.ownerDescriptor.launchTicket !== current.attempt.launchTicket ||
      active.authorizedAt === null ||
      active.exit !== null ||
      (mode === "force" && at <= active.terminateAfterAt)
    )
      return;
    // These guards belong to this original identity/ticket for its whole lifecycle.
    // Set them before invoking an adapter that can emit, throw or never return.
    current[guard] = true;
    const descriptor = active.ownerDescriptor;
    const request = Object.freeze({
      mode,
      stopRequestedAt: active.stopRequestedAt,
      terminateAfterAt: active.terminateAfterAt,
    });
    const permission = sendGuard(
      () => owned === current,
      () => originalStore.canRequestStop(current.attempt, descriptor, request),
    );
    let settle: (() => void) | undefined;
    try {
      if (!permission.guard.stillCurrent()) {
        permission.seal();
        return;
      }
      settle = reserveWork();
      const pending = options.executor
        .requestStop(current.attempt, descriptor, request, permission.guard)
        .then(permission.seal, permission.seal);
      void pending.then(settle, settle);
    } catch {
      permission.seal();
      settle?.();
      /* The committed stop remains; recovery is a later batch. */
    }
  }
  function sendGuard(isCurrent: () => boolean, permitted: () => boolean) {
    let consumed = false;
    let active = true;
    const stillCurrent = () => {
      try {
        if (
          !active ||
          closed ||
          options.store !== originalStore ||
          originalStore.closed ||
          !isCurrent()
        )
          return false;
        const allowed = permitted();
        return (
          active &&
          !closed &&
          options.store === originalStore &&
          !originalStore.closed &&
          isCurrent() &&
          allowed
        );
      } catch {
        return false;
      }
    };
    const guard: ExecutionSendGuard = Object.freeze({
      signal: closeController.signal,
      stillCurrent,
      takeSendPermission() {
        if (consumed) return false;
        consumed = true;
        return stillCurrent();
      },
    });
    return {
      guard,
      seal() {
        active = false;
      },
    };
  }
  async function launch(current: OwnedAttempt) {
    const attempt = current.attempt;
    let authorizationAcknowledged = false;
    try {
      if (closed || options.store.closed || owned !== current) return;
      // schedule can change current facts synchronously. Use the store's full
      // current permission and latest lease, not the original claim's times.
      const preparation = sendGuard(
        () => owned === current,
        () =>
          originalStore.canPrepareAttempt(
            attempt.identity,
            attempt.launchTicket,
          ),
      );
      let prepared: OwnerDescriptor;
      try {
        if (!preparation.guard.stillCurrent()) return;
        const firstCreatedParent = fs.mkdirSync(
          dirname(attempt.workingDirectory),
          { recursive: true, mode: 0o700 },
        );
        if (!preparation.guard.stillCurrent()) return;
        // Only this attempt may create its final directory; never reuse prior output.
        fs.mkdirSync(attempt.workingDirectory, { mode: 0o700 });
        const syncThrough = dirname(
          firstCreatedParent ?? attempt.workingDirectory,
        );
        for (
          let directory = attempt.workingDirectory;
          ;
          directory = dirname(directory)
        ) {
          if (!preparation.guard.stillCurrent()) return;
          const descriptor = fs.openSync(
            directory,
            process.platform === "win32" ? "r+" : "r",
          );
          try {
            fs.fsyncSync(descriptor);
          } finally {
            fs.closeSync(descriptor);
          }
          if (toNamespacedPath(directory) === toNamespacedPath(syncThrough)) break;
        }
        if (!preparation.guard.stillCurrent()) return;
        prepared = await options.executor.prepare(attempt, preparation.guard);
      } finally {
        preparation.seal();
      }
      if (closed || options.store.closed || owned !== current) return;
      const descriptor = freezeOwnerDescriptor(prepared, attempt.launchTicket);
      if (closed || options.store.closed || owned !== current) return;
      if (!options.store.registerPrepared(attempt.identity, descriptor)) return;
      if (
        closed ||
        options.store.closed ||
        owned !== current ||
        !options.store.authorizeLaunch(attempt.identity, descriptor)
      )
        return;
      // Subscription is installed synchronously after authorization COMMIT and
      // before the adapter can perform its actual start, including synchronous exit.
      current.unsubscribe = options.executor.observeExit(
        attempt,
        descriptor,
        (exit) => {
          if (closed || options.store.closed || owned !== current) return;
          try {
            if (options.store.registerExit(exit)) observe(advance());
          } catch {
            /* Unknown exit persistence retains the occupied slot. */
          }
        },
      );
      if (closed || options.store.closed || owned !== current) {
        current.unsubscribe?.();
        current.unsubscribe = undefined;
        return;
      }
      const authorization = sendGuard(
        () => owned === current,
        () =>
          originalStore.canAuthorizeLaunch(
            attempt.identity,
            attempt.launchTicket,
            descriptor,
          ),
      );
      try {
        if (!authorization.guard.stillCurrent()) {
          if (!closed && !options.store.closed && owned === current)
            observe(advance());
          return;
        }
        await options.executor.authorize(
          attempt,
          descriptor,
          authorization.guard,
        );
        try {
          authorizationAcknowledged =
            !closed && !!readOwned(current) && !closed;
        } catch {
          /* A failed diagnostic read cannot turn the original ACK into proof. */
        }
      } finally {
        authorization.seal();
      }
    } catch (error) {
      // An ambiguous launch remains running and owns its slot for later inspection.
      throw errorOf(error);
    } finally {
      if (
        !closed &&
        !originalStore.closed &&
        owned === current &&
        !authorizationAcknowledged
      ) {
        let terminal = false;
        try {
          terminal = readOwned(current)?.exit?.treeExited === true;
        } catch {
          /* Diagnostic uncertainty must preserve the original launch result. */
        }
        if (!closed && !originalStore.closed && owned === current && !terminal)
          current.launchUnknown = true;
      }
    }
  }

  function start(attempt: ClaimedAttempt) {
    const current: OwnedAttempt = {
      attempt,
      launchUnknown: false,
      softSent: false,
      forceSent: false,
    };
    owned = current;
    recoveryRetired = false;
    lastRecoveryControl = undefined;
    recoveryState = "idle";
    schedule(current);
    const settle = reserveWork();
    const pending = launch(current);
    current.launch = pending;
    // Keep a single settling chain even when prepare or authorize never returns.
    void pending.then(
      () => {
        current.launch = undefined;
        settle();
      },
      () => {
        current.launch = undefined;
        settle();
      },
    );
    return pending;
  }

  function recoveryFacts(current: RecoveringAttempt) {
    if (closed || recovering !== current) return;
    const session = options.store.beginRecovery(
      options.ownerInstanceId,
      current.session.control,
    );
    if (!session) {
      discardRecovery(current);
      recoveryRetired = true;
      recoveryState = "unknown";
      return;
    }
    current.session = session;
    return { active: session.active, at: now() };
  }

  function scheduleRecovery(current: RecoveringAttempt) {
    const facts = recoveryFacts(current);
    if (!facts) return;
    const { active, at } = facts;
    const events: number[] = [];
    if (current.session.nextQueueDeadlineAt !== null) {
      const queueAt = beyond(current.session.nextQueueDeadlineAt);
      if (queueAt > at) events.push(queueAt);
    }
    if (active.stopReason === null) {
      const executionAt = beyond(active.executionDeadlineAt);
      if (executionAt > at) events.push(executionAt);
    }
    if (
      recoveryState === "owned-alive" &&
      active.stopReason !== null &&
      !current.forceSent
    ) {
      const forceAt = beyond(active.terminateAfterAt!);
      if (forceAt > at) events.push(forceAt);
    }
    if (!events.length) return;
    const generation = scheduleGeneration;
    cancelScheduled = options.clock.scheduleAt(Math.min(...events), () => {
      if (closed || recovering !== current || generation !== scheduleGeneration)
        return;
      cancelScheduled = undefined;
      try {
        observe(advance());
      } catch {
        /* Ambiguous I/O keeps the original slot. */
      }
    });
  }

  function sendRecoveryStop(
    current: RecoveringAttempt,
    mode: "soft" | "force",
  ) {
    const guard = mode === "soft" ? "softSent" : "forceSent";
    if (closed || recovering !== current || current[guard]) return;
    const control = current.session.control;
    const stop = options.store.prepareRecoveryStop(control, mode);
    if (!stop || closed || recovering !== current) return;
    current[guard] = true;
    const request = Object.freeze({
      mode: stop.mode,
      stopRequestedAt: stop.stopRequestedAt,
      terminateAfterAt: stop.terminateAfterAt,
    });
    const permission = sendGuard(
      () => recovering === current && recoveryState === "owned-alive",
      () => originalStore.canRequestRecoveryStop(control, stop),
    );
    let settle: (() => void) | undefined;
    try {
      if (!permission.guard.stillCurrent()) {
        permission.seal();
        return;
      }
      settle = reserveWork();
      const pending = options.executor
        .requestStop(stop.target, stop.descriptor, request, permission.guard)
        .then(permission.seal, permission.seal);
      void pending.then(settle, settle);
    } catch {
      permission.seal();
      settle?.();
      /* The original committed stopping facts remain recoverable. */
    }
  }

  function advanceRecovery(current: RecoveringAttempt) {
    if (closed || recovering !== current) return;
    if (!recoveryFacts(current)) {
      return;
    }
    if (recoveryState === "owned-alive") {
      sendRecoveryStop(current, "soft");
      if (closed || recovering !== current) return currentOwnedPending();
      // The force decision rereads the control, durable stop and current clock
      // after an adapter may synchronously exit, replace authority or close us.
      sendRecoveryStop(current, "force");
      if (closed || recovering !== current) return currentOwnedPending();
    }
    scheduleRecovery(current);
  }

  function resolveRecovery(
    current: RecoveringAttempt,
    resolution: RecoveryResolution,
  ) {
    if (closed || recovering !== current) return;
    if (resolution.kind !== "transferred") {
      current.session = resolution.session;
      recoveryState = resolution.kind;
      return;
    }
    discardRecovery(current);
    const active = options.store.getActiveAttempt(resolution.publisher);
    if (!active || closed) return;
    const retained: OwnedAttempt = {
      attempt: active,
      launchUnknown: false,
      softSent: false,
      forceSent: false,
      awaitingArtifacts: true,
    };
    owned = retained;
    recoveryState = "awaiting-artifacts";
    if (resolution.startupEventId !== null) {
      const result = options.store.restartSealedAttempt(
        resolution.publisher,
        resolution.startupEventId,
      );
      if (closed || owned !== retained) return;
      if (result?.kind === "created") {
        discard(retained);
        return start(result.attempt);
      }
      if (result?.kind === "already-applied") {
        discard(retained);
        recoveryRetired = true;
        recoveryState = "unknown";
        return;
      }
    }
    return advance();
  }

  function currentOwnedPending(): Promise<void> | undefined {
    // An adapter callback may synchronously replace ownership during subscription.
    return owned?.artifact ?? owned?.launch;
  }

  function afterArtifacts(current: OwnedAttempt): Promise<void> | undefined {
    if (closed || options.store.closed || owned !== current) return;
    const active = options.store.getActiveAttempt(current.attempt.identity);
    if (closed || options.store.closed || owned !== current) return;
    if (!active) {
      // Absence retires only this in-memory holder. It is not a success verdict:
      // claimNext still checks the durable slot, including a transferred owner.
      discard(current);
      lastRecoveryControl = undefined;
      return advance();
    }
    if (active.launchTicket !== current.attempt.launchTicket) return;
    // A blocked or stale chain remains cached for this entire OwnedAttempt.
    // Keep the existing heartbeat/cutoff path without awaiting this same promise.
    cancelTimer();
    schedule(current);
  }

  function settleArtifacts(current: OwnedAttempt): Promise<void> {
    if (current.artifact) return current.artifact;
    const pending = trackWork(() =>
      artifacts
        .settle(
          current.attempt.identity,
          current.awaitingArtifacts ? "recovery" : "run",
          closeController.signal,
        )
        .then(
          () => afterArtifacts(current),
          () => afterArtifacts(current),
        ),
    );
    current.artifact = pending;
    observe(pending);
    return pending;
  }

  function recoverArtifacts(current: OwnedAttempt): Promise<void> {
    if (current.artifact) return current.artifact;
    const stillCurrent = () =>
      !closed &&
      !options.store.closed &&
      owned === current &&
      current.artifact === pending;
    const pending: Promise<void> = trackWork(() =>
      artifacts.recover(current.attempt.identity, closeController.signal).then(
        (result) => {
          if (!stillCurrent()) return;
          if (result.kind === "settled") return afterArtifacts(current);
          const outcome = result.outcome;
          if (outcome.kind === "already-applied") {
            discard(current);
            recoveryRetired = true;
            recoveryState = "unknown";
            return;
          }
          const canPrepare = options.store.canPrepareAttempt(
            outcome.attempt.identity,
            outcome.attempt.launchTicket,
          );
          if (!stillCurrent()) return;
          discard(current);
          if (!canPrepare) {
            recoveryRetired = true;
            recoveryState = "unknown";
            return;
          }
          return start(outcome.attempt);
        },
        () => {
          if (!stillCurrent()) return;
          return afterArtifacts(current);
        },
      ),
    );
    current.artifact = pending;
    observe(pending);
    return pending;
  }

  async function restore(): Promise<void> {
    if (owned) return advance();
    const previous = recovering;
    const session = lastRecoveryControl
      ? options.store.beginRecovery(
          options.ownerInstanceId,
          lastRecoveryControl,
        )
      : options.store.beginRecovery(options.ownerInstanceId);
    if (!session) {
      if (previous) discardRecovery(previous);
      if (lastRecoveryControl) {
        recoveryRetired = true;
        recoveryState = "unknown";
        return;
      }
      recoveryState = "idle";
      return advance();
    }
    lastRecoveryControl = session.control;
    recoveryRetired = false;
    let current: RecoveringAttempt;
    if (
      previous &&
      previous.session.control.recoveryId === session.control.recoveryId
    ) {
      current = previous;
      current.session = session;
      current.unsubscribe?.();
      current.unsubscribe = undefined;
    } else {
      if (previous) discardRecovery(previous);
      current = { session, softSent: false, forceSent: false };
    }
    recovering = current;
    recoveryState = "inspecting";
    cancelTimer();
    scheduleRecovery(current);
    try {
      const inspection = await options.executor.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      if (closed || recovering !== current) return;
      const resolution = options.store.applyRecoveryInspection(
        session.control,
        inspection,
      );
      if (!resolution) {
        recoveryState = "unknown";
        cancelTimer();
        scheduleRecovery(current);
        return;
      }
      if (resolution.kind === "transferred")
        return resolveRecovery(current, resolution);
      resolveRecovery(current, resolution);
      if (resolution.kind === "owned-alive") {
        const descriptor = resolution.session.active.ownerDescriptor!;
        current.unsubscribe = options.executor.observeExit(
          session.target,
          descriptor,
          (exit) => {
            if (closed || recovering !== current) return;
            try {
              const terminal = options.store.applyRecoveryInspection(
                session.control,
                { kind: "tree-exited", exit },
              );
              if (terminal) {
                const pending = resolveRecovery(current, terminal);
                void pending?.catch(() => {
                  /* Launch ambiguity keeps its durable slot. */
                });
              }
            } catch {
              /* An uncommitted proof grants no new publisher authority. */
            }
          },
        );
        if (closed || recovering !== current) {
          current.unsubscribe?.();
          current.unsubscribe = undefined;
          return currentOwnedPending();
        }
      }
      return advance();
    } catch (error) {
      if (!closed && recovering === current) {
        recoveryState = "unknown";
        cancelTimer();
        scheduleRecovery(current);
      }
      throw errorOf(error);
    }
  }

  function advance(): Promise<void> | undefined {
    if (closed || recoveryRetired) return;
    cancelTimer();
    if (recovering) return advanceRecovery(recovering);
    if (owned) {
      const current = owned;
      const facts = fresh(current);
      if (!facts) {
        if (owned === current) return;
      } else {
        const { active } = facts;
        if (
          (active.stopReason !== null &&
            options.store.finishCancelled(current.attempt.identity)) ||
          (active.stopReason === null &&
            (active.exit?.completion?.kind === "failure" ||
              active.exit?.completion?.kind === "oom") &&
            options.store.finishFailed(current.attempt.identity))
        ) {
          discard(current);
          lastRecoveryControl = undefined;
        } else {
          sendStop(current, "soft");
          if (closed) return;
          if (owned !== current) return currentOwnedPending();
          sendStop(current, "force");
          if (closed) return;
          if (owned !== current) return currentOwnedPending();
          const latest = schedule(current);
          if (!latest || latest.stopReason !== null) return;
          if (latest.exit?.completion?.kind === "success")
            return settleArtifacts(current);
          if (
            current.awaitingArtifacts &&
            latest.exit?.completion?.kind === "interrupted"
          )
            return recoverArtifacts(current);
          return current.launch;
        }
      }
    }
    if (closed) return;
    const select = options.claimSelection;
    const selection: unknown = select === undefined ? "ordinary" : select();
    if (selection === "none") return;
    let onlyJobId: string | undefined;
    if (selection !== "ordinary") {
      if (
        selection === null ||
        typeof selection !== "object" ||
        Array.isArray(selection)
      )
        return;
      const selectedId = (selection as Readonly<{ onlyJobId?: unknown }>)
        .onlyJobId;
      if (!validIdentifier(selectedId)) return;
      onlyJobId = selectedId;
    }
    if (closed || options.store.closed) return;
    const attempt =
      onlyJobId === undefined
        ? options.store.claimNext(options.ownerInstanceId)
        : options.store.claimNext(options.ownerInstanceId, onlyJobId);
    if (!attempt) return;
    return start(attempt);
  }
  return Object.freeze({
    recover(): Promise<void> {
      if (closed) return Promise.reject(new EnhancementError("not_ready"));
      if (recoveryPending) return recoveryPending;
      // Publish the shared promise before restore can synchronously reenter an
      // adapter. A close before this microtask must not perform delayed writes.
      const settle = reserveWork();
      const pending = Promise.resolve().then(() => {
        if (closed) return;
        return restore();
      });
      recoveryPending = pending;
      void pending.then(
        () => {
          if (recoveryPending === pending) recoveryPending = undefined;
          settle();
        },
        () => {
          if (recoveryPending === pending) recoveryPending = undefined;
          settle();
        },
      );
      return pending;
    },
    pendingWork(): number {
      return pendingWorkCount;
    },
    readiness(): Readonly<{
      ready: false;
      recoveryState:
        | "idle"
        | "inspecting"
        | "owned-alive"
        | "unknown"
        | "awaiting-artifacts";
    }> {
      return Object.freeze({ ready: false, recoveryState });
    },
    status(): RunnerStatus {
      const current = owned;
      let ownedState: RunnerStatus["ownedState"] = current ? "busy" : "none";
      if (current) {
        try {
          if (current.launchUnknown || !readOwned(current))
            ownedState = "unknown";
        } catch {
          ownedState = "unknown";
        }
      }
      return Object.freeze({
        closed,
        storeClosed: originalStore.closed,
        recoveryState,
        recoveryInFlight: recoveryPending !== undefined,
        ownedState,
      });
    },
    wake(): Promise<void> {
      if (closed) return Promise.reject(new EnhancementError("not_ready"));
      try {
        return advance() ?? Promise.resolve();
      } catch (error) {
        return Promise.reject(errorOf(error));
      }
    },
    async close(): Promise<void> {
      closed = true;
      closeController.abort();
      cancelTimer();
      if (owned) {
        owned.unsubscribe?.();
        owned.unsubscribe = undefined;
      }
      if (recovering) {
        recovering.unsubscribe?.();
        recovering.unsubscribe = undefined;
      }
    },
  });
}
