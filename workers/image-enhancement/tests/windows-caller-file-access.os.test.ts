import { spawnSync } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
const modulePath = join(workerDirectory, "deployment", "windows", "Worker.Installation.psm1");
const windowsSuite = process.platform === "win32" ? describe : describe.skip;

windowsSuite("caller-only credential file access", () => {
  it("allows the caller and denies a real restricted token at the credential leaf with a readable sibling control", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeb-caller-file-access-"));
    try {
      const result = spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
        "-Command", String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$module = Import-Module -Name $env:ZEB_CALLER_ACCESS_MODULE -Force -PassThru -ErrorAction Stop
# A real restricted caller token is not a different Windows account, SCM identity or Session0.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class CallerFileAccessProbe {
  [StructLayout(LayoutKind.Sequential)] private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool CreateRestrictedToken(SafeAccessTokenHandle token, uint flags, uint disableCount, IntPtr disabled, uint privilegeCount, IntPtr privileges, uint restrictCount, [In] SidAndAttributes[] restrictions, out SafeAccessTokenHandle result);
  [DllImport("advapi32.dll")] private static extern bool IsTokenRestricted(SafeAccessTokenHandle token);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool ImpersonateLoggedOnUser(SafeAccessTokenHandle token);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool RevertToSelf();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool ReadFile(SafeFileHandle file, [Out] byte[] buffer, uint length, out uint read, IntPtr overlapped);
  private static int ReadByte(string path) {
    using (SafeFileHandle file = CreateFileW(path, 0x00000001, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (file.IsInvalid) return Marshal.GetLastWin32Error();
      uint read;
      if (!ReadFile(file, new byte[1], 1, out read, IntPtr.Zero)) return Marshal.GetLastWin32Error();
      if (read != 1) throw new InvalidOperationException("caller-file probe did not read one sentinel byte");
      return 0;
    }
  }
  public static int[] ReadPair(string control, string credential, string restrictingSid) {
    var sid = new SecurityIdentifier(restrictingSid);
    byte[] bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      SafeAccessTokenHandle token;
      if (!OpenProcessToken(new IntPtr(-1), 0x000e, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      using (token) {
        var restrictions = new SidAndAttributes[] { new SidAndAttributes { Sid = pinned.AddrOfPinnedObject(), Attributes = 0 } };
        SafeAccessTokenHandle restricted;
        if (!CreateRestrictedToken(token, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, restrictions, out restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
        using (restricted) {
          if (!IsTokenRestricted(restricted)) throw new InvalidOperationException("caller-file probe token is not restricted");
          if (!ImpersonateLoggedOnUser(restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
          try {
            return new int[] { ReadByte(control), ReadByte(credential) };
          } finally {
            if (!RevertToSelf()) Environment.FailFast("caller-file probe could not restore its own token");
          }
        }
      }
    } finally { pinned.Free(); }
  }
}
'@
$response = & $module {
  param([string]$root)
  Initialize-WorkerInstallNative
  $restrictedSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-12')
  # Only this newly created test directory gains traversal; no ancestor ACL is changed.
  $rootAcl = Get-WorkerCallerSecurity -Directory
  $rootAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $restrictedSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
    [System.Security.AccessControl.AccessControlType]::Allow))
  [System.IO.Directory]::SetAccessControl($root, $rootAcl)
  $credential = Join-Path $root 'credential-copy.bin'
  $control = Join-Path $root 'readable-copy.bin'
  $bytes = [System.Text.Encoding]::UTF8.GetBytes('public inert credential-copy sentinel')
  New-WorkerCallerFile -Path $credential -Bytes $bytes
  New-WorkerCallerFile -Path $control -Bytes $bytes
  $controlAcl = [System.IO.File]::GetAccessControl($control)
  $controlAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $restrictedSid, [System.Security.AccessControl.FileSystemRights]::ReadData,
    [System.Security.AccessControl.AccessControlType]::Allow))
  [System.IO.File]::SetAccessControl($control, $controlAcl)
  Assert-WorkerCallerFile -Path $credential
  $beforeAcl = [Zeb.WorkerInstall.Native]::Inspect($credential).SecuritySddl
  $beforeHash = [Zeb.WorkerInstall.Native]::Hash($credential)
  $controlHash = [Zeb.WorkerInstall.Native]::Hash($control)
  $callerRead = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($credential)) -ceq [Convert]::ToBase64String($bytes)
  $restrictedErrors = [CallerFileAccessProbe]::ReadPair($control, $credential, $restrictedSid.Value)
  Assert-WorkerCallerFile -Path $credential
  return @{
    callerReadAllowed = $callerRead
    restrictedControlReadError = $restrictedErrors[0]
    restrictedCredentialReadError = $restrictedErrors[1]
    credentialBytesPreserved = ([Zeb.WorkerInstall.Native]::Hash($credential) -ceq $beforeHash)
    credentialAclPreserved = ([Zeb.WorkerInstall.Native]::Inspect($credential).SecuritySddl -ceq $beforeAcl)
    controlBytesPreserved = ([Zeb.WorkerInstall.Native]::Hash($control) -ceq $controlHash)
    callerReadAllowedAfter = ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($credential)) -ceq [Convert]::ToBase64String($bytes))
  }
} $env:ZEB_CALLER_ACCESS_ROOT
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
`,
      ], {
        cwd: workerDirectory,
        env: { ...process.env, ZEB_CALLER_ACCESS_MODULE: modulePath, ZEB_CALLER_ACCESS_ROOT: root },
        encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
      });
      expect(result.error === undefined).toBe(true);
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr === "").toBe(true);
      let receipt: unknown;
      try { receipt = JSON.parse(result.stdout); }
      catch { throw new Error("caller-file access probe did not return JSON"); }
      expect(receipt).toEqual({
        callerReadAllowed: true,
        restrictedControlReadError: 0,
        restrictedCredentialReadError: 5,
        credentialBytesPreserved: true,
        credentialAclPreserved: true,
        controlBytesPreserved: true,
        callerReadAllowedAfter: true,
      });
    } finally {
      // Delete only the two known inert leaves, then their newly created empty directory.
      await rm(join(root, "readable-copy.bin"), { force: true });
      await rm(join(root, "credential-copy.bin"), { force: true });
      await rmdir(root);
    }
  }, 40_000);
});
