function Assert-WorkerPackagePath {
    param($RelativePath)

    if ($RelativePath -isnot [string] -or $RelativePath.Length -eq 0 -or
        $RelativePath -cmatch '[\\:\p{Cc}<>"|?*]') {
        throw 'worker_package_invalid'
    }
    foreach ($segment in $RelativePath.Split([char]'/')) {
        if ($segment.Length -eq 0 -or $segment -ceq '.' -or $segment -ceq '..' -or
            $segment -cmatch '[ .]\z') {
            throw 'worker_package_invalid'
        }
        $deviceName = $segment.Split([char]'.')[0].TrimEnd([char]' ')
        if ([System.Text.RegularExpressions.Regex]::IsMatch(
            $deviceName,
            '\A(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])\z',
            ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
             [System.Text.RegularExpressions.RegexOptions]::CultureInvariant))) {
            throw 'worker_package_invalid'
        }
    }
}

function Test-WorkerPackageInteger {
    param($Value)

    return (($Value -is [int] -or $Value -is [long] -or $Value -is [double]) -and
        $Value -ge 0 -and $Value -le 9007199254740991 -and
        [Math]::Floor([double]$Value) -eq [double]$Value)
}

function Test-WorkerPayloadCore {
    param($PayloadRoot, $ExpectedInventorySha256, $ExpectedConfigSha256)

    try {
        if ($PayloadRoot -isnot [string] -or
            $PayloadRoot -cnotmatch '\A[A-Za-z]:[\\/]' -or
            $ExpectedInventorySha256 -isnot [string] -or
            $ExpectedInventorySha256 -cnotmatch '\A[A-Fa-f0-9]{64}\z' -or
            $args.Count -ne 0) {
            throw 'worker_package_invalid'
        }
        $installed = $null -ne $ExpectedConfigSha256
        if ($installed -and ($ExpectedConfigSha256 -isnot [string] -or
            $ExpectedConfigSha256 -cnotmatch '\A[A-Fa-f0-9]{64}\z')) { throw 'worker_package_invalid' }
        $configSeen = $false
        $rootText = $PayloadRoot.TrimEnd([char[]]@('\', '/'))
        if ($rootText.Length -le 3) { throw 'worker_package_invalid' }
        Assert-WorkerPackagePath -RelativePath ($rootText.Substring(3).Replace('\', '/'))
        $root = [System.IO.Path]::GetFullPath($rootText)
        $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($root))
        if ($drive.DriveType -eq [System.IO.DriveType]::Network) {
            throw 'worker_package_invalid'
        }

        $ancestor = $root
        while ($null -ne $ancestor) {
            $attributes = [System.IO.File]::GetAttributes($ancestor)
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
                throw 'worker_package_invalid'
            }
            $parent = [System.IO.Directory]::GetParent($ancestor)
            $ancestor = if ($null -eq $parent) { $null } else { $parent.FullName }
        }

        $inventoryPath = [System.IO.Path]::Combine($root, 'package.inventory.json')
        $attributes = [System.IO.File]::GetAttributes($inventoryPath)
        if (($attributes -band ([System.IO.FileAttributes]::ReparsePoint -bor
                               [System.IO.FileAttributes]::Directory)) -ne 0) {
            throw 'worker_package_invalid'
        }
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $inventoryBytes = [System.IO.File]::ReadAllBytes($inventoryPath)
            $inventoryDigest = [BitConverter]::ToString($sha256.ComputeHash($inventoryBytes)).Replace('-', '')
            if (-not [string]::Equals($inventoryDigest, $ExpectedInventorySha256,
                                     [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'worker_package_invalid'
            }
            $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
            $inventoryText = $utf8.GetString($inventoryBytes)
            if ($inventoryText -cnotmatch '\A[\x20\t\r\n]*\{' -or
                $inventoryText -cnotmatch '\}[\x20\t\r\n]*\z') {
                throw 'worker_package_invalid'
            }
            $inventory = ConvertFrom-Json -InputObject $inventoryText -ErrorAction Stop
            if ($inventory -isnot [pscustomobject] -or
                @($inventory.PSObject.Properties).Count -ne 4) {
                throw 'worker_package_invalid'
            }
            foreach ($field in @('schemaVersion', 'version', 'storeSchemaVersion', 'files')) {
                $property = $inventory.PSObject.Properties[$field]
                if ($null -eq $property -or -not [string]::Equals(
                    $property.Name, $field, [System.StringComparison]::Ordinal)) {
                    throw 'worker_package_invalid'
                }
            }
            if (-not (Test-WorkerPackageInteger -Value $inventory.schemaVersion) -or
                $inventory.schemaVersion -ne 1 -or
                -not (Test-WorkerPackageInteger -Value $inventory.storeSchemaVersion) -or
                $inventory.storeSchemaVersion -ne 7 -or
                $inventory.version -isnot [string] -or
                $inventory.version -cnotmatch '\A[A-Za-z0-9.-]+\z' -or
                $inventory.files -isnot [array]) {
                throw 'worker_package_invalid'
            }

            $startupMarkerDeclared = $false; $startupMarkerSeen = $false
            $startupMarkerSha256 = [BitConverter]::ToString($sha256.ComputeHash(
                [System.Text.Encoding]::ASCII.GetBytes("ZEB_STARTUP_OBSERVATION_V1`n"))).Replace('-', '')
            $entries = [System.Collections.Generic.Dictionary[string, object]]::new(
                [System.StringComparer]::OrdinalIgnoreCase)
            foreach ($entry in $inventory.files) {
                if ($entry -isnot [pscustomobject] -or
                    @($entry.PSObject.Properties).Count -ne 3) {
                    throw 'worker_package_invalid'
                }
                foreach ($field in @('path', 'bytes', 'sha256')) {
                    $property = $entry.PSObject.Properties[$field]
                    if ($null -eq $property -or -not [string]::Equals(
                        $property.Name, $field, [System.StringComparison]::Ordinal)) {
                        throw 'worker_package_invalid'
                    }
                }
                Assert-WorkerPackagePath -RelativePath $entry.path
                if ([string]::Equals($entry.path, 'package.inventory.json',
                                     [System.StringComparison]::OrdinalIgnoreCase) -or
                    -not (Test-WorkerPackageInteger -Value $entry.bytes) -or
                    $entry.sha256 -isnot [string] -or
                    $entry.sha256 -cnotmatch '\A[A-Fa-f0-9]{64}\z' -or
                    $entries.ContainsKey($entry.path)) {
                    throw 'worker_package_invalid'
                }
                $entries.Add($entry.path, $entry)
                if ([string]::Equals($entry.path, 'startup-observation.v1', [System.StringComparison]::OrdinalIgnoreCase)) {
                    if ($entry.path -cne 'startup-observation.v1' -or $entry.bytes -ne 27 -or
                        -not [string]::Equals($entry.sha256, $startupMarkerSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
                        throw 'worker_package_invalid'
                    }
                    $startupMarkerDeclared = $true
                }
            }
            if ($entries.ContainsKey('app/worker.config.json')) { throw 'worker_package_invalid' }
            foreach ($required in @(
                'WindowsServiceHost.exe',
                'WindowsServiceHost.deps.json',
                'WindowsServiceHost.runtimeconfig.json',
                'runtime/node.exe',
                'runtime/LICENSE',
                'app/main.mjs',
                'app/manage.mjs',
                'app/package.json',
                'app/dist/bootstrap.js',
                'app/dist/contracts.js',
                'native/bridge/WindowsControlBridge.exe',
                'native/supervisor/WindowsSupervisor.exe'
            )) {
                if (-not $entries.ContainsKey($required)) {
                    throw 'worker_package_invalid'
                }
            }

            $seen = [System.Collections.Generic.HashSet[string]]::new(
                [System.StringComparer]::OrdinalIgnoreCase)
            $directories = [System.Collections.Generic.Stack[string]]::new()
            $directories.Push($root)
            while ($directories.Count -gt 0) {
                $directory = $directories.Pop()
                foreach ($path in [System.IO.Directory]::GetFileSystemEntries($directory)) {
                    $attributes = [System.IO.File]::GetAttributes($path)
                    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw 'worker_package_invalid'
                    }
                    $relative = $path.Substring($root.Length + 1).Replace('\', '/')
                    Assert-WorkerPackagePath -RelativePath $relative
                    if (-not $seen.Add($relative)) { throw 'worker_package_invalid' }
                    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
                    if ([string]::Equals($relative, 'startup-observation.v1', [System.StringComparison]::OrdinalIgnoreCase)) {
                        if ($relative -cne 'startup-observation.v1' -or $isDirectory -or -not $startupMarkerDeclared) {
                            throw 'worker_package_invalid'
                        }
                        $startupMarkerSeen = $true
                    }
                    if ([string]::Equals($relative, 'package.inventory.json',
                                         [System.StringComparison]::OrdinalIgnoreCase)) {
                        if ($isDirectory) { throw 'worker_package_invalid' }
                        continue
                    }
                    $policyPath = $relative.ToLowerInvariant()
                    if ($installed -and $relative -ceq 'app/worker.config.json' -and -not $isDirectory) {
                        $configStream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open,
                            [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                        try {
                            $configDigest = [BitConverter]::ToString($sha256.ComputeHash($configStream)).Replace('-', '')
                            if (-not [string]::Equals($configDigest, $ExpectedConfigSha256,
                                [System.StringComparison]::OrdinalIgnoreCase)) { throw 'worker_package_invalid' }
                        } finally { $configStream.Dispose() }
                        $configSeen = $true
                        continue
                    }
                    if ($policyPath -ceq 'app/worker.config.json' -or
                        $policyPath -cmatch '\A(?:app/)?(?:store|records)(?:/|\z)' -or
                        $policyPath -cmatch '\.(?:pfx|p12)\z' -or
                        $policyPath -cmatch '(?:\A|/)node_modules/\.bin(?:/|\z)' -or
                        $policyPath -cmatch '(?:\A|/)\.pnpm(?:/|\z)') {
                        throw 'worker_package_invalid'
                    }
                    if ($isDirectory) {
                        $directories.Push($path)
                        continue
                    }
                    if (-not $entries.ContainsKey($relative)) {
                        throw 'worker_package_invalid'
                    }
                    $entry = $entries[$relative]
                    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open,
                        [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                    try {
                        if ($stream.Length -ne [long]$entry.bytes) {
                            throw 'worker_package_invalid'
                        }
                        $digest = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
                        if (-not [string]::Equals($digest, $entry.sha256,
                                                 [System.StringComparison]::OrdinalIgnoreCase)) {
                            throw 'worker_package_invalid'
                        }
                    } finally {
                        $stream.Dispose()
                    }
                    $null = $entries.Remove($relative)
                }
            }
            if ($entries.Count -ne 0 -or ($installed -and -not $configSeen)) { throw 'worker_package_invalid' }
            if ($startupMarkerDeclared -ne $startupMarkerSeen) { throw 'worker_package_invalid' }
            return [pscustomobject]@{
                version = $inventory.version
                storeSchemaVersion = 7
                startupObservationV1 = ($startupMarkerDeclared -and $startupMarkerSeen)
            }
        } finally {
            $sha256.Dispose()
        }
    } catch {
        throw 'worker_package_invalid'
    }
}


function Test-WorkerPayload {
    param($PayloadRoot, $ExpectedInventorySha256)
    if ($args.Count -ne 0) { throw 'worker_package_invalid' }
    Test-WorkerPayloadCore -PayloadRoot $PayloadRoot -ExpectedInventorySha256 $ExpectedInventorySha256
}

function Test-WorkerInstalledPayload {
    param($PayloadRoot, $ExpectedInventorySha256, $ExpectedConfigSha256)
    if ($args.Count -ne 0 -or $null -eq $ExpectedConfigSha256) { throw 'worker_package_invalid' }
    Test-WorkerPayloadCore -PayloadRoot $PayloadRoot -ExpectedInventorySha256 $ExpectedInventorySha256 -ExpectedConfigSha256 $ExpectedConfigSha256
}

function Initialize-WorkerInstallNative {
    if ($null -ne ('Zeb.WorkerInstall.Native' -as [type])) { return }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WorkerInstall {
    [StructLayout(LayoutKind.Sequential)] public struct FileTime {
        public uint Low, High;
        public long Value { get { return unchecked((long)(((ulong)High << 32) | Low)); } }
        public static FileTime From(long value) { return new FileTime { Low = (uint)value, High = (uint)((ulong)value >> 32) }; }
    }
    [StructLayout(LayoutKind.Sequential)] public struct FileInfo {
        public uint Attributes; public FileTime Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] public struct BasicInfo {
        public long Creation, Access, Write, Change; public uint Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] public struct TokenPrivileges {
        public uint Count; public Luid Id; public uint Attributes;
    }
    public sealed class ObjectInfo {
        public string Path, Identity, SecuritySddl, CreationUtc, LastWriteUtc;
        public uint Attributes, Links; public long Bytes; public bool Directory;
    }
    public sealed class ProcessPin {
        public int pid, sessionId; public string creationFileTime, imagePath, tokenUserSid;
        public SafeProcessHandle handle;
        internal readonly SafeProcessHandle originalHandle;
        internal readonly string originalKernelImage;
        public ProcessPin() {}
        internal ProcessPin(SafeProcessHandle original, string kernelImage) {
            originalHandle=original; originalKernelImage=kernelImage;
        }
    }
    public sealed class StartupCallerPin : IDisposable {
        readonly object gate = new object();
        readonly ProcessPin pin;
        readonly SafeProcessHandle originalHandle;
        readonly FileStream image;
        readonly string imageSha256;
        bool disposed;
        Exception disposalFailure;
        internal StartupCallerPin(ProcessPin value, FileStream source, string hash) {
            pin = value; originalHandle = value.handle; image = source; imageSha256 = hash;
        }
        public ProcessPin Pin { get { return pin; } }
        public string ImageSha256 { get { return imageSha256; } }
        public void Dispose() {
            lock (gate) {
                if (!disposed) {
                    disposed = true;
                    try { image.Dispose(); } catch (Exception failure) { disposalFailure = failure; }
                    try { originalHandle.Dispose(); }
                    catch (Exception failure) { disposalFailure = disposalFailure == null ? failure : new AggregateException(disposalFailure, failure); }
                }
                if (disposalFailure != null) throw new InvalidOperationException("worker_startup_caller_cleanup_unknown", disposalFailure);
            }
        }
    }
    public sealed class PrivilegeLease : IDisposable {
        internal SafeFileHandle Token; internal List<TokenPrivileges> Previous = new List<TokenPrivileges>();
        public void Dispose() {
            if (Token == null) return;
            bool failed = false;
            try {
                for (int index = Previous.Count - 1; index >= 0; index--) {
                    TokenPrivileges state = Previous[index];
                    Native.ClearLastError(0);
                    if (!Native.AdjustTokenPrivileges(Token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero) ||
                        Marshal.GetLastWin32Error() != 0) failed = true;
                }
            } finally { Token.Dispose(); Token = null; }
            if (failed) throw new InvalidOperationException("worker_privilege_restore_unknown");
        }
    }
    // Closed startup protocol reader; parsing never establishes process or receipt authority.
    internal static class StartupJson {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private sealed class Number {
            internal readonly long Value;
            internal readonly bool Negative;
            internal Number(long value, bool negative) { Value = value; Negative = negative; }
        }
        private static InvalidDataException Invalid() { return new InvalidDataException("worker_startup_observation_invalid"); }
        private static Dictionary<string, object> ReadDocument(byte[] body, int maximum, int depth) {
            if (body == null || body.Length == 0 || body.Length > maximum) throw Invalid();
            string text;
            try { text = Utf8.GetString(body); } catch (DecoderFallbackException) { throw Invalid(); }
            return new Reader(text, depth).Document();
        }
        private sealed class Reader {
            private readonly string text;
            private readonly int maximumDepth;
            private int position;
            internal Reader(string source, int depth) { text = source; maximumDepth = depth; }
            private void Space() {
                while (position < text.Length && (text[position] == ' ' || text[position] == '\t' ||
                    text[position] == '\r' || text[position] == '\n')) position++;
            }
            private bool Take(char value) {
                if (position >= text.Length || text[position] != value) return false;
                position++; return true;
            }
            internal Dictionary<string, object> Document() {
                Space();
                if (position >= text.Length || text[position] != '{') throw Invalid();
                Dictionary<string, object> value = Object(1);
                Space(); if (position != text.Length) throw Invalid();
                return value;
            }
            private Dictionary<string, object> Object(int depth) {
                if (depth > maximumDepth || !Take('{')) throw Invalid();
                Dictionary<string, object> value = new Dictionary<string, object>(StringComparer.Ordinal);
                Space(); if (Take('}')) return value;
                while (true) {
                    Space(); string key = String(); Space();
                    if (!Take(':') || value.ContainsKey(key)) throw Invalid();
                    value.Add(key, Value(depth)); Space();
                    if (Take('}')) return value;
                    if (!Take(',')) throw Invalid();
                }
            }
            private object Value(int depth) {
                Space(); if (position >= text.Length) throw Invalid();
                char first = text[position];
                if (first == '{') return Object(depth + 1);
                if (first == '"') return String();
                if (first == '-' || (first >= '0' && first <= '9')) return Integer();
                if (Literal("true")) return true;
                if (Literal("false")) return false;
                if (Literal("null")) return null;
                throw Invalid();
            }
            private bool Literal(string expected) {
                if (text.Length - position < expected.Length ||
                    string.CompareOrdinal(text, position, expected, 0, expected.Length) != 0) return false;
                position += expected.Length; return true;
            }
            private Number Integer() {
                int start = position; bool negative = Take('-');
                if (position >= text.Length) throw Invalid();
                if (Take('0')) {
                    if (position < text.Length && text[position] >= '0' && text[position] <= '9') throw Invalid();
                } else {
                    if (text[position] < '1' || text[position] > '9') throw Invalid();
                    do { position++; } while (position < text.Length && text[position] >= '0' && text[position] <= '9');
                }
                long value;
                if (!long.TryParse(text.Substring(start, position - start), NumberStyles.AllowLeadingSign,
                    CultureInfo.InvariantCulture, out value)) throw Invalid();
                return new Number(value, negative);
            }
            private string String() {
                if (!Take('"')) throw Invalid();
                StringBuilder value = new StringBuilder();
                while (position < text.Length) {
                    char next = text[position++];
                    if (next == '"') {
                        string result = value.ToString();
                        for (int index = 0; index < result.Length; index++) {
                            if (char.IsHighSurrogate(result[index])) {
                                if (++index >= result.Length || !char.IsLowSurrogate(result[index])) throw Invalid();
                            } else if (char.IsLowSurrogate(result[index])) throw Invalid();
                        }
                        return result;
                    }
                    if (next < 0x20) throw Invalid();
                    if (next != '\\') { value.Append(next); continue; }
                    if (position >= text.Length) throw Invalid();
                    next = text[position++];
                    switch (next) {
                        case '"': case '\\': case '/': value.Append(next); break;
                        case 'b': value.Append('\b'); break;
                        case 'f': value.Append('\f'); break;
                        case 'n': value.Append('\n'); break;
                        case 'r': value.Append('\r'); break;
                        case 't': value.Append('\t'); break;
                        case 'u':
                            if (text.Length - position < 4) throw Invalid();
                            int scalar = 0;
                            for (int index = 0; index < 4; index++) {
                                char digit = text[position++];
                                int part = digit >= '0' && digit <= '9' ? digit - '0' :
                                    digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 :
                                    digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 : -1;
                                if (part < 0) throw Invalid();
                                scalar = scalar * 16 + part;
                            }
                            value.Append((char)scalar); break;
                        default: throw Invalid();
                    }
                }
                throw Invalid();
            }
        }
        private static Dictionary<string, object> Object(object value) {
            Dictionary<string, object> result = value as Dictionary<string, object>;
            if (result == null) throw Invalid(); return result;
        }
        private static void Keys(Dictionary<string, object> value, params string[] names) {
            if (value.Count != names.Length) throw Invalid();
            foreach (string name in names) if (!value.ContainsKey(name)) throw Invalid();
        }
        private static string Text(Dictionary<string, object> value, string key) {
            string result = value[key] as string;
            if (result == null) throw Invalid(); return result;
        }
        private static bool Boolean(Dictionary<string, object> value, string key) {
            if (!(value[key] is bool)) throw Invalid(); return (bool)value[key];
        }
        private static long Integer(Dictionary<string, object> value, string key, long minimum, long maximum) {
            Number number = value[key] as Number;
            if (number == null || number.Value < minimum || number.Value > maximum) throw Invalid();
            value[key] = number.Value; return number.Value;
        }
        private static uint Unsigned(Dictionary<string, object> value, string key) {
            Number number = value[key] as Number;
            if (number == null || number.Negative || number.Value < 0 || number.Value > uint.MaxValue) throw Invalid();
            uint result = (uint)number.Value; value[key] = result; return result;
        }
        private static string Hex(Dictionary<string, object> value, string key) {
            string result = Text(value, key);
            if (result.Length != 64) throw Invalid();
            foreach (char digit in result) if (!(digit >= '0' && digit <= '9') && !(digit >= 'a' && digit <= 'f')) throw Invalid();
            return result;
        }
        private static string Uuid(Dictionary<string, object> value, string key) {
            string result = Text(value, key); Guid parsed;
            if (!Guid.TryParseExact(result, "D", out parsed) || parsed == Guid.Empty || parsed.ToString("D") != result) throw Invalid();
            return result;
        }
        private static void Creation(Dictionary<string, object> value, string key) {
            string result = Text(value, key); ulong parsed;
            if (!ulong.TryParse(result, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) || parsed == 0 ||
                parsed.ToString(CultureInfo.InvariantCulture) != result) throw Invalid();
        }
        private static void Sid(Dictionary<string, object> value, string key) {
            string result = Text(value, key);
            try { if (new SecurityIdentifier(result).Value != result) throw Invalid(); }
            catch (ArgumentException) { throw Invalid(); }
        }
        private static void NullableText(Dictionary<string, object> value, string key) {
            if (value[key] != null) Text(value, key);
        }
        private static void Identity(object value) {
            Dictionary<string, object> identity = Object(value);
            Keys(identity, "pid", "creationFileTime");
            Integer(identity, "pid", 1, int.MaxValue); Creation(identity, "creationFileTime");
        }
        internal static IDictionary<string, object> ReadContext(byte[] raw) {
            Dictionary<string, object> value = ReadDocument(raw, 4096, 6);
            Keys(value, "v", "operationId", "startupAttemptId", "startingReceiptSha256", "pipeName", "nonce", "cutoffTick64",
                "caller", "expectedServiceSid", "inventorySha256", "configSha256", "engineManifestSha256", "hostSha256", "nodeSha256");
            Integer(value, "v", 1, 1); Uuid(value, "operationId"); string attempt = Uuid(value, "startupAttemptId");
            if (Text(value, "pipeName") != "zeb-worker-startup-v1-" + attempt.Replace("-", "")) throw Invalid();
            foreach (string key in new string[] { "startingReceiptSha256", "nonce", "inventorySha256", "configSha256",
                "engineManifestSha256", "hostSha256", "nodeSha256" }) Hex(value, key);
            Integer(value, "cutoffTick64", long.MinValue, long.MaxValue); Sid(value, "expectedServiceSid");
            Dictionary<string, object> caller = Object(value["caller"]);
            Keys(caller, "pid", "creationFileTime", "imagePath", "imageSha256", "tokenUserSid", "sessionId");
            Integer(caller, "pid", 1, int.MaxValue); Creation(caller, "creationFileTime");
            Hex(caller, "imageSha256"); Sid(caller, "tokenUserSid"); Integer(caller, "sessionId", 0, uint.MaxValue);
            string image = Text(caller, "imagePath");
            if (image.Length < 3 || !((image[0] >= 'A' && image[0] <= 'Z') || (image[0] >= 'a' && image[0] <= 'z')) ||
                image[1] != ':' || (image[2] != '\\' && image[2] != '/') || image.IndexOf('\0') >= 0) throw Invalid();
            try { caller["imagePath"] = Path.GetFullPath(image); }
            catch (ArgumentException) { throw Invalid(); }
            catch (NotSupportedException) { throw Invalid(); }
            catch (PathTooLongException) { throw Invalid(); }
            return value;
        }
        internal static IDictionary<string, object> ReadFrame(byte[] body, string expectedKind) {
            int maximum, sequence;
            switch (expectedKind) {
                case "prepared": maximum = 8192; sequence = 1; break;
                case "ack_prepared": maximum = 1024; sequence = 2; break;
                case "authorized": maximum = 1024; sequence = 3; break;
                case "ready": case "settled": maximum = 8192; sequence = 4; break;
                default: throw Invalid();
            }
            Dictionary<string, object> value = ReadDocument(body, maximum, 8);
            if (expectedKind == "prepared") Keys(value, "v", "kind", "seq", "nonce", "operationId", "startupAttemptId",
                "startingReceiptSha256", "host", "node", "jobName", "inventorySha256", "configSha256",
                "engineManifestSha256", "hostSha256", "nodeSha256", "inspection");
            else if (expectedKind == "ack_prepared") Keys(value, "v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node");
            else if (expectedKind == "authorized") Keys(value, "v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node", "authorized");
            else if (expectedKind == "ready") Keys(value, "v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node", "phase");
            else {
                List<string> fields = new List<string>(new string[] { "v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node", "phase",
                    "jobName", "sealed", "ownerReleasedTreeActive", "forceCalls", "failureType", "cleanup" });
                if (value.ContainsKey("cleanupFailureCount") || value.ContainsKey("ownerReleaseCompleted")) {
                    fields.Add("cleanupFailureCount"); fields.Add("ownerReleaseCompleted");
                }
                Keys(value, fields.ToArray());
            }
            Integer(value, "v", 1, 1); Integer(value, "seq", sequence, sequence);
            if (Text(value, "kind") != expectedKind) throw Invalid();
            Hex(value, "nonce"); Uuid(value, "operationId"); Uuid(value, "startupAttemptId");
            Identity(value["host"]); Identity(value["node"]);
            if (expectedKind == "prepared") {
                Text(value, "jobName");
                foreach (string key in new string[] { "startingReceiptSha256", "inventorySha256", "configSha256", "engineManifestSha256", "hostSha256", "nodeSha256" }) Hex(value, key);
                Dictionary<string, object> inspection = Object(value["inspection"]);
                Keys(inspection, "processSignaled", "inOriginalJob", "activeProcesses", "totalProcesses", "jobHandleFlags", "processHandleFlags", "authorized", "sealed");
                foreach (string key in new string[] { "processSignaled", "inOriginalJob", "authorized", "sealed" }) Boolean(inspection, key);
                foreach (string key in new string[] { "activeProcesses", "totalProcesses", "jobHandleFlags", "processHandleFlags" }) Unsigned(inspection, key);
            } else {
                Hex(value, "preparedSha256");
                if (expectedKind == "authorized" && !Boolean(value, "authorized")) throw Invalid();
                if (expectedKind == "ready" || expectedKind == "settled") Phase(value, expectedKind);
                if (expectedKind == "settled") Settlement(value);
            }
            return value;
        }
        private static void Phase(Dictionary<string, object> frame, string kind) {
            Dictionary<string, object> value = Object(frame["phase"]);
            Keys(value, "v", "kind", "attempt", "nonce", "phase", "runnerConstructed", "listenerSucceeded", "recoveryCalled", "claimEntered", "prepareEntered", "authorizeEntered");
            Integer(value, "v", 1, 1);
            if (Text(value, "kind") != "startup_phase" || Uuid(value, "attempt") != Text(frame, "startupAttemptId") ||
                Hex(value, "nonce") != Text(frame, "nonce")) throw Invalid();
            string phase = Text(value, "phase");
            if (kind == "ready" ? phase != "listening" : phase != "listener_bind_failed" && phase != "store_schema_incompatible") throw Invalid();
            if (Boolean(value, "runnerConstructed") != (phase != "store_schema_incompatible") ||
                Boolean(value, "listenerSucceeded") != (phase == "listening")) throw Invalid();
            foreach (string key in new string[] { "recoveryCalled", "claimEntered", "prepareEntered", "authorizeEntered" }) if (Boolean(value, key)) throw Invalid();
        }
        private static void Settlement(Dictionary<string, object> value) {
            NullableText(value, "jobName"); NullableText(value, "failureType");
            if (value["sealed"] != null) Boolean(value, "sealed");
            if (value["ownerReleasedTreeActive"] != null) Unsigned(value, "ownerReleasedTreeActive");
            Integer(value, "forceCalls", 0, int.MaxValue);
            if (value.ContainsKey("cleanupFailureCount")) {
                Integer(value, "cleanupFailureCount", 0, int.MaxValue); Boolean(value, "ownerReleaseCompleted");
            }
            Dictionary<string, object> cleanup = Object(value["cleanup"]);
            Keys(cleanup, "rootExit", "treeExit", "stdout", "stderr");
            if (cleanup["rootExit"] != null) {
                Dictionary<string, object> root = Object(cleanup["rootExit"]);
                Keys(root, "identity", "exitCode"); Identity(root["identity"]); Unsigned(root, "exitCode");
            }
            if (cleanup["treeExit"] != null) {
                Dictionary<string, object> tree = Object(cleanup["treeExit"]);
                Keys(tree, "engineExitCode", "activeProcesses"); Unsigned(tree, "engineExitCode"); Unsigned(tree, "activeProcesses");
            }
            foreach (string key in new string[] { "stdout", "stderr" }) {
                Dictionary<string, object> stream = Object(cleanup[key]);
                Keys(stream, "bytesRead", "eof", "readFailureType", "sinkFailureType");
                Integer(stream, "bytesRead", 0, long.MaxValue); Boolean(stream, "eof");
                NullableText(stream, "readFailureType"); NullableText(stream, "sinkFailureType");
            }
        }
    }
    public sealed class StartupPipe : IDisposable {
        const int CallerAccess = 0x001f019f, ServiceAccess = 0x0012019b;
        readonly object gate = new object();
        readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        readonly NamedPipeServerStream stream;
        readonly long cutoff;
        readonly string name;
        readonly Task acceptTask;
        Task pendingTask;
        bool busy, disposed, acceptUsed, accepted, ackUsed, eofUsed;
        int clientProcessId;
        Exception disposalFailure;

        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
            public int Length; public IntPtr Descriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }
        [DllImport("kernel32.dll", EntryPoint="CreateNamedPipeW", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafePipeHandle CreateNamedPipe(string path, uint mode, uint pipeMode, uint instances,
            uint output, uint input, uint timeout, ref SecurityAttributes security);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetNamedPipeInfo(SafePipeHandle pipe, out uint flags, out uint output, out uint input, out uint maximum);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("advapi32.dll")]
        static extern uint GetSecurityInfo(SafePipeHandle pipe, int kind, uint fields,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);

        internal StartupPipe(string attempt, long firstCutoffTick64, SecurityIdentifier caller, SecurityIdentifier service) {
            Guid parsed;
            if (attempt == null || !Guid.TryParseExact(attempt, "D", out parsed) ||
                !String.Equals(parsed.ToString("D"), attempt, StringComparison.Ordinal) ||
                attempt[14] < '1' || attempt[14] > '8' || "89ab".IndexOf(attempt[19]) < 0 ||
                caller == null || service == null || caller.Equals(service))
                throw new InvalidDataException("worker_startup_pipe_input_invalid");
            cutoff = firstCutoffTick64;
            name = "zeb-worker-startup-v1-" + attempt.Replace("-", "");
            try {
                Remaining();
                stream = CreateStream(name, caller, service);
                Remaining();
                acceptTask = stream.WaitForConnectionAsync(cancellation.Token);
                Remaining();
            } catch (Exception failure) { CloseAfterFailure(failure); throw; }
        }
        public string PipeName { get { return name; } }
        public int ClientProcessId { get { return clientProcessId; } }

        static NamedPipeServerStream CreateStream(string leaf, SecurityIdentifier caller, SecurityIdentifier service) {
            RawAcl acl = new RawAcl(GenericAcl.AclRevision, 2);
            acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, CallerAccess, caller, false, null));
            acl.InsertAce(1, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, ServiceAccess, service, false, null));
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(ControlFlags.SelfRelative |
                ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected, caller, null, null, acl);
            byte[] binary = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(binary, 0);
            GCHandle pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
            SafePipeHandle handle;
            try {
                SecurityAttributes security = new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)),
                    Descriptor=pinned.AddrOfPinnedObject(), Inherit=false };
                handle = CreateNamedPipe(@"\\.\pipe\" + leaf, 0x40080003u, 0x00000008u, 1, 0, 0, 0, ref security);
            } finally { pinned.Free(); }
            try {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                VerifyPipe(handle, caller, service);
                return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
            } catch { handle.Dispose(); throw; }
        }
        static void VerifyPipe(SafePipeHandle handle, SecurityIdentifier caller, SecurityIdentifier service) {
            uint inheritance, flags, output, input, maximum;
            if (!GetHandleInformation(handle, out inheritance) ||
                !GetNamedPipeInfo(handle, out flags, out output, out input, out maximum))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((inheritance & 1) != 0 || (flags & 1) == 0 || (flags & 4) != 0 || maximum != 1)
                throw new InvalidDataException("worker_startup_pipe_security_invalid");
            IntPtr owner, group, dacl, sacl, descriptor;
            uint error = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error);
            try {
                uint length = GetSecurityDescriptorLength(descriptor);
                if (length == 0 || length > 65536) throw new InvalidDataException("worker_startup_pipe_security_invalid");
                byte[] binary = new byte[(int)length]; Marshal.Copy(descriptor, binary, 0, binary.Length);
                RawSecurityDescriptor actual = new RawSecurityDescriptor(binary, 0);
                ControlFlags required = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected;
                if (actual.Owner == null || !caller.Equals(actual.Owner) || (actual.ControlFlags & required) != required ||
                    actual.DiscretionaryAcl == null || actual.DiscretionaryAcl.Count != 2)
                    throw new InvalidDataException("worker_startup_pipe_security_invalid");
                bool foundCaller = false, foundService = false;
                foreach (GenericAce raw in actual.DiscretionaryAcl) {
                    CommonAce ace = raw as CommonAce;
                    if (ace == null || ace.AceFlags != AceFlags.None || ace.AceQualifier != AceQualifier.AccessAllowed || ace.IsCallback)
                        throw new InvalidDataException("worker_startup_pipe_security_invalid");
                    if (!foundCaller && caller.Equals(ace.SecurityIdentifier) && ace.AccessMask == CallerAccess) foundCaller = true;
                    else if (!foundService && service.Equals(ace.SecurityIdentifier) && ace.AccessMask == ServiceAccess) foundService = true;
                    else throw new InvalidDataException("worker_startup_pipe_security_invalid");
                }
                if (!foundCaller || !foundService) throw new InvalidDataException("worker_startup_pipe_security_invalid");
            } finally { LocalFree(descriptor); }
        }
        int Remaining() {
            long now = Native.TickCount64();
            if (cutoff <= now) throw new TimeoutException("worker_startup_pipe_timeout");
            long remaining = cutoff - now;
            if (remaining > Int32.MaxValue) throw new InvalidDataException("worker_startup_window_invalid");
            return (int)remaining;
        }
        void Enter(bool requireAccepted) {
            try {
                lock (gate) {
                    if (disposed || busy || (requireAccepted && !accepted))
                        throw new InvalidOperationException("worker_startup_pipe_state_invalid");
                    Remaining(); busy = true;
                }
            } catch (TimeoutException failure) { CloseAfterFailure(failure); throw; }
        }
        void Leave() { lock (gate) { busy = false; } }
        void Wait(Task task) {
            while (!task.IsCompleted) {
                int remaining = Remaining();
                try { task.Wait(remaining); } catch (AggregateException) { }
            }
            Remaining(); task.GetAwaiter().GetResult(); Remaining();
        }
        void CloseAfterFailure(Exception original) {
            try { Dispose(); }
            catch (Exception cleanup) { throw new AggregateException("worker_startup_pipe_cleanup_unknown", original, cleanup); }
        }
        void ReadExactly(byte[] raw, int offset, int count) {
            int end = checked(offset + count);
            while (offset < end) {
                Task<int> read;
                lock (gate) {
                    if (disposed) throw new ObjectDisposedException("StartupPipe");
                    Remaining(); pendingTask = read = stream.ReadAsync(raw, offset, end-offset, cancellation.Token);
                }
                Wait(read);
                int received = read.GetAwaiter().GetResult();
                if (received == 0) throw new EndOfStreamException("worker_startup_frame_truncated");
                offset += received;
            }
        }
        static uint BodyLength(byte[] raw) {
            return (uint)raw[0] | ((uint)raw[1] << 8) | ((uint)raw[2] << 16) | ((uint)raw[3] << 24);
        }
        public void Accept() {
            Enter(false);
            try {
                if (acceptUsed) throw new InvalidOperationException("worker_startup_accept_already_used");
                acceptUsed = true; Wait(acceptTask);
                uint pid;
                if (!GetNamedPipeClientProcessId(stream.SafePipeHandle, out pid))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (pid == 0 || pid > Int32.MaxValue) throw new InvalidDataException("worker_startup_peer_invalid");
                Remaining(); clientProcessId = (int)pid; accepted = true;
            } catch (Exception failure) { CloseAfterFailure(failure); throw; }
            finally { Leave(); }
        }
        public byte[] ReadFrame(int maximum) {
            Enter(true);
            try {
                if (eofUsed || maximum < 1 || maximum > 8192) throw new InvalidDataException("worker_startup_frame_bound_invalid");
                byte[] header = new byte[4]; ReadExactly(header, 0, 4);
                uint length = BodyLength(header);
                if (length == 0 || length > (uint)maximum) throw new InvalidDataException("worker_startup_frame_bound_invalid");
                byte[] wire = new byte[4+(int)length]; Buffer.BlockCopy(header, 0, wire, 0, 4);
                ReadExactly(wire, 4, (int)length);
                new UTF8Encoding(false, true).GetCharCount(wire, 4, (int)length);
                Remaining(); return wire;
            } catch (Exception failure) { CloseAfterFailure(failure); throw; }
            finally { Leave(); }
        }
        public void WriteAck(byte[] rawWire) {
            Enter(true);
            try {
                if (ackUsed || eofUsed) throw new InvalidOperationException("worker_startup_ack_already_used");
                ackUsed = true;
                if (rawWire == null || rawWire.Length < 5 || rawWire.Length > 1028)
                    throw new InvalidDataException("worker_startup_ack_bound_invalid");
                byte[] wire = (byte[])rawWire.Clone();
                uint length = BodyLength(wire);
                if (length == 0 || length > 1024 || length != wire.Length-4)
                    throw new InvalidDataException("worker_startup_ack_bound_invalid");
                new UTF8Encoding(false, true).GetCharCount(wire, 4, (int)length);
                Task write;
                lock (gate) {
                    if (disposed) throw new ObjectDisposedException("StartupPipe");
                    Remaining(); pendingTask = write = stream.WriteAsync(wire, 0, wire.Length, cancellation.Token);
                }
                Wait(write);
            } catch (Exception failure) { CloseAfterFailure(failure); throw; }
            finally { Leave(); }
        }
        public void RequireEof() {
            Enter(true);
            try {
                if (eofUsed) throw new InvalidOperationException("worker_startup_eof_already_used");
                eofUsed = true;
                byte[] tail = new byte[1]; Task<int> read;
                lock (gate) {
                    if (disposed) throw new ObjectDisposedException("StartupPipe");
                    Remaining(); pendingTask = read = stream.ReadAsync(tail, 0, 1, cancellation.Token);
                }
                Wait(read);
                if (read.GetAwaiter().GetResult() != 0) throw new InvalidDataException("worker_startup_frame_trailing_bytes");
                Remaining();
            } catch (Exception failure) { CloseAfterFailure(failure); throw; }
            finally { Leave(); }
        }
        static void Join(Task task) {
            if (task == null) return;
            try { task.GetAwaiter().GetResult(); } catch (Exception) { }
        }
        public void Dispose() {
            lock (gate) {
                if (!disposed) {
                    disposed = true;
                    try { cancellation.Cancel(); } catch (Exception failure) { disposalFailure = failure; }
                    try { if (stream != null) stream.Dispose(); }
                    catch (Exception failure) { if (disposalFailure == null) disposalFailure = failure; }
                    // Closing cancels the same native I/O; joining grants no renewed business window.
                    Join(acceptTask); Join(pendingTask);
                    try { cancellation.Dispose(); }
                    catch (Exception failure) { if (disposalFailure == null) disposalFailure = failure; }
                }
                if (disposalFailure != null) throw new InvalidOperationException("worker_startup_pipe_cleanup_unknown", disposalFailure);
            }
        }
    }
    public static class Native {
        public static IDictionary<string, object> ReadStartupContext(byte[] raw) {
            return StartupJson.ReadContext(raw);
        }
        public static IDictionary<string, object> ReadStartupFrame(byte[] body, string expectedKind) {
            return StartupJson.ReadFrame(body, expectedKind);
        }
        const uint Backup = 0x02000000, OpenReparse = 0x00200000;
        [DllImport("kernel32.dll", EntryPoint="GetTickCount64")] static extern ulong ReadTickCount64();
        public static long TickCount64() { return checked((long)ReadTickCount64()); }
        public static StartupPipe NewStartupPipe(string canonicalAttemptId, long firstCutoffTick64) {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
                if (identity.User == null || identity.ImpersonationLevel != TokenImpersonationLevel.None)
                    throw new InvalidOperationException("worker_startup_caller_identity_invalid");
                SecurityIdentifier service = (SecurityIdentifier)new NTAccount("NT SERVICE", "ZebImageEnhancement")
                    .Translate(typeof(SecurityIdentifier));
                return new StartupPipe(canonicalAttemptId, firstCutoffTick64, identity.User, service);
            }
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr buffer, uint size);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref BasicInfo info, uint size);
        [DllImport("kernel32.dll", EntryPoint="SetFileInformationByHandle", SetLastError=true)]
        static extern bool SetDisposition(SafeFileHandle file, int kind, ref int disposition, uint size);
        [DllImport("kernel32.dll", EntryPoint="SetFileInformationByHandle", SetLastError=true)]
        static extern bool SetRename(SafeFileHandle file, int kind, IntPtr rename, uint size);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool SetFileTime(SafeFileHandle file, ref FileTime creation, IntPtr access, ref FileTime write);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint fields, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint fields, out IntPtr text, out uint length);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool SetKernelObjectSecurity(SafeFileHandle file, uint fields, byte[] descriptor);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern uint SetSecurityInfo(SafeFileHandle file, int kind, uint fields, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool GetSecurityDescriptorOwner(IntPtr descriptor, out IntPtr owner, out bool defaulted);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool GetSecurityDescriptorGroup(IntPtr descriptor, out IntPtr group, out bool defaulted);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
        [DllImport("kernel32.dll", SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(SafeProcessHandle process);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetProcessTimes(SafeProcessHandle process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref uint length);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeFileHandle token);
        [DllImport("advapi32.dll", EntryPoint="OpenProcessToken", SetLastError=true)]
        static extern bool OpenCurrentToken(IntPtr process, uint access, out SafeFileHandle token);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool GetTokenInformation(SafeFileHandle token, int kind, IntPtr value, uint size, out uint required);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
        [DllImport("advapi32.dll", SetLastError=true)]
        internal static extern bool AdjustTokenPrivileges(SafeFileHandle token, bool disableAll, ref TokenPrivileges state, uint size, IntPtr previous, IntPtr required);
        [DllImport("kernel32.dll", EntryPoint="SetLastError")] internal static extern void ClearLastError(uint value);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr OpenSCManager(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr OpenService(IntPtr manager, string name, uint access);
        [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
        static void Failure() { throw new Win32Exception(Marshal.GetLastWin32Error()); }
        public static SafeFileHandle OpenObject(string path, uint access, uint share) {
            SafeFileHandle handle = CreateFile(path, access, share, IntPtr.Zero, 3, Backup | OpenReparse, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); Failure(); }
            try { InspectHandle(handle, path, false); return handle; }
            catch { handle.Dispose(); throw; }
        }
        static ObjectInfo InspectHandle(SafeFileHandle handle, string path, bool security) {
            FileInfo info;
            if (!GetFileInformationByHandle(handle, out info)) Failure();
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) == 0 && info.Links != 1))
                throw new InvalidDataException("worker_path_invalid");
            StringBuilder final = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity) Failure();
            string resolved = final.ToString();
            if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) resolved = resolved.Substring(4);
            if (!String.Equals(resolved.TrimEnd('\\'), Path.GetFullPath(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("worker_path_invalid");
            return new ObjectInfo { Path=resolved, Identity=info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8"),
                Directory=(info.Attributes & 0x10)!=0, Attributes=info.Attributes, Links=info.Links,
                Bytes=unchecked((long)(((ulong)info.SizeHigh<<32)|info.SizeLow)),
                CreationUtc=DateTime.FromFileTimeUtc(info.Creation.Value).ToString("o"),
                LastWriteUtc=DateTime.FromFileTimeUtc(info.Write.Value).ToString("o"),
                SecuritySddl=security ? Security(handle) : null };
        }
        static string Security(SafeFileHandle handle) {
            IntPtr owner, group, dacl, sacl, descriptor, text;
            uint result = GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor);
            if (result != 0) throw new Win32Exception((int)result);
            try {
                uint length;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 7, out text, out length)) Failure();
                try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
            } finally { LocalFree(descriptor); }
        }
        public static ObjectInfo Inspect(string path) {
            using (SafeFileHandle handle = OpenObject(path, 0x00020080, 7)) return InspectHandle(handle, path, true);
        }
        public static string[] Children(string path) {
            using (SafeFileHandle handle = OpenObject(path, 0x00000081, 7)) {
                if (!InspectHandle(handle, path, false).Directory) throw new InvalidDataException("worker_path_invalid");
                IntPtr buffer = Marshal.AllocHGlobal(65536);
                try {
                    List<string> names = new List<string>(); bool first = true;
                    while (true) {
                        if (!GetFileInformationByHandleEx(handle, first ? 15 : 14, buffer, 65536)) {
                            if (Marshal.GetLastWin32Error() == 18) break;
                            Failure();
                        }
                        first = false; int offset = 0;
                        while (true) {
                            int next = Marshal.ReadInt32(buffer, offset);
                            int bytes = Marshal.ReadInt32(buffer, offset + 60);
                            if (bytes < 0 || (bytes & 1) != 0 || offset + 68 + bytes > 65536)
                                throw new InvalidDataException("worker_path_invalid");
                            string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 68), bytes / 2);
                            if (name != "." && name != "..") names.Add(name);
                            if (next == 0) break;
                            if (next < 68 || offset + next >= 65536) throw new InvalidDataException("worker_path_invalid");
                            offset += next;
                        }
                    }
                    return names.ToArray();
                } finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        public static byte[] ReadBytes(string path) {
            using (SafeFileHandle handle = OpenObject(path, 0x80000080, 1))
            using (FileStream stream = new FileStream(handle, FileAccess.Read))
            using (MemoryStream bytes = new MemoryStream()) {
                if (InspectHandle(handle, path, false).Directory) throw new InvalidDataException("worker_path_invalid");
                stream.CopyTo(bytes); return bytes.ToArray();
            }
        }
        public static string Hash(string path) {
            using (SafeFileHandle handle = OpenObject(path, 0x80000080, 1))
            using (FileStream stream = new FileStream(handle, FileAccess.Read))
            using (SHA256 hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
        public static void RestoreMetadata(string path, string sddl, string creationUtc, string writeUtc, uint attributes) {
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(sddl);
            // Windows consumes the request bit to preserve the captured auto-inherited state.
            if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0)
                descriptor.SetFlags(descriptor.ControlFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
            byte[] binary = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(binary, 0);
            // Security inheritance processing also reads the existing descriptor.
            using (SafeFileHandle handle = OpenObject(path, 0x000E0180, 7)) {
                uint fields = 7 | ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? 0x80000000u : 0x20000000u);
                IntPtr raw = Marshal.AllocHGlobal(binary.Length);
                try {
                    Marshal.Copy(binary, 0, raw, binary.Length);
                    IntPtr owner=IntPtr.Zero, group=IntPtr.Zero, dacl=IntPtr.Zero; bool defaulted=false, present=false;
                    if (!GetSecurityDescriptorOwner(raw, out owner, out defaulted) ||
                        !GetSecurityDescriptorGroup(raw, out group, out defaulted) ||
                        !GetSecurityDescriptorDacl(raw, out present, out dacl, out defaulted) || !present) Failure();
                    uint result = SetSecurityInfo(handle, 1, fields, owner, group, dacl, IntPtr.Zero);
                    if (result != 0) throw new Win32Exception((int)result);
                    if (!SetKernelObjectSecurity(handle, 7, binary)) Failure();
                } finally { Marshal.FreeHGlobal(raw); }
                FileTime creation = FileTime.From(DateTime.Parse(creationUtc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToFileTimeUtc());
                FileTime write = FileTime.From(DateTime.Parse(writeUtc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToFileTimeUtc());
                if (!SetFileTime(handle, ref creation, IntPtr.Zero, ref write)) Failure();
                BasicInfo basic = new BasicInfo { Attributes=attributes };
                if (!SetFileInformationByHandle(handle, 0, ref basic, (uint)Marshal.SizeOf(typeof(BasicInfo)))) Failure();
            }
        }
        public static void DeleteObject(string path) {
            using (SafeFileHandle handle = OpenObject(path, 0x00010180, 0)) {
                BasicInfo basic = new BasicInfo { Attributes=0x80 };
                if (!SetFileInformationByHandle(handle, 0, ref basic, (uint)Marshal.SizeOf(typeof(BasicInfo)))) Failure();
                int remove = 1;
                if (!SetDisposition(handle, 4, ref remove, 4)) Failure();
            }
        }
        public static void MoveObject(string source, string destination) {
            byte[] name = Encoding.Unicode.GetBytes(Path.GetFullPath(destination));
            int rootOffset = IntPtr.Size == 8 ? 8 : 4, lengthOffset = rootOffset + IntPtr.Size, nameOffset = lengthOffset + 4;
            // Win32 resolves the absolute name as a terminated string, despite FileNameLength.
            int size = nameOffset + name.Length + sizeof(char);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                Marshal.Copy(new byte[size], 0, buffer, size);
                Marshal.WriteInt32(buffer, lengthOffset, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
                using (SafeFileHandle handle = OpenObject(source, 0x00010080, 0))
                    if (!SetRename(handle, 3, buffer, (uint)size)) Failure();
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        static IntPtr TokenInfo(SafeFileHandle token, int kind) {
            uint required; GetTokenInformation(token, kind, IntPtr.Zero, 0, out required);
            if (required == 0) Failure();
            IntPtr bytes = Marshal.AllocHGlobal((int)required);
            if (!GetTokenInformation(token, kind, bytes, required, out required)) { Marshal.FreeHGlobal(bytes); Failure(); }
            return bytes;
        }
        public static ProcessPin Pin(int pid, string expected) {
            SafeProcessHandle handle = OpenProcess(0x00101000, false, pid);
            if (handle.IsInvalid) { handle.Dispose(); Failure(); }
            try {
                FileTime creation, exit, kernel, user;
                if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) Failure();
                uint length = 32768; StringBuilder image = new StringBuilder((int)length);
                if (!QueryFullProcessImageName(handle, 0, image, ref length)) Failure();
                if (!String.Equals(image.ToString(), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("worker_identity_unknown");
                SafeFileHandle token;
                if (!OpenProcessToken(handle, 8, out token)) Failure();
                using (token) {
                    IntPtr identity = TokenInfo(token, 1), session = IntPtr.Zero;
                    try {
                        string sid = new SecurityIdentifier(Marshal.ReadIntPtr(identity)).Value;
                        session = TokenInfo(token, 12);
                        if (WaitForSingleObject(handle, 0) != 258) throw new InvalidDataException("worker_identity_unknown");
                        return new ProcessPin(handle, image.ToString()) { pid=pid, creationFileTime=creation.Value.ToString(CultureInfo.InvariantCulture),
                            imagePath=image.ToString(), tokenUserSid=sid, sessionId=Marshal.ReadInt32(session), handle=handle };
                    } finally { Marshal.FreeHGlobal(identity); if (session != IntPtr.Zero) Marshal.FreeHGlobal(session); }
                }
            } catch { handle.Dispose(); throw; }
        }
        public static void RequireStartupPin(ProcessPin pin) {
            if (pin == null || pin.handle == null || pin.handle.IsClosed || pin.handle.IsInvalid || pin.pid <= 0)
                throw new InvalidDataException("worker_identity_unknown");
            SafeProcessHandle handle = pin.handle;
            uint flags;
            if (!GetHandleInformation(handle, out flags)) Failure();
            if ((flags & 1) != 0 || Wait(handle, 0)) throw new InvalidDataException("worker_identity_unknown");
            uint pid = GetProcessId(handle);
            if (pid == 0) Failure();
            FileTime creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) Failure();
            uint length = 32768; StringBuilder image = new StringBuilder((int)length);
            if (!QueryFullProcessImageName(handle, 0, image, ref length)) Failure();
            if (pid != (uint)pin.pid || creation.Value.ToString(CultureInfo.InvariantCulture) != pin.creationFileTime ||
                !String.Equals(image.ToString(), pin.imagePath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("worker_identity_unknown");
            SafeFileHandle token;
            if (!OpenProcessToken(handle, 8, out token)) Failure();
            using (token) {
                IntPtr identity = TokenInfo(token, 1), session = IntPtr.Zero;
                try {
                    string sid = new SecurityIdentifier(Marshal.ReadIntPtr(identity)).Value;
                    session = TokenInfo(token, 12);
                    if (sid != pin.tokenUserSid || Marshal.ReadInt32(session) != pin.sessionId)
                        throw new InvalidDataException("worker_identity_unknown");
                } finally { Marshal.FreeHGlobal(identity); if (session != IntPtr.Zero) Marshal.FreeHGlobal(session); }
            }
            if (!Object.ReferenceEquals(pin.handle, handle) || Wait(handle, 0))
                throw new InvalidDataException("worker_identity_unknown");
        }
        public static uint ReadStartupExitCode(ProcessPin pin) {
            if (pin == null) throw new InvalidDataException("worker_identity_unknown");
            SafeProcessHandle handle = pin.handle;
            if (handle == null || handle.IsClosed || handle.IsInvalid || pin.pid <= 0 ||
                !Object.ReferenceEquals(handle, pin.originalHandle) || String.IsNullOrEmpty(pin.originalKernelImage) ||
                !String.Equals(pin.imagePath, pin.originalKernelImage, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("worker_identity_unknown");
            uint flags;
            if (!GetHandleInformation(handle, out flags)) Failure();
            if ((flags & 1) != 0 || !Wait(handle, 0)) throw new InvalidDataException("worker_identity_unknown");
            uint pid = GetProcessId(handle);
            if (pid == 0) Failure();
            FileTime creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) Failure();
            if (pid != (uint)pin.pid || creation.Value.ToString(CultureInfo.InvariantCulture) != pin.creationFileTime)
                throw new InvalidDataException("worker_identity_unknown");
            uint code;
            if (!GetExitCodeProcess(handle, out code)) Failure();
            if (!Wait(handle, 0) || !Object.ReferenceEquals(pin.handle, handle))
                throw new InvalidDataException("worker_identity_unknown");
            return code;
        }
        public static StartupCallerPin PinStartupCaller() {
            ProcessPin pin = null; FileStream image = null;
            try {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
                    if (identity.User == null || identity.ImpersonationLevel != TokenImpersonationLevel.None)
                        throw new InvalidOperationException("worker_startup_caller_identity_invalid");
                }
                using (System.Diagnostics.Process current = System.Diagnostics.Process.GetCurrentProcess())
                    pin = Pin(current.Id, current.MainModule.FileName);
                RequireStartupPin(pin);
                // System caller images may have valid hardlinks; owned-payload Hash remains unchanged.
                image = new FileStream(pin.imagePath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.SequentialScan);
                uint flags;
                if (!GetHandleInformation(image.SafeFileHandle, out flags)) Failure();
                if ((flags & 1) != 0) throw new InvalidDataException("worker_identity_unknown");
                string hash;
                using (SHA256 sha = SHA256.Create())
                    hash = BitConverter.ToString(sha.ComputeHash(image)).Replace("-", "").ToLowerInvariant();
                RequireStartupPin(pin);
                return new StartupCallerPin(pin, image, hash);
            } catch (Exception original) {
                List<Exception> failures = new List<Exception>(); failures.Add(original);
                try { if (image != null) image.Dispose(); } catch (Exception cleanup) { failures.Add(cleanup); }
                try { if (pin != null && pin.handle != null) pin.handle.Dispose(); } catch (Exception cleanup) { failures.Add(cleanup); }
                if (failures.Count > 1) throw new AggregateException("worker_startup_caller_cleanup_unknown", failures);
                throw;
            }
        }
        public static bool Wait(SafeProcessHandle handle, uint milliseconds) {
            uint result = WaitForSingleObject(handle, milliseconds);
            if (result == 0) return true; if (result == 258) return false; Failure(); return false;
        }
        static uint PrivilegeState(SafeFileHandle token, Luid id) {
            IntPtr info = TokenInfo(token, 3);
            try {
                int count = Marshal.ReadInt32(info);
                for (int index=0; index<count; index++) {
                    int offset=4+index*12;
                    if (unchecked((uint)Marshal.ReadInt32(info, offset)) == id.Low && Marshal.ReadInt32(info, offset+4) == id.High)
                        return unchecked((uint)Marshal.ReadInt32(info, offset+8));
                }
                throw new InvalidOperationException("worker_permission_denied");
            } finally { Marshal.FreeHGlobal(info); }
        }
        public static PrivilegeLease Privileges() {
            IntPtr manager=OpenSCManager(null, null, 3);
            if (manager == IntPtr.Zero) Failure();
            try {
                IntPtr service=OpenService(manager, "ZebImageEnhancement", 0x00010037);
                if (service == IntPtr.Zero) { if (Marshal.GetLastWin32Error()!=1060) Failure(); }
                else CloseServiceHandle(service);
            } finally { CloseServiceHandle(manager); }
            SafeFileHandle token;
            if (!OpenCurrentToken(GetCurrentProcess(), 0x28, out token)) Failure();
            PrivilegeLease lease=new PrivilegeLease { Token=token };
            try {
                foreach (string name in new string[] { "SeBackupPrivilege", "SeRestorePrivilege" }) {
                    Luid id; if (!LookupPrivilegeValue(null, name, out id)) Failure();
                    uint previous=PrivilegeState(token, id);
                    TokenPrivileges enabled=new TokenPrivileges { Count=1, Id=id, Attributes=previous | 2 };
                    lease.Previous.Add(new TokenPrivileges { Count=1, Id=id, Attributes=previous });
                    ClearLastError(0);
                    if (!AdjustTokenPrivileges(token, false, ref enabled, 0, IntPtr.Zero, IntPtr.Zero) ||
                        Marshal.GetLastWin32Error()!=0 || (PrivilegeState(token, id)&2)==0) Failure();
                }
                return lease;
            } catch { lease.Dispose(); throw; }
        }
    }
}
'@ -ErrorAction Stop
}

function ConvertTo-WorkerTimeoutSeconds {
    param($Value)
    $text = if ($Value -is [string]) { $Value }
        elseif ($Value -is [int] -or $Value -is [long]) { $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
        else { throw 'worker_timeout_invalid' }
    $seconds = 0
    if ($text -cnotmatch '\A[0-9]+\z' -or
        -not [int]::TryParse($text, [System.Globalization.NumberStyles]::None,
            [System.Globalization.CultureInfo]::InvariantCulture, [ref]$seconds) -or
        $seconds -lt 1 -or $seconds -gt [Math]::Floor([int]::MaxValue / 1000)) { throw 'worker_timeout_invalid' }
    return $seconds
}

function Test-WorkerJsonVersionOne {
    param($Value)
    return (($Value -is [int] -or $Value -is [long]) -and $Value -eq 1)
}

function Get-WorkerRemainingMilliseconds {
    param([DateTime]$Deadline)
    $remaining = [Math]::Ceiling(($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remaining -le 0 -or $remaining -gt [int]::MaxValue) { throw 'worker_timeout_unknown' }
    return [int]$remaining
}

function Assert-WorkerObject {
    param($Value, [string[]]$Keys)
    if ($Value -isnot [pscustomobject] -or @($Value.PSObject.Properties).Count -ne $Keys.Count) { throw 'worker_input_invalid' }
    foreach ($key in $Keys) {
        $property = $Value.PSObject.Properties[$key]
        if ($null -eq $property -or $property.Name -cne $key) { throw 'worker_input_invalid' }
    }
}

function Assert-WorkerUuid {
    param($Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z') { throw 'worker_input_invalid' }
}

function Assert-WorkerHash {
    param($Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '\A[a-fA-F0-9]{64}\z') { throw 'worker_input_invalid' }
}

function Get-WorkerBytesHash {
    param([byte[]]$Bytes)
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Read-WorkerJson {
    param([string]$Path)
    Initialize-WorkerInstallNative
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $text = $utf8.GetString([Zeb.WorkerInstall.Native]::ReadBytes($Path))
    if ($text -cnotmatch '\A[\x20\t\r\n]*\{' -or $text -cnotmatch '\}[\x20\t\r\n]*\z') { throw 'worker_input_invalid' }
    return ConvertFrom-Json -InputObject $text -ErrorAction Stop
}

function Resolve-WorkerLocalPath {
    param($Path, [switch]$AllowMissing)
    if ($Path -isnot [string] -or $Path -cnotmatch '\A[A-Za-z]:[\\/]' -or $Path.Length -le 3) { throw 'worker_path_invalid' }
    $text = $Path.Replace('/', '\').TrimEnd([char]'\')
    Assert-WorkerPackagePath -RelativePath $text.Substring(3).Replace('\', '/')
    $full = [System.IO.Path]::GetFullPath($text)
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -cne 'NTFS') { throw 'worker_path_invalid' }
    Initialize-WorkerInstallNative
    $cursor = $full
    $missing = $false
    while ($cursor.Length -gt 0) {
        try { $info = [Zeb.WorkerInstall.Native]::Inspect($cursor) }
        catch {
            $failure = $_.Exception
            while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
            if (-not $AllowMissing -or $failure -isnot [System.ComponentModel.Win32Exception] -or $failure.NativeErrorCode -notin @(2, 3)) { throw 'worker_path_invalid' }
            $missing = $true
            $info = $null
        }
        if ($null -ne $info -and $cursor -cne $full -and -not $info.Directory) { throw 'worker_path_invalid' }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    if ($missing -and -not $AllowMissing) { throw 'worker_path_invalid' }
    return $full
}

function Test-WorkerSamePath {
    param([string]$Left, [string]$Right)
    return [string]::Equals($Left.TrimEnd([char]'\'), $Right.TrimEnd([char]'\'), [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-WorkerSeparatePaths {
    param([string[]]$Paths)
    for ($left = 0; $left -lt $Paths.Count; $left++) {
        for ($right = $left + 1; $right -lt $Paths.Count; $right++) {
            $a = $Paths[$left].TrimEnd([char]'\'); $b = $Paths[$right].TrimEnd([char]'\')
            if ((Test-WorkerSamePath $a $b) -or $a.StartsWith($b + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
                $b.StartsWith($a + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'worker_path_invalid' }
        }
    }
}

function Get-WorkerVersionRoot {
    param([string]$ProgramRoot, [string]$Version)
    if ($Version -cnotmatch '\A[A-Za-z0-9.-]+\z') { throw 'worker_package_invalid' }
    Assert-WorkerPackagePath -RelativePath $Version
    $versionRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($ProgramRoot, $Version))
    if (-not (Test-WorkerSamePath ([System.IO.Path]::GetDirectoryName($versionRoot)) $ProgramRoot) -or
        [System.IO.Path]::GetFileName($versionRoot) -cne $Version) { throw 'worker_package_invalid' }
    return $versionRoot
}

function Get-WorkerCallerSecurity {
    param([switch]$Directory)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = if ($Directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $inherit = if ($Directory) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
        [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
    return $security
}

function New-WorkerCallerDirectory {
    param([string]$Path)
    $null = Resolve-WorkerLocalPath -Path $Path -AllowMissing
    if ([System.IO.Directory]::Exists($Path)) {
        if ([Zeb.WorkerInstall.Native]::Children($Path).Count -ne 0) { throw 'worker_directory_not_empty' }
        [System.IO.Directory]::SetAccessControl($Path, (Get-WorkerCallerSecurity -Directory))
    } else {
        $null = [System.IO.Directory]::CreateDirectory($Path, (Get-WorkerCallerSecurity -Directory))
    }
}

function Assert-WorkerCallerFile {
    param([string]$Path)
    $null = Resolve-WorkerLocalPath -Path $Path
    $info = [Zeb.WorkerInstall.Native]::Inspect($Path)
    if ($info.Directory) { throw 'worker_ownership_invalid' }
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $security.SetSecurityDescriptorSddlForm($info.SecuritySddl)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $sid -or
        -not $security.AreAccessRulesProtected -or $rules.Count -ne 1 -or
        $rules[0].IdentityReference.Value -cne $sid -or [int]$rules[0].FileSystemRights -ne 0x001f01ff -or
        $rules[0].IsInherited -or [int]$rules[0].InheritanceFlags -ne 0 -or [int]$rules[0].PropagationFlags -ne 0 -or
        $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'worker_ownership_invalid' }
}

function New-WorkerCallerFile {
    param([string]$Path, [byte[]]$Bytes)
    $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::CreateNew,
        [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None,
        4096, [System.IO.FileOptions]::WriteThrough, (Get-WorkerCallerSecurity))
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    Assert-WorkerCallerFile -Path $Path
}

function Write-WorkerLedger {
    param([string]$Path, $Value)
    $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes(($Value | ConvertTo-Json -Depth 64 -Compress) + [char]10)
    if (-not [System.IO.File]::Exists($Path)) { New-WorkerCallerFile -Path $Path -Bytes $bytes; return }
    Assert-WorkerCallerFile -Path $Path
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    New-WorkerCallerFile -Path $temporary -Bytes $bytes
    [System.IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value)
    Assert-WorkerCallerFile -Path $Path
}

function Open-WorkerInstallLock {
    param([string]$Path, [string]$OperationId, [switch]$Existing)
    if ([System.IO.File]::Exists($Path)) {
        if (-not $Existing) { throw 'worker_operation_locked' }
        Assert-WorkerCallerFile -Path $Path
        return [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    }
    $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::CreateNew,
        [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None,
        4096, [System.IO.FileOptions]::WriteThrough, (Get-WorkerCallerSecurity))
    try {
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($OperationId + [char]10)
        $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
        return $stream
    } catch { $stream.Dispose(); throw }
}

function Get-WorkerTree {
    param([string]$Root)
    $null = Resolve-WorkerLocalPath -Path $Root
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $items = [System.Collections.Generic.List[object]]::new()
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $path = $pending.Pop()
        $info = [Zeb.WorkerInstall.Native]::Inspect($path)
        if (-not $seen.Add($info.Identity)) { throw 'worker_path_invalid' }
        $items.Add([pscustomobject]@{ path = $path; info = $info })
        if ($info.Directory) {
            foreach ($name in [Zeb.WorkerInstall.Native]::Children($path)) {
                Assert-WorkerPackagePath -RelativePath $name
                $pending.Push([System.IO.Path]::Combine($path, $name))
            }
        }
    }
    return $items.ToArray()
}

function Copy-WorkerFile {
    param([string]$Source, [string]$Destination)
    # PS5 reads high-bit hexadecimal literals as negative Int32 values.
    $sourceHandle = [Zeb.WorkerInstall.Native]::OpenObject($Source, [uint32]2147483776, 1)
    $inputStream = $null; $outputStream = $null
    try {
        $inputStream = [System.IO.FileStream]::new($sourceHandle, [System.IO.FileAccess]::Read)
        $outputStream = [System.IO.FileStream]::new($Destination, [System.IO.FileMode]::CreateNew,
            [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None,
            4096, [System.IO.FileOptions]::WriteThrough, (Get-WorkerCallerSecurity))
        $inputStream.CopyTo($outputStream); $outputStream.Flush($true)
    } finally {
        if ($null -ne $outputStream) { $outputStream.Dispose() }
        if ($null -ne $inputStream) { $inputStream.Dispose() } else { $sourceHandle.Dispose() }
    }
}

function Copy-WorkerPayload {
    param([string]$Source, [string]$Destination, [string]$InventorySha256)
    New-WorkerCallerDirectory -Path $Destination
    foreach ($item in (Get-WorkerTree -Root $Source | Sort-Object { $_.path.Length })) {
        if (Test-WorkerSamePath $item.path $Source) { continue }
        $target = [System.IO.Path]::Combine($Destination, $item.path.Substring($Source.Length + 1))
        if ($item.info.Directory) { $null = [System.IO.Directory]::CreateDirectory($target, (Get-WorkerCallerSecurity -Directory)) }
        else { Copy-WorkerFile -Source $item.path -Destination $target }
    }
    $null = Test-WorkerPayload -PayloadRoot $Destination -ExpectedInventorySha256 $InventorySha256
}

function Remove-WorkerOwnedTree {
    param([string]$Root)
    foreach ($item in (Get-WorkerTree -Root $Root | Sort-Object { $_.path.Length } -Descending)) {
        [Zeb.WorkerInstall.Native]::DeleteObject($item.path)
    }
}

function Enter-WorkerInstallPrivileges {
    param([DateTime]$Deadline)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    try {
        Initialize-WorkerInstallNative
        if ([System.Security.Principal.WindowsIdentity]::GetCurrent().ImpersonationLevel -ne [System.Security.Principal.TokenImpersonationLevel]::None) {
            throw 'worker_permission_denied'
        }
        return [Zeb.WorkerInstall.Native]::Privileges()
    } catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        if ($failure.Message -ceq 'worker_privilege_restore_unknown') { throw 'worker_privilege_restore_unknown' }
        throw 'worker_permission_denied'
    }
}

function Open-WorkerProcessIdentity {
    param([int]$ProcessId, [string]$ExpectedImagePath)
    try {
        Initialize-WorkerInstallNative
        return [Zeb.WorkerInstall.Native]::Pin($ProcessId, $ExpectedImagePath)
    } catch { throw 'worker_identity_unknown' }
}

function Open-WorkerExclusiveObject {
    param([string]$LiteralPath, [DateTime]$Deadline)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    try {
        $path = Resolve-WorkerLocalPath -Path $LiteralPath
        return [Zeb.WorkerInstall.Native]::OpenObject($path, [uint32]3221291008, 0)
    } catch { throw 'worker_exclusion_unknown' }
}

function ConvertTo-WorkerProcessArgument {
    param([string]$Value)
    if ($null -eq $Value -or $Value.IndexOf([char]0) -ge 0) { throw 'worker_input_invalid' }
    $quoted = [System.Text.RegularExpressions.Regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $quoted = [System.Text.RegularExpressions.Regex]::Replace($quoted, '(\\+)\z', '$1$1')
    return '"' + $quoted + '"'
}

function Invoke-WorkerFixedProcess {
    param([string]$ExecutablePath, [string[]]$Arguments, [DateTime]$Deadline, [switch]$DiscardOutput)
    $process = [System.Diagnostics.Process]::new()
    $started = $false; $known = $false
    try {
        $info = [System.Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $ExecutablePath
        $info.Arguments = (@($Arguments | ForEach-Object { ConvertTo-WorkerProcessArgument $_ }) -join ' ')
        $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
        $info.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false, $true)
        $info.EnvironmentVariables.Remove('NODE_OPTIONS')
        $info.EnvironmentVariables.Remove('NODE_PATH')
        $process.StartInfo = $info
        $null = Get-WorkerRemainingMilliseconds $Deadline
        $started = $process.Start()
        if (-not $started) { throw 'worker_process_unknown' }
        $process.StandardInput.Close()
        if ($DiscardOutput) {
            # Localized status bytes are unused; acceptance requires exit and independent state verification.
            $stdout = $process.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
            $stderr = $process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
        } else {
            $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        }
        if (-not $process.WaitForExit((Get-WorkerRemainingMilliseconds $Deadline)) -or
            -not $stdout.Wait((Get-WorkerRemainingMilliseconds $Deadline)) -or
            -not $stderr.Wait((Get-WorkerRemainingMilliseconds $Deadline))) { throw 'worker_process_unknown' }
        if ($DiscardOutput) {
            $null = $stdout.GetAwaiter().GetResult(); $null = $stderr.GetAwaiter().GetResult()
            $outputText = ''; $errorText = ''
        } else {
            $outputText = $stdout.GetAwaiter().GetResult(); $errorText = $stderr.GetAwaiter().GetResult()
        }
        $value = [pscustomobject]@{ outcome='known'; exited=$true; exitCode=$process.ExitCode;
            stdout=$outputText; stderr=$errorText; stdoutComplete=$true; stderrComplete=$true }
        $known = $true
        return $value
    } catch {
        if ($started) {
            $script:WorkerUnresolvedProcess = $process
            $script:WorkerUnresolvedProcessIdentity = [pscustomobject]@{ pid=$process.Id;
                creationFileTime=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); imagePath=$ExecutablePath }
        }
        return [pscustomobject]@{ outcome='unknown'; exited=$false; exitCode=$null; stdout=''; stderr=''; stdoutComplete=$false; stderrComplete=$false }
    } finally { if (-not $started -or $known) { $process.Dispose() } }
}

function Invoke-WorkerNodeProcess {
    param([string]$ExecutablePath, [string[]]$Arguments, [DateTime]$Deadline)
    return Invoke-WorkerFixedProcess -ExecutablePath $ExecutablePath -Arguments $Arguments -Deadline $Deadline
}

function Invoke-WorkerRobocopy {
    param([string]$Source, [string]$Destination, [string[]]$Arguments, [DateTime]$Deadline)
    $expected = @('/E', '/B', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:0', '/W:0')
    if (($Arguments -join [char]0) -cne ($expected -join [char]0)) { throw 'worker_input_invalid' }
    return Invoke-WorkerFixedProcess -ExecutablePath ([System.IO.Path]::Combine([System.Environment]::SystemDirectory, 'robocopy.exe')) -Arguments (@($Source, $Destination) + $expected) -Deadline $Deadline -DiscardOutput
}

function Assert-WorkerProcessResult {
    param($Value, [int]$MaximumExit = 0, [switch]$AllowStderr)
    if ($null -eq $Value -or $Value.outcome -cne 'known' -or $Value.exited -ne $true -or
        $Value.stdoutComplete -ne $true -or $Value.stderrComplete -ne $true) { throw 'worker_process_unknown' }
    if ($Value.exitCode -isnot [int] -or $Value.exitCode -lt 0 -or $Value.exitCode -gt $MaximumExit -or
        (-not $AllowStderr -and $Value.stderr -cne '')) { throw 'worker_process_failed' }
}

function Get-WorkerServiceRow {
    $rows = @(Get-CimInstance -ClassName Win32_Service -Filter "Name='ZebImageEnhancement'" -ErrorAction Stop)
    if ($rows.Count -gt 1) { throw 'worker_identity_unknown' }
    if ($rows.Count -eq 0) { return $null }
    return $rows[0]
}

function Assert-WorkerLiveGeneration {
    param($Generation, [DateTime]$Deadline)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    if ($null -eq $Generation.host.handle -or $null -eq $Generation.node.handle -or
        [Zeb.WorkerInstall.Native]::Wait($Generation.host.handle, 0) -or
        [Zeb.WorkerInstall.Native]::Wait($Generation.node.handle, 0)) { throw 'worker_identity_unknown' }
    $row = Get-WorkerServiceRow
    if ($null -eq $row -or $row.ProcessId -ne $Generation.host.pid -or
        $row.PathName -cne $Generation.imagePath -or $row.StartName -cne 'NT SERVICE\ZebImageEnhancement' -or
        $row.State -cne 'Running') { throw 'worker_identity_unknown' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalAddress $Generation.endpoint.host -LocalPort $Generation.endpoint.port -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $Generation.node.pid) { throw 'worker_identity_unknown' }
}

function Get-WorkerTransport {
    param($Configuration)
    if ($Configuration -isnot [pscustomobject]) { throw 'worker_configuration_invalid' }
    $hasTls = $null -ne $Configuration.PSObject.Properties['tls']
    $hasHost = $null -ne $Configuration.PSObject.Properties['host']
    if ($hasTls -eq $hasHost) { throw 'worker_configuration_invalid' }
    if ($hasTls -and $Configuration.tls -isnot [pscustomobject]) { throw 'worker_configuration_invalid' }
    $hostAddress = if ($hasTls) { $Configuration.tls.host } else { $Configuration.host }
    $address = $null
    if ($hostAddress -isnot [string] -or -not [System.Net.IPAddress]::TryParse($hostAddress, [ref]$address) -or
        $address.Equals([System.Net.IPAddress]::Any) -or $address.Equals([System.Net.IPAddress]::IPv6Any)) { throw 'worker_configuration_invalid' }
    return [pscustomobject]@{ scheme=$(if ($hasTls) { 'https' } else { 'http' }); host=$hostAddress }
}

function Invoke-WorkerMaintenanceHttp {
    param([string]$Method, $Generation, [string]$Bearer, [DateTime]$Deadline)
    if ($Method -cnotin @('GET', 'POST') -or $Bearer -cnotmatch '\A[A-Za-z0-9_-]{43}\z') { throw 'worker_input_invalid' }
    Assert-WorkerLiveGeneration -Generation $Generation -Deadline $Deadline
    if ($Generation.endpoint.scheme -cnotin @('http', 'https')) { throw 'worker_identity_unknown' }
    $builder = [System.UriBuilder]::new($Generation.endpoint.scheme, $Generation.endpoint.host, [int]$Generation.endpoint.port, '/v1/maintenance')
    $request = [System.Net.HttpWebRequest]::CreateHttp($builder.Uri)
    $response = $null; $reader = $null
    try {
        $request.Method = $Method; $request.AllowAutoRedirect = $false; $request.Proxy = $null
        $request.Timeout = Get-WorkerRemainingMilliseconds $Deadline
        $request.ReadWriteTimeout = Get-WorkerRemainingMilliseconds $Deadline
        $request.Headers['Authorization'] = 'Bearer ' + $Bearer
        if ($Method -ceq 'POST') { $request.ContentLength = 0 }
        $pending = $request.GetResponseAsync()
        if (-not $pending.Wait((Get-WorkerRemainingMilliseconds $Deadline))) { throw 'worker_http_unknown' }
        $response = $pending.GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) { throw 'worker_http_unknown' }
        $reader = [System.IO.StreamReader]::new($response.GetResponseStream(), [System.Text.UTF8Encoding]::new($false, $true))
        $body = $reader.ReadToEndAsync()
        if (-not $body.Wait((Get-WorkerRemainingMilliseconds $Deadline))) { throw 'worker_http_unknown' }
        $value = ConvertFrom-Json -InputObject ($body.GetAwaiter().GetResult()) -ErrorAction Stop
        if ($value -isnot [pscustomobject] -or $value.code -isnot [string] -or $value.code -cne 'ok' -or $value.data -isnot [pscustomobject]) { throw 'worker_http_unknown' }
        $value = $value.data
        Assert-WorkerUuid $value.bootId
        if ($null -ne $Generation.bootId -and $Generation.bootId -cne $value.bootId) { throw 'worker_identity_unknown' }
        Assert-WorkerLiveGeneration -Generation $Generation -Deadline $Deadline
        return $value
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $request.Abort()
    }
}

function Get-WorkerServiceGeneration {
    param($Receipt, [DateTime]$Deadline, [switch]$WaitForReady)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    $hostPin = $null; $nodePin = $null
    try {
        $row = Get-WorkerServiceRow
        if ($null -eq $row) { return [pscustomobject]@{ exists=$false; candidateSid=$null } }
        if ($null -eq $Receipt -or $row.PathName -cne $Receipt.active.imagePath -or
            $row.StartName -cne 'NT SERVICE\ZebImageEnhancement') { throw 'worker_identity_unknown' }
        $candidate = [System.Security.Principal.NTAccount]::new('NT SERVICE\ZebImageEnhancement').Translate([System.Security.Principal.SecurityIdentifier]).Value
        $generation = [pscustomobject]@{ exists=$true; serviceName='ZebImageEnhancement';
            accountName='NT SERVICE\ZebImageEnhancement'; imagePath=$row.PathName; status=$row.State;
            candidateSid=$candidate; tokenUserSid=$null; sessionId=$null; bootId=$null; host=$null; node=$null; endpoint=$null }
        $generation | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
            if ($null -ne $this.host) { $this.host.handle.Dispose() }
            if ($null -ne $this.node) { $this.node.handle.Dispose() }
        }
        if ($row.State -ceq 'Stopped' -and [int]$row.ProcessId -eq 0) { return $generation }
        if ($row.State -cne 'Running' -or [int]$row.ProcessId -le 0) { throw 'worker_identity_unknown' }
        $versionRoot = Get-WorkerVersionRoot -ProgramRoot $Receipt.programRoot -Version $Receipt.active.version
        $hostPin = Open-WorkerProcessIdentity -ProcessId $row.ProcessId -ExpectedImagePath ([System.IO.Path]::Combine($versionRoot, 'WindowsServiceHost.exe'))
        $null = Test-WorkerInstalledPayload -PayloadRoot $versionRoot -ExpectedInventorySha256 $Receipt.active.inventorySha256 -ExpectedConfigSha256 $Receipt.configSha256
        $afterPackage = Get-WorkerServiceRow
        if ([Zeb.WorkerInstall.Native]::Wait($hostPin.handle, 0) -or $null -eq $afterPackage -or
            $afterPackage.ProcessId -ne $hostPin.pid -or $afterPackage.State -cne 'Running' -or
            $afterPackage.PathName -cne $generation.imagePath -or $afterPackage.StartName -cne 'NT SERVICE\ZebImageEnhancement') { throw 'worker_identity_unknown' }
        if ($hostPin.tokenUserSid -cne $candidate -or $hostPin.sessionId -ne 0 -or
            ($null -ne $Receipt.tokenUserSid -and $Receipt.tokenUserSid -cne $candidate)) { throw 'worker_identity_unknown' }
        Assert-WorkerNativeAcl -Receipt $Receipt -Sid $candidate
        $config = Read-WorkerJson ([System.IO.Path]::Combine($Receipt.dataRoot, 'config', 'worker.config.json'))
        $transport = Get-WorkerTransport $config
        $address = $null
        if (-not [System.Net.IPAddress]::TryParse($transport.host, [ref]$address) -or
            $address.Equals([System.Net.IPAddress]::Any) -or $address.Equals([System.Net.IPAddress]::IPv6Any) -or
            @(Get-NetIPAddress -IPAddress $transport.host -ErrorAction Stop).Count -eq 0 -or
            -not (Test-WorkerPackageInteger $config.port) -or $config.port -lt 1 -or $config.port -gt 65535) { throw 'worker_identity_unknown' }
        $nodePath = [System.IO.Path]::Combine($versionRoot, 'runtime', 'node.exe')
        while ($true) {
            $null = Get-WorkerRemainingMilliseconds $Deadline
            if ([Zeb.WorkerInstall.Native]::Wait($hostPin.handle, 0) -or
                ($null -ne $nodePin -and [Zeb.WorkerInstall.Native]::Wait($nodePin.handle, 0))) { throw 'worker_identity_unknown' }
            $current = Get-WorkerServiceRow
            if ($null -eq $current -or $current.ProcessId -ne $hostPin.pid -or $current.State -cne 'Running' -or
                $current.PathName -cne $generation.imagePath -or $current.StartName -cne 'NT SERVICE\ZebImageEnhancement') { throw 'worker_identity_unknown' }
            $childRows = @(Get-CimInstance -ClassName Win32_Process -Filter ("ParentProcessId=" + $hostPin.pid) -ErrorAction Stop)
            $children = @($childRows | Where-Object { [string]::Equals($_.ExecutablePath, $nodePath, [System.StringComparison]::OrdinalIgnoreCase) })
            if ($children.Count -gt 1 -or @($childRows | Where-Object {
                    $_.Name -ieq 'node.exe' -and -not [string]::Equals($_.ExecutablePath, $nodePath, [System.StringComparison]::OrdinalIgnoreCase)
                }).Count -ne 0 -or ($null -ne $nodePin -and ($children.Count -ne 1 -or $children[0].ProcessId -ne $nodePin.pid))) { throw 'worker_identity_unknown' }
            if ($children.Count -eq 1 -and $null -eq $nodePin) {
                $nodePin = Open-WorkerProcessIdentity -ProcessId $children[0].ProcessId -ExpectedImagePath $nodePath
                if ([long]$nodePin.creationFileTime -lt [long]$hostPin.creationFileTime -or
                    $nodePin.tokenUserSid -cne $candidate -or $nodePin.sessionId -ne 0) { throw 'worker_identity_unknown' }
            }
            if ($null -ne $nodePin) {
                $nodeRows = @(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $nodePin.pid) -ErrorAction Stop)
                if ($nodeRows.Count -ne 1 -or $nodeRows[0].ParentProcessId -ne $hostPin.pid -or
                    -not [string]::Equals($nodeRows[0].ExecutablePath, $nodePin.imagePath, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'worker_identity_unknown' }
            }
            $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
                [System.Net.IPAddress]::Parse($_.LocalAddress).Equals($address) -and $_.LocalPort -eq $config.port
            })
            if ($listeners.Count -gt 1 -or ($listeners.Count -eq 1 -and
                    ($null -eq $nodePin -or $listeners[0].OwningProcess -ne $nodePin.pid))) { throw 'worker_identity_unknown' }
            if ($null -ne $nodePin -and $listeners.Count -eq 1) {
                $generation.host = $hostPin; $generation.node = $nodePin
                $generation.tokenUserSid = $candidate; $generation.sessionId = 0
                $generation.endpoint = [pscustomobject]@{ scheme=$transport.scheme; host=$transport.host; port=$config.port; ownerPid=$nodePin.pid; bootId=$null }
                Assert-WorkerLiveGeneration -Generation $generation -Deadline $Deadline
                $hostPin = $null; $nodePin = $null
                return $generation
            }
            if (-not $WaitForReady) { throw 'worker_identity_unknown' }
            $budget = [uint32][Math]::Min(100, (Get-WorkerRemainingMilliseconds $Deadline))
            if ([Zeb.WorkerInstall.Native]::Wait($hostPin.handle, $budget) -or
                ($null -ne $nodePin -and [Zeb.WorkerInstall.Native]::Wait($nodePin.handle, 0))) { throw 'worker_identity_unknown' }
        }
    } catch {
        if ($_.Exception.Message -ceq 'worker_timeout_unknown') { throw }
        throw 'worker_identity_unknown'
    } finally {
        if ($null -ne $hostPin) { $hostPin.handle.Dispose() }
        if ($null -ne $nodePin) { $nodePin.handle.Dispose() }
    }
}

function Invoke-WorkerScmChange {
    param([string]$Action, [string]$ImagePath, $Generation, [DateTime]$Deadline, [string[]]$StartupArguments)
    if ($null -ne $StartupArguments) {
        if ($Action -cne 'Start' -or $StartupArguments.Length -ne 2 -or
            $StartupArguments[0] -cne 'zeb-startup-observe-v1' -or
            [string]::IsNullOrEmpty($StartupArguments[1]) -or $StartupArguments[1].Length -gt 5464 -or
            $StartupArguments[1] -cnotmatch '\A[A-Za-z0-9_-]+\z') { throw 'worker_input_invalid' }
        $encoded = $StartupArguments[1]
        try {
            $raw = [Convert]::FromBase64String($encoded.Replace('-', '+').Replace('_', '/') + ('=' * ((4 - $encoded.Length % 4) % 4)))
        } catch { throw 'worker_input_invalid' }
        if ($raw.Length -eq 0 -or $raw.Length -gt 4096 -or
            [Convert]::ToBase64String($raw).TrimEnd('=').Replace('+', '-').Replace('/', '_') -cne $encoded) { throw 'worker_input_invalid' }
    }
    $service = $null
    if ($Action -cin @('Start', 'Stop')) {
        Add-Type -AssemblyName System.ServiceProcess -ErrorAction Stop
        $service = [System.ServiceProcess.ServiceController]::new('ZebImageEnhancement')
        try {
            if ($Action -ceq 'Stop') {
                Assert-WorkerLiveGeneration -Generation $Generation -Deadline $Deadline
                $service.Stop()
                $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromMilliseconds((Get-WorkerRemainingMilliseconds $Deadline)))
                if (-not [Zeb.WorkerInstall.Native]::Wait($Generation.host.handle, [uint32](Get-WorkerRemainingMilliseconds $Deadline)) -or
                    -not [Zeb.WorkerInstall.Native]::Wait($Generation.node.handle, [uint32](Get-WorkerRemainingMilliseconds $Deadline))) { throw 'worker_stop_unknown' }
            } else {
                if ($null -eq $StartupArguments) { $service.Start() }
                else { $service.Start($StartupArguments) }
                $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromMilliseconds((Get-WorkerRemainingMilliseconds $Deadline)))
            }
        } finally { $service.Dispose() }
        return
    }
    $arguments = switch -CaseSensitive ($Action) {
        'CreateDemand' { @('create', 'ZebImageEnhancement', 'binPath=', $ImagePath, 'start=', 'demand', 'obj=', 'NT SERVICE\ZebImageEnhancement') }
        'SetAutomatic' { @('config', 'ZebImageEnhancement', 'start=', 'auto') }
        'SetImagePath' { @('config', 'ZebImageEnhancement', 'binPath=', $ImagePath) }
        'Delete' { @('delete', 'ZebImageEnhancement') }
        default { throw 'worker_input_invalid' }
    }
    $result = Invoke-WorkerFixedProcess -ExecutablePath ([System.IO.Path]::Combine([System.Environment]::SystemDirectory, 'sc.exe')) -Arguments $arguments -Deadline $Deadline -DiscardOutput
    Assert-WorkerProcessResult -Value $result
    $row = Get-WorkerServiceRow
    if (($Action -ceq 'Delete' -and $null -ne $row) -or
        ($Action -cne 'Delete' -and ($null -eq $row -or $row.StartName -cne 'NT SERVICE\ZebImageEnhancement')) -or
        ($Action -cin @('CreateDemand', 'SetImagePath') -and $row.PathName -cne $ImagePath) -or
        ($Action -ceq 'SetAutomatic' -and $row.StartMode -cne 'Auto')) { throw 'worker_scm_unknown' }
}

function Set-WorkerResourceAcl {
    param($Receipt, [string]$CandidateSid, [DateTime]$Deadline)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    $serviceSid = [System.Security.Principal.SecurityIdentifier]::new($CandidateSid)
    $callerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $versionRoot = Get-WorkerVersionRoot $Receipt.programRoot $Receipt.active.version
    # The real SCM host checks external ancestors before creating its worker; a SID-only context omits service logon groups.
    $parentUpdates = @()
    foreach ($root in @($Receipt.programRoot, $Receipt.dataRoot)) {
        $info = [Zeb.WorkerInstall.Native]::Inspect($root)
        $existing = [System.Security.AccessControl.DirectorySecurity]::new()
        $existing.SetSecurityDescriptorSddlForm($info.SecuritySddl)
        $rules = @($existing.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $callerRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $callerSid.Value })
        $serviceRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $CandidateSid })
        if (-not $info.Directory -or -not $existing.AreAccessRulesProtected -or
            $existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $callerSid.Value -or
            $rules.Count -ne ($callerRules.Count + $serviceRules.Count) -or $callerRules.Count -ne 1 -or $serviceRules.Count -gt 1 -or
            [int]$callerRules[0].FileSystemRights -ne 0x001f01ff -or [int]$callerRules[0].AccessControlType -ne 0 -or
            $callerRules[0].IsInherited -or [int]$callerRules[0].InheritanceFlags -ne 3 -or [int]$callerRules[0].PropagationFlags -ne 0) { throw 'worker_ownership_invalid' }
        if ($serviceRules.Count -eq 1 -and ([int]$serviceRules[0].FileSystemRights -ne 0x001000a0 -or
                [int]$serviceRules[0].AccessControlType -ne 0 -or $serviceRules[0].IsInherited -or
                [int]$serviceRules[0].InheritanceFlags -ne 0 -or [int]$serviceRules[0].PropagationFlags -ne 0)) { throw 'worker_ownership_invalid' }
        $security = Get-WorkerCallerSecurity -Directory
        $security.SetGroup([System.Security.AccessControl.RawSecurityDescriptor]::new($info.SecuritySddl).Group)
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($serviceSid,
            [System.Security.AccessControl.FileSystemRights]0x001000a0, [System.Security.AccessControl.AccessControlType]::Allow))
        $sddl = $security.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Owner -bor
            [System.Security.AccessControl.AccessControlSections]::Group -bor [System.Security.AccessControl.AccessControlSections]::Access)
        $parentUpdates += [pscustomobject]@{ path=$root; info=$info; sddl=$sddl }
    }
    foreach ($update in $parentUpdates) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        [Zeb.WorkerInstall.Native]::RestoreMetadata($update.path, $update.sddl, $update.info.CreationUtc, $update.info.LastWriteUtc, $update.info.Attributes)
        if ([Zeb.WorkerInstall.Native]::Inspect($update.path).SecuritySddl -cne $update.sddl) { throw 'worker_acl_unknown' }
    }
    $roots = @($versionRoot)
    if ($Receipt.operation.action -ceq 'Install' -and $null -eq $Receipt.tokenUserSid) { $roots += @(([System.IO.Path]::Combine($Receipt.dataRoot, 'store')),
        ([System.IO.Path]::Combine($Receipt.dataRoot, 'records')), ([System.IO.Path]::Combine($Receipt.dataRoot, 'engine')),
        ([System.IO.Path]::Combine($Receipt.dataRoot, 'config')), ([System.IO.Path]::Combine($Receipt.dataRoot, 'tls'))) }
    else { Assert-WorkerNativeAcl -Receipt $Receipt -Sid $CandidateSid }
    foreach ($root in $roots) {
        $nativeOnly = (Test-WorkerSamePath $root ([System.IO.Path]::Combine($Receipt.dataRoot, 'records'))) -or
            (Test-WorkerSamePath $root ([System.IO.Path]::Combine($Receipt.dataRoot, 'engine')))
        $store = Test-WorkerSamePath $root ([System.IO.Path]::Combine($Receipt.dataRoot, 'store'))
        foreach ($item in (Get-WorkerTree $root | Sort-Object { $_.path.Length } -Descending)) {
            $null = Get-WorkerRemainingMilliseconds $Deadline
            $security = if ($item.info.Directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
            $security.SetOwner($(if ($nativeOnly) { $serviceSid } else { $callerSid }))
            $security.SetGroup([System.Security.AccessControl.RawSecurityDescriptor]::new($item.info.SecuritySddl).Group)
            $security.SetAccessRuleProtection($true, $false)
            $inherit = if ($item.info.Directory -and -not $nativeOnly) {
                [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
            } else { [System.Security.AccessControl.InheritanceFlags]::None }
            if (-not $nativeOnly) {
                $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($callerSid,
                    [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
                    [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
            }
            $rights = if ($nativeOnly) { [System.Security.AccessControl.FileSystemRights]::FullControl }
                elseif ($store) { [System.Security.AccessControl.FileSystemRights]::Modify }
                else { [System.Security.AccessControl.FileSystemRights]::ReadAndExecute }
            $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($serviceSid, $rights, $inherit,
                [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
            $sddl = $security.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Owner -bor
                [System.Security.AccessControl.AccessControlSections]::Group -bor [System.Security.AccessControl.AccessControlSections]::Access)
            [Zeb.WorkerInstall.Native]::RestoreMetadata($item.path, $sddl, $item.info.CreationUtc, $item.info.LastWriteUtc, $item.info.Attributes)
            if ([Zeb.WorkerInstall.Native]::Inspect($item.path).SecuritySddl -cne $sddl) { throw 'worker_acl_unknown' }
        }
    }
    return [pscustomobject]@{ verified=$true; candidateSid=$CandidateSid }
}

function Assert-WorkerNativeAcl {
    param($Receipt, [string]$Sid)
    foreach ($name in @('engine', 'records')) {
        foreach ($item in (Get-WorkerTree ([System.IO.Path]::Combine($Receipt.dataRoot, $name)))) {
            $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($item.info.SecuritySddl)
            if ($descriptor.Owner.Value -cne $Sid -or
                ($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
                $null -eq $descriptor.DiscretionaryAcl -or $descriptor.DiscretionaryAcl.Count -ne 1) { throw 'worker_acl_unknown' }
            $ace = $descriptor.DiscretionaryAcl[0]
            if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.SecurityIdentifier.Value -cne $Sid -or
                $ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed -or
                [int]$ace.AceFlags -ne 0 -or $ace.AccessMask -ne 0x001f01ff) { throw 'worker_acl_unknown' }
        }
    }
}

function Assert-WorkerEngineVersion {
    param($Value)
    if ($Value -isnot [string] -or $Value.Length -eq 0 -or $Value -cmatch '[\x00-\x1f\x7f]' -or
        $Value -cmatch '\A[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' -or
        $Value -cmatch '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]\z') { throw 'worker_engine_invalid' }
    $null = [System.Text.UTF8Encoding]::new($false, $true).GetByteCount($Value)
}

function Assert-WorkerEngineLayout {
    param($Entries, $Material)
    $required = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $null = $required.Add('installation-manifest.json')
    if (-not $Entries.ContainsKey('installation-manifest.json')) { throw 'worker_engine_invalid' }
    $manifest = Read-WorkerJson $Entries['installation-manifest.json'].sourcePath
    Assert-WorkerObject $manifest @('v', 'platform', 'recipeId', 'binaryVersion', 'entryPoint', 'files', 'models')
    Assert-WorkerEngineVersion $manifest.binaryVersion
    if (-not (Test-WorkerJsonVersionOne $manifest.v) -or $manifest.platform -cne 'win-x64' -or $manifest.recipeId -cne 'upscayl-4x-png-v1' -or
        $Material.workerConfig.models -isnot [array] -or $Material.workerConfig.models.Count -eq 0 -or $manifest.files -isnot [array] -or
        $manifest.files.Count -eq 0 -or $manifest.models -isnot [array] -or $manifest.models.Count -eq 0) { throw 'worker_engine_invalid' }
    Assert-WorkerPackagePath $manifest.entryPoint
    $binarySeen = $false
    foreach ($declaration in $manifest.files) {
        Assert-WorkerEngineDeclaration -Declaration $declaration -Entries $Entries -Required $required
        if ($declaration.path -ceq $manifest.entryPoint) { $binarySeen = $true }
    }
    if (-not $binarySeen) { throw 'worker_engine_invalid' }
    $modelIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $modelDirectories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($model in $manifest.models) {
        Assert-WorkerObject $model @('modelId', 'modelVersion', 'modelDirectory', 'modelName', 'modelSetSha256')
        Assert-WorkerPackagePath $model.modelDirectory
        Assert-WorkerPackagePath $model.modelName
        $null = [System.Text.UTF8Encoding]::new($false, $true).GetByteCount($model.modelDirectory)
        Assert-WorkerEngineVersion $model.modelName
        Assert-WorkerEngineVersion $model.modelVersion
        Assert-WorkerHash $model.modelSetSha256
        if ($model.modelName.Contains('/') -or $model.modelId -isnot [string] -or $model.modelId -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*\z' -or
            -not $modelIds.Add($model.modelId) -or -not $modelDirectories.Add($model.modelDirectory)) { throw 'worker_engine_invalid' }
        $setPath = $model.modelDirectory + '/model-set.json'
        if (-not $required.Add($setPath) -or -not $Entries.ContainsKey($setPath) -or
            $Entries[$setPath].sha256 -cne $model.modelSetSha256) { throw 'worker_engine_invalid' }
        $set = Read-WorkerJson $Entries[$setPath].sourcePath
        Assert-WorkerObject $set @('v', 'modelName', 'files')
        if (-not (Test-WorkerJsonVersionOne $set.v) -or $set.modelName -cne $model.modelName -or $set.files -isnot [array] -or $set.files.Count -ne 2) { throw 'worker_engine_invalid' }
        $pair = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($declaration in $set.files) {
            Assert-WorkerObject $declaration @('path', 'length', 'sha256')
            if ($declaration.path -cnotin @(($model.modelName + '.bin'), ($model.modelName + '.param')) -or
                -not $pair.Add($declaration.path)) { throw 'worker_engine_invalid' }
            $qualified = [pscustomobject]@{ path=$model.modelDirectory + '/' + $declaration.path; length=$declaration.length; sha256=$declaration.sha256 }
            Assert-WorkerEngineDeclaration -Declaration $qualified -Entries $Entries -Required $required
        }
    }
    foreach ($selection in $Material.workerConfig.models) {
        $models = @($manifest.models | Where-Object { $_.modelId -ceq $selection.id })
        if ($models.Count -ne 1 -or $selection.binaryVersion -cne $manifest.binaryVersion -or
            $selection.binarySha256 -cne $Entries[$manifest.entryPoint].sha256 -or
            $selection.modelVersion -cne $models[0].modelVersion -or $selection.modelSha256 -cne $models[0].modelSetSha256 -or
            $selection.nativeScale -ne 4 -or $selection.tta -ne $false) { throw 'worker_engine_invalid' }
    }
    if ($required.Count -ne $Entries.Count) { throw 'worker_engine_invalid' }
    return $Entries['installation-manifest.json'].sha256
}

function Assert-WorkerEngineDeclaration {
    param($Declaration, $Entries, $Required)
    Assert-WorkerObject $Declaration @('path', 'length', 'sha256')
    Assert-WorkerPackagePath $Declaration.path
    $null = [System.Text.UTF8Encoding]::new($false, $true).GetByteCount($Declaration.path)
    Assert-WorkerHash $Declaration.sha256
    $length = 0L
    if ($Declaration.length -isnot [string] -or $Declaration.length -cnotmatch '\A(?:0|[1-9][0-9]*)\z' -or
        -not [long]::TryParse($Declaration.length, [ref]$length) -or -not $Required.Add($Declaration.path) -or
        -not $Entries.ContainsKey($Declaration.path) -or $Entries[$Declaration.path].bytes -ne $length -or
        $Entries[$Declaration.path].sha256 -cne $Declaration.sha256) { throw 'worker_engine_invalid' }
}

function Read-WorkerEngineImport {
    param([string]$Path, [string]$ExpectedSha256, $Material, [string[]]$OwnedPaths)
    Assert-WorkerHash $ExpectedSha256
    if ([Zeb.WorkerInstall.Native]::Hash($Path) -ine $ExpectedSha256) { throw 'worker_engine_invalid' }
    $value = Read-WorkerJson $Path
    Assert-WorkerObject $value @('schemaVersion', 'files')
    if (-not (Test-WorkerJsonVersionOne $value.schemaVersion) -or $value.files -isnot [array] -or $value.files.Count -eq 0) { throw 'worker_engine_invalid' }
    $entries = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $identities = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($entry in $value.files) {
        Assert-WorkerObject $entry @('sourcePath', 'path', 'bytes', 'sha256')
        Assert-WorkerPackagePath $entry.path; Assert-WorkerHash $entry.sha256
        $source = Resolve-WorkerLocalPath $entry.sourcePath
        Assert-WorkerSeparatePaths (@($source) + $OwnedPaths)
        $info = [Zeb.WorkerInstall.Native]::Inspect($source)
        if ($info.Directory -or -not $identities.Add($info.Identity) -or -not (Test-WorkerPackageInteger $entry.bytes) -or
            $info.Bytes -ne $entry.bytes -or [Zeb.WorkerInstall.Native]::Hash($source) -cne $entry.sha256 -or
            $entries.ContainsKey($entry.path)) { throw 'worker_engine_invalid' }
        $entries.Add($entry.path, $entry)
    }
    $manifestSha = Assert-WorkerEngineLayout -Entries $entries -Material $Material
    return [pscustomobject]@{ entries=$entries; manifestSha256=$manifestSha }
}

function Assert-WorkerStableFiles {
    param($Receipt, [switch]$Engine)
    $configPath = [System.IO.Path]::Combine($Receipt.dataRoot, 'config', 'worker.config.json')
    $tlsPath = [System.IO.Path]::Combine($Receipt.dataRoot, 'tls', 'worker.pfx')
    if ([Zeb.WorkerInstall.Native]::Hash($configPath) -cne $Receipt.configSha256) { throw 'worker_configuration_invalid' }
    $config = Read-WorkerJson $configPath
    $transport = Get-WorkerTransport $config
    if (($null -eq $Receipt.tlsSha256) -ne ($transport.scheme -ceq 'http')) { throw 'worker_configuration_invalid' }
    if ($transport.scheme -ceq 'https') {
        if (-not (Test-WorkerSamePath $config.tls.pfxPath $tlsPath) -or
            [Zeb.WorkerInstall.Native]::Hash($tlsPath) -cne $Receipt.tlsSha256) { throw 'worker_configuration_invalid' }
    } elseif ([System.IO.File]::Exists($tlsPath)) { throw 'worker_configuration_invalid' }
    if ($config.operatorClientId -cne $Receipt.clientId -or
        -not (Test-WorkerSamePath $config.storeDirectory ([System.IO.Path]::Combine($Receipt.dataRoot, 'store'))) -or
        -not (Test-WorkerSamePath $config.execution.installationRoot ([System.IO.Path]::Combine($Receipt.dataRoot, 'engine'))) -or
        -not (Test-WorkerSamePath $config.execution.recordsRoot ([System.IO.Path]::Combine($Receipt.dataRoot, 'records'))) -or
        $config.execution.expectedManifestSha256 -cne $Receipt.engineManifestSha256) { throw 'worker_configuration_invalid' }
    if ($Engine) {
        $root = [System.IO.Path]::Combine($Receipt.dataRoot, 'engine')
        $entries = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($item in (Get-WorkerTree $root)) {
            if ($item.info.Directory) { continue }
            $relative = $item.path.Substring($root.Length + 1).Replace('\', '/')
            $entries.Add($relative, [pscustomobject]@{ path=$relative; sourcePath=$item.path; bytes=$item.info.Bytes; sha256=[Zeb.WorkerInstall.Native]::Hash($item.path) })
        }
        if ((Assert-WorkerEngineLayout $entries $config) -cne $Receipt.engineManifestSha256) { throw 'worker_engine_invalid' }
    }
    return $config
}

function Assert-WorkerCopiedEngine {
    param([string]$Root, $Material, [string]$ExpectedManifestSha256)
    $entries = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($item in (Get-WorkerTree $Root)) {
        if ($item.info.Directory) { continue }
        $relative = $item.path.Substring($Root.Length + 1).Replace('\', '/')
        $entries.Add($relative, [pscustomobject]@{ path=$relative; sourcePath=$item.path; bytes=$item.info.Bytes; sha256=[Zeb.WorkerInstall.Native]::Hash($item.path) })
    }
    if ((Assert-WorkerEngineLayout $entries $Material) -cne $ExpectedManifestSha256) { throw 'worker_engine_invalid' }
}

function Assert-WorkerPairing {
    param($Value)
    Assert-WorkerObject $Value @('serviceId', 'credential')
    Assert-WorkerUuid $Value.serviceId
    Assert-WorkerObject $Value.credential @('clientId', 'credentialId', 'version', 'key')
    Assert-WorkerUuid $Value.credential.clientId; Assert-WorkerUuid $Value.credential.credentialId
    if (-not (Test-WorkerPackageInteger $Value.credential.version) -or $Value.credential.version -lt 1 -or
        $Value.credential.key -cnotmatch '\A[A-Za-z0-9_-]{43}\z') { throw 'worker_identity_unknown' }
}

function Read-WorkerCredential {
    param([string]$Path, $Receipt)
    Assert-WorkerCallerFile $Path
    $pairing = Read-WorkerJson $Path
    Assert-WorkerPairing $pairing
    if ($pairing.serviceId -cne $Receipt.serviceId -or $pairing.credential.clientId -cne $Receipt.clientId) { throw 'worker_identity_unknown' }
    return $pairing
}

function Read-WorkerReceipt {
    param([string]$Path)
    Assert-WorkerCallerFile $Path
    $receipt = Read-WorkerJson $Path
    Assert-WorkerObject $receipt @('schemaVersion', 'installationId', 'state', 'serviceName', 'accountName', 'tokenUserSid',
        'sessionId', 'programRoot', 'dataRoot', 'storeSchemaVersion', 'serviceId', 'clientId', 'engineImportSha256',
        'engineManifestSha256', 'configSha256', 'tlsSha256', 'active', 'previous', 'lastStopped', 'operation')
    Assert-WorkerUuid $receipt.installationId
    if ($receipt.schemaVersion -ne 1 -or $receipt.storeSchemaVersion -ne 7 -or $receipt.serviceName -cne 'ZebImageEnhancement' -or
        $receipt.accountName -cne 'NT SERVICE\ZebImageEnhancement' -or $receipt.state -cnotin @('pending', 'installed', 'retained', 'unknown')) { throw 'worker_receipt_invalid' }
    $program = Resolve-WorkerLocalPath $receipt.programRoot
    $data = Resolve-WorkerLocalPath $receipt.dataRoot
    Assert-WorkerSeparatePaths @($program, $data)
    if (-not (Test-WorkerSamePath $Path ([System.IO.Path]::Combine($data, 'installation', 'receipt.json')))) { throw 'worker_receipt_invalid' }
    foreach ($identity in @($receipt.serviceId, $receipt.clientId)) { if ($null -ne $identity) { Assert-WorkerUuid $identity } }
    foreach ($hash in @($receipt.engineImportSha256, $receipt.engineManifestSha256)) { Assert-WorkerHash $hash }
    if ($null -ne $receipt.tlsSha256) { Assert-WorkerHash $receipt.tlsSha256 }
    if ($null -ne $receipt.configSha256) { Assert-WorkerHash $receipt.configSha256 }
    if ($null -ne $receipt.tokenUserSid) { $null = [System.Security.Principal.SecurityIdentifier]::new($receipt.tokenUserSid) }
    if ($null -ne $receipt.sessionId -and $receipt.sessionId -ne 0) { throw 'worker_receipt_invalid' }
    if ($receipt.active -isnot [pscustomobject]) { throw 'worker_receipt_invalid' }
    foreach ($active in @($receipt.active, $receipt.previous)) {
        if ($null -eq $active) { continue }
        Assert-WorkerObject $active @('version', 'inventorySha256', 'imagePath')
        Assert-WorkerHash $active.inventorySha256
        $root = Get-WorkerVersionRoot $program $active.version
        if ($active.imagePath -cne ('"' + [System.IO.Path]::Combine($root, 'WindowsServiceHost.exe') + '"')) { throw 'worker_receipt_invalid' }
    }
    Assert-WorkerObject $receipt.operation @('operationId', 'action', 'stage', 'outcome', 'maintenanceBootId', 'targetSha256')
    Assert-WorkerUuid $receipt.operation.operationId
    if ($receipt.operation.action -cnotin @('Install', 'Upgrade', 'Rollback', 'Uninstall', 'DeleteData') -or
        $receipt.operation.stage -cnotin @('prepared', 'initializing', 'identity_saved', 'service_created', 'started', 'maintenance', 'stopped', 'backed_up', 'switched', 'retained', 'deleted') -or
        $receipt.operation.outcome -cnotin @('pending', 'known', 'unknown')) { throw 'worker_receipt_invalid' }
    if ($null -ne $receipt.operation.maintenanceBootId) { Assert-WorkerUuid $receipt.operation.maintenanceBootId }
    if ($null -ne $receipt.operation.targetSha256) { Assert-WorkerHash $receipt.operation.targetSha256 }
    if ($null -ne $receipt.lastStopped) {
        Assert-WorkerObject $receipt.lastStopped @('bootId', 'host', 'node', 'pinsExclusive')
        Assert-WorkerUuid $receipt.lastStopped.bootId
        if ($receipt.lastStopped.pinsExclusive -ne $true) { throw 'worker_receipt_invalid' }
        foreach ($pin in @($receipt.lastStopped.host, $receipt.lastStopped.node)) {
            Assert-WorkerObject $pin @('pid', 'creationFileTime')
            if (-not (Test-WorkerPackageInteger $pin.pid) -or $pin.pid -lt 1 -or
                $pin.creationFileTime -isnot [string] -or $pin.creationFileTime -cnotmatch '\A[1-9][0-9]*\z') { throw 'worker_receipt_invalid' }
        }
    }
    if ($receipt.state -cin @('installed', 'retained') -and ($null -eq $receipt.serviceId -or $null -eq $receipt.clientId -or
        $null -eq $receipt.tokenUserSid -or $receipt.sessionId -ne 0 -or $null -eq $receipt.configSha256)) { throw 'worker_receipt_invalid' }
    return $receipt
}

function Get-WorkerSnapshot {
    param([string]$Root)
    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) {
        foreach ($item in (Get-WorkerTree ([System.IO.Path]::Combine($Root, $name)))) {
            $entry = [ordered]@{ path=$item.path.Substring($Root.Length + 1).Replace('\', '/');
                kind=$(if ($item.info.Directory) { 'directory' } else { 'file' });
                creationUtc=$item.info.CreationUtc; lastWriteUtc=$item.info.LastWriteUtc;
                attributes=$item.info.Attributes; securitySddl=$item.info.SecuritySddl }
            if (-not $item.info.Directory) {
                $entry['bytes'] = $item.info.Bytes
                $entry['sha256'] = [Zeb.WorkerInstall.Native]::Hash($item.path)
            }
            $entries.Add([pscustomobject]$entry)
        }
    }
    return [pscustomobject]@{ schemaVersion=1; entries=@($entries.ToArray() | Sort-Object path) }
}

function Assert-WorkerSnapshot {
    param([string]$Root, $Manifest, [switch]$Security)
    Assert-WorkerObject $Manifest @('schemaVersion', 'entries')
    if ($Manifest.schemaVersion -ne 1 -or $Manifest.entries -isnot [array] -or $Manifest.entries.Count -lt 5) { throw 'worker_backup_invalid' }
    $actual = Get-WorkerSnapshot $Root
    $expected = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Manifest.entries) {
        Assert-WorkerPackagePath $entry.path
        if ($entry.path.Split([char]'/')[0] -cnotin @('store', 'records', 'engine', 'config', 'tls') -or
            $entry.kind -cnotin @('file', 'directory') -or $expected.ContainsKey($entry.path)) { throw 'worker_backup_invalid' }
        $keys = @('path', 'kind', 'creationUtc', 'lastWriteUtc', 'attributes', 'securitySddl')
        if ($entry.kind -ceq 'file') { $keys += @('bytes', 'sha256'); Assert-WorkerHash $entry.sha256 }
        Assert-WorkerObject $entry $keys
        $expected.Add($entry.path, $entry)
    }
    if ($actual.entries.Count -ne $expected.Count) { throw 'worker_backup_invalid' }
    foreach ($entry in $actual.entries) {
        if (-not $expected.ContainsKey($entry.path)) { throw 'worker_backup_invalid' }
        $wanted = $expected[$entry.path]
        if ($wanted.path -cne $entry.path -or $wanted.kind -cne $entry.kind -or
            $wanted.creationUtc -cne $entry.creationUtc -or $wanted.lastWriteUtc -cne $entry.lastWriteUtc -or
            $wanted.attributes -ne $entry.attributes -or
            ($entry.kind -ceq 'file' -and ($wanted.bytes -ne $entry.bytes -or $wanted.sha256 -cne $entry.sha256)) -or
            ($Security -and $wanted.securitySddl -cne $entry.securitySddl)) { throw 'worker_backup_invalid' }
    }
}

function Restore-WorkerSnapshotMetadata {
    param([string]$Root, $Manifest)
    # Restoring parents first prevents inheritance propagation from overwriting restored children.
    foreach ($entry in ($Manifest.entries | Sort-Object { $_.path.Length })) {
        Assert-WorkerPackagePath $entry.path
        $path = [System.IO.Path]::Combine($Root, $entry.path.Replace('/', '\'))
        [Zeb.WorkerInstall.Native]::RestoreMetadata($path, $entry.securitySddl, $entry.creationUtc, $entry.lastWriteUtc, [uint32]$entry.attributes)
    }
    Assert-WorkerSnapshot -Root $Root -Manifest $Manifest -Security
}

function Copy-WorkerSnapshot {
    param([string]$Source, [string]$Destination, $Manifest, [DateTime]$Deadline)
    New-WorkerCallerDirectory $Destination
    foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) {
        $result = Invoke-WorkerRobocopy -Source ([System.IO.Path]::Combine($Source, $name)) -Destination ([System.IO.Path]::Combine($Destination, $name)) -Arguments @('/E', '/B', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:0', '/W:0') -Deadline $Deadline
        Assert-WorkerProcessResult -Value $result -MaximumExit 7 -AllowStderr
    }
    foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) {
        foreach ($item in (Get-WorkerTree ([System.IO.Path]::Combine($Destination, $name)) | Sort-Object { $_.path.Length } -Descending)) {
            $security = Get-WorkerCallerSecurity -Directory:$item.info.Directory
            $security.SetGroup([System.Security.AccessControl.RawSecurityDescriptor]::new($item.info.SecuritySddl).Group)
            $sddl = $security.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Owner -bor
                [System.Security.AccessControl.AccessControlSections]::Group -bor [System.Security.AccessControl.AccessControlSections]::Access)
            [Zeb.WorkerInstall.Native]::RestoreMetadata($item.path, $sddl, $item.info.CreationUtc, $item.info.LastWriteUtc, $item.info.Attributes)
            if ([Zeb.WorkerInstall.Native]::Inspect($item.path).SecuritySddl -cne $sddl) { throw 'worker_acl_unknown' }
        }
    }
    Assert-WorkerSnapshot -Root $Destination -Manifest $Manifest
}

function Test-WorkerSnapshotDatabase {
    param([string]$Root, $Receipt, [DateTime]$Deadline)
    $versionRoot = Get-WorkerVersionRoot $Receipt.programRoot $Receipt.active.version
    $probe = @'
const { createRequire } = require("node:module");
const Database = createRequire(process.argv[1])("better-sqlite3");
const database = new Database(process.argv[2], { readonly: true, fileMustExist: true, timeout: 0 });
try {
  if (database.pragma("user_version", { simple: true }) !== 7 ||
      database.pragma("quick_check", { simple: true }) !== "ok" ||
      database.prepare("SELECT service_id FROM service_identity").get()?.service_id !== process.argv[3])
    throw new Error("worker_backup_invalid");
  process.stdout.write('{"verified":true}\n');
} finally { database.close(); }
'@
    $arguments = @('-e', $probe, ([System.IO.Path]::Combine($versionRoot, 'app', 'package.json')),
        ([System.IO.Path]::Combine($Root, 'store', 'worker.sqlite')), $Receipt.serviceId)
    $result = Invoke-WorkerNodeProcess -ExecutablePath ([System.IO.Path]::Combine($versionRoot, 'runtime', 'node.exe')) -Arguments $arguments -Deadline $Deadline
    Assert-WorkerProcessResult $result
    $verified = ConvertFrom-Json -InputObject $result.stdout -ErrorAction Stop
    Assert-WorkerObject $verified @('verified')
    if ($verified.verified -ne $true) { throw 'worker_backup_invalid' }
}

function New-WorkerBackup {
    param($Receipt, [string]$BackupRoot, [DateTime]$Deadline)
    $root = Resolve-WorkerLocalPath -Path $BackupRoot -AllowMissing
    Assert-WorkerSeparatePaths @($root, $Receipt.programRoot, $Receipt.dataRoot)
    $null = Assert-WorkerStableFiles -Receipt $Receipt -Engine
    New-WorkerCallerDirectory $root
    $backupId = [Guid]::NewGuid().ToString()
    $snapshotRoot = [System.IO.Path]::Combine($root, $backupId)
    $manifest = Get-WorkerSnapshot $Receipt.dataRoot
    Copy-WorkerSnapshot -Source $Receipt.dataRoot -Destination $snapshotRoot -Manifest $manifest -Deadline $Deadline
    $verificationRoot = [System.IO.Path]::Combine($root, $backupId + '-verification')
    Copy-WorkerSnapshot -Source $snapshotRoot -Destination $verificationRoot -Manifest $manifest -Deadline $Deadline
    Test-WorkerSnapshotDatabase -Root $verificationRoot -Receipt $Receipt -Deadline $Deadline
    Restore-WorkerSnapshotMetadata -Root $verificationRoot -Manifest $manifest
    Remove-WorkerOwnedTree $verificationRoot
    $manifestPath = [System.IO.Path]::Combine($snapshotRoot, 'manifest.json')
    Write-WorkerLedger -Path $manifestPath -Value $manifest
    $backup = [pscustomobject]@{ schemaVersion=1; backupId=$backupId; installationId=$Receipt.installationId; storeSchemaVersion=7;
        serviceId=$Receipt.serviceId; clientId=$Receipt.clientId; tokenUserSid=$Receipt.tokenUserSid;
        engineManifestSha256=$Receipt.engineManifestSha256; configSha256=$Receipt.configSha256; tlsSha256=$Receipt.tlsSha256;
        sourceVersion=$Receipt.active.version; sourceInventorySha256=$Receipt.active.inventorySha256; sourceImagePath=$Receipt.active.imagePath;
        root=$snapshotRoot; manifestSha256=[Zeb.WorkerInstall.Native]::Hash($manifestPath); verified=$true }
    $path = [System.IO.Path]::Combine($snapshotRoot, 'backup-receipt.json')
    Write-WorkerLedger -Path $path -Value $backup
    return [pscustomobject]@{ path=$path; value=$backup }
}

function Read-WorkerBackup {
    param([string]$Path, $Receipt)
    Assert-WorkerCallerFile $Path
    $backup = Read-WorkerJson $Path
    Assert-WorkerObject $backup @('schemaVersion', 'backupId', 'installationId', 'storeSchemaVersion', 'serviceId', 'clientId',
        'tokenUserSid', 'engineManifestSha256', 'configSha256', 'tlsSha256', 'sourceVersion', 'sourceInventorySha256',
        'sourceImagePath', 'root', 'manifestSha256', 'verified')
    Assert-WorkerUuid $backup.backupId
    if ($backup.schemaVersion -ne 1 -or $backup.verified -ne $true -or $backup.storeSchemaVersion -ne 7 -or
        $backup.installationId -cne $Receipt.installationId -or $backup.serviceId -cne $Receipt.serviceId -or
        $backup.clientId -cne $Receipt.clientId -or $backup.tokenUserSid -cne $Receipt.tokenUserSid -or
        $backup.engineManifestSha256 -cne $Receipt.engineManifestSha256 -or $backup.configSha256 -cne $Receipt.configSha256 -or
        $backup.tlsSha256 -cne $Receipt.tlsSha256 -or $null -eq $Receipt.previous -or
        $backup.sourceVersion -cne $Receipt.previous.version -or $backup.sourceInventorySha256 -cne $Receipt.previous.inventorySha256 -or
        $backup.sourceImagePath -cne $Receipt.previous.imagePath) { throw 'worker_backup_invalid' }
    $root = Resolve-WorkerLocalPath $backup.root
    Assert-WorkerSeparatePaths @($root, $Receipt.programRoot, $Receipt.dataRoot)
    Assert-WorkerCallerDirectory $root
    $callerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($item in (Get-WorkerTree $root)) {
        $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($item.info.SecuritySddl)
        if ($descriptor.Owner.Value -cne $callerSid -or $null -eq $descriptor.DiscretionaryAcl -or $descriptor.DiscretionaryAcl.Count -eq 0) { throw 'worker_ownership_invalid' }
        foreach ($ace in $descriptor.DiscretionaryAcl) {
            if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.SecurityIdentifier.Value -cne $callerSid -or
                $ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed -or $ace.AccessMask -ne 0x001f01ff) { throw 'worker_ownership_invalid' }
        }
    }
    if (-not (Test-WorkerSamePath $Path ([System.IO.Path]::Combine($root, 'backup-receipt.json')))) { throw 'worker_backup_invalid' }
    $manifestPath = [System.IO.Path]::Combine($root, 'manifest.json')
    Assert-WorkerCallerFile $manifestPath
    Assert-WorkerHash $backup.manifestSha256
    if ([Zeb.WorkerInstall.Native]::Hash($manifestPath) -cne $backup.manifestSha256) { throw 'worker_backup_invalid' }
    $manifest = Read-WorkerJson $manifestPath
    Assert-WorkerSnapshot -Root $root -Manifest $manifest
    return [pscustomobject]@{ value=$backup; manifest=$manifest }
}

function Write-WorkerUpgradeEvidence {
    param($Evidence, $Receipt, $ReceiptPath, $Backup, [DateTime]$Deadline)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    Assert-WorkerObject $Evidence @('OperationId','OldActive','MaintenanceDtoRaw','MaintenanceDtoSha256','First','Second',
        'ScmStopCalls','HostExitCode','NodeExitCode','PinsExclusive','BackupResult','BackupBinding','EvidencePath','EvidenceSha256')
    if ($args.Count -ne 0 -or $null -ne $Evidence.EvidencePath -or $null -ne $Evidence.EvidenceSha256 -or
        -not [object]::ReferenceEquals($Evidence.BackupResult,$Backup) -or $Evidence.PinsExclusive -cne $true -or
        $Evidence.ScmStopCalls -ne 1 -or $Evidence.HostExitCode -isnot [uint32] -or $Evidence.HostExitCode -ne 0 -or
        $Evidence.NodeExitCode -isnot [uint32] -or $Evidence.NodeExitCode -ne 0) { throw 'worker_upgrade_evidence_invalid' }
    Assert-WorkerUuid $Evidence.OperationId
    Assert-WorkerObject $Evidence.BackupBinding @('path','valueJson','receiptSha256')
    Assert-WorkerObject $Backup @('path','value')
    Assert-WorkerHash $Evidence.BackupBinding.receiptSha256
    $diskReceipt = Read-WorkerReceipt $ReceiptPath
    if (($diskReceipt | ConvertTo-Json -Depth 64 -Compress) -cne ($Receipt | ConvertTo-Json -Depth 64 -Compress) -or
        $Receipt.state -cne 'installed' -or $Receipt.operation.action -cne 'Upgrade' -or
        $Receipt.operation.stage -cne 'stopped' -or $Receipt.operation.outcome -cne 'known' -or
        $Receipt.operation.operationId -cne $Evidence.OperationId -or $null -eq $Receipt.lastStopped -or
        ($Receipt.active | ConvertTo-Json -Compress) -cne ($Evidence.OldActive | ConvertTo-Json -Compress)) {
        throw 'worker_upgrade_evidence_invalid'
    }
    $receiptRaw = [Zeb.WorkerInstall.Native]::ReadBytes($ReceiptPath)
    if ($receiptRaw.Length -gt 65536) { throw 'worker_upgrade_evidence_invalid' }
    $receiptSha = Get-WorkerBytesHash $receiptRaw
    $versionRoot = Get-WorkerVersionRoot $Receipt.programRoot $Receipt.active.version
    $null = Test-WorkerInstalledPayload $versionRoot $Receipt.active.inventorySha256 $Receipt.configSha256
    $inventoryPath = [IO.Path]::Combine($versionRoot,'package.inventory.json')
    $inventoryRaw = [Zeb.WorkerInstall.Native]::ReadBytes($inventoryPath)
    if ((Get-WorkerBytesHash $inventoryRaw) -cne $Receipt.active.inventorySha256) { throw 'worker_upgrade_evidence_invalid' }
    $inventory = Read-WorkerJson $inventoryPath
    foreach ($required in @('orderly-stop-contract.v1','WindowsServiceHost.dll','WindowsSupervisor.dll',
        'WindowsSupervisor.deps.json','WindowsSupervisor.runtimeconfig.json')) {
        if (@($inventory.files | Where-Object { $_.path -ceq $required }).Count -ne 1) { throw 'worker_upgrade_evidence_invalid' }
    }
    $markerRaw = [Zeb.WorkerInstall.Native]::ReadBytes([IO.Path]::Combine($versionRoot,'orderly-stop-contract.v1'))
    if ($markerRaw.Length -ne 29 -or [Text.Encoding]::ASCII.GetString($markerRaw) -cne ("ZEB_ORDERLY_STOP_CONTRACT_V1"+[char]10)) {
        throw 'worker_upgrade_evidence_invalid'
    }
    Assert-WorkerHash $Evidence.MaintenanceDtoSha256
    if ($Evidence.MaintenanceDtoRaw -isnot [byte[]] -or $Evidence.MaintenanceDtoRaw.Length -gt 65536 -or
        (Get-WorkerBytesHash $Evidence.MaintenanceDtoRaw) -cne $Evidence.MaintenanceDtoSha256) { throw 'worker_upgrade_evidence_invalid' }
    $dto = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false,$true).GetString($Evidence.MaintenanceDtoRaw)) -ErrorAction Stop
    if (-not (Test-WorkerQuiescent $dto $Receipt.operation.maintenanceBootId) -or $dto.store.queued -ne 0 -or
        $Receipt.lastStopped.bootId -cne $dto.bootId) { throw 'worker_upgrade_evidence_invalid' }
    foreach ($generation in @($Evidence.First,$Evidence.Second)) {
        Assert-WorkerObject $generation @('bootId','endpoint','host','node')
        Assert-WorkerObject $generation.endpoint @('scheme','host','port','ownerPid','bootId')
        if ($generation.bootId -cne $dto.bootId -or $generation.endpoint.bootId -cne $dto.bootId -or
            $generation.endpoint.scheme -cnotin @('http','https') -or $generation.endpoint.host -isnot [string] -or
            [string]::IsNullOrWhiteSpace($generation.endpoint.host) -or -not (Test-WorkerPackageInteger $generation.endpoint.port) -or
            $generation.endpoint.port -lt 1 -or $generation.endpoint.port -gt 65535 -or
            $generation.endpoint.ownerPid -ne $generation.node.pid) { throw 'worker_upgrade_evidence_invalid' }
        foreach ($role in @('host','node')) {
            $pin = $generation.$role; $stopped = $Receipt.lastStopped.$role
            Assert-WorkerObject $pin @('pid','creationFileTime','imagePath','tokenUserSid','sessionId')
            $image = if ($role -ceq 'host') { [IO.Path]::Combine($versionRoot,'WindowsServiceHost.exe') }
                else { [IO.Path]::Combine($versionRoot,'runtime','node.exe') }
            if ($pin.pid -ne $stopped.pid -or $pin.creationFileTime -cne $stopped.creationFileTime -or
                $pin.tokenUserSid -cne $Receipt.tokenUserSid -or $pin.sessionId -ne 0 -or
                -not (Test-WorkerSamePath $pin.imagePath $image)) { throw 'worker_upgrade_evidence_invalid' }
        }
    }
    if (($Evidence.First | ConvertTo-Json -Depth 12 -Compress) -cne ($Evidence.Second | ConvertTo-Json -Depth 12 -Compress) -or
        $Backup.path -cne $Evidence.BackupBinding.path -or
        ($Backup.value | ConvertTo-Json -Depth 32 -Compress) -cne $Evidence.BackupBinding.valueJson) { throw 'worker_upgrade_evidence_invalid' }
    Assert-WorkerCallerFile $Backup.path
    $backupRaw = [Zeb.WorkerInstall.Native]::ReadBytes($Backup.path)
    if ((Get-WorkerBytesHash $backupRaw) -cne $Evidence.BackupBinding.receiptSha256) { throw 'worker_upgrade_evidence_invalid' }
    # ReadBackup binds the old source through previous; keep the live, pre-switch receipt untouched.
    $projection = $Receipt | ConvertTo-Json -Depth 64 -Compress | ConvertFrom-Json
    $projection.previous = $Evidence.OldActive
    $verified = Read-WorkerBackup $Backup.path $projection
    if (($verified.value | ConvertTo-Json -Depth 32 -Compress) -cne $Evidence.BackupBinding.valueJson) { throw 'worker_upgrade_evidence_invalid' }
    Assert-WorkerSnapshot -Root $Receipt.dataRoot -Manifest $verified.manifest -Security
    $manifestPath = [IO.Path]::Combine($verified.value.root,'manifest.json')
    $manifestRaw = [Zeb.WorkerInstall.Native]::ReadBytes($manifestPath)
    if ((Get-WorkerBytesHash $manifestRaw) -cne $verified.value.manifestSha256) { throw 'worker_upgrade_evidence_invalid' }
    $installation = Resolve-WorkerLocalPath ([IO.Path]::Combine($Receipt.dataRoot,'installation'))
    Assert-WorkerCallerDirectory $installation
    $root = [IO.Path]::Combine($installation,'upgrade-'+$Evidence.OperationId)
    $null = Resolve-WorkerLocalPath -Path $root -AllowMissing
    if ([IO.File]::Exists($root) -or [IO.Directory]::Exists($root)) { throw 'worker_upgrade_evidence_conflict' }
    $oldStop = [ordered]@{schemaVersion=1;operationId=$Evidence.OperationId;source='derivedFromQualifiedHostContract';
        oldActive=$Evidence.OldActive;maintenanceDtoSha256=$Evidence.MaintenanceDtoSha256;first=$Evidence.First;second=$Evidence.Second;
        scmStopCalls=$Evidence.ScmStopCalls;hostExitCode=$Evidence.HostExitCode;nodeExitCode=$Evidence.NodeExitCode;pinsExclusive=$Evidence.PinsExclusive;
        stoppedReceiptRawBase64=[Convert]::ToBase64String($receiptRaw);stoppedReceiptSha256=$receiptSha}
    $materials = @(@{name='maintenance-dto.json';raw=$Evidence.MaintenanceDtoRaw},@{name='old-package.inventory.json';raw=$inventoryRaw},
        @{name='old-stop.json';raw=[Text.UTF8Encoding]::new($false,$true).GetBytes(($oldStop | ConvertTo-Json -Depth 32 -Compress)+[char]10)})
    $null = Get-WorkerRemainingMilliseconds $Deadline
    New-WorkerCallerDirectory $root
    $materialIndex = [ordered]@{}
    foreach ($material in $materials) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        $path = [IO.Path]::Combine($root,$material.name)
        New-WorkerCallerFile -Path $path -Bytes $material.raw
        $readback = [Zeb.WorkerInstall.Native]::ReadBytes($path)
        $hash = Get-WorkerBytesHash $material.raw
        if ($readback.Length -ne $material.raw.Length -or (Get-WorkerBytesHash $readback) -cne $hash) { throw 'worker_upgrade_evidence_invalid' }
        $materialIndex[$material.name] = [ordered]@{bytes=$readback.Length;sha256=$hash}
    }
    foreach ($binding in @(@{path=$ReceiptPath;raw=$receiptRaw},@{path=$inventoryPath;raw=$inventoryRaw},
        @{path=$Backup.path;raw=$backupRaw},@{path=$manifestPath;raw=$manifestRaw})) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        $current = [Zeb.WorkerInstall.Native]::ReadBytes($binding.path)
        if ($current.Length -ne $binding.raw.Length -or (Get-WorkerBytesHash $current) -cne (Get-WorkerBytesHash $binding.raw)) {
            throw 'worker_upgrade_evidence_invalid'
        }
    }
    $index = [ordered]@{schemaVersion=1;operationId=$Evidence.OperationId;materials=$materialIndex;
        backupReceipt=[ordered]@{path=$Backup.path;bytes=$backupRaw.Length;sha256=(Get-WorkerBytesHash $backupRaw)};
        backupManifest=[ordered]@{path=$manifestPath;bytes=$manifestRaw.Length;sha256=(Get-WorkerBytesHash $manifestRaw)};
        directories=@('store','records','engine','config','tls')}
    $indexRaw = [Text.UTF8Encoding]::new($false,$true).GetBytes(($index | ConvertTo-Json -Depth 32 -Compress)+[char]10)
    $indexPath = [IO.Path]::Combine($root,'verified-backup.json')
    $null = Get-WorkerRemainingMilliseconds $Deadline
    New-WorkerCallerFile -Path $indexPath -Bytes $indexRaw
    Assert-WorkerCallerDirectory $root
    $saved = [Zeb.WorkerInstall.Native]::ReadBytes($indexPath)
    if ($saved.Length -ne $indexRaw.Length -or (Get-WorkerBytesHash $saved) -cne (Get-WorkerBytesHash $indexRaw) -or
        [Zeb.WorkerInstall.Native]::Children($root).Count -ne 4) { throw 'worker_upgrade_evidence_invalid' }
    $null = Get-WorkerRemainingMilliseconds $Deadline
    $Evidence.EvidencePath = $indexPath; $Evidence.EvidenceSha256 = Get-WorkerBytesHash $indexRaw
}

function Assert-WorkerGeneration {
    param($Generation, $Receipt, [switch]$AllowUnboundBoot)
    $versionRoot = Get-WorkerVersionRoot $Receipt.programRoot $Receipt.active.version
    if ($Generation.exists -ne $true -or $Generation.status -cne 'Running' -or
        $Generation.serviceName -cne 'ZebImageEnhancement' -or $Generation.accountName -cne 'NT SERVICE\ZebImageEnhancement' -or
        $Generation.imagePath -cne $Receipt.active.imagePath -or $Generation.sessionId -ne 0 -or
        $Generation.tokenUserSid -cne $Generation.candidateSid -or
        ($null -ne $Receipt.tokenUserSid -and $Receipt.tokenUserSid -cne $Generation.tokenUserSid) -or
        $Generation.host.pid -le 0 -or $Generation.node.pid -le 0 -or
        $Generation.host.sessionId -ne 0 -or $Generation.node.sessionId -ne 0 -or
        $Generation.host.tokenUserSid -cne $Generation.tokenUserSid -or $Generation.node.tokenUserSid -cne $Generation.tokenUserSid -or
        [long]$Generation.node.creationFileTime -lt [long]$Generation.host.creationFileTime -or
        -not (Test-WorkerSamePath $Generation.host.imagePath ([System.IO.Path]::Combine($versionRoot, 'WindowsServiceHost.exe'))) -or
        -not (Test-WorkerSamePath $Generation.node.imagePath ([System.IO.Path]::Combine($versionRoot, 'runtime', 'node.exe'))) -or
        $Generation.endpoint.scheme -cnotin @('http', 'https') -or
        $Generation.endpoint.ownerPid -ne $Generation.node.pid -or $Generation.endpoint.bootId -cne $Generation.bootId) { throw 'worker_identity_unknown' }
    if (-not $AllowUnboundBoot -or $null -ne $Generation.bootId) { Assert-WorkerUuid $Generation.bootId }
}

function Assert-WorkerSameGeneration {
    param($First, $Second, $Receipt)
    Assert-WorkerGeneration -Generation $Second -Receipt $Receipt -AllowUnboundBoot
    if (($null -ne $Second.bootId -and $First.bootId -cne $Second.bootId) -or $First.host.pid -ne $Second.host.pid -or
        $First.host.creationFileTime -cne $Second.host.creationFileTime -or $First.node.pid -ne $Second.node.pid -or
        $First.node.creationFileTime -cne $Second.node.creationFileTime -or
        $First.endpoint.scheme -cne $Second.endpoint.scheme -or
        $First.endpoint.host -cne $Second.endpoint.host -or $First.endpoint.port -ne $Second.endpoint.port) { throw 'worker_identity_unknown' }
    $Second.bootId = $First.bootId; $Second.endpoint.bootId = $First.bootId
}

function Test-WorkerQuiescent {
    param($Snapshot, [string]$BootId)
    Assert-WorkerUuid $Snapshot.bootId
    if ($Snapshot.bootId -cne $BootId -or $Snapshot.sealed -ne $true -or $Snapshot.state -cnotin @('draining', 'quiescent') -or
        $Snapshot.http.sealed -ne $true -or $null -eq $Snapshot.runtime -or $Snapshot.runtime.closing -ne $false -or
        $Snapshot.runtime.startupRecovery -cne 'settled' -or $Snapshot.runtime.runner.closed -ne $false -or
        $Snapshot.runtime.runner.storeClosed -ne $false -or $Snapshot.runtime.runner.recoveryState -ceq 'unknown' -or
        $Snapshot.runtime.runner.ownedState -ceq 'unknown' -or $Snapshot.runtime.adapter.sealed -ne $false -or
        $Snapshot.runtime.adapter.close -cne 'not_requested' -or $Snapshot.runtime.adapter.activity -cin @('unknown', 'cleanup_unknown')) { throw 'worker_maintenance_unknown' }
    foreach ($count in @($Snapshot.store.queued, $Snapshot.store.running, $Snapshot.store.slots, $Snapshot.store.unreleasedReferences,
        $Snapshot.http.uploads, $Snapshot.http.downloads, $Snapshot.http.receipts,
        $Snapshot.pending.selfTestAdmission, $Snapshot.pending.selfTestOutputRead, $Snapshot.pending.runner, $Snapshot.pending.adapter)) {
        if (-not (Test-WorkerPackageInteger $count)) { throw 'worker_maintenance_unknown' }
    }
    $zero = $Snapshot.store.running -eq 0 -and $Snapshot.store.slots -eq 0 -and $Snapshot.store.unreleasedReferences -eq 0 -and
        $Snapshot.http.uploads -eq 0 -and $Snapshot.http.downloads -eq 0 -and $Snapshot.http.receipts -eq 0 -and
        $Snapshot.pending.selfTestAdmission -eq 0 -and $Snapshot.pending.selfTestOutputRead -eq 0 -and
        $Snapshot.pending.runner -eq 0 -and $Snapshot.pending.adapter -eq 0 -and
        $Snapshot.runtime.runner.recoveryState -ceq 'idle' -and $Snapshot.runtime.runner.recoveryInFlight -eq $false -and
        $Snapshot.runtime.runner.ownedState -ceq 'none' -and $Snapshot.runtime.adapter.activity -ceq 'idle'
    if ($Snapshot.state -ceq 'quiescent' -and $Snapshot.canStop -eq $true -and $zero) { return $true }
    if ($Snapshot.state -ceq 'draining' -and $Snapshot.canStop -eq $false) { return $false }
    throw 'worker_maintenance_unknown'
}

function Assert-WorkerExclusiveSnapshot {
    param($Receipt, [DateTime]$Deadline)
    $pins = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) {
            $items = @(Get-WorkerTree ([System.IO.Path]::Combine($Receipt.dataRoot, $name)))
            foreach ($item in ($items | Sort-Object { $_.path.Length } -Descending)) {
                $pins.Add((Open-WorkerExclusiveObject -LiteralPath $item.path -Deadline $Deadline))
            }
        }
    } finally { foreach ($pin in $pins) { $pin.Dispose() } }
}

function New-WorkerOperation {
    param([string]$Action, $TargetSha256)
    return [pscustomobject]@{ operationId=[Guid]::NewGuid().ToString(); action=$Action; stage='prepared';
        outcome='pending'; maintenanceBootId=$null; targetSha256=$TargetSha256 }
}

function Get-WorkerPublicResult {
    param([string]$Code, [string]$OperationId, $Receipt, [string]$Outcome, [int]$ExitCode)
    $value = [ordered]@{ code=$Code; operationId=$OperationId; outcome=$Outcome }
    if ($null -ne $Receipt) {
        $value['installationId'] = $Receipt.installationId; $value['serviceId'] = $Receipt.serviceId; $value['clientId'] = $Receipt.clientId
        $value['version'] = $Receipt.active.version
        if ($null -ne $Receipt.previous) { $value['previousVersion'] = $Receipt.previous.version }
    }
    return [pscustomobject]@{ value=[pscustomobject]$value; exitCode=$ExitCode }
}

function Save-WorkerStage {
    param([string]$Path, $Receipt, [string]$Stage, [string]$Outcome)
    $Receipt.operation.stage = $Stage; $Receipt.operation.outcome = $Outcome
    Write-WorkerLedger -Path $Path -Value $Receipt
}

function Write-WorkerVersionConfig {
    param([string]$VersionRoot, [byte[]]$Bytes, [string]$ExpectedHash)
    $path = [System.IO.Path]::Combine($VersionRoot, 'app', 'worker.config.json')
    if ([System.IO.File]::Exists($path)) {
        if ([Zeb.WorkerInstall.Native]::Hash($path) -cne $ExpectedHash) { throw 'worker_configuration_invalid' }
    } else { New-WorkerCallerFile -Path $path -Bytes $Bytes }
}

function Invoke-WorkerConfigurationCheck {
    param([string]$VersionRoot, [string]$ConfigPath, [DateTime]$Deadline)
    return Invoke-WorkerNodeProcess -ExecutablePath ([System.IO.Path]::Combine($VersionRoot, 'runtime', 'node.exe')) -Arguments @(
        ([System.IO.Path]::Combine($VersionRoot, 'app', 'manage.mjs')), 'validate-config', $ConfigPath) -Deadline $Deadline
}

function Assert-WorkerConfigurationResult {
    param($Value)
    Assert-WorkerProcessResult $Value
    $parsed = ConvertFrom-Json -InputObject $Value.stdout -ErrorAction Stop
    Assert-WorkerObject $parsed @('configurationValid')
    if ($parsed.configurationValid -ne $true) { throw 'worker_configuration_invalid' }
}

function Assert-WorkerStartupWindow {
    param($Capture, [DateTime]$Deadline)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    if ($Capture.Disposed -or [Zeb.WorkerInstall.Native]::TickCount64() -ge $Capture.Context['cutoffTick64']) {
        throw 'worker_startup_observation_unknown'
    }
}

function Write-WorkerStartupIntent {
    param($Capture, $Receipt, $ReceiptPath)
    if ($args.Count -ne 0 -or $null -eq $Capture -or $Capture.Disposed -or $null -eq $Capture.CallerPin -or
        $null -ne $Capture.IntentPath -or $null -ne $Capture.IntentSha256) { throw 'worker_startup_intent_unknown' }
    $context = [Zeb.WorkerInstall.Native]::ReadStartupContext($Capture.ContextRaw)
    if (($context | ConvertTo-Json -Depth 8 -Compress) -cne ($Capture.Context | ConvertTo-Json -Depth 8 -Compress) -or
        [Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_intent_unknown' }
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.CallerPin.Pin)
    $caller = $Capture.CallerPin.Pin; $claimed = $context['caller']
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { if ($null -eq $identity.User -or $identity.User.Value -cne $caller.tokenUserSid -or
        $identity.ImpersonationLevel -ne [Security.Principal.TokenImpersonationLevel]::None) { throw 'worker_startup_intent_unknown' } }
    finally { $identity.Dispose() }
    if ($caller.pid -ne $PID -or $claimed['pid'] -ne $caller.pid -or $claimed['creationFileTime'] -cne $caller.creationFileTime -or
        -not [string]::Equals($claimed['imagePath'],$caller.imagePath,[StringComparison]::OrdinalIgnoreCase) -or
        $claimed['imageSha256'] -cne $Capture.CallerPin.ImageSha256 -or $claimed['tokenUserSid'] -cne $caller.tokenUserSid -or
        $claimed['sessionId'] -ne $caller.sessionId -or $context['expectedServiceSid'] -cne $Capture.ExpectedServiceSid) { throw 'worker_startup_intent_unknown' }
    $sourceSha = Get-WorkerBytesHash ([IO.File]::ReadAllBytes($MyInvocation.MyCommand.Module.Path))
    if ($Capture.SourceModuleSha256 -cne $sourceSha) { throw 'worker_startup_intent_unknown' }
    $installation = Resolve-WorkerLocalPath ([IO.Path]::Combine($Receipt.dataRoot,'installation'))
    Assert-WorkerCallerDirectory $installation
    $receiptPathFull = Resolve-WorkerLocalPath $ReceiptPath
    if (-not (Test-WorkerSamePath $receiptPathFull ([IO.Path]::Combine($installation,'receipt.json'))) -or
        [Zeb.WorkerInstall.Native]::Inspect($receiptPathFull).Bytes -gt 65536) { throw 'worker_startup_intent_unknown' }
    $diskReceipt = Read-WorkerReceipt $receiptPathFull
    Assert-WorkerUuid $Receipt.serviceId
    Assert-WorkerUuid $Receipt.clientId
    $receiptRaw = [Zeb.WorkerInstall.Native]::ReadBytes($receiptPathFull)
    if (($diskReceipt | ConvertTo-Json -Depth 64 -Compress) -cne ($Receipt | ConvertTo-Json -Depth 64 -Compress) -or
        $Receipt.operation.stage -cne 'started' -or $Receipt.operation.outcome -cne 'pending' -or
        $Capture.OperationId -cne $Receipt.operation.operationId -or $context['operationId'] -cne $Receipt.operation.operationId -or
        $context['startingReceiptSha256'] -cne (Get-WorkerBytesHash $receiptRaw) -or
        $context['inventorySha256'] -cne $Receipt.active.inventorySha256 -or $context['configSha256'] -cne $Receipt.configSha256 -or
        $context['engineManifestSha256'] -cne $Receipt.engineManifestSha256 -or
        ($null -ne $Receipt.tokenUserSid -and $context['expectedServiceSid'] -cne $Receipt.tokenUserSid)) { throw 'worker_startup_intent_unknown' }
    $root = [IO.Path]::Combine($installation,'startup-'+$context['startupAttemptId'])
    $null = Resolve-WorkerLocalPath -Path $root -AllowMissing
    if ([IO.Directory]::Exists($root) -or [IO.File]::Exists($root)) { throw 'worker_startup_intent_conflict' }
    $value = [ordered]@{v=1;kind='startup_intent';operationId=$Receipt.operation.operationId;startupAttemptId=$context['startupAttemptId'];
        installationId=$Receipt.installationId;serviceId=$Receipt.serviceId;clientId=$Receipt.clientId;active=$Receipt.active;previous=$Receipt.previous;
        sourceModuleSha256=$sourceSha;startingReceiptSha256=(Get-WorkerBytesHash $receiptRaw);contextSha256=(Get-WorkerBytesHash $Capture.ContextRaw);
        configSha256=$Receipt.configSha256;engineManifestSha256=$Receipt.engineManifestSha256;
        materials=[ordered]@{startingReceipt=[ordered]@{bytes=$receiptRaw.Length;sha256=(Get-WorkerBytesHash $receiptRaw)};
            context=[ordered]@{bytes=$Capture.ContextRaw.Length;sha256=(Get-WorkerBytesHash $Capture.ContextRaw)}};
        missingRecoveryEvidence=@('oldStop','verifiedBackup','failureCloseout')}
    $intentRaw = [Text.UTF8Encoding]::new($false,$true).GetBytes(($value | ConvertTo-Json -Depth 8 -Compress)+[char]10)
    if ($intentRaw.Length -gt 16384) { throw 'worker_startup_intent_unknown' }
    [Zeb.WorkerInstall.Native]::RequireStartupPin($caller)
    if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_intent_unknown' }
    New-WorkerCallerDirectory $root
    $materials = @(@{name='starting-receipt.json';raw=$receiptRaw},@{name='context.json';raw=$Capture.ContextRaw},@{name='intent.json';raw=$intentRaw})
    foreach ($material in $materials) {
        if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_intent_unknown' }
        New-WorkerCallerFile -Path ([IO.Path]::Combine($root,$material.name)) -Bytes $material.raw
    }
    foreach ($material in $materials) {
        $path = [IO.Path]::Combine($root,$material.name)
        Assert-WorkerCallerFile $path
        if ([Zeb.WorkerInstall.Native]::Inspect($path).Bytes -ne $material.raw.Length) { throw 'worker_startup_intent_unknown' }
        $readback = [Zeb.WorkerInstall.Native]::ReadBytes($path)
        if ($readback.Length -ne $material.raw.Length -or (Get-WorkerBytesHash $readback) -cne (Get-WorkerBytesHash $material.raw)) { throw 'worker_startup_intent_unknown' }
    }
    Assert-WorkerCallerDirectory $root
    [Zeb.WorkerInstall.Native]::RequireStartupPin($caller)
    if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_intent_unknown' }
    $Capture.IntentPath = [IO.Path]::Combine($root,'intent.json'); $Capture.IntentSha256 = Get-WorkerBytesHash $intentRaw
    try { Assert-WorkerStartupIntent -Capture $Capture -Receipt $Receipt -ReceiptPath $ReceiptPath }
    catch { $Capture.IntentPath = $null; $Capture.IntentSha256 = $null; throw }
}

function Assert-WorkerStartupIntent {
    param($Capture, $Receipt, $ReceiptPath)
    if ($args.Count -ne 0 -or $null -eq $Capture -or $Capture.Disposed -or $null -eq $Capture.CallerPin -or
        $Capture.IntentPath -isnot [string] -or $Capture.IntentSha256 -isnot [string]) { throw 'worker_startup_intent_unknown' }
    Assert-WorkerHash $Capture.IntentSha256
    $context = [Zeb.WorkerInstall.Native]::ReadStartupContext($Capture.ContextRaw)
    if (($context | ConvertTo-Json -Depth 8 -Compress) -cne ($Capture.Context | ConvertTo-Json -Depth 8 -Compress) -or
        [Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_intent_unknown' }
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.CallerPin.Pin)
    $caller = $Capture.CallerPin.Pin; $claimed = $context['caller']
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { if ($null -eq $identity.User -or $identity.User.Value -cne $caller.tokenUserSid -or
        $identity.ImpersonationLevel -ne [Security.Principal.TokenImpersonationLevel]::None) { throw 'worker_startup_intent_unknown' } }
    finally { $identity.Dispose() }
    if ($caller.pid -ne $PID -or $claimed['pid'] -ne $caller.pid -or $claimed['creationFileTime'] -cne $caller.creationFileTime -or
        -not [string]::Equals($claimed['imagePath'],$caller.imagePath,[StringComparison]::OrdinalIgnoreCase) -or
        $claimed['imageSha256'] -cne $Capture.CallerPin.ImageSha256 -or $claimed['tokenUserSid'] -cne $caller.tokenUserSid -or
        $claimed['sessionId'] -ne $caller.sessionId -or $context['expectedServiceSid'] -cne $Capture.ExpectedServiceSid) { throw 'worker_startup_intent_unknown' }
    $sourceSha = Get-WorkerBytesHash ([IO.File]::ReadAllBytes($MyInvocation.MyCommand.Module.Path))
    if ($Capture.SourceModuleSha256 -cne $sourceSha) { throw 'worker_startup_intent_unknown' }
    $installation = Resolve-WorkerLocalPath ([IO.Path]::Combine($Receipt.dataRoot,'installation'))
    Assert-WorkerCallerDirectory $installation
    $receiptPathFull = Resolve-WorkerLocalPath $ReceiptPath
    if (-not (Test-WorkerSamePath $receiptPathFull ([IO.Path]::Combine($installation,'receipt.json'))) -or
        [Zeb.WorkerInstall.Native]::Inspect($receiptPathFull).Bytes -gt 65536) { throw 'worker_startup_intent_unknown' }
    $diskReceipt = Read-WorkerReceipt $receiptPathFull
    Assert-WorkerUuid $Receipt.serviceId
    Assert-WorkerUuid $Receipt.clientId
    $receiptRaw = [Zeb.WorkerInstall.Native]::ReadBytes($receiptPathFull)
    if (($diskReceipt | ConvertTo-Json -Depth 64 -Compress) -cne ($Receipt | ConvertTo-Json -Depth 64 -Compress) -or
        $Receipt.operation.stage -cne 'started' -or $Receipt.operation.outcome -cne 'pending' -or
        $Capture.OperationId -cne $Receipt.operation.operationId -or $context['operationId'] -cne $Receipt.operation.operationId -or
        $context['startingReceiptSha256'] -cne (Get-WorkerBytesHash $receiptRaw) -or
        $context['inventorySha256'] -cne $Receipt.active.inventorySha256 -or $context['configSha256'] -cne $Receipt.configSha256 -or
        $context['engineManifestSha256'] -cne $Receipt.engineManifestSha256 -or
        ($null -ne $Receipt.tokenUserSid -and $context['expectedServiceSid'] -cne $Receipt.tokenUserSid)) { throw 'worker_startup_intent_unknown' }
    $root = [IO.Path]::Combine($installation,'startup-'+$context['startupAttemptId'])
    $intentPath = [IO.Path]::Combine($root,'intent.json')
    if (-not [string]::Equals($Capture.IntentPath,$intentPath,[StringComparison]::OrdinalIgnoreCase)) { throw 'worker_startup_intent_unknown' }
    Assert-WorkerCallerDirectory $root
    $children = @([Zeb.WorkerInstall.Native]::Children($root))
    if ($children.Count -ne 3 -or @($children | Where-Object { $_ -cnotin @('starting-receipt.json','context.json','intent.json') }).Count -ne 0) { throw 'worker_startup_intent_unknown' }
    foreach ($material in @(@{name='starting-receipt.json';raw=$receiptRaw},@{name='context.json';raw=$Capture.ContextRaw})) {
        $path = [IO.Path]::Combine($root,$material.name)
        Assert-WorkerCallerFile $path
        if ([Zeb.WorkerInstall.Native]::Inspect($path).Bytes -ne $material.raw.Length) { throw 'worker_startup_intent_unknown' }
        $saved = [Zeb.WorkerInstall.Native]::ReadBytes($path)
        if ($saved.Length -ne $material.raw.Length -or (Get-WorkerBytesHash $saved) -cne (Get-WorkerBytesHash $material.raw)) { throw 'worker_startup_intent_unknown' }
    }
    # This private, versioned intent uses one canonical encoding: exact bytes also close every object/key/scalar shape.
    $expected = [ordered]@{v=1;kind='startup_intent';operationId=$Receipt.operation.operationId;startupAttemptId=$context['startupAttemptId'];
        installationId=$Receipt.installationId;serviceId=$Receipt.serviceId;clientId=$Receipt.clientId;active=$Receipt.active;previous=$Receipt.previous;
        sourceModuleSha256=$sourceSha;startingReceiptSha256=(Get-WorkerBytesHash $receiptRaw);contextSha256=(Get-WorkerBytesHash $Capture.ContextRaw);
        configSha256=$Receipt.configSha256;engineManifestSha256=$Receipt.engineManifestSha256;
        materials=[ordered]@{startingReceipt=[ordered]@{bytes=$receiptRaw.Length;sha256=(Get-WorkerBytesHash $receiptRaw)};
            context=[ordered]@{bytes=$Capture.ContextRaw.Length;sha256=(Get-WorkerBytesHash $Capture.ContextRaw)}};
        missingRecoveryEvidence=@('oldStop','verifiedBackup','failureCloseout')}
    $expectedRaw = [Text.UTF8Encoding]::new($false,$true).GetBytes(($expected | ConvertTo-Json -Depth 8 -Compress)+[char]10)
    Assert-WorkerCallerFile $intentPath
    if ($expectedRaw.Length -gt 16384 -or [Zeb.WorkerInstall.Native]::Inspect($intentPath).Bytes -ne $expectedRaw.Length) { throw 'worker_startup_intent_unknown' }
    $intentRaw = [Zeb.WorkerInstall.Native]::ReadBytes($intentPath)
    if ($intentRaw.Length -ne $expectedRaw.Length -or (Get-WorkerBytesHash $intentRaw) -cne $Capture.IntentSha256 -or
        (Get-WorkerBytesHash $intentRaw) -cne (Get-WorkerBytesHash $expectedRaw)) { throw 'worker_startup_intent_unknown' }
    [Zeb.WorkerInstall.Native]::RequireStartupPin($caller)
    if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_intent_unknown' }
}

function New-WorkerStartupObservation {
    param($Receipt, [string]$ReceiptPath, [DateTime]$Deadline)
    Assert-WorkerUuid $Receipt.operation.operationId
    $capture = [pscustomobject]@{ OperationId=$Receipt.operation.operationId; Stage='created'; FailureStage=$null;
        Failure=$null; FailureType=$null; DiagnosticFailureType=$null; DisposeFailure=$null; Disposed=$false;
        CallerPin=$null; HostPin=$null; NodePin=$null; Pipe=$null; ContextRaw=$null; Context=$null;
        SourceModuleSha256=$null; StartArguments=$null; ExpectedServiceSid=$null; HostPath=$null; NodePath=$null;
        PreparedSha256=$null; JobName=$null; HostExited=$null; NodeExited=$null; HostExitCode=$null; NodeExitCode=$null; IntentPath=$null; IntentSha256=$null;
        RawFrames=[System.Collections.Generic.List[object]]::new() }
    $capture | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
        if (-not $this.Disposed) {
            $this.Disposed = $true
            $resources = [System.Collections.Generic.List[object]]::new()
            if ($null -ne $this.Pipe) { $resources.Add($this.Pipe) }
            if ($null -ne $this.NodePin) { $resources.Add($this.NodePin.handle) }
            if ($null -ne $this.HostPin) { $resources.Add($this.HostPin.handle) }
            if ($null -ne $this.CallerPin) { $resources.Add($this.CallerPin) }
            foreach ($resource in $resources) {
                try { $resource.Dispose() } catch { if ($null -eq $this.DisposeFailure) { $this.DisposeFailure = $_.Exception } }
            }
        }
        if ($null -ne $this.DisposeFailure) { throw $this.DisposeFailure }
    }
    try {
        $capture.Stage = 'source'
        $sourceStream = [System.IO.File]::OpenRead($MyInvocation.MyCommand.Module.Path)
        $sourceHash = [System.Security.Cryptography.SHA256]::Create()
        try { $capture.SourceModuleSha256 = [BitConverter]::ToString($sourceHash.ComputeHash($sourceStream)).Replace('-','').ToLowerInvariant() }
        finally { try { $sourceHash.Dispose() } finally { $sourceStream.Dispose() } }
        $capture.Stage = 'receipt'
        $null = Get-WorkerRemainingMilliseconds $Deadline
        Assert-WorkerCallerFile $ReceiptPath
        $receiptRaw = [Zeb.WorkerInstall.Native]::ReadBytes($ReceiptPath)
        $receiptValue = ConvertFrom-Json -InputObject ([System.Text.UTF8Encoding]::new($false,$true).GetString($receiptRaw)) -ErrorAction Stop
        if ($Receipt.operation.stage -cne 'started' -or $Receipt.operation.outcome -cne 'pending' -or
            ($receiptValue | ConvertTo-Json -Depth 64 -Compress) -cne ($Receipt | ConvertTo-Json -Depth 64 -Compress)) {
            throw 'worker_startup_observation_unknown'
        }
        $startingSha = Get-WorkerBytesHash $receiptRaw
        $versionRoot = Get-WorkerVersionRoot $Receipt.programRoot $Receipt.active.version
        $capture.HostPath = [System.IO.Path]::Combine($versionRoot,'WindowsServiceHost.exe')
        $capture.NodePath = [System.IO.Path]::Combine($versionRoot,'runtime','node.exe')
        $capture.Stage = 'materials'
        $inventoryRaw = [Zeb.WorkerInstall.Native]::ReadBytes(([System.IO.Path]::Combine($versionRoot,'package.inventory.json')))
        if ((Get-WorkerBytesHash $inventoryRaw) -cne $Receipt.active.inventorySha256) { throw 'worker_package_invalid' }
        $inventory = ConvertFrom-Json -InputObject ([System.Text.UTF8Encoding]::new($false,$true).GetString($inventoryRaw)) -ErrorAction Stop
        Assert-WorkerObject $inventory @('schemaVersion','version','storeSchemaVersion','files')
        if ($inventory.schemaVersion -ne 1 -or $inventory.storeSchemaVersion -ne 7 -or
            $inventory.version -cne $Receipt.active.version -or $inventory.files -isnot [array]) { throw 'worker_package_invalid' }
        $hashes = @{}
        foreach ($relative in @('startup-observation.v1','WindowsServiceHost.exe','runtime/node.exe')) {
            $entries = @($inventory.files | Where-Object { $_.path -ceq $relative })
            if ($entries.Count -ne 1) { throw 'worker_package_invalid' }
            $entry = $entries[0]
            Assert-WorkerObject $entry @('path','bytes','sha256')
            Assert-WorkerHash $entry.sha256
            if (-not (Test-WorkerPackageInteger $entry.bytes)) { throw 'worker_package_invalid' }
            $path = [System.IO.Path]::Combine($versionRoot,$relative.Replace('/','\'))
            $info = [Zeb.WorkerInstall.Native]::Inspect($path)
            if ($info.Directory -or $info.Bytes -ne $entry.bytes -or
                [Zeb.WorkerInstall.Native]::Hash($path) -cne $entry.sha256.ToLowerInvariant()) { throw 'worker_package_invalid' }
            $hashes[$relative] = $entry.sha256.ToLowerInvariant()
        }
        $marker = [System.Text.Encoding]::ASCII.GetBytes("ZEB_STARTUP_OBSERVATION_V1`n")
        if ($hashes['startup-observation.v1'] -cne (Get-WorkerBytesHash $marker) -or
            [Zeb.WorkerInstall.Native]::Inspect(([System.IO.Path]::Combine($versionRoot,'startup-observation.v1'))).Bytes -ne 27) {
            throw 'worker_package_invalid'
        }
        foreach ($path in @([System.IO.Path]::Combine($Receipt.dataRoot,'config','worker.config.json'),
            [System.IO.Path]::Combine($versionRoot,'app','worker.config.json'))) {
            if ([Zeb.WorkerInstall.Native]::Hash($path) -cne $Receipt.configSha256) { throw 'worker_configuration_invalid' }
        }
        if ([Zeb.WorkerInstall.Native]::Hash(([System.IO.Path]::Combine($Receipt.dataRoot,'engine','installation-manifest.json'))) -cne
            $Receipt.engineManifestSha256) { throw 'worker_engine_invalid' }
        $capture.Stage = 'service-identity'
        $sid = [System.Security.Principal.NTAccount]::new('NT SERVICE','ZebImageEnhancement').Translate([System.Security.Principal.SecurityIdentifier]).Value
        if (($null -ne $Receipt.tokenUserSid -and $Receipt.tokenUserSid -cne $sid) -or
            ($null -eq $Receipt.tokenUserSid -and $Receipt.operation.action -cne 'Install')) { throw 'worker_identity_unknown' }
        $capture.ExpectedServiceSid = $sid
        $row = Get-WorkerServiceRow
        if ($null -eq $row -or $row.State -cne 'Stopped' -or [long]$row.ProcessId -ne 0 -or
            $row.StartName -cne 'NT SERVICE\ZebImageEnhancement' -or $row.PathName -cne $Receipt.active.imagePath) { throw 'worker_identity_unknown' }
        $capture.Stage = 'caller-pin'
        $capture.CallerPin = [Zeb.WorkerInstall.Native]::PinStartupCaller()
        [Zeb.WorkerInstall.Native]::RequireStartupPin($capture.CallerPin.Pin)
        $caller = $capture.CallerPin.Pin
        $nonce = [byte[]]::new(32)
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($nonce) } finally { $random.Dispose() }
        $attempt = [Guid]::NewGuid().ToString('D')
        $remaining = Get-WorkerRemainingMilliseconds $Deadline
        $tick = [Zeb.WorkerInstall.Native]::TickCount64()
        $context = [ordered]@{ v=1; operationId=$Receipt.operation.operationId; startupAttemptId=$attempt;
            startingReceiptSha256=$startingSha; pipeName=('zeb-worker-startup-v1-'+$attempt.Replace('-',''));
            nonce=[BitConverter]::ToString($nonce).Replace('-','').ToLowerInvariant(); cutoffTick64=($tick+[long]$remaining);
            caller=[ordered]@{pid=$caller.pid;creationFileTime=$caller.creationFileTime;imagePath=$caller.imagePath;
                imageSha256=$capture.CallerPin.ImageSha256;tokenUserSid=$caller.tokenUserSid;sessionId=$caller.sessionId};
            expectedServiceSid=$sid;inventorySha256=$Receipt.active.inventorySha256;configSha256=$Receipt.configSha256;
            engineManifestSha256=$Receipt.engineManifestSha256;hostSha256=$hashes['WindowsServiceHost.exe'];nodeSha256=$hashes['runtime/node.exe'] }
        $capture.ContextRaw = [System.Text.UTF8Encoding]::new($false,$true).GetBytes(($context | ConvertTo-Json -Depth 8 -Compress))
        $capture.Context = [Zeb.WorkerInstall.Native]::ReadStartupContext($capture.ContextRaw)
        $capture.Stage = 'pipe'
        Assert-WorkerStartupWindow $capture $Deadline
        $capture.Pipe = [Zeb.WorkerInstall.Native]::NewStartupPipe($attempt,$capture.Context['cutoffTick64'])
        if ($capture.Pipe.PipeName -cne $capture.Context['pipeName']) { throw 'worker_startup_observation_unknown' }
        $encoded = [Convert]::ToBase64String($capture.ContextRaw).TrimEnd('=').Replace('+','-').Replace('/','_')
        $capture.StartArguments = [string[]]@('zeb-startup-observe-v1',$encoded)
        Assert-WorkerStartupWindow $capture $Deadline
        $capture.Stage = 'intent'
        Write-WorkerStartupIntent -Capture $capture -Receipt $Receipt -ReceiptPath $ReceiptPath
        Assert-WorkerStartupWindow $capture $Deadline
        $capture.Stage = 'prepared-to-start'
    } catch {
        $capture.Failure = $_.Exception
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        $capture.FailureType = $failure.GetType().FullName; $capture.FailureStage = $capture.Stage
    }
    return $capture
}

function Assert-WorkerStartupHost {
    param($Capture, $Receipt, [DateTime]$Deadline)
    Assert-WorkerStartupWindow $Capture $Deadline
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.CallerPin.Pin)
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.HostPin)
    $row = Get-WorkerServiceRow
    if ($null -eq $row -or $row.State -cne 'Running' -or $row.ProcessId -ne $Capture.HostPin.pid -or
        $row.StartName -cne 'NT SERVICE\ZebImageEnhancement' -or $row.PathName -cne $Receipt.active.imagePath) { throw 'worker_identity_unknown' }
    Assert-WorkerStartupWindow $Capture $Deadline
}

function Read-WorkerStartupFrame {
    param($Capture, [string]$Kind, [DateTime]$Deadline)
    Assert-WorkerStartupWindow $Capture $Deadline
    $maximum = if ($Kind -ceq 'authorized') { 1024 } else { 8192 }
    $wire = $Capture.Pipe.ReadFrame($maximum)
    $Capture.RawFrames.Add([pscustomobject]@{kind=$Kind;raw=$wire})
    Assert-WorkerStartupWindow $Capture $Deadline
    $body = [byte[]]::new($wire.Length-4)
    [Buffer]::BlockCopy($wire,4,$body,0,$body.Length)
    if ($Kind -ceq 'final') {
        try { return [Zeb.WorkerInstall.Native]::ReadStartupFrame($body,'ready') }
        catch { return [Zeb.WorkerInstall.Native]::ReadStartupFrame($body,'settled') }
    }
    return [Zeb.WorkerInstall.Native]::ReadStartupFrame($body,$Kind)
}

function Assert-WorkerStartupBindings {
    param($Capture, $Frame, [switch]$Prepared)
    foreach ($key in @('nonce','operationId','startupAttemptId')) {
        if ($Frame[$key] -cne $Capture.Context[$key]) { throw 'worker_startup_observation_unknown' }
    }
    foreach ($pair in @(@('host',$Capture.HostPin),@('node',$Capture.NodePin))) {
        if ($null -eq $pair[1]) { continue }
        $actual = $Frame[$pair[0]]; $pin = $pair[1]
        if ($actual['pid'] -ne $pin.pid -or $actual['creationFileTime'] -cne $pin.creationFileTime) { throw 'worker_identity_unknown' }
    }
    if ($Prepared) {
        foreach ($key in @('startingReceiptSha256','inventorySha256','configSha256','engineManifestSha256','hostSha256','nodeSha256')) {
            if ($Frame[$key] -cne $Capture.Context[$key]) { throw 'worker_startup_observation_unknown' }
        }
    } elseif ($Frame['preparedSha256'] -cne $Capture.PreparedSha256) { throw 'worker_startup_observation_unknown' }
}

function Read-WorkerStartupFailureFrames {
    param($Capture)
    if ($args.Count -ne 0 -or $null -eq $Capture -or $Capture.Disposed -isnot [bool] -or $Capture.Disposed -or
        $Capture.Stage -cne 'settled' -or $Capture.ContextRaw -isnot [byte[]] -or $Capture.RawFrames.Count -ne 4 -or
        $null -eq $Capture.HostPin -or $null -eq $Capture.NodePin -or
        $Capture.HostExited -isnot [bool] -or -not $Capture.HostExited -or
        $Capture.NodeExited -isnot [bool] -or -not $Capture.NodeExited -or
        $Capture.HostExitCode -isnot [uint32] -or $Capture.HostExitCode -ne 1 -or
        $Capture.NodeExitCode -isnot [uint32] -or $Capture.NodeExitCode -ne 2) { throw 'worker_startup_failure_invalid' }
    $context = [Zeb.WorkerInstall.Native]::ReadStartupContext($Capture.ContextRaw)
    if ($Capture.OperationId -cne $context['operationId'] -or
        ($context | ConvertTo-Json -Depth 8 -Compress) -cne ($Capture.Context | ConvertTo-Json -Depth 8 -Compress) -or
        $Capture.PreparedSha256 -cne (Get-WorkerBytesHash $Capture.RawFrames[0].raw)) { throw 'worker_startup_failure_invalid' }
    $frames = [Collections.Generic.List[object]]::new()
    $kinds = @('prepared','ack_prepared','authorized','settled')
    foreach ($index in 0..3) {
        $source = $Capture.RawFrames[$index]
        $expected = if ($index -eq 3) { 'final' } else { $kinds[$index] }
        $maximum = if ($index -in @(1,2)) { 1024 } else { 8192 }
        if ($source.kind -cne $expected -or $source.raw -isnot [byte[]] -or $source.raw.Length -lt 5 -or
            $source.raw.Length -gt $maximum+4 -or [BitConverter]::ToUInt32($source.raw,0) -ne $source.raw.Length-4) {
            throw 'worker_startup_failure_invalid'
        }
        $body = [byte[]]::new($source.raw.Length-4)
        [Buffer]::BlockCopy($source.raw,4,$body,0,$body.Length)
        $frame = [Zeb.WorkerInstall.Native]::ReadStartupFrame($body,$kinds[$index])
        Assert-WorkerStartupBindings -Capture $Capture -Frame $frame -Prepared:($index -eq 0)
        $frames.Add($frame)
    }
    $prepared = $frames[0]; $final = $frames[3]; $inspection = $prepared['inspection']
    if ([string]::IsNullOrWhiteSpace($prepared['jobName']) -or $prepared['jobName'] -cne $Capture.JobName -or
        $final['jobName'] -cne $Capture.JobName -or $inspection['authorized'] -or $inspection['sealed'] -or
        $inspection['processSignaled'] -or -not $inspection['inOriginalJob'] -or $inspection['activeProcesses'] -lt 1 -or
        $inspection['totalProcesses'] -lt $inspection['activeProcesses'] -or ($inspection['jobHandleFlags'] -band 1) -ne 0 -or
        ($inspection['processHandleFlags'] -band 1) -ne 0 -or -not $final.ContainsKey('cleanupFailureCount') -or
        -not $final.ContainsKey('ownerReleaseCompleted') -or $final['cleanupFailureCount'] -ne 0 -or
        -not $final['ownerReleaseCompleted'] -or -not $final['sealed'] -or $null -eq $final['ownerReleasedTreeActive'] -or
        $final['ownerReleasedTreeActive'] -ne 0 -or $final['forceCalls'] -ne 1 -or
        $final['failureType'] -cne 'InvalidOperationException') { throw 'worker_startup_failure_invalid' }
    $cleanup = $final['cleanup']; $root = $cleanup['rootExit']; $tree = $cleanup['treeExit']
    if ($null -eq $root -or $null -eq $tree -or $root['identity']['pid'] -ne $Capture.NodePin.pid -or
        $root['identity']['creationFileTime'] -cne $Capture.NodePin.creationFileTime -or $root['exitCode'] -ne $Capture.NodeExitCode -or
        $tree['engineExitCode'] -ne $Capture.NodeExitCode -or $tree['activeProcesses'] -ne 0) { throw 'worker_startup_failure_invalid' }
    foreach ($role in @('stdout','stderr')) {
        $stream = $cleanup[$role]
        if (-not $stream['eof'] -or $null -ne $stream['readFailureType'] -or $null -ne $stream['sinkFailureType']) {
            throw 'worker_startup_failure_invalid'
        }
    }
    return $frames.ToArray()
}

function Wait-WorkerStartupExit {
    param($Capture, [DateTime]$Deadline)
    if ($args.Count -ne 0 -or $null -eq $Capture -or $null -eq $Capture.CallerPin -or
        $null -eq $Capture.HostPin -or $null -eq $Capture.NodePin) { throw 'worker_startup_observation_unknown' }
    foreach ($role in @('Host','Node')) {
        Assert-WorkerStartupWindow $Capture $Deadline
        [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.CallerPin.Pin)
        $pin = $Capture.($role+'Pin')
        $remaining = [long](Get-WorkerRemainingMilliseconds $Deadline)
        $cutoffRemaining = [long]$Capture.Context['cutoffTick64'] - [Zeb.WorkerInstall.Native]::TickCount64()
        if ($cutoffRemaining -le 0) { throw 'worker_startup_observation_unknown' }
        $signaled = [Zeb.WorkerInstall.Native]::Wait($pin.handle,[uint32][Math]::Min($remaining,$cutoffRemaining))
        Assert-WorkerStartupWindow $Capture $Deadline
        [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.CallerPin.Pin)
        $Capture.($role+'Exited') = $signaled
        if (-not $signaled) { throw 'worker_startup_observation_unknown' }
        $code = [Zeb.WorkerInstall.Native]::ReadStartupExitCode($pin)
        Assert-WorkerStartupWindow $Capture $Deadline
        [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.CallerPin.Pin)
        $Capture.($role+'ExitCode') = $code
    }
}

function Receive-WorkerStartupObservation {
    param($Capture, $Receipt, [DateTime]$Deadline)
    try {
        $Capture.Stage = 'running-host'
        Assert-WorkerStartupWindow $Capture $Deadline
        $row = Get-WorkerServiceRow
        if ($null -eq $row -or $row.State -cne 'Running' -or [long]$row.ProcessId -le 0 -or [long]$row.ProcessId -gt [int]::MaxValue -or
            $row.StartName -cne 'NT SERVICE\ZebImageEnhancement' -or $row.PathName -cne $Receipt.active.imagePath) { throw 'worker_identity_unknown' }
        $Capture.HostPin = Open-WorkerProcessIdentity -ProcessId $row.ProcessId -ExpectedImagePath $Capture.HostPath
        if ($Capture.HostPin.tokenUserSid -cne $Capture.ExpectedServiceSid -or $Capture.HostPin.sessionId -ne 0 -or
            [Zeb.WorkerInstall.Native]::Hash($Capture.HostPin.imagePath) -cne $Capture.Context['hostSha256']) { throw 'worker_identity_unknown' }
        Assert-WorkerStartupHost $Capture $Receipt $Deadline
        $Capture.Stage = 'accept'
        $Capture.Pipe.Accept()
        if ($Capture.Pipe.ClientProcessId -ne $Capture.HostPin.pid) { throw 'worker_identity_unknown' }
        Assert-WorkerStartupHost $Capture $Receipt $Deadline
        $Capture.Stage = 'prepared'
        $prepared = Read-WorkerStartupFrame $Capture 'prepared' $Deadline
        Assert-WorkerStartupBindings $Capture $prepared -Prepared
        $inspection = $prepared['inspection']
        if ($inspection['authorized'] -or $inspection['sealed'] -or $inspection['processSignaled'] -or -not $inspection['inOriginalJob'] -or
            $inspection['activeProcesses'] -lt 1 -or $inspection['totalProcesses'] -lt $inspection['activeProcesses'] -or
            ($inspection['jobHandleFlags'] -band 1) -ne 0 -or ($inspection['processHandleFlags'] -band 1) -ne 0 -or
            [string]::IsNullOrEmpty($prepared['jobName'])) { throw 'worker_startup_observation_unknown' }
        $Capture.JobName = $prepared['jobName']
        $Capture.Stage = 'node-pin'
        $Capture.NodePin = Open-WorkerProcessIdentity -ProcessId $prepared['node']['pid'] -ExpectedImagePath $Capture.NodePath
        if ($Capture.NodePin.pid -eq $Capture.HostPin.pid -or $Capture.NodePin.tokenUserSid -cne $Capture.ExpectedServiceSid -or
            $Capture.NodePin.sessionId -ne 0 -or [uint64]$Capture.NodePin.creationFileTime -lt [uint64]$Capture.HostPin.creationFileTime -or
            [Zeb.WorkerInstall.Native]::Hash($Capture.NodePin.imagePath) -cne $Capture.Context['nodeSha256']) { throw 'worker_identity_unknown' }
        Assert-WorkerStartupBindings $Capture $prepared -Prepared
        $nodeRows = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$Capture.NodePin.pid) -ErrorAction Stop)
        if ($nodeRows.Count -ne 1 -or $nodeRows[0].ParentProcessId -ne $Capture.HostPin.pid -or
            -not [string]::Equals($nodeRows[0].ExecutablePath,$Capture.NodePath,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'worker_identity_unknown' }
        [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.NodePin)
        Assert-WorkerStartupHost $Capture $Receipt $Deadline
        $Capture.PreparedSha256 = Get-WorkerBytesHash $Capture.RawFrames[0].raw
        $ack = [ordered]@{v=1;kind='ack_prepared';seq=2;nonce=$Capture.Context['nonce'];operationId=$Capture.Context['operationId'];
            startupAttemptId=$Capture.Context['startupAttemptId'];preparedSha256=$Capture.PreparedSha256;
            host=[ordered]@{pid=$Capture.HostPin.pid;creationFileTime=$Capture.HostPin.creationFileTime};
            node=[ordered]@{pid=$Capture.NodePin.pid;creationFileTime=$Capture.NodePin.creationFileTime}}
        $body = [System.Text.UTF8Encoding]::new($false,$true).GetBytes(($ack | ConvertTo-Json -Depth 8 -Compress))
        $parsedAck = [Zeb.WorkerInstall.Native]::ReadStartupFrame($body,'ack_prepared')
        Assert-WorkerStartupBindings $Capture $parsedAck
        $wire = [byte[]]::new(4+$body.Length)
        [BitConverter]::GetBytes([uint32]$body.Length).CopyTo($wire,0); $body.CopyTo($wire,4)
        $Capture.RawFrames.Add([pscustomobject]@{kind='ack_prepared';raw=$wire})
        $Capture.Stage = 'ack'
        [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.NodePin)
        Assert-WorkerStartupHost $Capture $Receipt $Deadline
        $Capture.Pipe.WriteAck($wire)
        $Capture.Stage = 'authorized'
        $authorized = Read-WorkerStartupFrame $Capture 'authorized' $Deadline
        Assert-WorkerStartupBindings $Capture $authorized
        $Capture.Stage = 'final'
        $final = Read-WorkerStartupFrame $Capture 'final' $Deadline
        Assert-WorkerStartupBindings $Capture $final
        if ($final['kind'] -ceq 'settled') {
            if ($null -ne $final['jobName'] -and $final['jobName'] -cne $Capture.JobName) { throw 'worker_startup_observation_unknown' }
            $root = $final['cleanup']['rootExit']
            if ($null -ne $root -and ($root['identity']['pid'] -ne $Capture.NodePin.pid -or
                $root['identity']['creationFileTime'] -cne $Capture.NodePin.creationFileTime)) { throw 'worker_identity_unknown' }
        }
        $Capture.Stage = 'eof'
        Assert-WorkerStartupWindow $Capture $Deadline
        $Capture.Pipe.RequireEof()
        if ($final['kind'] -ceq 'ready') {
            Assert-WorkerStartupHost $Capture $Receipt $Deadline
            [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.NodePin)
        } else {
            $Capture.Stage = 'exit-wait'
            Wait-WorkerStartupExit -Capture $Capture -Deadline $Deadline
        }
        $Capture.Stage = $final['kind']
        return $final
    } catch {
        if ($null -eq $Capture.FailureType) {
            $Capture.Failure = $_.Exception; $failure = $_.Exception
            while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
            $Capture.FailureType = $failure.GetType().FullName; $Capture.FailureStage = $Capture.Stage
        }
        throw
    }
}

function Write-WorkerStartupDiagnostic {
    param($Capture, $Receipt)
    Assert-WorkerUuid $Capture.OperationId
    if ($Capture.OperationId -cne $Receipt.operation.operationId) { throw 'worker_startup_archive_unknown' }
    $directory = [System.IO.Path]::Combine($Receipt.dataRoot,'installation')
    Assert-WorkerCallerDirectory $directory
    $pins = [ordered]@{}
    foreach ($pair in @(@('caller',$(if($null -ne $Capture.CallerPin){$Capture.CallerPin.Pin}else{$null})),
        @('host',$Capture.HostPin),@('node',$Capture.NodePin))) {
        $pin = $pair[1]
        if ($null -eq $pin) { $pins[$pair[0]]=$null; continue }
        $pins[$pair[0]] = [ordered]@{pid=$pin.pid;creationFileTime=$pin.creationFileTime;imagePath=$pin.imagePath;
            tokenUserSid=$pin.tokenUserSid;sessionId=$pin.sessionId}
    }
    $frames = @($Capture.RawFrames | ForEach-Object { [ordered]@{kind=$_.kind;wireBase64=[Convert]::ToBase64String($_.raw)} })
    $contextRaw = if ($null -eq $Capture.ContextRaw) { '' } else { [Convert]::ToBase64String($Capture.ContextRaw) }
    $failure = $Capture.Failure
    while ($null -ne $failure -and $null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $nativeCode = if ($failure -is [System.ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $null }
    $value = [ordered]@{v=1;kind='startup_caller_diagnostic';operationId=$Capture.OperationId;stage=$Capture.Stage;
        failureStage=$Capture.FailureStage;failureType=$Capture.FailureType;failureNativeErrorCode=$nativeCode;sourceModuleSha256=$Capture.SourceModuleSha256;
        contextRawBase64=$contextRaw;contextSha256=$(if($null -ne $Capture.ContextRaw){Get-WorkerBytesHash $Capture.ContextRaw}else{$null});
        context=$Capture.Context;preparedSha256=$Capture.PreparedSha256;frames=$frames;frameScope='complete_returned_frames_and_ack_before_write';
        pins=$pins;hostExited=$Capture.HostExited;nodeExited=$Capture.NodeExited}
    $bytes = [System.Text.UTF8Encoding]::new($false,$true).GetBytes(($value | ConvertTo-Json -Depth 12 -Compress)+[char]10)
    New-WorkerCallerFile -Path ([System.IO.Path]::Combine($directory,'startup-'+$Capture.OperationId+'.json')) -Bytes $bytes
}


function Write-WorkerOperationDiagnostic {
    param($Receipt, [Exception]$Failure)
    Assert-WorkerUuid $Receipt.operation.operationId
    # Keep operational logs outside the data trees so recovery and explicit data deletion remain independent.
    $directory=[IO.Path]::Combine($Receipt.programRoot,'installation-diagnostics')
    if([IO.Directory]::Exists($directory)){Assert-WorkerCallerDirectory $directory}else{New-WorkerCallerDirectory $directory}
    while($null -ne $Failure.InnerException){$Failure=$Failure.InnerException}
    $nativeCode=if($Failure -is [ComponentModel.Win32Exception]){$Failure.NativeErrorCode}else{$null}
    $value=[ordered]@{v=1;kind='worker_operation_diagnostic';operationId=$Receipt.operation.operationId;
        action=$Receipt.operation.action;stage=$Receipt.operation.stage;
        failureType=$Failure.GetType().FullName;failureNativeErrorCode=$nativeCode}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Compress)+[char]10)
    New-WorkerCallerFile -Path ([IO.Path]::Combine($directory,'operation-'+$Receipt.operation.operationId+'-error.json')) -Bytes $bytes
}

function Assert-WorkerStartupFailurePins {
    param($Capture, $Receipt, [DateTime]$Deadline)
    if ($args.Count -ne 0 -or $null -eq $Capture -or $Capture.Disposed -or $Capture.Stage -cne 'settled' -or
        $null -eq $Capture.CallerPin -or $null -eq $Capture.HostPin -or $null -eq $Capture.NodePin -or
        $Deadline.Kind -ne [DateTimeKind]::Utc -or $Capture.HostExited -isnot [bool] -or -not $Capture.HostExited -or
        $Capture.NodeExited -isnot [bool] -or -not $Capture.NodeExited -or
        $Capture.HostExitCode -isnot [uint32] -or $Capture.HostExitCode -ne 1 -or
        $Capture.NodeExitCode -isnot [uint32] -or $Capture.NodeExitCode -ne 2) { throw 'worker_startup_proof_invalid' }
    Assert-WorkerStartupWindow $Capture $Deadline
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Capture.CallerPin.Pin)
    $caller = $Capture.CallerPin.Pin; $claimed = $Capture.Context['caller']
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        if ($null -eq $identity.User -or $identity.ImpersonationLevel -ne [Security.Principal.TokenImpersonationLevel]::None -or
            $identity.User.Value -cne $caller.tokenUserSid) { throw 'worker_identity_unknown' }
    } finally { $identity.Dispose() }
    if ($caller.pid -ne $PID -or $claimed['pid'] -ne $caller.pid -or $claimed['creationFileTime'] -cne $caller.creationFileTime -or
        -not (Test-WorkerSamePath $claimed['imagePath'] $caller.imagePath) -or
        $claimed['imageSha256'] -cne $Capture.CallerPin.ImageSha256 -or $claimed['tokenUserSid'] -cne $caller.tokenUserSid -or
        $claimed['sessionId'] -ne $caller.sessionId -or $Receipt.serviceName -cne 'ZebImageEnhancement' -or
        $Receipt.accountName -cne 'NT SERVICE\ZebImageEnhancement' -or $Receipt.sessionId -ne 0 -or
        $Capture.ExpectedServiceSid -cnotmatch '\AS-1-5-80-(?:[0-9]+-){4}[0-9]+\z' -or
        $Capture.Context['expectedServiceSid'] -cne $Capture.ExpectedServiceSid -or
        $Receipt.tokenUserSid -cne $Capture.ExpectedServiceSid -or $Capture.HostPin.pid -eq $Capture.NodePin.pid -or
        [uint64]$Capture.NodePin.creationFileTime -lt [uint64]$Capture.HostPin.creationFileTime) { throw 'worker_identity_unknown' }
    foreach ($role in @('Host','Node')) {
        $pin = $Capture.($role+'Pin')
        if ($pin.tokenUserSid -cne $Capture.ExpectedServiceSid -or $pin.sessionId -ne 0 -or
            -not (Test-WorkerSamePath $pin.imagePath $Capture.($role+'Path'))) { throw 'worker_identity_unknown' }
        # Exited processes are checked through the original handle; live-image APIs can fail after exit.
        $code = [Zeb.WorkerInstall.Native]::ReadStartupExitCode($pin)
        if ($code -isnot [uint32] -or $code -ne $Capture.($role+'ExitCode')) { throw 'worker_startup_proof_invalid' }
        Assert-WorkerStartupWindow $Capture $Deadline
        [Zeb.WorkerInstall.Native]::RequireStartupPin($caller)
    }
}

function New-WorkerStartupFailureProof {
    param($Capture, $Receipt, $ReceiptPath, $UpgradeEvidence, [DateTime]$Deadline)
    if ($args.Count -ne 0 -or $null -eq $Capture -or $null -eq $Receipt -or $null -eq $UpgradeEvidence -or
        $Deadline.Kind -ne [DateTimeKind]::Utc) { throw 'worker_startup_proof_invalid' }
    $null = Get-WorkerRemainingMilliseconds $Deadline
    Assert-WorkerStartupFailurePins $Capture $Receipt $Deadline
    $contextRaw = [byte[]]$Capture.ContextRaw.Clone()
    $context = [Zeb.WorkerInstall.Native]::ReadStartupContext($contextRaw)
    $json = { param($Value) $Value | ConvertTo-Json -Depth 64 -Compress }
    if ((& $json $context) -cne (& $json $Capture.Context) -or $Capture.OperationId -cne $context['operationId'] -or
        [Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_proof_invalid' }
    $utf8 = [Text.UTF8Encoding]::new($false,$true)
    $sourcePath = $MyInvocation.MyCommand.Module.Path
    $sourceSha = Get-WorkerBytesHash ([IO.File]::ReadAllBytes($sourcePath))
    if ($Capture.SourceModuleSha256 -cne $sourceSha) { throw 'worker_startup_proof_invalid' }
    $bindings = [Collections.Generic.List[object]]::new()
    $read = {
        param([string]$Path, [long]$Maximum=[long]::MaxValue, [bool]$Private=$true)
        $null = Get-WorkerRemainingMilliseconds $Deadline
        if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_proof_invalid' }
        if ($Private) { Assert-WorkerCallerFile $Path }
        $info = [Zeb.WorkerInstall.Native]::Inspect($Path)
        if ($info.Directory -or $info.Bytes -lt 0 -or $info.Bytes -gt $Maximum) { throw 'worker_startup_proof_invalid' }
        $raw = [Zeb.WorkerInstall.Native]::ReadBytes($Path)
        if ($raw.Length -ne $info.Bytes) { throw 'worker_startup_proof_invalid' }
        $bindings.Add([pscustomobject]@{path=$Path;raw=[byte[]]$raw.Clone();info=$info})
        return ,$raw
    }
    $receiptFull = Resolve-WorkerLocalPath $ReceiptPath
    $disk = Read-WorkerReceipt $receiptFull
    $failedRaw = & $read $receiptFull 65536
    $failedValue = ConvertFrom-Json -InputObject $utf8.GetString($failedRaw) -ErrorAction Stop
    if ((& $json $failedValue) -cne (& $json $disk) -or (& $json $disk) -cne (& $json $Receipt) -or $disk.state -cne 'unknown' -or
        $disk.operation.action -cne 'Upgrade' -or $disk.operation.stage -cne 'started' -or
        $disk.operation.outcome -cne 'unknown' -or $disk.operation.operationId -cne $context['operationId'] -or
        $null -eq $disk.previous -or $disk.sessionId -ne 0 -or $disk.tokenUserSid -cne $context['expectedServiceSid']) {
        throw 'worker_startup_proof_invalid'
    }
    $installation = Resolve-WorkerLocalPath ([IO.Path]::Combine($disk.dataRoot,'installation'))
    Assert-WorkerCallerDirectory $installation
    if (-not (Test-WorkerSamePath $receiptFull ([IO.Path]::Combine($installation,'receipt.json')))) { throw 'worker_startup_proof_invalid' }
    $startupRoot = Resolve-WorkerLocalPath ([IO.Path]::Combine($installation,'startup-'+$context['startupAttemptId']))
    Assert-WorkerCallerDirectory $startupRoot
    $intentPath = [IO.Path]::Combine($startupRoot,'intent.json')
    Assert-WorkerHash $Capture.IntentSha256
    if ($Capture.IntentPath -isnot [string] -or -not (Test-WorkerSamePath $Capture.IntentPath $intentPath) -or
        (@([Zeb.WorkerInstall.Native]::Children($startupRoot) | Sort-Object) -join ',') -cne 'context.json,intent.json,starting-receipt.json') {
        throw 'worker_startup_proof_invalid'
    }
    $startingRaw = & $read ([IO.Path]::Combine($startupRoot,'starting-receipt.json')) 65536
    $savedContext = & $read ([IO.Path]::Combine($startupRoot,'context.json')) 4096
    $intentRaw = & $read $intentPath 16384
    if ([Convert]::ToBase64String($savedContext) -cne [Convert]::ToBase64String($contextRaw) -or
        (Get-WorkerBytesHash $startingRaw) -cne $context['startingReceiptSha256'] -or
        (Get-WorkerBytesHash $intentRaw) -cne $Capture.IntentSha256) { throw 'worker_startup_proof_invalid' }
    $starting = ConvertFrom-Json -InputObject $utf8.GetString($startingRaw) -ErrorAction Stop
    if ($starting.state -cne 'installed' -or $starting.operation.stage -cne 'started' -or $starting.operation.outcome -cne 'pending') {
        throw 'worker_startup_proof_invalid'
    }
    $expectedFailed = (& $json $starting) | ConvertFrom-Json
    $expectedFailed.state = 'unknown'; $expectedFailed.operation.outcome = 'unknown'
    if ((& $json $expectedFailed) -cne (& $json $disk) -or $context['inventorySha256'] -cne $starting.active.inventorySha256 -or
        $context['configSha256'] -cne $starting.configSha256 -or $context['engineManifestSha256'] -cne $starting.engineManifestSha256 -or
        $starting.operation.targetSha256 -cne $starting.active.inventorySha256) { throw 'worker_startup_proof_invalid' }
    $expectedIntent = [ordered]@{v=1;kind='startup_intent';operationId=$starting.operation.operationId;startupAttemptId=$context['startupAttemptId'];
        installationId=$starting.installationId;serviceId=$starting.serviceId;clientId=$starting.clientId;active=$starting.active;previous=$starting.previous;
        sourceModuleSha256=$sourceSha;startingReceiptSha256=(Get-WorkerBytesHash $startingRaw);contextSha256=(Get-WorkerBytesHash $contextRaw);
        configSha256=$starting.configSha256;engineManifestSha256=$starting.engineManifestSha256;
        materials=[ordered]@{startingReceipt=[ordered]@{bytes=$startingRaw.Length;sha256=(Get-WorkerBytesHash $startingRaw)};
            context=[ordered]@{bytes=$contextRaw.Length;sha256=(Get-WorkerBytesHash $contextRaw)}};
        missingRecoveryEvidence=@('oldStop','verifiedBackup','failureCloseout')}
    $expectedIntentRaw = $utf8.GetBytes(($expectedIntent | ConvertTo-Json -Depth 8 -Compress)+[char]10)
    if ([Convert]::ToBase64String($intentRaw) -cne [Convert]::ToBase64String($expectedIntentRaw)) { throw 'worker_startup_proof_invalid' }
    $frames = @(Read-WorkerStartupFailureFrames $Capture)
    if ($frames.Count -ne 4) { throw 'worker_startup_proof_invalid' }
    $wires = @($Capture.RawFrames | ForEach-Object { ,([byte[]]$_.raw.Clone()) })
    $preparedSha = Get-WorkerBytesHash $wires[0]
    if ($preparedSha -cne $Capture.PreparedSha256) { throw 'worker_startup_proof_invalid' }

    Assert-WorkerObject $UpgradeEvidence @('OperationId','OldActive','MaintenanceDtoRaw','MaintenanceDtoSha256','First','Second',
        'ScmStopCalls','HostExitCode','NodeExitCode','PinsExclusive','BackupResult','BackupBinding','EvidencePath','EvidenceSha256')
    Assert-WorkerHash $UpgradeEvidence.EvidenceSha256
    Assert-WorkerHash $UpgradeEvidence.MaintenanceDtoSha256
    $upgradeRoot = Resolve-WorkerLocalPath ([IO.Path]::Combine($installation,'upgrade-'+$context['operationId']))
    $upgradePath = [IO.Path]::Combine($upgradeRoot,'verified-backup.json')
    Assert-WorkerCallerDirectory $upgradeRoot
    if ($UpgradeEvidence.OperationId -cne $context['operationId'] -or $UpgradeEvidence.EvidencePath -isnot [string] -or
        -not (Test-WorkerSamePath $UpgradeEvidence.EvidencePath $upgradePath) -or
        $UpgradeEvidence.PinsExclusive -isnot [bool] -or -not $UpgradeEvidence.PinsExclusive -or $UpgradeEvidence.ScmStopCalls -ne 1 -or
        $UpgradeEvidence.HostExitCode -isnot [uint32] -or $UpgradeEvidence.HostExitCode -ne 0 -or
        $UpgradeEvidence.NodeExitCode -isnot [uint32] -or $UpgradeEvidence.NodeExitCode -ne 0 -or
        (& $json $UpgradeEvidence.OldActive) -cne (& $json $starting.previous) -or
        (@([Zeb.WorkerInstall.Native]::Children($upgradeRoot) | Sort-Object) -join ',') -cne
            'maintenance-dto.json,old-package.inventory.json,old-stop.json,verified-backup.json') { throw 'worker_startup_proof_invalid' }
    $upgradeRaw = & $read $upgradePath
    if ((Get-WorkerBytesHash $upgradeRaw) -cne $UpgradeEvidence.EvidenceSha256) { throw 'worker_startup_proof_invalid' }
    $index = ConvertFrom-Json -InputObject $utf8.GetString($upgradeRaw) -ErrorAction Stop
    Assert-WorkerObject $index @('schemaVersion','operationId','materials','backupReceipt','backupManifest','directories')
    Assert-WorkerObject $index.materials @('maintenance-dto.json','old-package.inventory.json','old-stop.json')
    if ($index.schemaVersion -ne 1 -or $index.operationId -cne $context['operationId'] -or
        ($index.directories -join ',') -cne 'store,records,engine,config,tls') { throw 'worker_startup_proof_invalid' }
    $oldMaterial = @{}
    foreach ($name in @('maintenance-dto.json','old-package.inventory.json','old-stop.json')) {
        $raw = & $read ([IO.Path]::Combine($upgradeRoot,$name))
        $declaration = $index.materials.PSObject.Properties[$name].Value
        Assert-WorkerObject $declaration @('bytes','sha256')
        Assert-WorkerHash $declaration.sha256
        if (-not (Test-WorkerPackageInteger $declaration.bytes) -or $declaration.bytes -ne $raw.Length -or
            $declaration.sha256 -cne (Get-WorkerBytesHash $raw)) { throw 'worker_startup_proof_invalid' }
        $oldMaterial[$name] = $raw
    }
    $oldStop = ConvertFrom-Json -InputObject $utf8.GetString($oldMaterial['old-stop.json']) -ErrorAction Stop
    Assert-WorkerObject $oldStop @('schemaVersion','operationId','source','oldActive','maintenanceDtoSha256','first','second',
        'scmStopCalls','hostExitCode','nodeExitCode','pinsExclusive','stoppedReceiptRawBase64','stoppedReceiptSha256')
    Assert-WorkerHash $oldStop.stoppedReceiptSha256
    $stoppedRaw = [Convert]::FromBase64String($oldStop.stoppedReceiptRawBase64)
    if ($stoppedRaw.Length -gt 65536 -or [Convert]::ToBase64String($stoppedRaw) -cne $oldStop.stoppedReceiptRawBase64 -or
        (Get-WorkerBytesHash $stoppedRaw) -cne $oldStop.stoppedReceiptSha256) { throw 'worker_startup_proof_invalid' }
    $stopped = ConvertFrom-Json -InputObject $utf8.GetString($stoppedRaw) -ErrorAction Stop
    if ($stopped.state -cne 'installed' -or $stopped.operation.action -cne 'Upgrade' -or $stopped.operation.stage -cne 'stopped' -or
        $stopped.operation.outcome -cne 'known' -or $stopped.operation.operationId -cne $context['operationId'] -or
        (& $json $stopped.active) -cne (& $json $UpgradeEvidence.OldActive) -or $null -eq $stopped.lastStopped) { throw 'worker_startup_proof_invalid' }
    $expectedStarting = (& $json $stopped) | ConvertFrom-Json
    $expectedStarting.previous = (& $json $UpgradeEvidence.OldActive) | ConvertFrom-Json
    $expectedStarting.active = (& $json $starting.active) | ConvertFrom-Json
    $expectedStarting.operation.stage = 'started'; $expectedStarting.operation.outcome = 'pending'
    if ((& $json $expectedStarting) -cne (& $json $starting)) { throw 'worker_startup_proof_invalid' }
    $expectedOldStop = [ordered]@{schemaVersion=1;operationId=$UpgradeEvidence.OperationId;source='derivedFromQualifiedHostContract';
        oldActive=$UpgradeEvidence.OldActive;maintenanceDtoSha256=$UpgradeEvidence.MaintenanceDtoSha256;
        first=$UpgradeEvidence.First;second=$UpgradeEvidence.Second;scmStopCalls=$UpgradeEvidence.ScmStopCalls;
        hostExitCode=$UpgradeEvidence.HostExitCode;nodeExitCode=$UpgradeEvidence.NodeExitCode;pinsExclusive=$UpgradeEvidence.PinsExclusive;
        stoppedReceiptRawBase64=[Convert]::ToBase64String($stoppedRaw);stoppedReceiptSha256=(Get-WorkerBytesHash $stoppedRaw)}
    $expectedOldStopRaw = $utf8.GetBytes(($expectedOldStop | ConvertTo-Json -Depth 32 -Compress)+[char]10)
    if ([Convert]::ToBase64String($expectedOldStopRaw) -cne [Convert]::ToBase64String($oldMaterial['old-stop.json']) -or
        $UpgradeEvidence.MaintenanceDtoRaw -isnot [byte[]] -or $UpgradeEvidence.MaintenanceDtoRaw.Length -gt 65536 -or
        [Convert]::ToBase64String($UpgradeEvidence.MaintenanceDtoRaw) -cne [Convert]::ToBase64String($oldMaterial['maintenance-dto.json']) -or
        (Get-WorkerBytesHash $oldMaterial['maintenance-dto.json']) -cne $UpgradeEvidence.MaintenanceDtoSha256) { throw 'worker_startup_proof_invalid' }
    $dto = ConvertFrom-Json -InputObject $utf8.GetString($oldMaterial['maintenance-dto.json']) -ErrorAction Stop
    if (-not (Test-WorkerQuiescent $dto $stopped.operation.maintenanceBootId) -or $dto.store.queued -ne 0 -or
        $stopped.lastStopped.bootId -cne $dto.bootId -or $stopped.lastStopped.pinsExclusive -isnot [bool] -or
        -not $stopped.lastStopped.pinsExclusive) { throw 'worker_startup_proof_invalid' }
    $oldRoot = Get-WorkerVersionRoot $disk.programRoot $UpgradeEvidence.OldActive.version
    $newRoot = Get-WorkerVersionRoot $disk.programRoot $disk.active.version
    foreach ($generation in @($UpgradeEvidence.First,$UpgradeEvidence.Second)) {
        Assert-WorkerObject $generation @('bootId','endpoint','host','node')
        Assert-WorkerObject $generation.endpoint @('scheme','host','port','ownerPid','bootId')
        if ($generation.bootId -cne $dto.bootId -or $generation.endpoint.bootId -cne $dto.bootId -or
            $generation.endpoint.scheme -cnotin @('http','https') -or $generation.endpoint.host -isnot [string] -or
            [string]::IsNullOrWhiteSpace($generation.endpoint.host) -or -not (Test-WorkerPackageInteger $generation.endpoint.port) -or
            $generation.endpoint.port -lt 1 -or $generation.endpoint.port -gt 65535 -or
            $generation.endpoint.ownerPid -ne $generation.node.pid) { throw 'worker_startup_proof_invalid' }
        foreach ($role in @('host','node')) {
            $pin = $generation.$role; $saved = $stopped.lastStopped.$role
            Assert-WorkerObject $pin @('pid','creationFileTime','imagePath','tokenUserSid','sessionId')
            $image = if ($role -ceq 'host') { [IO.Path]::Combine($oldRoot,'WindowsServiceHost.exe') } else { [IO.Path]::Combine($oldRoot,'runtime','node.exe') }
            if (-not (Test-WorkerPackageInteger $pin.pid) -or $pin.pid -lt 1 -or $pin.pid -ne $saved.pid -or
                $pin.creationFileTime -isnot [string] -or $pin.creationFileTime -cnotmatch '\A[1-9][0-9]*\z' -or
                $pin.creationFileTime -cne $saved.creationFileTime -or $pin.tokenUserSid -cne $stopped.tokenUserSid -or
                $pin.sessionId -ne 0 -or -not (Test-WorkerSamePath $pin.imagePath $image)) { throw 'worker_startup_proof_invalid' }
        }
    }
    if ((& $json $UpgradeEvidence.First) -cne (& $json $UpgradeEvidence.Second)) { throw 'worker_startup_proof_invalid' }
    $oldPayload = Test-WorkerInstalledPayload $oldRoot $UpgradeEvidence.OldActive.inventorySha256 $disk.configSha256
    $newPayload = Test-WorkerInstalledPayload $newRoot $disk.active.inventorySha256 $disk.configSha256
    if ($newPayload.startupObservationV1 -ne $true) { throw 'worker_startup_proof_invalid' }
    $oldInventoryRaw = & $read ([IO.Path]::Combine($oldRoot,'package.inventory.json')) ([long]::MaxValue) $false
    $newInventoryRaw = & $read ([IO.Path]::Combine($newRoot,'package.inventory.json')) ([long]::MaxValue) $false
    if ([Convert]::ToBase64String($oldInventoryRaw) -cne [Convert]::ToBase64String($oldMaterial['old-package.inventory.json']) -or
        (Get-WorkerBytesHash $newInventoryRaw) -cne $context['inventorySha256']) { throw 'worker_startup_proof_invalid' }
    $oldInventory = ConvertFrom-Json -InputObject $utf8.GetString($oldInventoryRaw) -ErrorAction Stop
    $newInventory = ConvertFrom-Json -InputObject $utf8.GetString($newInventoryRaw) -ErrorAction Stop
    foreach ($inventory in @($oldInventory,$newInventory)) {
        foreach ($required in @('WindowsServiceHost.dll','WindowsSupervisor.dll','WindowsSupervisor.deps.json','WindowsSupervisor.runtimeconfig.json')) {
            if (@($inventory.files | Where-Object { $_.path -ceq $required }).Count -ne 1) { throw 'worker_startup_proof_invalid' }
        }
    }
    $marker = & $read ([IO.Path]::Combine($oldRoot,'orderly-stop-contract.v1')) 29 $false
    $startupMarker = & $read ([IO.Path]::Combine($newRoot,'startup-observation.v1')) 27 $false
    if ([Text.Encoding]::ASCII.GetString($marker) -cne ("ZEB_ORDERLY_STOP_CONTRACT_V1"+[char]10) -or
        [Text.Encoding]::ASCII.GetString($startupMarker) -cne ("ZEB_STARTUP_OBSERVATION_V1"+[char]10)) { throw 'worker_startup_proof_invalid' }
    foreach ($entry in @(
        @{path=[IO.Path]::Combine($newRoot,'WindowsServiceHost.exe');sha=$context['hostSha256']},
        @{path=[IO.Path]::Combine($newRoot,'runtime','node.exe');sha=$context['nodeSha256']},
        @{path=[IO.Path]::Combine($disk.dataRoot,'config','worker.config.json');sha=$disk.configSha256},
        @{path=[IO.Path]::Combine($disk.dataRoot,'engine','installation-manifest.json');sha=$disk.engineManifestSha256}
    )) {
        $raw = & $read $entry.path ([long]::MaxValue) $false
        if ((Get-WorkerBytesHash $raw) -cne $entry.sha) { throw 'worker_startup_proof_invalid' }
    }
    Assert-WorkerObject $UpgradeEvidence.BackupResult @('path','value')
    Assert-WorkerObject $UpgradeEvidence.BackupBinding @('path','valueJson','receiptSha256')
    $backup = $UpgradeEvidence.BackupResult; $binding = $UpgradeEvidence.BackupBinding
    Assert-WorkerHash $binding.receiptSha256
    if ($backup.path -cne $binding.path -or (& $json $backup.value) -cne $binding.valueJson) { throw 'worker_startup_proof_invalid' }
    $verified = Read-WorkerBackup $backup.path $disk
    if ((& $json $verified.value) -cne $binding.valueJson) { throw 'worker_startup_proof_invalid' }
    $manifestPath = [IO.Path]::Combine($verified.value.root,'manifest.json')
    $backupRaw = & $read $backup.path
    $manifestRaw = & $read $manifestPath
    if ((Get-WorkerBytesHash $backupRaw) -cne $binding.receiptSha256 -or
        (Get-WorkerBytesHash $manifestRaw) -cne $verified.value.manifestSha256) { throw 'worker_startup_proof_invalid' }
    foreach ($pair in @(@{value=$index.backupReceipt;path=$backup.path;raw=$backupRaw},@{value=$index.backupManifest;path=$manifestPath;raw=$manifestRaw})) {
        Assert-WorkerObject $pair.value @('path','bytes','sha256')
        if ($pair.value.path -cne $pair.path -or -not (Test-WorkerPackageInteger $pair.value.bytes) -or
            $pair.value.bytes -ne $pair.raw.Length -or $pair.value.sha256 -cne (Get-WorkerBytesHash $pair.raw)) { throw 'worker_startup_proof_invalid' }
    }
    $failedSnapshot = Get-WorkerSnapshot $disk.dataRoot
    Assert-WorkerSnapshot -Root $disk.dataRoot -Manifest $failedSnapshot -Security
    $snapshotRaw = $utf8.GetBytes(($failedSnapshot | ConvertTo-Json -Depth 32 -Compress)+[char]10)
    $existing = @([pscustomobject]@{name='starting-receipt.json';raw=[byte[]]$startingRaw.Clone()},
        [pscustomobject]@{name='context.json';raw=[byte[]]$contextRaw.Clone()},[pscustomobject]@{name='intent.json';raw=[byte[]]$intentRaw.Clone()})
    $new = [Collections.Generic.List[object]]::new()
    $new.Add([pscustomobject]@{name='failed-receipt.json';raw=[byte[]]$failedRaw.Clone()})
    foreach ($i in 0..3) { $new.Add([pscustomobject]@{name=@('prepared.frame','ack-prepared.frame','authorized.frame','settled.frame')[$i];raw=[byte[]]$wires[$i].Clone()}) }
    $new.Add([pscustomobject]@{name='failed-snapshot.json';raw=[byte[]]$snapshotRaw.Clone()})
    $materials = [ordered]@{}
    foreach ($material in @($existing)+@($new.ToArray())) { $materials[$material.name] = [ordered]@{bytes=$material.raw.Length;sha256=(Get-WorkerBytesHash $material.raw)} }
    $pins = [ordered]@{caller=$context['caller']}
    foreach ($role in @('host','node')) {
        $pin = $Capture.($role+'Pin')
        $pins[$role] = [ordered]@{pid=$pin.pid;creationFileTime=$pin.creationFileTime;imagePath=$pin.imagePath;tokenUserSid=$pin.tokenUserSid;sessionId=$pin.sessionId}
    }
    $proof = [ordered]@{v=1;kind='startup_failure_proof';operationId=$context['operationId'];startupAttemptId=$context['startupAttemptId'];
        installationId=$disk.installationId;serviceId=$disk.serviceId;clientId=$disk.clientId;tokenUserSid=$disk.tokenUserSid;sessionId=$disk.sessionId;
        active=$disk.active;previous=$disk.previous;configSha256=$disk.configSha256;engineManifestSha256=$disk.engineManifestSha256;tlsSha256=$disk.tlsSha256;
        failedReceiptSha256=(Get-WorkerBytesHash $failedRaw);sourceModuleSha256=$sourceSha;startingReceiptSha256=(Get-WorkerBytesHash $startingRaw);
        contextSha256=(Get-WorkerBytesHash $contextRaw);preparedSha256=$preparedSha;jobName=$frames[0]['jobName'];phase=$frames[3]['phase'];pins=$pins;
        exits=[ordered]@{hostExitCode=$Capture.HostExitCode;nodeExitCode=$Capture.NodeExitCode;pipeEof=$true};
        upgradeEvidence=[ordered]@{path=$upgradePath;sha256=(Get-WorkerBytesHash $upgradeRaw)};
        backup=[ordered]@{path=$backup.path;sha256=(Get-WorkerBytesHash $backupRaw);manifestPath=$manifestPath;manifestSha256=(Get-WorkerBytesHash $manifestRaw)};
        failedSnapshotSha256=(Get-WorkerBytesHash $snapshotRaw);deadlineUtcTicks=$Deadline.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);
        cutoffTick64=$context['cutoffTick64'];materials=$materials;
        closeout=[ordered]@{captureReleased=$true;privilegesRestored=$true;installationLocksReleased=$true}}
    $proofRaw = $utf8.GetBytes(($proof | ConvertTo-Json -Depth 32 -Compress)+[char]10)
    if ($proofRaw.Length -gt 65536) { throw 'worker_startup_proof_invalid' }
    foreach ($bound in $bindings) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        $info = [Zeb.WorkerInstall.Native]::Inspect($bound.path)
        $currentRaw = [Zeb.WorkerInstall.Native]::ReadBytes($bound.path)
        if ($info.Identity -cne $bound.info.Identity -or $info.SecuritySddl -cne $bound.info.SecuritySddl -or
            $info.CreationUtc -cne $bound.info.CreationUtc -or $info.LastWriteUtc -cne $bound.info.LastWriteUtc -or
            $info.Attributes -ne $bound.info.Attributes -or [Convert]::ToBase64String($currentRaw) -cne [Convert]::ToBase64String($bound.raw)) {
            throw 'worker_startup_proof_invalid'
        }
    }
    $null = Test-WorkerInstalledPayload $oldRoot $UpgradeEvidence.OldActive.inventorySha256 $disk.configSha256
    $null = Test-WorkerInstalledPayload $newRoot $disk.active.inventorySha256 $disk.configSha256
    # Backup objects stay caller-only; the manifest retains source ACLs for restoration.
    $null = Read-WorkerBackup $backup.path $disk
    Assert-WorkerSnapshot -Root $disk.dataRoot -Manifest $failedSnapshot -Security
    if ((Get-WorkerBytesHash ([IO.File]::ReadAllBytes($sourcePath))) -cne $sourceSha -or
        (& $json $Receipt) -cne (& $json $disk) -or [Convert]::ToBase64String($Capture.ContextRaw) -cne [Convert]::ToBase64String($contextRaw) -or
        $Capture.RawFrames.Count -ne 4 -or
        (@([Zeb.WorkerInstall.Native]::Children($startupRoot) | Sort-Object) -join ',') -cne 'context.json,intent.json,starting-receipt.json' -or
        (@([Zeb.WorkerInstall.Native]::Children($upgradeRoot) | Sort-Object) -join ',') -cne
            'maintenance-dto.json,old-package.inventory.json,old-stop.json,verified-backup.json') { throw 'worker_startup_proof_invalid' }
    foreach ($i in 0..3) {
        if ([Convert]::ToBase64String($Capture.RawFrames[$i].raw) -cne [Convert]::ToBase64String($wires[$i])) { throw 'worker_startup_proof_invalid' }
    }
    Assert-WorkerStartupFailurePins $Capture $Receipt $Deadline
    $null = Get-WorkerRemainingMilliseconds $Deadline
    if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $context['cutoffTick64']) { throw 'worker_startup_proof_invalid' }
    return [pscustomobject]@{OperationId=$context['operationId'];StartupAttemptId=$context['startupAttemptId'];DataRoot=$disk.dataRoot;ReceiptPath=$receiptFull;
        FailedReceiptRaw=[byte[]]$failedRaw.Clone();SourceModuleSha256=$sourceSha;ContextCutoffTick64=$context['cutoffTick64'];DeadlineUtcTicks=$Deadline.Ticks;
        ExistingMaterials=$existing;NewMaterials=$new.ToArray();ProofRaw=$proofRaw;
        Closeout=[pscustomobject]@{captureReleased=$false;privilegesRestored=$false;installationLocksReleased=$false};PublishedPath=$null;PublishedSha256=$null}
}

function Write-WorkerStartupFailureProof {
    param($Evidence, [DateTime]$Deadline)
    $null = Get-WorkerRemainingMilliseconds $Deadline
    Assert-WorkerObject $Evidence @('OperationId','StartupAttemptId','DataRoot','ReceiptPath','FailedReceiptRaw','SourceModuleSha256',
        'ContextCutoffTick64','DeadlineUtcTicks','ExistingMaterials','NewMaterials','ProofRaw','Closeout','PublishedPath','PublishedSha256')
    Assert-WorkerObject $Evidence.Closeout @('captureReleased','privilegesRestored','installationLocksReleased')
    foreach ($key in @('captureReleased','privilegesRestored','installationLocksReleased')) {
        if ($Evidence.Closeout.$key -isnot [bool] -or -not $Evidence.Closeout.$key) { throw 'worker_startup_proof_invalid' }
    }
    if ($args.Count -ne 0 -or $Deadline.Kind -ne [DateTimeKind]::Utc -or $Evidence.DeadlineUtcTicks -isnot [long] -or
        $Evidence.DeadlineUtcTicks -ne $Deadline.Ticks -or $Evidence.ContextCutoffTick64 -isnot [long] -or
        [Zeb.WorkerInstall.Native]::TickCount64() -ge $Evidence.ContextCutoffTick64 -or
        $null -ne $Evidence.PublishedPath -or $null -ne $Evidence.PublishedSha256 -or
        $Evidence.PSObject.Properties['PublishedPath'] -isnot [Management.Automation.PSNoteProperty] -or
        $Evidence.PSObject.Properties['PublishedSha256'] -isnot [Management.Automation.PSNoteProperty] -or
        $Evidence.FailedReceiptRaw -isnot [byte[]] -or $Evidence.FailedReceiptRaw.Length -gt 65536 -or
        $Evidence.ProofRaw -isnot [byte[]] -or $Evidence.ProofRaw.Length -gt 65536 -or
        $Evidence.ExistingMaterials -isnot [array] -or $Evidence.ExistingMaterials.Count -ne 3 -or
        $Evidence.NewMaterials -isnot [array] -or $Evidence.NewMaterials.Count -ne 6) { throw 'worker_startup_proof_invalid' }
    Assert-WorkerUuid $Evidence.OperationId
    Assert-WorkerUuid $Evidence.StartupAttemptId
    Assert-WorkerHash $Evidence.SourceModuleSha256
    if ([Zeb.WorkerInstall.Native]::Hash($MyInvocation.MyCommand.Module.Path) -cne $Evidence.SourceModuleSha256) {
        throw 'worker_startup_proof_invalid'
    }
    $receipt = Read-WorkerReceipt $Evidence.ReceiptPath
    $receiptSha = Get-WorkerBytesHash $Evidence.FailedReceiptRaw
    if (-not (Test-WorkerSamePath $receipt.dataRoot $Evidence.DataRoot) -or $receipt.state -cne 'unknown' -or
        $receipt.operation.action -cne 'Upgrade' -or $receipt.operation.stage -cne 'started' -or
        $receipt.operation.outcome -cne 'unknown' -or $receipt.operation.operationId -cne $Evidence.OperationId -or
        [Zeb.WorkerInstall.Native]::Hash($Evidence.ReceiptPath) -cne $receiptSha) { throw 'worker_startup_proof_invalid' }
    $utf8 = [Text.UTF8Encoding]::new($false,$true)
    $proof = ConvertFrom-Json -InputObject ($utf8.GetString($Evidence.ProofRaw)) -ErrorAction Stop
    foreach ($key in @('v','kind','operationId','startupAttemptId','failedReceiptSha256','sourceModuleSha256',
        'deadlineUtcTicks','cutoffTick64','materials','closeout')) {
        $property = $proof.PSObject.Properties[$key]
        if ($null -eq $property -or $property.Name -cne $key) { throw 'worker_startup_proof_invalid' }
    }
    $canonical = $utf8.GetBytes(($proof | ConvertTo-Json -Depth 32 -Compress)+[char]10)
    $proofSha = Get-WorkerBytesHash $Evidence.ProofRaw
    if ((Get-WorkerBytesHash $canonical) -cne $proofSha -or ($proof.v -isnot [int] -and $proof.v -isnot [long]) -or
        $proof.v -ne 1 -or $proof.kind -cne 'startup_failure_proof' -or $proof.operationId -cne $Evidence.OperationId -or
        $proof.startupAttemptId -cne $Evidence.StartupAttemptId -or $proof.failedReceiptSha256 -cne $receiptSha -or
        $proof.sourceModuleSha256 -cne $Evidence.SourceModuleSha256 -or $proof.deadlineUtcTicks -isnot [string] -or
        $proof.deadlineUtcTicks -cne $Deadline.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -or
        ($proof.cutoffTick64 -isnot [int] -and $proof.cutoffTick64 -isnot [long]) -or
        $proof.cutoffTick64 -ne $Evidence.ContextCutoffTick64 -or
        ($proof.closeout | ConvertTo-Json -Compress) -cne ($Evidence.Closeout | ConvertTo-Json -Compress)) {
        throw 'worker_startup_proof_invalid'
    }
    $oldNames = @('starting-receipt.json','context.json','intent.json')
    $newNames = @('failed-receipt.json','prepared.frame','ack-prepared.frame','authorized.frame','settled.frame','failed-snapshot.json')
    $names = $oldNames+$newNames
    Assert-WorkerObject $proof.materials $names
    $materials = @($Evidence.ExistingMaterials)+@($Evidence.NewMaterials)
    foreach ($index in 0..8) {
        $material = $materials[$index]; $declaration = $proof.materials.PSObject.Properties[$names[$index]].Value
        Assert-WorkerObject $material @('name','raw')
        Assert-WorkerObject $declaration @('bytes','sha256')
        if ($material.name -cne $names[$index] -or $material.raw -isnot [byte[]] -or
            ($declaration.bytes -isnot [int] -and $declaration.bytes -isnot [long]) -or
            $declaration.bytes -ne $material.raw.Length -or $declaration.sha256 -cne (Get-WorkerBytesHash $material.raw)) {
            throw 'worker_startup_proof_invalid'
        }
    }
    if ((Get-WorkerBytesHash $Evidence.NewMaterials[0].raw) -cne $receiptSha) { throw 'worker_startup_proof_invalid' }
    $installation = Resolve-WorkerLocalPath ([IO.Path]::Combine($Evidence.DataRoot,'installation'))
    Assert-WorkerCallerDirectory $installation
    $root = Resolve-WorkerLocalPath ([IO.Path]::Combine($installation,'startup-'+$Evidence.StartupAttemptId))
    Assert-WorkerCallerDirectory $root
    $children = @([Zeb.WorkerInstall.Native]::Children($root))
    if ($children.Count -ne 3 -or @($children | Where-Object { $_ -cnotin $oldNames }).Count -ne 0) {
        throw 'worker_startup_proof_conflict'
    }
    foreach ($material in $Evidence.ExistingMaterials) {
        $path = [IO.Path]::Combine($root,$material.name)
        Assert-WorkerCallerFile $path
        if ([Zeb.WorkerInstall.Native]::Hash($path) -cne (Get-WorkerBytesHash $material.raw)) { throw 'worker_startup_proof_invalid' }
    }
    foreach ($material in $Evidence.NewMaterials) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $Evidence.ContextCutoffTick64) { throw 'worker_startup_proof_invalid' }
        New-WorkerCallerFile -Path ([IO.Path]::Combine($root,$material.name)) -Bytes $material.raw
    }
    $pending = [IO.Path]::Combine($root,'failure-proof.pending.json')
    $final = [IO.Path]::Combine($root,'failure-proof.json')
    $null = Get-WorkerRemainingMilliseconds $Deadline
    if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $Evidence.ContextCutoffTick64) { throw 'worker_startup_proof_invalid' }
    New-WorkerCallerFile -Path $pending -Bytes $Evidence.ProofRaw
    foreach ($material in $materials+@([pscustomobject]@{name='failure-proof.pending.json';raw=$Evidence.ProofRaw})) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $Evidence.ContextCutoffTick64) { throw 'worker_startup_proof_invalid' }
        $path = [IO.Path]::Combine($root,$material.name)
        Assert-WorkerCallerFile $path
        $saved = [Zeb.WorkerInstall.Native]::ReadBytes($path)
        if ($saved.Length -ne $material.raw.Length -or (Get-WorkerBytesHash $saved) -cne (Get-WorkerBytesHash $material.raw)) {
            throw 'worker_startup_proof_invalid'
        }
    }
    Assert-WorkerCallerDirectory $root
    $children = @([Zeb.WorkerInstall.Native]::Children($root))
    if ($children.Count -ne 10 -or @($children | Where-Object { $_ -cnotin ($names+@('failure-proof.pending.json')) }).Count -ne 0 -or
        [Zeb.WorkerInstall.Native]::Hash($Evidence.ReceiptPath) -cne $receiptSha -or
        [Zeb.WorkerInstall.Native]::Hash($MyInvocation.MyCommand.Module.Path) -cne $Evidence.SourceModuleSha256) { throw 'worker_startup_proof_invalid' }
    $null = Get-WorkerRemainingMilliseconds $Deadline
    if ([Zeb.WorkerInstall.Native]::TickCount64() -ge $Evidence.ContextCutoffTick64) { throw 'worker_startup_proof_invalid' }
    # No fallible qualification check follows the no-overwrite publication.
    [Zeb.WorkerInstall.Native]::MoveObject($pending,$final)
    $Evidence.PublishedPath = $final; $Evidence.PublishedSha256 = $proofSha
}

function Start-WorkerOwnedService {
    param($Receipt, [string]$ReceiptPath, [DateTime]$Deadline, [switch]$Create, [switch]$Switch, [ref]$StartupCapture, [switch]$DeferCompletion)
    $created = $null; $running = $null; $capture = $null
    try {
        $versionRoot = Get-WorkerVersionRoot $Receipt.programRoot $Receipt.active.version
        $payload = Test-WorkerInstalledPayload -PayloadRoot $versionRoot -ExpectedInventorySha256 $Receipt.active.inventorySha256 -ExpectedConfigSha256 $Receipt.configSha256
        if ($payload.startupObservationV1 -isnot [bool]) { throw 'worker_package_invalid' }
        $observe = $payload.startupObservationV1
        if (($null -ne $StartupCapture -and $null -ne $StartupCapture.Value) -or
            ($observe -and (-not $PSBoundParameters.ContainsKey('StartupCapture') -or $null -eq $StartupCapture))) { throw 'worker_input_invalid' }
        if ($Create) {
            Save-WorkerStage $ReceiptPath $Receipt 'service_created' 'pending'
            Invoke-WorkerScmChange -Action CreateDemand -ImagePath $Receipt.active.imagePath -Deadline $Deadline
            $created = Get-WorkerServiceGeneration -Receipt $Receipt -Deadline $Deadline
            if ($created.exists -ne $true -or $created.status -cne 'Stopped' -or $null -eq $created.candidateSid -or
                ($null -ne $Receipt.tokenUserSid -and $Receipt.tokenUserSid -cne $created.candidateSid)) { throw 'worker_identity_unknown' }
            $acl = Set-WorkerResourceAcl -Receipt $Receipt -CandidateSid $created.candidateSid -Deadline $Deadline
            if ($acl.verified -ne $true -or $acl.candidateSid -cne $created.candidateSid) { throw 'worker_acl_unknown' }
        }
        if ($Switch) {
            $acl = Set-WorkerResourceAcl -Receipt $Receipt -CandidateSid $Receipt.tokenUserSid -Deadline $Deadline
            if ($acl.verified -ne $true -or $acl.candidateSid -cne $Receipt.tokenUserSid) { throw 'worker_acl_unknown' }
            Save-WorkerStage $ReceiptPath $Receipt 'switched' 'pending'
            Invoke-WorkerScmChange -Action SetImagePath -ImagePath $Receipt.active.imagePath -Deadline $Deadline
        }
        Save-WorkerStage $ReceiptPath $Receipt 'started' 'pending'
        if ($observe) {
            $capture = New-WorkerStartupObservation -Receipt $Receipt -ReceiptPath $ReceiptPath -Deadline $Deadline
            $StartupCapture.Value = $capture
            if ($null -eq $capture) { throw 'worker_startup_observation_unknown' }
            if ($null -ne $capture.FailureType) { throw $capture.Failure }
            if (($Create -and $created.candidateSid -cne $capture.ExpectedServiceSid) -or
                ($null -ne $Receipt.tokenUserSid -and $Receipt.tokenUserSid -cne $capture.ExpectedServiceSid)) { throw 'worker_identity_unknown' }
            $capture.Stage = 'intent-readback'
            Assert-WorkerStartupIntent -Capture $capture -Receipt $Receipt -ReceiptPath $ReceiptPath
            Assert-WorkerStartupWindow $capture $Deadline
            $capture.Stage = 'scm-start'
            Invoke-WorkerScmChange -Action Start -ImagePath $Receipt.active.imagePath -Deadline $Deadline -StartupArguments $capture.StartArguments
            $final = Receive-WorkerStartupObservation -Capture $capture -Receipt $Receipt -Deadline $Deadline
            if ($final.kind -cne 'ready') { throw 'worker_startup_observation_unknown' }
        } else {
            Invoke-WorkerScmChange -Action Start -ImagePath $Receipt.active.imagePath -Deadline $Deadline
        }
        $running = Get-WorkerServiceGeneration -Receipt $Receipt -Deadline $Deadline -WaitForReady
        if ($observe -and ($running.host.pid -ne $capture.HostPin.pid -or $running.host.creationFileTime -cne $capture.HostPin.creationFileTime -or
            $running.node.pid -ne $capture.NodePin.pid -or $running.node.creationFileTime -cne $capture.NodePin.creationFileTime)) { throw 'worker_identity_unknown' }
        Assert-WorkerGeneration -Generation $running -Receipt $Receipt -AllowUnboundBoot
        if ($null -eq $running.bootId) {
            $observation = Invoke-WorkerMaintenanceHttp -Method GET -Generation $running -Bearer $script:WorkerBearer -Deadline $Deadline
            Assert-WorkerUuid $observation.bootId
            $running.bootId = $observation.bootId; $running.endpoint.bootId = $observation.bootId
        }
        Assert-WorkerGeneration $running $Receipt
        $Receipt.tokenUserSid = $running.tokenUserSid; $Receipt.sessionId = 0
        Invoke-WorkerScmChange -Action SetAutomatic -ImagePath $Receipt.active.imagePath -Generation $running -Deadline $Deadline
        if ($DeferCompletion) {
            Save-WorkerStage $ReceiptPath $Receipt 'started' 'pending'
        } else {
            $Receipt.state = 'installed'
            Save-WorkerStage $ReceiptPath $Receipt 'started' 'known'
        }
    } finally {
        if ($null -ne $running) { $running.Dispose() }
        if ($null -ne $created) { $created.Dispose() }
    }
}

function Stop-WorkerOwnedService {
    param($Receipt, [string]$ReceiptPath, [DateTime]$Deadline, [bool]$Resume, [ref]$UpgradeEvidence)
    if ($PSBoundParameters.ContainsKey('UpgradeEvidence') -and
        ($null -eq $UpgradeEvidence -or $null -ne $UpgradeEvidence.Value)) { throw 'worker_input_invalid' }
    $first = $null; $second = $null; $candidate = $null
    try {
        $first = Get-WorkerServiceGeneration -Receipt $Receipt -Deadline $Deadline
        Assert-WorkerGeneration -Generation $first -Receipt $Receipt -AllowUnboundBoot
        if ($Resume) {
            if ($null -ne $first.bootId -and $Receipt.operation.maintenanceBootId -cne $first.bootId) { throw 'worker_identity_unknown' }
            $first.bootId = $Receipt.operation.maintenanceBootId; $first.endpoint.bootId = $Receipt.operation.maintenanceBootId
        }
        Save-WorkerStage $ReceiptPath $Receipt 'maintenance' 'pending'
        $method = if ($Resume) { 'GET' } else { 'POST' }
        $snapshot = Invoke-WorkerMaintenanceHttp -Method $method -Generation $first -Bearer $script:WorkerBearer -Deadline $Deadline
        if ($null -eq $first.bootId) {
            Assert-WorkerUuid $snapshot.bootId
            $first.bootId = $snapshot.bootId; $first.endpoint.bootId = $snapshot.bootId
        }
        $quiescent = Test-WorkerQuiescent -Snapshot $snapshot -BootId $first.bootId
        $Receipt.operation.maintenanceBootId = $first.bootId
        if (-not $quiescent) {
            Save-WorkerStage $ReceiptPath $Receipt 'maintenance' 'known'
            return $false
        }
        $second = Get-WorkerServiceGeneration -Receipt $Receipt -Deadline $Deadline
        Assert-WorkerSameGeneration $first $second $Receipt
        Save-WorkerStage $ReceiptPath $Receipt 'maintenance' 'known'
        Save-WorkerStage $ReceiptPath $Receipt 'stopped' 'pending'
        Invoke-WorkerScmChange -Action Stop -ImagePath $Receipt.active.imagePath -Generation $first -Deadline $Deadline
        Assert-WorkerExclusiveSnapshot -Receipt $Receipt -Deadline $Deadline
        $Receipt.lastStopped = [pscustomobject]@{ bootId=$first.bootId; host=[pscustomobject]@{
                pid=$first.host.pid; creationFileTime=$first.host.creationFileTime };
            node=[pscustomobject]@{ pid=$first.node.pid; creationFileTime=$first.node.creationFileTime }; pinsExclusive=$true }
        Save-WorkerStage $ReceiptPath $Receipt 'stopped' 'known'
        if ($null -ne $UpgradeEvidence -and $Receipt.operation.action -ceq 'Upgrade' -and $snapshot.store.queued -eq 0) {
            try {
                $null = Get-WorkerRemainingMilliseconds $Deadline
                $hostCode = [Zeb.WorkerInstall.Native]::ReadStartupExitCode($first.host)
                $nodeCode = [Zeb.WorkerInstall.Native]::ReadStartupExitCode($first.node)
                if ($hostCode -eq 0 -and $nodeCode -eq 0) {
                    $generations = @($first, $second) | ForEach-Object {
                        $generation = $_
                        $projection = [ordered]@{ bootId=$generation.bootId; endpoint=[pscustomobject]@{
                            scheme=$generation.endpoint.scheme;host=$generation.endpoint.host;port=$generation.endpoint.port;
                            ownerPid=$generation.endpoint.ownerPid;bootId=$generation.endpoint.bootId} }
                        foreach ($role in @('host','node')) {
                            $pin = $generation.$role
                            $projection[$role] = [pscustomobject]@{pid=$pin.pid;creationFileTime=$pin.creationFileTime;
                                imagePath=$pin.imagePath;tokenUserSid=$pin.tokenUserSid;sessionId=$pin.sessionId}
                        }
                        [pscustomobject]$projection
                    }
                    $dtoRaw = [Text.UTF8Encoding]::new($false,$true).GetBytes(($snapshot | ConvertTo-Json -Depth 12 -Compress)+[char]10)
                    $candidate = [pscustomobject]@{OperationId=$Receipt.operation.operationId;
                        OldActive=[pscustomobject]@{version=$Receipt.active.version;inventorySha256=$Receipt.active.inventorySha256;imagePath=$Receipt.active.imagePath};
                        MaintenanceDtoRaw=$dtoRaw;MaintenanceDtoSha256=(Get-WorkerBytesHash $dtoRaw);
                        First=$generations[0];Second=$generations[1];ScmStopCalls=1;HostExitCode=$hostCode;NodeExitCode=$nodeCode;PinsExclusive=$true}
                }
            } catch { $candidate = $null }
        }
    } finally {
        if ($null -ne $second) { $second.Dispose() }
        if ($null -ne $first) { $first.Dispose() }
    }
    # Publish only after the original generation handles were released successfully.
    if ($null -ne $candidate) { $UpgradeEvidence.Value = $candidate }
    return $true
}

function Read-WorkerInternalRecovery {
    param([hashtable]$Request, [DateTime]$Deadline)
    $null=Get-WorkerRemainingMilliseconds $Deadline
    $receiptPath=Resolve-WorkerLocalPath $Request.Receipt
    $receipt=Read-WorkerReceipt $receiptPath
    $raw=[Zeb.WorkerInstall.Native]::ReadBytes($receiptPath)
    if((Get-WorkerBytesHash $raw) -cne $Request.ExpectedFailedReceiptSha256 -or
        $receipt.state -cne 'unknown' -or $receipt.operation.action -cne 'Upgrade' -or
        $receipt.operation.stage -cne 'started' -or $receipt.operation.outcome -cne 'unknown' -or $null -eq $receipt.previous){throw 'worker_state_invalid'}
    $unknown=[IO.Path]::Combine($receipt.dataRoot,'installation','unknown-process.json')
    if([IO.File]::Exists($unknown) -or [IO.Directory]::Exists($unknown)){throw 'worker_process_unknown'}
    $backupPath=Resolve-WorkerLocalPath $Request.BackupReceipt
    if([Zeb.WorkerInstall.Native]::Hash($backupPath) -cne $Request.ExpectedBackupReceiptSha256){throw 'worker_backup_invalid'}
    $backup=Read-WorkerBackup $backupPath $receipt
    $bound=@(foreach($path in @($receiptPath,$backupPath,([IO.Path]::Combine($backup.value.root,'manifest.json')))){
        [pscustomobject]@{path=$path;info=[Zeb.WorkerInstall.Native]::Inspect($path);raw=[Zeb.WorkerInstall.Native]::ReadBytes($path)}
    })
    $null=Get-WorkerRemainingMilliseconds $Deadline
    return [pscustomobject]@{receipt=$receipt;receiptPath=$receiptPath;failedRaw=$raw;backup=$backup;bound=$bound;
        proofRaw=$null;failedSnapshot=$null;failedSnapshotRaw=$null}
}

function Read-WorkerRecoveryEvidence {
    param([hashtable]$Request, [DateTime]$Deadline)
    if(-not $Request.ContainsKey('FailureProof')){return Read-WorkerInternalRecovery $Request $Deadline}
    $utf8 = [Text.UTF8Encoding]::new($false,$true)
    $json = { param($Value) $Value | ConvertTo-Json -Depth 64 -Compress }
    $bound = [Collections.Generic.List[object]]::new()
    $read = {
        param([string]$Path, [long]$Maximum=[long]::MaxValue)
        $null = Get-WorkerRemainingMilliseconds $Deadline
        Assert-WorkerCallerFile $Path
        $info = [Zeb.WorkerInstall.Native]::Inspect($Path)
        if ($info.Directory -or $info.Bytes -lt 1 -or $info.Bytes -gt $Maximum) { throw 'worker_startup_proof_invalid' }
        $raw = [Zeb.WorkerInstall.Native]::ReadBytes($Path)
        if ($raw.Length -ne $info.Bytes) { throw 'worker_startup_proof_invalid' }
        $bound.Add([pscustomobject]@{path=$Path;raw=$raw;info=$info})
        return ,$raw
    }
    $receiptPath = Resolve-WorkerLocalPath $Request.Receipt
    $receipt = Read-WorkerReceipt $receiptPath
    $failedRaw = & $read $receiptPath 65536
    if ((Get-WorkerBytesHash $failedRaw) -cne $Request.ExpectedFailedReceiptSha256.ToLowerInvariant() -or
        $receipt.operation.operationId -cne $Request.FailedOperationId -or $receipt.state -cne 'unknown' -or
        $receipt.operation.action -cne 'Upgrade' -or $receipt.operation.stage -cne 'started' -or
        $receipt.operation.outcome -cne 'unknown' -or $null -eq $receipt.previous -or $receipt.sessionId -ne 0) {
        throw 'worker_startup_proof_invalid'
    }
    $proofPath = Resolve-WorkerLocalPath $Request.FailureProof
    $proofRaw = & $read $proofPath 65536
    if ((Get-WorkerBytesHash $proofRaw) -cne $Request.ExpectedFailureProofSha256.ToLowerInvariant()) { throw 'worker_startup_proof_invalid' }
    $proof = ConvertFrom-Json -InputObject $utf8.GetString($proofRaw) -ErrorAction Stop
    Assert-WorkerObject $proof @('v','kind','operationId','startupAttemptId','installationId','serviceId','clientId','tokenUserSid','sessionId',
        'active','previous','configSha256','engineManifestSha256','tlsSha256','failedReceiptSha256','sourceModuleSha256','startingReceiptSha256',
        'contextSha256','preparedSha256','jobName','phase','pins','exits','upgradeEvidence','backup','failedSnapshotSha256',
        'deadlineUtcTicks','cutoffTick64','materials','closeout')
    if (-not (Test-WorkerJsonVersionOne $proof.v) -or $proof.kind -cne 'startup_failure_proof' -or
        (Get-WorkerBytesHash $utf8.GetBytes((& $json $proof)+[char]10)) -cne (Get-WorkerBytesHash $proofRaw) -or
        $proof.sourceModuleSha256 -cne [Zeb.WorkerInstall.Native]::Hash($MyInvocation.MyCommand.Module.Path) -or
        $proof.failedReceiptSha256 -cne (Get-WorkerBytesHash $failedRaw)) { throw 'worker_startup_proof_invalid' }
    foreach ($key in @('installationId','serviceId','clientId','tokenUserSid','sessionId','configSha256','engineManifestSha256','tlsSha256')) {
        if ($proof.$key -cne $receipt.$key) { throw 'worker_startup_proof_invalid' }
    }
    if ($proof.operationId -cne $Request.FailedOperationId -or (& $json $proof.active) -cne (& $json $receipt.active) -or
        (& $json $proof.previous) -cne (& $json $receipt.previous)) { throw 'worker_startup_proof_invalid' }
    Assert-WorkerUuid $proof.startupAttemptId
    $installation = [IO.Path]::Combine($receipt.dataRoot,'installation')
    Assert-WorkerCallerDirectory $installation
    $root = Resolve-WorkerLocalPath ([IO.Path]::Combine($installation,'startup-'+$proof.startupAttemptId))
    Assert-WorkerCallerDirectory $root
    if (-not (Test-WorkerSamePath $proofPath ([IO.Path]::Combine($root,'failure-proof.json')))) { throw 'worker_startup_proof_invalid' }
    $names = @('starting-receipt.json','context.json','intent.json','failed-receipt.json','prepared.frame',
        'ack-prepared.frame','authorized.frame','settled.frame','failed-snapshot.json')
    Assert-WorkerObject $proof.materials $names
    $children = @([Zeb.WorkerInstall.Native]::Children($root))
    if ($children.Count -ne 10 -or @($children | Where-Object { $_ -cnotin ($names+@('failure-proof.json')) }).Count -ne 0) {
        throw 'worker_startup_proof_invalid'
    }
    $raws = @{}
    foreach ($name in $names) {
        $declaration = $proof.materials.PSObject.Properties[$name].Value
        Assert-WorkerObject $declaration @('bytes','sha256')
        Assert-WorkerHash $declaration.sha256
        if (-not (Test-WorkerPackageInteger $declaration.bytes) -or $declaration.bytes -lt 1) { throw 'worker_startup_proof_invalid' }
        $maximum = if ($name -ceq 'context.json') { 4096 } elseif ($name.EndsWith('.frame')) { 8196 }
            elseif ($name -ceq 'intent.json') { 16384 } elseif ($name.EndsWith('receipt.json')) { 65536 } else { [long]::MaxValue }
        $raws[$name] = & $read ([IO.Path]::Combine($root,$name)) $maximum
        if ($raws[$name].Length -ne $declaration.bytes -or (Get-WorkerBytesHash $raws[$name]) -cne $declaration.sha256) {
            throw 'worker_startup_proof_invalid'
        }
    }
    if ((Get-WorkerBytesHash $raws['failed-receipt.json']) -cne (Get-WorkerBytesHash $failedRaw) -or
        (Get-WorkerBytesHash $raws['starting-receipt.json']) -cne $proof.startingReceiptSha256 -or
        (Get-WorkerBytesHash $raws['context.json']) -cne $proof.contextSha256 -or
        (Get-WorkerBytesHash $raws['failed-snapshot.json']) -cne $proof.failedSnapshotSha256) { throw 'worker_startup_proof_invalid' }
    $starting = ConvertFrom-Json -InputObject $utf8.GetString($raws['starting-receipt.json']) -ErrorAction Stop
    $expectedFailed = (& $json $starting) | ConvertFrom-Json
    if ($starting.state -cne 'installed' -or $starting.operation.stage -cne 'started' -or $starting.operation.outcome -cne 'pending') {
        throw 'worker_startup_proof_invalid'
    }
    $expectedFailed.state='unknown'; $expectedFailed.operation.outcome='unknown'
    if ((& $json $expectedFailed) -cne (& $json $receipt)) { throw 'worker_startup_proof_invalid' }
    $context = [Zeb.WorkerInstall.Native]::ReadStartupContext($raws['context.json'])
    if ($context['operationId'] -cne $proof.operationId -or $context['startupAttemptId'] -cne $proof.startupAttemptId -or
        $context['startingReceiptSha256'] -cne $proof.startingReceiptSha256 -or $context['expectedServiceSid'] -cne $receipt.tokenUserSid -or
        $context['inventorySha256'] -cne $receipt.active.inventorySha256 -or $context['configSha256'] -cne $receipt.configSha256 -or
        $context['engineManifestSha256'] -cne $receipt.engineManifestSha256 -or $context['cutoffTick64'] -ne $proof.cutoffTick64 -or
        $receipt.operation.targetSha256 -cne $receipt.active.inventorySha256 -or $proof.deadlineUtcTicks -isnot [string] -or
        $proof.deadlineUtcTicks -cnotmatch '\A[1-9][0-9]*\z') { throw 'worker_startup_proof_invalid' }
    $originalTicks = 0L
    if (-not [long]::TryParse($proof.deadlineUtcTicks,[ref]$originalTicks) -or $originalTicks -gt [DateTime]::MaxValue.Ticks) {
        throw 'worker_startup_proof_invalid'
    }
    $expectedIntent = [ordered]@{v=1;kind='startup_intent';operationId=$starting.operation.operationId;startupAttemptId=$proof.startupAttemptId;
        installationId=$starting.installationId;serviceId=$starting.serviceId;clientId=$starting.clientId;active=$starting.active;previous=$starting.previous;
        sourceModuleSha256=$proof.sourceModuleSha256;startingReceiptSha256=$proof.startingReceiptSha256;contextSha256=$proof.contextSha256;
        configSha256=$starting.configSha256;engineManifestSha256=$starting.engineManifestSha256;
        materials=[ordered]@{startingReceipt=[ordered]@{bytes=$raws['starting-receipt.json'].Length;sha256=$proof.startingReceiptSha256};
            context=[ordered]@{bytes=$raws['context.json'].Length;sha256=$proof.contextSha256}};
        missingRecoveryEvidence=@('oldStop','verifiedBackup','failureCloseout')}
    if ((Get-WorkerBytesHash $utf8.GetBytes(($expectedIntent|ConvertTo-Json -Depth 8 -Compress)+[char]10)) -cne
        (Get-WorkerBytesHash $raws['intent.json'])) { throw 'worker_startup_proof_invalid' }
    Assert-WorkerObject $proof.pins @('caller','host','node')
    Assert-WorkerObject $proof.exits @('hostExitCode','nodeExitCode','pipeEof')
    Assert-WorkerObject $proof.closeout @('captureReleased','privilegesRestored','installationLocksReleased')
    foreach ($key in @('captureReleased','privilegesRestored','installationLocksReleased')) {
        if ($proof.closeout.$key -isnot [bool] -or -not $proof.closeout.$key) { throw 'worker_startup_proof_invalid' }
    }
    if (-not (Test-WorkerPackageInteger $proof.exits.hostExitCode) -or $proof.exits.hostExitCode -ne 1 -or
        -not (Test-WorkerPackageInteger $proof.exits.nodeExitCode) -or $proof.exits.nodeExitCode -ne 2 -or
        $proof.exits.pipeEof -isnot [bool] -or -not $proof.exits.pipeEof -or
        (& $json $proof.pins.caller) -cne (& $json $context['caller'])) { throw 'worker_startup_proof_invalid' }
    $newRoot = Get-WorkerVersionRoot $receipt.programRoot $receipt.active.version
    foreach ($role in @('host','node')) {
        $pin = $proof.pins.$role
        Assert-WorkerObject $pin @('pid','creationFileTime','imagePath','tokenUserSid','sessionId')
        $image = if ($role -ceq 'host') { [IO.Path]::Combine($newRoot,'WindowsServiceHost.exe') } else { [IO.Path]::Combine($newRoot,'runtime','node.exe') }
        if (-not (Test-WorkerPackageInteger $pin.pid) -or $pin.pid -lt 1 -or $pin.creationFileTime -isnot [string] -or
            $pin.creationFileTime -cnotmatch '\A[1-9][0-9]*\z' -or $pin.tokenUserSid -cne $receipt.tokenUserSid -or
            -not (Test-WorkerPackageInteger $pin.sessionId) -or $pin.sessionId -ne 0 -or -not (Test-WorkerSamePath $pin.imagePath $image)) {
            throw 'worker_startup_proof_invalid'
        }
    }
    [uint64]$hostTime=0; [uint64]$nodeTime=0
    if (-not [uint64]::TryParse($proof.pins.host.creationFileTime,[ref]$hostTime) -or
        -not [uint64]::TryParse($proof.pins.node.creationFileTime,[ref]$nodeTime) -or $nodeTime -lt $hostTime) { throw 'worker_startup_proof_invalid' }
    # These are recorded identities for the strict frame parser, never reopened live process pins.
    $recorded = [pscustomobject]@{Disposed=$false;Stage='settled';ContextRaw=$raws['context.json'];Context=$context;OperationId=$proof.operationId;
        HostPin=$proof.pins.host;NodePin=$proof.pins.node;HostExited=$true;NodeExited=$true;HostExitCode=[uint32]1;NodeExitCode=[uint32]2;
        PreparedSha256=$proof.preparedSha256;JobName=$proof.jobName;RawFrames=@(
            [pscustomobject]@{kind='prepared';raw=$raws['prepared.frame']},[pscustomobject]@{kind='ack_prepared';raw=$raws['ack-prepared.frame']},
            [pscustomobject]@{kind='authorized';raw=$raws['authorized.frame']},[pscustomobject]@{kind='final';raw=$raws['settled.frame']})}
    $frames = @(Read-WorkerStartupFailureFrames $recorded)
    if ((& $json $frames[3]['phase']) -cne (& $json $proof.phase)) { throw 'worker_startup_proof_invalid' }
    $newPayload = Test-WorkerInstalledPayload $newRoot $receipt.active.inventorySha256 $receipt.configSha256
    if ($newPayload.startupObservationV1 -ne $true -or [Zeb.WorkerInstall.Native]::Hash(([IO.Path]::Combine($newRoot,'WindowsServiceHost.exe'))) -cne $context['hostSha256'] -or
        [Zeb.WorkerInstall.Native]::Hash(([IO.Path]::Combine($newRoot,'runtime','node.exe'))) -cne $context['nodeSha256']) { throw 'worker_startup_proof_invalid' }
    Assert-WorkerObject $proof.backup @('path','sha256','manifestPath','manifestSha256')
    $backupPath = Resolve-WorkerLocalPath $Request.BackupReceipt
    if (-not (Test-WorkerSamePath $proof.backup.path $backupPath) -or
        $proof.backup.sha256 -cne $Request.ExpectedBackupReceiptSha256.ToLowerInvariant()) { throw 'worker_backup_invalid' }
    $backup = Read-WorkerBackup $backupPath $receipt
    $backupRaw = & $read $backupPath
    $manifestPath = [IO.Path]::Combine($backup.value.root,'manifest.json')
    $manifestRaw = & $read $manifestPath
    if ((Get-WorkerBytesHash $backupRaw) -cne $proof.backup.sha256 -or $proof.backup.manifestPath -cne $manifestPath -or
        $proof.backup.manifestSha256 -cne $backup.value.manifestSha256 -or
        (Get-WorkerBytesHash $manifestRaw) -cne $proof.backup.manifestSha256) { throw 'worker_backup_invalid' }
    Assert-WorkerObject $proof.upgradeEvidence @('path','sha256')
    $upgradeRoot = Resolve-WorkerLocalPath ([IO.Path]::Combine($installation,'upgrade-'+$proof.operationId))
    Assert-WorkerCallerDirectory $upgradeRoot
    $upgradePath = [IO.Path]::Combine($upgradeRoot,'verified-backup.json')
    if ($proof.upgradeEvidence.path -cne $upgradePath -or
        (@([Zeb.WorkerInstall.Native]::Children($upgradeRoot)|Sort-Object) -join ',') -cne
        'maintenance-dto.json,old-package.inventory.json,old-stop.json,verified-backup.json') { throw 'worker_startup_proof_invalid' }
    $upgradeRaw = & $read $upgradePath
    if ((Get-WorkerBytesHash $upgradeRaw) -cne $proof.upgradeEvidence.sha256) { throw 'worker_startup_proof_invalid' }
    $index = ConvertFrom-Json -InputObject $utf8.GetString($upgradeRaw) -ErrorAction Stop
    Assert-WorkerObject $index @('schemaVersion','operationId','materials','backupReceipt','backupManifest','directories')
    Assert-WorkerObject $index.materials @('maintenance-dto.json','old-package.inventory.json','old-stop.json')
    if (-not (Test-WorkerJsonVersionOne $index.schemaVersion) -or $index.operationId -cne $proof.operationId -or
        $index.directories -isnot [array] -or ($index.directories -join ',') -cne 'store,records,engine,config,tls') { throw 'worker_startup_proof_invalid' }
    foreach ($pair in @(@{value=$index.backupReceipt;path=$backupPath;raw=$backupRaw},@{value=$index.backupManifest;path=$manifestPath;raw=$manifestRaw})) {
        Assert-WorkerObject $pair.value @('path','bytes','sha256')
        if ($pair.value.path -cne $pair.path -or -not (Test-WorkerPackageInteger $pair.value.bytes) -or
            $pair.value.bytes -ne $pair.raw.Length -or $pair.value.sha256 -cne (Get-WorkerBytesHash $pair.raw)) { throw 'worker_startup_proof_invalid' }
    }
    $oldRaws = @{}
    foreach ($name in @('maintenance-dto.json','old-package.inventory.json','old-stop.json')) {
        $oldRaws[$name] = & $read ([IO.Path]::Combine($upgradeRoot,$name))
        $declaration = $index.materials.PSObject.Properties[$name].Value
        Assert-WorkerObject $declaration @('bytes','sha256')
        if (-not (Test-WorkerPackageInteger $declaration.bytes) -or $declaration.bytes -ne $oldRaws[$name].Length -or
            $declaration.sha256 -cne (Get-WorkerBytesHash $oldRaws[$name])) { throw 'worker_startup_proof_invalid' }
    }
    $old = ConvertFrom-Json -InputObject $utf8.GetString($oldRaws['old-stop.json']) -ErrorAction Stop
    Assert-WorkerObject $old @('schemaVersion','operationId','source','oldActive','maintenanceDtoSha256','first','second',
        'scmStopCalls','hostExitCode','nodeExitCode','pinsExclusive','stoppedReceiptRawBase64','stoppedReceiptSha256')
    $stoppedRaw = [Convert]::FromBase64String($old.stoppedReceiptRawBase64)
    $stopped = ConvertFrom-Json -InputObject $utf8.GetString($stoppedRaw) -ErrorAction Stop
    $dto = ConvertFrom-Json -InputObject $utf8.GetString($oldRaws['maintenance-dto.json']) -ErrorAction Stop
    if (-not (Test-WorkerJsonVersionOne $old.schemaVersion) -or $old.source -cne 'derivedFromQualifiedHostContract' -or
        $old.operationId -cne $proof.operationId -or $old.scmStopCalls -ne 1 -or $old.hostExitCode -ne 0 -or $old.nodeExitCode -ne 0 -or
        $old.pinsExclusive -isnot [bool] -or -not $old.pinsExclusive -or $stoppedRaw.Length -gt 65536 -or
        [Convert]::ToBase64String($stoppedRaw) -cne $old.stoppedReceiptRawBase64 -or
        (Get-WorkerBytesHash $stoppedRaw) -cne $old.stoppedReceiptSha256 -or $old.maintenanceDtoSha256 -cne (Get-WorkerBytesHash $oldRaws['maintenance-dto.json']) -or
        $stopped.state -cne 'installed' -or $stopped.operation.action -cne 'Upgrade' -or $stopped.operation.stage -cne 'stopped' -or
        $stopped.operation.outcome -cne 'known' -or $stopped.operation.operationId -cne $proof.operationId -or
        (& $json $stopped.active) -cne (& $json $receipt.previous) -or (& $json $old.oldActive) -cne (& $json $receipt.previous) -or
        -not (Test-WorkerQuiescent $dto $stopped.operation.maintenanceBootId) -or $dto.store.queued -ne 0 -or
        $stopped.lastStopped.bootId -cne $dto.bootId -or $stopped.lastStopped.pinsExclusive -isnot [bool] -or
        -not $stopped.lastStopped.pinsExclusive -or (& $json $old.first) -cne (& $json $old.second)) { throw 'worker_startup_proof_invalid' }
    $expectedStarting = (& $json $stopped) | ConvertFrom-Json
    $expectedStarting.previous=$stopped.active; $expectedStarting.active=$starting.active
    $expectedStarting.operation.stage='started'; $expectedStarting.operation.outcome='pending'
    if ((& $json $expectedStarting) -cne (& $json $starting)) { throw 'worker_startup_proof_invalid' }
    $oldRoot = Get-WorkerVersionRoot $receipt.programRoot $receipt.previous.version
    foreach ($generation in @($old.first,$old.second)) {
        Assert-WorkerObject $generation @('bootId','endpoint','host','node')
        Assert-WorkerObject $generation.endpoint @('scheme','host','port','ownerPid','bootId')
        if ($generation.bootId -cne $dto.bootId -or $generation.endpoint.bootId -cne $dto.bootId -or
            $generation.endpoint.ownerPid -ne $generation.node.pid -or $generation.endpoint.scheme -cnotin @('http','https') -or
            $generation.endpoint.host -isnot [string] -or [string]::IsNullOrWhiteSpace($generation.endpoint.host) -or
            -not (Test-WorkerPackageInteger $generation.endpoint.port) -or $generation.endpoint.port -lt 1 -or
            $generation.endpoint.port -gt 65535) { throw 'worker_startup_proof_invalid' }
        foreach ($role in @('host','node')) {
            $pin=$generation.$role; $saved=$stopped.lastStopped.$role
            Assert-WorkerObject $pin @('pid','creationFileTime','imagePath','tokenUserSid','sessionId')
            $image = if ($role -ceq 'host') { [IO.Path]::Combine($oldRoot,'WindowsServiceHost.exe') } else { [IO.Path]::Combine($oldRoot,'runtime','node.exe') }
            if ($pin.pid -ne $saved.pid -or $pin.creationFileTime -cne $saved.creationFileTime -or
                $pin.tokenUserSid -cne $receipt.tokenUserSid -or $pin.sessionId -ne 0 -or -not (Test-WorkerSamePath $pin.imagePath $image)) {
                throw 'worker_startup_proof_invalid'
            }
        }
    }
    $null = Test-WorkerInstalledPayload $oldRoot $receipt.previous.inventorySha256 $receipt.configSha256
    if ([Zeb.WorkerInstall.Native]::Hash(([IO.Path]::Combine($oldRoot,'package.inventory.json'))) -cne (Get-WorkerBytesHash $oldRaws['old-package.inventory.json']) -or
        [Text.Encoding]::ASCII.GetString([Zeb.WorkerInstall.Native]::ReadBytes(([IO.Path]::Combine($oldRoot,'orderly-stop-contract.v1')))) -cne
        ("ZEB_ORDERLY_STOP_CONTRACT_V1"+[char]10)) { throw 'worker_startup_proof_invalid' }
    $failedSnapshot = ConvertFrom-Json -InputObject $utf8.GetString($raws['failed-snapshot.json']) -ErrorAction Stop
    Assert-WorkerSnapshot -Root $receipt.dataRoot -Manifest $failedSnapshot -Security
    foreach ($pair in @(@{path=[IO.Path]::Combine($receipt.dataRoot,'config','worker.config.json');sha=$receipt.configSha256},
        @{path=[IO.Path]::Combine($receipt.dataRoot,'engine','installation-manifest.json');sha=$receipt.engineManifestSha256})) {
        if ([Zeb.WorkerInstall.Native]::Hash($pair.path) -cne $pair.sha) { throw 'worker_startup_proof_invalid' }
    }
    $unknownPath=[IO.Path]::Combine($installation,'unknown-process.json')
    if ([IO.File]::Exists($unknownPath)) { throw 'worker_process_unknown' }
    foreach ($entry in $bound) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        Assert-WorkerCallerFile $entry.path
        $info=[Zeb.WorkerInstall.Native]::Inspect($entry.path)
        if ($info.Identity -cne $entry.info.Identity -or $info.SecuritySddl -cne $entry.info.SecuritySddl -or
            $info.CreationUtc -cne $entry.info.CreationUtc -or $info.LastWriteUtc -cne $entry.info.LastWriteUtc -or
            $info.Attributes -ne $entry.info.Attributes -or [Zeb.WorkerInstall.Native]::Hash($entry.path) -cne (Get-WorkerBytesHash $entry.raw)) {
            throw 'worker_startup_proof_invalid'
        }
    }
    return [pscustomobject]@{receipt=$receipt;receiptPath=$receiptPath;failedRaw=$failedRaw;proof=$proof;proofRaw=$proofRaw;
        failedSnapshot=$failedSnapshot;failedSnapshotRaw=$raws['failed-snapshot.json'];backup=$backup;bound=$bound.ToArray()}
}

function Assert-WorkerRecoveryTrees {
    param($Trees, [DateTime]$Deadline)
    foreach ($tree in $Trees) {
        $null = Get-WorkerRemainingMilliseconds $Deadline
        $actual = @(Get-WorkerTree $tree.path)
        if ($actual.Count -ne $tree.entries.Count) { throw 'worker_backup_invalid' }
        $pins=[Collections.Generic.List[object]]::new()
        try {
            foreach ($item in $actual) {
                $relative = $tree.name+$item.path.Substring($tree.path.Length).Replace('\','/')
                if (-not $tree.entries.ContainsKey($relative)) { throw 'worker_backup_invalid' }
                $wanted=$tree.entries[$relative]; $info=$item.info
                if ($info.Identity -cne $tree.identities[$relative] -or $info.SecuritySddl -cne $wanted.securitySddl -or
                    $info.CreationUtc -cne $wanted.creationUtc -or $info.LastWriteUtc -cne $wanted.lastWriteUtc -or
                    $info.Attributes -ne $wanted.attributes -or $info.Directory -ne ($wanted.kind -ceq 'directory') -or
                    (-not $info.Directory -and ($info.Bytes -ne $wanted.bytes -or [Zeb.WorkerInstall.Native]::Hash($item.path) -cne $wanted.sha256))) {
                    throw 'worker_backup_invalid'
                }
                $pins.Add((Open-WorkerExclusiveObject -LiteralPath $item.path -Deadline $Deadline))
            }
        } finally { foreach ($pin in $pins) { $pin.Dispose() } }
    }
}

function Assert-WorkerRecoveryContentMatch {
    param($Actual, $Backup, [DateTime]$Deadline)
    try{
        $sets=[Collections.Generic.List[object]]::new()
        foreach($manifest in @($Actual,$Backup)){
            $null=Get-WorkerRemainingMilliseconds $Deadline
            Assert-WorkerObject $manifest @('schemaVersion','entries')
            if(-not (Test-WorkerJsonVersionOne $manifest.schemaVersion) -or $manifest.entries -isnot [array] -or $manifest.entries.Count -lt 5){throw 'worker_backup_invalid'}
            $entries=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach($entry in $manifest.entries){
                $null=Get-WorkerRemainingMilliseconds $Deadline
                Assert-WorkerPackagePath $entry.path
                if($entry.kind -isnot [string] -or $entry.kind -cnotin @('file','directory') -or
                    $entry.path.Split([char]'/')[0] -cnotin @('store','records','engine','config','tls') -or $entries.ContainsKey($entry.path)){throw 'worker_backup_invalid'}
                $keys=@('path','kind','creationUtc','lastWriteUtc','attributes','securitySddl')
                if($entry.kind -ceq 'file'){
                    $keys+=@('bytes','sha256');Assert-WorkerHash $entry.sha256
                    if(-not (Test-WorkerPackageInteger $entry.bytes)){throw 'worker_backup_invalid'}
                }
                Assert-WorkerObject $entry $keys
                $entries.Add($entry.path,$entry)
            }
            foreach($name in @('store','records','engine','config','tls')){
                if(-not $entries.ContainsKey($name) -or $entries[$name].kind -cne 'directory'){throw 'worker_backup_invalid'}
            }
            $sets.Add($entries)
        }
        if($sets[0].Count -ne $sets[1].Count){throw 'worker_backup_invalid'}
        foreach($entry in $sets[0].Values){
            $null=Get-WorkerRemainingMilliseconds $Deadline
            if(-not $sets[1].ContainsKey($entry.path)){throw 'worker_backup_invalid'}
            $wanted=$sets[1][$entry.path]
            if($entry.path -cne $wanted.path -or $entry.kind -cne $wanted.kind -or
                ($entry.kind -ceq 'file' -and ($entry.bytes -ne $wanted.bytes -or $entry.sha256 -cne $wanted.sha256))){throw 'worker_backup_invalid'}
        }
        $null=Get-WorkerRemainingMilliseconds $Deadline
    }catch{
        if($_.Exception.Message -ceq 'worker_timeout_unknown'){throw}
        throw 'worker_backup_invalid'
    }
}

function Invoke-WorkerRecovery {
    param([hashtable]$Request)
    $utf8=[Text.UTF8Encoding]::new($false,$true)
    $operationId=[Guid]::NewGuid().ToString(); $receipt=$null; $delivery=$null; $privileges=$null; $startupCapture=$null
    $recoveryReceipt=$null; $recoveryPath=$null; $liveTouched=$false; $receiptPath=$null
    $script:WorkerBearer=$null
    try {
        $internal=-not $Request.ContainsKey('FailureProof')
        $allowed=if($internal){@('Receipt','BackupReceipt','RecoveryRoot','CredentialFile','TimeoutSeconds')}else{
            @('Receipt','ExpectedFailedReceiptSha256','FailedOperationId','BackupReceipt','ExpectedBackupReceiptSha256',
                'FailureProof','ExpectedFailureProofSha256','RecoveryRoot','CredentialFile','TimeoutSeconds')}
        if ($args.Count -ne 0 -or $Request.Count -ne $allowed.Count) { throw 'worker_input_invalid' }
        foreach ($key in $allowed) { if (-not $Request.ContainsKey($key)) { throw 'worker_input_invalid' } }
        foreach ($key in $Request.Keys) { if ($key -cnotin $allowed) { throw 'worker_input_invalid' } }
        $seconds=ConvertTo-WorkerTimeoutSeconds $Request.TimeoutSeconds
        $deadline=[DateTime]::UtcNow.AddSeconds($seconds)
        if($internal){
            $initial=Read-WorkerReceipt (Resolve-WorkerLocalPath $Request.Receipt)
            $Request.FailedOperationId=$initial.operation.operationId
            $Request.ExpectedFailedReceiptSha256=[Zeb.WorkerInstall.Native]::Hash($Request.Receipt)
            $Request.ExpectedBackupReceiptSha256=[Zeb.WorkerInstall.Native]::Hash((Resolve-WorkerLocalPath $Request.BackupReceipt))
        }
        Assert-WorkerUuid $Request.FailedOperationId
        foreach($key in @('ExpectedFailedReceiptSha256','ExpectedBackupReceiptSha256')){Assert-WorkerHash $Request[$key]}
        if(-not $internal){Assert-WorkerHash $Request.ExpectedFailureProofSha256}
        $existingLock=Get-Variable -Scope Script -Name WorkerRecoveryLock -ValueOnly -ErrorAction SilentlyContinue
        if ($null -ne $existingLock) { throw 'worker_operation_locked' }
        $evidence=Read-WorkerRecoveryEvidence $Request $deadline
        $receipt=$evidence.receipt; $receiptPath=$evidence.receiptPath
        $recoveryRoot=Resolve-WorkerLocalPath -Path $Request.RecoveryRoot -AllowMissing
        $credentialPath=Resolve-WorkerLocalPath $Request.CredentialFile
        Assert-WorkerSeparatePaths @($recoveryRoot,$receipt.programRoot,$receipt.dataRoot,$evidence.backup.value.root,$credentialPath)
        if ([IO.Directory]::Exists($recoveryRoot) -or [IO.File]::Exists($recoveryRoot) -or
            -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($recoveryRoot)) -or
            -not (Test-WorkerSamePath ([IO.Path]::GetPathRoot($recoveryRoot)) ([IO.Path]::GetPathRoot($receipt.dataRoot)))) {
            throw 'worker_path_invalid'
        }
        $null=Read-WorkerCredential $credentialPath $receipt
        $lockPath=[IO.Path]::Combine($receipt.dataRoot,'installation','operation.lock')
        # -Existing also creates a missing file; Recovery must never manufacture this lock.
        Assert-WorkerCallerFile $lockPath
        $lockIdentity=[Zeb.WorkerInstall.Native]::Inspect($lockPath).Identity
        $script:WorkerRecoveryLock=Open-WorkerInstallLock -Path $lockPath -OperationId $operationId -Existing
        if ([Zeb.WorkerInstall.Native]::Inspect($lockPath).Identity -cne $lockIdentity) { throw 'worker_operation_locked' }
        $evidence=Read-WorkerRecoveryEvidence $Request $deadline
        $receipt=$evidence.receipt; $receiptPath=$evidence.receiptPath
        $failedReceipt=($receipt|ConvertTo-Json -Depth 64 -Compress)|ConvertFrom-Json
        $pairing=Read-WorkerCredential $credentialPath $receipt
        $credentialInfo=[Zeb.WorkerInstall.Native]::Inspect($credentialPath)
        $credentialSha=[Zeb.WorkerInstall.Native]::Hash($credentialPath)
        $script:WorkerBearer=$pairing.credential.key
        $privileges=Enter-WorkerInstallPrivileges -Deadline $deadline
        if($internal){
            $evidence.failedSnapshot=Get-WorkerSnapshot $receipt.dataRoot
            Assert-WorkerRecoveryContentMatch $evidence.failedSnapshot $evidence.backup.manifest $deadline
            $evidence.failedSnapshotRaw=$utf8.GetBytes(($evidence.failedSnapshot|ConvertTo-Json -Depth 64 -Compress)+[char]10)
            $evidence.proofRaw=$utf8.GetBytes(([ordered]@{v=1;kind='internal_stopped_recovery';operationId=$Request.FailedOperationId;
                failedReceiptSha256=$Request.ExpectedFailedReceiptSha256;backupReceiptSha256=$Request.ExpectedBackupReceiptSha256;
                snapshotSha256=(Get-WorkerBytesHash $evidence.failedSnapshotRaw)}|ConvertTo-Json -Compress)+[char]10)
        }
        $currentSha=Get-WorkerBytesHash $evidence.failedRaw
        $verifyMaterials = {
            $null=Get-WorkerRemainingMilliseconds $deadline
            if($internal){
                if([Zeb.WorkerInstall.Native]::Hash($credentialPath) -cne $credentialSha){throw 'worker_identity_unknown'}
                foreach($entry in $evidence.bound){
                    if(-not (Test-WorkerSamePath $entry.path $receiptPath) -and
                        [Zeb.WorkerInstall.Native]::Hash($entry.path) -cne (Get-WorkerBytesHash $entry.raw)){throw 'worker_backup_invalid'}
                }
                return
            }
            Assert-WorkerCallerFile $credentialPath
            $credentialCurrent=[Zeb.WorkerInstall.Native]::Inspect($credentialPath)
            if ($credentialCurrent.Identity -cne $credentialInfo.Identity -or $credentialCurrent.SecuritySddl -cne $credentialInfo.SecuritySddl -or
                $credentialCurrent.CreationUtc -cne $credentialInfo.CreationUtc -or $credentialCurrent.LastWriteUtc -cne $credentialInfo.LastWriteUtc -or
                $credentialCurrent.Attributes -ne $credentialInfo.Attributes -or [Zeb.WorkerInstall.Native]::Hash($credentialPath) -cne $credentialSha) {
                throw 'worker_identity_unknown'
            }
            foreach ($entry in $evidence.bound) {
                if (Test-WorkerSamePath $entry.path $receiptPath) { continue }
                Assert-WorkerCallerFile $entry.path
                $info=[Zeb.WorkerInstall.Native]::Inspect($entry.path)
                if ($info.Identity -cne $entry.info.Identity -or $info.SecuritySddl -cne $entry.info.SecuritySddl -or
                    $info.CreationUtc -cne $entry.info.CreationUtc -or $info.LastWriteUtc -cne $entry.info.LastWriteUtc -or
                    $info.Attributes -ne $entry.info.Attributes -or
                    [Zeb.WorkerInstall.Native]::Hash($entry.path) -cne (Get-WorkerBytesHash $entry.raw)) { throw 'worker_startup_proof_invalid' }
            }
        }
        $guard = {
            & $verifyMaterials
            if ([Zeb.WorkerInstall.Native]::Hash($receiptPath) -cne $currentSha) { throw 'worker_operation_conflict' }
            $generation=Get-WorkerServiceGeneration -Receipt $failedReceipt -Deadline $deadline
            try {
                if ($generation.exists -ne $true -or $generation.status -cne 'Stopped' -or
                    $generation.serviceName -cne $failedReceipt.serviceName -or $generation.accountName -cne $failedReceipt.accountName -or
                    $generation.imagePath -cne $failedReceipt.active.imagePath -or $generation.candidateSid -cne $failedReceipt.tokenUserSid) {
                    throw 'worker_identity_unknown'
                }
            } finally { if ($null -ne $generation.PSObject.Methods['Dispose']) { $generation.Dispose() } }
        }
        & $guard
        if($internal){
            $config=Read-WorkerJson ([IO.Path]::Combine($receipt.dataRoot,'config','worker.config.json'))
            if(-not (Test-WorkerPackageInteger $config.port) -or $config.port -lt 1 -or $config.port -gt 65535){throw 'worker_configuration_invalid'}
            if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object {$_.LocalPort -eq $config.port}).Count -ne 0){throw 'worker_port_in_use'}
        }
        Assert-WorkerExclusiveSnapshot -Receipt $receipt -Deadline $deadline
        New-WorkerCallerDirectory $recoveryRoot
        $recoveryPath=[IO.Path]::Combine($recoveryRoot,'recovery-receipt.json')
        $recoveryReceipt=[pscustomobject]@{schemaVersion=1;kind='worker_recovery';installationId=$receipt.installationId;
            failedOperationId=$Request.FailedOperationId;failedReceiptSha256=$currentSha;failureProofSha256=(Get-WorkerBytesHash $evidence.proofRaw);
            selectedBackupReceiptSha256=$Request.ExpectedBackupReceiptSha256.ToLowerInvariant();recoveryOperationId=$operationId;
            phase='archiving';outcome='pending';bootId=$null;qualificationRequired=$true}
        New-WorkerCallerFile -Path ([IO.Path]::Combine($recoveryRoot,'intent.json')) -Bytes $utf8.GetBytes(($recoveryReceipt|ConvertTo-Json -Compress)+[char]10)
        New-WorkerCallerFile -Path ([IO.Path]::Combine($recoveryRoot,'failed-receipt.json')) -Bytes $evidence.failedRaw
        New-WorkerCallerFile -Path ([IO.Path]::Combine($recoveryRoot,'failure-proof.json')) -Bytes $evidence.proofRaw
        New-WorkerCallerFile -Path ([IO.Path]::Combine($recoveryRoot,'failed-snapshot.json')) -Bytes $evidence.failedSnapshotRaw
        Write-WorkerLedger $recoveryPath $recoveryReceipt
        $archive=[IO.Path]::Combine($recoveryRoot,'archive')
        New-WorkerCallerDirectory $archive
        Write-WorkerLedger ([IO.Path]::Combine($archive,'manifest.json')) ([pscustomobject]@{
            schemaVersion=1;kind='raw_failure_archive';failedReceiptSha256=$currentSha;failureProofSha256=$recoveryReceipt.failureProofSha256;
            manifest=$evidence.failedSnapshot})
        $staging=[IO.Path]::Combine($recoveryRoot,'staging')
        $recoveryReceipt.phase='staging'; Write-WorkerLedger $recoveryPath $recoveryReceipt
        & $guard
        $null=Read-WorkerBackup $Request.BackupReceipt $failedReceipt
        Copy-WorkerSnapshot -Source $evidence.backup.value.root -Destination $staging -Manifest $evidence.backup.manifest -Deadline $deadline
        $oldReceipt=($failedReceipt|ConvertTo-Json -Depth 64 -Compress)|ConvertFrom-Json
        $oldReceipt.active=$oldReceipt.previous
        Test-WorkerSnapshotDatabase -Root $staging -Receipt $oldReceipt -Deadline $deadline
        Restore-WorkerSnapshotMetadata -Root $staging -Manifest $evidence.backup.manifest
        Assert-WorkerSnapshot -Root $staging -Manifest $evidence.backup.manifest -Security
        Assert-WorkerSnapshot -Root $receipt.dataRoot -Manifest $evidence.failedSnapshot -Security
        $trees=[Collections.Generic.List[object]]::new()
        foreach ($subject in @(@{root=$receipt.dataRoot;manifest=$evidence.failedSnapshot},@{root=$staging;manifest=$evidence.backup.manifest})) {
            foreach ($name in @('store','records','engine','config','tls')) {
                $entries=@{}; $identities=@{}
                foreach ($entry in $(if($internal){@()}else{$subject.manifest.entries})) {
                    if ($entry.path.Split([char]'/')[0] -cne $name) { continue }
                    $entries[$entry.path]=$entry
                    $identities[$entry.path]=[Zeb.WorkerInstall.Native]::Inspect(([IO.Path]::Combine($subject.root,$entry.path.Replace('/','\')))).Identity
                }
                $trees.Add([pscustomobject]@{name=$name;path=[IO.Path]::Combine($subject.root,$name);entries=$entries;identities=$identities})
            }
        }
        & $guard
        if(-not $internal){Assert-WorkerRecoveryTrees $trees $deadline}
        $receipt.operation=New-WorkerOperation 'Rollback' $Request.ExpectedBackupReceiptSha256.ToLowerInvariant()
        $receipt.operation.operationId=$operationId; $receipt.state='pending'
        $liveTouched=$true
        Save-WorkerStage $receiptPath $receipt 'backed_up' 'pending'
        $currentSha=[Zeb.WorkerInstall.Native]::Hash($receiptPath)
        $recoveryReceipt.phase='swapping'; Write-WorkerLedger $recoveryPath $recoveryReceipt
        foreach ($index in 0..4) {
            $name=@('store','records','engine','config','tls')[$index]
            & $guard
            if(-not $internal){
                Assert-WorkerRecoveryTrees $trees $deadline
                $null=Read-WorkerBackup $Request.BackupReceipt $failedReceipt
            }
            [Zeb.WorkerInstall.Native]::MoveObject($trees[$index].path,([IO.Path]::Combine($archive,$name)))
            $trees[$index].path=[IO.Path]::Combine($archive,$name)
            $recoveryReceipt.phase='archived_'+$name; Write-WorkerLedger $recoveryPath $recoveryReceipt
            & $guard
            if(-not $internal){Assert-WorkerRecoveryTrees $trees $deadline}
            [Zeb.WorkerInstall.Native]::MoveObject($trees[$index+5].path,([IO.Path]::Combine($receipt.dataRoot,$name)))
            $trees[$index+5].path=[IO.Path]::Combine($receipt.dataRoot,$name)
            $recoveryReceipt.phase='restored_'+$name; Write-WorkerLedger $recoveryPath $recoveryReceipt
        }
        if(-not $internal){Assert-WorkerRecoveryTrees $trees $deadline}
        Assert-WorkerSnapshot -Root $archive -Manifest $evidence.failedSnapshot -Security
        Restore-WorkerSnapshotMetadata -Root $receipt.dataRoot -Manifest $evidence.backup.manifest
        $null=Read-WorkerBackup $Request.BackupReceipt $failedReceipt
        $receipt.active=$failedReceipt.previous; $receipt.previous=$failedReceipt.active
        $null=Test-WorkerInstalledPayload (Get-WorkerVersionRoot $receipt.programRoot $receipt.active.version) $receipt.active.inventorySha256 $receipt.configSha256
        Save-WorkerStage $receiptPath $receipt 'backed_up' 'pending'
        $currentSha=[Zeb.WorkerInstall.Native]::Hash($receiptPath)
        & $guard
        $recoveryReceipt.phase='starting'; Write-WorkerLedger $recoveryPath $recoveryReceipt
        Start-WorkerOwnedService -Receipt $receipt -ReceiptPath $receiptPath -Deadline $deadline -Switch -StartupCapture ([ref]$startupCapture) -DeferCompletion
        $running=Get-WorkerServiceGeneration -Receipt $receipt -Deadline $deadline -WaitForReady
        try {
            $dto=Invoke-WorkerMaintenanceHttp -Method GET -Generation $running -Bearer $script:WorkerBearer -Deadline $deadline
            Assert-WorkerUuid $dto.bootId
            $running.bootId=$dto.bootId; $running.endpoint.bootId=$dto.bootId
            Assert-WorkerGeneration $running $receipt
            if ($dto.bootId -ceq $failedReceipt.lastStopped.bootId) { throw 'worker_identity_unknown' }
            $recoveryReceipt.bootId=$dto.bootId
        } finally { $running.Dispose() }
        & $verifyMaterials
        $null=Read-WorkerBackup $Request.BackupReceipt $failedReceipt
        $null=Get-WorkerRemainingMilliseconds $deadline
        $delivery=Get-WorkerPublicResult 'worker_recovery_complete' $operationId $receipt 'known' 0
        $delivery.value|Add-Member -NotePropertyMembers @{failedOperationId=$Request.FailedOperationId;qualificationRequired=$true;bootId=$recoveryReceipt.bootId}
    } catch {
        $code=if ($_.Exception.Message -cmatch '\Aworker_[a-z_]+\z') { $_.Exception.Message } else { 'worker_operation_unknown' }
        $outcome=if ($null -ne $recoveryReceipt -or $code.EndsWith('_unknown',[StringComparison]::Ordinal)) { 'unknown' } else { 'known' }
        $delivery=Get-WorkerPublicResult $code $operationId $receipt $outcome 1
    } finally {
        $cleanupFailed=$false
        try { if ($null -ne $startupCapture) { $startupCapture.Dispose() } } catch { $cleanupFailed=$true }
        try { if ($null -ne $privileges) { $privileges.Dispose() } } catch { $cleanupFailed=$true }
        $script:WorkerBearer=$null
        if ($cleanupFailed -and $null -ne $delivery) {
            $delivery.exitCode=1; $delivery.value.code='worker_privilege_restore_unknown'; $delivery.value.outcome='unknown'
        }
        if ($null -ne $delivery -and $null -ne $recoveryReceipt) {
            try {
                if ($delivery.exitCode -ne 0) {
                    $recoveryReceipt.outcome='unknown'
                    if ($liveTouched) {
                        $receipt.state='unknown'; $receipt.operation.outcome='unknown'
                        Write-WorkerLedger $receiptPath $receipt
                    }
                } else {
                    $null=Get-WorkerRemainingMilliseconds $deadline
                    $recoveryReceipt.phase='complete'; $recoveryReceipt.outcome='known'
                }
                Write-WorkerLedger $recoveryPath $recoveryReceipt
                if ($delivery.exitCode -eq 0) {
                    $null=Get-WorkerRemainingMilliseconds $deadline
                    $receipt.state='installed'
                    Save-WorkerStage $receiptPath $receipt 'started' 'known'
                }
            } catch {
                $delivery.exitCode=1; $delivery.value.code='worker_ledger_unknown'; $delivery.value.outcome='unknown'
                if ($liveTouched) {
                    $receipt.state='unknown'; $receipt.operation.outcome='unknown'
                    try { Write-WorkerLedger $receiptPath $receipt } catch { }
                }
                $recoveryReceipt.outcome='unknown'
                try { Write-WorkerLedger $recoveryPath $recoveryReceipt } catch { }
            }
        }
        # The independent Recover process owns this lock until exit, including failure output.
    }
    return $delivery
}

function Invoke-WorkerInstallation {
    param([hashtable]$Request, [bool]$Remove)
    $operationId = [Guid]::NewGuid().ToString()
    $receipt = $null; $receiptPath = $null; $lock = $null; $privileges = $null; $delivery = $null
    $startupCapture = $null; $startupDiagnosticAttempted = $false
    $startupFailureCandidate = $null
    $upgradeEvidence = $null; $stopEvidenceArguments = @{}
    $approvedReceiptSha256 = $null; $approvedReceiptJson = $null
    $ledgerOwned = $false; $bootstrapStarted = $false; $tombstonePath = $null; $tombstone = $null; $tombstoneLock = $null
    $script:WorkerBearer = $null
    try {
        $allowed = @('Action', 'PayloadRoot', 'ExpectedInventorySha256', 'ProgramRoot', 'DataRoot', 'EngineImportManifest',
            'ExpectedEngineImportSha256', 'ConfigFile', 'TlsPfx', 'CredentialFile', 'TimeoutSeconds', 'Receipt', 'BackupRoot', 'BackupReceipt', 'ExpectedDataRoot')
        foreach ($key in $Request.Keys) { if ($key -cnotin $allowed) { throw 'worker_input_invalid' } }
        if (-not $Request.ContainsKey('TimeoutSeconds')) { throw 'worker_timeout_invalid' }
        $seconds = ConvertTo-WorkerTimeoutSeconds $Request.TimeoutSeconds
        $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
        $action = if ($Request.ContainsKey('Action')) { $Request.Action } elseif ($Remove) { 'Uninstall' } else { 'Install' }
        if (($Remove -and $action -cnotin @('Uninstall', 'DeleteData')) -or
            (-not $Remove -and $action -cnotin @('Install', 'Upgrade', 'Rollback'))) { throw 'worker_input_invalid' }
        if ($action -ceq 'Upgrade') { $stopEvidenceArguments.UpgradeEvidence = [ref]$upgradeEvidence }
        $fresh = $action -ceq 'Install' -and -not $Request.ContainsKey('Receipt')
        $target = $null; $selectedBackup = $null; $payload = $null; $versionRoot = $null
        $package = $null; $engineImport = $null; $material = $null; $resume = $false; $credentialPath = $null
        if ($fresh) {
            foreach ($key in @('PayloadRoot', 'ExpectedInventorySha256', 'ProgramRoot', 'DataRoot', 'EngineImportManifest',
                'ExpectedEngineImportSha256', 'ConfigFile', 'CredentialFile')) {
                if (-not $Request.ContainsKey($key)) { throw 'worker_input_invalid' }
            }
            $program = Resolve-WorkerLocalPath -Path $Request.ProgramRoot -AllowMissing
            $data = Resolve-WorkerLocalPath -Path $Request.DataRoot -AllowMissing
            $receiptPath = [System.IO.Path]::Combine($data, 'installation', 'receipt.json')
            if ([System.IO.File]::Exists($receiptPath)) {
                $receipt = Read-WorkerReceipt $receiptPath
                $operationId = $receipt.operation.operationId
                $outcome = if ($receipt.state -ceq 'unknown' -or $receipt.operation.outcome -cne 'known') { 'unknown' } else { 'known' }
                $delivery = Get-WorkerPublicResult 'worker_operation_pending' $operationId $receipt $outcome 1
                return $delivery
            }
        } else {
            if (-not $Request.ContainsKey('Receipt')) { throw 'worker_input_invalid' }
            foreach ($key in @('ProgramRoot', 'DataRoot', 'EngineImportManifest', 'ExpectedEngineImportSha256', 'ConfigFile', 'TlsPfx')) {
                if ($Request.ContainsKey($key)) { throw 'worker_input_invalid' }
            }
            $receiptPath = Resolve-WorkerLocalPath $Request.Receipt
            $receipt = Read-WorkerReceipt $receiptPath
            $approvedReceiptSha256 = [Zeb.WorkerInstall.Native]::Hash($receiptPath)
            $approvedReceiptJson = $receipt | ConvertTo-Json -Depth 64 -Compress
            $program = $receipt.programRoot; $data = $receipt.dataRoot
            $operationId = $receipt.operation.operationId
            if ($receipt.state -ceq 'unknown' -or $receipt.operation.outcome -cne 'known') {
                $delivery = Get-WorkerPublicResult 'worker_operation_pending' $operationId $receipt 'unknown' 1
                return $delivery
            }
            if ($receipt.state -ceq 'pending') {
                $delivery = Get-WorkerPublicResult 'worker_operation_pending' $operationId $receipt 'known' 1
                return $delivery
            }
        }
        if ($action -cin @('Install', 'Upgrade')) {
            if (-not $Request.ContainsKey('PayloadRoot') -or -not $Request.ContainsKey('ExpectedInventorySha256')) { throw 'worker_input_invalid' }
            $payload = Resolve-WorkerLocalPath $Request.PayloadRoot
            $package = Test-WorkerPayload -PayloadRoot $payload -ExpectedInventorySha256 $Request.ExpectedInventorySha256
            $versionRoot = Get-WorkerVersionRoot $program $package.version
            $target = if ($action -ceq 'Upgrade') { $Request.ExpectedInventorySha256.ToLowerInvariant() } else { $null }
        } elseif ($Request.ContainsKey('PayloadRoot') -or $Request.ContainsKey('ExpectedInventorySha256')) { throw 'worker_input_invalid' }
        if ($action -ceq 'Rollback') {
            if (-not $Request.ContainsKey('BackupReceipt')) { throw 'worker_input_invalid' }
            $selectedPath = Resolve-WorkerLocalPath $Request.BackupReceipt
            Assert-WorkerCallerFile $selectedPath
            $target = [Zeb.WorkerInstall.Native]::Hash($selectedPath)
        } elseif ($Request.ContainsKey('BackupReceipt')) { throw 'worker_input_invalid' }
        if ($action -ceq 'DeleteData') {
            if (-not $Request.ContainsKey('ExpectedDataRoot') -or $receipt.state -cne 'retained' -or
                -not (Test-WorkerSamePath (Resolve-WorkerLocalPath $Request.ExpectedDataRoot) $data)) { throw 'worker_data_root_invalid' }
        } elseif ($Request.ContainsKey('ExpectedDataRoot')) { throw 'worker_input_invalid' }
        if ($null -ne $receipt -and $receipt.operation.stage -ceq 'maintenance') {
            if ($receipt.state -cne 'installed' -or $receipt.operation.action -cne $action -or
                $receipt.operation.targetSha256 -cne $target -or $null -eq $receipt.operation.maintenanceBootId) { throw 'worker_operation_conflict' }
            $resume = $true
        }
        if ($action -ceq 'Upgrade') {
            if (-not $Request.ContainsKey('BackupRoot') -or $receipt.state -cne 'installed' -or $package.version -ceq $receipt.active.version) { throw 'worker_input_invalid' }
            $backupRoot = Resolve-WorkerLocalPath -Path $Request.BackupRoot -AllowMissing
            if ([System.IO.File]::Exists($backupRoot) -or ([System.IO.Directory]::Exists($backupRoot) -and [Zeb.WorkerInstall.Native]::Children($backupRoot).Count -ne 0) -or
                (([System.IO.Directory]::Exists($versionRoot) -or [System.IO.File]::Exists($versionRoot)) -and -not $resume)) { throw 'worker_directory_not_empty' }
            if ($resume) {
                $null = Test-WorkerInstalledPayload -PayloadRoot $versionRoot -ExpectedInventorySha256 $Request.ExpectedInventorySha256 -ExpectedConfigSha256 $receipt.configSha256
            }
        } elseif ($Request.ContainsKey('BackupRoot')) { throw 'worker_input_invalid' }
        if ($action -ne 'DeleteData') {
            if (-not $Request.ContainsKey('CredentialFile')) { throw 'worker_input_invalid' }
            $credentialPath = Resolve-WorkerLocalPath -Path $Request.CredentialFile -AllowMissing:$fresh
            $null = Resolve-WorkerLocalPath ([System.IO.Path]::GetDirectoryName($credentialPath))
            if (-not [System.IO.Directory]::Exists([System.IO.Path]::GetDirectoryName($credentialPath))) { throw 'worker_path_invalid' }
        } elseif ($Request.ContainsKey('CredentialFile')) { throw 'worker_input_invalid' }
        $separate = @($program, $data)
        if ($null -ne $payload) { $separate += $payload }
        if ($null -ne $credentialPath) { $separate += $credentialPath }
        if ($action -ceq 'Upgrade') { $separate += $backupRoot }
        Assert-WorkerSeparatePaths $separate
        if ($fresh) {
            foreach ($root in @($program, $data)) {
                if ([System.IO.File]::Exists($root) -or
                    ([System.IO.Directory]::Exists($root) -and [Zeb.WorkerInstall.Native]::Children($root).Count -ne 0)) { throw 'worker_directory_not_empty' }
            }
            if ([System.IO.File]::Exists($credentialPath)) { throw 'worker_credential_exists' }
            $configSource = Resolve-WorkerLocalPath $Request.ConfigFile
            $importSource = Resolve-WorkerLocalPath $Request.EngineImportManifest
            $material = Read-WorkerJson $configSource
            $transport = Get-WorkerTransport $material
            $transportKey = if ($transport.scheme -ceq 'https') { 'tls' } else { 'host' }
            Assert-WorkerObject $material @('port', $transportKey, 'selfTestModelId', 'workerConfig', 'submissionLimits', 'runnerLimits', 'transportLimits', 'execution')
            $tlsSource = $null; $tlsSha256 = $null
            $externalInputs = @($configSource, $importSource)
            if ($transport.scheme -ceq 'https') {
                Assert-WorkerObject $material.tls @('host')
                if (-not $Request.ContainsKey('TlsPfx')) { throw 'worker_input_invalid' }
                $tlsSource = Resolve-WorkerLocalPath $Request.TlsPfx
                $tlsSha256 = [Zeb.WorkerInstall.Native]::Hash($tlsSource)
                $externalInputs += $tlsSource
            } elseif ($Request.ContainsKey('TlsPfx')) { throw 'worker_input_invalid' }
            Assert-WorkerSeparatePaths ($externalInputs + $separate)
            Assert-WorkerObject $material.execution @('bridgeLimits', 'journalLimits')
            $engineImport = Read-WorkerEngineImport -Path $importSource -ExpectedSha256 $Request.ExpectedEngineImportSha256 -Material $material -OwnedPaths $separate
            $receipt = [pscustomobject]@{ schemaVersion=1; installationId=[Guid]::NewGuid().ToString(); state='pending';
                serviceName='ZebImageEnhancement'; accountName='NT SERVICE\ZebImageEnhancement'; tokenUserSid=$null; sessionId=$null;
                programRoot=$program; dataRoot=$data; storeSchemaVersion=7; serviceId=$null; clientId=$null;
                engineImportSha256=$Request.ExpectedEngineImportSha256.ToLowerInvariant(); engineManifestSha256=$engineImport.manifestSha256;
                configSha256=$null; tlsSha256=$tlsSha256;
                active=[pscustomobject]@{ version=$package.version; inventorySha256=$Request.ExpectedInventorySha256.ToLowerInvariant();
                    imagePath='"' + [System.IO.Path]::Combine($versionRoot, 'WindowsServiceHost.exe') + '"' };
                previous=$null; lastStopped=$null; operation=(New-WorkerOperation $action $null) }
        } else {
            if (($action -ceq 'Install' -and $receipt.state -cne 'retained') -or
                ($action -cin @('Rollback', 'Uninstall') -and $receipt.state -cne 'installed')) { throw 'worker_state_invalid' }
            if ($action -ne 'DeleteData') {
                $pairing = Read-WorkerCredential $credentialPath $receipt
                $script:WorkerBearer = $pairing.credential.key
                $activeRoot = Get-WorkerVersionRoot $program $receipt.active.version
                if ($action -ne 'Install' -or [System.IO.Directory]::Exists($activeRoot)) {
                    $null = Test-WorkerInstalledPayload -PayloadRoot $activeRoot -ExpectedInventorySha256 $receipt.active.inventorySha256 -ExpectedConfigSha256 $receipt.configSha256
                }
            }
        }
        $privileges = Enter-WorkerInstallPrivileges -Deadline $deadline
        if ($fresh) {
            $unowned = Get-WorkerServiceGeneration -Receipt $receipt -Deadline $deadline
            try { if ($unowned.exists) { throw 'worker_service_not_owned' } }
            finally { if ($null -ne $unowned.PSObject.Methods['Dispose']) { $unowned.Dispose() } }
            $operationId = $receipt.operation.operationId
            $bootstrapStarted = $true
            New-WorkerCallerDirectory $data
            New-WorkerCallerDirectory ([System.IO.Path]::Combine($data, 'installation'))
        } else {
            $null = Assert-WorkerStableFiles -Receipt $receipt -Engine
            if ($action -ceq 'Rollback') {
                $selectedBackup = Read-WorkerBackup $selectedPath $receipt
                Assert-WorkerSeparatePaths @($selectedBackup.value.root, $program, $data, $credentialPath)
            }
        }
        $nextOperation = if (-not $resume -and -not $fresh) { New-WorkerOperation $action $target } else { $null }
        $operationId = if ($null -ne $nextOperation) { $nextOperation.operationId } else { $receipt.operation.operationId }
        $lock = Open-WorkerInstallLock -Path ([System.IO.Path]::Combine($data, 'installation', 'operation.lock')) -OperationId $operationId -Existing:(-not $fresh)
        if (-not $fresh) {
            $lockedReceipt = Read-WorkerReceipt $receiptPath
            if ([Zeb.WorkerInstall.Native]::Hash($receiptPath) -cne $approvedReceiptSha256 -or
                ($lockedReceipt | ConvertTo-Json -Depth 64 -Compress) -cne $approvedReceiptJson) { throw 'worker_operation_conflict' }
            $receipt = $lockedReceipt
            if ($null -ne $nextOperation) { $receipt.operation = $nextOperation }
        }
        $ledgerOwned = $true
        if (-not $resume) { Save-WorkerStage $receiptPath $receipt 'prepared' 'pending' }
        if ($fresh) {
            New-WorkerCallerDirectory $program
            foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) { New-WorkerCallerDirectory ([System.IO.Path]::Combine($data, $name)) }
            Copy-WorkerPayload -Source $payload -Destination $versionRoot -InventorySha256 $Request.ExpectedInventorySha256
            foreach ($entry in $engineImport.entries.Values) {
                $destination = [System.IO.Path]::Combine($data, 'engine', $entry.path.Replace('/', '\'))
                $null = [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination), (Get-WorkerCallerSecurity -Directory))
                Copy-WorkerFile -Source $entry.sourcePath -Destination $destination
                if ([Zeb.WorkerInstall.Native]::Inspect($destination).Bytes -ne $entry.bytes -or
                    [Zeb.WorkerInstall.Native]::Hash($destination) -cne $entry.sha256) { throw 'worker_engine_invalid' }
            }
            Assert-WorkerCopiedEngine -Root ([System.IO.Path]::Combine($data, 'engine')) -Material $material -ExpectedManifestSha256 $receipt.engineManifestSha256
            if ($null -ne $tlsSource) {
                Copy-WorkerFile -Source $tlsSource -Destination ([System.IO.Path]::Combine($data, 'tls', 'worker.pfx'))
                if ([Zeb.WorkerInstall.Native]::Hash(([System.IO.Path]::Combine($data, 'tls', 'worker.pfx'))) -cne $receipt.tlsSha256) { throw 'worker_configuration_invalid' }
            }
            Save-WorkerStage $receiptPath $receipt 'initializing' 'pending'
            $initialized = Invoke-WorkerNodeProcess -ExecutablePath ([System.IO.Path]::Combine($versionRoot, 'runtime', 'node.exe')) -Arguments @(
                ([System.IO.Path]::Combine($versionRoot, 'app', 'manage.mjs')), 'initialize', ([System.IO.Path]::Combine($data, 'store'))) -Deadline $deadline
            Assert-WorkerProcessResult $initialized
            $pairing = ConvertFrom-Json -InputObject $initialized.stdout -ErrorAction Stop
            Assert-WorkerPairing $pairing
            Assert-WorkerExclusiveSnapshot -Receipt $receipt -Deadline $deadline
            $receipt.serviceId = $pairing.serviceId; $receipt.clientId = $pairing.credential.clientId
            Save-WorkerStage $receiptPath $receipt 'identity_saved' 'known'
            New-WorkerCallerFile -Path $credentialPath -Bytes ([System.Text.UTF8Encoding]::new($false, $true).GetBytes($initialized.stdout))
            $script:WorkerBearer = $pairing.credential.key
            $complete = [pscustomobject]@{ storeDirectory=[System.IO.Path]::Combine($data, 'store'); port=$material.port;
                operatorClientId=$receipt.clientId; selfTestModelId=$material.selfTestModelId; workerConfig=$material.workerConfig;
                submissionLimits=$material.submissionLimits; runnerLimits=$material.runnerLimits; transportLimits=$material.transportLimits;
                execution=[pscustomobject]@{ installationRoot=[System.IO.Path]::Combine($data, 'engine'); recordsRoot=[System.IO.Path]::Combine($data, 'records');
                    expectedManifestSha256=$receipt.engineManifestSha256; bridgeLimits=$material.execution.bridgeLimits; journalLimits=$material.execution.journalLimits } }
            if ($transport.scheme -ceq 'https') {
                $complete | Add-Member -MemberType NoteProperty -Name tls -Value ([pscustomobject]@{ host=$transport.host; pfxPath=[System.IO.Path]::Combine($data, 'tls', 'worker.pfx') })
            } else { $complete | Add-Member -MemberType NoteProperty -Name host -Value $transport.host }
            $configBytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes(($complete | ConvertTo-Json -Compress -Depth 64) + [char]10)
            $receipt.configSha256 = Get-WorkerBytesHash $configBytes
            $configPath = [System.IO.Path]::Combine($data, 'config', 'worker.config.json')
            New-WorkerCallerFile -Path $configPath -Bytes $configBytes
            Write-WorkerVersionConfig $versionRoot $configBytes $receipt.configSha256
            Save-WorkerStage $receiptPath $receipt 'identity_saved' 'known'
            $configuration = Invoke-WorkerConfigurationCheck -VersionRoot $versionRoot -ConfigPath $configPath -Deadline $deadline
            if ($configuration.outcome -ceq 'known' -and $configuration.exited -eq $true -and $configuration.stdoutComplete -eq $true -and
                $configuration.stderrComplete -eq $true -and $configuration.exitCode -ne 0) {
                $delivery = Get-WorkerPublicResult 'worker_configuration_invalid' $operationId $receipt 'known' 1
                return $delivery
            }
            Assert-WorkerConfigurationResult $configuration
            $null = Test-WorkerInstalledPayload -PayloadRoot $versionRoot -ExpectedInventorySha256 $receipt.active.inventorySha256 -ExpectedConfigSha256 $receipt.configSha256
            Start-WorkerOwnedService -Receipt $receipt -ReceiptPath $receiptPath -Deadline $deadline -Create -StartupCapture ([ref]$startupCapture)
        } elseif ($action -ceq 'Install') {
            if ($null -eq $receipt.lastStopped -or $receipt.lastStopped.pinsExclusive -ne $true) { throw 'worker_retirement_unknown' }
            $absent = Get-WorkerServiceGeneration -Receipt $receipt -Deadline $deadline
            try { if ($absent.exists) { throw 'worker_identity_unknown' } }
            finally { if ($null -ne $absent.PSObject.Methods['Dispose']) { $absent.Dispose() } }
            Assert-WorkerExclusiveSnapshot -Receipt $receipt -Deadline $deadline
            if (-not [System.IO.Directory]::Exists($versionRoot)) { Copy-WorkerPayload $payload $versionRoot $Request.ExpectedInventorySha256 }
            $configBytes = [Zeb.WorkerInstall.Native]::ReadBytes(([System.IO.Path]::Combine($data, 'config', 'worker.config.json')))
            Write-WorkerVersionConfig $versionRoot $configBytes $receipt.configSha256
            $null = Test-WorkerInstalledPayload -PayloadRoot $versionRoot -ExpectedInventorySha256 $Request.ExpectedInventorySha256 -ExpectedConfigSha256 $receipt.configSha256
            $configuration = Invoke-WorkerConfigurationCheck -VersionRoot $versionRoot -ConfigPath ([System.IO.Path]::Combine($data, 'config', 'worker.config.json')) -Deadline $deadline
            Assert-WorkerConfigurationResult $configuration
            $receipt.active = [pscustomobject]@{ version=$package.version; inventorySha256=$Request.ExpectedInventorySha256.ToLowerInvariant();
                imagePath='"' + [System.IO.Path]::Combine($versionRoot, 'WindowsServiceHost.exe') + '"' }
            Save-WorkerStage $receiptPath $receipt 'prepared' 'pending'
            Test-WorkerSnapshotDatabase -Root $data -Receipt $receipt -Deadline $deadline
            Start-WorkerOwnedService -Receipt $receipt -ReceiptPath $receiptPath -Deadline $deadline -Create -StartupCapture ([ref]$startupCapture)
        } else {
            if ($action -ceq 'Upgrade' -and -not $resume) {
                Copy-WorkerPayload -Source $payload -Destination $versionRoot -InventorySha256 $Request.ExpectedInventorySha256
                $configBytes = [Zeb.WorkerInstall.Native]::ReadBytes(([System.IO.Path]::Combine($data, 'config', 'worker.config.json')))
                Write-WorkerVersionConfig $versionRoot $configBytes $receipt.configSha256
                $null = Test-WorkerInstalledPayload -PayloadRoot $versionRoot -ExpectedInventorySha256 $Request.ExpectedInventorySha256 -ExpectedConfigSha256 $receipt.configSha256
                $configuration = Invoke-WorkerConfigurationCheck -VersionRoot $versionRoot -ConfigPath ([System.IO.Path]::Combine($data, 'config', 'worker.config.json')) -Deadline $deadline
                Assert-WorkerConfigurationResult $configuration
            }
            if ($action -ceq 'DeleteData') {
                if ($null -eq $receipt.lastStopped -or $receipt.lastStopped.pinsExclusive -ne $true) { throw 'worker_retirement_unknown' }
                $absent = Get-WorkerServiceGeneration -Receipt $receipt -Deadline $deadline
                try { if ($absent.exists) { throw 'worker_retirement_unknown' } }
                finally { if ($null -ne $absent.PSObject.Methods['Dispose']) { $absent.Dispose() } }
                $names = @([Zeb.WorkerInstall.Native]::Children($data))
                if ($names.Count -ne 6 -or @($names | Where-Object { $_ -cnotin @('store', 'records', 'engine', 'config', 'tls', 'installation') }).Count -ne 0) { throw 'worker_data_root_invalid' }
                $installation = [System.IO.Path]::Combine($data, 'installation')
                $books = @([Zeb.WorkerInstall.Native]::Children($installation))
                if (@($books | Where-Object { $_ -cnotin @('receipt.json', 'operation.lock') }).Count -ne 0) { throw 'worker_ownership_invalid' }
                Assert-WorkerExclusiveSnapshot -Receipt $receipt -Deadline $deadline
                $tombstones = [System.IO.Path]::Combine($program, 'installation-tombstones')
                if ([System.IO.Directory]::Exists($tombstones)) { Assert-WorkerCallerDirectory $tombstones }
                else { New-WorkerCallerDirectory $tombstones }
                $proposed = [System.IO.Path]::Combine($tombstones, $receipt.installationId + '.json')
                if ([System.IO.File]::Exists($proposed)) { throw 'worker_operation_conflict' }
                $tombstoneLock = Open-WorkerInstallLock -Path ($proposed + '.lock') -OperationId $operationId
                $tombstone = [pscustomobject]@{ schemaVersion=1; installationId=$receipt.installationId;
                    receiptSha256=[Zeb.WorkerInstall.Native]::Hash($receiptPath); receipt=(Read-WorkerJson $receiptPath);
                    operation=[pscustomobject]@{ operationId=$operationId; action='DeleteData'; stage='deleted'; outcome='pending'; maintenanceBootId=$null; targetSha256=$null } }
                Write-WorkerLedger $proposed $tombstone
                $tombstonePath = $proposed
                $lock.Dispose(); $lock = $null
                foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) { Remove-WorkerOwnedTree ([System.IO.Path]::Combine($data, $name)) }
                [Zeb.WorkerInstall.Native]::DeleteObject($receiptPath)
                [Zeb.WorkerInstall.Native]::DeleteObject(([System.IO.Path]::Combine($installation, 'operation.lock')))
                [Zeb.WorkerInstall.Native]::DeleteObject($installation)
                [Zeb.WorkerInstall.Native]::DeleteObject($data)
                $tombstone.operation.outcome = 'known'
                Write-WorkerLedger $tombstonePath $tombstone
                $receipt.operation.stage = 'deleted'; $receipt.operation.outcome = 'known'
            } elseif ((Stop-WorkerOwnedService -Receipt $receipt -ReceiptPath $receiptPath -Deadline $deadline -Resume $resume @stopEvidenceArguments)) {
                if ($action -ceq 'Uninstall') {
                    Save-WorkerStage $receiptPath $receipt 'retained' 'pending'
                    Invoke-WorkerScmChange -Action Delete -ImagePath $receipt.active.imagePath -Deadline $deadline
                    foreach ($active in @($receipt.active, $receipt.previous)) {
                        if ($null -eq $active) { continue }
                        $root = Get-WorkerVersionRoot $program $active.version
                        if ([System.IO.Directory]::Exists($root)) {
                            $null = Test-WorkerInstalledPayload -PayloadRoot $root -ExpectedInventorySha256 $active.inventorySha256 -ExpectedConfigSha256 $receipt.configSha256
                            Remove-WorkerOwnedTree $root
                        }
                    }
                    $receipt.state = 'retained'
                    Save-WorkerStage $receiptPath $receipt 'retained' 'known'
                } elseif ($action -ceq 'Upgrade') {
                    $backup = New-WorkerBackup -Receipt $receipt -BackupRoot $backupRoot -Deadline $deadline
                    if ($null -ne $upgradeEvidence) {
                        try {
                            $upgradeEvidence | Add-Member -NotePropertyMembers @{
                                BackupResult=$backup; BackupBinding=[pscustomobject]@{path=$backup.path;
                                    valueJson=($backup.value | ConvertTo-Json -Depth 32 -Compress);
                                    receiptSha256=[Zeb.WorkerInstall.Native]::Hash($backup.path)};
                                EvidencePath=$null; EvidenceSha256=$null }
                            Write-WorkerUpgradeEvidence $upgradeEvidence $receipt $receiptPath $backup $deadline
                        } catch { $upgradeEvidence = $null }
                    }
                    Save-WorkerStage $receiptPath $receipt 'backed_up' 'known'
                    $null = Test-WorkerInstalledPayload -PayloadRoot $versionRoot -ExpectedInventorySha256 $Request.ExpectedInventorySha256 -ExpectedConfigSha256 $receipt.configSha256
                    $receipt.previous = $receipt.active
                    $receipt.active = [pscustomobject]@{ version=$package.version; inventorySha256=$Request.ExpectedInventorySha256.ToLowerInvariant();
                        imagePath='"' + [System.IO.Path]::Combine($versionRoot, 'WindowsServiceHost.exe') + '"' }
                    Save-WorkerStage $receiptPath $receipt 'backed_up' 'pending'
                    Start-WorkerOwnedService -Receipt $receipt -ReceiptPath $receiptPath -Deadline $deadline -Switch -StartupCapture ([ref]$startupCapture)
                } else {
                    $currentBackupRoot = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($selectedBackup.value.root), 'rollback-' + $operationId)
                    $currentBackup = New-WorkerBackup -Receipt $receipt -BackupRoot $currentBackupRoot -Deadline $deadline
                    Save-WorkerStage $receiptPath $receipt 'backed_up' 'known'
                    $staging = [System.IO.Path]::Combine($data, 'installation', 'restore-' + $operationId)
                    Copy-WorkerSnapshot -Source $selectedBackup.value.root -Destination $staging -Manifest $selectedBackup.manifest -Deadline $deadline
                    Test-WorkerSnapshotDatabase -Root $staging -Receipt $receipt -Deadline $deadline
                    Restore-WorkerSnapshotMetadata -Root $staging -Manifest $selectedBackup.manifest
                    $holding = [System.IO.Path]::Combine($data, 'installation', 'pre-restore-' + $operationId)
                    New-WorkerCallerDirectory $holding
                    Save-WorkerStage $receiptPath $receipt 'backed_up' 'pending'
                    foreach ($name in @('store', 'records', 'engine', 'config', 'tls')) {
                        [Zeb.WorkerInstall.Native]::MoveObject(([System.IO.Path]::Combine($data, $name)), ([System.IO.Path]::Combine($holding, $name)))
                        [Zeb.WorkerInstall.Native]::MoveObject(([System.IO.Path]::Combine($staging, $name)), ([System.IO.Path]::Combine($data, $name)))
                    }
                    Restore-WorkerSnapshotMetadata -Root $data -Manifest $selectedBackup.manifest
                    $oldRoot = Get-WorkerVersionRoot $program $selectedBackup.value.sourceVersion
                    $null = Test-WorkerInstalledPayload -PayloadRoot $oldRoot -ExpectedInventorySha256 $selectedBackup.value.sourceInventorySha256 -ExpectedConfigSha256 $receipt.configSha256
                    $current = $receipt.active
                    $receipt.active = $receipt.previous; $receipt.previous = $current
                    Save-WorkerStage $receiptPath $receipt 'backed_up' 'pending'
                    Start-WorkerOwnedService -Receipt $receipt -ReceiptPath $receiptPath -Deadline $deadline -Switch -StartupCapture ([ref]$startupCapture)
                    Remove-WorkerOwnedTree $holding
                    Remove-WorkerOwnedTree $staging
                }
            }
            if ($receipt.operation.stage -ceq 'maintenance' -and $receipt.operation.outcome -ceq 'known') {
                $delivery = Get-WorkerPublicResult 'worker_not_quiescent' $operationId $receipt 'known' 1
                return $delivery
            }
        }
        $null = Get-WorkerRemainingMilliseconds $deadline
        $delivery = Get-WorkerPublicResult 'worker_operation_complete' $operationId $receipt 'known' 0
        return $delivery
    } catch {
        $operationFailure = $_
        if ($null -ne $startupCapture) {
            if ($null -eq $startupCapture.FailureType) {
                $startupCapture.Failure = $operationFailure.Exception
                $failure = $operationFailure.Exception
                while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
                $startupCapture.FailureType = $failure.GetType().FullName
                $startupCapture.FailureStage = $startupCapture.Stage
            }
            $startupDiagnosticAttempted = $true
            try { Write-WorkerStartupDiagnostic -Capture $startupCapture -Receipt $receipt }
            catch { $startupDiagnosticFailure = $_.Exception.GetType().FullName }
        } elseif ($ledgerOwned) {
            try { Write-WorkerOperationDiagnostic -Receipt $receipt -Failure $operationFailure.Exception }
            catch { $startupDiagnosticFailure = $_.Exception.GetType().FullName }
        }
        $code = if ($operationFailure.Exception.Message -cmatch '\Aworker_[a-z_]+\z') { $operationFailure.Exception.Message } else { 'worker_operation_unknown' }
        $outcome = if ($ledgerOwned -or $bootstrapStarted -or $code.EndsWith('_unknown', [System.StringComparison]::Ordinal)) { 'unknown' } else { 'known' }
        if ($ledgerOwned) {
            $receipt.state = 'unknown'; $receipt.operation.outcome = 'unknown'
            try {
                if ($null -ne $tombstonePath) {
                    $tombstone.operation.outcome = 'unknown'
                    Write-WorkerLedger $tombstonePath $tombstone
                } else {
                    Write-WorkerLedger $receiptPath $receipt
                    if ($null -ne $script:WorkerUnresolvedProcessIdentity) {
                        Write-WorkerLedger ([System.IO.Path]::Combine($data, 'installation', 'unknown-process.json')) $script:WorkerUnresolvedProcessIdentity
                    }
                }
            } catch { $code = 'worker_ledger_unknown' }
        }
        if ($ledgerOwned -and $code -cne 'worker_ledger_unknown' -and $action -ceq 'Upgrade' -and
            $null -ne $startupCapture -and $startupCapture.Stage -ceq 'settled' -and $null -ne $upgradeEvidence -and
            $null -ne $upgradeEvidence.EvidencePath -and $null -ne $upgradeEvidence.EvidenceSha256) {
            try {
                $failureReadback = Read-WorkerReceipt $receiptPath
                if (($failureReadback | ConvertTo-Json -Depth 64 -Compress) -ceq ($receipt | ConvertTo-Json -Depth 64 -Compress)) {
                    $startupFailureCandidate = New-WorkerStartupFailureProof $startupCapture $receipt $receiptPath $upgradeEvidence $deadline
                }
            } catch { $startupFailureCandidate = $null }
        }
        $delivery = Get-WorkerPublicResult $code $operationId $receipt $outcome 1
        return $delivery
    } finally {
        $captureRestoreFailed = $false
        try { if ($null -ne $startupCapture) { $startupCapture.Dispose() } }
        catch {
            $captureRestoreFailed = $true
            if ($null -eq $startupCapture.FailureType) {
                $startupCapture.Failure = $_.Exception
                $failure = $_.Exception
                while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
                $startupCapture.FailureType = $failure.GetType().FullName
                $startupCapture.FailureStage = $startupCapture.Stage
            }
        }
        $restoreFailed = $false
        try { if ($null -ne $privileges) { $privileges.Dispose() } } catch { $restoreFailed = $true }
        $script:WorkerBearer = $null
        if ($captureRestoreFailed -and $null -ne $delivery) {
            if ($delivery.value.outcome -cne 'unknown') { $delivery.value.code = 'worker_startup_cleanup_unknown' }
            $delivery.exitCode = 1; $delivery.value.outcome = 'unknown'
            if (-not $startupDiagnosticAttempted) {
                $startupDiagnosticAttempted = $true
                try { Write-WorkerStartupDiagnostic -Capture $startupCapture -Receipt $receipt }
                catch { $startupDiagnosticFailure = $_.Exception.GetType().FullName }
            }
            if ($ledgerOwned) {
                $receipt.state = 'unknown'; $receipt.operation.outcome = 'unknown'
                try { Write-WorkerLedger $receiptPath $receipt } catch { $delivery.value.code = 'worker_ledger_unknown' }
            }
        }
        if ($restoreFailed -and $null -ne $delivery) {
            $delivery.exitCode = 1; $delivery.value.code = 'worker_privilege_restore_unknown'; $delivery.value.outcome = 'unknown'
            if ($ledgerOwned) {
                $receipt.state = 'unknown'; $receipt.operation.outcome = 'unknown'
                try {
                    if ($null -ne $tombstonePath) { $tombstone.operation.outcome = 'unknown'; Write-WorkerLedger $tombstonePath $tombstone }
                    else { Write-WorkerLedger $receiptPath $receipt }
                } catch { $delivery.value.code = 'worker_ledger_unknown' }
            }
        }
        $unlockFailed = $false
        try { if ($null -ne $tombstoneLock) { $tombstoneLock.Dispose() } } catch { $unlockFailed = $true }
        try { if ($null -ne $lock) { $lock.Dispose() } } catch { $unlockFailed = $true }
        if ($unlockFailed -and $null -ne $delivery) {
            $delivery.exitCode = 1; $delivery.value.code = 'worker_operation_unknown'; $delivery.value.outcome = 'unknown'
        }
        if ($null -ne $startupFailureCandidate -and -not $captureRestoreFailed -and -not $restoreFailed -and -not $unlockFailed) {
            $startupFailureCandidate.Closeout.captureReleased = $true
            $startupFailureCandidate.Closeout.privilegesRestored = $true
            $startupFailureCandidate.Closeout.installationLocksReleased = $true
            try { Write-WorkerStartupFailureProof $startupFailureCandidate $deadline }
            catch { $startupFailureCandidate = $null }
        }
    }
}

function Assert-WorkerCallerDirectory {
    param([string]$Path)
    $null = Resolve-WorkerLocalPath $Path
    $info = [Zeb.WorkerInstall.Native]::Inspect($Path)
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm($info.SecuritySddl)
    $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not $info.Directory -or -not $security.AreAccessRulesProtected -or
        $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $sid -or $rules.Count -ne 1 -or
        $rules[0].IdentityReference.Value -cne $sid -or [int]$rules[0].FileSystemRights -ne 0x001f01ff -or
        $rules[0].IsInherited -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'worker_ownership_invalid' }
}

Export-ModuleMember -Function Test-WorkerPayload, Test-WorkerInstalledPayload
