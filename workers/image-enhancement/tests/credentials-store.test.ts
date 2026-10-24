import { randomBytes } from "node:crypto";
import fs, { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticate,
  createClient,
  revokeCredential,
  rotateCredential,
} from "../src/credentials.js";
import { initializeStore, openStore } from "../src/store.js";
import { toErrorResponse } from "../src/contracts.js";
import {
  diskContains,
  sourceImage,
  storageFixture,
  submission,
} from "./storage-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const result = await storageFixture();
  cleanups.push(() => result.cleanup());
  return result;
}

describe("durable service identity and credentials", () => {
  it.each([
    ["first existing ancestor", []],
    ["first newly created ancestor", ["level-one"]],
    ["second newly created ancestor", ["level-one", "level-two"]],
  ])(
    "fails closed and releases the database when parent directory fsync fails for %s",
    async (_name, segments) => {
      const parentDirectory = await mkdtemp(
        join(tmpdir(), "enhancement-parent-directory-sync-"),
      );
      cleanups.push(() =>
        rm(parentDirectory, { recursive: true, force: true }),
      );
      const directory = join(parentDirectory, "level-one", "level-two", "data");
      const faultDirectory = join(parentDirectory, ...segments);
      const sync = fs.fsyncSync;
      let faultInjected = false;
      let failedDescriptor: number | undefined;
      vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        const actual = fs.fstatSync(descriptor);
        if (actual.isDirectory() && existsSync(faultDirectory)) {
          const target = fs.statSync(faultDirectory);
          if (actual.dev === target.dev && actual.ino === target.ino) {
            faultInjected = true;
            failedDescriptor = descriptor;
            throw Object.assign(
              new Error(
                `fixture parent directory sync failure: ${faultDirectory}`,
              ),
              { code: "EIO" },
            );
          }
        }
        sync(descriptor);
      });
      let initialized: ReturnType<typeof initializeStore> | undefined;
      let failure: unknown;
      try {
        try {
          initialized = initializeStore({ directory, clock: () => 1_000 });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: "internal_error", status: 503 });
        expect(Boolean(initialized)).toBe(false);
        expect(faultInjected).toBe(true);
        expect(String(failure)).not.toContain(parentDirectory);
        const response = JSON.stringify(
          toErrorResponse(failure, "fixture-parent-sync-request"),
        );
        expect(response).not.toContain(parentDirectory);
        expect(response).not.toContain("fixture parent directory sync failure");
        expect(response).not.toContain("EIO");
        expect(() => fs.fstatSync(failedDescriptor!)).toThrowError(
          expect.objectContaining({ code: "EBADF" }),
        );
        const probe = new Database(join(directory, "worker.sqlite"), {
          fileMustExist: true,
          timeout: 0,
        });
        try {
          expect(
            probe.prepare("SELECT service_id FROM service_identity").get(),
          ).toHaveProperty("service_id");
          expect(
            probe.prepare("SELECT COUNT(*) AS count FROM credentials").get(),
          ).toEqual({ count: 0 });
        } finally {
          probe.close();
        }
      } finally {
        initialized?.store.close();
      }
    },
  );

  it("persists a newly created data directory chain before returning credentials and reopens its identity", async () => {
    const parentDirectory = await mkdtemp(
      join(tmpdir(), "enhancement-new-directory-"),
    );
    cleanups.push(() => rm(parentDirectory, { recursive: true, force: true }));
    const directory = join(parentDirectory, "level-one", "level-two", "data");
    const expectedDirectories = [
      directory,
      join(parentDirectory, "level-one", "level-two"),
      join(parentDirectory, "level-one"),
      parentDirectory,
    ];
    const syncedDirectories: string[] = [];
    const sync = fs.fsyncSync;
    const syncSpy = vi
      .spyOn(fs, "fsyncSync")
      .mockImplementation((descriptor) => {
        const actual = fs.fstatSync(descriptor);
        if (actual.isDirectory()) {
          const path = expectedDirectories.find((candidate) => {
            if (!existsSync(candidate)) return false;
            const target = fs.statSync(candidate);
            return actual.dev === target.dev && actual.ino === target.ino;
          });
          if (path) syncedDirectories.push(path);
        }
        sync(descriptor);
      });
    const { store, credential } = initializeStore({
      directory,
      clock: () => 1_000,
    });
    try {
      const identity = store.identity;
      expect(authenticate(store, `Bearer ${credential.key}`).clientId).toBe(
        credential.clientId,
      );
      store.close();
      syncSpy.mockRestore();
      const reopened = openStore({ directory, clock: () => 2_000 });
      try {
        expect(reopened.identity).toEqual(identity);
        expect(
          authenticate(reopened, `Bearer ${credential.key}`).clientId,
        ).toBe(credential.clientId);
      } finally {
        reopened.close();
      }
      expect(syncedDirectories).toEqual(expectedDirectories);
      expect(await diskContains(directory, credential.key)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("fails closed and releases the database if persisting the input directory entry fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "enhancement-directory-sync-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("fixture directory sync failure"), {
        code: "EIO",
      });
    });
    const state: { initialized?: ReturnType<typeof initializeStore> } = {};
    try {
      expect(() => {
        state.initialized = initializeStore({ directory, clock: () => 1_000 });
      }).toThrowError(
        expect.objectContaining({ code: "internal_error", status: 503 }),
      );
    } finally {
      state.initialized?.store.close();
    }
    const probe = new Database(join(directory, "worker.sqlite"), {
      timeout: 0,
    });
    expect(
      probe.prepare("SELECT service_id FROM service_identity").get(),
    ).toHaveProperty("service_id");
    probe.close();
  });

  it("sanitizes initialization when the controlled data directory is a regular file", async () => {
    const parentDirectory = await mkdtemp(
      join(tmpdir(), "enhancement-invalid-directory-"),
    );
    cleanups.push(() => rm(parentDirectory, { recursive: true, force: true }));
    const directory = join(parentDirectory, "regular-file");
    await writeFile(directory, "fixture");
    let failure: unknown;
    try {
      initializeStore({ directory, clock: () => 1_000 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "internal_error", status: 503 });
    expect(
      JSON.stringify(toErrorResponse(failure, "fixture-request")),
    ).not.toContain(directory);
  });

  it("ordinary open never initializes a missing service or creates a database", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "enhancement-uninitialized-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    expect(() => openStore({ directory, clock: () => 1_000 })).toThrowError(
      expect.objectContaining({ code: "store_not_initialized" }),
    );
    expect(existsSync(join(directory, "worker.sqlite"))).toBe(false);
  });

  it("reopens stable identity and digest without ever storing the one-time plaintext key", async () => {
    const f = await fixture();
    const { credential } = f.initialized;
    expect(credential.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(credential.key, "base64url")).toHaveLength(32);
    const before = f.store.identity;
    const authenticated = f.principal();
    expect(await diskContains(f.directory, credential.key)).toBe(false);
    f.store.close();
    const db = new Database(join(f.directory, "worker.sqlite"), {
      readonly: true,
    });
    const row = db.prepare("SELECT * FROM credentials").get() as Record<
      string,
      unknown
    >;
    expect(Object.keys(row)).not.toContain("key");
    expect(row.key_digest).toMatch(/^[a-f0-9]{64}$/);
    const digest = row.key_digest;
    db.close();
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.store.identity).toEqual(before);
    expect(f.principal()).toEqual(authenticated);
    f.store.close();
    const reopened = new Database(join(f.directory, "worker.sqlite"), {
      readonly: true,
    });
    expect(
      reopened.prepare("SELECT key_digest FROM credentials").get(),
    ).toEqual({ key_digest: digest });
    reopened.close();
    expect(await diskContains(f.directory, credential.key)).toBe(false);
  });

  it("second initialization fails without resetting identities or returning another key", async () => {
    const f = await fixture();
    const before = f.store.identity;
    f.store.close();
    expect(() =>
      initializeStore({ directory: f.directory, clock: f.clock }),
    ).toThrowError(
      expect.objectContaining({ code: "store_already_initialized" }),
    );
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.store.identity).toEqual(before);
    expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
  });

  it.each([
    undefined,
    null,
    "",
    "Basic abc",
    "bearer abc",
    "Bearer ",
    "Bearer a b",
    "Bearer a\r\nb",
    " Bearer abc",
    "Bearer abc ",
    ["Bearer abc"],
    `Bearer ${randomBytes(32).toString("base64url")}`,
    `Bearer ${"a".repeat(42)}`,
    `Bearer ${"a".repeat(44)}`,
  ])(
    "rejects missing, malformed or incorrect Bearer authentication %#",
    async (authorization) => {
      const f = await fixture();
      expect(() => authenticate(f.store, authorization)).toThrowError(
        expect.objectContaining({ code: "authentication_failed", status: 401 }),
      );
    },
  );

  it("rotates within the stable client, revokes the old key, and preserves owned jobs", async () => {
    const f = await fixture();
    const accepted = await f
      .service()
      .submit(f.principal(), submission(await sourceImage()));
    const next = rotateCredential(f.store, {
      clientId: f.initialized.credential.clientId,
      revokeCredentialId: f.initialized.credential.credentialId,
    });
    expect(next.clientId).toBe(f.initialized.credential.clientId);
    expect(next.credentialId).not.toBe(f.initialized.credential.credentialId);
    expect(next.version).toBe(2);
    expect(next.key).not.toBe(f.initialized.credential.key);
    expect(() => f.principal()).toThrowError(
      expect.objectContaining({ code: "authentication_failed" }),
    );
    const principal = authenticate(f.store, `Bearer ${next.key}`);
    expect(f.service().get(principal, accepted.job.jobId)).toEqual(
      accepted.job,
    );
    expect(await diskContains(f.directory, next.key)).toBe(false);
    revokeCredential(f.store, next.credentialId);
    expect(() => authenticate(f.store, `Bearer ${next.key}`)).toThrowError(
      expect.objectContaining({ code: "authentication_failed" }),
    );
  });

  it("an independent client cannot read or cancel another client's job", async () => {
    const f = await fixture();
    const accepted = await f
      .service()
      .submit(f.principal(), submission(await sourceImage()));
    const second = createClient(f.store);
    const principal = authenticate(f.store, `Bearer ${second.key}`);
    expect(second.clientId).not.toBe(f.initialized.credential.clientId);
    expect(() => f.service().get(principal, accepted.job.jobId)).toThrowError(
      expect.objectContaining({ code: "job_not_found", status: 404 }),
    );
    expect(() =>
      f.service().cancel(principal, accepted.job.jobId),
    ).toThrowError(
      expect.objectContaining({ code: "job_not_found", status: 404 }),
    );
    expect(f.service().get(f.principal(), accepted.job.jobId).status).toBe(
      "queued",
    );
  });

  it("does not accept a caller-constructed or revoked principal as authenticated ownership", async () => {
    const f = await fixture();
    const principal = f.principal();
    const accepted = await f
      .service()
      .submit(principal, submission(await sourceImage()));
    expect(() =>
      f.service().get({ ...principal }, accepted.job.jobId),
    ).toThrowError(expect.objectContaining({ code: "authentication_failed" }));
    revokeCredential(f.store, principal.credentialId);
    expect(() => f.service().get(principal, accepted.job.jobId)).toThrowError(
      expect.objectContaining({ code: "authentication_failed" }),
    );
  });

  it("uses SQLite FULL durability and holds an actual exclusive database lock", async () => {
    const f = await fixture();
    expect(f.store.durability).toEqual({
      synchronous: "full",
      lockingMode: "exclusive",
      journalMode: "delete",
    });
    const second = new Database(join(f.directory, "worker.sqlite"), {
      timeout: 0,
    });
    expect(() =>
      second.prepare("SELECT service_id FROM service_identity").get(),
    ).toThrowError(expect.objectContaining({ code: "SQLITE_BUSY" }));
    second.close();
    expect(() =>
      openStore({ directory: f.directory, clock: f.clock }),
    ).toThrowError(expect.objectContaining({ code: "store_locked" }));
    f.store.close();
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
  });
});
