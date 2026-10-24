import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
const modulePath = join(
  workerDirectory,
  "deployment",
  "windows",
  "Worker.Installation.psm1",
);
const requiredPaths = [
  "WindowsServiceHost.exe",
  "WindowsServiceHost.deps.json",
  "WindowsServiceHost.runtimeconfig.json",
  "runtime/node.exe",
  "runtime/LICENSE",
  "app/main.mjs",
  "app/manage.mjs",
  "app/package.json",
  "app/dist/bootstrap.js",
  "app/dist/contracts.js",
  "native/bridge/WindowsControlBridge.exe",
  "native/supervisor/WindowsSupervisor.exe",
] as const;

type InventoryEntry = { path: string; bytes: number; sha256: string };
type Payload = {
  owner: string;
  root: string;
  inventory: {
    schemaVersion: number;
    version: string;
    storeSchemaVersion: number;
    files: InventoryEntry[];
  };
};
type ShellResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
const children: {
  process: ReturnType<typeof spawn>;
  closed: Promise<ShellResult>;
}[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.process.exitCode === null && child.process.signalCode === null)
      child.process.kill();
    await child.closed.catch(() => undefined);
  }
});

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireModule() {
  expect(
    existsSync(modulePath),
    "Test-WorkerPayload behavior module has not been implemented",
  ).toBe(true);
}

async function addFile(p: Payload, path: string, bytes: Buffer) {
  const target = join(p.root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
  p.inventory.files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}

async function writeInventory(p: Payload) {
  await writeFile(
    join(p.root, "package.inventory.json"),
    `${JSON.stringify(p.inventory)}\n`,
    "utf8",
  );
}

async function payload(): Promise<Payload> {
  const cache = join(workerDirectory, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const owner = await mkdtemp(join(cache, "worker-payload-"));
  const p: Payload = {
    owner,
    root: join(owner, "ordinary-parent", "离线 安装包"),
    inventory: {
      schemaVersion: 1,
      version: "m3-e2-fixture",
      storeSchemaVersion: 7,
      files: [],
    },
  };
  for (const path of [
    ...requiredPaths,
    "licenses/第三方 许可.txt",
    "app/worker.config.example.json",
    "app/node_modules/payload-fixture/package.json",
    "app/node_modules/payload-fixture/index.js",
    "app/node_modules/payload-fixture/LICENSE",
  ])
    await addFile(p, path, Buffer.from(`inert synthetic fixture: ${path}\n`));
  await writeInventory(p);
  // Preserve each uniquely owned fixture as evidence, including failed rounds.
  return p;
}

async function snapshot(root: string) {
  const entries: { path: string; kind: string; content?: string }[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relative, kind: "link", content: await readlink(path) });
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name), `${relative}/${name}`);
    } else if (stat.isFile()) {
      entries.push({
        path: relative,
        kind: "file",
        content: sha256(await readFile(path)),
      });
    } else {
      entries.push({ path: relative, kind: "other" });
    }
  }
  await visit(root, "");
  return entries;
}

function runPowerShell(
  script: string,
  variables: Readonly<Record<string, string>>,
): Promise<ShellResult> {
  const running = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "RemoteSigned",
      "-Command",
      script,
    ],
    {
      cwd: workerDirectory,
      env: { ...process.env, ...variables },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  assert.ok(running.stdout && running.stderr);
  let stdout = "";
  let stderr = "";
  running.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString("utf8");
  });
  running.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString("utf8");
  });
  const closed = new Promise<ShellResult>((resolve, reject) => {
    running.once("error", () =>
      reject(new Error("Windows PowerShell fixture could not start")),
    );
    running.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  children.push({ process: running, closed });
  return closed;
}

const verificationCommand = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Import-Module -Name $env:VOZEB_PAYLOAD_TEST_MODULE -Force -ErrorAction Stop
  $items = @(Test-WorkerPayload -PayloadRoot $env:VOZEB_PAYLOAD_TEST_ROOT -ExpectedInventorySha256 $env:VOZEB_PAYLOAD_TEST_SHA256)
  $response = [ordered]@{ ok = $true; count = $items.Count; value = $items[0] }
} catch {
  $response = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 8))
exit 0
`;

async function verify(
  p: Payload,
  expectedInventorySha256?: string,
  selectedRoot = p.root,
) {
  // This assertion runs inside each it; a missing implementation is a behavior RED.
  requireModule();
  const expected =
    expectedInventorySha256 ??
    sha256(await readFile(join(p.root, "package.inventory.json")));
  const before = await snapshot(p.owner);
  let result: ShellResult;
  try {
    result = await runPowerShell(verificationCommand, {
      VOZEB_PAYLOAD_TEST_MODULE: modulePath,
      VOZEB_PAYLOAD_TEST_ROOT: selectedRoot,
      VOZEB_PAYLOAD_TEST_SHA256: expected,
      VOZEB_PAYLOAD_EXECUTION_MARKER: join(p.owner, "payload-executed.marker"),
    });
  } finally {
    expect(
      isDeepStrictEqual(await snapshot(p.owner), before),
      "all fixture bytes, inventory and tree entries remain unchanged",
    ).toBe(true);
  }
  expect(result.code).toBe(0);
  expect(result.signal === null).toBe(true);
  expect(result.stderr === "", "no raw PowerShell errors or private paths").toBe(
    true,
  );
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("payload verifier did not return one JSON response");
  }
}

async function rejects(
  p: Payload,
  expectedInventorySha256?: string,
  selectedRoot = p.root,
) {
  expect(
    isDeepStrictEqual(await verify(p, expectedInventorySha256, selectedRoot), {
      ok: false,
      error: "worker_package_invalid",
    }),
    "only the fixed worker_package_invalid classification is exposed",
  ).toBe(true);
}

describe.skipIf(process.platform !== "win32")(
  "Windows offline payload integrity boundary",
  () => {
    it("accepts the complete Unicode and space layout with production dependencies without changing any bytes", async () => {
      const p = await payload();
      // Both SHA256 encodings are hexadecimal, including upper case.
      p.inventory.files[0]!.sha256 = p.inventory.files[0]!.sha256.toUpperCase();
      await writeInventory(p);
      const expected = sha256(
        await readFile(join(p.root, "package.inventory.json")),
      ).toUpperCase();
      expect(
        isDeepStrictEqual(await verify(p, expected), {
          ok: true,
          count: 1,
          value: { version: "m3-e2-fixture", storeSchemaVersion: 7, startupObservationV1: false },
        }),
        "one read-only version/schema receipt from the complete layout",
      ).toBe(true);
    }, 20_000);

    it("rejects an externally pinned inventory digest mismatch without trusting the package", async () => {
      const p = await payload();
      await rejects(p, "0".repeat(64));
    }, 20_000);

    it.each(["digest", "size"] as const)(
      "rejects a listed file %s mismatch",
      async (mode) => {
        const p = await payload();
        const entry = p.inventory.files.find(
          (file) => file.path === "app/main.mjs",
        );
        assert.ok(entry);
        if (mode === "digest") {
          const path = join(p.root, "app", "main.mjs");
          const bytes = await readFile(path);
          bytes[0] = bytes[0]! ^ 0xff;
          await writeFile(path, bytes);
        } else {
          entry.bytes += 1;
          await writeInventory(p);
        }
        await rejects(p);
      },
      20_000,
    );

    it.each(["extra", "missing"] as const)(
      "rejects an %s actual payload file",
      async (mode) => {
        const p = await payload();
        if (mode === "extra")
          await writeFile(
            join(p.root, "unlisted-private-file.txt"),
            "synthetic-private-extra\n",
            { flag: "wx" },
          );
        else
          await unlink(
            join(p.root, "app", "node_modules", "payload-fixture", "LICENSE"),
          );
        await rejects(p);
      },
      20_000,
    );

    it("rejects a coherent inventory and tree missing the required supervisor layout", async () => {
      const p = await payload();
      const path = "native/supervisor/WindowsSupervisor.exe";
      await unlink(join(p.root, ...path.split("/")));
      p.inventory.files = p.inventory.files.filter((file) => file.path !== path);
      await writeInventory(p);
      await rejects(p);
    }, 20_000);

    it.each(["duplicate", "case-collision"] as const)(
      "rejects a %s inventory entry",
      async (mode) => {
        const p = await payload();
        const original = p.inventory.files[0]!;
        p.inventory.files.push({
          ...original,
          path: mode === "duplicate" ? original.path : original.path.toUpperCase(),
        });
        await writeInventory(p);
        await rejects(p);
      },
      20_000,
    );

    it.each([
      "../outside.txt",
      "app/main.mjs:private",
      "app/main.mjs.",
      "app/CoM1.js",
    ])(
      "rejects unsafe inventory path %j",
      async (path) => {
        const p = await payload();
        const entry = p.inventory.files.find(
          (file) => file.path === "app/main.mjs",
        );
        assert.ok(entry);
        await writeFile(join(p.root, "..", "outside.txt"), "outside sentinel\n", {
          flag: "wx",
        });
        entry.path = path;
        await writeInventory(p);
        await rejects(p);
      },
      20_000,
    );

    it("rejects an inventory for a Store schema other than seven", async () => {
      const p = await payload();
      p.inventory.storeSchemaVersion = 6;
      await writeInventory(p);
      await rejects(p);
    }, 20_000);

    it("rejects malformed UTF-8 that replacement decoding would accept as the exact valid inventory", async () => {
      const p = await payload();
      await addFile(
        p,
        "licenses/replacement-\ufffd(.txt",
        Buffer.from("synthetic replacement-name license\n"),
      );
      const text = `${JSON.stringify(p.inventory)}\n`;
      const position = text.indexOf("\ufffd(");
      expect(position >= 0).toBe(true);
      const bytes = Buffer.concat([
        Buffer.from(text.slice(0, position)),
        Buffer.from([0xc3, 0x28]),
        Buffer.from(text.slice(position + 2)),
      ]);
      expect(
        isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), p.inventory),
        "fixture isolates fatal decoding from all inventory field checks",
      ).toBe(true);
      await writeFile(join(p.root, "package.inventory.json"), bytes);
      await rejects(p);
    }, 20_000);

    it.each([
      "app/worker.config.json",
      "keys/synthetic-private.PFX",
      "keys/synthetic-private.p12",
      "Store/records/state.json",
      "app/node_modules/.bin/tool.cmd",
      "app/node_modules/.pnpm/payload-fixture/index.js",
    ])(
      "rejects inventoried runtime state, private material or link layout %s",
      async (path) => {
        const p = await payload();
        await addFile(p, path, Buffer.from("synthetic-private-not-a-secret\n"));
        await writeInventory(p);
        await rejects(p);
      },
      20_000,
    );

    for (const mode of ["root", "ancestor", "child"] as const)
      it(`rejects a real ${mode} directory reparse point without following or modifying its target`, async (context) => {
        requireModule();
        const p = await payload();
        let selectedRoot = p.root;
        try {
          if (mode === "root") {
            selectedRoot = join(p.owner, "linked-root");
            await symlink(p.root, selectedRoot, "junction");
          } else if (mode === "ancestor") {
            const alias = join(p.owner, "linked-parent");
            await symlink(join(p.owner, "ordinary-parent"), alias, "junction");
            selectedRoot = join(alias, basename(p.root));
          } else {
            const outside = join(p.owner, "outside-target");
            await mkdir(outside);
            const bytes = Buffer.from("synthetic outside-target license\n");
            await writeFile(join(outside, "license.txt"), bytes, { flag: "wx" });
            await symlink(outside, join(p.root, "linked-directory"), "junction");
            p.inventory.files.push({
              path: "linked-directory/license.txt",
              bytes: bytes.length,
              sha256: sha256(bytes),
            });
            await writeInventory(p);
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "EACCES") {
            context.skip(
              `environment not verified: real ${mode} junction creation denied (${code})`,
            );
            return;
          }
          throw error;
        }
        await rejects(p, undefined, selectedRoot);
      }, 20_000);

    it("rejects a package without executing its real synthetic EXE or Node tripwires", async () => {
      requireModule();
      const p = await payload();
      const executable = join(p.owner, "execution-tripwire.exe");
      const compiled = await runPowerShell(
        `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
public static class PayloadExecutionTripwire {
  public static int Main(string[] args) {
    File.WriteAllText(Environment.GetEnvironmentVariable("VOZEB_PAYLOAD_EXECUTION_MARKER"), "synthetic-payload-executed");
    return 23;
  }
}
'@ -OutputAssembly $env:VOZEB_PAYLOAD_TRIPWIRE_EXE -OutputType ConsoleApplication -ErrorAction Stop
[Console]::Out.WriteLine('tripwire_fixture_ready')
`,
        { VOZEB_PAYLOAD_TRIPWIRE_EXE: executable },
      );
      expect(
        compiled.code === 0 &&
          compiled.signal === null &&
          compiled.stderr === "" &&
          compiled.stdout.trim() === "tripwire_fixture_ready",
        "standard Windows compiler must prepare the real fixture before the target assertion",
      ).toBe(true);
      const exeBytes = await readFile(executable);
      const scriptBytes = Buffer.from(
        'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.VOZEB_PAYLOAD_EXECUTION_MARKER, "synthetic-payload-executed");\nprocess.exit(23);\n',
      );
      for (const entry of p.inventory.files) {
        const bytes = entry.path.endsWith(".exe")
          ? exeBytes
          : entry.path === "app/main.mjs" || entry.path === "app/manage.mjs"
            ? scriptBytes
            : undefined;
        if (!bytes) continue;
        await writeFile(join(p.root, ...entry.path.split("/")), bytes);
        entry.bytes = bytes.length;
        entry.sha256 = sha256(bytes);
      }
      await addFile(
        p,
        "app/worker.config.json",
        Buffer.from('{"private":"synthetic-private-live-config"}\n'),
      );
      await writeInventory(p);
      await rejects(p);
      expect(existsSync(join(p.owner, "payload-executed.marker"))).toBe(false);
    }, 40_000);
  },
);
