import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createArtifacts,
  type ArtifactWork,
  type ArtifactWorkKey,
} from "../src/artifacts.js";
import { EnhancementError } from "../src/contracts.js";
import {
  authenticate,
  createClient,
  revokeCredential,
  rotateCredential,
} from "../src/credentials.js";
import {
  artifactFixture,
  writeActualFile,
  type ArtifactFileEvent,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import {
  artifactJobRows,
  installArtifactCommitFault,
  publishedArtifactControl,
} from "./artifact-fault-fixtures.js";
import { sourceImage, submission } from "./storage-fixtures.js";

const fixtures: ArtifactFixture[] = [];
const controllers: AbortController[] = [];
const gates: { release(): void }[] = [];
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const gate of gates.splice(0)) gate.release();
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});

async function fixture() {
  const f = await artifactFixture();
  fixtures.push(f);
  return f;
}

function controller() {
  const value = new AbortController();
  controllers.push(value);
  return value;
}

function track<T>(value: Promise<T>): Promise<T> {
  pending.push(value);
  void value.catch(() => undefined);
  return value;
}

function gate(
  f: ArtifactFixture,
  predicate: (event: ArtifactFileEvent) => boolean,
  phase: "before" | "after" = "after",
) {
  const value = f.gate(predicate, phase);
  gates.push(value);
  return value;
}

function reached(
  value: ReturnType<typeof gate>,
  read: Promise<unknown>,
): Promise<ArtifactFileEvent> {
  return Promise.race([
    value.reached,
    read.then(
      () => {
        throw new Error("published read settled before its real I/O gate");
      },
      (cause: unknown) => {
        throw new Error("published read rejected before its real I/O gate", {
          cause,
        });
      },
    ),
  ]);
}

function audit(f: ArtifactFixture) {
  const store = f.storage.store;
  return {
    acquire: vi.spyOn(store, "acquireArtifactWork"),
    release: vi.spyOn(store, "releaseArtifactReference"),
    readWork: vi.spyOn(store, "readArtifactWork"),
    readReference: vi.spyOn(store, "readArtifactReference"),
    principal: vi.spyOn(store, "assertPrincipal"),
    mutations: [
      vi.spyOn(store, "claimNext"),
      vi.spyOn(store, "registerPrepared"),
      vi.spyOn(store, "authorizeLaunch"),
      vi.spyOn(store, "registerExit"),
      vi.spyOn(store, "reserveArtifactCandidate"),
      vi.spyOn(store, "recordArtifactCandidate"),
      vi.spyOn(store, "finishSucceeded"),
      vi.spyOn(store, "finishFailed"),
      vi.spyOn(store, "restartInterruptedAttempt"),
    ],
  };
}

function acquired(value: ReturnType<typeof audit>, index = 0): ArtifactWork {
  const call = value.acquire.mock.results[index];
  assert.ok(call?.type === "return" && call.value);
  return call.value;
}

function expectReadOnly(
  f: ArtifactFixture,
  firstEvent: number,
  observed: ReturnType<typeof audit>,
) {
  const issued = f.events
    .slice(firstEvent)
    .filter(({ phase }) => phase === "before")
    .map(({ event }) => event);
  expect(
    issued.filter(
      (event) =>
        !["open", "stat", "read", "close"].includes(event.stage) ||
        (event.stage === "open" && event.flags !== "r") ||
        event.role === "raw-output",
    ),
  ).toEqual([]);
  for (const operation of observed.mutations)
    expect(operation).not.toHaveBeenCalled();
}

function expectReference(
  f: ArtifactFixture,
  work: ArtifactWork,
  state: "held" | "released",
) {
  const row = artifactJobRows(f, work.key.publisher.jobId).references.find(
    (reference) => reference.reference_id === work.key.referenceId,
  );
  assert.ok(row);
  expect(row).toMatchObject({
    purpose: "recovery",
    candidate_id: work.candidate?.candidateId,
    publisher_identity_json: JSON.stringify(work.key.publisher),
    released_at: state === "held" ? null : f.storage.clock(),
  });
}

function expectSuccessUnchanged(
  f: ArtifactFixture,
  jobId: string,
  before: ReturnType<typeof artifactJobRows>,
) {
  const rows = artifactJobRows(f, jobId);
  expect(rows.jobs).toEqual(before.jobs);
  expect(rows.attempts).toEqual(before.attempts);
  expect(rows.candidates).toEqual(before.candidates);
  expect(rows.slot).toEqual(before.slot);
}

async function expectOriginalHandlesClosed(
  f: ArtifactFixture,
  firstEvent: number,
) {
  const opened = f.events
    .slice(firstEvent)
    .filter(({ phase, event }) => phase === "after" && event.stage === "open");
  for (const { event } of opened) {
    assert.ok(event.file);
    await expect(event.file.stat()).rejects.toMatchObject({ code: "EBADF" });
  }
}

describe("strict reads of published native artifacts", () => {
  it("returns the original complete PNG and metadata through a fresh held read-only ref", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(f, "download-published");
    const { candidate } = control.work;
    assert.ok(candidate);
    const before = artifactJobRows(f, control.attempt.identity.jobId);
    const dto = f.job(control.attempt.identity.jobId);
    expect(before.references).toHaveLength(1);
    expect(before.references[0]?.released_at).toBe(f.storage.clock());
    f.storage.setReady(false);
    f.hooks.maxReadLength = 23;
    const observed = audit(f);
    const firstEvent = f.events.length;
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    const result = await track(
      artifacts.readPublished(
        f.storage.principal(),
        control.attempt.identity.jobId,
        controller().signal,
      ),
    );
    expect(result).toEqual({ ...candidate.manifest.png, bytes: control.png });
    expect(f.job(control.attempt.identity.jobId)).toEqual(dto);
    expect(observed.acquire).toHaveBeenCalledExactlyOnceWith(
      control.attempt.identity,
      "recovery",
    );
    const work = acquired(observed);
    expect(work).toMatchObject({ purpose: "recovery", access: "published" });
    expect(work.candidate).toEqual({ ...candidate, state: "durable" });
    expect(work.key.referenceId).not.toBe(control.work.key.referenceId);
    expect(observed.release).toHaveBeenCalledExactlyOnceWith(work.key);
    expectReference(f, work, "released");
    const events = f.events.slice(firstEvent);
    const opens = events.filter(
      ({ phase, event }) => phase === "after" && event.stage === "open",
    );
    expect(opens.map(({ event }) => event.path).sort()).toEqual(
      [
        control.attempt.inputPath,
        candidate.pngPath,
        candidate.manifestPath,
      ].sort(),
    );
    for (const { event: opened } of opens) {
      assert.ok(opened.file);
      const sameHandle = events.filter(
        ({ phase, event }) =>
          phase === "after" &&
          event.path === opened.path &&
          event.stage !== "open",
      );
      expect(sameHandle.every(({ event }) => event.file === opened.file)).toBe(
        true,
      );
      const reads = sameHandle.filter(({ event }) => event.stage === "read");
      expect(reads.length).toBeGreaterThan(1);
      expect(reads.at(-1)?.event.bytesRead).toBe(0);
      expect(
        reads.slice(0, -1).every(({ event }) => event.bytesRead! > 0),
      ).toBe(true);
      expect(sameHandle.at(-1)?.event.stage).toBe("close");
    }
    await expectOriginalHandlesClosed(f, firstEvent);
    expectReadOnly(f, firstEvent, observed);
    expectSuccessUnchanged(f, control.attempt.identity.jobId, before);
    expect(f.executor.prepareCalls).toEqual([control.attempt]);
  });

  it("keeps concurrent requests, original handles and abort cleanup independent", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(f, "download-concurrent");
    const observed = audit(f);
    const firstEvent = f.events.length;
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    const firstController = controller();
    const secondController = controller();
    const firstGate = gate(
      f,
      (event) => event.stage === "read" && event.role === "candidate-png",
    );
    const first = track(
      artifacts.readPublished(
        f.storage.principal(),
        control.attempt.identity.jobId,
        firstController.signal,
      ),
    );
    const firstRead = await reached(firstGate, first);
    assert.ok(firstRead.file);
    const secondGate = gate(
      f,
      (event) =>
        event.stage === "read" &&
        event.role === "candidate-png" &&
        event.file !== firstRead.file,
    );
    const second = track(
      artifacts.readPublished(
        f.storage.principal(),
        control.attempt.identity.jobId,
        secondController.signal,
      ),
    );
    const secondRead = await reached(secondGate, second);
    assert.ok(secondRead.file);
    expect(firstRead.file).not.toBe(secondRead.file);
    expect(observed.acquire).toHaveBeenCalledTimes(2);
    const firstWork = acquired(observed, 0);
    const secondWork = acquired(observed, 1);
    expect(firstWork.key.referenceId).not.toBe(secondWork.key.referenceId);
    expectReference(f, firstWork, "held");
    expectReference(f, secondWork, "held");
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    const abortEvent = f.events.length;
    firstController.abort();
    firstGate.release();
    await expect(first).rejects.toBeInstanceOf(EnhancementError);
    expect(secondSettled).toBe(false);
    expect(secondController.signal.aborted).toBe(false);
    expectReference(f, firstWork, "released");
    expectReference(f, secondWork, "held");
    await expect(firstRead.file.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
    expect((await secondRead.file.stat()).isFile()).toBe(true);
    expect(
      f.events
        .slice(abortEvent)
        .filter(
          ({ phase, event }) =>
            phase === "before" &&
            event.file === firstRead.file &&
            event.stage !== "close",
        ),
    ).toEqual([]);
    secondGate.release();
    await expect(second).resolves.toEqual({
      ...control.work.candidate!.manifest.png,
      bytes: control.png,
    });
    expectReference(f, secondWork, "released");
    expect(observed.release.mock.calls.map(([key]) => key)).toEqual([
      firstWork.key,
      secondWork.key,
    ]);
    await expectOriginalHandlesClosed(f, firstEvent);
    expectReadOnly(f, firstEvent, observed);
  });

  it("rejects unauthorized, foreign, missing and real non-success jobs before acquisition or private I/O", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(f, "download-preflight");
    const principal = f.storage.principal();
    const foreignCredential = createClient(f.storage.store);
    const foreign = authenticate(
      f.storage.store,
      `Bearer ${foreignCredential.key}`,
    );
    const running = await f.claim(
      submission(await sourceImage(), "download-running"),
    );
    const queued = await f.storage
      .service()
      .submit(principal, submission(await sourceImage(), "download-queued"));
    const cases = [
      {
        principal: { ...principal },
        jobId: control.attempt.identity.jobId,
        code: "authentication_failed",
        status: 401,
      },
      {
        principal: foreign,
        jobId: control.attempt.identity.jobId,
        code: "job_not_found",
        status: 404,
      },
      {
        principal,
        jobId: "missing-published-job",
        code: "job_not_found",
        status: 404,
      },
      {
        principal,
        jobId: running.identity.jobId,
        code: "result_not_ready",
        status: 409,
      },
      {
        principal,
        jobId: queued.job.jobId,
        code: "result_not_ready",
        status: 409,
      },
    ];
    const before = f.rows();
    const observed = audit(f);
    const firstEvent = f.events.length;
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    const outcomes = await Promise.allSettled(
      cases.map((value) =>
        track(
          artifacts.readPublished(
            value.principal,
            value.jobId,
            controller().signal,
          ),
        ),
      ),
    );
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.status).toBe("rejected");
      assert.ok(outcome.status === "rejected");
      expect(outcome.reason).toMatchObject({
        code: cases[index]!.code,
        status: cases[index]!.status,
      });
    }
    const aborted = controller();
    aborted.abort();
    await expect(
      track(
        artifacts.readPublished(
          principal,
          control.attempt.identity.jobId,
          aborted.signal,
        ),
      ),
    ).rejects.toBeInstanceOf(EnhancementError);
    expect(observed.acquire).not.toHaveBeenCalled();
    expect(f.events.slice(firstEvent)).toEqual([]);
    expect(f.rows()).toEqual(before);
    expectReadOnly(f, firstEvent, observed);
    const principalCalls = observed.principal.mock.calls.length;
    f.storage.store.close();
    await expect(
      track(
        artifacts.readPublished(
          principal,
          control.attempt.identity.jobId,
          controller().signal,
        ),
      ),
    ).rejects.toBeInstanceOf(EnhancementError);
    expect(observed.principal).toHaveBeenCalledTimes(principalCalls);
    expect(observed.acquire).not.toHaveBeenCalled();
    expect(f.events.slice(firstEvent)).toEqual([]);
  });

  it("does not treat an acquisition's already-released published snapshot as an I/O grant", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(
      f,
      "download-consumed-acquire",
    );
    const nativeAcquire = f.storage.store.acquireArtifactWork.bind(
      f.storage.store,
    );
    const nativeRelease = f.storage.store.releaseArtifactReference.bind(
      f.storage.store,
    );
    const observed = audit(f);
    observed.acquire.mockImplementation((publisher, purpose) => {
      const work = nativeAcquire(publisher, purpose);
      assert.ok(
        work && work.access === "published" && work.purpose === "recovery",
      );
      expect(nativeRelease(work.key)).toBe(true);
      expect(f.storage.store.readArtifactReference(work.key)).toBe("released");
      expect(f.storage.store.readArtifactWork(work.key).kind).toBe("published");
      return work;
    });
    const firstEvent = f.events.length;
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    await expect(
      track(
        artifacts.readPublished(
          f.storage.principal(),
          control.attempt.identity.jobId,
          controller().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "internal_error", status: 503 });
    expect(observed.acquire).toHaveBeenCalledTimes(1);
    expect(observed.release).not.toHaveBeenCalled();
    expectReference(f, acquired(observed), "released");
    expect(f.events.slice(firstEvent)).toEqual([]);
    expectReadOnly(f, firstEvent, observed);
  });

  it("rechecks the same held ref after a pending original open instead of consuming published facts", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(f, "download-current-ref");
    const nativeRelease = f.storage.store.releaseArtifactReference.bind(
      f.storage.store,
    );
    const observed = audit(f);
    const firstEvent = f.events.length;
    const openedGate = gate(
      f,
      (event) => event.stage === "open" && event.role === "engine",
    );
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    const read = track(
      artifacts.readPublished(
        f.storage.principal(),
        control.attempt.identity.jobId,
        controller().signal,
      ),
    );
    const opened = await reached(openedGate, read);
    assert.ok(opened.file);
    const work = acquired(observed);
    expect(nativeRelease(work.key)).toBe(true);
    expect(f.storage.store.readArtifactWork(work.key).kind).toBe("published");
    openedGate.release();
    await expect(read).rejects.toMatchObject({
      code: "internal_error",
      status: 503,
    });
    expect(observed.acquire).toHaveBeenCalledTimes(1);
    expect(
      f.events
        .slice(firstEvent)
        .filter(
          ({ event }) => event.stage === "read" || event.stage === "stat",
        ),
    ).toEqual([]);
    await expect(opened.file.stat()).rejects.toMatchObject({ code: "EBADF" });
    expectReference(f, work, "released");
    expectReadOnly(f, firstEvent, observed);
  });

  it.each(["before", "after"] as const)(
    "closes a %s real open cancellation before releasing only its own exact ref",
    async (phase) => {
      const f = await fixture();
      const control = await publishedArtifactControl(
        f,
        `download-abort-${phase}`,
      );
      const nativeRelease = f.storage.store.releaseArtifactReference.bind(
        f.storage.store,
      );
      const observed = audit(f);
      const firstEvent = f.events.length;
      observed.release.mockImplementation((key) => {
        expect(key).toEqual(acquired(observed).key);
        const opens = f.events
          .slice(firstEvent)
          .filter(
            ({ phase: completed, event }) =>
              completed === "after" && event.stage === "open",
          );
        expect(opens).toHaveLength(1);
        expect(f.events.slice(firstEvent)).toContainEqual({
          phase: "after",
          event: expect.objectContaining({
            stage: "close",
            file: opens[0]!.event.file,
          }),
        });
        return nativeRelease(key);
      });
      const pendingOpen = gate(
        f,
        (event) => event.stage === "open" && event.role === "engine",
        phase,
      );
      const cancellation = controller();
      const artifacts = createArtifacts({
        store: f.storage.store,
        files: f.files,
      });
      const read = track(
        artifacts.readPublished(
          f.storage.principal(),
          control.attempt.identity.jobId,
          cancellation.signal,
        ),
      );
      await reached(pendingOpen, read);
      expectReference(f, acquired(observed), "held");
      cancellation.abort();
      expect(observed.release).not.toHaveBeenCalled();
      pendingOpen.release();
      await expect(read).rejects.toBeInstanceOf(EnhancementError);
      expect(
        f.events
          .slice(firstEvent)
          .filter(({ phase: issued }) => issued === "before")
          .map(({ event }) => event.stage),
      ).toEqual(["open", "close"]);
      expect(observed.release).toHaveBeenCalledExactlyOnceWith(
        acquired(observed).key,
      );
      expectReference(f, acquired(observed), "released");
      await expectOriginalHandlesClosed(f, firstEvent);
      expectReadOnly(f, firstEvent, observed);
    },
  );

  it("rejects pending bytes after credential revocation while completing exact cleanup", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(f, "download-revoked");
    const principal = f.storage.principal();
    const siblingCredential = rotateCredential(f.storage.store, {
      clientId: principal.clientId,
    });
    const sibling = authenticate(
      f.storage.store,
      `Bearer ${siblingCredential.key}`,
    );
    const dto = f.storage.store.getOwned(
      sibling,
      control.attempt.identity.jobId,
    );
    const observed = audit(f);
    const firstEvent = f.events.length;
    const pendingRead = gate(
      f,
      (event) => event.stage === "read" && event.role === "candidate-png",
    );
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    const read = track(
      artifacts.readPublished(
        principal,
        control.attempt.identity.jobId,
        controller().signal,
      ),
    );
    const original = await reached(pendingRead, read);
    assert.ok(original.file);
    const revokedAt = f.events.length;
    revokeCredential(f.storage.store, principal.credentialId);
    pendingRead.release();
    await expect(read).rejects.toBeInstanceOf(EnhancementError);
    expect(
      f.events
        .slice(revokedAt)
        .filter(({ phase }) => phase === "before")
        .every(({ event }) => event.stage === "close"),
    ).toBe(true);
    await expect(original.file.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(observed.release).toHaveBeenCalledExactlyOnceWith(
      acquired(observed).key,
    );
    expectReference(f, acquired(observed), "released");
    expect(
      f.storage.store.getOwned(sibling, control.attempt.identity.jobId),
    ).toEqual(dto);
    expectReadOnly(f, firstEvent, observed);
  });

  it("only closes a late original handle after Store closure and preserves the held ref", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(f, "download-store-closed");
    const principal = f.storage.principal();
    const observed = audit(f);
    const firstEvent = f.events.length;
    const pendingOpen = gate(
      f,
      (event) => event.stage === "open" && event.role === "engine",
    );
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    const read = track(
      artifacts.readPublished(
        principal,
        control.attempt.identity.jobId,
        controller().signal,
      ),
    );
    const original = await reached(pendingOpen, read);
    assert.ok(original.file);
    const work = acquired(observed);
    expectReference(f, work, "held");
    const operations = [
      observed.acquire,
      observed.release,
      observed.readWork,
      observed.readReference,
      observed.principal,
    ];
    const callsAtClose = operations.map(
      (operation) => operation.mock.calls.length,
    );
    f.storage.store.close();
    pendingOpen.release();
    await expect(read).rejects.toBeInstanceOf(EnhancementError);
    expect(operations.map((operation) => operation.mock.calls.length)).toEqual(
      callsAtClose,
    );
    expect(
      f.events
        .slice(firstEvent)
        .filter(({ phase }) => phase === "before")
        .map(({ event }) => event.stage),
    ).toEqual(["open", "close"]);
    await expect(original.file.stat()).rejects.toMatchObject({ code: "EBADF" });
    expectReference(f, work, "held");
    expectReadOnly(f, firstEvent, observed);
  });

  it.each([
    "png-mismatch",
    "png-missing",
    "manifest-mismatch",
    "manifest-missing",
  ] as const)(
    "rejects %s without raw fallback, repair, re-publication or changing success",
    async (mode) => {
      const f = await fixture();
      const control = await publishedArtifactControl(f, `download-${mode}`);
      const { candidate } = control.work;
      assert.ok(candidate);
      const before = artifactJobRows(f, control.attempt.identity.jobId);
      const dto = f.job(control.attempt.identity.jobId);
      if (mode === "png-mismatch") {
        const damaged = Buffer.from(control.png);
        damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 0xff;
        await writeActualFile(candidate.pngPath, damaged, false);
      } else if (mode === "manifest-mismatch") {
        const damaged = Buffer.from(JSON.stringify(candidate.manifest), "utf8");
        damaged[0] = 0x5b;
        await writeActualFile(candidate.manifestPath, damaged, false);
      } else {
        await unlink(
          mode === "png-missing" ? candidate.pngPath : candidate.manifestPath,
        );
      }
      const observed = audit(f);
      const firstEvent = f.events.length;
      const artifacts = createArtifacts({
        store: f.storage.store,
        files: f.files,
      });
      await expect(
        track(
          artifacts.readPublished(
            f.storage.principal(),
            control.attempt.identity.jobId,
            controller().signal,
          ),
        ),
      ).rejects.toMatchObject({ code: "internal_error", status: 503 });
      expect(f.job(control.attempt.identity.jobId)).toEqual(dto);
      expectSuccessUnchanged(f, control.attempt.identity.jobId, before);
      expect(observed.acquire).toHaveBeenCalledTimes(1);
      expect(observed.release).toHaveBeenCalledExactlyOnceWith(
        acquired(observed).key,
      );
      expectReference(f, acquired(observed), "released");
      await expectOriginalHandlesClosed(f, firstEvent);
      expectReadOnly(f, firstEvent, observed);
      expect(f.executor.prepareCalls).toEqual([control.attempt]);
    },
  );

  it("does not release or deliver after an issued real close loses its acknowledgement", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(f, "download-close-unknown");
    const dto = f.job(control.attempt.identity.jobId);
    const observed = audit(f);
    const firstEvent = f.events.length;
    let lost: ArtifactFileEvent | undefined;
    f.hooks.after = async (event) => {
      if (!lost && event.stage === "close" && event.role === "candidate-png") {
        lost = event;
        throw new Error("controlled real close acknowledgement loss");
      }
    };
    const artifacts = createArtifacts({
      store: f.storage.store,
      files: f.files,
    });
    await expect(
      track(
        artifacts.readPublished(
          f.storage.principal(),
          control.attempt.identity.jobId,
          controller().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "internal_error", status: 503 });
    assert.ok(lost?.file);
    await expect(lost.file.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(observed.release).not.toHaveBeenCalled();
    expectReference(f, acquired(observed), "held");
    expect(f.job(control.attempt.identity.jobId)).toEqual(dto);
    expectReadOnly(f, firstEvent, observed);
  });

  it.each(["committed", "held", "readback-unknown"] as const)(
    "interprets a first release exception from the exact %s fact without replaying it",
    async (mode) => {
      const f = await fixture();
      const fault =
        mode === "held" ? installArtifactCommitFault(f, "release") : undefined;
      const control = await publishedArtifactControl(
        f,
        `download-release-${mode}`,
      );
      const dto = f.job(control.attempt.identity.jobId);
      const nativeRelease = f.storage.store.releaseArtifactReference.bind(
        f.storage.store,
      );
      const nativeReadReference = f.storage.store.readArtifactReference.bind(
        f.storage.store,
      );
      const observed = audit(f);
      const firstEvent = f.events.length;
      const readbacks: ArtifactWorkKey[] = [];
      let releaseIssued = false;
      observed.release.mockImplementation((key) => {
        expect(releaseIssued).toBe(false);
        expect(key).toEqual(acquired(observed).key);
        const opens = f.events
          .slice(firstEvent)
          .filter(
            ({ phase, event }) => phase === "after" && event.stage === "open",
          );
        expect(opens).toHaveLength(3);
        for (const { event: opened } of opens) {
          expect(f.events.slice(firstEvent)).toContainEqual({
            phase: "after",
            event: expect.objectContaining({
              stage: "close",
              file: opened.file,
            }),
          });
        }
        releaseIssued = true;
        const released = nativeRelease(key);
        expect(released).toBe(true);
        throw new Error(
          "controlled release acknowledgement loss after real COMMIT",
        );
      });
      observed.readReference.mockImplementation((key) => {
        if (releaseIssued) {
          readbacks.push(key);
          if (mode === "readback-unknown")
            throw new Error("controlled exact reference readback failure");
        }
        return nativeReadReference(key);
      });
      fault?.setEnabled(true);
      const artifacts = createArtifacts({
        store: f.storage.store,
        files: f.files,
      });
      const read = track(
        artifacts.readPublished(
          f.storage.principal(),
          control.attempt.identity.jobId,
          controller().signal,
        ),
      );
      if (mode === "committed") {
        await expect(read).resolves.toEqual({
          ...control.work.candidate!.manifest.png,
          bytes: control.png,
        });
      } else {
        await expect(read).rejects.toMatchObject({
          code: "internal_error",
          status: 503,
        });
      }
      const work = acquired(observed);
      expect(observed.release).toHaveBeenCalledExactlyOnceWith(work.key);
      expect(readbacks.length).toBeGreaterThan(0);
      for (const key of readbacks) expect(key).toEqual(work.key);
      expectReference(f, work, mode === "held" ? "held" : "released");
      if (mode === "held") {
        expect(observed.release.mock.results[0]?.type).toBe("throw");
        expect(fault?.rolledBackFaultRows()).toEqual([]);
      }
      expect(f.job(control.attempt.identity.jobId)).toEqual(dto);
      await expectOriginalHandlesClosed(f, firstEvent);
      expectReadOnly(f, firstEvent, observed);
    },
  );
});
