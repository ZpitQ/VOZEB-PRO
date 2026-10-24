import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { authenticate } from "../src/credentials.js";
import { runOfflineCredentialCommand } from "../src/offline-management.js";
import { openStore } from "../src/store.js";
import {
  diskContains,
  recursiveFiles,
  sha256,
  sourceImage,
  storageFixture,
  submission,
} from "./storage-fixtures.js";

type Pairing = ReturnType<typeof runOfflineCredentialCommand>;
type CliResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

const manage = fileURLToPath(new URL("../manage.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
const children: {
  process: ReturnType<typeof spawn>;
  closed: Promise<CliResult>;
}[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.process.exitCode === null && child.process.signalCode === null)
      child.process.kill();
    await child.closed.catch(() => undefined);
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const result = await storageFixture();
  cleanups.push(() => result.cleanup());
  return result;
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "enhancement-management-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function databaseState(directory: string) {
  const db = new Database(join(directory, "worker.sqlite"), {
    readonly: true,
    fileMustExist: true,
    timeout: 0,
  });
  try {
    return {
      schema: db.pragma("user_version", { simple: true }),
      identity: db.prepare("SELECT * FROM service_identity").all(),
      clients: db.prepare("SELECT * FROM clients ORDER BY client_id").all(),
      credentials: db
        .prepare("SELECT * FROM credentials ORDER BY version, credential_id")
        .all(),
    };
  } finally {
    db.close();
  }
}

async function inputState(directory: string) {
  return Promise.all(
    (await recursiveFiles(join(directory, "inputs")))
      .sort()
      .map(async (path) => ({
        path: relative(directory, path),
        sha256: sha256(await readFile(path)),
      })),
  );
}

function runCli(
  args: readonly string[],
  cwd: string,
  entry = manage,
): Promise<CliResult> {
  const running = spawn(process.execPath, [entry, ...args], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(running.stdout && running.stderr);
  let stdout = "";
  let stderr = "";
  running.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString("utf8");
  });
  running.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString("utf8");
  });
  const closed = new Promise<CliResult>((resolve, reject) => {
    running.once("error", () => {
      reject(new Error("management child could not start"));
    });
    running.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  children.push({ process: running, closed });
  return closed;
}

function readPairing(result: CliResult): Pairing {
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  // Compare booleans so a broken implementation cannot print a key in a diff.
  expect(result.stderr === "").toBe(true);
  expect(result.stdout.endsWith("\n")).toBe(true);
  const lines = result.stdout.split("\n");
  expect(lines.length).toBe(2);
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!);
  } catch {
    throw new Error("management success did not contain one JSON line");
  }
  expect(value !== null && typeof value === "object").toBe(true);
  const pairing = value as Pairing;
  expect(Object.keys(pairing).sort()).toEqual(["credential", "serviceId"]);
  expect(
    typeof pairing.serviceId === "string" && pairing.serviceId.length > 0,
  ).toBe(true);
  expect(
    pairing.credential !== null && typeof pairing.credential === "object",
  ).toBe(true);
  expect(Object.keys(pairing.credential).sort()).toEqual([
    "clientId",
    "credentialId",
    "key",
    "version",
  ]);
  for (const name of ["clientId", "credentialId"] as const)
    expect(
      typeof pairing.credential[name] === "string" &&
        pairing.credential[name].length > 0,
    ).toBe(true);
  expect(
    Number.isSafeInteger(pairing.credential.version) &&
      pairing.credential.version > 0,
  ).toBe(true);
  expect(
    typeof pairing.credential.key === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(pairing.credential.key),
  ).toBe(true);
  return pairing;
}

function expectCliFailure(result: CliResult, code: string) {
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stdout === "").toBe(true);
  expect(result.stderr === `enhancement_management_failed:${code}\n`).toBe(
    true,
  );
}

const invalidArguments: ReadonlyArray<{
  name: string;
  args: (directory: string, relativeDirectory: string) => readonly string[];
}> = [
  { name: "missing command", args: () => [] },
  { name: "missing initialize directory", args: () => ["initialize"] },
  { name: "missing issue directory", args: () => ["issue"] },
  { name: "missing issue client", args: (directory) => ["issue", directory] },
  {
    name: "extra initialize argument",
    args: (directory) => ["initialize", directory, "extra"],
  },
  {
    name: "extra issue argument",
    args: (directory) => ["issue", directory, "fixture-client", "extra"],
  },
  { name: "unknown command", args: (directory) => ["status", directory] },
  { name: "empty initialize directory", args: () => ["initialize", ""] },
  {
    name: "empty issue client",
    args: (directory) => ["issue", directory, ""],
  },
  {
    name: "relative initialize directory",
    args: (_directory, relativeDirectory) => ["initialize", relativeDirectory],
  },
  {
    name: "relative issue directory",
    args: (_directory, relativeDirectory) => [
      "issue",
      relativeDirectory,
      "fixture-client",
    ],
  },
  { name: "NUL command", args: (directory) => ["initialize\0", directory] },
  { name: "control command", args: (directory) => ["initialize\n", directory] },
  {
    name: "NUL initialize directory",
    args: (directory) => ["initialize", `${directory}\0private`],
  },
  {
    name: "control initialize directory",
    args: (directory) => ["initialize", `${directory}\u001fprivate`],
  },
  {
    name: "NUL issue directory",
    args: (directory) => ["issue", `${directory}\0private`, "fixture-client"],
  },
  {
    name: "control issue directory",
    args: (directory) => ["issue", `${directory}\rprivate`, "fixture-client"],
  },
  {
    name: "NUL client",
    args: (directory) => ["issue", directory, "fixture\0client"],
  },
  {
    name: "control client",
    args: (directory) => ["issue", directory, "fixture\tclient"],
  },
  {
    name: "DEL client",
    args: (directory) => ["issue", directory, "fixture\u007fclient"],
  },
];

describe("offline credential command", () => {
  it("initializes the explicit nested directory, freezes pairing, and closes before immediate reopen", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "level-one", "data");
    expect(existsSync(directory)).toBe(false);
    const pairing = runOfflineCredentialCommand(["initialize", directory]);
    expect(Object.isFrozen(pairing)).toBe(true);
    expect(Object.isFrozen(pairing.credential)).toBe(true);
    expect(pairing.credential.version).toBe(1);
    expect(existsSync(join(directory, "worker.sqlite"))).toBe(true);
    const reopened = openStore({ directory, clock: Date.now });
    try {
      expect(reopened.identity.serviceId).toBe(pairing.serviceId);
      const principal = authenticate(
        reopened,
        `Bearer ${pairing.credential.key}`,
      );
      expect(principal.clientId).toBe(pairing.credential.clientId);
      expect(principal.credentialId).toBe(pairing.credential.credentialId);
      expect(principal.credentialVersion).toBe(pairing.credential.version);
    } finally {
      reopened.close();
    }
    const state = databaseState(directory);
    expect(state.schema).toBe(7);
    expect(state.clients).toHaveLength(1);
    expect(state.credentials).toHaveLength(1);
    expect(await diskContains(root, pairing.credential.key)).toBe(false);
  });

  it("rejects repeated initialization without changing identity, clients, or valid credentials", async () => {
    const f = await fixture();
    const identity = f.store.identity;
    f.store.close();
    const before = databaseState(f.directory);
    expect(() =>
      runOfflineCredentialCommand(["initialize", f.directory]),
    ).toThrowError(
      expect.objectContaining({ code: "store_already_initialized" }),
    );
    expect(databaseState(f.directory)).toEqual(before);
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.store.identity).toEqual(identity);
    expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
  });

  it.each([false, true])(
    "issue never creates a missing Store when the directory exists=%s",
    async (existingDirectory) => {
      const root = await temporaryRoot();
      const directory = join(root, "data");
      if (existingDirectory) await mkdir(directory);
      expect(() =>
        runOfflineCredentialCommand(["issue", directory, randomUUID()]),
      ).toThrowError(
        expect.objectContaining({ code: "store_not_initialized" }),
      );
      expect(existsSync(join(directory, "worker.sqlite"))).toBe(false);
      expect(existsSync(directory)).toBe(existingDirectory);
      expect(await readdir(root)).toEqual(existingDirectory ? ["data"] : []);
    },
  );

  it("rejects an unknown client without issuing credentials and releases its acquired Store", async () => {
    const f = await fixture();
    const identity = f.store.identity;
    f.store.close();
    const before = databaseState(f.directory);
    expect(() =>
      runOfflineCredentialCommand(["issue", f.directory, randomUUID()]),
    ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(databaseState(f.directory)).toEqual(before);
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.store.identity).toEqual(identity);
    expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
  });

  it("refuses an active exclusive Store without issuing a credential or disturbing its owner", async () => {
    const f = await fixture();
    f.store.close();
    const before = databaseState(f.directory);
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(() =>
      runOfflineCredentialCommand([
        "issue",
        f.directory,
        f.initialized.credential.clientId,
      ]),
    ).toThrowError(expect.objectContaining({ code: "store_locked" }));
    expect(f.store.closed).toBe(false);
    expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
    f.store.close();
    expect(databaseState(f.directory)).toEqual(before);
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
  });

  it("issues for the same client, keeps both keys valid for the original queued job, and preserves source and policy", async () => {
    const f = await fixture();
    const old = f.initialized.credential;
    const identity = f.store.identity;
    const accepted = await f
      .service()
      .submit(
        f.principal(),
        submission(await sourceImage(), "offline-existing-job"),
      );
    const stored = f.store.findByKey(f.principal(), "offline-existing-job");
    expect(stored?.job.status).toBe("queued");
    const inputs = await inputState(f.directory);
    expect(inputs.length).toBeGreaterThan(0);
    f.store.close();
    const next = runOfflineCredentialCommand([
      "issue",
      f.directory,
      old.clientId,
    ]);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.credential)).toBe(true);
    expect(next.serviceId).toBe(identity.serviceId);
    expect(next.credential.clientId).toBe(old.clientId);
    expect(next.credential.credentialId).not.toBe(old.credentialId);
    expect(next.credential.version).toBe(old.version + 1);
    expect(next.credential.key === old.key).toBe(false);
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.store.identity).toEqual(identity);
    for (const credential of [old, next.credential]) {
      const principal = authenticate(f.store, `Bearer ${credential.key}`);
      expect(f.service().get(principal, accepted.job.jobId)).toEqual(
        accepted.job,
      );
      expect(f.store.findByKey(principal, "offline-existing-job")).toEqual(
        stored,
      );
    }
    expect(await inputState(f.directory)).toEqual(inputs);
    f.store.close();
    const state = databaseState(f.directory);
    expect(state.schema).toBe(7);
    expect(state.clients).toHaveLength(1);
    expect(state.credentials).toHaveLength(2);
    for (const credential of [old, next.credential])
      expect(await diskContains(f.directory, credential.key)).toBe(false);
  });

  it.each(invalidArguments)(
    "rejects $name before creating or opening a Store",
    async (testCase) => {
      const root = await temporaryRoot();
      const directory = join(root, "data");
      const relativeDirectory = `enhancement-management-relative-${randomUUID()}`;
      const relativeTarget = join(process.cwd(), relativeDirectory);
      expect(existsSync(relativeTarget)).toBe(false);
      cleanups.push(() => rm(relativeTarget, { recursive: true, force: true }));
      expect(() =>
        runOfflineCredentialCommand(
          testCase.args(directory, relativeDirectory),
        ),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
      expect(await readdir(root)).toEqual([]);
      expect(existsSync(relativeTarget)).toBe(false);
    },
  );
});

describe("actual dist offline management CLI", () => {
  it("uses the fixed sibling dist from another cwd, emits one pairing JSON line, and can authenticate after exit", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "data");
    const pairing = readPairing(await runCli(["initialize", directory], root));
    const reopened = openStore({ directory, clock: Date.now });
    try {
      expect(reopened.identity.serviceId).toBe(pairing.serviceId);
      const principal = authenticate(
        reopened,
        `Bearer ${pairing.credential.key}`,
      );
      expect(principal.clientId).toBe(pairing.credential.clientId);
      expect(principal.credentialId).toBe(pairing.credential.credentialId);
      expect(principal.credentialVersion).toBe(1);
    } finally {
      reopened.close();
    }
    expect(existsSync(join(root, "worker.sqlite"))).toBe(false);
    expect(await diskContains(root, pairing.credential.key)).toBe(false);
  }, 10_000);

  it("issues once for the explicit existing client and retains authentication with both keys after exit", async () => {
    const f = await fixture();
    const root = await temporaryRoot();
    const old = f.initialized.credential;
    const identity = f.store.identity;
    f.store.close();
    const next = readPairing(
      await runCli(["issue", f.directory, old.clientId], root),
    );
    expect(next.serviceId).toBe(identity.serviceId);
    expect(next.credential.clientId).toBe(old.clientId);
    expect(next.credential.credentialId).not.toBe(old.credentialId);
    expect(next.credential.version).toBe(old.version + 1);
    expect(next.credential.key === old.key).toBe(false);
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.store.identity).toEqual(identity);
    for (const credential of [old, next.credential])
      expect(authenticate(f.store, `Bearer ${credential.key}`).clientId).toBe(
        old.clientId,
      );
    f.store.close();
    const state = databaseState(f.directory);
    expect(state.clients).toHaveLength(1);
    expect(state.credentials).toHaveLength(2);
    for (const credential of [old, next.credential])
      expect(await diskContains(f.directory, credential.key)).toBe(false);
  }, 10_000);

  it.each([
    { mode: "duplicate", code: "store_already_initialized" },
    { mode: "missing", code: "store_not_initialized" },
    { mode: "unknown-client", code: "invalid_request" },
    { mode: "locked", code: "store_locked" },
  ])(
    "sanitizes $mode failure, leaves stdout empty, and preserves the original Store",
    async ({ mode, code }) => {
      const f = await fixture();
      const root = await temporaryRoot();
      const identity = f.store.identity;
      f.store.close();
      const before = databaseState(f.directory);
      if (mode === "locked")
        f.setStore(openStore({ directory: f.directory, clock: f.clock }));
      const directory = mode === "missing" ? join(root, "data") : f.directory;
      const args =
        mode === "duplicate"
          ? ["initialize", directory]
          : [
              "issue",
              directory,
              mode === "unknown-client"
                ? randomUUID()
                : f.initialized.credential.clientId,
            ];
      expectCliFailure(await runCli(args, root), code);
      if (mode === "locked") {
        expect(f.store.closed).toBe(false);
        expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
        f.store.close();
      }
      if (mode === "missing") expect(existsSync(directory)).toBe(false);
      expect(databaseState(f.directory)).toEqual(before);
      f.setStore(openStore({ directory: f.directory, clock: f.clock }));
      expect(f.store.identity).toEqual(identity);
      expect(f.principal().clientId).toBe(f.initialized.credential.clientId);
    },
    10_000,
  );

  it("maps a real filesystem initialization failure to internal_error without exposing a path or stack", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "regular-file");
    await writeFile(directory, "fixture-private-filesystem-value", {
      flag: "wx",
    });
    expectCliFailure(
      await runCli(["initialize", directory], root),
      "internal_error",
    );
    expect(await readFile(directory, "utf8")).toBe(
      "fixture-private-filesystem-value",
    );
    expect(await readdir(root)).toEqual(["regular-file"]);
  }, 10_000);

  it("sanitizes fixed dist module loading failure before creating a Store", async () => {
    const root = await temporaryRoot();
    const entry = join(root, "manage.mjs");
    await cp(manage, entry, { errorOnExist: true, force: false });
    expectCliFailure(
      await runCli(["initialize", join(root, "data")], root, entry),
      "internal_error",
    );
    expect(await readdir(root)).toEqual(["manage.mjs"]);
  }, 10_000);

  // The operating system rejects NUL argv; the API cases above cover that input.
  it.each(
    invalidArguments.filter(
      (testCase) =>
        !testCase
          .args("fixture-directory", "relative-directory")
          .some((value) => value.includes("\0")),
    ),
  )(
    "rejects CLI $name before creating a Store with only the safe error code",
    async (testCase) => {
      const root = await temporaryRoot();
      const directory = join(root, "data");
      expectCliFailure(
        await runCli(testCase.args(directory, "relative-data"), root),
        "invalid_request",
      );
      expect(await readdir(root)).toEqual([]);
    },
    10_000,
  );
});
