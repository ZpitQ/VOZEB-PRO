import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

import { EnhancementError } from "../src/contracts.js";
import type {
  ClaimedAttempt,
  Clock,
  ExecutionAdapter,
  ExecutionExit,
  ExecutionTarget,
  OwnerDescriptor,
} from "../src/execution.js";
import { openStore } from "../src/store.js";
import { deferred } from "./http-fixtures.js";
import { storageFixture } from "./storage-fixtures.js";

export type StorageFixture = Awaited<ReturnType<typeof storageFixture>>;

export function snapshot<T>(
  storage: StorageFixture,
  read: (db: Database.Database) => T,
) {
  const db = new Database(
    readFileSync(join(storage.directory, "worker.sqlite")),
  );
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function commitFault(
  storage: StorageFixture,
  trigger: string,
  constructStore?: (storage: StorageFixture) => ReturnType<typeof openStore>,
) {
  storage.store.close();
  const db = new Database(join(storage.directory, "worker.sqlite"));
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE lifecycle_commit_fault (
      client_id TEXT REFERENCES clients(client_id) DEFERRABLE INITIALLY DEFERRED
    ); ${trigger}`);
  } finally {
    db.close();
  }
  storage.setStore(
    constructStore
      ? constructStore(storage)
      : openStore({ directory: storage.directory, clock: storage.clock }),
  );
}

export function manualClock(storage: StorageFixture) {
  const entries: { at: number; callback: () => void; cancelled: boolean }[] =
    [];
  const clock: Clock = {
    now: storage.clock,
    scheduleAt(at, callback) {
      if (!Number.isSafeInteger(at) || at <= storage.clock())
        throw new Error("lifecycle scheduler must choose a safe future event");
      const entry = { at, callback, cancelled: false };
      entries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    clock,
    entries,
    pending: () => entries.filter((entry) => !entry.cancelled),
    advanceTo(at: number) {
      if (at < storage.clock())
        throw new Error("test clock cannot move backwards");
      for (;;) {
        const next = entries
          .filter((entry) => !entry.cancelled && entry.at <= at)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        storage.setNow(next.at);
        next.cancelled = true;
        next.callback();
      }
      storage.setNow(at);
    },
  };
}

export function descriptor(attempt: ExecutionTarget): OwnerDescriptor {
  return {
    adapterId: "controlled-lifecycle-fixture",
    launchTicket: attempt.launchTicket,
    executionId: `execution-${attempt.identity.jobId}`,
    details: { controlled: true },
  };
}

export function treeExit(
  attempt: ExecutionTarget,
  owner = descriptor(attempt),
): ExecutionExit {
  return {
    identity: attempt.identity,
    descriptor: owner,
    launchTicket: attempt.launchTicket,
    treeExited: true,
  };
}

export function controlledExecutor() {
  const prepared = deferred<ClaimedAttempt>();
  const authorized = deferred<ClaimedAttempt>();
  const prepareCalls: ClaimedAttempt[] = [];
  const authorizeCalls: ClaimedAttempt[] = [];
  const launchCalls: ClaimedAttempt[] = [];
  const sealedTickets = new Set<string>();
  const activeTickets = new Set<string>();
  const exits = new Map<string, ExecutionExit>();
  const stopCalls: {
    attempt: ExecutionTarget;
    descriptor: OwnerDescriptor;
    mode: "soft" | "force";
  }[] = [];
  const observers: {
    attempt: ExecutionTarget;
    descriptor: OwnerDescriptor;
    listener: (exit: ExecutionExit) => void;
    subscribed: boolean;
  }[] = [];
  const hooks: {
    prepare?: (
      attempt: ClaimedAttempt,
      owner: OwnerDescriptor,
    ) => Promise<OwnerDescriptor>;
    authorize?: (
      attempt: ClaimedAttempt,
      owner: OwnerDescriptor,
    ) => Promise<void>;
    stop?: (call: (typeof stopCalls)[number]) => Promise<void>;
    observe?: (observer: (typeof observers)[number]) => void;
  } = {};
  const adapter: ExecutionAdapter = {
    kind: "test",
    async prepare(attempt, guard) {
      prepareCalls.push(attempt);
      prepared.resolve(attempt);
      const owner = descriptor(attempt);
      const preparedOwner = hooks.prepare
        ? await hooks.prepare(attempt, owner)
        : owner;
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      return preparedOwner;
    },
    async authorize(attempt, owner, guard) {
      authorizeCalls.push(attempt);
      authorized.resolve(attempt);
      await hooks.authorize?.(attempt, owner);
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      // A terminal tree-exit seals even an authorization held before its start side effect.
      if (!sealedTickets.has(attempt.launchTicket)) {
        launchCalls.push(attempt);
        activeTickets.add(attempt.launchTicket);
      }
    },
    async inspect(target, owner) {
      const original = prepareCalls.find(
        (attempt) =>
          isDeepStrictEqual(attempt.identity, target.identity) &&
          attempt.launchTicket === target.launchTicket,
      );
      if (
        !original ||
        (owner !== null && !isDeepStrictEqual(owner, descriptor(original)))
      )
        return { kind: "unknown", ...target };
      const exit = exits.get(target.launchTicket);
      if (exit) return { kind: "tree-exited", exit };
      if (activeTickets.has(target.launchTicket))
        return {
          kind: "owned-alive",
          ...target,
          descriptor: descriptor(original),
        };
      if (
        authorizeCalls.some(
          (attempt) => attempt.launchTicket === target.launchTicket,
        )
      )
        return { kind: "unknown", ...target };
      sealedTickets.add(target.launchTicket);
      return { kind: "never-authorized", ...target };
    },
    async requestStop(attempt, owner, request, guard) {
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      const call = { attempt, descriptor: owner, mode: request.mode };
      stopCalls.push(call);
      if (hooks.stop) await hooks.stop(call);
    },
    observeExit(attempt, owner, listener) {
      const observer = {
        attempt,
        descriptor: owner,
        listener,
        subscribed: true,
      };
      observers.push(observer);
      hooks.observe?.(observer);
      return () => {
        observer.subscribed = false;
      };
    },
  };
  return {
    adapter,
    hooks,
    prepared,
    authorized,
    prepareCalls,
    authorizeCalls,
    launchCalls,
    stopCalls,
    observers,
    activeCount: () => activeTickets.size,
    emit(exit: ExecutionExit) {
      const original = prepareCalls.find(
        (attempt) =>
          isDeepStrictEqual(attempt.identity, exit.identity) &&
          attempt.launchTicket === exit.launchTicket &&
          isDeepStrictEqual(descriptor(attempt), exit.descriptor),
      );
      if (original && exit.treeExited === true) {
        sealedTickets.add(original.launchTicket);
        activeTickets.delete(original.launchTicket);
        exits.set(original.launchTicket, exit);
      }
      for (const observer of observers.filter((item) => item.subscribed))
        observer.listener(exit);
    },
  };
}
