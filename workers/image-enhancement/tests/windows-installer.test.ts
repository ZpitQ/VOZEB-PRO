import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runOfflineCredentialCommand } from "../src/offline-management.js";
import { configInput } from "./fixtures.js";
import { transportLimits } from "./http-fixtures.js";
import { recursiveFiles, runnerLimits, sha256, submissionLimits } from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
const windowsDirectory = join(workerDirectory, "deployment", "windows");
const modulePath = join(windowsDirectory, "Worker.Installation.psm1");
const installPath = join(windowsDirectory, "Install-Worker.ps1");
const removePath = join(windowsDirectory, "Remove-Worker.ps1");
const require = createRequire(import.meta.url);
const layout = [
  "WindowsServiceHost.exe", "WindowsServiceHost.deps.json",
  "WindowsServiceHost.runtimeconfig.json", "runtime/node.exe", "runtime/LICENSE",
  "app/main.mjs", "app/manage.mjs", "app/package.json", "app/dist/bootstrap.js",
  "app/dist/contracts.js", "native/bridge/WindowsControlBridge.exe",
  "native/supervisor/WindowsSupervisor.exe",
] as const;
type Pairing = ReturnType<typeof runOfflineCredentialCommand>;
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Result = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
const children: { process: ReturnType<typeof spawn>; closed: Promise<Result> }[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.process.exitCode === null && child.process.signalCode === null)
      child.process.kill();
    await child.closed.catch(() => undefined);
  }
});

function installerAvailable() {
  expect(existsSync(installPath) && existsSync(removePath),
    "Windows install/remove behavior entries have not been implemented").toBe(true);
}

async function put(path: string, bytes: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function tree(root: string) {
  if (!existsSync(root)) return [];
  return Promise.all((await recursiveFiles(root)).sort().map(async (path) => ({
    path: relative(root, path).replaceAll("\\", "/"), sha256: sha256(await readFile(path)),
  })));
}

async function inventory(root: string, version: string) {
  const files = [];
  for (const path of (await recursiveFiles(root)).sort()) {
    if (path === join(root, "package.inventory.json")) continue;
    const bytes = await readFile(path);
    files.push({ path: relative(root, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, version, storeSchemaVersion: 7, files })}\n`);
  await put(join(root, "package.inventory.json"), bytes);
  return sha256(bytes);
}

async function fixture(version = "m3-e3-fixture", realManage = false) {
  const cache = join(workerDirectory, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const owner = await mkdtemp(join(cache, "worker-installer-"));
  const payload = join(owner, "source payload 空格");
  const program = join(owner, "program files");
  const data = join(owner, "稳定 data");
  const backup = join(owner, "backup");
  const credential = join(owner, "delivery", "credential.json");
  const observation = join(owner, "private-observation.json");
  const manageEvents = join(owner, "manage-events.jsonl");
  for (const path of layout) await put(join(payload, ...path.split("/")), `inert fixture ${path}\n`);
  await put(join(payload, "app", "package.json"), '{"type":"module"}\n');
  await mkdir(dirname(credential), { recursive: true });
  await put(join(owner, "unrelated.txt"), "unrelated external sentinel\n");
  if (realManage) {
    await cp(process.execPath, join(payload, "runtime", "node.exe"));
    await cp(join(workerDirectory, "manage.mjs"), join(payload, "app", "manage.mjs"));
    for (const name of ["offline-management", "store", "credentials", "contracts", "execution", "config", "windows-journal-reader"])
      await cp(join(workerDirectory, "dist", `${name}.js`), join(payload, "app", "dist", `${name}.js`));
    // Real manage/initialize/Store; this controlled validator observes E3 ordering.
    await put(join(payload, "app", "dist", "bootstrap.js"), `
import { appendFileSync } from "node:fs";
export function validateWindowsWorkerInstallConfiguration(value) {
  appendFileSync(${JSON.stringify(manageEvents)}, JSON.stringify({
    event: "validate-config", clientId: value.operatorClientId,
    complete: typeof value.operatorClientId === "string" &&
      value.storeDirectory === ${JSON.stringify(join(data, "store"))} &&
      value.execution?.installationRoot === ${JSON.stringify(join(data, "engine"))} &&
      value.execution?.recordsRoot === ${JSON.stringify(join(data, "records"))} &&
      (value.tls?.pfxPath === ${JSON.stringify(join(data, "tls", "worker.pfx"))} ||
        (value.host === "127.0.0.1" && !Object.hasOwn(value, "tls")))
  }) + "\\n");
  if (process.env.VOZEB_INSTALLER_FIXTURE_MODE === "config-failure")
    throw new Error("synthetic-private-config-failure");
}
`);
  }
  const sqliteRoot = dirname(require.resolve("better-sqlite3/package.json"));
  for (const path of ["package.json", "LICENSE", "lib", "prebuilds"]) {
    const target = join(payload, "app", "node_modules", "better-sqlite3", ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await cp(join(sqliteRoot, ...path.split("/")), target, { recursive: true, dereference: true });
  }
  const inventorySha256 = await inventory(payload, version);
  const sourceEngine = join(owner, "electron source engine");
  const binary = Buffer.from("inert approved upscayl binary\n");
  const modelBin = Buffer.from([0, 17, 255, 8]);
  const modelParam = Buffer.from("7767517\nfixture parameters\n");
  const entry = (path: string, bytes: Buffer) => ({ path, length: String(bytes.length), sha256: sha256(bytes) });
  const modelSet = Buffer.from(`${JSON.stringify({ v: 1, modelName: "upscayl-standard-4x", files: [
    entry("upscayl-standard-4x.bin", modelBin), entry("upscayl-standard-4x.param", modelParam),
  ] })}\n`);
  const manifest = Buffer.from(`${JSON.stringify({ v: 1, platform: "win-x64", recipeId: "upscayl-4x-png-v1",
    binaryVersion: "fixture-binary-v1", entryPoint: "bin/upscayl-bin.exe",
    files: [entry("bin/upscayl-bin.exe", binary)], models: [{ modelId: "standard-4x",
      modelVersion: "fixture-model-v1", modelDirectory: "models/fixture-model",
      modelName: "upscayl-standard-4x", modelSetSha256: sha256(modelSet) }],
  })}\n`);
  const engineFiles = [
    ["installation-manifest.json", manifest], ["bin/upscayl-bin.exe", binary],
    ["models/fixture-model/model-set.json", modelSet],
    ["models/fixture-model/upscayl-standard-4x.bin", modelBin],
    ["models/fixture-model/upscayl-standard-4x.param", modelParam],
  ] as const;
  for (const [path, bytes] of engineFiles) await put(join(sourceEngine, ...path.split("/")), bytes);
  const importBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, files: engineFiles.map(([path, bytes]) => ({
    sourcePath: join(sourceEngine, ...path.split("/")), path, bytes: bytes.length, sha256: sha256(bytes),
  })) })}\n`);
  const engineImport = join(owner, "engine-import.json");
  await put(engineImport, importBytes);
  const workerConfig = configInput();
  workerConfig.models[0]!.binarySha256 = sha256(binary);
  workerConfig.models[0]!.modelSha256 = sha256(modelSet);
  const material = {
    port: 32_001, tls: { host: "127.0.0.1" }, selfTestModelId: "standard-4x", workerConfig,
    submissionLimits, runnerLimits, transportLimits,
    execution: { bridgeLimits: runnerAdapterOptions.bridge.limits, journalLimits: runnerAdapterOptions.journalLimits },
  };
  const config = join(owner, "configuration-material.json");
  await put(config, `${JSON.stringify(material)}\n`);
  const pfx = join(owner, "source-private.pfx");
  await put(pfx, "synthetic-private-pfx-fixture\n");
  return { owner, payload, program, data, backup, credential, observation, manageEvents, version,
    inventorySha256, engineImport, engineImportSha256: sha256(importBytes), manifestSha256: sha256(manifest),
    sourceEngine, config, pfx, material, realManage, receipt: join(data, "installation", "receipt.json"), bootId: randomUUID() };
}

function runPowerShell(script: string, variables: Readonly<Record<string, string>> = {}, fileArguments?: readonly string[], timeout = 60_000) {
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", ...(fileArguments === undefined ? ["-Command", `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
${script}`] : ["-File", script, ...fileArguments])], { cwd: workerDirectory, env: { ...process.env, ...variables }, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout });
  assert.ok(child.stdout && child.stderr);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString("utf8"); });
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString("utf8"); });
  const closed = new Promise<Result>((resolve, reject) => {
    child.once("error", () => reject(new Error("installer PowerShell fixture could not start")));
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  children.push({ process: child, closed });
  return closed;
}

function json(result: Result) {
  expect(result.signal === null).toBe(true);
  expect(result.stderr === "", "no paths, secrets or raw child errors on stderr").toBe(true);
  try {
    const value: unknown = JSON.parse(result.stdout);
    expect(value !== null && typeof value === "object" && !Array.isArray(value), "one JSON object").toBe(true);
    return value as Record<string, unknown>;
  }
  catch { throw new Error("installer did not return one safe JSON value"); }
}

async function installedGate(f: Fixture, expectedConfigSha256: string, strict = false) {
  const before = await tree(f.payload);
  const result = await runPowerShell(`
Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -ErrorAction Stop
$command = Get-Command Test-WorkerInstalledPayload -ErrorAction SilentlyContinue
if ($null -eq $command) { [Console]::Out.WriteLine('{"available":false}'); exit 0 }
try {
  if ($env:VOZEB_INSTALLER_STRICT -eq 'true') {
    $value = Test-WorkerPayload -PayloadRoot $env:VOZEB_INSTALLER_PAYLOAD -ExpectedInventorySha256 $env:VOZEB_INSTALLER_INVENTORY
  } else {
    $value = Test-WorkerInstalledPayload -PayloadRoot $env:VOZEB_INSTALLER_PAYLOAD -ExpectedInventorySha256 $env:VOZEB_INSTALLER_INVENTORY -ExpectedConfigSha256 $env:VOZEB_INSTALLER_CONFIG_HASH
  }
  $response = @{ available = $true; ok = $true; value = $value }
} catch { $response = @{ available = $true; ok = $false; error = $_.Exception.Message } }
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 8))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_INSTALLER_PAYLOAD: f.payload,
    VOZEB_INSTALLER_INVENTORY: f.inventorySha256, VOZEB_INSTALLER_CONFIG_HASH: expectedConfigSha256,
    VOZEB_INSTALLER_STRICT: String(strict) });
  const response = json(result);
  expect(response.available, "Test-WorkerInstalledPayload behavior is missing").toBe(true);
  expect(isDeepStrictEqual(await tree(f.payload), before), "the original package/config bytes remain unchanged").toBe(true);
  return response;
}

const callerSecurity = `
function Protect-TestFile($Path) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $existing = [System.IO.File]::GetAccessControl($Path, [System.Security.AccessControl.AccessControlSections]::Owner)
  $security = [System.Security.AccessControl.FileSecurity]::new()
  if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $sid.Value) { $security.SetOwner($sid) }
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
  [System.IO.File]::SetAccessControl($Path, $security)
  $actual = [System.IO.File]::GetAccessControl($Path)
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $sid.Value -or
      -not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -cne $sid.Value -or
      [int]$rules[0].FileSystemRights -ne 0x001f01ff -or [int]$rules[0].AccessControlType -ne 0 -or
      $rules[0].IsInherited -or [int]$rules[0].InheritanceFlags -ne 0 -or [int]$rules[0].PropagationFlags -ne 0) { throw 'worker_fixture_acl_invalid' }
}
`;

function initialRequest(f: Fixture) {
  return { Action: "Install", PayloadRoot: f.payload, ExpectedInventorySha256: f.inventorySha256,
    ProgramRoot: f.program, DataRoot: f.data, EngineImportManifest: f.engineImport,
    ExpectedEngineImportSha256: f.engineImportSha256, ConfigFile: f.config, TlsPfx: f.pfx,
    CredentialFile: f.credential, TimeoutSeconds: 30 };
}

function databaseState(f: Fixture) {
  const db = new Database(join(f.data, "store", "worker.sqlite"), { readonly: true, fileMustExist: true, timeout: 0 });
  try { return { schema: db.pragma("user_version", { simple: true }), check: db.pragma("quick_check", { simple: true }),
    identity: db.prepare("SELECT service_id FROM service_identity").get(),
    clients: db.prepare("SELECT client_id FROM clients ORDER BY client_id").all(),
    credentials: db.prepare("SELECT credential_id FROM credentials ORDER BY credential_id").all() }; }
  finally { db.close(); }
}

async function retainedFixture(f: Fixture, state: "installed" | "retained" = "installed", transport: "http" | "https" = "https") {
  const pairing = runOfflineCredentialCommand(["initialize", join(f.data, "store")]);
  const versionRoot = join(f.program, f.version);
  await cp(f.payload, versionRoot, { recursive: true });
  await cp(f.sourceEngine, join(f.data, "engine"), { recursive: true });
  await put(join(f.data, "records", "preserved-record.json"), '{"preserve":"same-attempt"}\n');
  await put(join(f.data, "store", "inputs", "preserved-input.bin"), Buffer.from([0, 255, 1]));
  await put(join(f.data, "store", "attempts", "preserved-result.bin"), Buffer.from([1, 2, 3]));
  const { tls, ...commonMaterial } = f.material;
  const config = Buffer.from(`${JSON.stringify({ ...commonMaterial, operatorClientId: pairing.credential.clientId,
    storeDirectory: join(f.data, "store"), ...(transport === "https"
      ? { tls: { ...tls, pfxPath: join(f.data, "tls", "worker.pfx") } }
      : { host: "127.0.0.1" }),
    execution: { ...f.material.execution, installationRoot: join(f.data, "engine"), recordsRoot: join(f.data, "records"),
      expectedManifestSha256: f.manifestSha256 } })}\n`);
  await put(join(f.data, "config", "worker.config.json"), config);
  await put(join(versionRoot, "app", "worker.config.json"), config);
  await mkdir(join(f.data, "tls"), { recursive: true });
  if (transport === "https") await cp(f.pfx, join(f.data, "tls", "worker.pfx"));
  await put(f.credential, `${JSON.stringify(pairing)}\n`);
  const receipt = { schemaVersion: 1, installationId: randomUUID(), state,
    serviceName: "ZebImageEnhancement", accountName: "NT SERVICE\\ZebImageEnhancement",
    tokenUserSid: null, sessionId: 0, programRoot: f.program, dataRoot: f.data, storeSchemaVersion: 7,
    serviceId: pairing.serviceId, clientId: pairing.credential.clientId,
    engineImportSha256: f.engineImportSha256, engineManifestSha256: f.manifestSha256,
    configSha256: sha256(config), tlsSha256: transport === "https" ? sha256(await readFile(f.pfx)) : null,
    active: { version: f.version, inventorySha256: f.inventorySha256,
      imagePath: `"${join(versionRoot, "WindowsServiceHost.exe")}"` }, previous: null,
    lastStopped: state === "retained" ? { bootId: f.bootId,
      host: { pid: 41_001, creationFileTime: "133000000000000001" },
      node: { pid: 41_002, creationFileTime: "133000000000000002" }, pinsExclusive: true } : null,
    operation: { operationId: randomUUID(), action: state === "retained" ? "Uninstall" : "Install",
      stage: state === "retained" ? "retained" : "started", outcome: "known", maintenanceBootId: null, targetSha256: null } };
  await put(f.receipt, `${JSON.stringify(receipt)}\n`);
  const protectedFiles = await runPowerShell(`${callerSecurity}
$receipt = Get-Content -LiteralPath $env:VOZEB_INSTALLER_RECEIPT -Encoding UTF8 -Raw | ConvertFrom-Json
$receipt.tokenUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[System.IO.File]::WriteAllText($env:VOZEB_INSTALLER_RECEIPT, ($receipt | ConvertTo-Json -Depth 16 -Compress), [System.Text.UTF8Encoding]::new($false))
Protect-TestFile $env:VOZEB_INSTALLER_RECEIPT
Protect-TestFile $env:VOZEB_INSTALLER_CREDENTIAL
[Console]::Out.WriteLine('{"prepared":true}')
`, { VOZEB_INSTALLER_RECEIPT: f.receipt, VOZEB_INSTALLER_CREDENTIAL: f.credential });
  expect(json(protectedFiles).prepared, "real caller-owned NTFS fixture preparation").toBe(true);
  return pairing;
}

const sequenceScope = `
param($Fixture, $Mode)
$required = @('Enter-WorkerInstallPrivileges', 'Invoke-WorkerNodeProcess', 'Get-WorkerServiceGeneration',
  'Invoke-WorkerScmChange', 'Invoke-WorkerMaintenanceHttp', 'Open-WorkerExclusiveObject',
  'Invoke-WorkerRobocopy', 'Set-WorkerResourceAcl')
foreach ($name in $required) {
  if ($null -eq (Get-Command $name -CommandType Function -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ready = $false }
  }
}
$script:testEvents = [System.Collections.Generic.List[object]]::new()
$script:testFixture = $Fixture
$script:testMode = $Mode
$script:testExists = $Fixture.initialState -eq 'installed'
$script:testRunning = $script:testExists
$script:testImagePath = $Fixture.imagePath
$script:testSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:testGenerationReads = 0
$script:testStarting = $false
$script:testNodeOriginal = (Get-Command Invoke-WorkerNodeProcess).ScriptBlock
$script:testExclusiveOriginal = (Get-Command Open-WorkerExclusiveObject).ScriptBlock
if ($Mode -in @('receipt-race', 'restore-failure')) {
  $script:testLockOriginal = (Get-Command Open-WorkerInstallLock).ScriptBlock
  $script:testReadReceiptOriginal = (Get-Command Read-WorkerReceipt).ScriptBlock
  function script:Read-WorkerReceipt {
    param($Path)
    $value = & $script:testReadReceiptOriginal -Path $Path
    $script:testEvents.Add(@{ name = 'receipt-read' })
    return $value
  }
  $script:testLedgerOriginal = (Get-Command Write-WorkerLedger).ScriptBlock
  function script:Write-WorkerLedger {
    param($Path, $Value)
    & $script:testLedgerOriginal -Path $Path -Value $Value
    if ($script:testMode -eq 'restore-failure' -and $Value.operation.outcome -ceq 'unknown') {
      $script:testEvents.Add(@{ name = 'unknown-written' })
    }
  }
  function script:Open-WorkerInstallLock {
    param($Path, $OperationId, [switch]$Existing)
    if ($script:testMode -eq 'receipt-race') {
      $winner = & $script:testReadReceiptOriginal -Path $script:testFixture.receipt
      $winner.previous = $winner.active
      $winner.active = $script:testFixture.race.active
      $winner.operation = [pscustomobject]@{ operationId = $script:testFixture.race.operationId;
        action = 'Upgrade'; stage = 'started'; outcome = 'known'; maintenanceBootId = $null;
        targetSha256 = $winner.active.inventorySha256 }
      $otherLock = & $script:testLockOriginal -Path $Path -OperationId $winner.operation.operationId -Existing
      try {
        Write-WorkerLedger $script:testFixture.receipt $winner
        $verified = & $script:testReadReceiptOriginal -Path $script:testFixture.receipt
        if ($verified.operation.operationId -cne $winner.operation.operationId) { throw 'worker_fixture_race_invalid' }
        [System.IO.File]::WriteAllBytes($script:testFixture.race.snapshot, [System.IO.File]::ReadAllBytes($script:testFixture.receipt))
        $script:testEvents.Add(@{ name = 'race-winner-saved' })
      } finally { $otherLock.Dispose() }
    }
    $inner = & $script:testLockOriginal -Path $Path -OperationId $OperationId -Existing:$Existing
    $script:testEvents.Add(@{ name = 'lock-acquired' })
    $lease = [pscustomobject]@{ inner = $inner }
    $lease | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
      $this.inner.Dispose()
      $script:testEvents.Add(@{ name = 'lock-released' })
    }
    return $lease
  }
}
function script:Enter-WorkerInstallPrivileges {
  param($Deadline)
  $script:testEvents.Add(@{ name = 'privileges-enter'; deadline = $Deadline.Ticks.ToString() })
  if ($script:testMode -eq 'privilege-denied') { throw 'worker_permission_denied' }
  $lease = [pscustomobject]@{}
  $lease | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    if ($script:testMode -eq 'restore-failure') {
      $locked = $false
      try {
        $probe = [System.IO.File]::Open([System.IO.Path]::Combine($script:testFixture.data, 'installation', 'operation.lock'),
          [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
        $probe.Dispose()
      } catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        $locked = ($failure.HResult -band 65535) -eq 32
      }
      $script:testEvents.Add(@{ name = $(if ($locked) { 'restore-while-locked' } else { 'restore-after-unlock' }) })
      throw 'worker_fixture_restore_unknown'
    }
    $script:testEvents.Add(@{ name = 'privileges-restored' })
  }
  return $lease
}
function script:Invoke-WorkerNodeProcess {
  param($ExecutablePath, $Arguments, $Deadline)
  $kind = if ($Arguments[0] -eq '-e') { 'verify-backup' } else { $Arguments[1] }
  $script:testEvents.Add(@{ name = 'node:' + $kind; deadline = $Deadline.Ticks.ToString() })
  if ($kind -eq 'issue') { throw 'worker_fixture_forbidden_issue' }
  if ($script:testFixture.realManage -or $kind -eq 'verify-backup') {
    $executable = if ($script:testFixture.realManage) { $ExecutablePath } else { $env:VOZEB_INSTALLER_TEST_NODE }
    $result = & $script:testNodeOriginal -ExecutablePath $executable -Arguments $Arguments -Deadline $Deadline
    if ($script:testMode -eq 'lost-output' -and $kind -eq 'initialize') { $result.stdout = '' }
    return $result
  }
  if ($kind -ne 'validate-config') { throw 'worker_fixture_unexpected_node_action' }
  return [pscustomobject]@{ outcome = 'known'; exited = $true; exitCode = 0;
    stdout = '{"configurationValid":true}' + [char]10; stderr = ''; stdoutComplete = $true; stderrComplete = $true }
}
function script:Get-WorkerServiceGeneration {
  param($Receipt, $Deadline, [switch]$WaitForReady)
  $script:testGenerationReads++
  $script:testEvents.Add(@{ name = 'generation'; deadline = $Deadline.Ticks.ToString() })
  if (-not $script:testExists) {
    return [pscustomobject]@{ exists = $false; candidateSid = $script:testSid }
  }
  if ($script:testStarting -and $script:testMode -like 'startup-*') {
    $script:testEvents.Add(@{ name = $(if ($WaitForReady) { 'startup-wait-requested' } else { 'startup-no-wait' }); deadline = $Deadline.Ticks.ToString() })
    if (-not $WaitForReady) { throw 'worker_identity_unknown' }
    if ($script:testMode -eq 'startup-exit') { throw 'worker_identity_unknown' }
    if ($script:testMode -eq 'startup-budget') { throw 'worker_timeout_unknown' }
    $script:testEvents.Add(@{ name = 'startup-observation' })
    $script:testStarting = $false
  }
  if ($script:testMode -eq 'endpoint-owner' -or
      (($script:testMode -eq 'boot-change' -or $script:testMode -eq 'pid-reuse') -and $script:testGenerationReads -gt 1)) {
    throw 'worker_identity_unknown'
  }
  $boot = $script:testFixture.bootId
  $nodePath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($script:testImagePath.Trim('"')), 'runtime', 'node.exe')
  $generation = [pscustomobject]@{ exists = $true; serviceName = 'ZebImageEnhancement';
    accountName = 'NT SERVICE\\ZebImageEnhancement'; imagePath = $script:testImagePath;
    status = $(if ($script:testRunning) { 'Running' } else { 'Stopped' }); candidateSid = $script:testSid;
    tokenUserSid = $script:testSid; sessionId = 0; bootId = $boot;
    host = @{ pid = 41001; creationFileTime = '133000000000000001'; imagePath = $script:testImagePath.Trim('"');
      tokenUserSid = $script:testSid; sessionId = 0; alive = $script:testRunning };
    node = @{ pid = 41002; creationFileTime = '133000000000000002'; parentPid = 41001;
      imagePath = $nodePath; tokenUserSid = $script:testSid; sessionId = 0; alive = $script:testRunning };
    endpoint = @{ scheme = $(if ($null -eq $Receipt.tlsSha256) { 'http' } else { 'https' }); host = '127.0.0.1'; port = 32001; ownerPid = 41002; bootId = $boot } }
  $generation | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $script:testEvents.Add(@{ name = 'generation-disposed' })
  }
  if ($script:testMode -eq 'startup-owner') { $generation.endpoint.ownerPid = 42002 }
  if ($WaitForReady -and $script:testMode -eq 'startup-delay') {
    $generation.bootId = $null; $generation.endpoint.bootId = $null
    $script:testEvents.Add(@{ name = 'startup-ready' })
  }
  return $generation
}
function script:Invoke-WorkerScmChange {
  param($Action, $ImagePath, $Generation, $Deadline)
  $script:testEvents.Add(@{ name = 'scm:' + $Action; imagePath = $ImagePath; deadline = $Deadline.Ticks.ToString() })
  if ($script:testMode -eq 'switch-failure' -and $Action -eq 'SetImagePath') { throw 'worker_fixture_scm_result_unknown' }
  switch ($Action) {
    'CreateDemand' { $script:testExists = $true; $script:testImagePath = $ImagePath }
    'Start' { $script:testRunning = $true; $script:testStarting = $true }
    'Stop' { $script:testRunning = $false }
    'Delete' { $script:testExists = $false }
    'SetImagePath' { $script:testImagePath = $ImagePath }
    'SetAutomatic' { }
    default { throw 'worker_fixture_unexpected_scm_action' }
  }
}
function script:Invoke-WorkerMaintenanceHttp {
  param($Method, $Generation, $Bearer, $Deadline)
  $script:testEvents.Add(@{ name = 'http:' + $Method; deadline = $Deadline.Ticks.ToString() })
  $draining = $script:testMode -in @('draining', 'restore-failure')
  return [pscustomobject]@{ bootId = $script:testFixture.bootId; sealed = $true;
    state = $(if ($draining) { 'draining' } else { 'quiescent' }); canStop = (-not $draining);
    store = @{ queued = 2; running = 0; slots = 0; unreleasedReferences = 0 };
    http = @{ sealed = $true; uploads = 0; downloads = 0; receipts = 0 };
    pending = @{ selfTestAdmission = 0; selfTestOutputRead = 0; runner = 0; adapter = 0 };
    runtime = @{ closing = $false; startupRecovery = 'settled';
      runner = @{ closed = $false; storeClosed = $false; recoveryState = 'idle'; recoveryInFlight = $false; ownedState = 'none' };
      adapter = @{ sealed = $false; activity = 'idle'; close = 'not_requested' } } }
}
function script:Open-WorkerExclusiveObject {
  param($LiteralPath, $Deadline)
  $script:testEvents.Add(@{ name = 'exclusive'; deadline = $Deadline.Ticks.ToString() })
  return (& $script:testExclusiveOriginal -LiteralPath $LiteralPath -Deadline $Deadline)
}
function script:Invoke-WorkerRobocopy {
  param($Source, $Destination, $Arguments, $Deadline)
  $script:testEvents.Add(@{ name = 'copy'; arguments = @($Arguments); deadline = $Deadline.Ticks.ToString() })
  if ($script:testMode -eq 'copy-failure') { return [pscustomobject]@{ outcome = 'known'; exited = $true; exitCode = 8; stdout = 'synthetic-private-copy'; stderr = ''; stdoutComplete = $true; stderrComplete = $true } }
  $null = [System.IO.Directory]::CreateDirectory($Destination)
  foreach ($directory in [System.IO.Directory]::GetDirectories($Source, '*', [System.IO.SearchOption]::AllDirectories)) {
    $null = [System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($Destination, $directory.Substring($Source.Length + 1)))
  }
  foreach ($file in [System.IO.Directory]::GetFiles($Source, '*', [System.IO.SearchOption]::AllDirectories)) {
    $target = [System.IO.Path]::Combine($Destination, $file.Substring($Source.Length + 1))
    [System.IO.File]::Copy($file, $target, $false)
    [System.IO.File]::SetCreationTimeUtc($target, [System.IO.File]::GetCreationTimeUtc($file))
    [System.IO.File]::SetLastWriteTimeUtc($target, [System.IO.File]::GetLastWriteTimeUtc($file))
    [System.IO.File]::SetAttributes($target, [System.IO.File]::GetAttributes($file))
  }
  $directories = @($Source) + @([System.IO.Directory]::GetDirectories($Source, '*', [System.IO.SearchOption]::AllDirectories))
  foreach ($directory in ($directories | Sort-Object { $_.Length } -Descending)) {
    $target = if ($directory -ceq $Source) { $Destination } else { [System.IO.Path]::Combine($Destination, $directory.Substring($Source.Length + 1)) }
    [System.IO.Directory]::SetCreationTimeUtc($target, [System.IO.Directory]::GetCreationTimeUtc($directory))
    [System.IO.Directory]::SetLastWriteTimeUtc($target, [System.IO.Directory]::GetLastWriteTimeUtc($directory))
    [System.IO.File]::SetAttributes($target, [System.IO.File]::GetAttributes($directory))
  }
  if ($script:testMode -eq 'copy-corrupt') {
    foreach ($target in [System.IO.Directory]::GetFiles($Destination, 'preserved-record.json', [System.IO.SearchOption]::AllDirectories)) {
      [System.IO.File]::WriteAllText($target, 'synthetic-corrupted-copy')
    }
  }
  return [pscustomobject]@{ outcome = 'known'; exited = $true; exitCode = 7; stdout = ''; stderr = ''; stdoutComplete = $true; stderrComplete = $true }
}
function script:Set-WorkerResourceAcl {
  param($Receipt, $CandidateSid, $Deadline)
  $script:testEvents.Add(@{ name = 'resource-acl'; deadline = $Deadline.Ticks.ToString() })
  return [pscustomobject]@{ verified = $true; candidateSid = $script:testSid }
}
return [pscustomobject]@{ ready = $true }
`;

type Observation = { ready: boolean; sourceSecurityUnchanged: boolean; events: { name: string; deadline?: string; arguments?: string[]; imagePath?: string }[];
  credentialSecurity?: { owner: string; protected: boolean; rules: { sid: string; mask: number; inherited: boolean; flags: number; type: number }[] }; callerSid: string };

async function entry(f: Fixture, request: Record<string, unknown>, mode = "normal", initialState = "fresh", remove = false,
  race?: { active: { version: string; inventorySha256: string; imagePath: string }; operationId: string; snapshot: string }) {
  installerAvailable();
  const current = existsSync(f.receipt) ? JSON.parse(await readFile(f.receipt, "utf8")) as { active: { imagePath: string } } : null;
  const sourcesBefore = [await tree(f.payload), await tree(f.sourceEngine),
    sha256(await readFile(f.engineImport)), sha256(await readFile(f.config)), sha256(await readFile(f.pfx))];
  const result = await runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru -ErrorAction Stop
$fixture = $env:VOZEB_INSTALLER_FIXTURE | ConvertFrom-Json
$ready = & $module { ${sequenceScope} } $fixture $env:VOZEB_INSTALLER_FIXTURE_MODE
if (-not $ready.ready) { [Console]::Out.WriteLine('{"missingInstallerBehavior":true}'); exit 0 }
function Get-TestSourceSecurity {
  $items = [System.Collections.Generic.List[object]]::new()
  foreach ($source in @($fixture.payload, $fixture.sourceEngine, $fixture.config, $fixture.pfx, $fixture.engineImport)) {
    $isDirectory = ([System.IO.File]::GetAttributes($source) -band [System.IO.FileAttributes]::Directory) -ne 0
    $paths = @($source)
    if ($isDirectory) { $paths += @([System.IO.Directory]::GetFileSystemEntries($source, '*', [System.IO.SearchOption]::AllDirectories)) }
    foreach ($path in ($paths | Sort-Object)) {
      $directory = ([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::Directory) -ne 0
      $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
      $items.Add([ordered]@{ path = $path; sddl = $acl.GetSecurityDescriptorSddlForm(
        [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group -bor [System.Security.AccessControl.AccessControlSections]::Access) })
    }
  }
  return (@($items.ToArray()) | ConvertTo-Json -Depth 8 -Compress)
}
$sourceSecurityBefore = Get-TestSourceSecurity
$inputValue = $env:VOZEB_INSTALLER_REQUEST | ConvertFrom-Json
$named = @{}
foreach ($property in $inputValue.PSObject.Properties) { $named[$property.Name] = $property.Value }
try {
  $returned = @(& $env:VOZEB_INSTALLER_ENTRY @named)
  foreach ($value in $returned) {
    if ($value -is [string]) { [Console]::Out.WriteLine($value) }
    else { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 16)) }
  }
} finally {
  $observation = & $module {
    $security = $null
    if ([System.IO.File]::Exists($script:testFixture.credential)) {
      $acl = [System.IO.File]::GetAccessControl($script:testFixture.credential)
      $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{ sid = $_.IdentityReference.Value; mask = [int]$_.FileSystemRights; inherited = $_.IsInherited;
          flags = ([int]$_.InheritanceFlags -bor ([int]$_.PropagationFlags -shl 4)); type = [int]$_.AccessControlType }
      })
      $security = @{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
        protected = $acl.AreAccessRulesProtected; rules = $rules }
    }
    @{ ready = $true; events = @($script:testEvents.ToArray()); callerSid = $script:testSid; credentialSecurity = $security }
  }
  $observation['sourceSecurityUnchanged'] = [string]::Equals($sourceSecurityBefore, (Get-TestSourceSecurity), [System.StringComparison]::Ordinal)
  [System.IO.File]::WriteAllText($env:VOZEB_INSTALLER_OBSERVATION, ($observation | ConvertTo-Json -Depth 16 -Compress), [System.Text.UTF8Encoding]::new($false))
}
exit $LASTEXITCODE
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_INSTALLER_ENTRY: remove ? removePath : installPath,
    VOZEB_INSTALLER_REQUEST: JSON.stringify(request), VOZEB_INSTALLER_FIXTURE_MODE: mode,
    VOZEB_INSTALLER_OBSERVATION: f.observation, VOZEB_INSTALLER_TEST_NODE: process.execPath,
    VOZEB_INSTALLER_FIXTURE: JSON.stringify({ ...f, initialState, race,
      imagePath: current?.active.imagePath ?? `"${join(f.program, f.version, "WindowsServiceHost.exe")}"`,
      nodePath: join(f.program, f.version, "runtime", "node.exe") }) });
  const publicValue = json(result);
  expect(publicValue.missingInstallerBehavior !== true, "required private OS behavior seams are missing").toBe(true);
  expect(existsSync(f.observation), "original invocation reached its private observation finally").toBe(true);
  const observed = JSON.parse(await readFile(f.observation, "utf8")) as Observation;
  expect(observed.ready).toBe(true);
  expect(observed.sourceSecurityUnchanged, "external source owner/group/DACL and inheritance remain unchanged").toBe(true);
  expect(isDeepStrictEqual([await tree(f.payload), await tree(f.sourceEngine), sha256(await readFile(f.engineImport)),
    sha256(await readFile(f.config)), sha256(await readFile(f.pfx))], sourcesBefore), "external sources stay byte-identical").toBe(true);
  const names = Object.keys(publicValue);
  expect(names.every((name) => ["code", "operationId", "version", "previousVersion", "installationId", "serviceId", "clientId", "outcome"].includes(name)), "only safe public receipt fields").toBe(true);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  expect(typeof publicValue.code === "string" && /^worker_[a-z_]+$/.test(publicValue.code) && !/\s/.test(publicValue.code)).toBe(true);
  expect(typeof publicValue.operationId === "string" && uuid.test(publicValue.operationId) && !/\s/.test(publicValue.operationId)).toBe(true);
  for (const name of ["installationId", "serviceId", "clientId"])
    expect(publicValue[name] === undefined || publicValue[name] === null ||
      (typeof publicValue[name] === "string" && uuid.test(publicValue[name]) && !/\s/.test(publicValue[name]))).toBe(true);
  for (const name of ["version", "previousVersion"])
    expect(publicValue[name] === undefined || publicValue[name] === null ||
      (typeof publicValue[name] === "string" && /^[A-Za-z0-9.-]+$/.test(publicValue[name]) && !/\s/.test(publicValue[name]))).toBe(true);
  expect(publicValue.outcome === "known" || publicValue.outcome === "unknown").toBe(true);
  const publicBytes = `${result.stdout}${result.stderr}`;
  expect(!publicBytes.includes(f.owner) && !publicBytes.includes("synthetic-private"), "no actual roots or raw child contents in public output").toBe(true);
  if (existsSync(f.credential)) {
    const secret = JSON.parse(await readFile(f.credential, "utf8")) as Pairing;
    expect(!publicBytes.includes(secret.credential.key), "no credential in output").toBe(true);
  }
  const deadlines = observed.events.flatMap((event) => event.deadline === undefined ? [] : [event.deadline]);
  expect(new Set(deadlines).size <= 1, "all OS operations use the same caller deadline").toBe(true);
  const events = observed.events.map((event) => event.name);
  if (events.includes("privileges-enter") && mode !== "privilege-denied" && mode !== "restore-failure") {
    expect(events.filter((event) => event === "privileges-restored")).toHaveLength(1);
    const restored = events.indexOf("privileges-restored");
    expect(events.every((event, index) => !/^(node:|scm:|copy|resource-acl|exclusive)/.test(event) || index < restored), "restoration follows the last owned OS operation").toBe(true);
  }
  return { result, publicValue, observed, events };
}

async function receipt(f: Fixture) {
  return JSON.parse(await readFile(f.receipt, "utf8")) as {
    installationId: string; state: string; serviceId: string | null; clientId: string | null;
    active: { version: string; imagePath: string }; previous: { version: string } | null;
    operation: { operationId: string; stage: string; outcome: string; maintenanceBootId: string | null; targetSha256: string | null };
  };
}

async function dataSnapshot(f: Fixture) {
  return Promise.all(["store", "records", "engine", "config", "tls"].map(async (name) => ({ name, files: await tree(join(f.data, name)) })));
}

async function securitySnapshot(f: Fixture, root = f.data) {
  const result = await runPowerShell(`
$items = [System.Collections.Generic.List[object]]::new()
foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) {
  $root = [System.IO.Path]::Combine($env:VOZEB_INSTALLER_DATA, $name)
  $paths = @($root) + @([System.IO.Directory]::GetFileSystemEntries($root, '*', [System.IO.SearchOption]::AllDirectories))
  foreach ($path in ($paths | Sort-Object)) {
    $isDirectory = ([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::Directory) -ne 0
    $acl = if ($isDirectory) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
    $items.Add(@{ path = $path.Substring($env:VOZEB_INSTALLER_DATA.Length + 1).Replace('\\', '/');
      sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group -bor [System.Security.AccessControl.AccessControlSections]::Access);
      creation = [System.IO.File]::GetCreationTimeUtc($path).ToString('o'); lastWrite = [System.IO.File]::GetLastWriteTimeUtc($path).ToString('o');
      attributes = [int][System.IO.File]::GetAttributes($path) })
  }
}
[Console]::Out.WriteLine((@($items.ToArray()) | ConvertTo-Json -Compress -Depth 8))
`, { VOZEB_INSTALLER_DATA: root });
  expect(result.code).toBe(0);
  expect(result.stderr === "").toBe(true);
  return JSON.parse(result.stdout) as unknown;
}

async function backupReceipt(root: string) {
  const found: { path: string; value: Record<string, unknown> }[] = [];
  for (const path of await recursiveFiles(root)) {
    if (!path.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (value.schemaVersion === 1 && typeof value.backupId === "string" && value.verified === true) found.push({ path, value });
    } catch { /* Non-receipt fixture files may be arbitrary bytes. */ }
  }
  expect(found.length, "one verified complete-snapshot backup receipt").toBe(1);
  return found[0]!;
}

function before(events: readonly string[], first: string, second: string) {
  expect(events.indexOf(first) >= 0 && events.indexOf(second) > events.indexOf(first), `${first} precedes ${second}`).toBe(true);
}

async function realRootAcl(f: Fixture, blocked: boolean) {
  return runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru -ErrorAction Stop
# A restricted caller token probes real NTFS access; it is not the SCM TokenUser or Session0.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class InstallerMetadataProbe {
  [StructLayout(LayoutKind.Sequential)] private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disabled, uint privilegeCount, IntPtr privileges, uint restrictCount, [In] SidAndAttributes[] restricted, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool RevertToSelf();
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  public static int Open(string path, string restrictingSid, uint access) {
    IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero;
    bool impersonated = false;
    var sid = new SecurityIdentifier(restrictingSid);
    byte[] bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      if (!OpenProcessToken(new IntPtr(-1), 0x000e, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var restriction = new SidAndAttributes[] { new SidAndAttributes { Sid = pinned.AddrOfPinnedObject(), Attributes = 0 } };
      if (!CreateRestrictedToken(token, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, restriction, out restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!ImpersonateLoggedOnUser(restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
      impersonated = true;
      using (SafeFileHandle file = CreateFileW(path, access, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
        return file.IsInvalid ? Marshal.GetLastWin32Error() : 0;
      }
    } finally {
      if (impersonated && !RevertToSelf()) Environment.FailFast("installer metadata probe could not revert its own restricted token");
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (token != IntPtr.Zero) CloseHandle(token);
      pinned.Free();
    }
  }
}
'@
$response = & $module {
  if ($null -eq (Get-Command Set-WorkerResourceAcl -ErrorAction SilentlyContinue)) { return @{ available = $false } }
  $f = $env:VOZEB_INSTALLER_FIXTURE | ConvertFrom-Json
  $caller = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $sha = [System.Security.Cryptography.SHA1]::Create()
  try { $hash = $sha.ComputeHash([System.Text.Encoding]::Unicode.GetBytes('ZEBIMAGEENHANCEMENT')) } finally { $sha.Dispose() }
  $parts = @(0..4 | ForEach-Object { [System.BitConverter]::ToUInt32($hash, $_ * 4).ToString() })
  $service = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-80-' + ($parts -join '-'))
  $privileges = $null
  try { $privileges = Enter-WorkerInstallPrivileges -Deadline ([DateTime]::UtcNow.AddSeconds(30)) }
  catch { return @{ available = $true; privilegesAvailable = $false; classified = ($_.Exception.Message -cmatch '\\Aworker_[a-z_]+\\z') } }
  $originals = @()
  $ownerOriginal = $null
  try {
    $ownerOriginal = [System.IO.Directory]::GetAccessControl($f.owner)
    $parent = [System.Security.AccessControl.DirectorySecurity]::new()
    $parent.SetOwner($caller)
    $parent.SetAccessRuleProtection($true, $false)
    $parent.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($caller,
      [System.Security.AccessControl.FileSystemRights]::FullControl, 3, 0, 0))
    $parent.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($service,
      [System.Security.AccessControl.FileSystemRights]0x001000a0, [System.Security.AccessControl.AccessControlType]::Allow))
    if ($env:VOZEB_INSTALLER_BLOCKED -eq 'true') {
      $parent.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($service,
        [System.Security.AccessControl.FileSystemRights]::ReadAttributes, [System.Security.AccessControl.AccessControlType]::Deny))
    }
    [System.IO.Directory]::SetAccessControl($f.owner, $parent)
    New-WorkerCallerDirectory $f.program
    New-WorkerCallerDirectory $f.data
    New-WorkerCallerDirectory ([System.IO.Path]::Combine($f.program, $f.version))
    foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) { New-WorkerCallerDirectory ([System.IO.Path]::Combine($f.data, $name)) }
    foreach ($root in @($f.program, $f.data)) { $originals += @(Get-WorkerTree $root) }
    $parentBefore = [Zeb.WorkerInstall.Native]::Inspect($f.owner).SecuritySddl
    $parentProbe = [InstallerMetadataProbe]::Open($f.owner, $service.Value, 0x001000a0)
    $r = [pscustomobject]@{ programRoot = $f.program; dataRoot = $f.data; tokenUserSid = $null;
      active = [pscustomobject]@{ version = $f.version }; operation = [pscustomobject]@{ action = 'Install' } }
    $accepted = $false; $classified = $false
    try {
      $result = Set-WorkerResourceAcl -Receipt $r -CandidateSid $service.Value -Deadline ([DateTime]::UtcNow.AddSeconds(30))
      $accepted = $result.verified -eq $true
    } catch { $classified = $_.Exception.Message -cmatch '\\Aworker_[a-z_]+\\z' }
    $roots = @()
    if ($accepted) {
      foreach ($root in @($f.program, $f.data)) {
        $acl = [System.IO.Directory]::GetAccessControl($root)
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $serviceRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $service.Value })
        $callerRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $caller.Value })
        $roots += @{ ownerIsCaller = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ceq $caller.Value;
          protected = $acl.AreAccessRulesProtected; callerFull = ($callerRules.Count -eq 1 -and [int]$callerRules[0].FileSystemRights -eq 0x001f01ff);
          serviceMetadataOnly = ($serviceRules.Count -eq 1 -and [int]$serviceRules[0].FileSystemRights -eq 0x001000a0 -and
            -not $serviceRules[0].IsInherited -and [int]$serviceRules[0].InheritanceFlags -eq 0 -and
            [int]$serviceRules[0].PropagationFlags -eq 0 -and [int]$serviceRules[0].AccessControlType -eq 0);
          metadataOpen = [InstallerMetadataProbe]::Open($root, $service.Value, 0x001000a0);
          mutationOpen = [InstallerMetadataProbe]::Open($root, $service.Value, 0x000d0040) }
      }
      Assert-WorkerNativeAcl -Receipt $r -Sid $service.Value
    }
    $unchanged = $true
    foreach ($item in $originals) {
      if ([Zeb.WorkerInstall.Native]::Inspect($item.path).SecuritySddl -cne $item.info.SecuritySddl) { $unchanged = $false }
    }
    return @{ available = $true; privilegesAvailable = $true; accepted = $accepted; classified = $classified;
      parentProbe = $parentProbe; parentUnchanged = ([Zeb.WorkerInstall.Native]::Inspect($f.owner).SecuritySddl -ceq $parentBefore);
      ownedAclUpdated = -not $unchanged; roots = @($roots) }
  } finally {
    try {
      foreach ($item in ($originals | Sort-Object { $_.path.Length } -Descending)) {
        [Zeb.WorkerInstall.Native]::RestoreMetadata($item.path, $item.info.SecuritySddl, $item.info.CreationUtc, $item.info.LastWriteUtc, $item.info.Attributes)
      }
    } finally {
      try { if ($null -ne $ownerOriginal) { [System.IO.Directory]::SetAccessControl($f.owner, $ownerOriginal) } }
      finally { if ($null -ne $privileges) { $privileges.Dispose() } }
    }
  }
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 10 -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_INSTALLER_FIXTURE: JSON.stringify(f), VOZEB_INSTALLER_BLOCKED: String(blocked) });
}

describe.skipIf(process.platform !== "win32")("Windows installation boundary", () => {
  it("installs internal HTTP without a PFX argument and preserves the protected credential", async () => {
    const f = await fixture("m3-http-fixture", true);
    const material: Record<string, unknown> = { ...f.material, host: "127.0.0.1" };
    delete material.tls;
    await put(f.config, `${JSON.stringify(material)}\n`);
    const request: Record<string, unknown> = initialRequest(f);
    delete request.TlsPfx;
    const installed = await entry(f, request);
    expect(installed.result.code, String(installed.publicValue.code)).toBe(0);
    expect(installed.publicValue.code).toBe("worker_operation_complete");
    const configuration = JSON.parse(await readFile(join(f.data, "config", "worker.config.json"), "utf8")) as Record<string, unknown>;
    expect(configuration.host).toBe("127.0.0.1");
    expect(Object.hasOwn(configuration, "tls")).toBe(false);
    expect(existsSync(join(f.data, "tls", "worker.pfx"))).toBe(false);
    const saved = JSON.parse(await readFile(f.receipt, "utf8")) as Record<string, unknown>;
    expect(saved.tlsSha256).toBeNull();
    const beforeCredential = sha256(await readFile(f.credential));
    const retained = await entry(f, { Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, "normal", "installed", true);
    expect(retained.result.code).toBe(0);
    const reinstalled = await entry(f, { Action: "Install", PayloadRoot: f.payload, ExpectedInventorySha256: f.inventorySha256,
      Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, "normal", "retained");
    expect(reinstalled.result.code).toBe(0);
    expect(sha256(await readFile(f.credential))).toBe(beforeCredential);
    expect(JSON.parse(await readFile(f.receipt, "utf8")).tlsSha256).toBeNull();
  }, 100_000);

  it.each([
    { method: "GET", shape: "ok" }, { method: "POST", shape: "ok" },
    { method: "POST", shape: "unwrapped" }, { method: "POST", shape: "error-code" },
    { method: "POST", shape: "null-data" },
    { method: "POST", shape: "empty-array-code" }, { method: "POST", shape: "ok-array-code" },
  ])("internal HTTP maintenance $method validates $shape envelope exactly once", async ({ method, shape }) => {
    const bootId = randomUUID();
    const bearer = Buffer.alloc(32, 17).toString("base64url");
    const seen: { method?: string; path?: string; authorized: boolean }[] = [];
    const server = createServer((request, response) => {
      seen.push({ method: request.method, path: request.url, authorized: request.headers.authorization === `Bearer ${bearer}` });
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const data = { bootId, sealed: false, state: "open", canStop: false };
      response.end(JSON.stringify(shape === "unwrapped" ? data : {
        code: shape === "empty-array-code" ? [] : shape === "ok-array-code" ? ["ok"] : shape === "error-code" ? "failed" : "ok",
        data: shape === "null-data" ? null : data, msg: "ok",
      }));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert(address && typeof address !== "string");
    try {
      const result = await runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru -ErrorAction Stop
$value = & $module {
  $script:liveChecks = 0
  function script:Assert-WorkerLiveGeneration { param($Generation, $Deadline) $script:liveChecks++ }
  $generation = [pscustomobject]@{ endpoint=[pscustomobject]@{ scheme='http'; host='127.0.0.1'; port=[int]$env:VOZEB_HTTP_PORT }; bootId=$env:VOZEB_HTTP_BOOT }
  try {
    $snapshot = Invoke-WorkerMaintenanceHttp -Method $env:VOZEB_HTTP_METHOD -Generation $generation -Bearer $env:VOZEB_HTTP_BEARER -Deadline ([DateTime]::UtcNow.AddSeconds(10))
  } catch {
    if ($_.Exception.Message -cne 'worker_http_unknown') { throw }
    return @{ rejected=$true; liveChecks=$script:liveChecks }
  }
  return @{ bootMatched=($snapshot.bootId -ceq $env:VOZEB_HTTP_BOOT); liveChecks=$script:liveChecks; state=$snapshot.state }
}
[Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_HTTP_PORT: String(address.port), VOZEB_HTTP_METHOD: method,
        VOZEB_HTTP_BOOT: bootId, VOZEB_HTTP_BEARER: bearer });
      expect(result.code).toBe(0);
      expect(json(result)).toEqual(shape === "ok"
        ? { bootMatched: true, liveChecks: 2, state: "open" }
        : { rejected: true, liveChecks: 1 });
      expect(seen).toEqual([{ method, path: "/v1/maintenance", authorized: true }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 20_000);

  it.each([false, true])("grants only owned-root metadata/traverse without rewriting blocked external ancestors on real NTFS (blocked=%s)", async (blocked) => {
    const f = await fixture();
    const result = await realRootAcl(f, blocked);
    expect(result.code).toBe(0);
    const value = json(result);
    expect(value.available).toBe(true);
    expect(value.privilegesAvailable, "requires real allocated SCM/SeBackup/SeRestore rights; absence is a prerequisite failure, not a behavioral RED").toBe(true);
    expect(value.parentProbe).toBe(blocked ? 5 : 0);
    expect(value.parentUnchanged, "external ancestor ACL must never be broadened").toBe(true);
    // Actual service-token ancestor refusal belongs to the Host gate before Prepare, after these minimal owned ACL grants.
    expect(value.accepted).toBe(true);
    expect(value.ownedAclUpdated).toBe(true);
    expect(isDeepStrictEqual(value.roots, [0, 1].map(() => ({ ownerIsCaller: true, protected: true,
      callerFull: true, serviceMetadataOnly: true, metadataOpen: 0, mutationOpen: 5 })))).toBe(true);
  }, 40_000);

  it.each([false, true])("accepts a decimal TimeoutSeconds through the actual -File entry (remove=%s)", async (remove) => {
    installerAvailable();
    const f = await fixture();
    const beforeFiles = await tree(f.owner);
    const request = remove ? { Receipt: ".", TimeoutSeconds: "30" } : { ...initialRequest(f), ProgramRoot: ".", TimeoutSeconds: "30" };
    const args = Object.entries(request).flatMap(([key, value]) => [`-${key}`, String(value)]);
    const result = await runPowerShell(remove ? removePath : installPath, {}, args);
    expect(result.code).toBe(1);
    expect(json(result).code, "valid CLI text passes the timeout gate and reaches the deliberate pre-write path failure").toBe("worker_path_invalid");
    expect(isDeepStrictEqual(await tree(f.owner), beforeFiles)).toBe(true);
    expect(!existsSync(f.program) && !existsSync(f.data) && !existsSync(f.credential)).toBe(true);
  }, 20_000);

  it.each([false, true].flatMap((remove) => ["missing", "0", "-1", "2147484", "1.5", "not-a-number"].map((value) => ({ remove, value }))))(
    "refuses invalid CLI timeout $value before writes (remove=$remove)", async ({ remove, value }) => {
      installerAvailable();
      const f = await fixture();
      const beforeFiles = await tree(f.owner);
      const request: Record<string, unknown> = remove ? { Receipt: "." } : { ...initialRequest(f), ProgramRoot: "." };
      if (value === "missing") delete request.TimeoutSeconds;
      else request.TimeoutSeconds = value;
      const args = Object.entries(request).flatMap(([key, item]) => [`-${key}`, String(item)]);
      const result = await runPowerShell(remove ? removePath : installPath, {}, args);
      expect(result.code).toBe(1);
      expect(json(result).code).toBe("worker_timeout_invalid");
      expect(isDeepStrictEqual(await tree(f.owner), beforeFiles)).toBe(true);
      expect(!existsSync(f.program) && !existsSync(f.data) && !existsSync(f.credential)).toBe(true);
    }, 20_000);

  it.each(["manifest", "model-set"].flatMap((kind) => ["true", '"1"', "1.0", "1e0"].map((scalar) => ({ kind, scalar }))).concat(
    ["true", '"1"'].map((scalar) => ({ kind: "import", scalar }))))(
    "rejects approved $kind version raw JSON $scalar before writes", async ({ kind, scalar }) => {
      installerAvailable();
      const f = await fixture();
      const manifestPath = join(f.sourceEngine, "installation-manifest.json");
      const setPath = join(f.sourceEngine, "models", "fixture-model", "model-set.json");
      if (kind !== "import") {
        const path = kind === "manifest" ? manifestPath : setPath;
        const original = await readFile(path, "utf8");
        expect(original.includes('"v":1,')).toBe(true);
        await put(path, original.replace('"v":1,', `"v":${scalar},`));
        if (kind === "model-set") {
          const setSha256 = sha256(await readFile(setPath));
          const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { models: { modelSetSha256: string }[] };
          manifest.models[0]!.modelSetSha256 = setSha256;
          await put(manifestPath, `${JSON.stringify(manifest)}\n`);
          f.material.workerConfig.models[0]!.modelSha256 = setSha256;
          await put(f.config, `${JSON.stringify(f.material)}\n`);
        }
      }
      const imported = JSON.parse(await readFile(f.engineImport, "utf8")) as { files: { sourcePath: string; bytes: number; sha256: string }[] };
      for (const file of imported.files) {
        const bytes = await readFile(file.sourcePath);
        file.bytes = bytes.length;
        file.sha256 = sha256(bytes);
      }
      let importText = `${JSON.stringify(imported)}\n`;
      if (kind === "import") importText = importText.replace('"schemaVersion":1,', `"schemaVersion":${scalar},`);
      await put(f.engineImport, importText);
      f.engineImportSha256 = sha256(Buffer.from(importText));
      f.manifestSha256 = sha256(await readFile(manifestPath));
      const beforeFiles = await tree(f.owner);
      const result = await entry(f, initialRequest(f));
      expect(result.result.code).toBe(1);
      expect(result.publicValue.code).toBe("worker_engine_invalid");
      expect(result.events.some((event) => event === "privileges-enter" || /^(node:|scm:|copy|resource-acl)/.test(event))).toBe(false);
      expect(isDeepStrictEqual((await tree(f.owner)).filter((file) => file.path !== "private-observation.json"), beforeFiles)).toBe(true);
      expect(!existsSync(f.program) && !existsSync(f.data) && !existsSync(f.credential)).toBe(true);
    }, 30_000);

  it("refuses a receipt changed between precheck and acquiring the real lock without overwriting the winner", async () => {
    installerAvailable();
    const f = await fixture();
    await retainedFixture(f);
    const targetVersion = "m3-race-winner";
    const targetHash = await inventory(f.payload, targetVersion);
    await cp(f.payload, join(f.program, targetVersion), { recursive: true });
    await cp(join(f.data, "config", "worker.config.json"), join(f.program, targetVersion, "app", "worker.config.json"));
    const race = { active: { version: targetVersion, inventorySha256: targetHash,
      imagePath: `"${join(f.program, targetVersion, "WindowsServiceHost.exe")}"` }, operationId: randomUUID(), snapshot: join(f.owner, "winner-receipt.json") };
    const dataBefore = await dataSnapshot(f);
    const programBefore = await tree(f.program);
    const result = await entry(f, { Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, "receipt-race", "installed", true, race);
    before(result.events, "receipt-read", "race-winner-saved");
    before(result.events, "race-winner-saved", "lock-acquired");
    expect(result.result.code).toBe(1);
    expect(result.publicValue.code).toBe("worker_operation_conflict");
    expect((await readFile(f.receipt)).equals(await readFile(race.snapshot)), "the newer active/operation receipt survives byte-for-byte").toBe(true);
    expect(result.events.some((event) => /^(http:|node:|scm:|copy|resource-acl|exclusive)/.test(event))).toBe(false);
    expect(isDeepStrictEqual(await dataSnapshot(f), dataBefore) && isDeepStrictEqual(await tree(f.program), programBefore)).toBe(true);
  }, 40_000);

  it("keeps the actual operation lock through privilege restoration failure and its Unknown ledger write", async () => {
    installerAvailable();
    const f = await fixture();
    await retainedFixture(f);
    const beforeData = await dataSnapshot(f);
    const result = await entry(f, { Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, "restore-failure", "installed", true);
    expect(result.result.code).toBe(1);
    expect(result.publicValue.code).toBe("worker_privilege_restore_unknown");
    expect(result.publicValue.outcome).toBe("unknown");
    expect(result.events.includes("restore-after-unlock")).toBe(false);
    before(result.events, "lock-acquired", "restore-while-locked");
    before(result.events, "restore-while-locked", "unknown-written");
    before(result.events, "unknown-written", "lock-released");
    expect((await receipt(f)).operation.outcome).toBe("unknown");
    expect(result.events.some((event) => /^(scm:|node:|copy|resource-acl)/.test(event))).toBe(false);
    expect(isDeepStrictEqual(await dataSnapshot(f), beforeData)).toBe(true);
  }, 40_000);

  it.each(["startup-delay", "startup-owner", "startup-exit", "startup-budget"])(
    "uses the startup-only readiness observation for %s without replaying Start or maintenance", async (mode) => {
      installerAvailable();
      const f = await fixture();
      await retainedFixture(f, "retained");
      const beforeData = await dataSnapshot(f);
      const result = await entry(f, { Action: "Install", PayloadRoot: f.payload, ExpectedInventorySha256: f.inventorySha256,
        Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, mode, "retained");
      expect(result.events.filter((event) => event === "scm:Start")).toHaveLength(1);
      before(result.events, "scm:Start", "startup-wait-requested");
      expect(result.events.includes("startup-no-wait")).toBe(false);
      expect(result.events.some((event) => event === "http:POST" || event === "node:initialize" || event === "node:issue")).toBe(false);
      if (mode === "startup-delay") {
        expect(result.result.code).toBe(0);
        before(result.events, "startup-observation", "startup-ready");
        before(result.events, "startup-ready", "http:GET");
        expect(result.events.filter((event) => event === "http:GET")).toHaveLength(1);
        before(result.events, "http:GET", "scm:SetAutomatic");
      } else {
        expect(result.result.code).toBe(1);
        expect(result.publicValue.outcome).toBe("unknown");
        expect(result.events.some((event) => event === "http:GET" || event === "scm:SetAutomatic")).toBe(false);
        expect((await receipt(f)).operation.outcome).toBe("unknown");
      }
      expect(isDeepStrictEqual(await dataSnapshot(f), beforeData)).toBe(true);
    }, 40_000);

  it("allows only the exact installed config while the shared strict package gate still rejects it", async () => {
    const f = await fixture();
    const bytes = Buffer.from('{"private":"synthetic-installed-config"}\n');
    await put(join(f.payload, "app", "worker.config.json"), bytes);
    const accepted = await installedGate(f, sha256(bytes));
    expect(isDeepStrictEqual(accepted, { available: true, ok: true,
      value: { version: f.version, storeSchemaVersion: 7 } })).toBe(true);
    const strict = await installedGate(f, sha256(bytes), true);
    expect(strict.ok === false && strict.error === "worker_package_invalid").toBe(true);
  }, 20_000);

  it.each(["missing", "changed", "extra"] as const)("rejects installed config %s without relaxing inventory", async (mode) => {
    const f = await fixture();
    const bytes = Buffer.from('{"private":"synthetic-installed-config"}\n');
    if (mode !== "missing") await put(join(f.payload, "app", "worker.config.json"), bytes);
    if (mode === "changed") await put(join(f.payload, "app", "worker.config.json"), Buffer.from("changed private bytes\n"));
    if (mode === "extra") await put(join(f.payload, "app", "unlisted.txt"), "unlisted\n");
    const response = await installedGate(f, sha256(bytes));
    expect(response.ok === false && response.error === "worker_package_invalid").toBe(true);
  }, 20_000);

  it.each([".", "..", "m3-e3."])("rejects version %j before deriving or creating any target", async (version) => {
    installerAvailable();
    const f = await fixture(version);
    const beforeFiles = await tree(f.owner);
    const result = await entry(f, initialRequest(f));
    expect(result.result.code).toBe(1);
    const afterFiles = (await tree(f.owner)).filter((file) => file.path !== "private-observation.json");
    expect(isDeepStrictEqual(afterFiles, beforeFiles), "invalid version leaves all owned and outside sentinels unchanged").toBe(true);
    expect(!existsSync(f.program) && !existsSync(f.data)).toBe(true);
    expect(result.events.every((event) => !/^(scm:|node:|copy|resource-acl)/.test(event))).toBe(true);
  }, 30_000);

  it.each(["missing", 0, 2_147_484] as const)("rejects TimeoutSeconds %s before any write", async (value) => {
    installerAvailable();
    const f = await fixture();
    const request: Record<string, unknown> = initialRequest(f);
    if (value === "missing") delete request.TimeoutSeconds;
    else request.TimeoutSeconds = value;
    const result = await entry(f, request);
    expect(result.result.code).toBe(1);
    expect(!existsSync(f.program) && !existsSync(f.data) && !existsSync(f.credential)).toBe(true);
    expect(result.events.some((event) => event === "privileges-enter" || /^(scm:|node:|copy|resource-acl)/.test(event))).toBe(false);
  }, 30_000);

  it("initializes the real Store once, then validates with the actual client and delivers the one secret despite a config failure", async () => {
    installerAvailable();
    const f = await fixture("m3-e3-real-init", true);
    const first = await entry(f, initialRequest(f), "config-failure");
    expect(first.result.code).toBe(1);
    expect(first.events.filter((event) => event === "node:initialize")).toHaveLength(1);
    before(first.events, "node:initialize", "node:validate-config");
    expect(first.events.some((event) => event.startsWith("scm:"))).toBe(false);
    const pairing = JSON.parse(await readFile(f.credential, "utf8")) as Pairing;
    const saved = await receipt(f);
    const database = databaseState(f);
    expect(database.schema === 7 && database.check === "ok" &&
      isDeepStrictEqual(database.identity, { service_id: pairing.serviceId })).toBe(true);
    expect(saved.serviceId === pairing.serviceId && saved.clientId === pairing.credential.clientId && saved.operation.outcome === "known").toBe(true);
    const observations = (await readFile(f.manageEvents, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { complete: boolean; clientId: string });
    expect(observations.length === 1 && observations[0]!.complete && observations[0]!.clientId === pairing.credential.clientId).toBe(true);
    const security = first.observed.credentialSecurity;
    expect(security !== undefined && security.owner === first.observed.callerSid && security.protected &&
      isDeepStrictEqual(security.rules, [{ sid: first.observed.callerSid, mask: 0x001f01ff, inherited: false, flags: 0, type: 0 }]), "real NTFS credential has exactly the caller Allow FullControl ACE").toBe(true);
    const originalCredential = await readFile(f.credential);
    expect(isDeepStrictEqual(await readdir(f.program), [f.version]), "the approved version is the single direct program child").toBe(true);
    const repeated = await entry(f, initialRequest(f), "config-failure");
    expect(repeated.events.some((event) => event === "node:initialize" || event === "node:issue")).toBe(false);
    expect((await readFile(f.credential)).equals(originalCredential)).toBe(true);
    expect(isDeepStrictEqual(databaseState(f), database)).toBe(true);
  }, 60_000);

  it("keeps a real initialized Store Unknown after lost output and never initializes or issues again", async () => {
    installerAvailable();
    const f = await fixture("m3-e3-lost-output", true);
    const result = await entry(f, initialRequest(f), "lost-output");
    expect(result.publicValue.outcome).toBe("unknown");
    expect(result.events.filter((event) => event === "node:initialize")).toHaveLength(1);
    expect(result.events.some((event) => event === "node:validate-config" || event.startsWith("scm:"))).toBe(false);
    const saved = await receipt(f);
    expect(saved.state === "unknown" && saved.operation.outcome === "unknown" && saved.serviceId === null && saved.clientId === null).toBe(true);
    expect(existsSync(join(f.data, "store", "worker.sqlite")) && !existsSync(f.credential)).toBe(true);
    const database = databaseState(f);
    const repeated = await entry(f, initialRequest(f), "lost-output");
    expect(repeated.publicValue.operationId === saved.operation.operationId && repeated.publicValue.outcome === "unknown").toBe(true);
    expect(repeated.events.some((event) => event.startsWith("node:") || event.startsWith("scm:"))).toBe(false);
    expect(isDeepStrictEqual(databaseState(f), database)).toBe(true);
  }, 60_000);

  it("reinstalls retained data with the same identity and credential without initialize or issue", async () => {
    installerAvailable();
    const f = await fixture();
    const pairing = await retainedFixture(f, "retained");
    const beforeData = await dataSnapshot(f);
    const originalCredential = await readFile(f.credential);
    const result = await entry(f, { Action: "Install", PayloadRoot: f.payload, ExpectedInventorySha256: f.inventorySha256,
      Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, "normal", "retained");
    expect(result.result.code).toBe(0);
    expect(result.events.some((event) => event === "node:initialize" || event === "node:issue")).toBe(false);
    before(result.events, "scm:CreateDemand", "scm:Start");
    before(result.events, "scm:Start", "scm:SetAutomatic");
    const saved = await receipt(f);
    expect(saved.state === "installed" && saved.serviceId === pairing.serviceId && saved.clientId === pairing.credential.clientId).toBe(true);
    expect(isDeepStrictEqual(await dataSnapshot(f), beforeData) && (await readFile(f.credential)).equals(originalCredential)).toBe(true);
  }, 40_000);

  it("seals once while draining, resumes the same target only with GET, and rejects a changed target", async () => {
    installerAvailable();
    const f = await fixture();
    await retainedFixture(f);
    const target = await inventory(f.payload, "m3-e3-next");
    const request = { Action: "Upgrade", PayloadRoot: f.payload, ExpectedInventorySha256: target, Receipt: f.receipt,
      BackupRoot: f.backup, CredentialFile: f.credential, TimeoutSeconds: 30 };
    const first = await entry(f, request, "draining", "installed");
    expect(first.publicValue.code).toBe("worker_not_quiescent");
    expect(first.events.filter((event) => event === "http:POST")).toHaveLength(1);
    expect(first.events.some((event) => event === "http:GET" || event === "scm:Stop" || event === "copy")).toBe(false);
    const saved = await receipt(f);
    expect(saved.operation.stage === "maintenance" && saved.operation.outcome === "known" && saved.operation.maintenanceBootId === f.bootId && saved.operation.targetSha256 === target).toBe(true);
    expect(saved.previous === null).toBe(true);
    const second = await entry(f, request, "draining", "installed");
    expect(second.publicValue.operationId).toBe(saved.operation.operationId);
    expect(second.events.filter((event) => event === "http:GET")).toHaveLength(1);
    expect(second.events.some((event) => event === "http:POST" || event === "scm:Stop" || event === "copy")).toBe(false);
    const otherTarget = await inventory(f.payload, "m3-e3-other");
    const changed = await entry(f, { ...request, ExpectedInventorySha256: otherTarget }, "draining", "installed");
    expect(changed.result.code).toBe(1);
    expect(changed.events.some((event) => /^(http:|scm:|copy)/.test(event))).toBe(false);
  }, 60_000);

  it.each(["pid-reuse", "endpoint-owner", "boot-change"])("stops all later writes when the private original-generation gate reports %s", async (mode) => {
    installerAvailable();
    const f = await fixture();
    await retainedFixture(f);
    const beforeData = await dataSnapshot(f);
    const result = await entry(f, { Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, mode, "installed", true);
    expect(result.publicValue.outcome).toBe("unknown");
    expect(result.events.some((event) => event === "scm:Stop" || event === "scm:Delete" || event === "copy")).toBe(false);
    expect(isDeepStrictEqual(await dataSnapshot(f), beforeData)).toBe(true);
    expect((await receipt(f)).operation.outcome).toBe("unknown");
  }, 40_000);

  it.each(["http", "https"] as const)("verifies a complete schema7 %s backup before switching, then explicitly rolls back bytes, ACLs and stable identity together", async (transport) => {
    installerAvailable();
    const f = await fixture();
    await retainedFixture(f, "installed", transport);
    const beforeData = await dataSnapshot(f);
    const beforeSecurity = await securitySnapshot(f);
    const dbBefore = databaseState(f);
    const nextHash = await inventory(f.payload, "m3-e3-next");
    const upgraded = await entry(f, { Action: "Upgrade", PayloadRoot: f.payload, ExpectedInventorySha256: nextHash,
      Receipt: f.receipt, BackupRoot: f.backup, CredentialFile: f.credential, TimeoutSeconds: 30 }, "normal", "installed");
    expect(upgraded.result.code).toBe(0);
    before(upgraded.events, "http:POST", "scm:Stop");
    before(upgraded.events, "scm:Stop", "exclusive");
    before(upgraded.events, "copy", "node:verify-backup");
    before(upgraded.events, "node:verify-backup", "scm:SetImagePath");
    before(upgraded.events, "scm:SetImagePath", "scm:Start");
    for (const event of upgraded.observed.events.filter((event) => event.name === "copy"))
      expect(isDeepStrictEqual(event.arguments, ["/E", "/B", "/COPY:DAT", "/DCOPY:DAT", "/XJ", "/R:0", "/W:0"])).toBe(true);
    const oldBackup = await backupReceipt(f.backup);
    expect(oldBackup.value.tlsSha256).toBe(transport === "http" ? null : sha256(await readFile(f.pfx)));
    expect(oldBackup.value.sourceVersion === f.version && oldBackup.value.storeSchemaVersion === 7).toBe(true);
    expect(typeof oldBackup.value.root === "string").toBe(true);
    const selectedBackupRoot = oldBackup.value.root as string;
    const backupBytes = await tree(selectedBackupRoot);
    const backupSecurity = await securitySnapshot(f, selectedBackupRoot);
    const originalBackupReceipt = await readFile(oldBackup.path);
    const saved = await receipt(f);
    expect(saved.active.version === "m3-e3-next" && saved.previous?.version === f.version).toBe(true);
    expect(isDeepStrictEqual(databaseState(f), dbBefore)).toBe(true);
    const rolledBack = await entry(f, { Action: "Rollback", Receipt: f.receipt, BackupReceipt: oldBackup.path,
      CredentialFile: f.credential, TimeoutSeconds: 30 }, "normal", "installed");
    expect(rolledBack.result.code).toBe(0);
    before(rolledBack.events, "node:verify-backup", "scm:SetImagePath");
    expect(isDeepStrictEqual(await dataSnapshot(f), beforeData) && isDeepStrictEqual(databaseState(f), dbBefore)).toBe(true);
    expect(isDeepStrictEqual(await securitySnapshot(f), beforeSecurity), "the entire old snapshot restores owner/group/DACL, inheritance, attributes and timestamps").toBe(true);
    expect(isDeepStrictEqual(await tree(selectedBackupRoot), backupBytes) && (await readFile(oldBackup.path)).equals(originalBackupReceipt), "the selected original backup stays immutable").toBe(true);
    expect(isDeepStrictEqual(await securitySnapshot(f, selectedBackupRoot), backupSecurity), "restore verification does not rewrite the original backup ACL or metadata").toBe(true);
    expect((await receipt(f)).active.version).toBe(f.version);
  }, 60_000);

  it.each(["privilege-denied", "copy-failure", "copy-corrupt", "backup-identity", "switch-failure"])("stops upgrade after %s without an automatic reverse switch or further start", async (mode) => {
    installerAvailable();
    const f = await fixture();
    await retainedFixture(f);
    if (mode === "backup-identity") {
      const db = new Database(join(f.data, "store", "worker.sqlite"));
      try { db.prepare("UPDATE service_identity SET service_id = ?").run(randomUUID()); }
      finally { db.close(); }
    }
    const receiptBefore = await readFile(f.receipt);
    const dataBefore = await tree(f.data);
    const target = await inventory(f.payload, "m3-e3-next");
    const result = await entry(f, { Action: "Upgrade", PayloadRoot: f.payload, ExpectedInventorySha256: target,
      Receipt: f.receipt, BackupRoot: f.backup, CredentialFile: f.credential, TimeoutSeconds: 30 }, mode, "installed");
    expect(result.result.code).toBe(1);
    expect(result.events.filter((event) => event === "scm:SetImagePath").length).toBe(mode === "switch-failure" ? 1 : 0);
    expect(result.events.some((event) => event === "scm:Start" || event === "node:initialize" || event === "node:issue")).toBe(false);
    if (mode === "switch-failure") expect((await receipt(f)).operation.outcome).toBe("unknown");
    if (mode === "privilege-denied")
      expect((await readFile(f.receipt)).equals(receiptBefore) && isDeepStrictEqual(await tree(f.data), dataBefore)).toBe(true);
  }, 60_000);

  it("defaults to a retaining uninstall and preserves all data, identity, credential and receipt", async () => {
    installerAvailable();
    const f = await fixture();
    const pairing = await retainedFixture(f);
    const beforeData = await dataSnapshot(f);
    const credential = await readFile(f.credential);
    const result = await entry(f, { Receipt: f.receipt, CredentialFile: f.credential, TimeoutSeconds: 30 }, "normal", "installed", true);
    expect(result.result.code).toBe(0);
    before(result.events, "scm:Stop", "exclusive");
    before(result.events, "exclusive", "scm:Delete");
    const saved = await receipt(f);
    expect(saved.state === "retained" && saved.serviceId === pairing.serviceId && saved.clientId === pairing.credential.clientId).toBe(true);
    expect(isDeepStrictEqual(await dataSnapshot(f), beforeData) && (await readFile(f.credential)).equals(credential)).toBe(true);
  }, 40_000);

  it("rejects a mismatched DeleteData root, then deletes only the retired whitelist after durable ownership moves to a tombstone", async () => {
    installerAvailable();
    const f = await fixture();
    await retainedFixture(f, "retained");
    const saved = await receipt(f);
    const beforeData = await dataSnapshot(f);
    const request = { Action: "DeleteData", Receipt: f.receipt, ExpectedDataRoot: f.data, TimeoutSeconds: 30 };
    const wrong = await entry(f, { ...request, ExpectedDataRoot: f.owner }, "normal", "retained", true);
    expect(wrong.result.code).toBe(1);
    expect(isDeepStrictEqual(await dataSnapshot(f), beforeData)).toBe(true);
    const credential = await readFile(f.credential);
    const deleted = await entry(f, request, "normal", "retained", true);
    expect(deleted.result.code).toBe(0);
    const tombstonePath = join(f.program, "installation-tombstones", `${saved.installationId}.json`);
    const tombstone = JSON.parse(await readFile(tombstonePath, "utf8")) as { installationId: string; operation: { outcome: string; stage: string } };
    expect(!existsSync(f.data) && tombstone.installationId === saved.installationId && tombstone.operation.stage === "deleted" && tombstone.operation.outcome === "known").toBe(true);
    expect((await readFile(f.credential)).equals(credential) && (await readFile(join(f.owner, "unrelated.txt"), "utf8")) === "unrelated external sentinel\n").toBe(true);
  }, 60_000);

  it("keeps an operation diagnostic without blocking explicit retained-data deletion", async () => {
    const f = await fixture();
    await retainedFixture(f, "retained");
    const saved = await receipt(f) as { operation: { operationId: string } };
    const logged = await runPowerShell(`
$module=Import-Module $env:VOZEB_INSTALLER_MODULE -PassThru
& $module {
  $receipt=Read-WorkerReceipt $env:VOZEB_DIAGNOSTIC_RECEIPT
  $path=Join-Path $receipt.dataRoot 'installation'
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $security=[Security.AccessControl.DirectorySecurity]::new()
  if([IO.Directory]::GetAccessControl($path).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value){$security.SetOwner($sid)}
  $security.SetAccessRuleProtection($true,$false)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  [IO.Directory]::SetAccessControl($path,$security)
  Write-WorkerOperationDiagnostic $receipt ([ComponentModel.Win32Exception]::new(1058))
}
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_DIAGNOSTIC_RECEIPT: f.receipt });
    expect(logged.code, logged.stderr).toBe(0);
    const deleted = await entry(f, { Action: "DeleteData", Receipt: f.receipt, ExpectedDataRoot: f.data,
      TimeoutSeconds: 30 }, "normal", "retained", true);
    expect(deleted.result.code, deleted.result.stdout).toBe(0);
    expect(existsSync(f.data)).toBe(false);
    const diagnostic = JSON.parse(await readFile(join(f.program, "installation-diagnostics",
      `operation-${saved.operation.operationId}-error.json`), "utf8")) as { failureNativeErrorCode: number };
    expect(diagnostic.failureNativeErrorCode).toBe(1058);
    expect(await readFile(join(f.owner, "unrelated.txt"), "utf8")).toBe("unrelated external sentinel\n");
  }, 60_000);

  it("pins an ordinary real process identity and proves read/write/delete sharing exclusion on a real file", async () => {
    const f = await fixture();
    const path = join(f.owner, "exclusive-object.bin");
    await put(path, "ordinary exclusive fixture\n");
    const result = await runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru
$response = & $module {
  if ($null -eq (Get-Command Open-WorkerProcessIdentity -ErrorAction SilentlyContinue) -or
      $null -eq (Get-Command Open-WorkerExclusiveObject -ErrorAction SilentlyContinue)) {
    return @{ available = $false }
  }
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $env:VOZEB_INSTALLER_TEST_NODE
  $info.Arguments = '-e "process.stdin.resume()"'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  $pin = $null
  $exclusive = $null
  $blocker = $null
  $knownClose = $false
  try {
    if (-not $process.Start()) { throw 'ordinary_fixture_start_failed' }
    $ctime = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    [System.IO.File]::WriteAllText($env:VOZEB_INSTALLER_ORDINARY_RECEIPT, (@{ pid = $process.Id; creationFileTime = $ctime } | ConvertTo-Json -Compress))
    $pin = Open-WorkerProcessIdentity -ProcessId $process.Id -ExpectedImagePath $env:VOZEB_INSTALLER_TEST_NODE
    $identity = $pin.pid -eq $process.Id -and $pin.creationFileTime -ceq $ctime -and
      [string]::Equals($pin.imagePath, $env:VOZEB_INSTALLER_TEST_NODE, [System.StringComparison]::OrdinalIgnoreCase) -and
      $pin.tokenUserSid -ceq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value -and
      $pin.sessionId -eq $process.SessionId -and -not $pin.handle.IsClosed
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $exclusive = Open-WorkerExclusiveObject -LiteralPath $env:VOZEB_INSTALLER_EXCLUSIVE -Deadline $deadline
    $sharingDenied = $false
    try {
      $unexpected = [System.IO.File]::Open($env:VOZEB_INSTALLER_EXCLUSIVE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
      $unexpected.Dispose()
    } catch {
      $failure = $_.Exception
      while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
      $sharingDenied = ($failure.HResult -band 65535) -eq 32
    }
    $deleteDenied = $false
    try { [System.IO.File]::Delete($env:VOZEB_INSTALLER_EXCLUSIVE) }
    catch {
      $failure = $_.Exception
      while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
      $deleteDenied = ($failure.HResult -band 65535) -eq 32
    }
    $exclusive.Dispose()
    $exclusive = $null
    $blocker = [System.IO.File]::Open($env:VOZEB_INSTALLER_EXCLUSIVE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $conflictRefused = $false
    try {
      $unexpected = Open-WorkerExclusiveObject -LiteralPath $env:VOZEB_INSTALLER_EXCLUSIVE -Deadline $deadline
      $unexpected.Dispose()
    } catch { $conflictRefused = $_.Exception.Message -cmatch '\\Aworker_[a-z_]+\\z' }
  } finally {
    if ($null -ne $blocker) { $blocker.Dispose() }
    if ($null -ne $exclusive) { $exclusive.Dispose() }
    if ($process.Id -gt 0) {
      $process.StandardInput.Close()
      $knownClose = $process.WaitForExit(10000)
      if ($knownClose) {
        $knownClose = $process.ExitCode -eq 0 -and $process.StandardOutput.ReadToEnd() -ceq '' -and $process.StandardError.ReadToEnd() -ceq ''
      }
    }
    if ($null -ne $pin) { $pin.handle.Dispose() }
    if ($knownClose) { $process.Dispose() }
  }
  return @{ available = $true; identity = $identity; sharingDenied = $sharingDenied;
    deleteDenied = $deleteDenied; conflictRefused = $conflictRefused; knownClose = $knownClose }
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_INSTALLER_TEST_NODE: process.execPath,
      VOZEB_INSTALLER_EXCLUSIVE: path, VOZEB_INSTALLER_ORDINARY_RECEIPT: join(f.owner, "ordinary-process.json") });
    const response = json(result);
    expect(response.available, "real process/exclusive OS primitives are missing").toBe(true);
    expect(isDeepStrictEqual(response, { available: true, identity: true, sharingDenied: true,
      deleteDenied: true, conflictRefused: true, knownClose: true })).toBe(true);
    expect(await readFile(path, "utf8")).toBe("ordinary exclusive fixture\n");
  }, 30_000);

  it("actually refuses unavailable SCM/backup/restore rights or restores an acquired caller privilege scope", async () => {
    const result = await runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru
$response = & $module {
  if ($null -eq (Get-Command Enter-WorkerInstallPrivileges -ErrorAction SilentlyContinue)) { return @{ available = $false } }
  $whoami = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'whoami.exe')
  $before = @(& $whoami /priv /fo csv /nh)
  if ($LASTEXITCODE -ne 0 -or $before.Count -eq 0) { throw 'privilege_fixture_query_failed' }
  $assigned = (@($before | Where-Object { $_ -cmatch '"SeBackupPrivilege"' }).Count -eq 1) -and
    (@($before | Where-Object { $_ -cmatch '"SeRestorePrivilege"' }).Count -eq 1)
  $lease = $null
  $accepted = $false
  $classified = $false
  try {
    $lease = Enter-WorkerInstallPrivileges -Deadline ([DateTime]::UtcNow.AddSeconds(10))
    $accepted = $null -ne $lease
  } catch { $classified = $_.Exception.Message -cmatch '\\Aworker_[a-z_]+\\z' }
  finally { if ($null -ne $lease) { $lease.Dispose() } }
  $after = @(& $whoami /priv /fo csv /nh)
  return @{ available = $true; unavailableRefused = ($assigned -or (-not $accepted -and $classified));
    classifiedOrAcquired = ($classified -or $accepted); restored = (($before -join [char]10) -ceq ($after -join [char]10)) }
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath });
    const response = json(result);
    expect(response.available, "actual privilege boundary is missing").toBe(true);
    expect(isDeepStrictEqual(response, { available: true, unavailableRefused: true,
      classifiedOrAcquired: true, restored: true })).toBe(true);
  }, 20_000);
});
describe.skipIf(process.platform !== "win32")("real installer fixed process output", () => {
  it.each(["robocopy", "node-stdout", "node-stderr"] as const)("joins %s with the command's output contract", async (kind) => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-fixed-process-"));
    const source = join(owner, "copy input");
    const destination = join(owner, "copy output");
    const bytes = Buffer.from([1, 2, 3]);
    await put(join(source, "original.bin"), bytes);
    const result = await runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru
$value = & $module {
  $lease = $null
  try {
    if ($env:VOZEB_FIXED_PROCESS_KIND -eq 'robocopy') {
      $lease = Enter-WorkerInstallPrivileges -Deadline ([DateTime]::UtcNow.AddSeconds(30))
      return Invoke-WorkerRobocopy -Source $env:VOZEB_FIXED_PROCESS_SOURCE -Destination $env:VOZEB_FIXED_PROCESS_DESTINATION -Arguments @('/E', '/B', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:0', '/W:0') -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    }
    $stream = if ($env:VOZEB_FIXED_PROCESS_KIND -eq 'node-stdout') { 'stdout' } else { 'stderr' }
    return Invoke-WorkerNodeProcess -ExecutablePath $env:VOZEB_FIXED_PROCESS_NODE -Arguments @('-e', ('process.' + $stream + '.write(Buffer.from([255]));')) -Deadline ([DateTime]::UtcNow.AddSeconds(30))
  } finally { if ($null -ne $lease) { $lease.Dispose() } }
}
[Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_FIXED_PROCESS_KIND: kind,
      VOZEB_FIXED_PROCESS_SOURCE: source, VOZEB_FIXED_PROCESS_DESTINATION: destination,
      VOZEB_FIXED_PROCESS_NODE: process.execPath });
    expect(result.code).toBe(0);
    const value = json(result);
    if (kind === "robocopy") {
      expect(value.outcome, "localized status bytes are not the copy's integrity proof").toBe("known");
      expect(value.exited).toBe(true);
      expect(value.exitCode).toBe(1);
      expect(value.stdoutComplete && value.stderrComplete).toBe(true);
      expect((await readFile(join(destination, "original.bin"))).equals(bytes)).toBe(true);
    } else {
      expect(value.outcome, "management output must continue rejecting invalid UTF-8").toBe("unknown");
      expect(value.stdoutComplete && value.stderrComplete).toBe(false);
    }
    expect((await readFile(join(source, "original.bin"))).equals(bytes)).toBe(true);
  }, 45_000);
});

describe.skipIf(process.platform !== "win32")("installer startup package capability", () => {
  it("accepts only the inventoried canonical marker and keeps legacy packages compatible", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-marker-"));
    const marker = Buffer.from("ZEB_STARTUP_OBSERVATION_V1\n");
    const cases = [
      { mode: "legacy", accepted: true, enabled: false, bytes: marker },
      { mode: "canonical", accepted: true, enabled: true, bytes: marker },
      { mode: "bad-content", accepted: false, enabled: false, bytes: Buffer.from("ZEB_STARTUP_OBSERVATION_V0\n") },
      { mode: "bom", accepted: false, enabled: false, bytes: Buffer.concat([Buffer.from([239, 187, 191]), marker]) },
      { mode: "crlf", accepted: false, enabled: false, bytes: Buffer.from("ZEB_STARTUP_OBSERVATION_V1\r\n") },
      { mode: "case-alias", accepted: false, enabled: false, bytes: marker },
      { mode: "directory", accepted: false, enabled: false, bytes: marker },
      { mode: "unregistered", accepted: false, enabled: false, bytes: marker },
      { mode: "missing-marker", accepted: false, enabled: false, bytes: marker },
      { mode: "missing-required", accepted: false, enabled: false, bytes: marker },
    ];
    const packages = [];
    for (const scenario of cases) {
      const root = join(owner, scenario.mode);
      const files = [];
      for (const path of layout) {
        const bytes = Buffer.from(`inert startup marker fixture ${path}\n`);
        files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
        if (scenario.mode !== "missing-required" || path !== "app/main.mjs")
          await put(join(root, ...path.split("/")), bytes);
      }
      const name = scenario.mode === "case-alias" ? "Startup-Observation.V1" : "startup-observation.v1";
      if (!["legacy", "directory", "unregistered", "missing-required"].includes(scenario.mode))
        files.push({ path: name, bytes: scenario.bytes.length, sha256: sha256(scenario.bytes) });
      if (scenario.mode === "directory") await mkdir(join(root, name));
      else if (!["legacy", "missing-marker", "missing-required"].includes(scenario.mode))
        await put(join(root, name), scenario.bytes);
      const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, version: "marker-v1", storeSchemaVersion: 7, files }));
      await put(join(root, "package.inventory.json"), raw);
      packages.push({ root, sha256: sha256(raw), ...scenario, bytes: undefined });
    }
    const result = await runPowerShell(`
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:VOZEB_INSTALLER_MODULE,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_syntax_invalid'}
foreach($name in @('Assert-WorkerPackagePath','Test-WorkerPackageInteger','Test-WorkerPayloadCore')){
  $definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  if($definitions.Count -ne 1){throw 'package_function_not_unique'}
  . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$rows=@(foreach($case in ($env:VOZEB_STARTUP_PACKAGES|ConvertFrom-Json)){
  $accepted=$false; $value=$null; $failure=$null
  try {$value=Test-WorkerPayloadCore $case.root $case.sha256; $accepted=$true}
  catch {$failure=$_.Exception.Message}
  $valid=if($case.accepted){$accepted -and $value.version -ceq 'marker-v1' -and $value.storeSchemaVersion -eq 7 -and
    $value.startupObservationV1 -is [bool] -and $value.startupObservationV1 -eq $case.enabled}
  else {-not $accepted -and $failure -ceq 'worker_package_invalid'}
  @{mode=$case.mode;passed=[bool]$valid;accepted=$accepted;failure=$failure}
})
@{rows=$rows;nativeLoaded=($null -ne ('Zeb.WorkerInstall.Native' -as [type]))}|ConvertTo-Json -Depth 6 -Compress
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_STARTUP_PACKAGES: JSON.stringify(packages) });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const value = json(result);
    const rows = value.rows as { mode: string; passed: boolean }[];
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) expect(row.passed, row.mode).toBe(true);
    expect(value.nativeLoaded).toBe(false);
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("installer startup argument delivery", () => {
  it("preserves ordinary Start and delivers only the exact bounded observation arguments", async () => {
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-startargs.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", sha256(await readFile(modulePath)),
    ]);
    expect(result.code, `startup argument controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.startupArgumentsParameterPresent).toBe(true);
    expect(value.passed).toBe(15);
    expect(value.failed).toBe(0);
    expect(value.controls).toHaveLength(15);
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("installer startup caller ownership", () => {
  it("keeps the original capture through all four callers and Unknown accounting", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-entry-"));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-entry.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", sha256(await readFile(modulePath)),
      "-OutputPath", join(owner, "entry-evidence.json"),
    ]);
    expect(result.code, `startup caller controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_caller_entry_controls_v4");
    expect(value.passed).toBe(true);
    expect(value.passCount).toBe(23);
    expect(value.failCount).toBe(0);
    expect(value.rows).toHaveLength(23);
    expect((value.rows as { passed: boolean }[]).every((row) => row.passed)).toBe(true);
    expect(value.observedEntrySlices).toBe(11);
    expect(value.actualProducerCollectorExecuted).toBe(false);
    expect(value.actualNativePipeOrPins).toBe(false);
    expect(value.actualInstalledInventoryOrMarker).toBe(false);
    expect(value.actualScmExercised).toBe(false);
    expect(value.actualVirtualServiceCrossSid).toBe(false);
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("installer startup producer and diagnostic I/O", () => {
  it("rejects invalid producer preflight and preserves a private diagnostic without overwriting it", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-producer-"));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-producer-diagnostic.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", sha256(await readFile(modulePath)),
      "-FixtureRoot", join(owner, "scenes"), "-OutputPath", join(owner, "producer-evidence.json"),
    ]);
    expect(result.code, `startup producer controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_producer_diagnostic_io_v2");
    expect(value.passed).toBe(true);
    expect(value.passCount).toBe(9);
    expect(value.failCount).toBe(0);
    expect(value.rows).toHaveLength(9);
    expect((value.rows as { passed: boolean }[]).every((row) => row.passed)).toBe(true);
    expect(value.actualImportedNew).toBe(true);
    expect(value.actualDiagnosticIo).toBe(true);
    expect(value.actualProducerSuccess).toBe(false);
    expect(value.actualContextOrStartingShaSuccess).toBe(false);
    expect(value.actualHostNodePins).toBe(false);
    expect(value.actualScmStarted).toBe(false);
    expect(value.actualVirtualServiceCrossSid).toBe(false);
    expect(value.actualGpu).toBe(false);
  }, 20_000);
});

describe.skipIf(process.platform !== "win32")("installer startup JSON protocol", () => {
  it("validates fixed wire shapes and preserves exact identity values", async () => {
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-json.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", sha256(await readFile(modulePath)),
    ]);
    expect(result.code, `startup JSON controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.available).toBe(true);
    expect(value.passed).toBe(32);
    expect(value.failed).toBe(0);
    expect(value.controls).toHaveLength(32);
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("installer startup pipe transport", () => {
  it("keeps one local pipe, exact frames, one ACK and the original cutoff", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-pipe-"));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-pipe.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", sha256(await readFile(modulePath)),
      "-OutputPath", join(owner, "pipe-evidence.json"),
    ]);
    expect(result.code, `startup pipe controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.passed).toBe(true);
    expect(value.passCount).toBe(16);
    expect(value.failCount).toBe(0);
    expect(value.rows).toHaveLength(16);
    expect(value.publicFactoryExecuted).toBe(false);
    expect(value.actualVirtualServiceCrossSid).toBe(false);
    expect(value.actualScmExercised).toBe(false);
  }, 20_000);
});

describe.skipIf(process.platform !== "win32")("installer startup caller pin", () => {
  it("retains the actual caller image and borrows original process handles without reopening", async () => {
    const probePath = join(workerDirectory, "tests", "fixtures", "windows-startup-caller-pin-probe.cs");
    const moduleSha = sha256(await readFile(modulePath));
    const probeSha = sha256(await readFile(probePath));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-caller-pin.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha, "-ProbePath", probePath, "-ProbeSha", probeSha,
    ]);
    expect(result.code, `startup caller pin controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_caller_pin_controls_v3");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.probeSha256).toBe(probeSha);
    expect(value.passed).toBe(true);
    expect(value.failCount).toBe(0);
    expect([0, 1]).toContain(value.skipCount);
    expect(Number(value.passCount) + Number(value.skipCount)).toBe(13);
    const rows = value.rows as { name: string; passed: boolean | null; skipped?: boolean; actualSystemImageHardLinks?: number }[];
    expect(rows).toHaveLength(13);
    for (const row of rows) {
      if (row.skipped) {
        expect(row.name).toBe("owned_hash_policy_kept_for_hardlinked_image");
        expect(row.passed).toBeNull();
        expect(rows.find((item) => item.name === "system_image_exact_sha_and_retained_stream")?.actualSystemImageHardLinks).toBe(1);
      } else expect(row.passed, row.name).toBe(true);
    }
    expect(value.callerFactoryExecuted).toBe(true);
    expect(value.callerDisposeControlReached).toBe(true);
    expect(value.productionSessionZeroPolicyExercised).toBe(false);
    expect(value.actualVirtualServiceCrossSid).toBe(false);
    expect(value.actualScmExercised).toBe(false);
    expect(value.scope).toBe("real current caller and real exited child; borrowed original kernel handle integrity/SHA/lifetime only; no service principal/session simulation, pipe, ACK or SCM");
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("installer startup intent persistence", () => {
  it("preserves exact private intent materials and checks the original start ordering", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-intent-"));
    const moduleSha = sha256(await readFile(modulePath));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-intent.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha,
      "-FixtureRoot", join(owner, "scenes"), "-OutputPath", join(owner, "intent-evidence.json"),
    ]);
    expect(result.code, `startup intent controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_intent_controls_v1");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    expect(value.storagePassCount).toBe(14);
    expect(value.storageFailCount).toBe(0);
    const rows = value.rows as { name: string; passed: boolean }[];
    expect(rows).toHaveLength(14);
    for (const row of rows) expect(row.passed, row.name).toBe(true);
    expect(value.sourcePassCount).toBe(2);
    expect(value.sourceFailCount).toBe(0);
    const sourceRows = value.sourceRows as { name: string; passed: boolean }[];
    expect(sourceRows).toHaveLength(2);
    for (const row of sourceRows) expect(row.passed, row.name).toBe(true);
    expect(value.callerFactoryExecuted).toBe(true);
    expect(value.actualStorageExecuted).toBe(true);
    expect(value.actualProducerSuccess).toBe(false);
    expect(value.actualScmStarted).toBe(false);
    expect(value.actualVirtualServiceCrossSid).toBe(false);
    expect(value.productionSessionZeroPolicyExercised).toBe(false);
    expect(value.failureProofCreated).toBe(false);
    expect(value.actualGpu).toBe(false);
    expect(value.scope).toBe("actual private durable-intent storage only; source-order checks separate; no full startup/FailureProof/Recover/SCM claim");
  }, 25_000);
});

describe.skipIf(process.platform !== "win32")("installer startup settlement cleanup shape", () => {
  it("keeps legacy diagnostics and requires the exact paired cleanup extension", async () => {
    const moduleSha = sha256(await readFile(modulePath));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-settlement-cleanup.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha,
    ]);
    expect(result.code, `startup settlement cleanup parser controls: ${result.stderr || result.stdout}`).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_settlement_cleanup_shape_v1");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passCount).toBe(15);
    expect(value.failCount).toBe(0);
    const rows = value.rows as { name: string; passed: boolean; accepted: boolean; expectedAccept: boolean }[];
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(row.passed, row.name).toBe(true);
      expect(row.accepted, row.name).toBe(row.expectedAccept);
    }
    expect(rows.filter((row) => row.accepted)).toHaveLength(4);
    expect(value.actualHostCleanup).toBe(false);
    expect(value.actualScm).toBe(false);
    expect(value.actualFailureProof).toBe(false);
    expect(value.actualRecover).toBe(false);
    expect(value.scope).toBe("pure production parser shape only; diagnostic acceptance never establishes cleanup facts or recovery authority");
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("installer startup original pin exit code", () => {
  it("reads real exit 0 and 2 from bound original handles and refuses unbound public records", async () => {
    const probePath = join(workerDirectory, "tests", "fixtures", "windows-startup-exit-code-probe.cs");
    const moduleSha = sha256(await readFile(modulePath));
    const probeSha = sha256(await readFile(probePath));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-exit-code.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha, "-ProbePath", probePath, "-ProbeSha", probeSha,
    ]);
    expect(result.code, "startup exit code controls: " + (result.stderr || result.stdout)).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_exit_code_controls_v3");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.probeSha256).toBe(probeSha);
    expect(value.actualNativeCompiled).toBe(true);
    expect(value.interfacePassCount).toBe(1);
    expect(value.interfaceFailCount).toBe(0);
    expect(value.passed).toBe(true);
    expect(value.behaviorStatus).toBe("complete");
    expect(value.expectedBehaviorControls).toBe(14);
    expect(value.passCount).toBe(14);
    expect(value.failCount).toBe(0);
    expect(value.pendingBehaviorControls).toBe(0);
    expect(value.pendingBehaviorNames).toEqual([]);
    expect(value.unexpectedFailure).toBeNull();
    const rows = value.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(14);
    for (const row of rows) expect(row.passed, String(row.name)).toBe(true);
    for (const expectedExit of [0, 2]) {
      expect(rows.find((row) => row.name === "real_stdin_gated_child_exit_" + expectedExit + "_exact_uint_and_original_borrow")).toMatchObject({
        expectedExitCode: expectedExit, actualExitCode: expectedExit, priorRealRequireStartupPin: true,
        originalBorrowPreserved: true, independentOriginalExitFactsMatched: true, guardianUsed: false,
        exitProbeReopenedPid: false, independentImageEvidenceSource: "same original handle kernel image queried while live",
        independentExitKernelImageQueried: false, retainedLiveImageBindingMatched: true,
      });
    }
    expect(rows.find((row) => row.name === "raw_parameterless_pin_with_correct_public_records_and_same_handle_refused")).toMatchObject({
      actualSeparateParameterlessObject: true, allPublicRecordsAndSameHandleCopiedExactly: true,
      borrowedOriginalHandlePreserved: true, publicRecordsPreserved: true, productionInternalBindingsCopied: false,
    });
    expect(value.probeCompiled).toBe(true);
    expect(value.actualChildCreated).toBe(true);
    expect(value.actualExitCodeReadInvoked).toBe(true);
    expect(value.nativeReadInvocationCount).toBe(15);
    expect(value.liveImageSeparatedFromExitFacts).toBe(true);
    expect(value.nonAuthorSourceReviewRequired).toBe(true);
    for (const field of ["independentExitKernelImageQueried", "actualDynamicHandleMutationExercised",
      "productionSessionZeroPolicyExercised", "actualVirtualServiceCrossSid", "actualScmExercised",
      "actualFailureProof", "actualRecover", "actualGpu"]) expect(value[field], field).toBe(false);
    expect(value.sourceReviewGate).toBe("only live Native.Pin binds readonly original handle and actual kernel image; raw public records cannot supply binding; exit reads kernel PID/creation/signaled/code from same local original handle, compares image to immutable live binding, rechecks current handle reference before return; no exited image query, PID/token reopen or borrowed-handle Dispose");
    expect(value.scope).toBe("14 deterministic original-handle behaviors; kernel image captured while live, exit kernel facts queried separately, raw parameterless public records refused; current-session children only; immutable origin and dynamic handle-change contracts retain separate non-author source review");
  }, 20_000);
});

describe.skipIf(process.platform !== "win32")("installer startup old stop capture", () => {
  it("keeps ordinary stop behavior and publishes upgrade facts after original pin disposal", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "old-stop-capture-"));
    const probePath = join(workerDirectory, "tests", "fixtures", "windows-startup-exit-code-probe.cs");
    const outputPath = join(owner, "evidence.json");
    const moduleSha = sha256(await readFile(modulePath));
    const probeSha = sha256(await readFile(probePath));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-old-stop-capture.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha, "-ProbePath", probePath, "-ProbeSha", probeSha,
      "-FixtureRoot", join(owner, "scene"), "-OutputPath", outputPath,
    ]);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const value = json(result);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(value);
    expect(value).toMatchObject({ passed: true, moduleSha256: moduleSha, probeSha256: probeSha,
      interfacePassCount: 1, interfaceFailCount: 0, behaviorPassCount: 11, behaviorFailCount: 0,
      pendingBehaviorCount: 0, pendingBehaviorNames: [], unexpectedFailure: null,
      actualNativeCompiled: true, actualOriginalPinAndRequire: true, actualPinAndRequireCount: 44,
      actualChildCount: 22, actualReceiptLedgerIo: true, nativeExitCodeProducerMocked: false });
    const rows = value.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(11);
    for (const row of rows) expect(row, String(row.name)).toMatchObject({
      passed: true, guardianUsed: false, cleanupFailureType: null, captureVisibleDuringDispose: false,
    });
    expect(rows.find((row) => row.name === "capture_original_exit0")).toMatchObject({
      capturePresent: true, captureMatchesActualOriginalFacts: true, stopCalls: 1,
      firstDisposeCalls: 1, secondDisposeCalls: 1, returnedValue: true,
    });
    expect(rows.find((row) => row.name === "queued_keeps_normal_stop")).toMatchObject({
      capturePresent: false, returnedValue: true, stopCalls: 1,
    });
    for (const field of ["actualScm", "actualSessionZeroOrServiceSid", "actualMaintenanceWire",
      "actualExclusiveSnapshot", "actualQualifiedPackage", "actualVerifiedBackup", "actualFailureProof",
      "actualRecover", "actualGpu"]) expect(value[field], field).toBe(false);
  }, 65_000);
});

describe.skipIf(process.platform !== "win32")("installer upgrade evidence storage", () => {
  it("binds four private materials to the original stopped receipt and complete backup", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "upgrade-evidence-"));
    const moduleSha = sha256(await readFile(modulePath));
    const outputPath = join(owner, "evidence.json");
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-upgrade-evidence.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha,
      "-FixtureRoot", join(owner, "scenes"), "-OutputPath", outputPath,
    ]);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const value = json(result);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(value);
    expect(value).toMatchObject({ code: "upgrade_evidence_storage_controls_v1", passed: true, moduleSha256: moduleSha,
      interfacePassCount: 1, interfaceFailCount: 0, behaviorPassCount: 17, behaviorFailCount: 0,
      pendingBehaviorCount: 0, pendingBehaviorNames: [], unexpectedFailure: null, forbiddenCalls: [],
      preflightCount: 16, writerInvocationCount: 17, actualNativeCompiled: true, actualStorage: true,
      actualWriterInvoked: true, actualInstalledPayloadValidation: true, actualReadBackupAndSnapshot: true });
    const rows = value.rows as { name: string; passed: boolean; originalInputsPreserved: boolean }[];
    expect(rows).toHaveLength(17);
    for (const row of rows) expect(row, row.name).toMatchObject({ passed: true, originalInputsPreserved: true });
    for (const field of ["actualNewWorkerBackup", "actualDatabaseVerification", "actualQualifiedHostBehavior",
      "actualStop", "actualScm", "actualSessionZeroOrServiceSid", "actualFailureProof", "actualRecover", "actualGpu"])
      expect(value[field], field).toBe(false);
  }, 65_000);
});

describe.skipIf(process.platform !== "win32")("installer startup shared wait exit", () => {
  it("shares the original deadline and records arbitrary uint exit codes from original pins", async () => {
    const probePath = join(workerDirectory, "tests", "fixtures", "windows-startup-wait-exit-probe.cs");
    const moduleSha = sha256(await readFile(modulePath));
    const probeSha = sha256(await readFile(probePath));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-startup-wait-exit.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha, "-ProbePath", probePath, "-ProbeSha", probeSha,
      "-ChildImage", process.execPath,
    ]);
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "startup-wait-exit-" + randomUUID() + ".json"), result.stdout, { flag: "wx" });
    expect(result.code, "startup wait exit controls: " + (result.stderr || result.stdout)).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_wait_exit_controls_v1");
    expect(value.childImageSha256).toBe(sha256(await readFile(process.execPath)));
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.probeSha256).toBe(probeSha);
    expect(value.actualNativeCompiled).toBe(true);
    expect(value.probeCompiled).toBe(true);
    expect(value.interfacePassCount).toBe(1);
    expect(value.interfaceFailCount).toBe(0);
    expect(value.passed).toBe(true);
    expect(value.behaviorStatus).toBe("complete");
    expect(value.expectedBehaviorControls).toBe(14);
    expect(value.passCount).toBe(14);
    expect(value.failCount).toBe(0);
    expect(value.pendingBehaviorControls).toBe(0);
    expect(value.pendingBehaviorNames).toEqual([]);
    expect(value.unexpectedFailure).toBeNull();
    const rows = value.rows as { name: string; passed: boolean }[];
    expect(rows.map((row) => row.name)).toEqual([
      "real_refused_capture_initial_exit_codes_null",
      "already_signaled_host0_node2_and_original_borrows",
      "delayed_real_host_then_node_exit_succeeds",
      "utc_total_deadline_is_shared_host_then_live_node",
      "earlier_monotonic_cutoff_is_shared_host_then_live_node",
      "expired_utc_rejected",
      "expired_monotonic_cutoff_rejected",
      "disposed_capture_rejected",
      "missing_host_pin_rejected",
      "missing_node_pin_rejected",
      "wrong_host_pid_record_rejected",
      "wrong_node_handle_rejected",
      "closed_caller_at_entry_rejected",
      "arbitrary_uint_exit_codes_are_observations_not_proof_gates",
    ]);
    for (const row of rows) expect(row.passed, row.name).toBe(true);
    expect(value.actualChildCreated).toBe(true);
    expect(value.childCount).toBe(10);
    expect(value.actualWaitHelperInvoked).toBe(true);
    expect(value.helperInvocationCount).toBe(13);
    expect(value.actualCaptureFactoryInvoked).toBe(true);
    expect(value.nonAuthorSourceReviewRequired).toBe(true);
    for (const field of ["actualReceiveExecuted", "productionSessionZeroPolicyExercised", "actualScmExercised",
      "actualVirtualServiceCrossSid", "actualFailureProof", "actualRecover", "actualGpu",
      "actualProducerSuccess", "callerInvalidationDuringWaitExercised"]) expect(value[field], field).toBe(false);
    expect(value.sourceReviewGate).toBe("real Assert-WorkerStartupWindow and original caller Require before/after each wait and before exit-code read; each wait gets min(original UTC remaining, original Context cutoff remaining); Host then Node share one absolute window; Native.ReadStartupExitCode receives original pins; no new timeout, PID reopen, pin disposal or recovery authority");
    expect(value.scope).toBe("real private wait consumer with actual current-session original handles; synthetic cutoff-only capture, no Receive/SCM/Session0/cross-SID/FailureProof/Recover/GPU claim");
  }, 40_000);
});

describe.skipIf(process.platform !== "win32")("installer upgrade evidence caller ownership", () => {
  it("keeps qualification optional and preserves original stop, backup and ledger failures", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-upgrade-entry-"));
    const moduleSha = sha256(await readFile(modulePath));
    const result = await runPowerShell(join(workerDirectory, "tests", "fixtures", "windows-upgrade-evidence-entry.ps1"), {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha, "-OutputPath", join(owner, "entry-evidence.json"),
    ]);
    expect(result.code, "upgrade evidence caller controls: " + (result.stderr || result.stdout)).toBe(0);
    const value = json(result);
    expect(value.code).toBe("upgrade_evidence_entry_controls_v1");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    expect(value.passCount).toBe(14);
    expect(value.failCount).toBe(0);
    expect(value.expectedBehaviorControls).toBe(11);
    expect(value.behaviorPassCount).toBe(11);
    expect(value.behaviorFailCount).toBe(0);
    expect(value.pendingBehaviorControls).toBe(0);
    expect(value.pendingBehaviorNames).toEqual([]);
    expect(value.observedEntrySlices).toBe(11);
    const rows = value.rows as { kind: string; name: string; passed: boolean; outputCount?: number; deadlineViolations?: number }[];
    expect(rows).toHaveLength(14);
    for (const row of rows) expect(row.passed, row.name).toBe(true);
    const behaviors = rows.filter((row) => row.kind === "behavior");
    expect(behaviors.map((row) => row.name)).toEqual([
      "upgrade_original_order_binding_and_scalar", "upgrade_resume_same_original_window",
      "upgrade_writer_failure_preserves_normal_upgrade", "upgrade_partial_writer_failure_loses_eligibility",
      "upgrade_legacy_without_evidence_remains_normal", "upgrade_stop_exception_not_swallowed",
      "upgrade_backup_exception_not_swallowed", "upgrade_ledger_exception_not_swallowed",
      "upgrade_stop_false_has_no_backup_writer_or_start", "uninstall_never_writes_upgrade_evidence",
      "rollback_never_writes_upgrade_evidence",
    ]);
    for (const row of behaviors) {
      expect(row.outputCount, row.name).toBe(1);
      expect(row.deadlineViolations, row.name).toBe(0);
    }
    expect(value.technicalNativeCompiled).toBe(true);
    expect(value.nonAuthorSourceReviewRequired).toBe(true);
    for (const field of ["actualNativeCompiled", "actualStopExecuted", "actualBackupExecuted", "actualWriterStorageExecuted",
      "actualScmExercised", "actualVirtualServiceCrossSid", "actualFailureProof", "actualRecover", "actualGpu",
      "fullInstallerActionValidationExecuted"]) expect(value[field], field).toBe(false);
    expect(value.scope).toBe("exact original Stop/action-dispatch and owner catch/finally with technical method sinks; no full installer validation, real Stop/backup/writer storage/SCM/Native/pins or recovery authority");
  }, 20_000);
});

describe.skipIf(process.platform !== "win32")("installer startup failure frame consumer", () => {
  it("reads four original failure frames while keeping handles, actual EOF and Proof outside this gate", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-failure-frames-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-startup-failure-frames.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("c966c5d82170e934913d74801f4b7211bab946671b506f051c0fc45ed58482ab");
    const moduleSha = sha256(await readFile(modulePath));
    const result = await runPowerShell(fixturePath, {}, ["-ModulePath", modulePath, "-ModuleSha", moduleSha]);
    const evidencePath = join(owner, "failure-frames-evidence.json");
    await writeFile(evidencePath, result.stdout, { encoding: "utf8", flag: "wx" });
    expect(await readFile(evidencePath, "utf8")).toBe(result.stdout);
    expect(result.code, "startup failure frames: " + (result.stderr || result.stdout)).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_failure_frames_controls_v1");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    for (const [field, count] of Object.entries({ interfacePassCount: 1, interfaceFailCount: 0,
      passCount: 15, failCount: 0, expectedBehaviorControls: 15, behaviorPassCount: 15, behaviorFailCount: 0,
      pendingBehaviorControls: 0, helperInvocationCount: 16 })) expect(value[field], field).toBe(count);
    expect(value.pendingBehaviorNames).toEqual([]);
    const rows = value.rows as { name: string; passed: boolean; checks: { variant: string; passed: boolean; captureUnchanged: boolean; accepted: boolean; expectedAccept: boolean; returnedFrameCount: number }[] }[];
    expect(rows.map((row) => row.name)).toEqual([
      "listener_failure_force1_expected_invalid_operation", "schema_failure_force1_expected_invalid_operation",
      "legacy_missing_cleanup_pair_refused", "cleanup_failure_count_nonzero_refused",
      "owner_release_incomplete_refused", "owner_tree_active_missing_refused", "tree_exit_missing_refused",
      "stderr_not_eof_refused", "stdout_sink_failure_refused", "phase_recovery_already_called_refused",
      "prepared_wire_sha_mismatch_refused", "raw_context_attempt_mismatch_refused",
      "stage_before_settled_refused", "host_zero_exit_code_refused", "truncated_or_extra_raw_frame_refused",
    ]);
    const checks = rows.flatMap((row) => row.checks);
    expect(checks).toHaveLength(16);
    for (const row of rows) expect(row.passed, row.name).toBe(true);
    for (const check of checks) {
      expect(check.passed, check.variant).toBe(true);
      expect(check.captureUnchanged, check.variant).toBe(true);
      expect(check.accepted, check.variant).toBe(check.expectedAccept);
      expect(check.returnedFrameCount, check.variant).toBe(check.expectedAccept ? 4 : 0);
    }
    expect(rows[14]?.checks.map((check) => check.variant)).toEqual(["truncate", "extra"]);
    for (const field of ["actualNativeCompiled", "syntheticCaptureConstructed", "actualFrameConsumerInvoked",
      "nonAuthorSourceReviewRequired"]) expect(value[field], field).toBe(true);
    for (const field of ["actualReceiveExecuted", "actualOriginalHandleVerification", "actualRealExitCodesObserved",
      "actualFailureProof", "actualRecover", "actualScm", "actualGpu"]) expect(value[field], field).toBe(false);
    expect(value.scope).toBe("real original Native context/frame parser and private failure-frame consumer; synthetic Capture and public pin identities only; no real Receive EOF/wait, original handles, service, cleanup or Proof/Recover evidence");
  }, 20_000);
});

describe.skipIf(process.platform !== "win32")("installer startup failure proof storage", () => {
  it("publishes fixed inert materials only after readback and closeout input gates", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-failure-proof-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-startup-failure-proof-storage.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("e1f0b351473c2f5fd5a0d6d1b3c5e7934796b433dab48a5c5b77930231c1987b");
    const moduleSha = sha256(await readFile(modulePath));
    const outputPath = join(owner, "storage-evidence.json");
    const result = await runPowerShell(fixturePath, {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha, "-FixtureRoot", join(owner, "scenes"), "-OutputPath", outputPath,
    ]);
    expect(await readFile(outputPath, "utf8")).toBe(result.stdout);
    expect(result.code, "startup failure proof storage: " + (result.stderr || result.stdout)).toBe(0);
    const value = json(result);
    expect(value.code).toBe("startup_failure_proof_storage_controls_v1");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    for (const [field, count] of Object.entries({ interfacePassCount: 1, interfaceFailCount: 0,
      behaviorPassCount: 12, behaviorFailCount: 0, pendingBehaviorCount: 0, preflightCount: 12,
      writerInvocationCount: 12 })) expect(value[field], field).toBe(count);
    expect(value.pendingBehaviorNames).toEqual([]);
    expect(value.unexpectedFailure).toBeNull();
    expect(value.forbiddenCalls).toEqual([]);
    const rows = value.rows as { name: string; passed: boolean; originalInputsPreserved: boolean }[];
    expect(rows.map((row) => row.name)).toEqual([
      "publishes_fixed_nine_materials_and_final_only", "capture_not_released_refused",
      "privileges_not_restored_refused", "installation_locks_not_released_refused",
      "failed_receipt_raw_tamper_refused", "existing_material_raw_tamper_refused",
      "new_material_vs_frozen_index_tamper_refused", "source_module_sha_mismatch_refused",
      "original_utc_deadline_expired_refused", "original_tick_cutoff_expired_refused",
      "pending_collision_preserves_originals", "final_collision_preserves_originals",
    ]);
    for (const row of rows) {
      expect(row.passed, row.name).toBe(true);
      expect(row.originalInputsPreserved, row.name).toBe(true);
    }
    for (const field of ["actualWriterInvoked", "actualNativeCompiled", "actualStorage",
      "actualReceiptValidation"]) expect(value[field], field).toBe(true);
    for (const field of ["actualSourceProvenance", "actualSemanticConstructor", "actualOriginalCloseout",
      "actualDatabaseVerification", "actualNewWorkerBackup", "actualScm", "actualFailureProof",
      "actualRecover", "actualGpu"]) expect(value[field], field).toBe(false);
    expect(value.nonAuthorSourceReviewRequired).toBe("writer validates 14-key inert evidence/receipt/current module and original UTC+Tick gates; checks fixed 3+6 material bytes/index/ACL; CreateNew pending readback then original MoveObject without overwrite as final publish; no post-publish fallible qualification gate; owning caller supplies real cleanup and source; Recover re-locks and revalidates");
    expect(value.scope).toBe("pure private storage with real receipt/path/ACL/native file helpers and original MoveObject; context/intent/frames/snapshot/proof semantic source and closeout flags deliberately synthetic; no DB/NewBackup/original startup/SCM/qualified FailureProof/Recover/GPU");
  }, 40_000);
});

describe.skipIf(process.platform !== "win32")("installer startup failure pin consumer", () => {
  it("checks the imported consumer through explicit native method sinks", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-failure-pins-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-startup-failure-pins.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("7900b6f24e640531505f38423c5266986599c9f86f59ebb26b9baf69abb1f1b8");
    const moduleSha = sha256(await readFile(modulePath));
    const result = await runPowerShell(fixturePath, {}, ["-ModulePath", modulePath, "-ModuleSha", moduleSha]);
    const evidencePath = join(owner, "failure-pins-evidence.json");
    await writeFile(evidencePath, result.stdout, { encoding: "utf8", flag: "wx" });
    expect(await readFile(evidencePath, "utf8")).toBe(result.stdout);
    expect(result.code, "startup failure pin consumer: " + (result.stderr || result.stdout)).toBe(0);
    const value = json(result);
    expect(value.code).toBe("failure_pins_consumer_controls_v1");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    expect(value.passCount).toBe(13);
    expect(value.failCount).toBe(0);
    const rows = value.rows as { name: string; passed: boolean; accepted: boolean; capturePreserved: boolean; nativeCallerCalls: number; nativeExitCalls: number }[];
    expect(rows.map((row) => row.name)).toEqual([
      "matching_capture_uses_native_boundaries", "actual_host_code_mismatch_refused",
      "actual_node_code_mismatch_refused", "service_sid_mismatch_refused", "service_session_mismatch_refused",
      "payload_path_mismatch_refused", "caller_context_mismatch_refused", "disposed_capture_refused",
      "utc_deadline_refused", "monotonic_cutoff_refused", "caller_native_refusal_preserved",
      "exit_native_refusal_preserved", "captured_exit_type_mismatch_refused",
    ]);
    for (const [index, row] of rows.entries()) {
      expect(row.passed, row.name).toBe(true);
      expect(row.capturePreserved, row.name).toBe(true);
      expect(row.accepted, row.name).toBe(index === 0);
    }
    expect(rows[0]?.nativeCallerCalls).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.nativeExitCalls).toBe(2);
    expect(value.actualImportedConsumer).toBe(true);
    expect(value.technicalNativeSinks).toBe(true);
    for (const field of ["actualNative", "actualOriginalHandles", "actualServiceSidOrSessionZero",
      "actualScm", "actualFailureProof", "actualRecover", "actualGpu"]) expect(value[field], field).toBe(false);
    expect(value.scope).toBe("imported private pin consumer with explicit native method sinks; no original handles, service or failure qualification");
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("installer startup failure proof owning entry", () => {
  it("preserves Unknown and publishes the same candidate only after original closeout gates", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-startup-failure-proof-entry-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-startup-failure-proof-entry.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("66b4527cd2487a74c80997046a5bea52166d920ecfeea2873a99985749656ee9");
    const moduleSha = sha256(await readFile(modulePath));
    const outputPath = join(owner, "entry-evidence.json");
    const result = await runPowerShell(fixturePath, {}, [
      "-ModulePath", modulePath, "-ModuleSha", moduleSha, "-OutputPath", outputPath,
    ]);
    await writeFile(join(owner, "entry-stdout.json"), result.stdout, { encoding: "utf8", flag: "wx" });
    expect(result.code, "startup failure proof owning entry: " + (result.stderr || result.stdout)).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(result.stdout);
    const value = json(result);
    expect(value.code).toBe("startup_failure_proof_entry_controls_v1");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    for (const [field, count] of Object.entries({ passCount: 16, failCount: 0,
      expectedBehaviorControls: 15, behaviorPassCount: 15, behaviorFailCount: 0,
      pendingBehaviorControls: 0, observedEntrySlices: 15 })) expect(value[field], field).toBe(count);
    expect(value.pendingBehaviorNames).toEqual([]);
    const rows = value.rows as { kind: string; name: string; passed: boolean; forbiddenCalls?: string[];
      deadlineViolations?: number; outputCount?: number; failureType?: string | null; exitCode?: number }[];
    expect(rows.map((row) => row.name)).toEqual([
      "one_candidate_in_original_catch_and_one_writer_in_original_finally",
      "upgrade_settled_original_references_order_and_deadline", "unknown_ledger_write_failure_has_no_proof",
      "unknown_independent_readback_mismatch_has_no_proof", "unknown_independent_readback_failure_has_no_proof",
      "optional_constructor_failure_preserves_original_error", "capture_dispose_failure_has_no_publication",
      "privileges_dispose_failure_has_no_publication", "installation_lock_dispose_failure_has_no_publication",
      "second_original_lock_dispose_failure_has_no_publication", "optional_writer_failure_preserves_original_unknown",
      "install_never_requests_failure_proof", "rollback_never_requests_failure_proof",
      "eof_stage_never_requests_failure_proof", "exit_wait_stage_never_requests_failure_proof",
      "missing_upgrade_success_pointers_never_request_failure_proof",
    ]);
    expect(rows[0]).toEqual({ kind: "wiring", name: rows[0]?.name, passed: true,
      constructorCallSites: 1, writerCallSites: 1, constructorInCatch: true,
      writerInFinally: true, constructorAssigned: true });
    for (const row of rows) {
      expect(row.passed, row.name).toBe(true);
      if (row.kind === "behavior") {
        expect(row.forbiddenCalls, row.name).toEqual([]);
        expect(row.deadlineViolations, row.name).toBe(0);
        expect(row.outputCount, row.name).toBe(1);
        expect(row.failureType, row.name).toBeNull();
        expect(row.exitCode, row.name).toBe(1);
      }
    }
    expect(value.technicalNativeCompiled).toBe(true);
    expect(value.constructorSourceInterfaceOutsideScope).toBe(true);
    for (const field of ["actualNativeCompiled", "actualIndependentDiskReadback", "actualStopExecuted",
      "actualBackupExecuted", "actualStartupExecuted", "actualSemanticConstructor", "actualWriterStorageExecuted",
      "actualOriginalHandleCloseout", "actualScmExercised", "actualFailureProof", "actualRecover", "actualGpu",
      "fullInstallerActionValidationExecuted"]) expect(value[field], field).toBe(false);
    expect(value.nonAuthorSourceReviewRequired).toBe("new optional readback/constructor/writer failures do not replace original startup error; original Unknown write/cleanup semantics unchanged; constructor after full independent Unknown readback while original refs held; all original disposal gates before same-candidate Closeout flags and single writer; no deadline extension or extra lifecycle calls");
    expect(value.scope).toBe("exact original Upgrade Start call and owner catch/finally; independent serialized receipt and Native/file methods are technical sinks; no original Native/filesystem/handles/SCM/startup/constructor/writer storage/Recovery");
  }, 25_000);
});

describe.skipIf(process.platform !== "win32")("installer startup failure proof constructor", () => {
  it("freezes original failure materials while preserving distinct source and backup ACLs", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-failure-constructor-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-startup-failure-proof-constructor.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("468ea0f531c8625b7b655c049ec7c7c96c2e19c26ecb2c2604a43f9d6779a37d");
    const moduleSha = sha256(await readFile(modulePath));
    // Keep nested inert package paths below the WinPS5 path limit.
    const sceneOwner = await mkdtemp(join(tmpdir(), "zeb-fc-"));
    const outputPath = join(owner, "constructor-evidence.json");
    const result = await runPowerShell(fixturePath, {}, ["-ModulePath", modulePath, "-ModuleSha", moduleSha,
      "-FixtureRoot", join(sceneOwner, "scenes"), "-OutputPath", outputPath]);
    await writeFile(join(owner, "constructor-stdout.json"), result.stdout, { encoding: "utf8", flag: "wx" });
    expect(result.code, "failure constructor: " + (result.stderr || result.stdout)).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(result.stdout);
    const value = json(result);
    expect(value.code).toBe("startup_failure_proof_constructor_controls_v4");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    for (const [field, count] of Object.entries({ interfacePassCount: 2, interfaceFailCount: 0,
      behaviorPassCount: 9, behaviorFailCount: 0, pendingBehaviorCount: 0, constructorInvocationCount: 10,
      actualInvocationCount: 10, actualFrameParserPreflight: 10, aclDifferencePreflightCount: 10 })) expect(value[field], field).toBe(count);
    expect(value.pendingBehaviorNames).toEqual([]);
    expect(value.unexpectedFailure).toBeNull();
    expect(value.forbiddenCalls).toEqual([]);
    const rows = value.rows as { name: string; passed: boolean; checks: { passed: boolean; accepted: boolean;
      sourceVsBackupAclDifferent: boolean; originalInputsPreserved: boolean; outputCount: number }[] }[];
    expect(rows.map((row) => row.name)).toEqual(["freezes_fourteen_key_failure_candidate",
      "unknown_receipt_additional_change_refused", "self_consistent_old_source_mismatch_refused",
      "successful_upgrade_pointer_missing_refused", "backup_payload_tamper_refused", "new_full_payload_tamper_refused",
      "original_frame_missing_refused", "original_deadline_refused", "original_starting_material_tamper_refused"]);
    expect(rows.flatMap((row) => row.checks)).toHaveLength(10);
    for (const [index, row] of rows.entries()) {
      expect(row.passed, row.name).toBe(true);
      for (const check of row.checks) {
        expect(check.passed, row.name).toBe(true);
        expect(check.sourceVsBackupAclDifferent, row.name).toBe(true);
        expect(check.originalInputsPreserved, row.name).toBe(true);
        expect(check.accepted, row.name).toBe(index === 0);
        expect(check.outputCount, row.name).toBe(index === 0 ? 1 : 0);
      }
    }
    for (const field of ["actualConstructorInvoked", "actualNativeCompiled", "actualStorage",
      "actualInstalledPayloadValidation", "actualReadBackupAndSnapshot", "sourceVsBackupAclDifferent"]) expect(value[field], field).toBe(true);
    for (const field of ["actualOriginalHandles", "actualScm", "actualSessionZeroOrServiceSid", "actualStartupIntentWriter",
      "actualDatabaseVerification", "actualNewWorkerBackup", "actualCloseout", "actualFailureProof", "actualRecover", "actualGpu"])
      expect(value[field], field).toBe(false);
  }, 40_000);
});

describe.skipIf(process.platform !== "win32")("installer explicit failure recovery", () => {
  it("recovers the internal installation with five inputs and no failure proof", async () => {
    const owner = await mkdtemp(join(tmpdir(), "zeb-internal-recovery-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-explicit-recovery.ps1");
    const result = await runPowerShell(fixturePath, {}, ["-ModulePath", modulePath, "-ModuleSha", sha256(await readFile(modulePath)),
      "-FixtureRoot", join(owner, "scenes"), "-OutputPath", join(owner, "result.json"), "-Internal"], 240_000);
    await put(join(owner, "stdout.json"), result.stdout);
    await put(join(owner, "stderr.txt"), result.stderr);
    const value = json(result);
    expect(result.code, JSON.stringify(value)).toBe(0);
    expect(value).toMatchObject({ passed: true, code: "internal_recovery_transaction_controls_v1", behaviorPassCount: 11,
      behaviorFailCount: 0, pendingBehaviorCount: 0, actualStorage: true, actualScm: false, actualDatabaseVerification: false });
    const rows = value.rows as { name: string; passed: boolean; directoryIdentityTransfers: number }[];
    expect(rows).toHaveLength(11);
    for (const row of rows) expect(row.passed, row.name).toBe(true);
    expect(rows[0]!.directoryIdentityTransfers).toBe(10);
  }, 250_000);

  it("keeps recovery startup pending while ordinary startup completes", async () => {
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-recovery-completion.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("6f63f8020ff495add912ce16ae4e806b276ede7ddda0716153515299a660f867");
    const result = await runPowerShell(fixturePath, {}, ["-ModulePath", modulePath]);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const value = json(result);
    expect(value.passed).toBe(true);
    expect(value.moduleSha256).toBe(sha256(await readFile(modulePath)));
    expect(value.rows).toEqual([
      { name: "recovery_start_does_not_commit_before_owner_cleanup", passed: true, knownWrites: 0, state: "pending", outcome: "pending" },
      { name: "ordinary_start_keeps_existing_completion", passed: true, knownWrites: 1, state: "installed", outcome: "known" },
    ]);
    expect(value.actualStartHelperBody).toBe(true);
    expect(value.actualScm).toBe(false);
  });

  it("checks the original deadline after cleanup before either success receipt", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-recovery-deadline-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-recovery-deadline.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("dfbb833f1a0b40d70efa727a1b1877bceda2e64a464c5a342546fadb05089e51");
    const moduleSha = sha256(await readFile(modulePath));
    const outputPath = join(owner, "deadline.json");
    const result = await runPowerShell(fixturePath, {}, ["-ModulePath", modulePath, "-ModuleSha", moduleSha, "-OutputPath", outputPath]);
    await writeFile(join(owner, "stdout.json"), result.stdout, { encoding: "utf8", flag: "wx" });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(result.stdout);
    const value = json(result);
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    expect(value.passCount).toBe(2);
    expect(value.failCount).toBe(0);
    const rows = value.rows as { passed: boolean; coreKnownWrites: number; privateKnownWrites: number }[];
    expect(rows.map((row) => [row.passed, row.coreKnownWrites, row.privateKnownWrites])).toEqual([[true, 1, 1], [true, 0, 0]]);
    expect(value.actualOriginalFinallySlice).toBe(true);
    expect(value.actualClockOrElapsedDeadline).toBe(false);
    expect(value.actualFullInvokeRecovery).toBe(false);
  });

  it("restores both failure phases and preserves original files on refusal or partial failure", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-explicit-recovery-"));
    const sceneOwner = await mkdtemp(join(tmpdir(), "zeb-er-"));
    const fixturePath = join(workerDirectory, "tests", "fixtures", "windows-explicit-recovery.ps1");
    expect(sha256(await readFile(fixturePath))).toBe("98d55f3eef0f1bb35d9615b3cb48f36872f4df8c3f2a2511ab08c770a526a0e8");
    const moduleSha = sha256(await readFile(modulePath));
    const outputPath = join(owner, "recovery.json");
    // Ten real filesystem scenarios share one fresh Native host; each retains its own original deadline.
    const result = await runPowerShell(fixturePath, {}, ["-ModulePath", modulePath, "-ModuleSha", moduleSha,
      "-FixtureRoot", join(sceneOwner, "scenes"), "-OutputPath", outputPath], 240_000);
    await writeFile(join(owner, "stdout.json"), result.stdout, { encoding: "utf8", flag: "wx" });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(result.stdout);
    const value = json(result);
    expect(value.code).toBe("explicit_recovery_transaction_controls_v3");
    expect(value.moduleSha256).toBe(moduleSha);
    expect(value.passed).toBe(true);
    for (const [key, count] of Object.entries({ interfacePassCount: 2, interfaceFailCount: 0,
      behaviorPassCount: 10, behaviorFailCount: 0, pendingBehaviorCount: 0, consumerInvocationCount: 10 })) expect(value[key], key).toBe(count);
    expect(value.unexpectedFailure).toBeNull();
    expect(value.pendingBehaviorNames).toEqual([]);
    const rows = value.rows as { passed: boolean; directoryIdentityTransfers: number; knownBeforeSuccessfulCleanupWrites: number;
      originalLockRetainedAtReturn: boolean; violations: string[] }[];
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.passed).toBe(true);
      expect(row.knownBeforeSuccessfulCleanupWrites).toBe(0);
      expect(row.violations).toEqual([]);
    }
    expect(rows.slice(0, 2).map((row) => row.directoryIdentityTransfers)).toEqual([10, 10]);
    for (const index of [0, 1, 7, 8, 9]) expect(rows[index]!.originalLockRetainedAtReturn).toBe(true);
    expect(rows[7]!.directoryIdentityTransfers).toBeGreaterThan(0);
    expect(rows[7]!.directoryIdentityTransfers).toBeLessThan(10);
    expect(value.actualStorage).toBe(true);
    for (const field of ["actualOriginalCopySnapshot", "actualOriginalHandles", "actualServiceSidOrSessionZero",
      "actualDatabaseVerification", "actualScm", "actualOriginalStartOwnedService", "actualHttp", "actualProcessLifetimeLock",
      "actualIndependentEntryExecuted", "actualFailureProof", "actualRecover", "actualGpu"]) expect(value[field], field).toBe(false);
  }, 250_000);
});

describe.skipIf(process.platform !== "win32")("internal installer failure diagnostics", () => {
  it("records ordinary operation stage and native code without private exception text or overwriting", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "internal-operation-diagnostic-"));
    const result = await runPowerShell(`
$module=Import-Module $env:VOZEB_INSTALLER_MODULE -PassThru
$value=& $module {
  param($root)
  Initialize-WorkerInstallNative
  New-WorkerCallerDirectory (Join-Path $root 'installation')
  $rows=@()
  foreach($native in @($true,$false)){
    $receipt=[pscustomobject]@{dataRoot=$root;programRoot=$root;operation=[pscustomobject]@{
      operationId=[Guid]::NewGuid().ToString();action='Upgrade';stage='started'}}
    $failure=if($native){[IO.IOException]::new('PRIVATE_EXCEPTION_SENTINEL',
      [ComponentModel.Win32Exception]::new(1058,'PRIVATE_EXCEPTION_SENTINEL'))}
      else{[InvalidOperationException]::new('PRIVATE_EXCEPTION_SENTINEL')}
    Write-WorkerOperationDiagnostic -Receipt $receipt -Failure $failure
    $path=Join-Path (Join-Path $root 'installation-diagnostics') ('operation-'+$receipt.operation.operationId+'-error.json')
    $raw=[IO.File]::ReadAllText($path);$record=$raw|ConvertFrom-Json
    $before=[Zeb.WorkerInstall.Native]::Hash($path);$refused=$false
    try{Write-WorkerOperationDiagnostic -Receipt $receipt -Failure $failure}catch{$refused=$true}
    $rows+=,[pscustomobject]@{record=$record;privateTextPresent=$raw.Contains('PRIVATE_EXCEPTION_SENTINEL');
      collisionRefused=$refused;originalUnchanged=([Zeb.WorkerInstall.Native]::Hash($path) -ceq $before)}
  }
  return [pscustomobject]@{rows=$rows}
} $env:VOZEB_DIAGNOSTIC_ROOT
[Console]::Out.WriteLine(($value|ConvertTo-Json -Depth 6 -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_DIAGNOSTIC_ROOT: owner });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const value = json(result) as { rows: { record: Record<string, unknown>; privateTextPresent: boolean;
      collisionRefused: boolean; originalUnchanged: boolean }[] };
    expect(value.rows).toHaveLength(2);
    for (const [index, row] of value.rows.entries()) {
      expect(row.record).toMatchObject({ v: 1, kind: "worker_operation_diagnostic", action: "Upgrade", stage: "started",
        failureNativeErrorCode: index === 0 ? 1058 : null,
        failureType: index === 0 ? "System.ComponentModel.Win32Exception" : "System.InvalidOperationException" });
      expect(Object.keys(row.record).sort()).toEqual(["v", "kind", "operationId", "action", "stage", "failureType", "failureNativeErrorCode"].sort());
      expect(row.privateTextPresent).toBe(false);
      expect(row.collisionRefused && row.originalUnchanged).toBe(true);
    }
  }, 20_000);
});

describe.skipIf(process.platform !== "win32")("real installer SCM localized output", () => {
  it.each(["CreateDemand", "SetAutomatic", "SetImagePath", "Delete", "exit-error", "identity-mismatch"] as const)(
    "joins localized streams and validates %s", async (scenario) => {
      const result = await runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru
$value = & $module {
  $script:ScmOutputOriginalProcess = (Get-Command Invoke-WorkerFixedProcess).ScriptBlock
  function script:Invoke-WorkerFixedProcess {
    param([string]$ExecutablePath, [string[]]$Arguments, [DateTime]$Deadline, [switch]$DiscardOutput)
    if ([IO.Path]::GetFileName($ExecutablePath) -cne 'sc.exe') { throw 'fixture_unexpected_command' }
    $exit = if ($env:VOZEB_SCM_OUTPUT_SCENARIO -ceq 'exit-error') { 5 } else { 0 }
    return & $script:ScmOutputOriginalProcess -ExecutablePath $env:VOZEB_SCM_OUTPUT_NODE -Arguments @(
      '-e', ('process.stdout.write(Buffer.from([0xb3,0xc9,0xb9,0xa6]));process.stderr.write(Buffer.from([0xff]));process.exitCode=' + $exit)) -Deadline $Deadline -DiscardOutput:$DiscardOutput
  }
  function script:Get-WorkerServiceRow {
    if ($env:VOZEB_SCM_OUTPUT_SCENARIO -ceq 'Delete') { return $null }
    $startName = if ($env:VOZEB_SCM_OUTPUT_SCENARIO -ceq 'identity-mismatch') { 'LocalSystem' } else { 'NT SERVICE\\ZebImageEnhancement' }
    return [pscustomobject]@{ StartName=$startName; PathName='fixed-image'; StartMode='Auto' }
  }
  $action = if ($env:VOZEB_SCM_OUTPUT_SCENARIO -cin @('exit-error','identity-mismatch')) { 'CreateDemand' } else { $env:VOZEB_SCM_OUTPUT_SCENARIO }
  try {
    Invoke-WorkerScmChange -Action $action -ImagePath 'fixed-image' -Deadline ([DateTime]::UtcNow.AddSeconds(15))
    return @{ accepted=$true; error=$null }
  } catch { return @{ accepted=$false; error=$_.Exception.Message } }
}
[Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_SCM_OUTPUT_SCENARIO: scenario, VOZEB_SCM_OUTPUT_NODE: process.execPath });
      expect(result.code).toBe(0);
      const value = json(result);
      if (scenario === "exit-error") {
        expect(value).toEqual({ accepted: false, error: "worker_process_failed" });
      } else if (scenario === "identity-mismatch") {
        expect(value).toEqual({ accepted: false, error: "worker_scm_unknown" });
      } else {
        expect(value).toEqual({ accepted: true, error: null });
      }
    }, 25_000);
});

describe.skipIf(process.platform !== "win32")("real installer snapshot inheritance", () => {
  it("restores inherited child ACLs when the verification parent has different ACLs", async () => {
    const cache = join(workerDirectory, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    const owner = await mkdtemp(join(cache, "worker-inheritance-"));
    const result = await runPowerShell(`
$module = Import-Module -Name $env:VOZEB_INSTALLER_MODULE -Force -PassThru
$value = & $module {
  $lease = $null; $manifest = $null
  $response = @{ privilegesAvailable = $false; copied = $false; restored = $false;
    sourceInherited = $false; backupProtected = $false; sourceUnchanged = $false;
    error = $null; cleanupError = $false }
  $source = Join-Path $env:VOZEB_INHERITANCE_ROOT 'source'
  $backup = Join-Path $env:VOZEB_INHERITANCE_ROOT 'verification'
  try {
    $lease = Enter-WorkerInstallPrivileges -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    $response.privilegesAvailable = $true
    New-WorkerCallerDirectory $source
    $security = Get-WorkerCallerSecurity -Directory
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,
      [Security.AccessControl.FileSystemRights]::FullControl, 3, 0, 0))
    [IO.Directory]::SetAccessControl($source, $security)
    foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) {
      $directory = Join-Path $source $name
      $null = [IO.Directory]::CreateDirectory($directory)
      [IO.File]::WriteAllBytes((Join-Path $directory 'probe.bin'), [byte[]]@(0, 17, 255, 8))
    }
    $nested = Join-Path $source 'store\\nested'
    $null = [IO.Directory]::CreateDirectory($nested)
    [IO.File]::WriteAllBytes((Join-Path $nested 'result.bin'), [byte[]]@(1, 2, 3))
    foreach ($item in (Get-WorkerTree $source | Sort-Object { $_.path.Length } -Descending)) {
      [Zeb.WorkerInstall.Native]::RestoreMetadata($item.path, $item.info.SecuritySddl,
        '2021-01-02T03:04:05.0000000Z', '2021-02-03T04:05:06.0000000Z', $item.info.Attributes)
    }
    $manifest = Get-WorkerSnapshot $source
    $originalChild = [Security.AccessControl.RawSecurityDescriptor]::new(
      [Zeb.WorkerInstall.Native]::Inspect((Join-Path $nested 'result.bin')).SecuritySddl)
    $systemInherited = @($originalChild.DiscretionaryAcl | Where-Object {
      $_.SecurityIdentifier.Value -ceq $system.Value -and
      ([int]$_.AceFlags -band [int][Security.AccessControl.AceFlags]::Inherited) -ne 0
    }).Count -eq 1
    $response.sourceInherited = $systemInherited -and
      ([int]$originalChild.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0
    Copy-WorkerSnapshot -Source $source -Destination $backup -Manifest $manifest -Deadline ([DateTime]::UtcNow.AddSeconds(30))
    $response.copied = $true
    $protectedChild = [Security.AccessControl.RawSecurityDescriptor]::new(
      [Zeb.WorkerInstall.Native]::Inspect((Join-Path $backup 'store\\nested\\result.bin')).SecuritySddl)
    $response.backupProtected = ([int]$protectedChild.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0 -and
      @($protectedChild.DiscretionaryAcl | Where-Object { $_.SecurityIdentifier.Value -ceq $system.Value }).Count -eq 0
    Restore-WorkerSnapshotMetadata -Root $backup -Manifest $manifest
    $response.restored = $true
  } catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $response.error = if ($failure.Message.StartsWith('worker_')) { $failure.Message } else { $failure.GetType().FullName }
  } finally {
    if ($null -ne $manifest) {
      try { Assert-WorkerSnapshot -Root $source -Manifest $manifest -Security; $response.sourceUnchanged = $true }
      catch { $response.cleanupError = $true }
    }
    if ($null -ne $lease) { try { $lease.Dispose() } catch { $response.cleanupError = $true } }
  }
  return $response
}
[Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))
`, { VOZEB_INSTALLER_MODULE: modulePath, VOZEB_INHERITANCE_ROOT: owner });
    expect(result.code).toBe(0);
    const value = json(result);
    expect(value.privilegesAvailable, "requires real allocated backup/restore rights").toBe(true);
    expect(value.sourceInherited, `source child really inherits the additional SYSTEM ACE: ${JSON.stringify(value)}`).toBe(true);
    expect(value.copied && value.backupProtected, "verification starts with a different protected caller ACL").toBe(true);
    expect(value.sourceUnchanged && !value.cleanupError).toBe(true);
    expect(value.restored, `complete security/DAT/bytes restoration: ${value.error}`).toBe(true);
    expect(value.error).toBeNull();
  }, 60_000);
});
