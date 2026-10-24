import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { configInput } from "./fixtures.js";
import { transportLimits } from "./http-fixtures.js";
import { runnerLimits, submissionLimits } from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

type CliResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  messages: readonly unknown[];
}>;
const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
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
});

const controlledBootstrap = `
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export function validateWindowsWorkerInstallConfiguration(value, appDirectory) {
  const ownApp = dirname(dirname(fileURLToPath(import.meta.url)));
  const appMatched = appDirectory === ownApp;
  const selected = value?.marker === "selected-preflight-json";
  process.send?.({ event: "validated", appMatched, selected });
  if (!appMatched || !selected)
    throw new Error("synthetic-private-controlled-validation");
}
`;
const credentialTripwire = `
export function runOfflineCredentialCommand() {
  process.send?.({ event: "credential-called" });
  throw new Error("synthetic-private-credential-call");
}
`;

async function payload(
  kind: "controlled" | "module-failure" | "actual" = "controlled",
) {
  const cache = join(workerDirectory, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "worker-manage-preflight-"));
  const app = join(root, "app");
  const cwd = join(root, "other-cwd");
  await mkdir(join(app, "dist"), { recursive: true });
  await mkdir(cwd);
  await cp(join(workerDirectory, "manage.mjs"), join(app, "manage.mjs"));
  await writeFile(join(app, "package.json"), '{"type":"module"}\n', {
    flag: "wx",
  });
  if (kind === "actual") {
    // This is the exact build supplied by Root for this round, never a stub.
    await cp(join(workerDirectory, "dist"), join(app, "dist"), {
      recursive: true,
    });
  } else {
    await cp(
      join(workerDirectory, "dist", "contracts.js"),
      join(app, "dist", "contracts.js"),
    );
    await writeFile(
      join(app, "dist", "offline-management.js"),
      credentialTripwire,
      { flag: "wx" },
    );
    await writeFile(
      join(app, "dist", "bootstrap.js"),
      kind === "module-failure"
        ? 'process.send?.({ event: "bootstrap-evaluated" });\nthrow new Error("synthetic-private-module-evaluation");\n'
        : controlledBootstrap,
      { flag: "wx" },
    );
  }
  // Match the existing main payload pattern: keep uniquely owned failed evidence.
  // Dependencies resolve upward to installed worker dependencies, without a link.
  return {
    root,
    app,
    cwd,
    manage: join(app, "manage.mjs"),
    config: join(root, "independent-private-config.json"),
  };
}

type Payload = Awaited<ReturnType<typeof payload>>;

function runCli(p: Payload, args: readonly string[]): Promise<CliResult> {
  const running = spawn(process.execPath, [p.manage, ...args], {
    cwd: p.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  assert.ok(running.stdout && running.stderr);
  let stdout = "";
  let stderr = "";
  const messages: unknown[] = [];
  running.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString("utf8");
  });
  running.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString("utf8");
  });
  running.on("message", (message: unknown) => {
    messages.push(message);
  });
  const closed = new Promise<CliResult>((resolve, reject) => {
    running.once("error", () =>
      reject(new Error("preflight child could not start")),
    );
    running.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr, messages }),
    );
  });
  children.push({ process: running, closed });
  return closed;
}

function eventCount(result: CliResult, event: string) {
  return result.messages.filter(
    (message) =>
      message !== null &&
      typeof message === "object" &&
      Reflect.get(message, "event") === event,
  ).length;
}

function failed(
  result: CliResult,
  code: "invalid_request" | "configuration_invalid" | "internal_error",
) {
  expect(result.code).toBe(1);
  expect(result.signal === null).toBe(true);
  expect(result.stdout === "", "no configuration or pairing output").toBe(true);
  expect(
    result.stderr === `enhancement_management_failed:${code}\n`,
    "one safe failure line",
  ).toBe(true);
  expect(eventCount(result, "credential-called")).toBe(0);
  expect(eventCount(result, "validated")).toBe(0);
}

function succeeded(result: CliResult) {
  expect(result.code).toBe(0);
  expect(result.signal === null).toBe(true);
  expect(result.stderr === "").toBe(true);
  expect(
    result.stdout === '{"configurationValid":true}\n',
    "exact non-sensitive receipt",
  ).toBe(true);
  expect(eventCount(result, "credential-called")).toBe(0);
}

async function shape(p: Payload) {
  return {
    root: (await readdir(p.root)).sort(),
    app: (await readdir(p.app)).sort(),
    dist: (await readdir(join(p.app, "dist"))).sort(),
    cwd: (await readdir(p.cwd)).sort(),
  };
}

function configuration(p: Payload) {
  return {
    storeDirectory: join(p.root, "absent-store"),
    port: 32_001,
    tls: {
      host: "127.0.0.1",
      pfxPath: join(p.root, "absent-tls", "private.pfx"),
    },
    // A complete format fixture only; this test never initializes or pairs a DB.
    operatorClientId: "11111111-1111-4111-8111-111111111111",
    selfTestModelId: "standard-4x",
    workerConfig: configInput(),
    submissionLimits,
    runnerLimits,
    transportLimits,
    execution: {
      installationRoot: join(p.root, "absent-engine"),
      recordsRoot: join(p.root, "absent-records"),
      expectedManifestSha256:
        runnerAdapterOptions.bridge.expectedManifestSha256,
      bridgeLimits: runnerAdapterOptions.bridge.limits,
      journalLimits: runnerAdapterOptions.journalLimits,
    },
  };
}

describe("manage validate-config command boundary", () => {
  it("reads the explicit outside JSON and passes its own appDirectory without credential work", async () => {
    const p = await payload();
    const bytes = Buffer.from(
      '{"marker":"selected-preflight-json","private":"synthetic-private-token-pfx"}\n',
    );
    await writeFile(p.config, bytes, { flag: "wx" });
    await writeFile(
      join(p.cwd, "worker.config.json"),
      '{"marker":"wrong-cwd-private"}\n',
      { flag: "wx" },
    );
    const before = await shape(p);
    const result = await runCli(p, ["validate-config", p.config]);
    succeeded(result);
    expect(eventCount(result, "validated")).toBe(1);
    const invocation = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        Reflect.get(message, "event") === "validated",
    );
    expect(
      invocation !== null &&
        typeof invocation === "object" &&
        Reflect.get(invocation, "appMatched") === true &&
        Reflect.get(invocation, "selected") === true,
      "fixed local module receives the explicit JSON and its own app",
    ).toBe(true);
    expect(
      (await readFile(p.config)).equals(bytes),
      "configuration bytes unchanged",
    ).toBe(true);
    expect(
      isDeepStrictEqual(await shape(p), before),
      "no identity or resource files created",
    ).toBe(true);
  }, 10_000);

  it.each(["missing", "empty", "extra", "relative", "control"] as const)(
    "rejects %s validate-config arguments without entering either command target",
    async (mode) => {
      const p = await payload();
      await writeFile(p.config, '{"marker":"selected-preflight-json"}\n', {
        flag: "wx",
      });
      // The relative file exists, so absence cannot accidentally prove the gate.
      await writeFile(
        join(p.cwd, "relative.json"),
        '{"marker":"selected-preflight-json"}\n',
        { flag: "wx" },
      );
      const args =
        mode === "missing"
          ? ["validate-config"]
          : mode === "empty"
            ? ["validate-config", ""]
            : mode === "extra"
              ? ["validate-config", p.config, "synthetic-private-extra"]
              : mode === "relative"
                ? ["validate-config", "relative.json"]
                : ["validate-config", `${p.config}\u001fprivate`];
      const before = await shape(p);
      failed(await runCli(p, args), "invalid_request");
      expect(isDeepStrictEqual(await shape(p), before)).toBe(true);
    },
    10_000,
  );

  it("rejects malformed UTF-8 inside otherwise parseable JSON before any validator or credential call", async () => {
    const p = await payload();
    const bytes = Buffer.concat([
      Buffer.from('{"marker":"selected-preflight-json","private":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]);
    let permissiveWouldParse = false;
    try {
      const value = JSON.parse(bytes.toString("utf8")) as { marker?: unknown };
      permissiveWouldParse = value.marker === "selected-preflight-json";
    } catch {}
    expect(
      permissiveWouldParse,
      "fixture distinguishes fatal decoding from replacement",
    ).toBe(true);
    await writeFile(p.config, bytes, { flag: "wx" });
    const before = await shape(p);
    failed(
      await runCli(p, ["validate-config", p.config]),
      "configuration_invalid",
    );
    expect((await readFile(p.config)).equals(bytes)).toBe(true);
    expect(isDeepStrictEqual(await shape(p), before)).toBe(true);
  }, 10_000);

  it("sanitizes malformed JSON without exposing its private content or invoking either target", async () => {
    const p = await payload();
    const bytes = Buffer.from(
      '{"marker":"selected-preflight-json","private":"synthetic-private-json",',
    );
    await writeFile(p.config, bytes, { flag: "wx" });
    const before = await shape(p);
    failed(
      await runCli(p, ["validate-config", p.config]),
      "configuration_invalid",
    );
    expect((await readFile(p.config)).equals(bytes)).toBe(true);
    expect(isDeepStrictEqual(await shape(p), before)).toBe(true);
  }, 10_000);

  it("sanitizes a real missing JSON file without creating it or entering credential work", async () => {
    const p = await payload();
    const before = await shape(p);
    failed(await runCli(p, ["validate-config", p.config]), "internal_error");
    expect(existsSync(p.config) === false).toBe(true);
    expect(isDeepStrictEqual(await shape(p), before)).toBe(true);
  }, 10_000);

  it("sanitizes fixed bootstrap module evaluation failure on the real import path", async () => {
    const p = await payload("module-failure");
    await writeFile(p.config, '{"marker":"selected-preflight-json"}\n', {
      flag: "wx",
    });
    const before = await shape(p);
    const result = await runCli(p, ["validate-config", p.config]);
    failed(result, "internal_error");
    expect(eventCount(result, "bootstrap-evaluated")).toBe(1);
    expect(isDeepStrictEqual(await shape(p), before)).toBe(true);
  }, 10_000);
});

describe.skipIf(process.platform !== "win32")(
  "actual dist manage preflight",
  () => {
    it("validates a full formal configuration without Store, material, pairing or listening", async () => {
      const p = await payload("actual");
      const input = configuration(p);
      const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
      await writeFile(p.config, bytes, { flag: "wx" });
      await writeFile(
        join(p.cwd, "worker.config.json"),
        '{"private":"wrong-cwd-config"}\n',
        { flag: "wx" },
      );
      const before = await shape(p);
      // The original built manage/bootstrap are first called by this it target.
      const result = await runCli(p, ["validate-config", p.config]);
      succeeded(result);
      expect(result.messages.length).toBe(0);
      expect((await readFile(p.config)).equals(bytes)).toBe(true);
      expect(isDeepStrictEqual(await shape(p), before)).toBe(true);
      for (const path of [
        input.storeDirectory,
        input.tls.pfxPath,
        input.execution.installationRoot,
        input.execution.recordsRoot,
      ])
        expect(
          existsSync(path) === false,
          "unavailable resources remain untouched",
        ).toBe(true);
    }, 10_000);

    it("rejects a valid programmatic port zero through the actual formal validator without opening resources", async () => {
      const p = await payload("actual");
      const input = { ...configuration(p), port: 0 };
      const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
      await writeFile(p.config, bytes, { flag: "wx" });
      const before = await shape(p);
      const result = await runCli(p, ["validate-config", p.config]);
      failed(result, "configuration_invalid");
      expect(result.messages.length).toBe(0);
      expect((await readFile(p.config)).equals(bytes)).toBe(true);
      expect(isDeepStrictEqual(await shape(p), before)).toBe(true);
      expect(existsSync(input.storeDirectory) === false).toBe(true);
      expect(existsSync(input.tls.pfxPath) === false).toBe(true);
    }, 10_000);
  },
);
